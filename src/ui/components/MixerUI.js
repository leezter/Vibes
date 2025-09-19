// MixerUI.js - 3-column mixer resembling the provided reference image
// Center column: Master knob, meters, crossfader. Side columns: Channel A/B strips with EQ knobs (inert) and faders.
export function createMixerUI(container, engine, decks){
  container.innerHTML = '';
  container.classList.add('mixer-root');

  // --- Small knob component ---
  // Simple rotary knob with -135..+135 deg sweep. value in [0,1]. Keyboard: arrow keys adjust.
  function createKnob({label, value=0.5, onChange, detent=0.5, step=0.01, ariaLabel}){
    const wrap = document.createElement('div'); wrap.className = 'knob'; wrap.tabIndex = 0; if(ariaLabel) wrap.setAttribute('aria-label', ariaLabel);
    const dial = document.createElement('div'); dial.className = 'knob-dial';
    const tick = document.createElement('div'); tick.className = 'knob-tick'; dial.appendChild(tick);
    const lbl = document.createElement('div'); lbl.className = 'knob-label'; lbl.textContent = label || '';
    wrap.append(dial, lbl);
    let v = Math.max(0, Math.min(1, value));
    const setAngle = (val)=>{
      const ang = -135 + (val * 270);
      dial.style.setProperty('--knob-angle', ang + 'deg');
    };
    const emit = ()=>{ if(typeof onChange==='function') onChange(v); };
    setAngle(v);
    let dragging = false; let lastY = 0; let lastX = 0;
    const toStep = (nv)=> Math.round(nv/step)*step;
    const onPointerDown = (e)=>{ dragging = true; lastY = e.clientY; lastX = e.clientX; wrap.setPointerCapture && wrap.setPointerCapture(e.pointerId); e.preventDefault(); };
    const onPointerMove = (e)=>{
      if(!dragging) return; const dy = e.clientY - lastY; const dx = e.clientX - lastX; lastY = e.clientY; lastX = e.clientX;
      // vertical sensitivity primary, horizontal provides fine adjust
      let nv = v - dy * 0.004 + dx * 0.001;
      // soft snap to detent if close
      if(detent != null && Math.abs(nv - detent) < 0.02) nv = detent;
      nv = Math.max(0, Math.min(1, nv)); nv = toStep(nv);
      if(nv !== v){ v = nv; setAngle(v); emit(); }
    };
    const onPointerUp = (e)=>{ dragging = false; wrap.releasePointerCapture && wrap.releasePointerCapture(e.pointerId); };
    const onKey = (e)=>{
      if(e.key==='ArrowUp' || e.key==='ArrowRight'){ v = Math.min(1, toStep(v+step)); setAngle(v); emit(); e.preventDefault(); }
      if(e.key==='ArrowDown' || e.key==='ArrowLeft'){ v = Math.max(0, toStep(v-step)); setAngle(v); emit(); e.preventDefault(); }
      if(e.key==='Home'){ v = 0; setAngle(v); emit(); e.preventDefault(); }
      if(e.key==='End'){ v = 1; setAngle(v); emit(); e.preventDefault(); }
    };
    wrap.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    wrap.addEventListener('keydown', onKey);
    // expose setter/getter
    wrap.setValue = (nv)=>{ v = Math.max(0, Math.min(1, nv)); setAngle(v); };
    wrap.getValue = ()=> v;
    return wrap;
  }

  // --- Utilities for combined gains ---
  let state = { cross: 0.5, aFader: 1.0, bFader: 1.0, master: 1.0 };
  const clamp01 = (n)=> Math.max(0, Math.min(1, n));
  const safeRangeVal = (el, fallback)=>{
    const n = (typeof el.valueAsNumber === 'number') ? el.valueAsNumber : parseFloat(el.value);
    return Number.isFinite(n) ? clamp01(n) : clamp01(fallback);
  };
  function updateDeckGains(){
    const a = clamp01(state.aFader) * (1 - clamp01(state.cross));
    const b = clamp01(state.bFader) * clamp01(state.cross);
    decks.A.setGain(a);
    decks.B.setGain(b);
  }

  // --- Layout ---
  const grid = document.createElement('div'); grid.className = 'mixer-grid'; container.appendChild(grid);

  // Channel strip factory (EQ knobs inert for now)
  function createChannelStrip(name){
    const strip = document.createElement('div'); strip.className = 'strip'; strip.setAttribute('aria-label', `Channel ${name}`);
    // Top knobs (Trim, Hi, Mid, Low, Filter) - inert except visuals
    const knobRow = document.createElement('div'); knobRow.className = 'strip-knobs';
    const kTrim = createKnob({label:'TRIM', value:0.5});
    const kHi   = createKnob({label:'HI', value:0.5});
    const kMid  = createKnob({label:'MID', value:0.5});
    const kLow  = createKnob({label:'LOW', value:0.5});
    const kFilt = createKnob({label:'FILTER', value:0.5});
    knobRow.append(kTrim,kHi,kMid,kLow,kFilt);

    // Cue button (visual only for now)
    const cue = document.createElement('button'); cue.className='cue-btn'; cue.textContent='CUE'; cue.setAttribute('aria-pressed','false');
    cue.addEventListener('click',()=>{ const p = cue.getAttribute('aria-pressed')==='true'; cue.setAttribute('aria-pressed', String(!p)); cue.classList.toggle('active', !p); });

    // Vertical fader
    const faderWrap = document.createElement('div'); faderWrap.className='fader-vert';
    const fader = document.createElement('input'); fader.type='range'; fader.min='0'; fader.max='1'; fader.step='0.01'; fader.value='1';
    // Improve Firefox vertical slider behavior
    try{ fader.setAttribute('orient','vertical'); }catch(_){}
    faderWrap.appendChild(fader);
    fader.addEventListener('input',()=>{
      if(name==='A'){
        state.aFader = safeRangeVal(fader, state.aFader);
      } else {
        state.bFader = safeRangeVal(fader, state.bFader);
      }
      updateDeckGains();
    });

    strip.append(knobRow, cue, faderWrap);
    return { strip, fader };
  }

  const left = createChannelStrip('A');
  const right = createChannelStrip('B');

  // Center column with master and meters
  const center = document.createElement('div'); center.className='center'; center.setAttribute('aria-label','Master and Meter');
  const masterKnob = createKnob({label:'MASTER LEVEL', value:1.0, onChange:(v)=>{
    // perceptual curve for gain
    const g = Math.pow(v, 2);
    state.master = g; engine.setMasterGain(g);
  }, ariaLabel:'Master level'});

  // Additional center knobs (inert for now)
  const mixKnob = createKnob({label:'MIXING', value:0.5});
  const phonesKnob = createKnob({label:'PHONES LEVEL', value:0.5});
  const samplerKnob = createKnob({label:'SAMPLER LEVEL', value:0.5});

  const centerKnobs = document.createElement('div'); centerKnobs.className='center-knobs';
  centerKnobs.append(masterKnob, mixKnob, phonesKnob, samplerKnob);

  // VU meter (10 segment)
  const meter = document.createElement('div'); meter.className='vu-vertical';
  const segs = []; for(let i=0;i<10;i++){ const s = document.createElement('div'); s.className='vu-seg'; meter.appendChild(s); segs.push(s); }

  // Crossfader (horizontal)
  const crossWrap = document.createElement('div'); crossWrap.className = 'crossfader';
  const cross = document.createElement('input'); cross.type='range'; cross.min='0'; cross.max='1'; cross.step='0.001'; cross.value='0.5'; crossWrap.appendChild(cross);
  cross.addEventListener('input',()=>{ state.cross = safeRangeVal(cross, state.cross); updateDeckGains(); });

  center.append(centerKnobs, meter, crossWrap);

  // Assemble grid
  grid.append(left.strip, center, right.strip);

  // Initial gains
  updateDeckGains();

  // --- Meter wiring ---
  try{
    const analyser = engine.ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.85;
    engine.master.connect(analyser); // extra tap from master to analyser
    const buf = new Uint8Array(analyser.frequencyBinCount);
    function tick(){
      analyser.getByteTimeDomainData(buf);
      // compute RMS
      let sum = 0; for(let i=0;i<buf.length;i++){ const v = (buf[i]-128)/128; sum += v*v; }
      const rms = Math.sqrt(sum / buf.length); // ~0..1
      // light segments proportionally; last two are red
      const active = Math.min(10, Math.max(0, Math.round(rms * 14))); // scale for some headroom
      for(let i=0;i<10;i++){
        segs[i].classList.toggle('on', i < active);
        segs[i].classList.toggle('warn', i >= 7 && i < active);
        segs[i].classList.toggle('clip', i >= 9 && i < active);
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }catch(e){ /* analyser optional */ }
}
