// src/ui/components/Platter.js
// Lightweight DOM-based Platter component
// Props: size (px), rpm (number), spinning (bool), labelText (string)

export default class Platter {
  constructor(opts = {}) {
    this.size = opts.size || 360;
    this.rpm = typeof opts.rpm === 'number' ? opts.rpm : 33.333;
    this.spinning = !!opts.spinning;
    this.labelText = opts.labelText || '';
    this.imageUrl = opts.imageUrl || null;
    this._angle = 0; // degrees
    this._rafId = null;
    this._lastTs = null;

    this._createDOM();
    this.setSize(this.size);
    this.setLabel(this.labelText);
    this.setRpm(this.rpm);
    this.setSpinning(this.spinning);
  }

  _createDOM(){
    const wrap = document.createElement('div');
    wrap.className = 'platter-wrap';

    const platter = document.createElement('div');
    platter.className = 'platter';
    this.platter = platter;

    const grooves = document.createElement('div');
    grooves.className = 'platter-grooves';
    platter.appendChild(grooves);

    const strobe = document.createElement('div');
    strobe.className = 'platter-strobe';
    platter.appendChild(strobe);

    const label = document.createElement('div');
    label.className = 'platter-label';
    label.textContent = this.labelText;
    this.label = label;
    platter.appendChild(label);

    const spindle = document.createElement('div');
    spindle.className = 'platter-spindle';
    platter.appendChild(spindle);

    const tonearm = document.createElement('div');
    tonearm.className = 'platter-tonearm';

    // add a child container for overlay content (waveform canvas etc.)
    const overlay = document.createElement('div');
    overlay.className = 'platter-overlay';
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.pointerEvents = 'none';
    this.overlay = overlay;
    platter.appendChild(overlay);

    wrap.appendChild(platter);
    wrap.appendChild(tonearm);

    this.el = wrap;
    // if an image URL was provided, attach it
    if(this.imageUrl) this.setImage(this.imageUrl);
  }

  setSize(px){
    this.size = px;
    this.el.style.setProperty('--platter-size', px + 'px');
    // allow internal elements to use percentage sizing
    this.el.style.width = px + 'px';
    this.el.style.height = px + 'px';
  }

  setLabel(text){
    this.labelText = text || '';
    if(this.label) this.label.textContent = this.labelText;
  }

  setRpm(rpm){
    this.rpm = typeof rpm === 'number' ? rpm : this.rpm;
    this._updateRotation();
  }

  setSpinning(flag){
    this.spinning = !!flag;
    this._updateRotation();
  }

  _rotationDurationSeconds(){
    const rpm = this.rpm || 33.333;
    if(!this.spinning || rpm <= 0) return 0;
    return 60 / rpm;
  }

  _updateRotation(){
    // stop any existing CSS animation usage
    this.platter.style.animationDuration = '';
    if(this.spinning && this.rpm > 0){
      this._startRaf();
    }else{
      this._stopRaf();
    }
  }

  _startRaf(){
    if(this._rafId) return;
    this._lastTs = performance.now();
    const tick = (ts)=>{
      const dt = (ts - this._lastTs) / 1000; // seconds
      this._lastTs = ts;
      // rpm -> degrees per second = rpm * 360 / 60 = rpm * 6
      const degPerSec = (this.rpm || 0) * 6;
      this._angle = (this._angle + degPerSec * dt) % 360;
      // apply rotation
      if(this.platter) this.platter.style.transform = `rotate(${this._angle}deg)`;
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopRaf(){
    if(this._rafId){ cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._lastTs = null;
  }

  // attach an element (e.g. waveform canvas) into the overlay
  attachOverlay(node){
    if(!this.overlay) return;
    // allow pointer events on overlay children if they explicitly set it
    node.style.pointerEvents = 'auto';
    this.overlay.appendChild(node);
  }

  // get current platter angle in degrees (0-360)
  getAngle(){ return this._angle || 0; }

  // set platter angle (degrees) and update visual immediately
  setAngle(deg){
    this._angle = ((deg % 360) + 360) % 360;
    if(this.platter) this.platter.style.transform = `rotate(${this._angle}deg)`;
  }

  setImage(url){
    this.imageUrl = url || null;
    if(!this.platter) return;
    // remove existing image if present
    const existing = this.platter.querySelector('.platter-image');
    if(existing) existing.remove();
    if(!this.imageUrl) return;
    const img = document.createElement('img');
    img.className = 'platter-image';
    img.alt = '';
    img.src = this.imageUrl;
    // place image above grooves but below label/spindle
    this.platter.appendChild(img);
  }

  destroy(){ if(this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el); }
}
