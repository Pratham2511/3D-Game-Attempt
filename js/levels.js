// Level flow (1-10), spawning, unlock progress, and the menu / pause / game-over / victory screens.
import { CONFIG, levelConfig } from './config.js';

const $ = (id) => document.getElementById(id);

export function loadUnlocked() {
  try {
    const v = Number(localStorage.getItem(CONFIG.storageKey));
    return Number.isFinite(v) && v >= 1 ? Math.min(CONFIG.levels.length, v) : 1;
  } catch { return 1; }
}

function saveUnlocked(n) {
  try { localStorage.setItem(CONFIG.storageKey, String(n)); } catch { /* private mode */ }
}

export class LevelFlow {
  constructor(game) {
    this.game = game;
    this.level = 1;
    this.mode = 'menu';
    this.timer = 0;
    this.kills = 0;
    this.unlocked = loadUnlocked();
    this.cleared = new Set();
    for (let i = 1; i < this.unlocked; i++) this.cleared.add(i);
    this.screens = { menu: $('menu'), pause: $('pause'), gameover: $('gameover'), victory: $('victory') };
    this.wire();
  }

  wire() {
    const g = this.game;
    $('btn-play').addEventListener('click', () => { g.audio.unlock(); this.startLevel(this.unlocked, { fresh: true }); g.input.requestLock(); });
    $('btn-resume').addEventListener('click', () => { g.resume(); g.input.requestLock(); });
    $('btn-restart').addEventListener('click', () => { g.resume(); this.startLevel(this.level, { fresh: true }); g.input.requestLock(); });
    $('btn-mainmenu').addEventListener('click', () => { g.resume(); this.toMenu(); });
    $('btn-retry').addEventListener('click', () => { this.startLevel(this.level, { fresh: true }); g.input.requestLock(); });
    $('btn-gameover-menu').addEventListener('click', () => this.toMenu());
    $('btn-victory-menu').addEventListener('click', () => this.toMenu());
    for (const id of ['menu-quality', 'pause-quality']) {
      const sel = $(id);
      sel.innerHTML = CONFIG.quality.order.map((q) => `<option value="${q}">${q}</option>`).join('');
      sel.addEventListener('change', () => g.setQuality(sel.value));
    }
    this.buildGrid();
  }

  syncQualitySelects(name) {
    for (const id of ['menu-quality', 'pause-quality']) $(id).value = name;
  }

  buildGrid() {
    const grid = $('level-grid');
    grid.innerHTML = '';
    for (let n = 1; n <= CONFIG.levels.length; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn level-btn' + (this.cleared.has(n) ? ' cleared' : '');
      b.textContent = String(n);
      b.disabled = n > this.unlocked;
      b.setAttribute('aria-label', n > this.unlocked ? `Level ${n} (locked)` : `Level ${n}`);
      b.addEventListener('click', () => { this.game.audio.unlock(); this.startLevel(n, { fresh: true }); this.game.input.requestLock(); });
      grid.appendChild(b);
    }
    $('btn-play').textContent = this.unlocked > 1 ? `Continue: Level ${this.unlocked}` : 'Play';
  }

  showScreen(name) {
    for (const [k, el] of Object.entries(this.screens)) el.hidden = k !== name;
  }

  toMenu() {
    const g = this.game;
    this.mode = 'menu';
    for (const e of g.enemies) e.deactivate();
    g.tokens.clear();
    g.hero.reset(g.heroSpawn.x, g.heroSpawn.z, 0);
    g.hud.show(false);
    g.hud.hideCard();
    g.hud.clearTransient();
    g.input.enabled = false;
    g.input.releaseLock();
    this.buildGrid();
    this.showScreen('menu');
  }

  startLevel(n, { fresh = false } = {}) {
    const g = this.game;
    const cfg = levelConfig(n);
    this.level = n;
    if (fresh) this.kills = 0;
    const carryHealth = !fresh ? g.hero.health : null;
    for (const e of g.enemies) e.deactivate();
    g.tokens.clear();
    g.tokens.setMax(cfg.attackTokens);
    g.hero.reset(g.heroSpawn.x, g.heroSpawn.z, g.heroSpawn.yaw);
    if (carryHealth !== null) g.hero.health = Math.min(g.hero.maxHealth, carryHealth + g.hero.maxHealth * CONFIG.hero.healBetweenLevels);
    g.cam.snapBehind(g.hero);

    const ring = g.arena.ground.spawnRing;
    const offset = Math.random() * ring.length;
    for (let i = 0; i < cfg.enemies; i++) {
      const p = ring.length ? ring[Math.floor(offset + (i * ring.length) / cfg.enemies) % ring.length] : { x: Math.cos(i) * 6, z: Math.sin(i) * 6 };
      g.enemies[i].activate(cfg, p.x, p.z, 0.5 + i * CONFIG.spawnStagger, g.tokens);
    }
    g.hud.buildEnemyBars(g.enemies.length);
    g.hud.clearTransient();
    g.hud.card(`Level ${n}`, `${cfg.enemies} ${cfg.enemies === 1 ? 'brute approaches' : 'brutes approach'}`, 2.6);
    g.audio.play('levelStart');
    const dur = g.hero.playPowerUp();
    g.hero.controlLocked = true;
    this.timer = Math.min(2.2, Math.max(1.0, dur - 0.3));
    this.mode = 'intro';
    g.hud.show(true);
    g.input.enabled = true;
    this.showScreen(null);
  }

  onKill() { this.kills++; }

  remaining() {
    let n = 0;
    for (const e of this.game.enemies) if (e.active && !e.dead) n++;
    return n;
  }

  update(dt) {
    const g = this.game;
    if (this.mode === 'intro') {
      this.timer -= dt;
      if (this.timer <= 0) { g.hero.controlLocked = false; this.mode = 'play'; }
    } else if (this.mode === 'play') {
      if (g.hero.dead) { this.mode = 'dead'; this.timer = 2.4; g.hero.lockTarget = null; }
      else if (this.remaining() === 0) {
        this.mode = 'cleared';
        this.timer = 3.2;
        this.cleared.add(this.level);
        const next = Math.min(CONFIG.levels.length, this.level + 1);
        if (next > this.unlocked || this.level === CONFIG.levels.length) { this.unlocked = Math.max(this.unlocked, next); saveUnlocked(this.unlocked); }
        g.hud.card(this.level === CONFIG.levels.length ? 'Victory' : 'Level cleared', this.level === CONFIG.levels.length ? 'The abbey is yours' : `Level ${next} awaits`, 3);
        g.audio.play('levelClear');
      }
    } else if (this.mode === 'cleared') {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.level >= CONFIG.levels.length) {
          this.mode = 'victory';
          g.hud.show(false);
          g.input.enabled = false;
          g.input.releaseLock();
          $('victory-detail').textContent = `All ten trials are won. ${this.kills} brutes fell to your blade.`;
          this.showScreen('victory');
        } else this.startLevel(this.level + 1);
      }
    } else if (this.mode === 'dead') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.mode = 'gameover';
        g.input.enabled = false;
        g.input.releaseLock();
        $('gameover-detail').textContent = `Level ${this.level}: ${this.remaining()} ${this.remaining() === 1 ? 'brute remains' : 'brutes remain'}.`;
        this.showScreen('gameover');
      }
    }
  }
}
