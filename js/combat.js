// Hit detection (weapon segment sweep vs capsules), damage resolution (block, parry, guard
// break, hit reactions by direction), game feel (hit-stop, shake, sparks, flash, numbers,
// knockback) and the pooled particle effects.
import * as THREE from 'three';
import { CONFIG } from './config.js';

const _a0 = new THREE.Vector3(), _b0 = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _p = new THREE.Vector3(), _q = new THREE.Vector3();
const _capA = new THREE.Vector3(), _capB = new THREE.Vector3();
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _r = new THREE.Vector3();
const _dir = new THREE.Vector3(), _f = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();

// Squared distance between segments p1-q1 and p2-q2; closest point on the first goes to outP.
export function segSegDist2(p1, q1, p2, q2, outP) {
  _d1.subVectors(q1, p1); _d2.subVectors(q2, p2); _r.subVectors(p1, p2);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) { outP.copy(p1); return _r.dot(_r); }
  if (a <= 1e-9) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = _d1.dot(_r);
    if (e <= 1e-9) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = _d1.dot(_d2), den = a * e - b * b;
      s = den !== 0 ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  outP.copy(p1).addScaledVector(_d1, s);
  _q.copy(p2).addScaledVector(_d2, t);
  return outP.distanceToSquared(_q);
}

function capsule(target, outA, outB) {
  const p = target.position, r = target.radius;
  outA.set(p.x, p.y + r, p.z);
  outB.set(p.x, p.y + target.height - r * 0.8, p.z);
}

// Chooses the reaction whose measured hip sway moves away from the attacker.
export function pickReaction(entries, lx, lz) {
  if (!entries || !entries.length) return null;
  let best = entries[0], bs = -Infinity;
  for (const e of entries) {
    const [sx, sz] = e.meta.sway;
    const len = Math.hypot(sx, sz) || 1;
    const score = -(sx * lx + sz * lz) / len;
    if (score > bs) { bs = score; best = e; }
  }
  return best;
}

// Direction from target to attacker in the target's Mixamo-local frame (+X left, +Z forward).
function localDir(target, attacker) {
  _dir.subVectors(attacker.position, target.position); _dir.y = 0;
  _dir.normalize();
  const s = Math.sin(target.yaw), c = Math.cos(target.yaw);
  return [_dir.x * c - _dir.z * s, _dir.x * s + _dir.z * c];
}

export class Combat {
  constructor({ hud, audio, cam, fx, ground }) {
    this.hud = hud;
    this.audio = audio;
    this.cam = cam;
    this.fx = fx;
    this.ground = ground;
    this.hitStop = 0;
    this.onKill = null;
    this.onHit = null;
    this.log = [];
    this.logEnabled = false;
    this.frame = 0;
  }

  get timeScale() { return this.hitStop > 0 ? 0.04 : 1; }

  update(dt, hero, enemies) {
    this.frame++;
    if (this.hitStop > 0) this.hitStop -= dt;
    if (hero.attack && !hero.dead) this.sweep(hero, enemies, dt);
    for (const e of enemies) {
      if (e.active && !e.dead && e.attack) this.sweep(e, hero, dt);
    }
  }

  strikeSegment(att, outA, outB) {
    const a = att.attack;
    if (a.strikeBone === 'LeftFoot' || a.strikeBone === 'RightFoot') {
      const left = a.strikeBone === 'LeftFoot';
      (left ? att.bones.lFoot : att.bones.rFoot).getWorldPosition(outA);
      (left ? att.bones.lToe : att.bones.rToe).getWorldPosition(outB);
      outB.sub(outA).multiplyScalar(1.6).add(outA);
      return 0.14;
    }
    att.weaponSegment(outA, outB);
    return 0.06;
  }

  sweep(att, targets, dt) {
    const a = att.attack;
    const t = a.shot.action.time;
    const wins = a.windows;
    const prevT = a.lastT ?? t;
    a.lastT = t;
    let wi = -1;
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i];
      if ((t >= w.start && t <= w.end) || (prevT < w.start && t > w.end)) { wi = i; break; }
    }
    if (wi !== a.windowIdx) {
      if (wi >= 0) a.hitSet.clear();
      a.windowIdx = wi;
      a.prevValid = false;
    }
    if (wi < 0) return;
    const blade = this.strikeSegment(att, _a, _b);
    if (!a.prevValid) { a.prevA = a.prevA || new THREE.Vector3(); a.prevB = a.prevB || new THREE.Vector3(); a.prevA.copy(_a); a.prevB.copy(_b); a.prevValid = true; }
    const list = Array.isArray(targets) ? targets : null;
    const n = list ? list.length : 1;
    for (let i = 0; i < n; i++) {
      const tg = list ? list[i] : targets;
      if (tg.dead || (tg.kind === 'enemy' && (!tg.active || tg.state === 'spawnWait')) || a.hitSet.has(tg)) continue;
      if (tg.iFrame) continue;
      const dx = tg.position.x - att.position.x, dz = tg.position.z - att.position.z;
      if (dx * dx + dz * dz > 16) continue;
      capsule(tg, _capA, _capB);
      const rr = tg.radius + blade;
      let hit = false;
      if (att.tipLocal || a.kind === 'kick') {
        const steps = CONFIG.combat.sweepSubsteps;
        for (let k = 1; k <= steps && !hit; k++) {
          const f = k / steps;
          _a0.lerpVectors(a.prevA, _a, f);
          _b0.lerpVectors(a.prevB, _b, f);
          if (segSegDist2(_a0, _b0, _capA, _capB, _p) < rr * rr) { hit = true; _hitPoint.copy(_p); }
        }
      } else {
        // Fallback: distance plus frontal cone at the window peak.
        const w = wins[wi];
        if (prevT <= w.peakT && t >= w.peakT) {
          const d = Math.sqrt(dx * dx + dz * dz);
          att.forward(_f);
          const cos = (_f.x * dx + _f.z * dz) / (d || 1);
          if (d < CONFIG.enemy.attackRange + 0.3 && cos > Math.cos(THREE.MathUtils.degToRad(CONFIG.combat.frontalConeDeg / 2))) {
            hit = true;
            _hitPoint.set(tg.position.x, tg.position.y + tg.height * 0.6, tg.position.z);
          }
        }
      }
      if (hit) this.resolve(att, tg, _hitPoint);
    }
    a.prevA.copy(_a); a.prevB.copy(_b);
  }

  resolve(att, tg, point) {
    const a = att.attack;
    const C = CONFIG.combat, H = CONFIG.hero;
    a.hitSet.add(tg);
    const [lx, lz] = localDir(tg, att);
    const frontal = lz > Math.cos(THREE.MathUtils.degToRad(H.blockArcDeg / 2));
    const heroInvolved = att.kind === 'hero' || tg.kind === 'hero';
    _dir.subVectors(tg.position, att.position); _dir.y = 0; _dir.normalize();
    const rec = { frame: this.frame, attacker: att.kind, target: tg.kind, kind: a.kind, result: '', lx, lz, clip: a.entry.name, t: a.shot.action.time };

    if (tg.blocking && frontal) {
      if (a.breaksBlock) {
        this.audio.play('kick');
        this.fx.sparks(point, 10, 0xffd08a);
        if (tg.kind === 'enemy') { tg.stagger(CONFIG.enemy.kickStagger); rec.result = 'guardbreak'; }
        else { tg.takeHit(a.damage, att, lx, lz, pickReaction); rec.result = 'guardbreak'; }
        this.hud.number(point, 'BREAK', 'blocked');
        this.cam.addShake(C.shakeLight);
        this.finish(rec, tg, att);
        return;
      }
      if (tg.kind === 'hero' && tg.time - tg.blockStart <= H.parryWindow) {
        if (att.stagger) att.stagger(CONFIG.enemy.parryStagger);
        this.audio.play('parry');
        this.fx.sparks(point, 34, 0xfff1c4);
        this.hitStop = Math.max(this.hitStop, C.hitStop * 1.3);
        this.cam.addShake(C.shakeLight);
        this.hud.number(point, 'PARRY', 'heavy');
        rec.result = 'parry';
        this.finish(rec, tg, att);
        return;
      }
      this.audio.play('block');
      this.fx.sparks(point, 16, 0xffc070);
      if (tg.kind === 'hero') {
        tg.stamina = Math.max(0, tg.stamina - H.blockHitStamina);
        tg.staminaDelay = H.staminaRegenDelay;
        const dmg = Math.round(a.damage * H.blockDamageFactor);
        if (tg.stamina <= 0) {
          tg.takeHit(a.damage * 0.6, att, lx, lz, pickReaction);
          rec.result = 'guardbreak';
        } else {
          tg.health = Math.max(0.01, tg.health - dmg);
          tg.blockImpact();
          rec.result = 'blocked';
        }
        this.hud.number(point, dmg > 0 ? String(dmg) : 'BLOCK', 'blocked hero');
        tg.knock.addScaledVector(_dir, C.knockback * 5);
      } else {
        tg.blockHit();
        this.hud.number(point, 'BLOCK', 'blocked');
        rec.result = 'blocked';
      }
      this.cam.addShake(C.shakeLight * 0.6);
      this.finish(rec, tg, att);
      return;
    }

    const dmg = Math.round(a.damage);
    tg.takeHit(dmg, att, lx, lz, pickReaction);
    const heavy = a.heavy;
    tg.knock.addScaledVector(_dir, (heavy ? C.heavyKnockback : C.knockback) * 12);
    if (heroInvolved) {
      this.hitStop = Math.max(this.hitStop, heavy ? C.hitStop : C.hitStopLight);
      this.cam.addShake(tg.kind === 'hero' ? C.shakeHeavy : (heavy ? C.shakeHeavy : C.shakeLight));
    }
    this.fx.sparks(point, heavy ? 28 : 16, 0xffb060);
    this.audio.play(heavy ? 'hitHeavy' : 'hit');
    this.hud.number(point, String(dmg), tg.kind === 'hero' ? 'hero' : heavy ? 'heavy' : '');
    rec.result = tg.dead ? 'kill' : 'hit';
    rec.reaction = tg.dead ? 'death' : tg.animator.lastShotName;
    if (tg.dead) {
      this.audio.play('death');
      if (this.onKill && tg.kind === 'enemy') this.onKill(tg);
    }
    this.finish(rec, tg, att);
  }

  finish(rec, tg, att) {
    if (this.logEnabled) this.log.push(rec);
    if (this.onHit) this.onHit(rec, tg, att);
  }
}

// ---------------------------------------------------------------- pooled particles

const SPARK_MAX = 256;
const DUST_MAX = 128;

function pointsMaterial(additive) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { scale: { value: 600 } },
    vertexShader: `
      attribute float size; attribute vec4 tint; varying vec4 vTint; uniform float scale;
      void main() {
        vTint = tint;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * scale / max(0.1, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: additive ? `
      varying vec4 vTint;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, r) * vTint.a;
        gl_FragColor = vec4(vTint.rgb * a * 2.2, a);
      }` : `
      varying vec4 vTint;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.1, r) * vTint.a;
        gl_FragColor = vec4(vTint.rgb, a);
      }`,
  });
}

class Pool {
  constructor(max, additive, scene) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.tint = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.cursor = 0;
    this.alive = 0;
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.tintAttr = new THREE.BufferAttribute(this.tint, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('tint', this.tintAttr);
    g.setAttribute('size', this.sizeAttr);
    this.points = new THREE.Points(g, pointsMaterial(additive));
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz, life, size, r, g, b) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.size0[i] = size;
    this.tint[i * 4] = r; this.tint[i * 4 + 1] = g; this.tint[i * 4 + 2] = b;
  }

  update(dt, gravity, drag, grow) {
    let alive = 0;
    const k = Math.exp(-drag * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.tint[i * 4 + 3] = 0; this.size[i] = 0; continue; }
      alive++;
      this.life[i] -= dt;
      const f = Math.max(0, this.life[i] / this.maxLife[i]);
      this.vel[i * 3 + 1] -= gravity * dt;
      this.vel[i * 3] *= k; this.vel[i * 3 + 1] *= k; this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.tint[i * 4 + 3] = grow ? f * f * 0.55 : f;
      this.size[i] = this.size0[i] * (grow ? 1 + (1 - f) * 2.2 : 0.4 + f * 0.6);
    }
    this.alive = alive;
    if (alive || this._wasAlive) {
      this.posAttr.needsUpdate = true; this.tintAttr.needsUpdate = true; this.sizeAttr.needsUpdate = true;
    }
    this._wasAlive = alive > 0;
  }
}

const _c = new THREE.Color();

export class ParticleFx {
  constructor(scene) {
    this.spark = new Pool(SPARK_MAX, true, scene);
    this.dust = new Pool(DUST_MAX, false, scene);
  }

  sparks(p, count, color) {
    _c.setHex(color);
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = 2.5 + Math.random() * 5.5;
      const r = Math.sqrt(1 - u * u);
      this.spark.spawn(p.x, p.y, p.z, r * Math.cos(th) * s, Math.abs(u) * s * 0.8 + 1.2, r * Math.sin(th) * s,
        0.18 + Math.random() * 0.3, 0.035 + Math.random() * 0.03, _c.r, _c.g, _c.b);
    }
  }

  puff(x, y, z, strength = 1) {
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2, s = (0.25 + Math.random() * 0.45) * strength;
      this.dust.spawn(x + Math.cos(a) * 0.05, y + 0.04, z + Math.sin(a) * 0.05, Math.cos(a) * s, 0.12 + Math.random() * 0.2, Math.sin(a) * s,
        0.6 + Math.random() * 0.5, 0.09 * strength + Math.random() * 0.05, 0.58, 0.5, 0.41);
    }
  }

  setScale(px) {
    this.spark.points.material.uniforms.scale.value = px;
    this.dust.points.material.uniforms.scale.value = px;
  }

  update(dt) {
    this.spark.update(dt, 9.8, 2.2, false);
    this.dust.update(dt, -0.05, 2.5, true);
  }
}
