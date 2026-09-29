import fs from 'fs';
globalThis.self = globalThis; globalThis.window = globalThis;
const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const b = fs.readFileSync('assets/hero/Paladin_WProp_J_Nordstrom.glb');
// strip images for node parsing
const jl = b.readUInt32LE(12); const j = JSON.parse(b.subarray(20, 20 + jl));
delete j.images; delete j.textures; for (const m of j.materials) { delete m.normalTexture; delete m.pbrMetallicRoughness.baseColorTexture; delete m.extensions; }
let js = Buffer.from(JSON.stringify(j)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 32)]);
const bin = b.subarray(20 + jl);
const out = Buffer.concat([b.subarray(0, 12), Buffer.from(new Uint32Array([js.length, 0x4e4f534a]).buffer), js, bin]);
out.writeUInt32LE(out.length, 8);
const g = await new GLTFLoader().parseAsync(out.buffer.slice(out.byteOffset, out.byteOffset + out.length), '');
const s = g.scene; s.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(s); console.log('box', box.min.toArray(), box.max.toArray());
s.traverse(o => { if (o.isSkinnedMesh) {
  o.computeBoundingBox();
  const sw = o.geometry.attributes.skinWeight, si = o.geometry.attributes.skinIndex; const cnt = {};
  for (let i = 0; i < si.count; i++) { let best = 0, bi = 0; for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > best) { best = w; bi = si.getComponent(i, k); } } const nm = o.skeleton.bones[bi].name; cnt[nm] = (cnt[nm] || 0) + 1; }
  console.log(o.name, o.geometry.attributes.position.count, 'skel', o.skeleton.bones.length, 'bb', o.boundingBox.min.toArray().map(v=>v.toFixed(2)), o.boundingBox.max.toArray().map(v=>v.toFixed(2)), Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,4));
}});
const sk = []; s.traverse(o => { if (o.isSkinnedMesh) sk.push(o.skeleton); });
console.log('same bones order', sk.every(k => k.bones.every((b, i) => b === sk[0].bones[i])));
