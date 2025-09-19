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

  // --- temporary debugging knobs for PRELOAD_LEAD, CROSSFADE (ms), and FLING params ---
  (function addTimingKnobs(){
    const knobsWrap = document.createElement('div');
    knobsWrap.style.position = 'fixed';
    knobsWrap.style.right = '12px';
  // position slightly below the top bar so it doesn't overlap the Dev tools button
  knobsWrap.style.top = '56px';
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

    function makeFlingKnob(labelText, initialVal, min, max, step, onChange){
      const row = document.createElement('div'); row.style.marginBottom='8px';
      const label = document.createElement('div'); label.textContent = labelText + ': ' + initialVal.toFixed(2); label.style.marginBottom='4px';
      const input = document.createElement('input'); input.type='range'; input.min=String(min); input.max=String(max); input.step=String(step); input.value=String(initialVal); input.style.width='180px';
      input.addEventListener('input', (ev)=>{ const v = Number(ev.target.value); label.textContent = labelText + ': ' + v.toFixed(2); onChange(v); });
      row.appendChild(label); row.appendChild(input); return row;
    }

    const initialPreMs = ((decks.A && decks.A.PRELOAD_LEAD)? decks.A.PRELOAD_LEAD*1000 : 16);
    const initialXfadeMs = ((decks.A && decks.A.CROSSFADE)? decks.A.CROSSFADE*1000 : 40);
    const preloadKnob = makeKnob('Preload lead', initialPreMs, (ms)=>{ const s = ms/1000; if(decks.A) decks.A.setPreloadLead(s); if(decks.B) decks.B.setPreloadLead(s); });
    const xfadeKnob = makeKnob('Crossfade', initialXfadeMs, (ms)=>{ const s = ms/1000; if(decks.A) decks.A.setCrossfade(s); if(decks.B) decks.B.setCrossfade(s); });

  // Fling knobs (read/write window.VibesDebugFling consumed by DeckUI)
    const fling = (window.VibesDebugFling = window.VibesDebugFling || { minRate: 0.18, minDegPerSec: 65, tau: 0.45, speedMult: 2.0 });
    const minRateKnob = makeFlingKnob('Fling min rate (x)', fling.minRate, 0.05, 0.6, 0.01, (v)=>{ fling.minRate = v; });
    const minDegKnob = makeFlingKnob('Fling min deg/sec', fling.minDegPerSec, 10, 180, 1, (v)=>{ fling.minDegPerSec = v; });
    const tauKnob = makeFlingKnob('Fling tau (s)', fling.tau, 0.10, 1.50, 0.01, (v)=>{ fling.tau = v; });
    const speedMultKnob = makeFlingKnob('Fling speed multiplier', fling.speedMult, 1.0, 6.0, 0.1, (v)=>{ fling.speedMult = v; });

  // Scratch sensitivity knobs
  const scratch = (window.VibesScratchCfg = window.VibesScratchCfg || { sensitivity: 1.0, maxRateBase: 4.0 });
  const sensKnob = makeFlingKnob('Scratch sensitivity', scratch.sensitivity, 0.5, 10.0, 0.1, (v)=>{ scratch.sensitivity = v; });
  const maxRateKnob = makeFlingKnob('Scratch max rate base', scratch.maxRateBase, 1.0, 20.0, 0.5, (v)=>{ scratch.maxRateBase = v; });

    // Fling acceleration (visual) after fling end
    const accel = (window.VibesFlingAccel = window.VibesFlingAccel || { duration: 0.5 });
    const accelDurKnob = makeFlingKnob('Accel after fling (s)', accel.duration, 0.1, 1.5, 0.05, (v)=>{ accel.duration = v; });

    knobsWrap.appendChild(preloadKnob);
    knobsWrap.appendChild(xfadeKnob);
    knobsWrap.appendChild(minRateKnob);
    knobsWrap.appendChild(minDegKnob);
    knobsWrap.appendChild(tauKnob);
    knobsWrap.appendChild(speedMultKnob);
    knobsWrap.appendChild(sensKnob);
    knobsWrap.appendChild(maxRateKnob);
    knobsWrap.appendChild(accelDurKnob);
    document.body.appendChild(knobsWrap);
    // expose globally for toggle controls
    window.VibesDebugPanel = knobsWrap;
  })();
  // --- end knobs ---

  // Dev tools dropdown in topbar (right) to show/hide the debug sliders
  (function addDevToolsDropdown(){
    const right = document.querySelector('.topbar .right-status');
    if(!right) return;
    const dd = document.createElement('div'); dd.className = 'devtools-dropdown';
    const btn = document.createElement('button'); btn.className = 'devtools-btn'; btn.textContent = 'Dev tools ▾';
    const menu = document.createElement('div'); menu.className = 'devtools-menu';
    const miShow = document.createElement('div'); miShow.className = 'devtools-item'; miShow.textContent = 'Show sliders';
    const miHide = document.createElement('div'); miHide.className = 'devtools-item'; miHide.textContent = 'Hide sliders';
    menu.append(miShow, miHide);
    dd.append(btn, menu);
    right.appendChild(dd);

    // initial visibility from localStorage
    const PANEL_KEY = 'vibes.devtools.visible';
    const setVisible = (vis)=>{
      const panel = window.VibesDebugPanel; if(!panel) return;
      panel.style.display = vis ? 'block' : 'none';
      try{ localStorage.setItem(PANEL_KEY, vis ? '1' : '0'); }catch(e){}
    };
    try{
      const saved = localStorage.getItem(PANEL_KEY);
      if(saved === '0') setVisible(false);
    }catch(e){}

    function closeMenu(){ dd.classList.remove('open'); }
    btn.addEventListener('click', (e)=>{ e.stopPropagation(); dd.classList.toggle('open'); });
    document.addEventListener('click', closeMenu);
    miShow.addEventListener('click', (e)=>{ e.stopPropagation(); setVisible(true); closeMenu(); });
    miHide.addEventListener('click', (e)=>{ e.stopPropagation(); setVisible(false); closeMenu(); });
  })();
});
