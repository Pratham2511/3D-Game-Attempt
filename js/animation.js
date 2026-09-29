// Clip library construction and the per-character animation state machine.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG, fadeTime } from './config.js';
import { retargetClip, analyzeClip, stripRootMotion, sampleRootCurve, canonicalBoneName } from './clipTools.js';

const UPPER_BODY = /^(Spine|Spine1|Spine2|Neck|Head|HeadTop_End|LeftEye|RightEye|Left(Shoulder|Arm|ForeArm|Hand.*)|Right(Shoulder|Arm|ForeArm|Hand.*)|Sword_joint|Shield_joint)$/;

export function shortName(url) {
  return decodeURI(url).split('/').pop().replace(/\.fbx$/i, '');
}

// Builds processed clips + measurements for one character type.
// roles: [{ url, role, loop, strike }]; returns { entries: Map(url -> entry), table, warnings }.
export async function buildClipLibrary({ template, boneMap, clipData, roles, weapon, label, yieldFn }) {
  const rigRoot = SkeletonUtils.clone(template);
  rigRoot.position.set(0, 0, 0);
  rigRoot.rotation.set(0, 0, 0);
  rigRoot.updateMatrixWorld(true);
  const find = (n) => { let b = null; rigRoot.traverse((o) => { if (!b && o.isBone && o.name === n) b = o; }); return b; };
  const hips = find('Hips');
  const rig = {
    root: rigRoot,
    mixer: new THREE.AnimationMixer(rigRoot),
    hips,
    lFoot: find('LeftFoot'),
    rFoot: find('RightFoot'),
    hand: find('RightHand'),
  };
  const hipsParentScale = new THREE.Vector3();
  hips.parent.getWorldScale(hipsParentScale);
  const unitToLocal = 1 / hipsParentScale.y;
  const charHipRest = boneMap.get('Hips').position.y;

  const entries = new Map();
  const table = [];
  const warnings = [];
  let i = 0;
  for (const r of roles) {
    const data = clipData.get(r.url);
    if (!data) { warnings.push(`${label}: clip not loaded ${r.url}`); continue; }
    if (entries.has(r.url)) { entries.get(r.url).roles.push(r.role); continue; }
    const name = shortName(r.url);
    const ratio = data.hipsRestY ? charHipRest / data.hipsRestY : 1;
    const rt = retargetClip(data.clip, name, boneMap, ratio);
    if (rt.unmatched.length) {
      const msg = `${label}/${name}: ${rt.unmatched.length} unmatched bone track(s): ${[...new Set(rt.unmatched)].join(', ')}`;
      warnings.push(msg);
      console.warn(`[anim] ${msg}`);
    }
    if (rt.bindRatio < 0.98) {
      const msg = `${label}/${name}: only ${(rt.bindRatio * 100).toFixed(1)}% of tracks bind (needs 98%)`;
      warnings.push(msg);
      console.error(`[anim] ${msg}`);
    }
    // Kicks are measured on the feet rather than the weapon hand.
    const strikeFoot = r.strike === 'foot';
    let meta;
    if (strikeFoot) {
      const mL = analyzeClip(rt.clip, { ...rig, hand: rig.lFoot }, { loop: r.loop, windowThreshold: CONFIG.anim.damageWindowThreshold });
      const mR = analyzeClip(rt.clip, { ...rig, hand: rig.rFoot }, { loop: r.loop, windowThreshold: CONFIG.anim.damageWindowThreshold });
      meta = mL.handPeak >= mR.handPeak ? { ...mL, strikeBone: 'LeftFoot' } : { ...mR, strikeBone: 'RightFoot' };
    } else {
      meta = analyzeClip(rt.clip, rig, { loop: r.loop, windowThreshold: CONFIG.anim.damageWindowThreshold });
      meta.strikeBone = 'RightHand';
    }
    stripRootMotion(rt.clip, meta, unitToLocal, r.loop);
    if (r.loop) meta.rootCurve = null;
    const entry = {
      url: r.url, name, clip: rt.clip, meta, loop: !!r.loop, roles: [r.role],
      bind: `${rt.bound}/${rt.total}`, bindRatio: rt.bindRatio,
      gait: null, dir: null, speed: meta.loopSpeed || meta.stanceRelSpeed,
    };
    entries.set(r.url, entry);
    table.push({
      clip: name, role: r.role, dur: +meta.duration.toFixed(2), bind: entry.bind,
      rootTravel: +meta.hipsTravel.toFixed(2), footTravel: +meta.footTravel.toFixed(2),
      dir: meta.direction, speed: +entry.speed.toFixed(2),
      handPeak: +meta.handPeak.toFixed(1), peakAt: +meta.handPeakT.toFixed(2),
      windows: meta.damageWindows.map((w) => `${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join(' '),
      rootMotion: meta.rootCurve ? 'yes' : 'no',
    });
    if (++i % 6 === 0 && yieldFn) await yieldFn();
  }
  rig.mixer.stopAllAction();
  // Upper-body copy of the block idle for blocking while moving.
  for (const e of entries.values()) {
    if (e.roles.includes('blockIdle')) {
      const tracks = e.clip.tracks.filter((t) => UPPER_BODY.test(t.name.slice(0, t.name.lastIndexOf('.'))));
      entries.set('blockUpper', {
        ...e, url: 'blockUpper', name: `${e.name}[upper]`, clip: new THREE.AnimationClip(`${e.name}_upper`, e.clip.duration, tracks), roles: ['blockUpper'],
      });
    }
  }
  return { entries, table, warnings };
}

// Picks the four locomotion directions per gait from measured travel, not file names.
export function classifyLocomotion(entries, urls, label) {
  const gaits = { walk: {}, run: {} };
  const log = [];
  for (const url of urls) {
    const e = entries.get(url);
    if (!e) continue;
    const gait = e.speed < 2.0 ? 'walk' : 'run';
    e.gait = gait;
    e.dir = e.meta.direction;
    if (gaits[gait][e.dir]) log.push(`${label}: duplicate ${gait}/${e.dir} (${e.name}); keeping ${gaits[gait][e.dir].name}`);
    else gaits[gait][e.dir] = e;
    log.push(`${label}: ${e.name} -> ${gait} ${e.dir} (${e.speed.toFixed(2)} m/s, travel [${e.meta.travelDir.map((v) => v.toFixed(2))}])`);
  }
  for (const l of log) console.info(`[anim] ${l}`);
  return { gaits, log };
}

const DIRS = ['forward', 'left', 'back', 'right'];

class Slot {
  constructor(entry, action) {
    this.entry = entry;
    this.action = action;
    this.w = 0;
    this.target = 0;
  }
}

// One mixer per character. Base layer (idle / locomotion / block idle) with phase-synced
// directional blending, an upper-body block overlay, and a stack of weighted one-shot actions.
export class Animator {
  constructor(root, lib, locomotion, roles) {
    this.root = root;
    this.mixer = new THREE.AnimationMixer(root);
    this.lib = lib;
    this.roles = roles;
    this.base = new Map();
    this.loco = [];
    this.phase = 0;
    this.localVel = new THREE.Vector2();
    this.speed = 0;
    this.blockAmt = 0;
    this.blocking = false;
    this.shots = [];
    this.rootDelta = new THREE.Vector2();
    this._tmp = new THREE.Vector2();
    this._tmp2 = new THREE.Vector2();
    this.updateStride = 1;
    this._accum = 0;
    this._frame = 0;
    this.lastShotName = '';
    this.maxBoneStep = 0;

    const mk = (entry, loop) => {
      const a = this.mixer.clipAction(entry.clip);
      a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      a.clampWhenFinished = !loop;
      return a;
    };
    this.idle = new Slot(roles.idle, mk(roles.idle, true));
    this.idle.action.play();
    this.idle.w = this.idle.target = 1;
    this.blockIdle = roles.blockIdle ? new Slot(roles.blockIdle, mk(roles.blockIdle, true)) : null;
    if (this.blockIdle) this.blockIdle.action.play();
    this.blockUpper = roles.blockUpper ? new Slot(roles.blockUpper, mk(roles.blockUpper, true)) : null;
    if (this.blockUpper) this.blockUpper.action.play();

    this.gaitSlots = { walk: {}, run: {} };
    for (const gait of ['walk', 'run']) {
      for (const d of DIRS) {
        const e = locomotion.gaits[gait][d];
        if (!e) continue;
        const s = new Slot(e, mk(e, true));
        s.action.timeScale = 0;
        s.action.play();
        s.gait = gait; s.dir = d;
        this.gaitSlots[gait][d] = s;
        this.loco.push(s);
      }
    }
    this.baseSlots = [this.idle, ...(this.blockIdle ? [this.blockIdle] : []), ...this.loco];
    this.sync(0);
  }

  setLocomotion(vx, vz) {
    this.localVel.set(vx, vz);
  }

  setBlock(on) {
    this.blocking = on;
  }

  // Plays a one-shot (or held) clip on top of the base layer.
  play(entry, opts = {}) {
    if (!entry) return null;
    const kind = opts.kind || 'shot';
    const prev = this.shots.length ? this.shots[this.shots.length - 1] : null;
    const fromKind = prev && !prev.fadingOut ? prev.kind : 'loco';
    const fade = opts.fade ?? fadeTime(fromKind, kind);
    for (const s of this.shots) {
      if (!s.fadingOut) { s.fadingOut = true; s.fadeRate = s.w / Math.max(0.001, fade); }
    }
    const action = this.mixer.clipAction(entry.clip);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.timeScale = opts.rate ?? 1;
    action.time = opts.startAt ?? 0;
    action.setEffectiveWeight(0);
    action.play();
    const shot = {
      entry, action, kind, w: 0, fadeIn: Math.max(0.001, fade), fadingOut: false, fadeRate: 0,
      hold: !!opts.hold, fadeOut: opts.fadeOut ?? fadeTime(kind, 'loco'), onEnd: opts.onEnd || null,
      ended: false, prevTime: action.time, startAt: action.time, id: ++this._frame,
    };
    this.shots.push(shot);
    this.lastShotName = entry.name;
    return shot;
  }

  stopShots(fade = 0.2) {
    for (const s of this.shots) {
      if (!s.fadingOut) { s.fadingOut = true; s.fadeRate = s.w / Math.max(0.001, fade); }
    }
  }

  current() {
    for (let i = this.shots.length - 1; i >= 0; i--) if (!this.shots[i].fadingOut) return this.shots[i];
    return null;
  }

  // Phase-synced time for every locomotion clip: left-foot contacts line up across clips.
  sync(dt) {
    let wSum = 0, stride = 0;
    for (const s of this.loco) {
      if (s.w <= 1e-4) continue;
      wSum += s.w;
      stride += s.w * Math.max(0.2, s.entry.speed * s.entry.clip.duration);
    }
    if (wSum > 0) {
      stride /= wSum;
      this.phase = (this.phase + (this.speed * dt) / stride) % 1;
    }
    for (const s of this.loco) {
      const d = s.entry.clip.duration;
      s.action.time = ((this.phase + s.entry.meta.contactPhase) % 1) * d;
    }
  }

  _baseTargets() {
    const a = CONFIG.anim;
    const vx = this.localVel.x, vz = this.localVel.y;
    const s = Math.hypot(vx, vz);
    this.speed = s;
    const moveW = THREE.MathUtils.clamp((s - a.idleSpeed * 0.5) / 0.55, 0, 1);
    const still = 1 - moveW;
    this.idle.target = still * (1 - this.blockAmt);
    if (this.blockIdle) this.blockIdle.target = still * this.blockAmt;
    for (const sl of this.loco) sl.target = 0;
    if (moveW <= 0) return;
    const walkRef = CONFIG.hero.walkSpeed, runRef = 3.0;
    const runF = THREE.MathUtils.smoothstep(s, walkRef, runRef);
    let ang = Math.atan2(vx, vz) * 180 / Math.PI; // 0 fwd, 90 left, -90 right
    if (ang < 0) ang += 360;
    const seg = Math.floor(ang / 90) % 4;
    const t = (ang - seg * 90) / 90;
    const d0 = DIRS[seg], d1 = DIRS[(seg + 1) % 4];
    const give = (gait, dir, w) => {
      if (w <= 0) return;
      const slot = this.gaitSlots[gait][dir] || this.gaitSlots.walk[dir] || this.gaitSlots.run[dir];
      if (slot) slot.target += w;
    };
    for (const [gait, gw] of [['walk', 1 - runF], ['run', runF]]) {
      if (gw <= 0) continue;
      give(gait, d0, moveW * gw * (1 - t));
      give(gait, d1, moveW * gw * t);
    }
  }

  update(dt) {
    this.rootDelta.set(0, 0);
    this._accum += dt;
    this._frame++;
    if (this.updateStride > 1 && this._frame % this.updateStride !== 0) return this.rootDelta;
    dt = this._accum;
    this._accum = 0;

    const rate = CONFIG.anim.locomotionWeightRate;
    const k = 1 - Math.exp(-rate * dt);
    const blockTarget = this.blocking ? 1 : 0;
    this.blockAmt += (blockTarget - this.blockAmt) * (1 - Math.exp(-(1 / fadeTime('loco', 'block')) * 2.2 * dt));
    if (Math.abs(this.blockAmt - blockTarget) < 0.002) this.blockAmt = blockTarget;
    this._baseTargets();
    let sum = 0;
    for (const s of this.baseSlots) {
      s.w += (s.target - s.w) * k;
      if (s.w < 1e-4) s.w = 0;
      sum += s.w;
    }
    if (sum < 1e-4) { this.idle.w = 1; sum = 1; }

    // One-shots: newest fades in, older ones fade out; completed ones fade back to the base.
    let shotSum = 0;
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      const d = s.entry.clip.duration;
      if (!s.fadingOut) {
        s.w = Math.min(1, s.w + dt / s.fadeIn);
        if (!s.hold && s.action.time >= d - s.fadeOut - 1e-3) {
          s.fadingOut = true;
          s.fadeRate = s.w / Math.max(0.001, s.fadeOut);
          if (!s.ended) { s.ended = true; if (s.onEnd) s.onEnd(s); }
        }
      } else {
        s.w -= s.fadeRate * dt;
        if (!s.ended && s.action.time >= d - 1e-3) { s.ended = true; if (s.onEnd) s.onEnd(s); }
      }
      if (s.w <= 0) {
        s.action.stop();
        s.action.enabled = false;
        this.shots.splice(i, 1);
        continue;
      }
    }
    for (const s of this.shots) shotSum += s.w;
    const shotScale = shotSum > 1 ? 1 / shotSum : 1;
    const baseScale = Math.max(0, 1 - shotSum * shotScale);

    for (const s of this.baseSlots) {
      const w = (s.w / sum) * baseScale;
      s.action.enabled = w > 1e-4;
      s.action.setEffectiveWeight(w);
    }
    if (this.blockUpper) {
      const moving = 1 - this.idle.target - (this.blockIdle ? this.blockIdle.target : 0);
      const w = this.blockAmt * Math.max(0, moving) * baseScale;
      this.blockUpper.action.enabled = w > 1e-3;
      // Upper-body bones get ~92% block pose while the legs keep the locomotion.
      this.blockUpper.action.setEffectiveWeight(w * 11);
    }
    for (const s of this.shots) s.action.setEffectiveWeight(s.w * shotScale);

    this.sync(dt);
    for (const s of this.shots) s.prevTime = s.action.time;
    this.mixer.update(dt);

    // Root motion from one-shot travel clips, weighted by their blend weight.
    for (const s of this.shots) {
      const meta = s.entry.meta;
      if (meta.rootCurve) {
        const a = sampleRootCurve(meta, s.prevTime, this._tmp);
        const b = sampleRootCurve(meta, s.action.time, this._tmp2);
        const w = s.w * shotScale;
        this.rootDelta.x += (b.x - a.x) * w * (s.rootScale ?? 1);
        this.rootDelta.y += (b.y - a.y) * w * (s.rootScale ?? 1);
      }
    }
    return this.rootDelta;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }
}

export function upperBodyRegex() {
  return UPPER_BODY;
}

export { canonicalBoneName };
