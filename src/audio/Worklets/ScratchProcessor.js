// ScratchProcessor.js
// Simple AudioWorkletProcessor that plays from a supplied Float32 channel buffer
// and accepts position / playbackRate / scratch start/stop commands from the main thread.

class ScratchProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.channels = []; // array of Float32Array
    this._bufLen = 0;
    this._bufSampleRate = sampleRate; // sample rate of provided buffer (may differ)
    this._resample = 1.0; // bufferSR / outputSR
    this._posSamples = 0.0; // position in output-rate samples (float)
    this._playbackRate = 1.0; // target playbackRate multiplier (logical)
    this._smoothedRate = 1.0; // smoothed rate used for sample stepping
    this._rateSmoothing = 0.08; // smoothing factor (0-1), lower = smoother
    this._scratchActive = false;
    this.port.onmessage = this._onMessage.bind(this);
  }

  _onMessage(e){
    const d = e.data || {};
    const cmd = d.cmd;
    if(cmd === 'setBuffer'){
      // expects d.channels = Array<Float32Array>, d.sampleRate = number
      if(Array.isArray(d.channels) && d.channels.length){
        this.channels = d.channels;
        this._bufLen = this.channels[0].length || 0;
        this._bufSampleRate = d.sampleRate || sampleRate;
        this._resample = (this._bufSampleRate || sampleRate) / sampleRate;
        // reset position to start if out of range
        if(this._posSamples >= this._bufLen / this._resample) this._posSamples = 0;
      }
    }else if(cmd === 'startScratch'){
      const pos = typeof d.position === 'number' ? d.position : 0;
      this._posSamples = (pos * sampleRate) || 0;
      this._playbackRate = typeof d.playbackRate === 'number' ? d.playbackRate : 0.0;
      this._scratchActive = true;
    }else if(cmd === 'setPosition'){
      const pos = typeof d.position === 'number' ? d.position : 0;
      this._posSamples = pos * sampleRate;
    }else if(cmd === 'setRate'){
      this._playbackRate = typeof d.playbackRate === 'number' ? d.playbackRate : this._playbackRate;
    }else if(cmd === 'stopScratch'){
      this._scratchActive = false;
    }
  }

  process(inputs, outputs/*, parameters*/){
    const output = outputs[0];
    const frames = output[0].length;

    if(!this.channels || this.channels.length === 0 || !this._scratchActive){
      // output silence while inactive or no buffer
      for(let ch=0; ch<output.length; ch++) output[ch].fill(0);
      return true;
    }

    const numOutCh = output.length;
    const bufChCount = this.channels.length;
    // per-block small local copies for speed
    const resample = this._resample;
    const bufLen = this._bufLen;
    const maxPosSamples = bufLen ? (bufLen / resample) : 0;
    for(let i=0;i<frames;i++){
      // smooth playback rate to avoid zipper noise when it changes abruptly
      this._smoothedRate += (this._playbackRate - this._smoothedRate) * this._rateSmoothing;
      // compute buffer index (float) taking resampling into account
      const bufIndex = this._posSamples * resample;
      let idx = Math.floor(bufIndex);
      const frac = bufIndex - idx;

      // cubic (Catmull-Rom) 4-point interpolation for better quality than linear
      for(let ch=0; ch<numOutCh; ch++){
        const src = this.channels[ch < bufChCount ? ch : 0];
        let s = 0.0;
        if(src && bufLen){
          // gather 4 sample points: p0 = idx-1, p1 = idx, p2 = idx+1, p3 = idx+2
          const get = (n)=>{
            if(n < 0) return src[0] || 0.0;
            if(n >= src.length) return src[src.length-1] || 0.0;
            return src[n] || 0.0;
          };
          const p0 = get(idx-1);
          const p1 = get(idx);
          const p2 = get(idx+1);
          const p3 = get(idx+2);
          const t = frac;
          // Catmull-Rom spline
          const t2 = t * t;
          const t3 = t2 * t;
          s = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2*p0 - 5*p1 + 4*p2 - p3) * t2 + (-p0 + 3*p1 -3*p2 + p3) * t3);
        }
        output[ch][i] = s;
      }

      // advance position in output-sample units by smoothedRate
      this._posSamples += this._smoothedRate;
      // clamp to bounds to avoid reading past end
      if(this._posSamples < 0) this._posSamples = 0;
      if(maxPosSamples && this._posSamples >= maxPosSamples) this._posSamples = maxPosSamples - 1;
    }

    return true;
  }
}

registerProcessor('scratch-processor', ScratchProcessor);
