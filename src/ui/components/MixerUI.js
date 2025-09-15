// MixerUI.js - simplistic mixer controls wired to AudioEngine and decks
export function createMixerUI(container, engine, decks){
  const masterGain = document.createElement('input'); masterGain.type='range'; masterGain.min=0; masterGain.max=1; masterGain.step=0.01; masterGain.value=1.0; masterGain.className='slider';
  container.appendChild(document.createTextNode('Master')); container.appendChild(masterGain);
  masterGain.addEventListener('input',()=> engine.setMasterGain(parseFloat(masterGain.value)));

  // global BPM control removed — per-deck BPM sliders are used instead

  const cross = document.createElement('input'); cross.type='range'; cross.min=0; cross.max=1; cross.step=0.01; cross.value=0.5; cross.className='slider';
  container.appendChild(document.createTextNode('Crossfader')); container.appendChild(cross);

  cross.addEventListener('input',()=>{
    // simple linear crossfade
    const v = parseFloat(cross.value);
    decks.A.setGain(1 - v);
    decks.B.setGain(v);
  });

  // channel faders
  ['A','B'].forEach(k=>{
    const label = document.createElement('div'); label.textContent=`Channel ${k}`;
  const f = document.createElement('input'); f.type='range'; f.min=0; f.max=1; f.step=0.01; f.value=1.0; f.className='slider';
    container.append(label,f);
    f.addEventListener('input',()=> decks[k].setGain(parseFloat(f.value)));
  });
}
