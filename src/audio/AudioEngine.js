// AudioEngine.js
// Central audio graph: AudioContext, master bus, routing, master meters

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.masterGain = null;
    this.outputNode = null;
    this.decks = {};
  }

  async init() {
    if (this.ctx) return;
  // let the browser choose the best sample rate for the device/context
  this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this._maybeRegisterWorklet();
  this.master = this.ctx.createGain();
  // unity gain at master by default to avoid unwanted attenuation
  this.master.gain.value = 1.0;
    this.masterGain = this.master;

    // simple limiter stub: onboard built-in dynamics can be added later
    this.outputNode = this.ctx.destination;
    this.master.connect(this.outputNode);
  }

  async _maybeRegisterWorklet(){
    try{
      if(this.ctx && this.ctx.audioWorklet){
        // register core worklets; tolerance for failures per-module
        const modules = ['/src/audio/Worklets/Timeworklet.js','/src/audio/Worklets/ScratchProcessor.js'];
        for(const m of modules){
          try{ 
            console.debug('[AudioEngine] registering worklet:', m);
            await this.ctx.audioWorklet.addModule(m); 
            console.debug('[AudioEngine] successfully registered:', m);
          }
          catch(e){ console.warn('[AudioEngine] failed to register worklet', m, e); }
        }
      }
    }catch(e){
      console.warn('[AudioEngine] AudioWorklet not available',e);
    }
  }

  connectDeck(deckNode){
    // deckNode expected to be a GainNode or AudioNode chain
    if(!this.master) throw new Error('AudioEngine not initialized');
    deckNode.connect(this.master);
  }

  setMasterGain(v){ this.master.gain.value = v; }
}
