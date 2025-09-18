// ScratchProcessor.js
// AudioWorkletProcessor that renders audio from supplied channel buffers
// and supports scratch via position/rate updates from the main thread.

class ScratchProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    // Source data
    this.channels = []; // Array<Float32Array>
    this._bufLen = 0;
    this._bufSampleRate = sampleRate; // SR of the provided buffer
    this._resample = 1.0; // bufferSR / contextSR

    // Playback state
    this._posSamples = 0.0;       // position in context samples (float)
    this._playbackRate = 1.0;     // target playback rate multiplier
    this._smoothedRate = 1.0;     // smoothed playback rate used per-sample
  this._rateSmoothing = 0.22;   // smoothing factor (0..1) a bit stronger to reduce zipper noise
    this._scratchActive = false;  // whether to output audio
  this._hold = false;           // UI indicates current hold state
    // Fling state (coasting after pointer release)
    this._flingActive = false;
    this._flingRate = 0.0;   // current fling playbackRate
    this._flingTau = 0.4;    // seconds, exponential decay time constant
    this._flingEndedFlag = false; // used to notify end once per block

  // Small gate envelope to avoid clicks when toggling mute/near-zero
  this._gateGain = 0.0;   // smoothed output gain (0..1)
  this._gateTau = 0.001;  // seconds, ~1ms smoothing

    this.port.onmessage = this._onMessage.bind(this);
  }

  _onMessage(e){
    const d = e.data || {};
    switch(d.cmd){
      case 'setBuffer': {
        if(Array.isArray(d.channels) && d.channels.length){
          this.channels = d.channels;
          this._bufLen = this.channels[0].length | 0;
          this._bufSampleRate = typeof d.sampleRate === 'number' ? d.sampleRate : sampleRate;
          this._resample = (this._bufSampleRate || sampleRate) / sampleRate;
          if(this._posSamples >= (this._bufLen / this._resample)) this._posSamples = 0;
        }
        break;
      }
      case 'startScratch': {
        const pos = Number(d.position) || 0;
        const rate = (typeof d.playbackRate === 'number') ? d.playbackRate : 0.0;
        this._posSamples = pos * sampleRate;
        this._playbackRate = rate;
        this._smoothedRate = rate;
        // cancel any lingering fling
        this._flingActive = false; this._flingRate = 0; this._flingEndedFlag = false;
        this._scratchActive = true;
        break;
      }
      case 'setPosition': {
        const pos = Number(d.position) || 0;
        this._posSamples = pos * sampleRate;
        // ensure we output from the new position
        this._scratchActive = true;
        // if flinging, cancel fling (explicit position set wins)
        if(this._flingActive){ this._flingActive = false; this._flingRate = 0; this._flingEndedFlag = false; }
        break;
      }
      case 'setRate': {
        if(typeof d.playbackRate === 'number'){
          this._playbackRate = d.playbackRate;
          // If commanded to near-zero, snap immediately to zero to avoid lingering motion
          const ZERO_TGT = 5e-3; // target threshold
          if(Math.abs(this._playbackRate) < ZERO_TGT){
            this._playbackRate = 0.0;
            this._smoothedRate = 0.0;
          }
        }
        break;
      }
      case 'stopScratch': {
        this._scratchActive = false;
        break;
      }
      case 'setHold': {
        this._hold = !!d.holding;
        if(this._hold){ this._playbackRate = 0.0; this._smoothedRate = 0.0; }
        break;
      }
      case 'fling': {
        // Start a fling with an initial rate and optional tau
        let r = typeof d.rate === 'number' ? d.rate : 0;
        let tau = (typeof d.tau === 'number' && d.tau > 0) ? d.tau : 0.4;
        // clamp rate to sane bounds
        r = Math.max(-4, Math.min(4, r));
        this._hold = false;
        this._scratchActive = true;
        this._flingActive = Math.abs(r) > 0.0005;
        this._flingRate = r;
        this._flingTau = tau;
        this._playbackRate = r;
        this._smoothedRate = r;
        this._flingEndedFlag = false;
        try{ this.port.postMessage({cmd:'debug', message:'fling-start', rate:r, tau}); }catch(_e){}
        break;
      }
    }
  }

  process(inputs, outputs){
    const output = outputs[0];
    if(!output || output.length === 0) return true;

  const frames = output[0].length;

    if(!this._scratchActive || !this.channels || this.channels.length === 0 || !this._bufLen){
      for(let ch=0; ch<output.length; ch++) output[ch].fill(0);
      return true;
    }

    const numOutCh = output.length;
    const bufChCount = this.channels.length;
    const resample = this._resample;
    const bufLen = this._bufLen;
    const maxPosSamples = bufLen ? (bufLen / resample) : 0;

  let flingEnded = false;
  const gateK = 1 - Math.exp(-1 / (sampleRate * this._gateTau));
    const flingDecayPerSample = (this._flingActive && this._flingTau > 0) ? Math.exp(-1 / (sampleRate * this._flingTau)) : 1.0;
  for(let i=0;i<frames;i++){
      // Exponential smoothing on playbackRate to reduce zipper noise
      if(this._hold){
        this._playbackRate = 0.0; this._smoothedRate = 0.0;
      } else if(this._flingActive){
        // During fling, drive rate directly and decay per-sample
        this._playbackRate = this._flingRate;
        this._smoothedRate = this._flingRate;
      } else {
        // clamp incoming playbackRate to reasonable bounds
        const clampedTarget = Math.max(-8, Math.min(8, this._playbackRate));
        this._smoothedRate += (clampedTarget - this._smoothedRate) * this._rateSmoothing;
      }
      const ZERO_TGT = 5e-3; // target near-zero threshold
      const ZERO_SNAP = 2e-3; // smoothed snap threshold
      // Snap logic: if target is near zero or smoothed is very small, clamp to 0
      if(!this._flingActive && (Math.abs(this._playbackRate) < ZERO_TGT || Math.abs(this._smoothedRate) < ZERO_SNAP)){
        this._smoothedRate = 0.0;
      }

  // Determine if we should mute output (hold or effectively zero speed when not flinging)
  const muteNow = this._hold || (!this._flingActive && Math.abs(this._smoothedRate) < ZERO_SNAP);
  // update gate envelope toward target (0 when muted, 1 when active)
  const gateTarget = muteNow ? 0.0 : 1.0;
  this._gateGain += (gateTarget - this._gateGain) * gateK;
      // Compute buffer index with resampling
      const bufIndex = this._posSamples * resample;
      const idx = Math.floor(bufIndex);
      const frac = bufIndex - idx;

      for(let ch=0; ch<numOutCh; ch++){
        const src = this.channels[ch < bufChCount ? ch : 0];
        let s = 0.0;
        if(!muteNow && src){
          // 4-point cubic interpolation (Catmull-Rom like) for smoother pitch shifts
          const i0 = Math.max(0, idx - 1);
          const i1 = Math.max(0, Math.min(idx, src.length - 1));
          const i2 = Math.max(0, Math.min(idx + 1, src.length - 1));
          const i3 = Math.max(0, Math.min(idx + 2, src.length - 1));
          const p0 = src[i0];
          const p1 = src[i1];
          const p2 = src[i2];
          const p3 = src[i3];
          const t = frac;
          const a0 = -0.5*p0 + 1.5*p1 - 1.5*p2 + 0.5*p3;
          const a1 = p0 - 2.5*p1 + 2*p2 - 0.5*p3;
          const a2 = -0.5*p0 + 0.5*p2;
          const a3 = p1;
          s = ((a0*t + a1)*t + a2)*t + a3;
        } else {
          s = 0.0; // explicit silence during holds/near-zero speeds to avoid DC buzz
        }
        // apply gate envelope to avoid hard edges
        output[ch][i] = s * this._gateGain;
      }

  // Advance position only when target rate is not near zero; freeze on holds
  const targetZero = this._hold || (!this._flingActive && Math.abs(this._playbackRate) < ZERO_TGT);
  if(!targetZero){ this._posSamples += this._smoothedRate; }
      if(this._posSamples < 0) this._posSamples = 0;
      if(maxPosSamples && this._posSamples >= maxPosSamples) this._posSamples = maxPosSamples - 1;
      // Update fling decay and termination
      if(this._flingActive){
  // keep fling rate within sane limits and decay
  this._flingRate = Math.max(-8, Math.min(8, this._flingRate * flingDecayPerSample));
        if(Math.abs(this._flingRate) < 1e-3){
          this._flingActive = false; this._playbackRate = 0.0; this._smoothedRate = 0.0;
          flingEnded = true;
        }
      }
    }

    // Notify fling end once at the end of the block
    if(flingEnded && !this._flingEndedFlag){
      this._flingEndedFlag = true;
      try{
        const posSeconds = this._posSamples / sampleRate;
        this.port.postMessage({cmd:'flingEnd', positionSeconds: posSeconds});
        this.port.postMessage({cmd:'debug', message:'fling-end', pos: posSeconds});
      }catch(_e){}
    }

    return true;
  }
}

registerProcessor('scratch-processor', ScratchProcessor);
