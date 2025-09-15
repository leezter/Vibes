// peaks.js - simple multiscale peak builder
function makePeaks(audioBuffer, opts={channels:1}){
  const ch = Math.min(opts.channels||1,audioBuffer.numberOfChannels);
  const data = audioBuffer.getChannelData(0);
  const len = data.length;
  const stride = Math.max(1,Math.floor(len/2000));
  const peaks = [];
  for(let i=0;i<len;i+=stride){
    let max=0; for(let j=i;j<i+stride && j<len;j++) max=Math.max(max,Math.abs(data[j]));
    peaks.push(max);
  }
  return peaks;
}

self.makePeaks = makePeaks; // export to worker scope
