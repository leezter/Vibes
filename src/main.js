// main.js - app entry, assemble engine, UI and wire interactions
import { AudioEngine } from './audio/AudioEngine.js';
import { createDeckUI } from './ui/components/DeckUI.js';
import { createMixerUI } from './ui/components/MixerUI.js';
import { getAnalysis, putAnalysis } from './storage/db.js';

window.addEventListener('load', async ()=>{
  const engine = new AudioEngine();
  await engine.init();

  const deckAEl = document.getElementById('deckA');
  const deckBEl = document.getElementById('deckB');

  const deckA = createDeckUI(deckAEl, engine, 'A');
  const deckB = createDeckUI(deckBEl, engine, 'B');
  const decks = {A:deckA,B:deckB};
  let activeDeck = deckA; // default

  // clicking inside a deck sets it as active
  deckAEl.addEventListener('click', ()=> activeDeck = deckA);
  deckBEl.addEventListener('click', ()=> activeDeck = deckB);

  const mixerEl = document.getElementById('mixer');
  createMixerUI(mixerEl, engine, decks);

  // basic track list interactions
  const selectFolder = document.getElementById('selectFolder');
  const folderPicker = document.getElementById('folderPicker');
  const trackList = document.getElementById('trackList');
  selectFolder.addEventListener('click',()=> folderPicker.click());
  folderPicker.addEventListener('change',()=>{
    for(const f of folderPicker.files){ addTrackToList(f); }
  });

  function addTrackToList(file){
    const el = document.createElement('div'); el.className='track'; el.textContent=file.name; el.draggable=true;
    el.addEventListener('dblclick',()=>{ deckA.loadFile(file); });
    el.addEventListener('dragstart', e=>{ e.dataTransfer.setData('text/plain', file.name); e.dataTransfer._file = file; });
    trackList.appendChild(el);
  }

  // register service worker
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('/sw.js').then(()=>console.log('sw registered'));
  }

  // keyboard shortcuts (basic)
  window.addEventListener('keydown', (e)=>{
    if(e.code==='Space'){ e.preventDefault(); activeDeck.playing?activeDeck.pause():activeDeck.play(); }
    // hotcues quick access (deck A 1-4, deck B 5-8 mapped by numeric keys) - simple mapping
    if(e.key==='1') deckA.jumpHotCue(1);
    if(e.key==='2') deckA.jumpHotCue(2);
    if(e.key==='9') deckB.jumpHotCue(1);
    // cue key (Q) - on keydown press behavior
    if(e.key.toLowerCase()==='q'){
      e.preventDefault(); console.debug('[main] keydown Q -> cueHoldStart for activeDeck', activeDeck.id); activeDeck.cueHoldStart();
    }
  });

  window.addEventListener('keyup', (e)=>{
    if(e.key.toLowerCase()==='q'){
      e.preventDefault(); console.debug('[main] keyup Q -> cueHoldEnd for activeDeck', activeDeck.id); activeDeck.cueHoldEnd();
    }
  });

  // --- temporary debugging knobs for PRELOAD_LEAD and CROSSFADE (ms) ---
  (function addTimingKnobs(){
    const knobsWrap = document.createElement('div');
    knobsWrap.style.position = 'fixed';
    knobsWrap.style.right = '12px';
    knobsWrap.style.top = '12px';
    knobsWrap.style.background = 'rgba(0,0,0,0.6)';
    knobsWrap.style.color = '#fff';
    knobsWrap.style.padding = '8px';
    knobsWrap.style.borderRadius = '6px';
    knobsWrap.style.zIndex = '9999';
    knobsWrap.style.fontSize = '12px';
    knobsWrap.style.maxWidth = '220px';

    function makeKnob(labelText, initialMs, onChange){
      const row = document.createElement('div'); row.style.marginBottom='8px';
      const label = document.createElement('div'); label.textContent = labelText + ': ' + initialMs.toFixed(0) + ' ms'; label.style.marginBottom='4px';
      const input = document.createElement('input'); input.type='range'; input.min='0'; input.max='200'; input.step='1'; input.value=String(initialMs); input.style.width='180px';
      input.addEventListener('input', (ev)=>{ const v = Number(ev.target.value); label.textContent = labelText + ': ' + v.toFixed(0) + ' ms'; onChange(v); });
      row.appendChild(label); row.appendChild(input); return row;
    }

    const initialPreMs = ((decks.A && decks.A.PRELOAD_LEAD)? decks.A.PRELOAD_LEAD*1000 : 16);
    const initialXfadeMs = ((decks.A && decks.A.CROSSFADE)? decks.A.CROSSFADE*1000 : 40);
    const preloadKnob = makeKnob('Preload lead', initialPreMs, (ms)=>{ const s = ms/1000; if(decks.A) decks.A.setPreloadLead(s); if(decks.B) decks.B.setPreloadLead(s); });
    const xfadeKnob = makeKnob('Crossfade', initialXfadeMs, (ms)=>{ const s = ms/1000; if(decks.A) decks.A.setCrossfade(s); if(decks.B) decks.B.setCrossfade(s); });
    knobsWrap.appendChild(preloadKnob); knobsWrap.appendChild(xfadeKnob); document.body.appendChild(knobsWrap);
  })();
  // --- end knobs ---
});
