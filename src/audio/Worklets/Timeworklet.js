// Minimal AudioWorkletProcessor stub for timing; currently used for scheduling hooks
class TimeworkletProcessor extends AudioWorkletProcessor{
  constructor(){ super(); }
  process(inputs, outputs, parameters){
    // no audio processing here; timing messages can be exchanged via port
    return true;
  }
}
registerProcessor('timeworklet-processor', TimeworkletProcessor);
