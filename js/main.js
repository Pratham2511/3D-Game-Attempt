// Boot, loading screen, scene assembly and the game loop.
import * as THREE from 'three';
import { CONFIG, THREE_VERSION } from './config.js';
import { loadAll, AssetError, missingTextures } from './assets.js';
import { Arena } from './arena.js';
import { Lighting } from './lighting.js';
import { ThirdPersonCamera } from './camera.js';
import { Input } from './input.js';
import { buildClipLibrary, classifyLocomotion } from './animation.js';
import { prepareTemplate, Hero } from './characters.js';
import { Enemy, AttackTokens } from './enemyAI.js';
import { Combat, ParticleFx } from './combat.js';
import { HUD } from './hud.js';
import { AudioFX } from './audio.js';
import { PostFX, detectTier } from './postfx.js';
import { LevelFlow } from './levels.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const $ = (id) => document.getElementById(id);
const MAX_ENEMIES = 10;
const PLAY_MODES = new Set(['intro', 'play', 'cleared', 'dead']);

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere(new THREE.Vector3(), 1.6);
const _push = new THREE.Vector3();
const _toe = new THREE.Vector3();

class Game {
  constructor() {
    this.canvas = $('game');
    this.params = new URLSearchParams(location.search);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = CONFIG.lighting.exposure;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.info.autoReset = false;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, window.innerWidth / window.innerHeight, 0.08, 400);
    this.time = 0;
    this.frameNo = 0;
    this.paused = false;
    this.last = performance.now();
    this.frameMs = new Float32Array(600);
    this.frameIdx = 0;
    this.logicMs = 0;
    this.debugText = '';
    this.debugTimer = 0;
    this.stats = {};
    this.menuAngle = 0;
    this.frame = this.frame.bind(this);
  }

  progress(frac, text) {
    const pct = Math.round(frac * 100);
    $('progress-fill').style.transform = `scaleX(${frac.toFixed(4)})`;
    $('progress-fill').parentElement.setAttribute('aria-valuenow', String(pct));
    $('load-status').textContent = `${text} (${pct}%)`;
  }

  showError(err) {
    console.error(err);
    const box = $('load-error');
    box.hidden = false;
    if (err instanceof AssetError) {
      box.innerHTML = `<strong>Could not load ${err.file}</strong><br><code>${err.url}</code><br>${err.reason}`;
    } else {
      const msg = String(err && err.message ? err.message : err);
      const file = location.protocol === 'file:' ? '<br>Open the game through a local web server (see README), not file://.' : '';
      box.innerHTML = `<strong>Startup failed</strong><br>${msg.replace(/</g, '&lt;')}${file}`;
    }
    $('load-status').textContent = 'Loading stopped.';
    $('loading').hidden = false;
  }

  async boot() {
    if (location.protocol === 'file:') throw new Error('Browsers block module imports and asset fetches from file:// (CORS).');
    this.progress(0, 'Downloading assets');
    const assets = await loadAll(({ phase, detail, fraction }) => this.progress(fraction, phase === 'download' ? `Downloading ${detail}` : `Parsing ${detail}`));
    this.assets = assets;
    await this.build(assets);
    this.assets = null;
    $('loading').hidden = true;
    this.flow.toMenu();
    this.last = performance.now();
    requestAnimationFrame(this.frame);
    if (this.qa) this.qa.start();
  }

  async build(assets) {
    const r = this.renderer;
    this.progress(0.92, 'Building arena');
    await nextFrame();
    this.arena = new Arena().build(assets.arena, r);
    this.scene.add(this.arena.group);
    await this.arena.buildGround(nextFrame, (f) => this.progress(0.92 + f * 0.03, 'Sampling ground'));
    const ground = this.arena.ground;
    this.lighting = new Lighting(this.scene, r);

    this.progress(0.95, 'Preparing characters');
    await nextFrame();
    const aniso = Math.min(8, r.capabilities.getMaxAnisotropy());
    this.heroT = prepareTemplate(assets.hero.scene, { height: CONFIG.scale.heroHeight, label: 'hero', anisotropy: aniso });
    this.enemyT = prepareTemplate(assets.enemy, { height: CONFIG.scale.heroHeight * CONFIG.scale.bruteRatio, label: 'brute', anisotropy: aniso });

    this.progress(0.96, 'Measuring animation clips');
    await nextFrame();
    this.heroLib = await this.buildHeroLib(assets.clips);
    this.progress(0.975, 'Measuring brute clips');
    this.enemyLib = await this.buildEnemyLib(assets.clips);

    this.hero = new Hero(this.heroT, this.heroLib);
    this.scene.add(this.hero.root);
    this.enemies = [];
    for (let i = 0; i < MAX_ENEMIES; i++) {
      const e = new Enemy(this.enemyT, this.enemyLib, i);
      this.enemies.push(e);
      this.scene.add(e.root);
    }
    this.heroSpawn = this.findSpawn(ground);

    this.cam = new ThirdPersonCamera(this.camera, this.arena);
    this.input = new Input(this.canvas);
    this.hud = new HUD();
    this.hud.buildEnemyBars(MAX_ENEMIES);
    this.audio = new AudioFX();
    this.fx = new ParticleFx(this.scene);
    this.tokens = new AttackTokens();
    this.combat = new Combat({ hud: this.hud, audio: this.audio, cam: this.cam, fx: this.fx, ground });
    this.flow = new LevelFlow(this);
    this.combat.onKill = () => this.flow.onKill();
    this.ctx = { input: this.input, cam: this.cam, ground, enemies: this.enemies, hero: this.hero, tokens: this.tokens };

    this.postfx = new PostFX(r, this.scene, this.camera);
    const det = detectTier(r);
    this.gpu = det.gpu;
    const forced = this.params.get('quality');
    this.setQuality(CONFIG.quality.tiers[forced] ? forced : det.tier, true);
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
    this.input.onLockChange = (locked) => {
      if (!locked && this.wasLocked && PLAY_MODES.has(this.flow.mode) && !this.paused && !this.input.virtual) this.pause();
      this.wasLocked = locked;
    };

    this.progress(0.99, 'Compiling shaders');
    await nextFrame();
    await this.warmUp();
    this.stats.load = { files: assets.stats.files, mb: +(assets.stats.bytes / 1048576).toFixed(1) };
    this.stats.arena = this.arena.stats;
    console.info(`[game] three ${THREE_VERSION}, GPU "${this.gpu}", tier ${this.postfx.tierName}, arena ${JSON.stringify(this.arena.stats)}`);
    if (missingTextures.length) console.warn(`[game] missing textures: ${missingTextures.join(', ')}`);
  }

  async buildHeroLib(clips) {
    const h = CONFIG.heroClips;
    const roles = [
      { url: h.idle, role: 'idle', loop: true },
      ...h.idleFidgets.map((url) => ({ url, role: 'fidget' })),
      ...h.locomotion.map((url) => ({ url, role: 'locomotion', loop: true })),
      ...h.lightCombo.map((url, i) => ({ url, role: `light${i + 1}` })),
      { url: h.heavy, role: 'heavy' },
      { url: h.kick, role: 'kick', strike: 'foot' },
      { url: h.blockIdle, role: 'blockIdle', loop: true },
      { url: h.blockImpact, role: 'blockImpact' },
      ...h.hits.map((url) => ({ url, role: 'hit' })),
      { url: h.death, role: 'death' },
      { url: h.dodge, role: 'dodge' },
      { url: h.dodgeInPlace, role: 'dodgeInPlace' },
      { url: h.powerUp, role: 'powerUp' },
    ];
    const lib = await buildClipLibrary({ template: this.heroT.wrap, boneMap: this.heroT.boneMap, clipData: clips, roles, label: 'hero', yieldFn: nextFrame });
    const E = (u) => lib.entries.get(u);
    lib.locomotion = classifyLocomotion(lib.entries, h.locomotion, 'hero');
    lib.roles = {
      idle: E(h.idle), blockIdle: E(h.blockIdle), blockUpper: lib.entries.get('blockUpper'),
      fidgets: h.idleFidgets.map(E).filter(Boolean), lightCombo: h.lightCombo.map(E).filter(Boolean),
      heavy: E(h.heavy), kick: E(h.kick), blockImpact: E(h.blockImpact), hits: h.hits.map(E).filter(Boolean),
      death: E(h.death), dodge: E(h.dodge), dodgeInPlace: E(h.dodgeInPlace), powerUp: E(h.powerUp),
    };
    return lib;
  }

  async buildEnemyLib(clips) {
    const c = CONFIG.enemyClips;
    const isKick = (u) => /kick/i.test(u);
    const roles = [
      { url: c.idle, role: 'idle', loop: true },
      ...c.idleVariants.map((url) => ({ url, role: 'idleVariant' })),
      ...c.locomotion.map((url) => ({ url, role: 'locomotion', loop: true })),
      ...c.attacks.map((url) => ({ url, role: 'attack', strike: isKick(url) ? 'foot' : 'hand' })),
      { url: c.gapCloser, role: 'gapCloser' },
      { url: c.blockIdle, role: 'blockIdle', loop: true },
      { url: c.blockReact, role: 'blockReact' },
      { url: c.hitLeft, role: 'hit' }, { url: c.hitRight, role: 'hit' }, { url: c.hitGut, role: 'hit' },
      { url: c.death, role: 'death' },
      ...c.taunts.map((url) => ({ url, role: 'taunt' })),
    ];
    const lib = await buildClipLibrary({ template: this.enemyT.wrap, boneMap: this.enemyT.boneMap, clipData: clips, roles, label: 'brute', yieldFn: nextFrame });
    const E = (u) => lib.entries.get(u);
    lib.locomotion = classifyLocomotion(lib.entries, c.locomotion, 'brute');
    const attacks = c.attacks.map(E).filter(Boolean);
    for (const a of attacks) a.isKick = isKick(a.url);
    lib.roles = {
      idle: E(c.idle), blockIdle: E(c.blockIdle), blockUpper: lib.entries.get('blockUpper'),
      idleVariants: c.idleVariants.map(E).filter(Boolean), attacks, kicks: attacks.filter((a) => a.isKick),
      gapCloser: E(c.gapCloser), blockReact: E(c.blockReact),
      hits: [E(c.hitLeft), E(c.hitRight), E(c.hitGut)].filter(Boolean), hitGut: E(c.hitGut),
      death: E(c.death), taunts: c.taunts.map(E).filter(Boolean),
    };
    return lib;
  }

  findSpawn(ground) {
    for (let r = 0; r < 12; r += 0.3) {
      for (let a = 0; a < Math.PI * 2; a += 0.4) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (ground.clearAt(x, z, 2)) return { x, z, yaw: 0 };
      }
    }
    return { x: 0, z: 0, yaw: 0 };
  }

  // Compiles every material with all characters visible so the first fight does not hitch.
  async warmUp() {
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      e.root.visible = true;
      e.root.position.set(Math.cos(i) * 3, 0, Math.sin(i) * 3);
    }
    this.hero.updateVisual(0, this.arena.ground);
    this.fx.sparks(new THREE.Vector3(0, 1, 0), 2, 0xffffff);
    this.fx.puff(0, 0, 0);
    this.cam.update(0, null, this.hero, null);
    if (this.renderer.compileAsync) await this.renderer.compileAsync(this.scene, this.camera);
    this.postfx.render();
    for (const e of this.enemies) { e.root.visible = false; e.root.position.set(0, -50, 0); }
  }

  setQuality(name, initial = false) {
    const tier = CONFIG.quality.tiers[name];
    this.postfx.setTier(name);
    this.lighting.setShadowMapSize(tier.shadowMap);
    this.lighting.setShadowExtent(name === 'Low' ? 14 : 18);
    this.lighting.buildDust(tier.dust);
    this.lighting.buildShafts(tier.shafts);
    this.flow.syncQualitySelects(name);
    this.onResize();
    if (!initial) console.info(`[game] quality -> ${name}`);
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.postfx.setSize(w, h);
    this.hud.resize(w, h);
    const px = (h * this.postfx.pixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.fx.setScale(px);
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.flow.showScreen('pause');
    this.input.clearHeld();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.flow.showScreen(null);
    this.last = performance.now();
  }

  frame(now) {
    requestAnimationFrame(this.frame);
    const raw = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    this.frameMs[this.frameIdx] = raw * 1000;
    this.frameIdx = (this.frameIdx + 1) % this.frameMs.length;
    if (this.qa && this.qa.running) { this.qa.tick(raw); return; }
    this.step(Math.min(0.05, raw));
    this.renderFrame(raw);
  }

  renderFrame(raw) {
    this.renderer.info.reset();
    this.postfx.render();
    if (!this.paused && raw) this.postfx.trackFrame(raw * 1000);
  }

  step(dt) {
    const t0 = performance.now();
    const input = this.input;
    const hero = this.hero;
    const mode = this.flow.mode;
    this.frameNo++;
    this.hud.fps(dt);
    if (input.debugPressed) this.hud.toggleDebug();
    if (input.pausePressed && PLAY_MODES.has(mode)) {
      if (this.paused) { this.resume(); input.requestLock(); } else this.pause();
    }
    if (this.paused) { input.endFrame(dt); return; }
    this.time += dt;
    const playing = PLAY_MODES.has(mode);
    const sdt = dt * this.combat.timeScale;
    const ground = this.arena.ground;

    hero.update(sdt, this.ctx);
    if (playing) {
      for (const e of this.enemies) e.update(sdt, this.ctx);
      this.separate();
      this.combat.update(sdt, hero, this.enemies);
      this.handleEvents();
      this.flow.update(dt);
    }
    hero.updateVisual(dt, ground);
    this.footsteps(hero, 2.4, 1);
    for (const e of this.enemies) {
      if (!e.active || !e.root.visible) continue;
      e.updateVisual(dt, ground);
      if (e.castsShadow && e.vel.lengthSq() > 3) this.footsteps(e, 1.8, 1.3);
    }

    if (playing) this.cam.update(dt, input, hero, hero.lockTarget);
    else this.menuCamera(dt);
    this.lighting.follow(hero.position);
    this.lighting.update(this.time, hero.position);
    this.fx.update(sdt);
    if (this.frameNo % 10 === 0) this.updateLod();
    this.hud.update(dt, this.camera, hero, this.enemies);
    this.hud.setCounts(this.flow.level, this.flow.remaining(), this.flow.kills);
    this.hud.lockPrompt(playing && !input.locked && !input.virtual && !this.paused);
    input.endFrame(dt);
    this.logicMs = performance.now() - t0;
    this.debugTimer -= dt;
    if (this.hud.debugOn && this.debugTimer <= 0) { this.debugTimer = 0.5; this.hud.setDebug(this.debugReport()); }
  }

  menuCamera(dt) {
    this.menuAngle += dt * 0.06;
    const r = 9.5;
    this.camera.position.set(Math.sin(this.menuAngle) * r, 3.4, Math.cos(this.menuAngle) * r);
    this.camera.lookAt(this.hero.position.x, 1.2, this.hero.position.z);
    this.cam.yaw = this.menuAngle;
  }

  // Hero/brute capsules never overlap; brutes give way more than the hero.
  separate() {
    const hero = this.hero, g = this.arena.ground;
    if (hero.dead) return;
    for (const e of this.enemies) {
      if (!e.active || e.dead || e.state === 'spawnWait') continue;
      _push.subVectors(e.position, hero.position); _push.y = 0;
      const d = _push.length(), min = hero.radius + e.radius;
      if (d >= min || d < 1e-5) continue;
      _push.multiplyScalar((min - d) / d);
      g.tryMove(e.root.position, _push.x * 0.7, _push.z * 0.7, e.radius);
      g.tryMove(hero.root.position, -_push.x * 0.3, -_push.z * 0.3, hero.radius);
    }
  }

  handleEvents() {
    const hero = this.hero;
    for (const ev of hero.events) {
      if (ev.type === 'swing') this.audio.play('swing', ev.kind === 'heavy' ? 1.2 : 0.9);
      else if (ev.type === 'death') this.audio.play('death', 1.3);
      else if (ev.type === 'dodge') this.fx.puff(hero.position.x, hero.position.y, hero.position.z, 1.2);
    }
    hero.events.length = 0;
    for (const e of this.enemies) {
      if (!e.events.length) continue;
      for (const ev of e.events) {
        if (ev.type === 'swing') this.audio.play('swing', 0.7);
        else if (ev.type === 'spawn') this.fx.puff(e.position.x, e.position.y, e.position.z, 2.6);
      }
      e.events.length = 0;
    }
  }

  footsteps(c, minSpeed, strength) {
    const gy = c.position.y;
    const planted = c.footContact(gy);
    if (planted < 0 || c.vel.lengthSq() < minSpeed * minSpeed) return;
    (planted === 0 ? c.bones.lToe : c.bones.rToe).getWorldPosition(_toe);
    this.fx.puff(_toe.x, gy, _toe.z, strength * 0.7);
    if (c === this.hero) this.audio.play('step', 1);
  }

  // Shadow casters: hero + nearest brutes. Animation rate: full near or in combat, reduced far/off-screen.
  updateLod() {
    const tier = this.postfx.tier;
    const hero = this.hero;
    _pv.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    const list = this.lodList || (this.lodList = []);
    list.length = 0;
    for (const e of this.enemies) {
      if (!e.active) continue;
      e._lodD = e.position.distanceToSquared(hero.position);
      list.push(e);
    }
    list.sort((a, b) => a._lodD - b._lodD);
    const [n1, n2] = CONFIG.anim.lodDistance;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      e.setShadow(i < tier.shadowCasters - 1);
      _sphere.center.set(e.position.x, e.position.y + 1, e.position.z);
      e.onScreen = _frustum.intersectsSphere(_sphere);
      const busy = e.attack || e.state === 'hit' || e.state === 'stagger' || e.state === 'telegraph' || e.state === 'dead';
      const dc = e.position.distanceTo(this.camera.position);
      let stride = 1;
      if (!busy) {
        if (!e.onScreen) stride = 3;
        else if (dc > n2) stride = 3;
        else if (dc > n1) stride = 2;
      }
      if (e.dead && e.deathTime > 3) stride = 4;
      e.animator.updateStride = stride;
    }
  }

  debugReport() {
    const info = this.renderer.info;
    const libs = [['hero', this.heroLib], ['brute', this.enemyLib]];
    const lines = [
      `FPS ${Math.round(this.hud.currentFps || 0)}  logic ${this.logicMs.toFixed(2)} ms`,
      `draw calls ${info.render.calls}  triangles ${info.render.triangles.toLocaleString()}`,
      `quality ${this.postfx.tierName}  render scale ${this.postfx.renderScale.toFixed(2)}  pixel ratio ${this.postfx.pixelRatio().toFixed(2)}`,
      `GPU ${this.gpu}`,
      `arena walkable ${this.arena.stats.walkableArea.toFixed(0)} m2  r=${this.arena.stats.boundaryRadius.toFixed(1)} m`,
      '',
    ];
    for (const [label, lib] of libs) {
      let min = 1, n = 0;
      for (const e of lib.entries.values()) { if (e.url === 'blockUpper') continue; n++; min = Math.min(min, e.bindRatio); }
      lines.push(`${label}: ${n} clips, min bind ${(min * 100).toFixed(1)}%`);
      for (const g of ['walk', 'run']) {
        const dirs = Object.entries(lib.locomotion.gaits[g]).map(([d, e]) => `${d}=${e.name}(${e.speed.toFixed(2)})`).join(' ');
        lines.push(`  ${g}: ${dirs}`);
      }
      for (const row of lib.table) if (row.windows && !/locomotion|idle/.test(row.role)) lines.push(`  ${row.clip} [${row.role}] win ${row.windows} peak ${row.peakAt}s root ${row.rootMotion}`);
      for (const w of lib.warnings) lines.push(`  WARN ${w}`);
    }
    if (missingTextures.length) lines.push(`missing textures: ${missingTextures.join(', ')}`);
    else lines.push('missing textures: none');
    return lines.join('\n');
  }
}

async function start() {
  const game = new Game();
  window.__game = game;
  if (game.params.get('qa') === '1') {
    const { QA } = await import('./qa.js');
    game.qa = new QA(game);
  }
  try {
    await game.boot();
  } catch (err) {
    game.showError(err);
  }
}

window.addEventListener('error', (e) => {
  const box = $('load-error');
  if (box && !$('loading').hidden) { box.hidden = false; box.textContent = `Error: ${e.message}`; }
});

start();

/*
Optimizations applied
- All assets are downloaded 4 at a time behind the loading screen and parsed with a frame yield between files; nothing loads during play.
- The arena's 23 submeshes are baked into a single merged, indexed geometry (one draw call) with a BVH for raycasts.
- Ground height is a precomputed Float32Array height field sampled bilinearly; walkability is a Uint8Array mask. No raycasts per frame except one BVH camera-collision ray.
- Ten brute clones are created once at load (SkeletonUtils.clone sharing geometry, textures and the shader program) and pooled across levels; level changes reset state instead of reallocating.
- Shaders are precompiled with compileAsync while every brute is visible, so the first fight does not hitch.
- Per-frame math reuses module-level Vector3/Matrix4/Frustum/Sphere scratch objects; the game loop allocates nothing per frame.
- Sparks and dust puffs are fixed-size pooled Points buffers (2 draw calls total); damage numbers and enemy bars are pooled DOM nodes updated only through transform/opacity.
- Audio uses a fixed pool of filter/gain voice chains; only the source node is created per sound.
- Only the hero and the nearest brutes (per quality tier) cast shadows; the shadow camera follows the hero with texel snapping.
- Brutes far from the camera or off-screen animate every 2nd/3rd frame (accumulated dt), dead ones every 4th; attackers always update every frame.
- Locomotion clips are time-driven (phase-synced) instead of running separate mixer time scales, which keeps blending cheap and slide-free.
- Characters use fixed generous bounding spheres so skinned meshes can be frustum culled without recomputing bounds.
- Post-processing is tiered (Low: SMAA only; Medium: half-cost GTAO + bloom; High/Ultra: full GTAO, higher pixel ratio, larger shadow map).
- Dynamic resolution lowers the render scale when frame time is over budget and restores it when frames return to vsync; pixel ratio is capped at 2.
- renderer.info is reset manually once per frame so draw-call stats cover the whole composer chain.
*/
