// Character templates (skeleton cleanup, bind-pose scale, Phong -> PBR), shared Character base,
// and the Hero controller (movement, combo, heavy, kick, block/parry, dodge).
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from './config.js';
import { normalizeSkeletonNames, unifySkeleton } from './clipTools.js';
import { Animator } from './animation.js';

// ---------------------------------------------------------------- materials

const MAX_DERIVED = 2048;

function sourceImage(tex) {
  const img = tex && tex.image;
  if (!img) return null;
  const w = img.width || img.videoWidth, h = img.height || img.videoHeight;
  return w && h ? img : null;
}

function readPixels(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return { c, ctx, data: ctx.getImageData(0, 0, w, h) };
}

function derivedTexture(canvas, like, colorSpace) {
  const t = new THREE.CanvasTexture(canvas);
  t.flipY = like.flipY;
  t.wrapS = like.wrapS; t.wrapT = like.wrapT;
  t.repeat.copy(like.repeat); t.offset.copy(like.offset);
  t.channel = like.channel;
  t.colorSpace = colorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function prepTexture(t, colorSpace, anisotropy) {
  if (!t) return null;
  t.colorSpace = colorSpace;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The source specular map drives roughness (G) and a metal mask (B) in one texture; the albedo is
// brightened under metal because Phong/Blinn diffuse maps are authored dark where metal is shiny.
function bakeSpecular(rule, map, spec) {
  const img = sourceImage(spec);
  if (!img) return null;
  const sw = Math.min(MAX_DERIVED, img.width), sh = Math.min(MAX_DERIVED, img.height);
  const s = readPixels(img, sw, sh);
  const px = s.data.data;
  const out = s.ctx.createImageData(sw, sh);
  const o = out.data;
  const mask = rule.metal > 0 ? new Float32Array(sw * sh) : null;
  const [r0, r1] = rule.roughness;
  const mf = rule.metalFrom || [0.3, 0.7];
  for (let i = 0, p = 0; p < px.length; i++, p += 4) {
    const lum = (px[p] * 0.2126 + px[p + 1] * 0.7152 + px[p + 2] * 0.0722) / 255;
    const rough = r0 + (r1 - r0) * lum;
    const metal = rule.metal > 0 ? rule.metal * smooth(mf[0], mf[1], lum) : 0;
    if (mask) mask[i] = metal;
    o[p] = 255; o[p + 1] = Math.round(rough * 255); o[p + 2] = Math.round(metal * 255); o[p + 3] = 255;
  }
  s.ctx.putImageData(out, 0, 0);
  const rm = derivedTexture(s.c, spec, THREE.NoColorSpace);
  let albedo = null;
  const mimg = sourceImage(map);
  if (mask && rule.metalAlbedoBoost > 1 && mimg) {
    const aw = Math.min(MAX_DERIVED, mimg.width), ah = Math.min(MAX_DERIVED, mimg.height);
    const a = readPixels(mimg, aw, ah);
    const ap = a.data.data;
    for (let y = 0; y < ah; y++) {
      const my = Math.min(sh - 1, Math.floor((y / ah) * sh));
      for (let x = 0; x < aw; x++) {
        const mx = Math.min(sw - 1, Math.floor((x / aw) * sw));
        const k = 1 + (rule.metalAlbedoBoost - 1) * mask[my * sw + mx];
        const p = (y * aw + x) * 4;
        ap[p] = Math.min(255, ap[p] * k); ap[p + 1] = Math.min(255, ap[p + 1] * k); ap[p + 2] = Math.min(255, ap[p + 2] * k);
      }
    }
    a.ctx.putImageData(a.data, 0, 0);
    albedo = derivedTexture(a.c, map, THREE.SRGBColorSpace);
  }
  return { rm, albedo };
}

export function convertMaterials(root, anisotropy, label) {
  const cache = new Map();
  const report = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const next = list.map((m) => {
      if (cache.has(m.uuid)) return cache.get(m.uuid);
      const rule = CONFIG.materials.find((r) => r.match.test(m.name) || r.match.test(o.name));
      const map = prepTexture(m.map || null, THREE.SRGBColorSpace, anisotropy);
      const normalMap = prepTexture(m.normalMap || null, THREE.NoColorSpace, anisotropy);
      const spec = m.specularMap || m.specularColorMap || null;
      const baked = spec ? bakeSpecular(rule, map, spec) : null;
      const std = new THREE.MeshStandardMaterial({
        name: m.name,
        map: baked && baked.albedo ? baked.albedo : map,
        normalMap,
        color: rule.color !== undefined ? rule.color : 0xffffff,
        roughness: baked ? 1 : rule.roughness[0],
        metalness: baked ? (rule.metal > 0 ? 1 : 0) : rule.metal,
        roughnessMap: baked ? baked.rm : null,
        metalnessMap: baked && rule.metal > 0 ? baked.rm : null,
        envMapIntensity: rule.envMapIntensity ?? 1,
        alphaTest: rule.alphaTest || 0,
        side: rule.alphaTest ? THREE.DoubleSide : THREE.FrontSide,
      });
      if (normalMap && m.normalScale) std.normalScale.copy(m.normalScale);
      if (baked) {
        prepTexture(baked.rm, THREE.NoColorSpace, anisotropy);
        if (baked.albedo) prepTexture(baked.albedo, THREE.SRGBColorSpace, anisotropy);
      }
      if (!map) report.push(`${label}/${m.name}: no color map`);
      cache.set(m.uuid, std);
      m.dispose();
      return std;
    });
    o.material = Array.isArray(o.material) ? next : next[0];
  });
  return report;
}

// ---------------------------------------------------------------- templates

const WEAPON_BONE = /^(Sword_joint|RightHand)$/;
const PROP_BONE = /^(Sword_joint|Shield_joint|RightHand|LeftHand)$/;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

// Dominant bone per skinned mesh. Mesh names are not trusted (the hero GLB conversion shuffled
// them), so weapons and props are identified by what they are skinned to.
function skinDominance(mesh) {
  const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
  const counts = new Map();
  for (let i = 0; i < si.count; i++) {
    let best = 0, bw = -1;
    for (let c = 0; c < 4; c++) { const w = sw.getComponent(i, c); if (w > bw) { bw = w; best = si.getComponent(i, c); } }
    counts.set(best, (counts.get(best) || 0) + 1);
  }
  let boneIdx = 0, top = -1;
  for (const [k, n] of counts) if (n > top) { top = n; boneIdx = k; }
  return { bone: mesh.skeleton.bones[boneIdx], fraction: top / Math.max(1, si.count), count: si.count };
}

function findWeaponTip(meshes) {
  let pick = null;
  for (const m of meshes) {
    const d = m.userData.dominance;
    if (d.fraction > 0.8 && WEAPON_BONE.test(d.bone.name) && (!pick || d.bone.name === 'Sword_joint')) pick = m;
  }
  if (!pick) return null;
  const mesh = pick, bone = pick.userData.dominance.bone;
  const si = mesh.geometry.attributes.skinIndex;
  let far = -1;
  const tip = new THREE.Vector3();
  const step = Math.max(1, Math.floor(si.count / 6000));
  for (let i = 0; i < si.count; i += step) {
    mesh.getVertexPosition(i, _v);
    mesh.localToWorld(_v);
    bone.worldToLocal(_w.copy(_v));
    const d = _w.lengthSq();
    if (d > far) { far = d; tip.copy(_w); }
  }
  return { bone: bone.name, tipLocal: tip, meshName: mesh.name };
}

// Normalizes one loaded model into a template that can be cloned per character.
export function prepareTemplate(model, { height, label, anisotropy }) {
  const boneMap = normalizeSkeletonNames(model);
  // Only FBX rigs carry nested duplicate bone chains. glTF skins are already clean, and each skin's
  // inverse-bind matrices are relative to its own mesh, so they must not be merged.
  const seen = new Set();
  let duplicates = false;
  model.traverse((o) => { if (o.isBone) { if (seen.has(o.name)) duplicates = true; seen.add(o.name); } });
  if (duplicates) unifySkeleton(model, boneMap);
  const matReport = convertMaterials(model, anisotropy, label);
  model.position.set(0, 0, 0);
  model.rotation.set(0, 0, 0);
  const wrap = new THREE.Group();
  wrap.name = `${label}-model`;
  wrap.add(model);
  wrap.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const skinned = [];
  model.traverse((o) => { if (o.isSkinnedMesh) { o.userData.dominance = skinDominance(o); skinned.push(o); } });
  model.traverse((o) => {
    const d = o.userData.dominance;
    if (o.isSkinnedMesh && !(d.fraction > 0.8 && PROP_BONE.test(d.bone.name))) {
      const b = new THREE.Box3();
      o.computeBoundingBox();
      b.copy(o.boundingBox).applyMatrix4(o.matrixWorld);
      box.union(b);
    }
  });
  const rawHeight = box.max.y - box.min.y;
  const s = height / rawHeight;
  model.scale.multiplyScalar(s);
  const c = box.getCenter(new THREE.Vector3());
  model.position.set(-c.x * s, -box.min.y * s, -c.z * s);
  wrap.updateMatrixWorld(true);

  // Generous fixed bounds so frustum culling never hides a swinging weapon or a fallen body.
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const inv = new THREE.Matrix4().copy(o.matrixWorld).invert();
    const center = new THREE.Vector3(0, height * 0.5, 0).applyMatrix4(inv);
    const scale = new THREE.Vector3();
    o.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    const r = (height * 1.25) / Math.max(1e-6, scale.y);
    o.boundingSphere = new THREE.Sphere(center, r);
    if (o.geometry) {
      o.geometry.boundingSphere = new THREE.Sphere(center.clone(), r);
    }
  });
  wrap.updateMatrixWorld(true);
  const weapon = findWeaponTip(skinned);
  return { wrap, boneMap, scale: s, rawHeight, height, weapon, matReport, label };
}

// ---------------------------------------------------------------- Character base

const FLASH_DECAY = 9;

export class Character {
  constructor(template, lib, kind) {
    this.kind = kind;
    this.template = template;
    this.root = new THREE.Group();
    this.root.name = kind;
    this.model = SkeletonUtils.clone(template.wrap);
    this.root.add(this.model);
    this.meshes = [];
    this.materials = [];
    const matMap = new Map();
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      this.meshes.push(o);
      const list = Array.isArray(o.material) ? o.material : [o.material];
      const next = list.map((m) => {
        if (!matMap.has(m)) { const c = m.clone(); c.emissive = new THREE.Color(0x000000); matMap.set(m, c); this.materials.push(c); }
        return matMap.get(m);
      });
      o.material = Array.isArray(o.material) ? next : next[0];
    });
    const bone = (n) => this.model.getObjectByName(n);
    this.bones = {
      hips: bone('Hips'), head: bone('Head'), hand: bone('RightHand'),
      lFoot: bone('LeftFoot'), rFoot: bone('RightFoot'),
      lToe: bone('LeftToeBase') || bone('LeftFoot'), rToe: bone('RightToeBase') || bone('RightFoot'),
      weapon: template.weapon ? bone(template.weapon.bone) : null,
    };
    this.tipLocal = template.weapon ? template.weapon.tipLocal.clone() : null;
    this.lib = lib;
    this.animator = new Animator(this.model, lib.entries, lib.locomotion, lib.roles);
    this.height = template.height;
    this.radius = kind === 'hero' ? CONFIG.hero.radius : CONFIG.enemy.radius;
    this.yaw = 0;
    this.vel = new THREE.Vector3();
    this.knock = new THREE.Vector3();
    this.health = 100;
    this.maxHealth = 100;
    this.dead = false;
    this.flash = 0;
    this.glow = 0;
    this.glowColor = new THREE.Color(0xff3a1a);
    this.flashColor = new THREE.Color(0xffffff);
    this.attack = null;
    this.blocking = false;
    this.blockStart = -10;
    this.castsShadow = true;
    this.footY = [0, 0];
    this.footDown = [true, true];
    this.onScreen = true;
    this._fwd = new THREE.Vector3();
  }

  get position() { return this.root.position; }

  forward(out) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }

  setShadow(on) {
    if (this.castsShadow === on) return;
    this.castsShadow = on;
    for (const m of this.meshes) m.castShadow = on;
  }

  hitFlash(amount = 1) { this.flash = Math.max(this.flash, amount); }

  // Converts a world-space velocity into the animator's Mixamo-local frame (+Z forward, +X left).
  feedLocomotion(vx, vz) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.animator.setLocomotion(vx * c - vz * s, vx * s + vz * c);
  }

  // Root-motion delta (Mixamo local) -> world displacement.
  applyRootDelta(rd, ground) {
    if (rd.x === 0 && rd.y === 0) return;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const dx = rd.x * c + rd.y * s, dz = -rd.x * s + rd.y * c;
    ground.tryMove(this.root.position, dx, dz, this.radius);
  }

  turnToward(targetYaw, rate, dt) {
    let d = targetYaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * (1 - Math.exp(-rate * dt));
    return Math.abs(d);
  }

  yawTo(p) { return Math.atan2(p.x - this.root.position.x, p.z - this.root.position.z); }

  weaponSegment(outA, outB) {
    const b = this.bones.weapon || this.bones.hand;
    this.bones.hand.getWorldPosition(outA);
    if (this.tipLocal) outB.copy(this.tipLocal).applyMatrix4(b.matrixWorld);
    else outB.copy(outA);
  }

  updateVisual(dt, ground) {
    this.root.position.y = ground.heightAt(this.root.position.x, this.root.position.z);
    this.root.rotation.y = this.yaw;
    if (this.flash > 0 || this.glow > 0) {
      this.flash = Math.max(0, this.flash - dt * FLASH_DECAY);
      const f = this.flash * this.flash;
      for (const m of this.materials) {
        m.emissive.copy(this.glowColor).multiplyScalar(this.glow).lerp(this.flashColor, Math.min(1, f));
        m.emissiveIntensity = f > 0 ? 0.6 + f : 1;
      }
    } else if (this._emissiveOn) {
      for (const m of this.materials) m.emissive.setRGB(0, 0, 0);
    }
    this._emissiveOn = this.flash > 0 || this.glow > 0;
  }

  // Footstep contacts: returns a foot index when a foot has just planted, else -1.
  footContact(groundY) {
    let planted = -1;
    const feet = [this.bones.lToe, this.bones.rToe];
    for (let i = 0; i < 2; i++) {
      feet[i].getWorldPosition(_v);
      const h = _v.y - groundY;
      const down = h < 0.07;
      if (down && !this.footDown[i]) planted = i;
      this.footDown[i] = down;
      this.footY[i] = h;
    }
    return planted;
  }

  dispose() {
    this.animator.dispose();
    for (const m of this.materials) m.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

// ---------------------------------------------------------------- Hero

// One swing per hero attack: the damage window that holds the clip's hand-speed peak.
function mainWindow(entry) {
  const w = entry.meta.damageWindows;
  let best = w[0];
  for (const x of w) if (x.peak > best.peak) best = x;
  return best ? [best] : [];
}

const _move = new THREE.Vector3();
const _camF = new THREE.Vector3();
const _camR = new THREE.Vector3();
const _want = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class Hero extends Character {
  constructor(template, lib) {
    super(template, lib, 'hero');
    this.maxHealth = CONFIG.hero.maxHealth;
    this.health = this.maxHealth;
    this.maxStamina = CONFIG.hero.maxStamina;
    this.stamina = this.maxStamina;
    this.staminaDelay = 0;
    this.state = 'free';
    this.stateTime = 0;
    this.combo = 0;
    this.queued = null;
    this.lockTarget = null;
    this.iFrame = false;
    this.dodgeDir = new THREE.Vector3();
    this.dodgeDone = 0;
    this.dodgeDur = 0.6;
    this.controlLocked = false;
    this.time = 0;
    this.lastAttackPress = -10;
    this.firstMotionAt = -1;
    this.events = [];
  }

  reset(x, z, yaw) {
    this.root.position.set(x, 0, z);
    this.yaw = yaw;
    this.vel.set(0, 0, 0);
    this.knock.set(0, 0, 0);
    this.health = this.maxHealth;
    this.stamina = this.maxStamina;
    this.dead = false;
    this.state = 'free';
    this.attack = null;
    this.combo = 0;
    this.queued = null;
    this.lockTarget = null;
    this.blocking = false;
    this.animator.setBlock(false);
    this.animator.stopShots(0.01);
    this.animator.setLocomotion(0, 0);
  }

  spend(cost) {
    if (this.stamina <= 0) return false;
    this.stamina = Math.max(0, this.stamina - cost);
    this.staminaDelay = CONFIG.hero.staminaRegenDelay;
    return true;
  }

  canAct() { return !this.dead && !this.controlLocked; }

  attackWindows(entry) { return entry.meta.damageWindows; }

  recoveryInfo() {
    const a = this.attack;
    if (!a) return null;
    const t = a.shot.action.time, d = a.entry.clip.duration;
    const wins = a.entry.meta.damageWindows;
    const lastEnd = a.windows.length ? a.windows[a.windows.length - 1].end : (wins.length ? wins[wins.length - 1].end : d * 0.5);
    return { t, d, lastEnd, inRecovery: t >= lastEnd, recFrac: t >= lastEnd ? (t - lastEnd) / Math.max(0.01, d - lastEnd) : 0 };
  }

  startAttack(kind, ctx) {
    const H = CONFIG.hero;
    const roles = this.lib.roles;
    let entry, damage, cost;
    if (kind === 'light') {
      entry = roles.lightCombo[this.combo % roles.lightCombo.length];
      damage = H.lightDamage[this.combo % H.lightDamage.length];
      cost = H.lightStamina;
    } else if (kind === 'heavy') {
      entry = roles.heavy; damage = H.heavyDamage; cost = H.heavyStamina;
    } else {
      entry = roles.kick; damage = H.kickDamage; cost = H.kickStamina;
    }
    if (!entry || this.stamina < cost * 0.4) return false;
    this.spend(cost);
    this.faceAttackTarget(ctx);
    const startAt = Math.max(0, entry.meta.motionStart - CONFIG.anim.attackLeadIn);
    const prevKind = this.attack ? 'attack' : 'loco';
    const shot = this.animator.play(entry, { kind: 'attack', startAt, fade: prevKind === 'attack' ? 0.1 : 0.08, fadeOut: 0.22 });
    shot.rootScale = kind === 'heavy' ? H.heavyLungeScale : 1;
    this.attack = {
      kind, entry, shot, damage, hitSet: new Set(), windowIdx: -1, startedAt: this.time, windows: mainWindow(entry),
      breaksBlock: kind === 'kick', heavy: kind === 'heavy', strikeBone: entry.meta.strikeBone,
    };
    this.state = kind === 'light' ? 'attack' : kind;
    this.stateTime = 0;
    this.queued = null;
    if (kind === 'light') this.combo = (this.combo + 1) % roles.lightCombo.length;
    else this.combo = 0;
    this.blocking = false;
    this.animator.setBlock(false);
    this.events.push({ type: 'swing', kind });
    return true;
  }

  faceAttackTarget(ctx) {
    let target = this.lockTarget && !this.lockTarget.dead ? this.lockTarget : null;
    if (!target && ctx.enemies) {
      ctx.cam.forward(_camF);
      let best = 3.8;
      for (const e of ctx.enemies) {
        if (!e.active || e.dead) continue;
        _tmp.subVectors(e.position, this.position);
        _tmp.y = 0;
        const d = _tmp.length();
        if (d > best) continue;
        _tmp.divideScalar(d || 1);
        if (_tmp.dot(_camF) < 0.35) continue;
        best = d; target = e;
      }
    }
    if (target) this.yaw = this.yawTo(target.position);
    else { ctx.cam.forward(_camF); this.yaw = Math.atan2(_camF.x, _camF.z); }
  }

  startDodge(ctx) {
    if (!this.spend(CONFIG.hero.dodgeStamina)) return false;
    const input = ctx.input;
    ctx.cam.forward(_camF); ctx.cam.right(_camR);
    this.dodgeDir.set(0, 0, 0).addScaledVector(_camF, input.moveZ).addScaledVector(_camR, input.moveX);
    if (this.dodgeDir.lengthSq() < 0.01) this.forward(this.dodgeDir).negate();
    this.dodgeDir.normalize();
    const back = this.lockTarget && this.dodgeDir.dot(this.forward(_tmp)) < -0.5;
    if (!back) this.yaw = Math.atan2(this.dodgeDir.x, this.dodgeDir.z);
    const entry = back && this.lib.roles.dodgeInPlace ? this.lib.roles.dodgeInPlace : this.lib.roles.dodge;
    const rate = THREE.MathUtils.clamp(entry.clip.duration / CONFIG.hero.dodgeTime, 1, 2.2);
    this.dodgeDur = (entry.clip.duration - entry.meta.motionStart * 0.5) / rate;
    const shot = this.animator.play(entry, { kind: 'dodge', rate, startAt: entry.meta.motionStart * 0.5, fadeOut: 0.18 });
    shot.rootScale = 0;
    this.attack = null;
    this.state = 'dodge';
    this.stateTime = 0;
    this.dodgeDone = 0;
    this.blocking = false;
    this.animator.setBlock(false);
    this.queued = null;
    this.events.push({ type: 'dodge' });
    return true;
  }

  // Called by combat when an enemy strike connects.
  takeHit(dmg, attacker, dirLocalX, dirLocalZ, entryPick) {
    const H = CONFIG.hero;
    this.health = Math.max(0, this.health - dmg);
    this.hitFlash(1);
    this.attack = null;
    this.queued = null;
    this.combo = 0;
    if (this.health <= 0) { this.die(); return; }
    const clip = entryPick(this.lib.roles.hits, dirLocalX, dirLocalZ);
    this.animator.play(clip, { kind: 'hit', fadeOut: 0.2 });
    this.state = 'hit';
    this.stateTime = 0;
    this.stunTime = H.hitStun;
    this.blocking = false;
    this.animator.setBlock(false);
  }

  blockImpact() {
    const e = this.lib.roles.blockImpact;
    if (e) this.animator.play(e, { kind: 'block', fade: 0.06, fadeOut: 0.15, rate: 1.3 });
  }

  die() {
    this.dead = true;
    this.state = 'dead';
    this.attack = null;
    this.blocking = false;
    this.animator.setBlock(false);
    this.animator.setLocomotion(0, 0);
    this.vel.set(0, 0, 0);
    this.animator.play(this.lib.roles.death, { kind: 'death', hold: true });
    this.events.push({ type: 'death' });
  }

  playPowerUp() {
    const e = this.lib.roles.powerUp;
    if (!e) return 0;
    this.animator.play(e, { kind: 'shot', fade: 0.25, fadeOut: 0.35 });
    return e.clip.duration;
  }

  update(dt, ctx) {
    const H = CONFIG.hero;
    const input = ctx.input;
    this.time += dt;
    this.stateTime += dt;
    const cam = ctx.cam;
    if (this.lockTarget && (this.lockTarget.dead || !this.lockTarget.active)) this.lockTarget = null;

    // Stamina.
    if (this.staminaDelay > 0) this.staminaDelay -= dt;
    else if (!this.blocking) this.stamina = Math.min(this.maxStamina, this.stamina + H.staminaRegen * dt);
    if (this.blocking) {
      this.stamina = Math.max(0, this.stamina - H.blockDrainPerSec * dt);
      if (this.staminaDelay <= 0) this.stamina = Math.min(this.maxStamina, this.stamina + H.staminaRegen * 0.25 * dt);
    }

    const acting = this.canAct();
    if (acting && input.lockPressed) this.cycleLock(ctx);

    // State transitions from input.
    if (acting) {
      const rec = this.recoveryInfo();
      const cancellable = this.state === 'free' || (rec && rec.inRecovery && rec.recFrac >= H.cancelFrac);
      if (input.attackPressed || input.heavyPressed) {
        this.lastAttackPress = this.time;
        this.queued = input.heavyPressed ? 'heavy' : 'light';
      }
      if (this.queued && this.time - this.lastAttackPress > H.comboBufferTime) this.queued = null;
      if (input.dodgePressed && (this.state === 'free' || cancellable || this.state === 'hit' && this.stateTime > H.hitStun * 0.7)) {
        this.startDodge(ctx);
      } else if (input.kickPressed && (this.state === 'free' || cancellable)) {
        this.startAttack('kick', ctx);
      } else if (this.queued) {
        const canChain = this.state === 'free' || (this.attack && rec.t >= rec.lastEnd - 0.04);
        if (canChain) this.startAttack(this.queued, ctx);
      }
      const wantBlock = input.block && (this.state === 'free' || this.state === 'block' || (cancellable && this.attack));
      if (wantBlock && !this.blocking) {
        if (this.attack) { this.animator.stopShots(0.12); this.attack = null; }
        this.blocking = true;
        this.blockStart = this.time;
        this.state = 'free';
        this.events.push({ type: 'blockUp' });
      } else if (!input.block && this.blocking) {
        this.blocking = false;
      }
      if (this.blocking && this.stamina <= 0) this.blocking = false;
      this.animator.setBlock(this.blocking);
    }

    // Attack / dodge / hit timers.
    if (this.attack) {
      const s = this.attack.shot;
      if (s.ended || s.fadingOut) {
        this.attack = null;
        this.state = 'free';
        this.combo = this.queued ? this.combo : 0;
      }
    }
    if (this.state === 'dodge') {
      const f = Math.min(1, this.stateTime / this.dodgeDur);
      const eased = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, f * 1.15));
      const target = eased * H.dodgeDistance;
      const step = target - this.dodgeDone;
      this.dodgeDone = target;
      ctx.ground.tryMove(this.root.position, this.dodgeDir.x * step, this.dodgeDir.z * step, this.radius);
      this.iFrame = this.stateTime >= H.dodgeIFrames[0] && this.stateTime <= H.dodgeIFrames[1];
      if (f >= 1) { this.state = 'free'; this.iFrame = false; }
    } else this.iFrame = false;
    if (this.state === 'hit' && this.stateTime >= this.stunTime) this.state = 'free';

    // Movement.
    cam.forward(_camF); cam.right(_camR);
    _move.set(0, 0, 0);
    const free = this.state === 'free' && acting;
    if (free) _move.addScaledVector(_camF, input.moveZ).addScaledVector(_camR, input.moveX);
    const mLen = _move.length();
    if (mLen > 1) _move.divideScalar(mLen);
    const strafe = this.blocking || !!this.lockTarget;
    let speed = input.walk ? H.walkSpeed : (strafe ? H.strafeRunSpeed : H.runSpeed);
    if (strafe && input.walk) speed = H.strafeWalkSpeed;
    if (this.blocking) speed = Math.min(speed, H.blockMoveSpeed);
    _want.copy(_move).multiplyScalar(speed);
    _tmp.subVectors(_want, this.vel);
    const rate = _want.lengthSq() > this.vel.lengthSq() ? H.accel : H.decel;
    const maxStep = rate * dt;
    const dl = _tmp.length();
    if (dl > maxStep) _tmp.multiplyScalar(maxStep / dl);
    this.vel.add(_tmp);
    if (this.state === 'dodge' || this.state === 'dead') this.vel.set(0, 0, 0);
    else if (!free) this.vel.multiplyScalar(Math.exp(-10 * dt));
    if (this.vel.lengthSq() > 1e-6) ctx.ground.tryMove(this.root.position, this.vel.x * dt, this.vel.z * dt, this.radius);
    if (this.knock.lengthSq() > 1e-5) {
      ctx.ground.tryMove(this.root.position, this.knock.x * dt, this.knock.z * dt, this.radius);
      this.knock.multiplyScalar(Math.exp(-12 * dt));
    }

    // Facing.
    if (acting && this.state !== 'dodge' && this.state !== 'dead') {
      if (this.lockTarget) this.turnToward(this.yawTo(this.lockTarget.position), H.turnRate, dt);
      else if (this.blocking) this.turnToward(Math.atan2(_camF.x, _camF.z), H.turnRate, dt);
      else if (this.state === 'free' && this.vel.lengthSq() > 0.04) this.turnToward(Math.atan2(this.vel.x, this.vel.z), H.turnRate, dt);
      else if (this.attack && this.lockTarget) this.turnToward(this.yawTo(this.lockTarget.position), H.turnRate * 0.5, dt);
    }

    this.feedLocomotion(this.vel.x, this.vel.z);
    const rd = this.animator.update(dt);
    if (this.state !== 'dodge') this.applyRootDelta(rd, ctx.ground);
    ctx.ground.clampToBoundary(this.root.position, this.radius);
  }

  cycleLock(ctx) {
    const alive = ctx.enemies.filter((e) => e.active && !e.dead && e.position.distanceTo(this.position) < CONFIG.camera.lockOnRange);
    if (!alive.length) { this.lockTarget = null; return; }
    if (!this.lockTarget) {
      ctx.cam.forward(_camF);
      let best = null, bs = -Infinity;
      for (const e of alive) {
        _tmp.subVectors(e.position, this.position); _tmp.y = 0;
        const d = _tmp.length();
        const score = _tmp.divideScalar(d || 1).dot(_camF) * 2 - d * 0.08;
        if (score > bs) { bs = score; best = e; }
      }
      this.lockTarget = best;
      return;
    }
    if (alive.length === 1) { this.lockTarget = null; return; }
    const angle = (e) => {
      _tmp.subVectors(e.position, this.position);
      let a = Math.atan2(_tmp.x, _tmp.z) - Math.atan2(this.lockTarget.position.x - this.position.x, this.lockTarget.position.z - this.position.z);
      a = Math.atan2(Math.sin(a), Math.cos(a));
      return a <= 1e-4 ? a + Math.PI * 2 : a;
    };
    let next = null, na = Infinity;
    for (const e of alive) {
      if (e === this.lockTarget) continue;
      const a = angle(e);
      if (a < na) { na = a; next = e; }
    }
    this.lockTarget = next;
  }
}

export function cloneTemplate(t) { return SkeletonUtils.clone(t.wrap); }
