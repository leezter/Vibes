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
    this._playbackRate = 1.0; // multiplier in samples per output sample
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
    for(let i=0;i<frames;i++){
      // compute buffer index (float) taking resampling into account
      const bufIndex = this._posSamples * this._resample;
      const idx = Math.floor(bufIndex);
      const frac = bufIndex - idx;
      for(let ch=0; ch<numOutCh; ch++){
        const src = this.channels[ch < bufChCount ? ch : 0];
        let s = 0.0;
        if(src){
          const a = src[idx] || 0.0;
          const b = src[idx+1] || 0.0;
          s = a * (1-frac) + b * frac;
        }
        output[ch][i] = s;
      }
      // advance position in output-sample units by playbackRate
      this._posSamples += this._playbackRate;
      // clamp and wrap if out of bounds
      const maxPosSamples = (this._bufLen / this._resample) || 0;
      if(this._posSamples < 0) this._posSamples = 0;
      if(maxPosSamples && this._posSamples >= maxPosSamples) this._posSamples = maxPosSamples - 1;
    }

    return true;
  }
}

registerProcessor('scratch-processor', ScratchProcessor);
