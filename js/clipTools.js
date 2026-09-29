// Load-time clip retargeting, cleanup and measurement.
// Pure functions on three.js objects so they also run under Node for offline checks.
import * as THREE from 'three';

const BONE_PREFIX = /^(?:.*[|])?(?:mixamorig\d*[:_]?)/i;

export function canonicalBoneName(name) {
  return name.replace(BONE_PREFIX, '');
}

// Renames every bone to its canonical name and returns name -> outermost bone.
// FBXLoader nests one duplicate Bone per skin deformer; only the outermost is animated.
export function normalizeSkeletonNames(root) {
  const map = new Map();
  root.traverse((o) => {
    if (!o.isBone) return;
    o.name = canonicalBoneName(o.name);
    if (!map.has(o.name)) map.set(o.name, o);
  });
  return map;
}

// Rebinds every SkinnedMesh under root to a single skeleton built from the outermost bones,
// remapping skinIndex attributes. Removes FBX duplicate bone chains.
export function unifySkeleton(root, boneMap) {
  const names = [...boneMap.keys()];
  const bones = names.map((n) => boneMap.get(n));
  const index = new Map(names.map((n, i) => [n, i]));
  const inverses = new Array(bones.length).fill(null);
  const meshes = [];
  root.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  root.updateMatrixWorld(true);
  for (const mesh of meshes) {
    const sk = mesh.skeleton;
    const remap = new Int32Array(sk.bones.length);
    for (let i = 0; i < sk.bones.length; i++) {
      const n = sk.bones[i].name;
      const target = index.get(n);
      remap[i] = target ?? 0;
      if (target !== undefined && inverses[target] === null) inverses[target] = sk.boneInverses[i].clone();
    }
    const attr = mesh.geometry.attributes.skinIndex;
    if (!mesh.geometry.userData.skinRemapped) {
      for (let i = 0; i < attr.array.length; i++) attr.array[i] = remap[attr.array[i]];
      attr.needsUpdate = true;
      mesh.geometry.userData.skinRemapped = true;
    }
  }
  for (let i = 0; i < bones.length; i++) {
    if (inverses[i] === null) inverses[i] = new THREE.Matrix4().copy(bones[i].matrixWorld).invert();
  }
  const skeleton = new THREE.Skeleton(bones, inverses);
  for (const mesh of meshes) mesh.bind(skeleton, mesh.bindMatrix);
  // Drop the nested duplicate bones now that nothing references them.
  for (const bone of bones) {
    for (let c = bone.children.length - 1; c >= 0; c--) {
      const child = bone.children[c];
      if (child.isBone && child.name === bone.name) {
        for (const g of [...child.children]) bone.add(g);
        bone.remove(child);
      }
    }
  }
  // Nested duplicates can themselves contain duplicates; repeat until stable.
  let removed = true;
  while (removed) {
    removed = false;
    for (const bone of bones) {
      for (let c = bone.children.length - 1; c >= 0; c--) {
        const child = bone.children[c];
        if (child.isBone && child.name === bone.name) {
          for (const g of [...child.children]) bone.add(g);
          bone.remove(child);
          removed = true;
        }
      }
    }
  }
  return skeleton;
}

// Renames tracks to canonical bone names, drops tracks for unknown bones and scales the Hips
// position track into the character's hip-parent units.
export function retargetClip(raw, name, boneMap, hipRatio) {
  const tracks = [];
  const unmatched = [];
  let total = 0;
  for (const t of raw.tracks) {
    const dot = t.name.lastIndexOf('.');
    const node = canonicalBoneName(t.name.slice(0, dot));
    const prop = t.name.slice(dot + 1);
    total++;
    if (!boneMap.has(node)) { unmatched.push(node); continue; }
    // Only the Hips keeps a translation track; other bones keep their own rest lengths.
    if (prop === 'position' && node !== 'Hips') continue;
    if (prop === 'scale') continue;
    const track = t.clone();
    track.name = `${node}.${prop}`;
    if (prop === 'position') {
      const v = track.values;
      for (let i = 0; i < v.length; i++) v[i] *= hipRatio;
    }
    tracks.push(track);
  }
  const clip = new THREE.AnimationClip(name, raw.duration, tracks);
  clip.optimize();
  const bound = total - unmatched.length;
  return { clip, total, bound, unmatched, bindRatio: total ? bound / total : 0 };
}

// Samples a clip on a rig and measures travel, foot contacts, hand speed and damage windows.
// rig: { root, mixer, hips, lFoot, rFoot, hand, tipLocal? }. Units are world metres.
export function analyzeClip(clip, rig, opts = {}) {
  const hz = opts.hz ?? 60;
  const n = Math.max(2, Math.round(clip.duration * hz) + 1);
  const dt = clip.duration / (n - 1);
  const mixer = rig.mixer;
  mixer.stopAllAction();
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const hand = new Float32Array(n * 3), lf = new Float32Array(n * 3), rf = new Float32Array(n * 3), hips = new Float32Array(n * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    action.time = Math.min(i * dt, clip.duration - 1e-4);
    action.enabled = true; action.weight = 1;
    mixer.update(0);
    rig.root.updateMatrixWorld(true);
    rig.hand.getWorldPosition(p); hand[i * 3] = p.x; hand[i * 3 + 1] = p.y; hand[i * 3 + 2] = p.z;
    rig.lFoot.getWorldPosition(p); lf[i * 3] = p.x; lf[i * 3 + 1] = p.y; lf[i * 3 + 2] = p.z;
    rig.rFoot.getWorldPosition(p); rf[i * 3] = p.x; rf[i * 3 + 1] = p.y; rf[i * 3 + 2] = p.z;
    rig.hips.getWorldPosition(p); hips[i * 3] = p.x; hips[i * 3 + 1] = p.y; hips[i * 3 + 2] = p.z;
  }
  action.stop();
  mixer.uncacheAction(clip);

  const last = (n - 1) * 3;
  const midX = (i) => (lf[i * 3] + rf[i * 3]) * 0.5;
  const midZ = (i) => (lf[i * 3 + 2] + rf[i * 3 + 2]) * 0.5;
  const hipsTravel = new THREE.Vector2(hips[last] - hips[0], hips[last + 2] - hips[2]);
  const lTravel = Math.hypot(lf[last] - lf[0], lf[last + 2] - lf[2]);
  const rTravel = Math.hypot(rf[last] - rf[0], rf[last + 2] - rf[2]);
  const footTravel = Math.min(lTravel, rTravel);

  // Hand speed profile and damage windows (speed above 50% of peak).
  const speed = new Float32Array(n);
  let peak = 0, peakI = 0;
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * 3, b = i * 3;
    // Remove body travel so a lunge does not count as a swing.
    const s = Math.hypot(
      (hand[b] - hips[b]) - (hand[a] - hips[a]),
      (hand[b + 1] - hand[a + 1]),
      (hand[b + 2] - hips[b + 2]) - (hand[a + 2] - hips[a + 2])) / dt;
    speed[i] = s;
  }
  // Light smoothing to suppress single-frame spikes.
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = speed[Math.max(0, i - 1)], b = speed[i], c = speed[Math.min(n - 1, i + 1)];
    sm[i] = (a + 2 * b + c) * 0.25;
    if (sm[i] > peak) { peak = sm[i]; peakI = i; }
  }
  const thr = peak * (opts.windowThreshold ?? 0.5);
  const windows = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    const above = sm[i] >= thr;
    if (above && start < 0) start = i;
    if ((!above || i === n - 1) && start >= 0) {
      const end = above ? i : i - 1;
      let lp = 0, lpi = start;
      for (let k = start; k <= end; k++) if (sm[k] > lp) { lp = sm[k]; lpi = k; }
      windows.push({ start: start * dt, end: end * dt, peakT: lpi * dt, peak: lp });
      start = -1;
    }
  }
  // Merge windows separated by tiny gaps, drop slivers.
  const merged = [];
  for (const w of windows) {
    const prev = merged[merged.length - 1];
    if (prev && w.start - prev.end < 0.07) {
      prev.end = w.end;
      if (w.peak > prev.peak) { prev.peak = w.peak; prev.peakT = w.peakT; }
    } else merged.push({ ...w });
  }
  const minWidth = opts.minWindow ?? 0.05;
  const damageWindows = merged.filter((w) => w.end - w.start >= minWidth || w.peak === peak);
  let motionStart = 0;
  for (let i = 0; i < n; i++) if (sm[i] > peak * 0.2) { motionStart = i * dt; break; }

  // Stance frames: a foot within 2.5 cm of its lowest height in the clip. Its horizontal speed
  // in clip space should be ~0 for a slide-free clip (world), and equals travel speed relative to hips.
  let stanceRelSpeed = 0, stanceWorldSpeed = 0, stanceCount = 0;
  const stanceRelDir = new THREE.Vector2();
  let leftLowT = 0, leftLow = Infinity, rightLow = Infinity;
  for (let i = 0; i < n; i++) {
    if (lf[i * 3 + 1] < leftLow) { leftLow = lf[i * 3 + 1]; leftLowT = i * dt; }
    if (rf[i * 3 + 1] < rightLow) rightLow = rf[i * 3 + 1];
  }
  const tol = 0.025;
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * 3, b = i * 3;
    for (const [f, low] of [[lf, leftLow], [rf, rightLow]]) {
      if (f[b + 1] > low + tol || f[a + 1] > low + tol) continue;
      const wx = (f[b] - f[a]) / dt, wz = (f[b + 2] - f[a + 2]) / dt;
      const rx = wx - (hips[b] - hips[a]) / dt, rz = wz - (hips[b + 2] - hips[a + 2]) / dt;
      stanceRelSpeed += Math.hypot(rx, rz);
      stanceRelDir.x += rx; stanceRelDir.y += rz;
      stanceWorldSpeed += Math.hypot(wx, wz);
      stanceCount++;
    }
  }
  stanceRelSpeed /= Math.max(1, stanceCount);
  stanceWorldSpeed /= Math.max(1, stanceCount);

  // Root travel for loops is the linear hips trend; for one-shots the smoothed feet midpoint.
  const loopSpeed = hipsTravel.length() / clip.duration;
  let travelDir = hipsTravel.clone();
  if (travelDir.lengthSq() < 1e-6) travelDir.set(-stanceRelDir.x, -stanceRelDir.y);
  if (travelDir.lengthSq() > 1e-8) travelDir.normalize();
  let rootCurve = null;
  if (!opts.loop && footTravel > (opts.rootMotionMin ?? 0.3)) {
    const raw = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { raw[i * 2] = midX(i) - midX(0); raw[i * 2 + 1] = midZ(i) - midZ(0); }
    const win = Math.max(1, Math.round(0.12 * hz));
    rootCurve = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      let sx = 0, sz = 0, c = 0;
      for (let k = -win; k <= win; k++) {
        const j = Math.min(n - 1, Math.max(0, i + k));
        sx += raw[j * 2]; sz += raw[j * 2 + 1]; c++;
      }
      rootCurve[i * 2] = sx / c; rootCurve[i * 2 + 1] = sz / c;
    }
    // Pin endpoints so the total displacement is exact.
    rootCurve[0] = 0; rootCurve[1] = 0;
    rootCurve[(n - 1) * 2] = raw[(n - 1) * 2]; rootCurve[(n - 1) * 2 + 1] = raw[(n - 1) * 2 + 1];
  }
  const dir = classifyDirection(travelDir);
  // Largest horizontal hips excursion (used to match hit reactions to the hit direction).
  let swayX = 0, swayZ = 0, swayMax = 0;
  for (let i = 0; i < n; i++) {
    const dx = hips[i * 3] - hips[0], dz = hips[i * 3 + 2] - hips[2];
    const d = dx * dx + dz * dz;
    if (d > swayMax) { swayMax = d; swayX = dx; swayZ = dz; }
  }
  // Head-height of the hips across the clip: lowest value (for grounding checks).
  let hipMin = Infinity;
  for (let i = 0; i < n; i++) hipMin = Math.min(hipMin, hips[i * 3 + 1]);
  return {
    sway: [swayX, swayZ], swayDir: classifyDirection(new THREE.Vector2(swayX, swayZ)), hipMin,
    duration: clip.duration, samples: n, dt,
    hipsTravel: hipsTravel.length(), footTravel,
    travelDir: [travelDir.x, travelDir.y], direction: dir,
    loopSpeed, stanceRelSpeed, stanceWorldSpeed,
    handPeak: peak, handPeakT: peakI * dt, damageWindows, motionStart,
    contactPhase: clip.duration > 0 ? leftLowT / clip.duration : 0,
    rootCurve, handSpeed: sm,
    hipY0: hips[1],
  };
}

// Mixamo characters face +Z and their left is +X.
export function classifyDirection(v) {
  if (v.lengthSq() < 1e-8) return 'none';
  const a = Math.atan2(v.x, v.y) * 180 / Math.PI;
  if (a > -45 && a <= 45) return 'forward';
  if (a > 45 && a <= 135) return 'left';
  if (a <= -45 && a > -135) return 'right';
  return 'back';
}

// Removes world travel from the Hips track: linear trend for loops, the extracted root curve
// for one-shot travel clips. The removed part is applied by game code instead.
export function stripRootMotion(clip, meta, unitToLocal, loop) {
  const track = clip.tracks.find((t) => t.name === 'Hips.position');
  if (!track) return;
  const v = track.values, times = track.times, T = clip.duration || 1;
  const x0 = v[0], z0 = v[2];
  const kx = (v[v.length - 3] - x0), kz = (v[v.length - 1] - z0);
  if (loop) {
    for (let i = 0; i < times.length; i++) {
      const f = times[i] / T;
      v[i * 3] -= kx * f;
      v[i * 3 + 2] -= kz * f;
    }
    return;
  }
  if (meta.rootCurve) {
    const rc = meta.rootCurve, n = meta.samples, dt = meta.dt;
    for (let i = 0; i < times.length; i++) {
      const s = Math.min(n - 1.0001, times[i] / dt);
      const a = Math.floor(s), f = s - a;
      const rx = rc[a * 2] * (1 - f) + rc[(a + 1) * 2] * f;
      const rz = rc[a * 2 + 1] * (1 - f) + rc[(a + 1) * 2 + 1] * f;
      v[i * 3] -= rx * unitToLocal;
      v[i * 3 + 2] -= rz * unitToLocal;
    }
  }
}

// Samples the root curve at time t into out (Vector2), in world metres, character space.
export function sampleRootCurve(meta, t, out) {
  const rc = meta.rootCurve;
  if (!rc) return out.set(0, 0);
  const n = meta.samples;
  const s = Math.min(n - 1.0001, Math.max(0, t / meta.dt));
  const a = Math.floor(s), f = s - a;
  out.x = rc[a * 2] * (1 - f) + rc[(a + 1) * 2] * f;
  out.y = rc[a * 2 + 1] * (1 - f) + rc[(a + 1) * 2 + 1] * f;
  return out;
}
