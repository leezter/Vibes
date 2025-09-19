// DeckUI.js - builds the DOM for a single deck and wires basic controls
import { Deck } from '../../audio/Deck.js';
import { putAnalysis, getAnalysis, putTrackMeta } from '../../storage/db.js';
import Platter from './Platter.js';

export function createDeckUI(container, engine, id){
  const deck = new Deck(engine,id);
  container.classList.add('deck-panel');

  const dd = document.createElement('div'); dd.className='drag-drop'; dd.textContent='Drag a song on this deck to load it';
  // use the Platter component for a richer visual
  // if this is the left deck (id === 'A') prefer the custom transparent platter image
  const imageUrl = (id === 'A') ? '/assets/platter-left.png' : (id === 'B' ? '/assets/platter-right.png' : null);
  const platterComp = new Platter({ size: 360, rpm: 33.333, spinning: false, labelText: '', imageUrl });
  // If imageUrl was provided, try to load it; if it exists the Platter will display it.
  if(imageUrl){
    const testImg = new Image();
    testImg.onload = ()=>{ try{ platterComp.setImage(imageUrl); }catch(e){} };
    testImg.onerror = ()=>{/* image not present - ignore */};
    testImg.src = imageUrl;
  }
  const platterWrap = platterComp.el;
  // create waveform canvas; this will be placed where the small jog used to be
  const canvas = document.createElement('canvas'); canvas.className='canvas';
  const wave = document.createElement('div'); wave.className='waveform'; wave.appendChild(canvas);
  const controls = document.createElement('div'); controls.className='controls';
  const playBtn=document.createElement('button'); playBtn.className='button'; playBtn.textContent='Play';
  const cueBtn=document.createElement('button'); cueBtn.className='button'; cueBtn.textContent='Cue';
  const syncBtn=document.createElement('button'); syncBtn.className='button'; syncBtn.textContent='Sync';
  controls.append(playBtn,cueBtn,syncBtn);
  // per-deck BPM display and slider
  const bpmWrap = document.createElement('div'); bpmWrap.className='bpm-wrap';
  const bpmLabel = document.createElement('span'); bpmLabel.textContent = 'BPM:'; bpmLabel.style.marginRight='6px';
  const bpmDetected = document.createElement('span'); bpmDetected.className='bpm-detected'; bpmDetected.textContent='—'; bpmDetected.style.marginRight='8px';
  const bpmTargetVal = document.createElement('span'); bpmTargetVal.className='bpm-target'; bpmTargetVal.textContent='120'; bpmTargetVal.style.margin='0 8px';
  const bpmSlider = document.createElement('input'); bpmSlider.type='range'; bpmSlider.min=60; bpmSlider.max=180; bpmSlider.step=1; bpmSlider.className='slider';
  // default slider visually centered between min and max
  bpmSlider.value = String((parseInt(bpmSlider.min,10) + parseInt(bpmSlider.max,10)) / 2);
  bpmWrap.append(bpmLabel,bpmDetected,bpmTargetVal,bpmSlider);
  controls.appendChild(bpmWrap);
  const hotcueWrap=document.createElement('div'); hotcueWrap.className='hotcues';
  for(let i=1;i<=8;i++){ const b=document.createElement('div'); b.className='hotcue'; b.textContent=i; b.dataset.c=i; hotcueWrap.appendChild(b)}

  // place the waveform directly under the platter and before controls so it spans the deck width
  container.append(dd,platterWrap,wave,controls,hotcueWrap);

  // allow dropping an image onto the platter to set a custom platter image at runtime
  platterWrap.addEventListener('dragover', (e)=>{ e.preventDefault(); platterWrap.style.outline = '2px dashed rgba(255,255,255,0.06)'; });
  platterWrap.addEventListener('dragleave', (e)=>{ platterWrap.style.outline = ''; });
  platterWrap.addEventListener('drop', (e)=>{
    e.preventDefault(); platterWrap.style.outline = '';
    const f = (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    if(!f) return;
    if(f.type && f.type.startsWith('image/')){
      const url = URL.createObjectURL(f);
      platterComp.setImage(url);
    }
  });

  // Pointer-based scratching on platter
  // We expect platterComp.el to be a square element; interpret pointer movement as rotation around center
  let isScratching = false;
  let lastAngle = 0;
  let lastTs = 0;
  let lastScratchPos = null;
  let initialPlatterAngle = 0;
  let pointerStartAngle = 0;
  let pointerStartRadius = 0;
  let lastVelDegPerSec = 0; // for fling
  let lastSmoothedRate = 0; // for fling
  let lastNonZeroRate = 0;  // last non-zero smoothed rate seen during move
  let lastNonZeroTime = 0;  // timestamp when lastNonZeroRate was captured
  // UI-side smoothing for playbackRate to avoid zipper noise when sending frequent updates
  let uiLastRate = 1.0;
  let lastSentMs = 0;
  let lastMoveTs = 0;
  // hold state with hysteresis to prevent chattering around the deadzone
  let inHold = false;
  // Debug-configurable fling parameters accessible from main.js knobs
  const FlingCfg = (window.VibesDebugFling = window.VibesDebugFling || {
    minRate: 0.18,       // minimum |rate| to trigger fling
    minDegPerSec: 65,    // fallback threshold if rate is derived from deg/sec
    tau: 0.45,           // decay time constant in seconds
    speedMult: 2.0       // fling speed multiplier (applied to computed rate)
  });
  // Debug-configurable scratch sensitivity (how many track seconds per platter rotation)
  const ScratchCfg = (window.VibesScratchCfg = window.VibesScratchCfg || {
    sensitivity: 1.0,    // 1.0 = 1 rotation == 1 second; raise to go faster (e.g., 5.0)
    maxRateBase: 4.0     // base clamp for |rate|; effective clamp = maxRateBase * sensitivity
  });

  // Fling visual animation state (platter rotation during fling)
  let flingRAF = null;
  let flingOmega = 0; // deg/sec
  let flingTau = 0.45;
  let flingLastTs = 0;
  function startFlingVisual(rate, tau){
    stopFlingVisual();
    // Drive platter by integrating an exponentially decaying angular velocity
    flingOmega = (rate || 0) * 360; // rate 1.0 -> 360 deg/sec
    flingTau = Math.max(0.05, tau || 0.45);
    flingLastTs = performance.now();
    // ensure platter isn't also spinning via internal RAF
    platterComp.setSpinning(false);
    const tick = (ts)=>{
      const dt = (ts - flingLastTs) / 1000; flingLastTs = ts;
      // integrate rotation at current omega
      const angleDelta = flingOmega * dt;
      try{ platterComp.setAngle(platterComp.getAngle() + angleDelta); }catch(_e){}
      // exponential decay of omega
      const decay = Math.exp(-dt / flingTau);
      flingOmega *= decay;
      if(Math.abs(flingOmega) < 2){ flingRAF = null; return; } // stop when very slow (<2 deg/sec)
      flingRAF = requestAnimationFrame(tick);
    };
    flingRAF = requestAnimationFrame(tick);
  }
  function stopFlingVisual(){ if(flingRAF){ cancelAnimationFrame(flingRAF); flingRAF = null; } }

  // Platter acceleration ramp after fling -> normal playback
  let accelRAF = null; let accelLastTs = 0; let accelOmega = 0; let accelTargetOmega = 0; let accelDur = 0.5; let accelElapsed = 0;
  function startPlatterAccelRamp(targetRpm, durationSec){
    stopFlingVisual(); // ensure fling loop is stopped
    stopPlatterAccelRamp();
    accelDur = Math.max(0.05, durationSec || 0.5);
    accelElapsed = 0; accelLastTs = performance.now();
    // Start from zero speed by design: ramp from 0 to target over accelDur
    accelOmega = 0; // deg/sec
    accelTargetOmega = (targetRpm || 33.333) * 6;
    platterComp.setSpinning(false);
    const tick = (ts)=>{
      const dt = (ts - accelLastTs) / 1000; accelLastTs = ts; accelElapsed += dt;
      const t = Math.min(1, accelElapsed / accelDur);
      // smoothstep for a softer ease-in
      const s = t*t*(3 - 2*t);
      const omega = accelTargetOmega * s; // strictly 0 -> target, no overshoot
      try{ platterComp.setAngle(platterComp.getAngle() + omega * dt); }catch(_e){}
      if(t >= 1){ accelRAF = null; platterComp.setSpinning(true); platterComp.setRpm((accelTargetOmega/6)); return; }
      accelRAF = requestAnimationFrame(tick);
    };
    accelRAF = requestAnimationFrame(tick);
  }
  function stopPlatterAccelRamp(){ if(accelRAF){ cancelAnimationFrame(accelRAF); accelRAF = null; } }
  const getAngle = (clientX, clientY)=>{
    const r = platterWrap.getBoundingClientRect();
    const cx = r.left + r.width/2; const cy = r.top + r.height/2;
    const dx = clientX - cx; const dy = clientY - cy;
    const ang = Math.atan2(dy, dx) * 180 / Math.PI; // degrees
    const dist = Math.sqrt(dx*dx + dy*dy);
    return { ang, dist };
  };

  const onPointerDown = (e)=>{
    e.preventDefault(); platterWrap.setPointerCapture && platterWrap.setPointerCapture(e.pointerId);
    isScratching = true; lastTs = performance.now();
    // pointerStartAngle is the angle where the pointer was clicked (for delta tracking)
  const angObj = getAngle(e.clientX, e.clientY);
  pointerStartAngle = angObj.ang;
  pointerStartRadius = angObj.dist || 0;
    // remember the platter's current visual angle so rotation is relative to it (no snap)
    try{ initialPlatterAngle = platterComp.getAngle(); }catch(err){ initialPlatterAngle = 0; }
    // set lastAngle for velocity calculations to the initial pointer angle
    lastAngle = pointerStartAngle;
    // if deck is playing, pause the regular BufferSource so only the scratch node produces audio
    const wasPlaying = !!deck.playing;
    if(wasPlaying){ deck.stopImmediate(); }
    // stop automatic platter spinning so pointer controls visual
    platterComp.setSpinning(false);
    // initialize scratch node and notify Deck to start scratch from current position
  const pos = deck.getPosition();
    lastScratchPos = pos;
  // start scratch with zero rate so a pure hold is silent and stops immediately
  deck.scratchStart(pos, 0.0);
    // start in hold state until meaningful movement exits hold
    inHold = true; try{ deck.scratchSetHold(true); deck.scratchSetRate(0); }catch(_e){}
    // reset UI smoothing state
    uiLastRate = 1.0;
    lastMoveTs = performance.now();
    // store flag to resume when pointer up
    platterWrap._wasPlayingBeforeScratch = wasPlaying;
  };
  const onPointerMove = (e)=>{
    if(!isScratching) return;
  const now = performance.now(); const angObj = getAngle(e.clientX, e.clientY);
    const dt = Math.max(1, now - lastTs) / 1000; // s
    // if pointer moved into an inner deadzone near spindle, ignore to avoid unstable angles
    const MIN_RADIUS = Math.min(platterWrap.clientWidth, platterWrap.clientHeight) * 0.06; // 6% of platter size (less aggressive)
    // compute delta angle in degrees (frame-to-frame), normalize to -180..180
  let dAng = angObj.ang - lastAngle; while(dAng > 180) dAng -= 360; while(dAng < -180) dAng += 360;
  // small deadzone to suppress tiny jitter (e.g., from radial movement or pointer noise)
    // Deadzone with hysteresis: smaller threshold to enter hold, larger to exit
  const HOLD_ENTER_DEG = 0.25;
  const HOLD_EXIT_DEG = 0.5;
    if(inHold){
      if(Math.abs(dAng) > HOLD_EXIT_DEG) inHold = false;
    } else {
      if(Math.abs(dAng) < HOLD_ENTER_DEG) inHold = true;
    }
    const isHoldThisFrame = inHold;
    if(isHoldThisFrame) dAng = 0;
    // angular velocity (deg/sec)
  // If inside inner radius, scale down delta rather than dropping the frame entirely
  let scaledDAng = dAng;
  if(angObj.dist < MIN_RADIUS){
    const scale = Math.max(0.15, angObj.dist / MIN_RADIUS); // keep some response
    scaledDAng = dAng * scale;
  }
  const vel = scaledDAng / dt;
  lastVelDegPerSec = vel;
  // compute rate; clamp to avoid extreme speeds, then lightly smooth
  const sens = ScratchCfg.sensitivity || 1.0;
  const maxRate = Math.max(1, (ScratchCfg.maxRateBase || 4) * sens);
  const rawRate = Math.max(-maxRate, Math.min(maxRate, (vel / 360) * sens));
  let smoothedRate = uiLastRate * 0.3 + rawRate * 0.7; // emphasize responsiveness; worklet also smooths
  if(isHoldThisFrame){ smoothedRate = 0; }
  uiLastRate = smoothedRate;
  lastSmoothedRate = smoothedRate;
  if(!isHoldThisFrame && Math.abs(smoothedRate) > 0.02){ lastNonZeroRate = smoothedRate; lastNonZeroTime = now; }
    
    // compute new position by integrating angular delta into seconds
    const basePos = (typeof lastScratchPos === 'number') ? lastScratchPos : deck.getPosition();
  const dtSeconds = (scaledDAng / 360) * sens; // scaled sensitivity
  const newPos = isHoldThisFrame ? basePos : Math.max(0, Math.min((deck.buffer?deck.buffer.duration:0), basePos + dtSeconds));
    lastScratchPos = newPos;
    
    // track movement timing - detect any movement
    if(Math.abs(dAng) >= 0.1){ lastMoveTs = performance.now(); }
    
    // send rate updates at regular intervals; send position only occasionally to reduce zipper noise
    const nowMs = performance.now();
    if(nowMs - lastSentMs >= 15){ // ~66Hz: frequent asserts
      // Drive hold flag into worklet for deterministic freeze, and push explicit rate
      deck.scratchSetHold(isHoldThisFrame);
      deck.scratchSetRate(isHoldThisFrame ? 0 : smoothedRate);
      lastSentMs = nowMs;
    }
    // Note: avoid periodic position corrections while actively scratching to prevent
    // audible "spring" artifacts (feedback between UI corrections and worklet smoothing).
    // We rely on rate-only updates during scratch and set the initial position on scratchStart.
    // separate check for stopping - zero rate quickly when no movement detected
    if(nowMs - lastMoveTs > 30 && Math.abs(smoothedRate) > 0.0005){
      deck.scratchSetRate(0);
      uiLastRate = 0;
    }
    // update platter visual angle relative to the platter's initial angle (avoid snapping to pointer)
  const newVisualAngle = initialPlatterAngle + (angObj.ang - pointerStartAngle);
    try{ platterComp.setAngle(newVisualAngle); }catch(e){}
    lastAngle = angObj.ang; lastTs = now;
  };
  const onPointerUp = (e)=>{
    if(!isScratching) return; isScratching=false; try{ platterWrap.releasePointerCapture && platterWrap.releasePointerCapture(e.pointerId); }catch(e){}
    // Compute a fresh release velocity from the final pointer delta so we don't miss fling due to last frame being in hold
    const now = performance.now();
    const angObj = getAngle(e.clientX, e.clientY);
    let dAngRelease = angObj.ang - lastAngle; while(dAngRelease > 180) dAngRelease -= 360; while(dAngRelease < -180) dAngRelease += 360;
    const dtRelease = Math.max(0.001, (now - lastTs) / 1000);
    const releaseVelDegPerSec = dAngRelease / dtRelease;
    // update last-known velocity for logging/threshold
    lastVelDegPerSec = releaseVelDegPerSec;
    // if deck was playing before scratch, resume normal BufferSource playback at the new position
    const finalPos = (typeof lastScratchPos === 'number') ? lastScratchPos : deck.getPosition();
    const FLING_MIN_RATE = FlingCfg.minRate; // ~0.18x (~65 deg/sec) by default
    const FLING_MIN_DEG_PER_SEC = FlingCfg.minDegPerSec; // backup threshold if smoothedRate is zero
    const FLING_RATE_SCALE = 1/360;   // deg/sec to rate multiplier
  const sens = ScratchCfg.sensitivity || 1.0;
  const derivedRate = (releaseVelDegPerSec * FLING_RATE_SCALE) * sens;
    // Also consider the last non-zero rate seen within a short window before release
    const sinceLastNZ = performance.now() - (lastNonZeroTime || now);
    const decay = Math.exp(-sinceLastNZ / 120); // ~120ms memory
    const candidate1 = (Math.abs(lastSmoothedRate) > 0.001) ? lastSmoothedRate : 0;
    const candidate2 = derivedRate;
    const candidate3 = (lastNonZeroRate && sinceLastNZ < 400) ? (lastNonZeroRate * decay) : 0;
    let flingRate = candidate1;
    if(Math.abs(candidate2) > Math.abs(flingRate)) flingRate = candidate2;
    if(Math.abs(candidate3) > Math.abs(flingRate)) flingRate = candidate3;
    const doFling = Math.abs(flingRate) >= FLING_MIN_RATE || Math.abs(releaseVelDegPerSec) >= FLING_MIN_DEG_PER_SEC;
    console.debug('[DeckUI] release', id, {
      lastSmoothedRate: +lastSmoothedRate.toFixed?.(3) ?? lastSmoothedRate,
      lastNonZeroRate: +lastNonZeroRate.toFixed?.(3) ?? lastNonZeroRate,
      sinceLastNZ: Math.round(sinceLastNZ),
      releaseVelDegPerSec: Math.round(releaseVelDegPerSec),
      derivedRate: +derivedRate.toFixed?.(3) ?? derivedRate,
      flingRate: +flingRate.toFixed?.(3) ?? flingRate,
      doFling
    });
    // End hold; if we will fling, don't send a zero-rate first—start fling immediately
    try{ deck.scratchSetHold(false); }catch(_e){}
    if(platterWrap._wasPlayingBeforeScratch){
      // resume at the last position reported by scratch
      if(doFling){
        const boosted = flingRate * (FlingCfg.speedMult || 1.0);
        console.debug('[DeckUI] fling start (playing before)', id, 'rate=', flingRate.toFixed(3), 'boosted=', boosted.toFixed(3));
  // Pass accel duration for audio resume ramp so it matches the platter accel feel
  deck.scratchFling(boosted, FlingCfg.tau, true, (window.VibesFlingAccel && window.VibesFlingAccel.duration) || 0.5, finalPos);
        startFlingVisual(boosted, FlingCfg.tau);
      } else {
        try{ deck.scratchSetRate(0); }catch(_e){}
        deck.resumeAtPosition(finalPos);
      }
    }
    else {
      // if we weren't playing before scratch, explicitly stop scratch output
      if(doFling){
        const boosted = flingRate * (FlingCfg.speedMult || 1.0);
        console.debug('[DeckUI] fling start (stopped before)', id, 'rate=', flingRate.toFixed(3), 'boosted=', boosted.toFixed(3));
  deck.scratchFling(boosted, FlingCfg.tau, false, 0, finalPos);
        startFlingVisual(boosted, FlingCfg.tau);
      } else {
        try{ deck.scratchSetRate(0); }catch(_e){}
        deck.scratchStop();
      }
    }
    // restore platter spin driven by slider/deck state
    updatePlatterFromDeck();
    platterWrap._wasPlayingBeforeScratch = false;
    lastScratchPos = null;
    inHold = false;
  };
  platterWrap.addEventListener('pointerdown', onPointerDown);
  platterWrap.addEventListener('pointermove', onPointerMove);
  // also track pointer movement globally so drags continue when pointer leaves the platter element
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  // track whether the user manually changed the BPM slider
  let bpmUserChanged = false;

  // drag & drop
  dd.addEventListener('dragover',e=>{ e.preventDefault(); dd.style.borderColor='var(--accent)'; });
  dd.addEventListener('dragleave',e=>{ dd.style.borderColor=''; });
  dd.addEventListener('drop',async e=>{
    e.preventDefault(); dd.style.borderColor='';
    const f = e.dataTransfer.files[0]; if(!f) return;
  await deck.loadFile(f);
  analyzeAndCache(f, deck);
    drawWaveform(canvas, deck);
  });

  // file picker: only open when clicking the drag-drop area (not entire container)
  dd.addEventListener('click', async (e)=>{
    e.stopPropagation();
    const inp = document.createElement('input'); inp.type='file'; inp.accept='audio/*'; inp.click();
    inp.onchange=async ()=>{ if(inp.files.length){ await deck.loadFile(inp.files[0]); analyzeAndCache(inp.files[0],deck); drawWaveform(canvas,deck); } }
  });

  playBtn.addEventListener('click',(e)=>{ e.stopPropagation(); if(deck.playing) deck.pause(); else deck.play(); updatePlayUI(); flashPlayDisabled(); });
  // visual feedback for rapid play/pause clicks
  function flashPlayDisabled(){ playBtn.disabled = true; setTimeout(()=>playBtn.disabled=false,100); }
  // Cue button behavior:
  // - click (tap) when stopped: move playhead to stored main cue
  // - click when playing: set main cue to current position
  // - hold (mousedown/touchstart): play from cue until release
  // suppress click if it immediately follows a hold interaction
  let _suppressNextCueClick = false;
  function markSuppress(){ _suppressNextCueClick = true; setTimeout(()=>{ _suppressNextCueClick=false; }, 400); }

  // UI-level hold detection for mouse (tap vs hold)
  let _cueHoldTimer = null;
  let _held = false;
  const HOLD_MS = 180;
  let _pressPos = 0;

  cueBtn.addEventListener('mousedown',(e)=>{
    e.stopPropagation(); console.debug('[DeckUI] cue mousedown',id);
    _held = false;
    // capture press position (used for both tap and hold)
    _pressPos = deck.getPosition();
    _cueHoldTimer = setTimeout(()=>{
      _held = true;
      // when hold threshold reached, suppress the following click
      markSuppress();
      // set temp cue to the position captured at press and start playback
      deck.setTempCue(_pressPos);
      deck.startTempPlay();
      updatePlayUI();
    }, HOLD_MS);
  });

  cueBtn.addEventListener('mouseup',(e)=>{
    e.stopPropagation(); console.debug('[DeckUI] cue mouseup',id);
    if(_cueHoldTimer){ clearTimeout(_cueHoldTimer); _cueHoldTimer = null; }
    if(_held){ // was a hold -> stop temp playback and return to cue
      deck.stopTempPlay();
    }else{ // was a tap: set main cue at release position
      const relPos = deck.getPosition();
      deck.setMainCue(relPos);
      // do not pause or seek; just set the cue
      console.debug('[DeckUI] tap set mainCue', id, relPos);
    }
    _held = false;
    updatePlayUI();
  });

  // touch equivalents
  cueBtn.addEventListener('touchstart',(e)=>{ e.stopPropagation(); console.debug('[DeckUI] cue touchstart',id); _held=false; _pressPos = deck.getPosition(); _cueHoldTimer = setTimeout(()=>{ _held=true; markSuppress(); deck.setTempCue(_pressPos); deck.startTempPlay(); updatePlayUI(); }, HOLD_MS); },{passive:true});
  cueBtn.addEventListener('touchend',(e)=>{ e.stopPropagation(); console.debug('[DeckUI] cue touchend',id); if(_cueHoldTimer){ clearTimeout(_cueHoldTimer); _cueHoldTimer=null; } if(_held){ deck.stopTempPlay(); } else { const relPos=deck.getPosition(); deck.setMainCue(relPos); console.debug('[DeckUI] tap set mainCue (touch)', id, relPos); } _held=false; updatePlayUI(); });

  // cancel hold timer if pointer leaves the button (prevents stray timers)
  cueBtn.addEventListener('mouseleave', ()=>{ if(_cueHoldTimer){ clearTimeout(_cueHoldTimer); _cueHoldTimer=null; _held=false; } });
  syncBtn.addEventListener('click',(e)=>{ e.stopPropagation(); // sync placeholder (actual sync engine not yet implemented)
    console.log('Sync pressed on deck', id); });
  function updatePlayUI(){ playBtn.textContent = deck.playing? 'Pause':'Play'; }

  hotcueWrap.addEventListener('click',e=>{
    const n = e.target.dataset.c; if(!n) return;
    if(e.shiftKey){ // set
      const pos = deck.pausedAt; deck.setHotCue(n,pos);
    }else{ deck.jumpHotCue(n); }
  });

  // make hotcue buttons stop propagation when clicked directly
  hotcueWrap.querySelectorAll('.hotcue').forEach(h=>{
    h.addEventListener('click', (ev)=>{ ev.stopPropagation(); });
  });

  deck.onUpdate = (msg)=>{
    if(msg.type==='loaded'){
      drawWaveform(canvas,deck);
    }
    updatePlayUI();
  }

  // sync platter spinning and label to deck state
  const updatePlatterFromDeck = ()=>{
    // if fling or accel visual animation is active, don't override; otherwise reflect deck playing state
    if(!flingRAF && !accelRAF){
      platterComp.setSpinning(!!deck.playing);
    }
    // label from track name if available
    if(deck && deck.file && deck.file.name) platterComp.setLabel(deck.file.name);
    // During normal playback (BufferSource), drive RPM from deck.playbackRate
    // Base: 33.333 rpm scaled by current deck rate
    const baseRpm = 33.333 * (deck.playbackRate || 1.0);
    platterComp.setRpm(baseRpm);
  }
  // call once to initialize label/spin
  updatePlatterFromDeck();
  // hook into deck.onUpdate to refresh when analysis or play state changes
  const oldOnUpdate = deck.onUpdate;
  deck.onUpdate = (msg)=>{ if(typeof oldOnUpdate==='function') oldOnUpdate(msg); if(msg.type==='loaded' || msg.type==='analysis' || msg.type==='play' || msg.type==='pause') updatePlatterFromDeck(); }

  // keep the waveform animating while playing
  const ensureWaveTicker = ()=>{ if(deck.playing) startWaveTicker(canvas, deck); else canvas._wfTicking = false; };
  const prev2 = deck.onUpdate;
  deck.onUpdate = (msg)=>{ if(typeof prev2==='function') prev2(msg); if(msg.type==='play' || msg.type==='pause' || msg.type==='seek') ensureWaveTicker(); };
  // initial draw and ticker state
  drawWaveform(canvas, deck); ensureWaveTicker();

  // click-to-seek on waveform with short guard after scratching
  wave.style.cursor = 'pointer';
  let lastScratchEnd = 0;
  const guardMs = 200; // block seeks within 200ms after scratch ends
  const origOnUpdate2 = deck.onUpdate;
  deck.onUpdate = (msg)=>{
    if(typeof origOnUpdate2==='function') origOnUpdate2(msg);
    if(msg.type==='flingEnd'){ lastScratchEnd = performance.now(); }
  };
  wave.addEventListener('click', (ev)=>{
    if(!deck.buffer) return;
    if(performance.now() - lastScratchEnd < guardMs) return; // guard after scratch
    const rect = wave.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
    const frac = rect.width>0 ? (x / rect.width) : 0;
    const target = frac * (deck.buffer.duration||0);
    deck.seek(target);
  });
  // keep the waveform crisp on resize and when analysis loads
  const redraw = ()=>{ try{ drawWaveform(canvas, deck); }catch(e){} };
  window.addEventListener('resize', redraw);
  const prevOnUpdate = deck.onUpdate;
  deck.onUpdate = (msg)=>{ if(typeof prevOnUpdate==='function') prevOnUpdate(msg); if(msg.type==='loaded' || msg.type==='analysis') redraw(); };

  // update BPM UI when analysis completes
  function refreshBpmUI(){
    const detected = deck.analysis && deck.analysis.bpm ? deck.analysis.bpm : null;
    bpmDetected.textContent = detected? String(Math.round(detected)) : '—';
    // compute slider center (midpoint of min/max)
    const minVal = parseInt(bpmSlider.min,10) || 60;
    const maxVal = parseInt(bpmSlider.max,10) || 180;
    const center = (minVal + maxVal) / 2;
    // Default behavior: if user hasn't touched slider, keep it visually centered.
    if(!bpmUserChanged){
      bpmSlider.value = String(center);
    }
    // Effective target BPM = detected * (slider/center) when detection exists, otherwise show slider value
    const sliderVal = parseFloat(bpmSlider.value);
    const effectiveTarget = detected ? Math.round(detected * (sliderVal / center)) : Math.round(sliderVal);
    bpmTargetVal.textContent = String(effectiveTarget);
    // Apply playback rate:
    // - If we have a detected BPM and the user hasn't changed slider -> keep native speed (1.0)
    // - Otherwise, the slider modifies speed relative to center: multiplier = sliderVal / center
    if(detected){
      if(!bpmUserChanged){
        deck.setPlaybackRate(1.0);
      }else{
        const multiplier = sliderVal / center;
        deck.setPlaybackRate(multiplier);
      }
    }else{
      if(bpmUserChanged){
        const multiplier = sliderVal / center;
        deck.setPlaybackRate(multiplier);
      }
    }
  }

  // react to slider changes per-deck
  bpmSlider.addEventListener('input', ()=>{ bpmUserChanged = true; refreshBpmUI(); updatePlatterFromDeck(); });

  // when analysis is set from analyzeAndCache it will populate deck.analysis; hook into that by wrapping deck.onUpdate setter is already used — call refresh periodically when loaded
  const origOnUpdate = deck.onUpdate;
  deck.onUpdate = (msg)=>{
    if(typeof origOnUpdate==='function') origOnUpdate(msg);
    if(msg.type==='loaded' || msg.type==='analysis'){ refreshBpmUI(); }
    if(msg.type==='flingStart'){
      // reset overlap flag for this fling cycle
      onUpdate._overlapAccelStarted = false;
      startFlingVisual(msg.rate || 0, msg.tau || FlingCfg.tau);
    }
    if(msg.type==='flingOverlapStart'){
      // Begin platter acceleration at the same time audio overlap starts, so visuals match
      stopFlingVisual();
      const accelCfg = (window.VibesFlingAccel || { duration: 0.5 });
      const targetRpm = 33.333 * (deck.playbackRate || 1);
      if(msg.direction === 'forward'){
        // For forward flings, we don't want a visible accelerate-from-zero; just ensure platter is spinning
        platterComp.setSpinning(true);
        platterComp.setRpm(targetRpm);
      }else{
        startPlatterAccelRamp(targetRpm, accelCfg.duration || 0.5);
      }
      onUpdate._overlapAccelStarted = true;
    }
    if(msg.type==='flingEnd'){
      stopFlingVisual();
  // If we already started an overlap acceleration, do not trigger a second ramp on flingEnd
  if(onUpdate._overlapAccelStarted){ onUpdate._overlapAccelStarted = false; return; }
      // Otherwise, start a short acceleration of platter towards normal rpm
      const accelCfg = (window.VibesFlingAccel || { duration: 0.5, startRate: 0.6 });
      const targetRpm = 33.333 * (deck.playbackRate || 1);
      startPlatterAccelRamp(targetRpm, accelCfg.duration || 0.5);
    }
    if(msg.type==='play' || msg.type==='pause'){
      // ensure visual reflects play state; if fling still active, tick will continue until it stops
      updatePlatterFromDeck();
    }
  }

  return deck;
}

// small inline analyzer call (post to worker)
async function analyzeAndCache(file, deck){
  const id = `${file.name}:${file.size}:${file.lastModified}`;
  const existing = await getAnalysis(id);
  if(existing){ console.log('using cached analysis',id); if(deck) deck.analysis = existing; return existing; }
  const arrayBuffer = await file.arrayBuffer();
  // append a small cache-bust so the worker script update is picked up even if a service worker cached an older file
  const workerUrl = '/src/analysis/AnalyzerWorker.js?v=' + Date.now();
  // Attempt to fetch the worker script with cache:'no-store' and create a Blob worker. This helps bypass some caching layers
  // (including aggressive server caches). If fetch or blob creation fails, fall back to direct Worker.
  let w = null;
  try{
    const resp = await fetch(workerUrl, {cache: 'no-store'});
    if(resp && resp.ok){
      let code = await resp.text();
      // try to fetch peaks helper and inline it into the worker blob so importScripts isn't required
      try{
        const peaksResp = await fetch('/src/analysis/peaks.js', {cache:'no-store'});
        if(peaksResp && peaksResp.ok){
          const peaksCode = await peaksResp.text();
          // remove any importScripts line referring to peaks.js in the worker code
          code = code.replace(/importScripts\((?:'|")\/src\/analysis\/peaks\.js(?:'|")\);?/g, '');
          // prepend peaks helper so worker has makePeaks available
          code = peaksCode + '\n' + code;
        }
      }catch(pe){
        console.debug('[AnalyzerWorker] failed to inline peaks.js, worker will attempt importScripts at runtime', pe && pe.message);
      }
      const blob = new Blob([code], {type:'application/javascript'});
      const blobUrl = URL.createObjectURL(blob);
      w = new Worker(blobUrl);
    }else{
      console.debug('[AnalyzerWorker] fetch returned not-ok, falling back to direct Worker', resp && resp.status);
      w = new Worker(workerUrl);
    }
  }catch(err){
    console.warn('[AnalyzerWorker] fetch/create blob worker failed, falling back to direct Worker', err && err.message);
    try{ w = new Worker(workerUrl); }catch(e){ console.error('[AnalyzerWorker] failed to create worker', e); return null; }
  }
    // attach robust error handlers so we can see worker runtime failures
    w.onerror = (ev)=>{ console.error('[AnalyzerWorker onerror]', ev && ev.message, ev); };
    w.onmessageerror = (ev)=>{ console.error('[AnalyzerWorker onmessageerror]', ev); };
  // do NOT transfer the arrayBuffer so we can reuse it on fallback (some workers lack OfflineAudioContext)
  w.postMessage({cmd:'analyze',fileMeta:{name:file.name,size:file.size,lastModified:file.lastModified},arrayBuffer});
  return new Promise((res)=>{
      // timeout in case the worker never responds (e.g. it crashed)
      const workerTimeout = setTimeout(()=>{
        console.warn('[AnalyzerWorker] timeout waiting for result for', file.name);
        try{ w.terminate(); }catch(e){}
        return res(null);
      }, 12000);
    w.onmessage = async (e)=>{
      const data = e.data;
      if(!data){ w.terminate(); return res(null); }
      // handle debug messages from worker
      if(data.cmd==='debug'){
        console.debug('[AnalyzerWorker debug]', data.fileMeta && data.fileMeta.name, data.message || '', data);
        return; // keep worker alive for real result or error
      }
      if(data.cmd==='result'){
        const payload = {peaks:data.peaks,bpm:data.bpm, debug:data.debug};
        console.debug('[AnalyzerWorker result]', file.name, 'bpm=', data.bpm, 'debug=', data.debug);
        await putAnalysis(id,payload);
        await putTrackMeta(id,{name:file.name,duration:deck&&deck.buffer?deck.buffer.duration:undefined});
        if(deck) deck.analysis = payload;
        if(deck && typeof deck.onUpdate === 'function') deck.onUpdate({type:'analysis',deck:deck.id});
        clearTimeout(workerTimeout);
        w.terminate();
        return res(payload);
      }
      if(data.cmd==='error'){
        console.warn('[AnalyzerWorker] analysis skipped for', file.name, data.message);
        // if the worker couldn't analyze because OfflineAudioContext isn't available in worker,
        // decode in the main thread using the page AudioContext and send raw PCM to the worker.
  if(data.message && data.message.indexOf('OfflineAudioContext')!==-1 && deck && deck.ctx){
          console.debug('[AnalyzerWorker fallback] OfflineAudioContext unavailable in worker; attempting main-thread decode...', file.name);
          // try to resume AudioContext first (may require user gesture)
          try{ if(typeof deck.ctx.resume === 'function') await deck.ctx.resume(); }catch(e){ console.debug('[AnalyzerWorker fallback] resume() failed or was blocked:', e && e.message); }
          try{
            // decode using deck's AudioContext (this returns an AudioBuffer in main thread)
            let mainAudioBuffer = null;
            try{ mainAudioBuffer = await deck.ctx.decodeAudioData(arrayBuffer.slice(0)); }
            catch(e){
              // fallback to callback-style decodeAudioData for older implementations
              mainAudioBuffer = await new Promise((resolve,reject)=> deck.ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject));
            }
            const channelData = mainAudioBuffer.getChannelData(0);
            // copy into a transferable typed array
            const pcm = new Float32Array(channelData.length);
            pcm.set(channelData);
            // post PCM to worker for analysis and continue waiting for result
            w.postMessage({cmd:'analyzePCM', fileMeta:{name:file.name,size:file.size,lastModified:file.lastModified}, pcm, sampleRate: mainAudioBuffer.sampleRate}, [pcm.buffer]);
            console.debug('[AnalyzerWorker fallback] posted PCM to worker for', file.name, 'len=', channelData.length, 'sr=', mainAudioBuffer.sampleRate);
            // don't terminate; wait for the worker to post a result
            return;
          }catch(err){
            console.warn('[AnalyzerWorker fallback decode failed]', err && err.message, err);
            w.terminate();
            return res(null);
          }
        }
        w.terminate();
        return res(null);
      }
      // unknown message
      w.terminate();
      return res(null);
    }
  });
}

// Waveform rendering with caches + playhead/overlay and phrase markers
function drawWaveform(canvas, deck){
  if(!deck.buffer) return;
  const c = canvas; const dpr = window.devicePixelRatio||1;
  const w = c.clientWidth; const h = c.clientHeight;
  c.width = Math.max(1, w * dpr); c.height = Math.max(1, h * dpr);
  const ctx = c.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);

  // per-deck color scheme
  function hexToRgb(hex){ const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); return m?{r:parseInt(m[1],16),g:parseInt(m[2],16),b:parseInt(m[3],16)}:{r:255,g:255,b:255}; }
  function rgbToHex(r,g,b){ const to=(x)=>x.toString(16).padStart(2,'0'); return '#'+to(r)+to(g)+to(b); }
  function mix(hex1, hex2, t){ const a=hexToRgb(hex1), b=hexToRgb(hex2); const r=Math.round(a.r+(b.r-a.r)*t), g=Math.round(a.g+(b.g-a.g)*t), bl=Math.round(a.b+(b.b-a.b)*t); return rgbToHex(r,g,bl); }
  function hexToRgba(hex, a){ const c = hexToRgb(hex); return `rgba(${c.r},${c.g},${c.b},${a})`; }
  function rgbToHsl(r,g,b){ r/=255; g/=255; b/=255; const max=Math.max(r,g,b), min=Math.min(r,g,b); let h,s,l=(max+min)/2; if(max===min){ h=s=0; } else { const d=max-min; s = l>0.5 ? d/(2-max-min) : d/(max+min); switch(max){ case r: h=(g-b)/d+(g<b?6:0); break; case g: h=(b-r)/d+2; break; case b: h=(r-g)/d+4; break;} h/=6; } return {h,s,l}; }
  function hslToRgb(h,s,l){ let r,g,b; if(s===0){ r=g=b=l; } else { const hue2rgb=(p,q,t)=>{ if(t<0) t+=1; if(t>1) t-=1; if(t<1/6) return p+(q-p)*6*t; if(t<1/2) return q; if(t<2/3) return p+(q-p)*(2/3 - t)*6; return p; }; const q = l < 0.5 ? l*(1+s) : l + s - l*s; const p = 2*l - q; r = hue2rgb(p,q,h+1/3); g = hue2rgb(p,q,h); b = hue2rgb(p,q,h-1/3);} return {r:Math.round(r*255), g:Math.round(g*255), b:Math.round(b*255)}; }
  function hexToHsl(hex){ const c=hexToRgb(hex); return rgbToHsl(c.r,c.g,c.b); }
  function hslToHex(h,s,l){ const c=hslToRgb(h,s,l); return rgbToHex(c.r,c.g,c.b); }
  const neonGreen = '#39ff14';
  const neonPurple = '#c400ff';
  const isLeft = deck && deck.id === 'A';
  const base = isLeft ? neonGreen : neonPurple;
  // Normalize perceived brightness using HSL lightness targets (same for both decks)
  const targetS = 0.95;           // vivid saturation
  const L_BRIGHT = 0.72;          // bright layer lightness
  const L_DIM = 0.46;             // dim layer lightness
  const L_HI = 0.84;              // center highlight lightness
  const hb = hexToHsl(base);
  const brightColor = hslToHex(hb.h, Math.max(targetS, hb.s), L_BRIGHT);
  const dimColor = hslToHex(hb.h, Math.max(targetS*0.9, hb.s*0.9), L_DIM);
  const highlightColor = hslToHex(hb.h, Math.max(targetS, hb.s), L_HI);

  // Prepare or rebuild offscreen caches when size or buffer changes
  const key = `${w}x${h}|${deck.buffer.length}|${deck.analysis && deck.analysis.peaks ? deck.analysis.peaks.length : 0}|${deck && deck.id}|${brightColor}|${dimColor}`;
  if(!c._wfCache || c._wfCache.key !== key){
    const makeOff = ()=>{ const off = document.createElement('canvas'); off.width=w*dpr; off.height=h*dpr; const octx=off.getContext('2d'); octx.setTransform(dpr,0,0,dpr,0,0); return {canvas:off,ctx:octx}; };
    const dim = makeOff(); const bright = makeOff(); const phrase = makeOff();
    // draw bars into both dim and bright using different colors
    const centerY = h/2;
    const peaks = deck.analysis && Array.isArray(deck.analysis.peaks) && deck.analysis.peaks.length ? deck.analysis.peaks : null;
    const buf = deck.buffer.getChannelData(0);
    const drawBars = (octx, color, highlight)=>{
      octx.fillStyle = '#000'; octx.fillRect(0,0,w,h);
      octx.fillStyle = color;
      if(peaks){
        for(let x=0; x<w; x++){
          const p = peaks[Math.floor(x * (peaks.length / w))] || 0;
          const bar = Math.max(1, p * h);
          const y = centerY - bar/2;
          octx.fillRect(x, y, 1, bar);
        }
      }else{
        const step = Math.max(1, Math.floor(buf.length / w));
        for(let x=0, i=0; x<w; x++, i+=step){
          let max=0; for(let j=0;j<step && (i+j)<buf.length;j++){ const v=Math.abs(buf[i+j]); if(v>max) max=v; }
          const bar = Math.max(1, max * h);
          const y = centerY - bar/2;
          octx.fillRect(x, y, 1, bar);
        }
      }
      // subtle center highlight
      octx.fillStyle = highlight || mix(color, '#ffffff', 0.45);
      octx.fillRect(0, Math.floor(centerY)-1, w, 2);
    };
    drawBars(dim.ctx, dimColor, mix(dimColor, '#ffffff', 0.28)); // dim/unplayed
    drawBars(bright.ctx, brightColor, highlightColor); // bright/played
    // Subtle glow for both decks, baked into bright cache to avoid runtime blending artifacts
    bright.ctx.save();
    bright.ctx.globalCompositeOperation = 'source-over';
    bright.ctx.shadowColor = hexToRgba(brightColor, 0.55);
    bright.ctx.shadowBlur = Math.min(18, h*0.9);
    bright.ctx.fillStyle = hexToRgba(brightColor, 0.6);
    // draw a thin center rect to generate glow via shadow
    const gh = Math.max(2, Math.round(h*0.22));
    bright.ctx.fillRect(0, Math.floor((h-gh)/2), w, gh);
    bright.ctx.restore();

    // phrase markers: draw only last two beats of each 4-beat bar if BPM known
    phrase.ctx.clearRect(0,0,w,h);
    const bpm = deck.analysis && deck.analysis.bpm;
    if(bpm && isFinite(bpm) && bpm>0){
      const beatSec = 60 / bpm; const duration = deck.buffer.duration || 0; const pxPerSec = w / Math.max(0.0001, duration);
      for(let i=0, t=0; t<=duration; i++, t+=beatSec){
        const beatInBar = i % 4;
        if(beatInBar===2 || beatInBar===3){
          const x = Math.floor(t * pxPerSec) + 0.5;
          phrase.ctx.fillStyle = (beatInBar===2) ? 'rgba(255,170,0,0.6)' : 'rgba(255,255,255,0.9)';
          phrase.ctx.fillRect(x, 0, 1, h);
        }
      }
    }

    c._wfCache = { key, dim: dim.canvas, bright: bright.canvas, phrase: phrase.canvas };
  }

  // dynamic draw: base dim waveform, then overlay played region in bright, optional phrase markers, then playhead
  ctx.drawImage(c._wfCache.dim, 0, 0, w, h);
  const duration = deck.buffer.duration || 0;
  const pos = Math.max(0, Math.min(duration, deck.getPosition ? deck.getPosition() : 0));
  const playX = duration>0 ? (pos / duration) * w : 0;
  // overlay played region using bright cache clipped to [0, playX]
  if(playX > 0){
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, playX, h); ctx.clip();
    // Normal compositing to avoid washout/white clipping
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(c._wfCache.bright, 0, 0, w, h);
    ctx.restore();
  }
  // phrase markers on top (configurable)
  const wfCfg = (window.VibesWaveform = window.VibesWaveform || { showBeatGrid:false, showPhrasing:false });
  if(wfCfg.showPhrasing && c._wfCache.phrase) ctx.drawImage(c._wfCache.phrase, 0, 0, w, h);
  // playhead line
  ctx.fillStyle = '#000'; ctx.fillRect(Math.floor(playX)-1, 0, 3, h);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.floor(playX), 0, 1, h);
}

// start an animation loop to update the overlay and playhead
function startWaveTicker(canvas, deck){
  if(canvas._wfTicking) return; canvas._wfTicking = true;
  const tick = ()=>{ try{ drawWaveform(canvas, deck); }catch(_){} if(canvas._wfTicking) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
