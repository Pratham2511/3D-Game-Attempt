// Keyboard, mouse and Pointer Lock. Exposes a polled state plus edge-triggered "pressed" flags
// that game code consumes once per frame. The QA harness drives the same state programmatically.
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.moveX = 0; // +1 right (D), -1 left (A)
    this.moveZ = 0; // +1 forward (W), -1 back (S)
    this.walk = false;
    this.block = false;
    this.attackPressed = false;
    this.attackHeld = false;
    this.attackHoldTime = 0;
    this.heavyPressed = false;
    this.kickPressed = false;
    this.dodgePressed = false;
    this.lockPressed = false;
    this.pausePressed = false;
    this.debugPressed = false;
    this.lookDX = 0;
    this.lookDY = 0;
    this.wheel = 0;
    this.locked = false;
    this.enabled = false;
    this.virtual = false; // QA harness sets the state directly
    this.onPause = null;
    this.onLockChange = null;
    this.lastInputTime = 0;

    this._onKeyDown = (e) => this.keyDown(e);
    this._onKeyUp = (e) => this.keyUp(e);
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.lookDX += e.movementX;
      this.lookDY += e.movementY;
    };
    this._onMouseDown = (e) => {
      if (!this.enabled) return;
      if (!this.locked && !this.virtual) { this.requestLock(); return; }
      if (e.button === 0) { this.attackPressed = true; this.attackHeld = true; this.attackHoldTime = 0; this.lastInputTime = performance.now(); }
      if (e.button === 1) { this.heavyPressed = true; e.preventDefault(); this.lastInputTime = performance.now(); }
      if (e.button === 2) this.block = true;
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) this.attackHeld = false;
      if (e.button === 2) this.block = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    };
    this._onWheel = (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); };
    this._onContext = (e) => e.preventDefault();
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.clearHeld();
      if (this.onLockChange) this.onLockChange(this.locked);
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel, { passive: true });
    window.addEventListener('contextmenu', this._onContext);
    document.addEventListener('pointerlockchange', this._onLockChange);
    window.addEventListener('blur', () => this.clearHeld());
  }

  keyDown(e) {
    if (e.code === 'F3') { e.preventDefault(); this.debugPressed = true; return; }
    if (e.code === 'Escape') { this.pausePressed = true; return; }
    if (!this.enabled) return;
    if (e.repeat) { if (e.code === 'Tab') e.preventDefault(); return; }
    this.keys.add(e.code);
    this.lastInputTime = performance.now();
    switch (e.code) {
      case 'KeyF': this.kickPressed = true; break;
      case 'KeyE': this.heavyPressed = true; break;
      case 'Space': this.dodgePressed = true; e.preventDefault(); break;
      case 'Tab': this.lockPressed = true; e.preventDefault(); break;
      case 'ShiftLeft': case 'ShiftRight': this.block = true; break;
      case 'ControlLeft': case 'ControlRight': this.walk = true; e.preventDefault(); break;
      default: break;
    }
    this.updateAxes();
  }

  keyUp(e) {
    this.keys.delete(e.code);
    switch (e.code) {
      case 'ShiftLeft': case 'ShiftRight': this.block = false; break;
      case 'ControlLeft': case 'ControlRight': this.walk = false; break;
      default: break;
    }
    this.updateAxes();
  }

  updateAxes() {
    if (this.virtual) return;
    const k = this.keys;
    this.moveX = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    this.moveZ = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
  }

  clearHeld() {
    this.keys.clear();
    if (!this.virtual) { this.moveX = 0; this.moveZ = 0; this.block = false; this.walk = false; }
    this.attackHeld = false;
  }

  requestLock() {
    if (this.virtual) return;
    const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // Called once per frame after game code consumed the edge flags.
  endFrame(dt) {
    if (this.attackHeld) this.attackHoldTime += dt;
    this.attackPressed = false;
    this.heavyPressed = false;
    this.kickPressed = false;
    this.dodgePressed = false;
    this.lockPressed = false;
    this.pausePressed = false;
    this.debugPressed = false;
    this.lookDX = 0;
    this.lookDY = 0;
    this.wheel = 0;
  }
}
