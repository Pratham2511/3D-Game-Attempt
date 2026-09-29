import fs from 'fs';
globalThis.self = globalThis;
globalThis.window = globalThis;
const fakeEl = () => ({ style: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getContext: () => null });
globalThis.document = { createElementNS: fakeEl, createElement: fakeEl };
const THREE = await import('/tmp/ana/node_modules/three/build/three.module.js');
const { FBXLoader } = await import('/tmp/ana/node_modules/three/examples/jsm/loaders/FBXLoader.js');

const root = '/vercel/share/v0-project/assets/';
const mode = process.argv[2];
const files = process.argv.slice(3);
THREE.DefaultLoadingManager.setURLModifier(() => 'data:,');

function load(f) {
  const buf = fs.readFileSync(root + f);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new FBXLoader().parse(ab, root);
}

for (const f of files) {
  const t0 = Date.now();
  let obj;
  try { obj = load(f); } catch (e) { console.log('FAIL', f, e.stack); continue; }
  const bones = [], meshes = [];
  obj.traverse(o => { if (o.isBone) bones.push(o); if (o.isMesh) meshes.push(o); });
  console.log(`== ${f} parse ${Date.now() - t0}ms bones=${bones.length} meshes=${meshes.length} clips=${obj.animations.length} scale=${obj.scale.toArray()}`);
  if (mode === 'model') {
    console.log('bones:', bones.map(b => b.name).join(','));
    for (const m of meshes) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      m.geometry.computeBoundingBox();
      console.log(' mesh', m.name, m.type, 'parent', m.parent?.name, 'verts', m.geometry.attributes.position.count, 'attrs', Object.keys(m.geometry.attributes).join('/'), 'bbox', m.geometry.boundingBox.min.toArray().map(v => v.toFixed(1)), m.geometry.boundingBox.max.toArray().map(v => v.toFixed(1)));
      for (const mt of mats) console.log('   mat', mt.type, mt.name, 'map', mt.map?.name, 'normal', mt.normalMap?.name, 'spec', mt.specularMap?.name, 'emis', mt.emissiveMap?.name, 'shin', mt.shininess, 'color', mt.color?.getHexString(), 'specCol', mt.specular?.getHexString(), 'bump', mt.bumpMap?.name, 'alpha', mt.alphaMap?.name, 'transp', mt.transparent, 'op', mt.opacity);
    }
    obj.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    for (const n of ['Hips', 'Head', 'HeadTop_End', 'LeftFoot', 'RightHand', 'LeftHand', 'RightToeBase', 'LeftToeBase']) {
      const b = bones.find(b => b.name.endsWith(n));
      if (b) console.log(' world', n, b.getWorldPosition(p).toArray().map(v => v.toFixed(2)));
    }
    const box = new THREE.Box3().setFromObject(obj);
    console.log(' box', box.min.toArray().map(v => v.toFixed(1)), box.max.toArray().map(v => v.toFixed(1)));
  }
  for (const c of obj.animations) {
    const hipsPos = c.tracks.find(t => /Hips\.position/.test(t.name));
    let info = '';
    if (hipsPos) {
      const v = hipsPos.values, n = v.length / 3;
      info = `hips0=(${v[0].toFixed(1)},${v[1].toFixed(1)},${v[2].toFixed(1)}) hipsEnd=(${v[3 * n - 3].toFixed(1)},${v[3 * n - 2].toFixed(1)},${v[3 * n - 1].toFixed(1)})`;
    }
    const posTracks = c.tracks.filter(t => t.name.endsWith('.position')).length;
    console.log(`  clip "${c.name}" dur=${c.duration.toFixed(3)} tracks=${c.tracks.length} pos=${posTracks} frames=${hipsPos ? hipsPos.times.length : '?'} ${info}`);
    if (mode === 'tracks') console.log('   ', c.tracks.map(t => t.name).slice(0, 6).join(' | '));
  }
}
