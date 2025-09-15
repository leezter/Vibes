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

  // place the waveform where the smaller jog/platter used to be (left of controls)
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
  const getAngle = (clientX, clientY)=>{
    const r = platterWrap.getBoundingClientRect();
    const cx = r.left + r.width/2; const cy = r.top + r.height/2;
    const dx = clientX - cx; const dy = clientY - cy;
    const ang = Math.atan2(dy, dx) * 180 / Math.PI; // degrees
    return ang;
  };

  const onPointerDown = (e)=>{
    e.preventDefault(); platterWrap.setPointerCapture && platterWrap.setPointerCapture(e.pointerId);
    isScratching = true; lastTs = performance.now(); lastAngle = getAngle(e.clientX, e.clientY);
    // if deck is playing, pause the regular BufferSource so only the scratch node produces audio
    const wasPlaying = !!deck.playing;
    if(wasPlaying){
      deck.pause();
    }
    // stop automatic platter spinning so pointer controls visual
    platterComp.setSpinning(false);
    // initialize scratch node and notify Deck to start scratch from current position
  const pos = deck.getPosition();
  lastScratchPos = pos;
  deck.scratchStart(pos, 0.0);
    // store flag to resume when pointer up
    platterWrap._wasPlayingBeforeScratch = wasPlaying;
  };
  const onPointerMove = (e)=>{
    if(!isScratching) return;
    const now = performance.now(); const ang = getAngle(e.clientX, e.clientY);
    const dt = Math.max(1, now - lastTs) / 1000; // s
    // compute delta angle in degrees, normalize to -180..180
    let dAng = ang - lastAngle; while(dAng > 180) dAng -= 360; while(dAng < -180) dAng += 360;
    // angular velocity (deg/sec)
    const vel = dAng / dt;
    // map angular velocity to playbackRate multiplier relative to native speed
    // small tuning: 360 deg/sec -> 2x speed, -360 deg/sec -> -2x (reverse)
    const rate = Math.max(-4, Math.min(4, vel / 360 * 2));
    // update deck scratch playback rate and position
  // base position is the last scratch-updated position (or paused head)
  const basePos = (typeof lastScratchPos === 'number') ? lastScratchPos : deck.getPosition();
  deck.scratchSetRate(rate);
  // advance/set internal position by a small amount proportional to rotation
  // convert dAng to seconds: assume 360deg corresponds to 1 second of audio movement at 1x for a coarse mapping
  const dtSeconds = (dAng / 360) * 1;
  const newPos = Math.max(0, Math.min((deck.buffer?deck.buffer.duration:0), basePos + dtSeconds));
  lastScratchPos = newPos;
  deck.scratchSetPosition(newPos);
    // update platter visual angle immediately for instant feedback
    try{ platterComp.platter.style.transform = `rotate(${ang}deg)`; }catch(e){}
    lastAngle = ang; lastTs = now;
  };
  const onPointerUp = (e)=>{
    if(!isScratching) return; isScratching=false; try{ platterWrap.releasePointerCapture && platterWrap.releasePointerCapture(e.pointerId); }catch(e){}
    // stop scratch audio
    deck.scratchStop();
    // if deck was playing before scratch, resume normal BufferSource playback at the new position
    const finalPos = (typeof lastScratchPos === 'number') ? lastScratchPos : deck.getPosition();
    if(platterWrap._wasPlayingBeforeScratch){
      // resume at the last position reported by scratch
      deck.resumeAtPosition(finalPos);
    }
    // restore platter spin driven by slider/deck state
    updatePlatterFromDeck();
    platterWrap._wasPlayingBeforeScratch = false;
    lastScratchPos = null;
  };
  platterWrap.addEventListener('pointerdown', onPointerDown);
  platterWrap.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

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
    // spinning when deck is playing
    platterComp.setSpinning(!!deck.playing);
    // label from track name if available
    if(deck && deck.file && deck.file.name) platterComp.setLabel(deck.file.name);
    // RPM driven by slider position: center of the slider is default rpm; moving slider left/right adjusts spin speed
  const sliderVal = parseFloat(bpmSlider.value) || ((parseInt(bpmSlider.min,10) + parseInt(bpmSlider.max,10))/2);
  // apply 50% scaling to reduce perceived spin speed
  platterComp.setRpm(sliderVal * 0.5);
  }
  // call once to initialize label/spin
  updatePlatterFromDeck();
  // hook into deck.onUpdate to refresh when analysis or play state changes
  const oldOnUpdate = deck.onUpdate;
  deck.onUpdate = (msg)=>{ if(typeof oldOnUpdate==='function') oldOnUpdate(msg); if(msg.type==='loaded' || msg.type==='analysis' || msg.type==='play' || msg.type==='pause') updatePlatterFromDeck(); }

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
  bpmSlider.addEventListener('input', ()=>{ bpmUserChanged = true; refreshBpmUI();
    // update platter RPM directly from slider so rotation follows slider immediately
  const sliderVal = parseFloat(bpmSlider.value) || ((parseInt(bpmSlider.min,10) + parseInt(bpmSlider.max,10))/2);
  // apply 50% scaling so slider reflects half-speed rotation
  platterComp.setRpm(sliderVal * 0.5);
  });

  // when analysis is set from analyzeAndCache it will populate deck.analysis; hook into that by wrapping deck.onUpdate setter is already used — call refresh periodically when loaded
  const origOnUpdate = deck.onUpdate;
  deck.onUpdate = (msg)=>{ if(typeof origOnUpdate==='function') origOnUpdate(msg); if(msg.type==='loaded' || msg.type==='analysis'){ refreshBpmUI(); } }

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

// waveform drawing (very simple)
function drawWaveform(canvas,deck){
  if(!deck.buffer) return;
  const c = canvas; const dpr = window.devicePixelRatio||1; c.width=c.clientWidth*dpr; c.height=c.clientHeight*dpr; const ctx=c.getContext('2d'); ctx.scale(dpr,dpr);
  const data = deck.buffer.getChannelData(0);
  const step = Math.floor(data.length / c.width);
  ctx.fillStyle='#081018'; ctx.fillRect(0,0,c.clientWidth,c.clientHeight);
  ctx.strokeStyle='#00d1b2'; ctx.beginPath();
  for(let i=0;i<c.clientWidth;i++){
    const idx = i*step; let max=0; for(let j=0;j<step;j++) max=Math.max(max,Math.abs(data[idx+j]||0));
    const h = max * c.clientHeight;
    ctx.moveTo(i,(c.clientHeight/2)-h/2); ctx.lineTo(i,(c.clientHeight/2)+h/2);
  }
  ctx.stroke();
}
