import fs from 'fs';
globalThis.self = globalThis; globalThis.window = globalThis;
const fakeEl = () => ({ style: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getContext: () => null });
globalThis.document = { createElementNS: fakeEl, createElement: fakeEl };
const THREE = await import('/tmp/ana/node_modules/three/build/three.module.js');
const { FBXLoader } = await import('/tmp/ana/node_modules/three/examples/jsm/loaders/FBXLoader.js');
THREE.DefaultLoadingManager.setURLModifier(() => 'data:,');
const root = '/vercel/share/v0-project/assets/';
const q = new THREE.Quaternion();
for (const f of process.argv.slice(2)) {
  const buf = fs.readFileSync(root + f);
  const o = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), root);
  o.updateMatrixWorld(true);
  const hips = o.getObjectByName('mixamorigHips');
  const p = new THREE.Vector3(); hips.getWorldPosition(p);
  const names = ['mixamorigHips','mixamorigSpine','mixamorigLeftArm','mixamorigLeftUpLeg','mixamorigRightHand','mixamorigLeftFoot'];
  console.log(f, 'hipsRestWorld', p.toArray().map(v=>v.toFixed(1)).join(','), 'rootChildren', o.children.map(c=>c.name+':'+c.type).join(' '));
  for (const n of names) { const b = o.getObjectByName(n); if (b) console.log('   ', n, 'pos', b.position.toArray().map(v=>v.toFixed(2)).join(','), 'quat', b.quaternion.toArray().map(v=>v.toFixed(3)).join(',')); }
  const c = o.animations[0];
  if (c) { const t = c.tracks.find(t=>t.name==='mixamorigLeftArm.quaternion'); console.log('    clip LeftArm q0', Array.from(t.values.slice(0,4)).map(v=>v.toFixed(3)).join(',')); }
}
