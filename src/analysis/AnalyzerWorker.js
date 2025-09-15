// AnalyzerWorker.js - runs in a WebWorker thread
// Responsibilities: compute multiscale peaks, estimate BPM (very simple), compute spectral flux

// peaks.js will be inlined into the worker blob by the main thread; no runtime importScripts required for blob workers

self.onmessage = async (ev)=>{
  const {cmd, fileMeta, arrayBuffer, pcm, sampleRate} = ev.data;
  if(cmd==='analyze' || cmd==='analyzePCM'){
    // Defensive: some browsers/worker environments don't expose OfflineAudioContext.
    // Detect and post back an informative error instead of throwing a ReferenceError.
    const OfflineCtxCtor = typeof self !== 'undefined' && (self.OfflineAudioContext || self.webkitOfflineAudioContext);
  // function-scoped audioBuffer used by both branches
  let audioBuffer = null;
    if(cmd === 'analyze'){
      if(!OfflineCtxCtor){
        self.postMessage({cmd:'error', fileMeta, message: 'OfflineAudioContext is not available in this worker; analysis skipped.'});
        return;
      }
      const audioCtx = new OfflineCtxCtor(1,44100*40,44100);
      try{
        // Some environments support promise-based decodeAudioData, others require callbacks.
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      }catch(err){
        try{
          audioBuffer = await new Promise((resolve,reject)=>audioCtx.decodeAudioData(arrayBuffer, resolve, reject));
        }catch(err2){
          self.postMessage({cmd:'error', fileMeta, message: 'decodeAudioData failed in worker: '+(err2 && err2.message)});
          return;
        }
      }
    }else{
      // analyzePCM: main thread already decoded and sent raw PCM and sampleRate
      if(!pcm || !sampleRate){ self.postMessage({cmd:'error', fileMeta, message:'analyzePCM missing pcm or sampleRate'}); return; }
      // post an immediate debug message so main thread sees we received the PCM
      try{ self.postMessage({cmd:'debug', fileMeta, message:'received-pcm', pcmLen: pcm.length, sampleRate}); }catch(e){}
      // if PCM is extremely large, downsample to a reasonable analysis rate to save memory/CPU
      let processed = pcm;
      let usedSampleRate = sampleRate;
      const TARGET_SR = 44100;
      if(sampleRate > TARGET_SR && pcm.length > TARGET_SR * 30){ // only downsample long audio (>30s)
        const factor = Math.max(1, Math.round(sampleRate / TARGET_SR));
        const newLen = Math.floor(pcm.length / factor);
        const out = new Float32Array(newLen);
        // simple boxcar decimation (average per block)
        for(let i=0, j=0;i+factor<=pcm.length;i+=factor, j++){
          let s = 0;
          for(let k=0;k<factor;k++) s += pcm[i+k];
          out[j] = s / factor;
        }
        processed = out;
        usedSampleRate = Math.round(sampleRate / factor);
        try{ self.postMessage({cmd:'debug', fileMeta, message:'downsampled-pcm', origLen: pcm.length, newLen: out.length, usedSampleRate}); }catch(e){}
      }
      // construct a minimal AudioBuffer-like object using processed PCM
      audioBuffer = {
        getChannelData: (ch)=> processed,
        sampleRate: usedSampleRate,
        numberOfChannels: 1,
        duration: processed.length / usedSampleRate
      };
    }
    // build peaks and run estimators inside try/catch so we always post a message back
    try{
      self.postMessage({cmd:'debug', fileMeta, message: 'analysis-start', duration: audioBuffer.duration, sr: audioBuffer.sampleRate});
      const peaks = makePeaks(audioBuffer, {channels:1});
      // improved bpm estimate using spectral-flux onset detection + autocorrelation
      let bpm = 120;
      let debug = {frames:0,fps:null,bestLag:null,bestVal:null,method:'none'};
      try{
        bpm = estimateBpm(audioBuffer, debug);
        debug.method = debug.method || 'spectral-flux';
      }catch(err){
        // if the estimator throws, post a debug message and fall back
        self.postMessage({cmd:'debug', fileMeta, message: 'estimateBpm threw: '+(err && err.message), stack: err && err.stack});
        // attempt a very simple fallback: autocorrelate amplitude envelope in time domain
        try{ bpm = fallbackBpmFromEnvelope(audioBuffer, debug); debug.method='envelope-fallback'; }
        catch(e){ self.postMessage({cmd:'debug', fileMeta, message:'fallbackBpmFromEnvelope threw: '+(e&&e.message)}); bpm = 120; }
      }
      // include debug info with the result so the main thread can inspect it
      self.postMessage({cmd:'result',fileMeta,peaks,bpm,debug});
    }catch(err){
      // unexpected exception in analysis - post it back so main thread doesn't timeout
      try{ self.postMessage({cmd:'debug', fileMeta, message:'analysis-failed', error: err && err.message, stack: err && err.stack}); }catch(e){}
      // still try to return a minimal result so UI can continue
      self.postMessage({cmd:'result',fileMeta,peaks:[],bpm:120,debug:{error:err&&err.message}});
    }
  }
}

// improved BPM estimator
function estimateBpm(audioBuffer, debug){
  const data = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  // STFT/frame params (smaller sizes for speed and stability)
  // choose conservative defaults that work well for music: 512/256 is faster and still gives usable onset info
  const fftSize = 512;
  const hopSize = 256;
  const window = hann(fftSize);

  // compute short-time energy envelope per frame (much faster than per-frame DFT)
  const frames = new Float32Array(Math.max(0, Math.floor((data.length - fftSize) / hopSize) + 1));
  let fi = 0;
  for(let pos=0; pos+fftSize <= data.length; pos += hopSize){
    let s = 0;
    for(let i=0;i<fftSize;i++){ const v = data[pos+i] * window[i]; s += Math.abs(v); }
    frames[fi++] = s / fftSize; // mean absolute energy
  }
  // allow smaller frame counts but record debug info
  if(typeof debug === 'object') debug.frames = frames.length;
  if(frames.length < 4){
    // too short for spectral method; throw so caller can try a fallback
    throw new Error('not-enough-frames');
  }

  // onset detection from energy envelope: positive differences of energy across frames
  const flux = new Float32Array(frames.length);
  for(let i=1;i<frames.length;i++){
    const diff = frames[i] - frames[i-1];
    flux[i] = diff > 0 ? diff : 0;
  }
  // normalize flux
  let maxFlux = 0; for(let i=0;i<flux.length;i++) if(flux[i]>maxFlux) maxFlux = flux[i];
  if(maxFlux < 1e-9) maxFlux = 1e-9;
  for(let i=0;i<flux.length;i++) flux[i] = flux[i]/maxFlux;
  const smooth = smoothArray(flux, 2);
  // threshold weak onsets (keep only above median + small margin)
  const med = median(Array.from(smooth));
  for(let i=0;i<smooth.length;i++) if(smooth[i] < med * 0.5) smooth[i] = 0;

  // build onset envelope sampled at sr/hopSize (frames per second)
  const fps = sr / hopSize;
  if(typeof debug === 'object') debug.fps = fps;
  // autocorrelate onset envelope to find periodicity
  // mean-subtract envelope to remove DC bias before autocorrelation
  const env = smooth;
  let meanEnv = 0; for(let i=0;i<env.length;i++) meanEnv += env[i]; meanEnv /= Math.max(1, env.length);
  for(let i=0;i<env.length;i++) env[i] -= meanEnv;
  const maxLagSeconds = 60/60; // 1 second (for 60 bpm min we need longer - we'll compute in samples below)

  // autocorrelation in reasonable BPM range 60-180
  const minBpm = 60, maxBpm = 180;
  const minLag = Math.floor(fps * 60 / maxBpm); // lag in frames
  const maxLag = Math.ceil(fps * 60 / minBpm);
  const ac = new Float32Array(maxLag+1);
  for(let lag=minLag; lag<=maxLag; lag++){
    let s=0;
    for(let i=0;i+lag<env.length;i++) s += env[i]*env[i+lag];
    ac[lag]=s;
  }
  // find best lag
  let bestLag = minLag, bestVal = -Infinity;
  for(let l=minLag;l<=maxLag;l++){ if(ac[l]>bestVal){ bestVal=ac[l]; bestLag=l; } }
  if(typeof debug === 'object'){ debug.bestLag = bestLag; debug.bestVal = bestVal; }
  if(!bestVal || bestVal<=0) throw new Error('autocorr-no-peak');
  let bpm = 60 * fps / bestLag;

  // octave correction: if bpm < 90, also check doubling; if bpm > 140, check halving
  if(bpm < 90) bpm *= 2;
  else if(bpm > 140) bpm = Math.round(bpm/2);

  return Math.round(bpm) || 120;
}

// fallback bpm estimator: autocorrelate amplitude envelope (very crude but works on steady beats)
function fallbackBpmFromEnvelope(audioBuffer, debug){
  const data = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  // compute amplitude envelope with a simple absolute + lowpass smoothing
  const env = new Float32Array(Math.floor(data.length/256));
  const step = 256;
  for(let i=0, j=0;i+step<=data.length;i+=step, j++){
    let s=0; for(let k=0;k<step;k++) s+=Math.abs(data[i+k]); env[j]=s/step;
  }
  if(typeof debug === 'object') debug.envLen = env.length;
  if(env.length < 16) throw new Error('envelope-too-short');
  // autocorrelate env
  const maxLag = Math.floor(sr/60/ (step/sr) ); // correspond to 60 bpm
  const minLag = Math.floor(sr/180/ (step/sr) );
  let best=0, bestIdx=minLag;
  for(let lag=minLag; lag<=maxLag; lag++){
    let s=0; for(let i=0;i+lag<env.length;i++) s += env[i]*env[i+lag];
    if(s>best){ best=s; bestIdx=lag; }
  }
  if(best<=0) throw new Error('envelope-autocorr-nopeak');
  // translate lag to bpm: frames-per-second for env is (sr/step), so bpm = 60 * (sr/step) / lag
  const fps = sr/step;
  if(typeof debug === 'object'){ debug.fps = fps; debug.bestLag = bestIdx; debug.bestVal = best; }
  let bpm = 60 * fps / bestIdx;
  if(bpm < 90) bpm *= 2; else if(bpm > 140) bpm = Math.round(bpm/2);
  return Math.round(bpm) || 120;
}

// helpers: hann window
function hann(N){ const w = new Float32Array(N); for(let n=0;n<N;n++) w[n] = 0.5*(1-Math.cos(2*Math.PI*n/(N-1))); return w; }

// magnitude spectrum using simple FFT (cooley-tukey) - minimal implementation
function magnitudeSpectrum(buffer){
  // use naive DFT for simplicity (fftSize 1024, acceptable in worker)
  const N = buffer.length;
  const half = N/2;
  const mags = new Float32Array(half);
  for(let k=0;k<half;k++){
    let re=0, im=0;
    for(let n=0;n<N;n++){
      const phi = -2*Math.PI*k*n/N;
      re += buffer[n]*Math.cos(phi);
      im += buffer[n]*Math.sin(phi);
    }
    mags[k] = Math.sqrt(re*re + im*im);
  }
  return mags;
}

function smoothArray(arr, radius){
  const out = new Float32Array(arr.length);
  const w = radius*2+1;
  for(let i=0;i<arr.length;i++){
    let s=0;
    for(let j=Math.max(0,i-radius); j<=Math.min(arr.length-1,i+radius); j++) s+=arr[j];
    out[i]=s/(Math.min(arr.length-1,i+radius)-Math.max(0,i-radius)+1);
  }
  return out;
}

function median(values){
  if(!values || values.length===0) return 0;
  const arr = values.slice().sort((a,b)=>a-b);
  const m = Math.floor(arr.length/2);
  return (arr.length%2===1) ? arr[m] : (arr[m-1]+arr[m])/2;
}
