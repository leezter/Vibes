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
  }

  async loadFile(file){
    const arrayBuffer = await file.arrayBuffer();
    this.fileMeta = {name:file.name,size:file.size,lastModified:file.lastModified};
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
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
    s.connect(this.eqLow);
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
