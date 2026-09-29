// Post-processes the FBX2glTF output of the hero.
// The hero FBX is FBX 6.1 (FileVersion 6100), which three.js FBXLoader cannot read, so it is
// converted once with FBX2glTF (Autodesk FBX SDK). FBX2glTF drops the embedded specular map,
// so this script copies that PNG out of the original FBX and attaches it to the glTF material
// through KHR_materials_specular. No new art is created; every byte comes from the original FBX.
//
// Usage:
//   FBX2glTF --binary -i assets/hero/Paladin_WProp_J_Nordstrom.fbx -o /tmp/paladin
//   node tools/pack-hero-glb.mjs /tmp/paladin.glb assets/hero/Paladin_WProp_J_Nordstrom.fbx assets/hero/Paladin_WProp_J_Nordstrom.glb
import fs from 'fs';

const [, , glbIn, fbxIn, glbOut] = process.argv;
if (!glbIn || !fbxIn || !glbOut) {
  console.error('usage: node tools/pack-hero-glb.mjs <in.glb> <source.fbx> <out.glb>');
  process.exit(1);
}

const glb = fs.readFileSync(glbIn);
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
const binHeader = 20 + jsonLen;
const binLen = glb.readUInt32LE(binHeader);
let bin = glb.subarray(binHeader + 8, binHeader + 8 + binLen);

const fbx = fs.readFileSync(fbxIn);
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let spec = null;
for (let i = fbx.indexOf(SIG); i >= 0; i = fbx.indexOf(SIG, i + 8)) {
  const end = fbx.indexOf('IEND', i) + 8;
  const context = fbx.subarray(Math.max(0, i - 400), i).toString('latin1');
  if (context.lastIndexOf('Paladin_specular.png') >= 0 && context.lastIndexOf('Paladin_specular.png') > context.lastIndexOf('Paladin_normal.png') && context.lastIndexOf('Paladin_specular.png') > context.lastIndexOf('Paladin_diffuse.png')) {
    spec = fbx.subarray(i, end);
    break;
  }
}
if (!spec) { console.error('specular PNG not found in FBX'); process.exit(1); }

const pad = (n) => (4 - (n % 4)) % 4;
const offset = bin.length + pad(bin.length);
bin = Buffer.concat([bin, Buffer.alloc(pad(bin.length)), spec]);
json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: spec.length });
json.images.push({ name: 'Paladin_specular.png', mimeType: 'image/png', bufferView: json.bufferViews.length - 1 });
json.textures.push({ name: 'specular', sampler: 0, source: json.images.length - 1 });
const texIndex = json.textures.length - 1;
for (const m of json.materials) {
  m.extensions = m.extensions || {};
  m.extensions.KHR_materials_specular = { specularColorTexture: { index: texIndex, texCoord: 0 } };
}
json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), 'KHR_materials_specular'])];
json.buffers[0].byteLength = bin.length + pad(bin.length);
bin = Buffer.concat([bin, Buffer.alloc(pad(bin.length))]);

let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad(jsonBuf.length), 0x20)]);
const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
const out = Buffer.alloc(total);
out.write('glTF', 0, 'latin1');
out.writeUInt32LE(2, 4);
out.writeUInt32LE(total, 8);
out.writeUInt32LE(jsonBuf.length, 12);
out.writeUInt32LE(0x4e4f534a, 16);
jsonBuf.copy(out, 20);
out.writeUInt32LE(bin.length, 20 + jsonBuf.length);
out.writeUInt32LE(0x004e4942, 24 + jsonBuf.length);
bin.copy(out, 28 + jsonBuf.length);
fs.writeFileSync(glbOut, out);
console.log(`wrote ${glbOut} (${(total / 1048576).toFixed(2)} MB), specular ${spec.length} bytes attached`);
