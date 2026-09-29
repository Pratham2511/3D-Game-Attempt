import fs from 'fs';
globalThis.self = globalThis; globalThis.window = globalThis;
const fakeEl = () => ({ style: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getContext: () => null });
globalThis.document = { createElementNS: fakeEl, createElement: fakeEl };
const THREE = await import('three');
const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
const T = await import('../js/clipTools.js');
THREE.DefaultLoadingManager.setURLModifier(() => 'data:,');
const root = '/vercel/share/v0-project/assets/';
const load = (f) => { const b = fs.readFileSync(root + f); return new FBXLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), root); };

const who = process.argv[2];
const rigFile = who === 'hero' ? 'hero/sword_and_shield_idle.fbx' : 'enemy/standing_idle.fbx';
const height = who === 'hero' ? 1.8 : 2.07;
const rigObj = load(rigFile);
const map = T.normalizeSkeletonNames(rigObj);
const cmHeight = who === 'hero' ? 178 : 216; // approx model height in cm for this probe only
rigObj.scale.setScalar(height / cmHeight);
const rig = { root: rigObj, mixer: new THREE.AnimationMixer(rigObj), hips: map.get('Hips'), lFoot: map.get('LeftFoot'), rFoot: map.get('RightFoot'), hand: map.get('RightHand') };
const files = fs.readdirSync(root + who).filter((f) => f.endsWith('.fbx') && !/Paladin|Brute|unarmed|crouch|casting|disarm|equip|death_\(2\)/.test(f));
for (const f of files) {
  const o = load(`${who}/${f}`);
  const r = T.retargetClip(o.animations[0], f, map, 1);
  const loop = /idle|walk|run|strafe/.test(f) && !/jump/.test(f);
  const m = T.analyzeClip(r.clip, rig, { loop });
  const w = m.damageWindows.map((w) => `${w.start.toFixed(2)}-${w.end.toFixed(2)}@${w.peakT.toFixed(2)}`).join(' ');
  console.log(`${f.padEnd(44)} dur=${m.duration.toFixed(2)} bind=${r.bound}/${r.total} hipsTr=${m.hipsTravel.toFixed(2)} footTr=${m.footTravel.toFixed(2)} dir=${m.direction.padEnd(7)} [${m.travelDir.map((v) => v.toFixed(2))}] v=${m.loopSpeed.toFixed(2)} stRel=${m.stanceRelSpeed.toFixed(2)} stW=${m.stanceWorldSpeed.toFixed(2)} peak=${m.handPeak.toFixed(1)}@${m.handPeakT.toFixed(2)} mStart=${m.motionStart.toFixed(2)} win=${w} root=${m.rootCurve ? 'Y' : '-'} hipY0=${m.hipY0.toFixed(2)}`);
}
