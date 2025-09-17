// Deck.js - per-deck player implementation using Web Audio API
// Features: load buffer, play/pause, cue, pitch, basic loop, hot cues

export class Deck {
  constructor(engine, id){
    this.engine = engine; // AudioEngine instance
    this.id = id; // 'A' or 'B'
    this.ctx = engine.ctx;

    this.buffer = null;
    this.source = null;
    this.playing = false;
    this.startTime = 0; // context time when playback started
    this.pausedAt = 0; // position in seconds when paused
    this.playbackRate = 1;

    // Nodes
    this.gain = this.ctx.createGain();
    this.eqHigh = this.ctx.createBiquadFilter(); this.eqHigh.type='highshelf';
    this.eqMid = this.ctx.createBiquadFilter(); this.eqMid.type='peaking';
    this.eqLow = this.ctx.createBiquadFilter(); this.eqLow.type='lowshelf';
    this.filter = this.ctx.createBiquadFilter(); this.filter.type='lowpass';
    // set sensible EQ band center frequencies and Q to avoid overly narrow/low defaults
    try{
      this.eqLow.frequency.value = 100;    // low band centered at 100Hz
      this.eqMid.frequency.value = 1000;   // mid band centered at ~1kHz
      this.eqMid.Q.value = 1;              // moderate bandwidth for mid peaking
      this.eqHigh.frequency.value = 10000; // high shelf boost/cut around 10kHz
      // disable aggressive lowpass by default (allow full audible bandwidth)
      this.filter.frequency.value = Math.min(20000, this.ctx.sampleRate/2);
      this.filter.Q.value = 0.707;
    }catch(e){ /* setting filter params may fail on some older browsers; ignore */ }

    // chain: source -> eqLow -> eqMid -> eqHigh -> filter -> gain -> master
  this.gain.gain.value = 1.0;
  this.eqLow.gain.value = 0;
  this.eqMid.gain.value = 0;
  this.eqHigh.gain.value = 0;

    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.filter);
    this.filter.connect(this.gain);

  // per-deck scratch gain (worklet output -> eqLow via scratchGain)
  this.scratchGain = this.ctx.createGain();
  this.scratchGain.gain.value = 0; // start silent until scratch active
  // we will connect scratchGain to eqLow in _ensureScratchNode when node created

  engine.connectDeck(this.gain);

    // UI hooks
    this.onUpdate = ()=>{};

    // analysis and cues
    this.cues = {}; // hot cue storage: cueId -> seconds
    this.loops = [];
    this.fileMeta = null;
    // main cue (single per track for now). null means not set yet.
    this.mainCue = null; // seconds
    this._tempCuePlaying = false;
    this._tempCue = null;
    this._cueHoldTimer = null;
    this._cueHoldWaiting = false;
    this._lastAction = 0;
    // operation lock to serialize play/pause/seek operations
    this._opLock = false;
    // precise playback bookkeeping: record when playback started in AudioContext time
    this._playStartContextTime = null;
    // and the track-offset (seconds) corresponding to that context time
    this._playStartTrackOffset = 0;
    // scratch node (AudioWorklet) and control port
    this.scratchNode = null;
    this._scratchPort = null;
    // timing knobs (defaults)
    this.PRELOAD_LEAD = 0.016; // seconds
    this.CROSSFADE = 0.04; // seconds
  }

  // Immediately stop audio output and set pausedAt to current position without debounce/op lock.
  stopImmediate(){
    try{
      const pos = this.getPosition();
      if(this.source){ try{ this.source.onended = null; this.source.stop(); }catch(e){} this.source = null; }
      this.pausedAt = Math.max(0, Math.min(this.buffer?this.buffer.duration:Infinity, pos));
      this.playing = false;
      // clear bookkeeping
      this._playStartContextTime = null;
      this._playStartTrackOffset = 0;
      this.startTime = 0;
      if(typeof this.onUpdate === 'function') this.onUpdate({type:'pause', deck:this.id});
    }catch(e){ console.warn('[Deck] stopImmediate error', e); }
  }

  async loadFile(file){
    const arrayBuffer = await file.arrayBuffer();
    this.fileMeta = {name:file.name,size:file.size,lastModified:file.lastModified};
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
  // when a buffer is loaded, prepare scratch node if audioWorklet available
  // add small delay to ensure worklet registration is complete
  setTimeout(() => {
    try{ this._ensureScratchNode(); }catch(e){ console.debug('[Deck] scratch node setup failed', e && e.message); }
  }, 100);
    this.pausedAt = 0;
    this.playing = false;
    // notify UI to draw waveform via analysis worker externally
    this.onUpdate({type:'loaded',deck:this.id,meta:this.fileMeta,duration:this.buffer.duration});
  }

  _makeSource(){
    if(!this.buffer) return null;
    // ensure any previous source is stopped and cleared to avoid duplicate audio
    if(this.source){
      try{ this.source.onended = null; this.source.stop(); }catch(e){}
      this.source = null;
    }
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.playbackRate.value = this.playbackRate;
    // route source through a per-source gain so we can crossfade when resuming from scratch
    try{
      const sg = this.ctx.createGain(); sg.gain.value = 1.0;
      s.connect(sg);
      sg.connect(this.eqLow);
      this.sourceGain = sg;
    }catch(e){
      // fallback: connect directly
      s.connect(this.eqLow);
      this.sourceGain = null;
    }
    s.onended = ()=>{ // only act if this source is still the active one
      if(this.source === s){
        this.playing = false;
        this.source = null;
        // clear play bookkeeping
        this._playStartContextTime = null;
        this._playStartTrackOffset = 0;
        this.startTime = 0;
        this.onUpdate({type:'ended',deck:this.id});
      }
    };
    this.source = s;
    return s;
  }

  _ensureScratchNode(){
    if(this.scratchNode) return;
    if(!this.ctx || !this.ctx.audioWorklet) {
      console.warn('[Deck] AudioWorklet not available for scratch node');
      return;
    }
    try{
      console.debug('[Deck] creating scratch-processor node');
      // create a node with up to 2 outputs (stereo)
      const node = new AudioWorkletNode(this.ctx, 'scratch-processor', {numberOfOutputs:1, outputChannelCount:[2]});
      // connect node to deck's processing chain via scratchGain -> eqLow
      node.connect(this.scratchGain);
      this.scratchGain.connect(this.eqLow);
      this.scratchNode = node;
      this._scratchPort = node.port;
      console.debug('[Deck] scratch node created successfully');
      // if buffer already decoded, send channels
      if(this.buffer){
        const ch0 = this.buffer.getChannelData(0).slice(0);
        const ch1 = (this.buffer.numberOfChannels>1) ? this.buffer.getChannelData(1).slice(0) : ch0.slice(0);
        // transferable arrays
        this._scratchPort.postMessage({cmd:'setBuffer', channels:[ch0,ch1], sampleRate:this.buffer.sampleRate}, [ch0.buffer, ch1.buffer]);
        console.debug('[Deck] sent buffer to scratch processor');
      }
    }catch(e){ 
      console.warn('[Deck] failed to create scratch node', e); 
      // retry once after a short delay in case worklet registration is still pending
      if(!this._scratchRetried){
        this._scratchRetried = true;
        setTimeout(() => {
          console.debug('[Deck] retrying scratch node creation');
          this._ensureScratchNode();
        }, 500);
      }
    }
  }

  // API for UI to control scratch
  scratchStart(positionSeconds, playbackRate){
    console.debug('[Deck] scratchStart', this.id, 'pos:', positionSeconds, 'rate:', playbackRate);
    if(this._scratchPort) this._scratchPort.postMessage({cmd:'startScratch', position: positionSeconds, playbackRate});
    // set scratch output audible with a tiny ramp to avoid clicks
    try{
      if(this.scratchGain){
        const now = this.ctx.currentTime;
        this.scratchGain.gain.cancelScheduledValues(now);
        const cur = this.scratchGain.gain.value;
        this.scratchGain.gain.setValueAtTime(cur, now);
        this.scratchGain.gain.linearRampToValueAtTime(1.0, now + 0.008);
      }
    }catch(e){}
  }
  scratchSetPosition(positionSeconds){ if(this._scratchPort) this._scratchPort.postMessage({cmd:'setPosition', position: positionSeconds}); }
  scratchSetRate(playbackRate){ if(this._scratchPort) this._scratchPort.postMessage({cmd:'setRate', playbackRate}); }
  scratchSetHold(holding){ if(this._scratchPort) this._scratchPort.postMessage({cmd:'setHold', holding: !!holding}); }
  scratchStop(){
    if(this._scratchPort) this._scratchPort.postMessage({cmd:'stopScratch'});
    // fade scratch output down slightly to avoid clicks
    try{
      if(this.scratchGain){
        const now = this.ctx.currentTime; this.scratchGain.gain.cancelScheduledValues(now); this.scratchGain.gain.setValueAtTime(this.scratchGain.gain.value, now);
        this.scratchGain.gain.linearRampToValueAtTime(0.0, now + 0.02);
      }
    }catch(e){ }
  }

  play(){
    const nowMs = Date.now();
    if(nowMs - this._lastAction < 40) return; // debounce rapid clicks
    this._lastAction = nowMs;
    console.debug(`[Deck ${this.id}] play requested - playing=${this.playing}, pausedAt=${this.pausedAt}`);
    if(this.playing) return;
    if(this._opLock){ console.debug(`[Deck ${this.id}] play blocked by op lock`); return; }
    this._opLock = true;
    try{
      // ensure any lingering source is stopped before creating a new one
      if(this.source){ try{ this.source.onended = null; this.source.stop(); }catch(e){} this.source = null; }
      const s = this._makeSource();
  if(!s){ console.warn(`[Deck ${this.id}] play aborted: no source created`); this._playStartContextTime = null; this._playStartTrackOffset = 0; return; }
  const offset = this.pausedAt;
  this._playStartTrackOffset = offset;
  this._playStartContextTime = this.ctx.currentTime;
  this.startTime = this._playStartContextTime;
      let _started = false;
      try{
        if(s && typeof s.start === 'function'){ s.start(0, offset); _started = true; }
        else { console.error('[Deck] start aborted: source invalid', s); }
      }catch(e){
        console.error('[Deck] start failed', e);
      }
      if(_started){
        this.playing = true;
        this.onUpdate({type:'play',deck:this.id});
      }else{
        // failed to start -> clear play bookkeeping
        this._playStartContextTime = null;
        this._playStartTrackOffset = 0;
        this.startTime = 0;
      }
    }finally{
      // release lock shortly after to allow subsequent actions; keep small guard window
      setTimeout(()=>{ this._opLock = false; }, 8);
    }
  }

  // helper to start playback at a given position (seconds) - used to resume after scratch
  resumeAtPosition(seconds){
    // Directly create and start a fresh BufferSource at `seconds`.
    if(!this.buffer) return;
    try{
      if(!this.buffer) return;
      const startPos = Math.max(0, Math.min(seconds, this.buffer.duration));
      this.pausedAt = startPos;
      // create a new source and ensure it routes through a sourceGain
      const s = this._makeSource();
      if(!s) return;
  const now = this.ctx.currentTime;
  const CROSSFADE = (typeof this.CROSSFADE === 'number') ? this.CROSSFADE : 0.04;
  const PRELOAD_LEAD = (typeof this.PRELOAD_LEAD === 'number') ? this.PRELOAD_LEAD : 0.016;
      // ensure sourceGain exists and start the source slightly in the future to give audio thread lead time
  const startTime = Math.max(now + PRELOAD_LEAD, now + 0.001);
      try{
        // prepare sourceGain fade: start silent at startTime - small epsilon, then ramp to 1 over CROSSFADE
        if(this.sourceGain){
          this.sourceGain.gain.cancelScheduledValues(startTime - 0.002);
          this.sourceGain.gain.setValueAtTime(0.0, startTime - 0.002);
          this.sourceGain.gain.linearRampToValueAtTime(1.0, startTime + CROSSFADE);
        }
      }catch(e){}
      // schedule scratch gain fade down starting at startTime
      try{
        if(this.scratchGain){
          this.scratchGain.gain.cancelScheduledValues(startTime - 0.002);
          const cur = this.scratchGain.gain.value || 1.0;
          this.scratchGain.gain.setValueAtTime(cur, startTime - 0.002);
          this.scratchGain.gain.linearRampToValueAtTime(0.0, startTime + CROSSFADE);
        }
      }catch(e){}
      // start the source at scheduled startTime at requested position
      try{
        s.start(startTime, startPos);
        this._playStartTrackOffset = startPos;
        this._playStartContextTime = startTime;
        this.startTime = startTime;
        this.playing = true;
        this.onUpdate({type:'play',deck:this.id});
      }catch(e){ console.error('[Deck] resumeAtPosition scheduled start failed', e); this.playing = false; }
      // as a final safety, ensure scratchGain is silent after the crossfade completes
      try{ setTimeout(()=>{ try{ if(this.scratchGain) this.scratchGain.gain.setValueAtTime(0, this.ctx.currentTime); }catch(e){} }, Math.ceil((PRELOAD_LEAD + CROSSFADE)*1000)+10); }catch(e){}
    }catch(e){ console.error('[Deck] resumeAtPosition error', e); }
  }

  // runtime setters for knobs (temporary UI use)
  setPreloadLead(seconds){ this.PRELOAD_LEAD = Math.max(0, Number(seconds) || 0); }
  setCrossfade(seconds){ this.CROSSFADE = Math.max(0, Number(seconds) || 0); }

  pause(){
    const nowMs = Date.now();
    if(nowMs - this._lastAction < 40) return; // debounce rapid clicks
    this._lastAction = nowMs;
    if(!this.playing) return;
    if(this._opLock){ console.debug(`[Deck ${this.id}] pause blocked by op lock`); return; }
    this._opLock = true;
    try{
      if(this.source){ try{ this.source.onended = null; this.source.stop(); }catch(e){} this.source = null; }
  const elapsed = (this._playStartContextTime != null) ? (this.ctx.currentTime - this._playStartContextTime) * this.playbackRate : 0;
  const pos = (this._playStartContextTime != null) ? (this._playStartTrackOffset + elapsed) : this.pausedAt || 0;
  this.pausedAt = Math.max(0, Math.min(this.buffer?this.buffer.duration:Infinity, pos));
  // clear start bookkeeping
  this._playStartContextTime = null;
  this._playStartTrackOffset = 0;
  this.startTime = 0;
      this.playing = false;
      console.debug(`[Deck ${this.id}] paused - pausedAt=${this.pausedAt}`);
      this.onUpdate({type:'pause',deck:this.id});
    }finally{
      setTimeout(()=>{ this._opLock = false; }, 8);
    }
  }

  seek(seconds){
    // simple seek; quantize externally if needed
    if(this._opLock){ console.debug(`[Deck ${this.id}] seek blocked by op lock`); return; }
    this._opLock = true;
    try{
      if(this.playing){
        // stop current source and mark as not playing so we can restart
        if(this.source){ try{ this.source.onended = null; this.source.stop(); }catch(e){} this.source = null; }
        this.playing = false;
        this.pausedAt = Math.max(0,Math.min(seconds,this.buffer.duration));
        this.play();
      }else{
        this.pausedAt = Math.max(0,Math.min(seconds,this.buffer.duration));
      }
    }finally{
      setTimeout(()=>{ this._opLock = false; }, 8);
    }
    this.onUpdate({type:'seek',deck:this.id,position:this.pausedAt});
  }

  setMainCue(seconds){ this.mainCue = Math.max(0,Math.min(seconds, this.buffer?this.buffer.duration:0)); }

  // temporary cue helpers used by UI to implement press-hold behavior
  setTempCue(seconds){ this._tempCue = Math.max(0, Math.min(seconds, this.buffer?this.buffer.duration:0)); this.onUpdate({type:'tempCueSet',deck:this.id,position:this._tempCue}); }

  startTempPlay(){
    if(!this.buffer) return;
    if(this._tempCue==null) return;
    // stop any existing source and start from temp cue
    if(this.source){ try{ this.source.onended=null; this.source.stop(); }catch(e){} this.source = null; }
    this.playing = false;
    this.pausedAt = this._tempCue;
    this.play();
    this._tempCuePlaying = true;
  }

  stopTempPlay(){
    if(!this._tempCuePlaying) return;
    if(this.playing) this.pause();
    if(this._tempCue!=null) this.pausedAt = this._tempCue;
    this._tempCuePlaying = false;
    this.onUpdate({type:'tempCueStop',deck:this.id,position:this.pausedAt});
  }

  // start of cue hold (keydown / mousedown)
  cueHoldStart(){
    if(!this.buffer) return;
    const HOLD_MS = 180;
    const currentPos = this.getPosition();
    console.debug(`[Deck ${this.id}] cueHoldStart - playing=${this.playing}, position=${currentPos}, mainCue=${this.mainCue}`);
    if(this.playing){
      // create a temporary cue at current position and immediately play from it
      this._tempCue = currentPos;
      // stop current source and mark as not playing so play() will restart a new source
      if(this.source) this.source.stop();
      this.playing = false;
      this.pausedAt = this._tempCue;
      this.play();
      this._tempCuePlaying = true;
    }else{
      // when stopped: move head to main cue if set (do nothing if none)
      if(this.mainCue!=null){ this.pausedAt = this.mainCue; this.onUpdate({type:'seek',deck:this.id,position:this.pausedAt}); }
      // start waiting timer: if hold lasts beyond threshold, start playback from main cue
      this._cueHoldWaiting = true;
      this._cueHoldTimer = setTimeout(()=>{
        this._cueHoldTimer = null;
        this._cueHoldWaiting = false;
        // if main cue exists, start playing from it
        const startPos = this.mainCue!=null? this.mainCue : 0;
        console.debug(`[Deck ${this.id}] cueHoldStart timer fired - starting at ${startPos}`);
        this.pausedAt = startPos;
        this.play();
        this._tempCuePlaying = true;
      }, HOLD_MS);
    }
  }

  // end of cue hold (keyup / mouseup)
  cueHoldEnd(){
    if(!this.buffer) return;
    console.debug(`[Deck ${this.id}] cueHoldEnd - playing=${this.playing}, tempPlaying=${this._tempCuePlaying}, mainCue=${this.mainCue}`);
    // if we were playing a temporary cue, stop and return to cue
    if(this._tempCuePlaying){
      if(this.playing) this.pause();
      // if we had a temp cue (created while playing), return to that point
      if(this._tempCue!=null){ this.pausedAt = this._tempCue; }
      else if(this.mainCue!=null){ this.pausedAt = this.mainCue; }
      this._tempCuePlaying = false;
      this._tempCue = null;
      this.onUpdate({type:'cueReturn',deck:this.id,position:this.pausedAt});
      return;
    }

    // if we were waiting for a hold (stopped + timer running), treat as a tap: cancel timer and ensure head is at mainCue
    if(this._cueHoldWaiting){
      if(this._cueHoldTimer){ clearTimeout(this._cueHoldTimer); this._cueHoldTimer = null; }
      this._cueHoldWaiting = false;
      if(this.mainCue!=null){ this.pausedAt = this.mainCue; this.onUpdate({type:'seek',deck:this.id,position:this.pausedAt}); }
    }
  }

  // helper to calculate current playback position in seconds
  getPosition(){
    if(!this.buffer) return 0;
    if(this.playing){
      if(this._playStartContextTime != null){
        const elapsed = (this.ctx.currentTime - this._playStartContextTime) * this.playbackRate;
        return Math.max(0, Math.min(this.buffer.duration, this._playStartTrackOffset + elapsed));
      }
      return Math.max(0, Math.min(this.buffer.duration, (this.ctx.currentTime - this.startTime) * this.playbackRate));
    }
    return this.pausedAt;
  }

  setPlaybackRate(v){
    this.playbackRate = v;
    if(this.source) this.source.playbackRate.value = v;
    this.onUpdate({type:'rate',deck:this.id,rate:v});
  }

  setGain(v){ this.gain.gain.value = v; }
  setEQ(low,mid,high){ this.eqLow.gain.value=low; this.eqMid.gain.value=mid; this.eqHigh.gain.value=high; }
  setFilter(freq,Q){ this.filter.frequency.value=freq; this.filter.Q.value=Q; }

  setHotCue(n,seconds){ this.cues[n]=seconds; }
  jumpHotCue(n){ if(this.cues[n]!=null) this.seek(this.cues[n]); }
}
