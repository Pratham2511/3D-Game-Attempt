// HUD: hero bars, level/enemy/kill counters, FPS, floating enemy health bars, pooled damage
// numbers, lock-on reticle, level cards, controls hints and the F3 debug overlay.
import * as THREE from 'three';

const CONTROLS = [
  ['W A S D', 'Move'], ['Mouse', 'Orbit camera'], ['Left click', 'Attack (click again to combo)'],
  ['E / Middle click', 'Heavy attack'], ['Right click / Shift', 'Block (tap just before a hit to parry)'],
  ['F', 'Kick (breaks guard)'], ['Space', 'Dodge'], ['Tab', 'Lock on / cycle target'],
  ['Left Ctrl', 'Walk'], ['Esc', 'Pause'], ['F3', 'Debug overlay'],
];

const NUM_POOL = 28;
const _v = new THREE.Vector3();

export class HUD {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'), hp: $('hp-fill'), hpLag: $('hp-lag'), st: $('st-fill'), level: $('hud-level'), enemies: $('hud-enemies'),
      kills: $('hud-kills'), fps: $('hud-fps'), bars: $('enemy-bars'), nums: $('damage-numbers'), reticle: $('lock-reticle'),
      card: $('card'), cardTitle: $('card-title'), cardSub: $('card-sub'), debug: $('debug'), lockPrompt: $('lock-prompt'),
    };
    const hint = CONTROLS.map(([k, v]) => `<div><kbd>${k}</kbd><span>${v}</span></div>`).join('');
    for (const id of ['menu-controls', 'pause-controls', 'hud-controls']) { const n = $(id); if (n) n.innerHTML = hint; }
    this.bars = [];
    this.nums = [];
    for (let i = 0; i < NUM_POOL; i++) {
      const d = document.createElement('div');
      d.className = 'dmg';
      d.style.opacity = '0';
      this.el.nums.appendChild(d);
      this.nums.push({ el: d, life: 0, pos: new THREE.Vector3(), cls: '', rise: 0 });
    }
    this.numCursor = 0;
    this.lagHp = 1;
    this.fpsAcc = 0; this.fpsFrames = 0;
    this.lastCounts = '';
    this.cardTimer = 0;
    this.debugOn = false;
    this.w = window.innerWidth; this.h = window.innerHeight;
  }

  buildEnemyBars(n) {
    while (this.bars.length < n) {
      const d = document.createElement('div');
      d.className = 'enemy-bar';
      d.innerHTML = '<div class="fill"></div>';
      d.style.opacity = '0';
      this.el.bars.appendChild(d);
      this.bars.push({ el: d, fill: d.firstChild, shown: false, lastW: -1, targeted: false });
    }
  }

  resize(w, h) { this.w = w; this.h = h; }

  show(on) { this.el.hud.hidden = !on; }

  setCounts(level, remaining, kills) {
    const key = `${level}|${remaining}|${kills}`;
    if (key === this.lastCounts) return;
    this.lastCounts = key;
    this.el.level.textContent = `Level ${level}`;
    this.el.enemies.textContent = `Enemies ${remaining}`;
    this.el.kills.textContent = `Kills ${kills}`;
  }

  card(title, sub, time) {
    this.el.cardTitle.textContent = title;
    this.el.cardSub.textContent = sub || '';
    this.el.card.hidden = false;
    this.el.card.style.animation = 'none';
    void this.el.card.offsetWidth;
    this.el.card.style.animation = '';
    this.cardTimer = time;
  }

  hideCard() { this.el.card.hidden = true; this.cardTimer = 0; }

  number(worldPos, text, cls) {
    const n = this.nums[this.numCursor];
    this.numCursor = (this.numCursor + 1) % NUM_POOL;
    n.pos.copy(worldPos);
    n.pos.x += (Math.random() - 0.5) * 0.3;
    n.life = 0.9;
    n.rise = 0;
    n.el.textContent = text;
    const c = `dmg ${cls || ''}`;
    if (n.cls !== c) { n.el.className = c; n.cls = c; }
  }

  update(dt, camera, hero, enemies) {
    const hpF = Math.max(0, hero.health / hero.maxHealth);
    this.lagHp += (hpF - this.lagHp) * (hpF < this.lagHp ? Math.min(1, dt * 2.2) : 1);
    this.el.hp.style.transform = `scaleX(${hpF.toFixed(4)})`;
    this.el.hpLag.style.transform = `scaleX(${this.lagHp.toFixed(4)})`;
    this.el.st.style.transform = `scaleX(${(hero.stamina / hero.maxStamina).toFixed(4)})`;

    if (this.cardTimer > 0) { this.cardTimer -= dt; if (this.cardTimer <= 0) this.hideCard(); }

    const hw = this.w * 0.5, hh = this.h * 0.5;
    for (let i = 0; i < this.bars.length; i++) {
      const b = this.bars[i];
      const e = enemies[i];
      let show = false;
      if (e && e.active && !e.dead && e.root.visible) {
        _v.copy(e.position); _v.y += e.height + 0.28;
        const d = _v.distanceTo(camera.position);
        _v.project(camera);
        if (_v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1 && d < 26) {
          show = true;
          const x = (_v.x * hw + hw) | 0, y = (-_v.y * hh + hh) | 0;
          const s = THREE.MathUtils.clamp(9 / d, 0.55, 1.2);
          b.el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s.toFixed(3)})`;
          const w = Math.round((e.health / e.maxHealth) * 1000);
          if (w !== b.lastW) { b.fill.style.transform = `scaleX(${(w / 1000).toFixed(3)})`; b.lastW = w; }
          const targeted = hero.lockTarget === e;
          if (targeted !== b.targeted) { b.el.classList.toggle('targeted', targeted); b.targeted = targeted; }
        }
      }
      if (show !== b.shown) { b.el.style.opacity = show ? '1' : '0'; b.shown = show; }
    }

    const lt = hero.lockTarget;
    if (lt && !lt.dead) {
      _v.copy(lt.position); _v.y += lt.height * 0.62;
      _v.project(camera);
      if (_v.z < 1) {
        this.el.reticle.hidden = false;
        this.el.reticle.style.transform = `translate3d(${(_v.x * hw + hw) | 0}px, ${(-_v.y * hh + hh) | 0}px, 0)`;
      } else this.el.reticle.hidden = true;
    } else if (!this.el.reticle.hidden) this.el.reticle.hidden = true;

    for (const n of this.nums) {
      if (n.life <= 0) continue;
      n.life -= dt;
      n.rise += dt * 0.9;
      _v.copy(n.pos); _v.y += n.rise;
      _v.project(camera);
      if (n.life <= 0 || _v.z > 1) { n.el.style.opacity = '0'; n.life = 0; continue; }
      const a = Math.min(1, n.life * 3);
      const pop = 1 + Math.max(0, n.life - 0.75) * 3;
      n.el.style.opacity = a.toFixed(2);
      n.el.style.transform = `translate3d(${(_v.x * hw + hw) | 0}px, ${(-_v.y * hh + hh) | 0}px, 0) translate(-50%, -50%) scale(${pop.toFixed(2)})`;
    }
  }

  fps(dt) {
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.currentFps = this.fpsFrames / this.fpsAcc;
      this.el.fps.textContent = `${Math.round(this.currentFps)} fps`;
      this.fpsAcc = 0; this.fpsFrames = 0;
    }
  }

  clearTransient() {
    for (const n of this.nums) { n.life = 0; n.el.style.opacity = '0'; }
    for (const b of this.bars) { b.shown = false; b.el.style.opacity = '0'; }
    this.el.reticle.hidden = true;
  }

  toggleDebug() {
    this.debugOn = !this.debugOn;
    this.el.debug.hidden = !this.debugOn;
  }

  setDebug(text) { if (this.debugOn) this.el.debug.textContent = text; }

  lockPrompt(on) { this.el.lockPrompt.hidden = !on; }
}
