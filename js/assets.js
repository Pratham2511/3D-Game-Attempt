// Preloads every asset behind the loading screen with byte-accurate progress.
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CONFIG } from './config.js';
import { canonicalBoneName } from './clipTools.js';

const EMPTY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export class AssetError extends Error {
  constructor(url, reason) {
    super(`${reason}`);
    this.url = url;
    this.file = decodeURI(url).split('/').pop();
    this.reason = reason;
  }
}

export const missingTextures = [];

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function uniqueClipUrls() {
  const h = CONFIG.heroClips, e = CONFIG.enemyClips;
  const all = [
    h.idle, ...h.idleFidgets, ...h.locomotion, ...h.lightCombo, h.heavy, h.kick, h.blockEnter, h.blockIdle,
    h.blockExit, h.blockImpact, ...h.hits, h.death, h.dodge, h.dodgeInPlace, h.powerUp,
    e.idle, ...e.idleVariants, ...e.locomotion, ...e.attacks, e.gapCloser, e.blockIdle, e.blockReact,
    e.hitLeft, e.hitRight, e.hitGut, e.death, ...e.taunts,
  ];
  return [...new Set(all)].filter((u) => !CONFIG.excludedClips[u]);
}

export function buildManifest() {
  const s = CONFIG.sizeHintsMB;
  const items = [
    { key: 'arena', url: CONFIG.paths.arena, kind: 'gltf', hint: s.arena },
    { key: 'hero', url: CONFIG.paths.heroModel, kind: 'gltf', hint: s.heroModel },
    { key: 'enemy', url: CONFIG.paths.enemyModel, kind: 'fbx', hint: s.enemyModel },
  ];
  for (const url of uniqueClipUrls()) {
    items.push({ key: url, url, kind: 'clip', hint: url === CONFIG.enemyClips.death ? s.enemyDeath : s.clip });
  }
  return items;
}

async function fetchWithProgress(item, onBytes) {
  let res;
  try {
    res = await fetch(encodeURI(item.url));
  } catch (err) {
    throw new AssetError(item.url, `network error (${err.message}). Is the game served over http:// from the project folder?`);
  }
  if (!res.ok) throw new AssetError(item.url, `HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || item.hint * 1048576;
  item.total = total;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onBytes(item, received);
  }
  const buf = new Uint8Array(received);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  if (received < 1024) {
    const head = new TextDecoder().decode(buf.subarray(0, Math.min(received, 200)));
    if (head.startsWith('version https://git-lfs')) {
      throw new AssetError(item.url, 'this is a Git LFS pointer file, not the real asset. Run "git lfs pull" in the project folder.');
    }
  }
  return buf.buffer;
}

// A LoadingManager that can be awaited until every texture it started has finished.
function trackedManager(label, { stubTextures = false } = {}) {
  const m = new THREE.LoadingManager();
  let pending = 0;
  let resolveIdle = null;
  const idle = () => { if (pending === 0 && resolveIdle) { const r = resolveIdle; resolveIdle = null; r(); } };
  const start = m.itemStart.bind(m), end = m.itemEnd.bind(m), err = m.itemError.bind(m);
  m.itemStart = (url) => { pending++; start(url); };
  m.itemEnd = (url) => { pending--; end(url); idle(); };
  m.itemError = (url) => {
    if (!stubTextures) {
      const name = decodeURI(url).split('/').pop();
      missingTextures.push(`${label}: ${name}`);
      console.warn(`[assets] missing texture in ${label}: ${name}`);
    }
    err(url);
  };
  if (stubTextures) m.setURLModifier((url) => (/\.(fbx)$/i.test(url) ? url : EMPTY_PNG));
  m.whenIdle = () => new Promise((r) => { resolveIdle = r; idle(); });
  return m;
}

function dirOf(url) {
  return url.slice(0, url.lastIndexOf('/') + 1);
}

function disposeObject(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        for (const k in mat) if (mat[k] && mat[k].isTexture) mat[k].dispose();
        mat.dispose();
      }
    }
  });
}

async function parseItem(item, buffer) {
  const label = decodeURI(item.url).split('/').pop();
  try {
    if (item.kind === 'gltf') {
      const loader = new GLTFLoader(trackedManager(label));
      return await loader.parseAsync(buffer, dirOf(encodeURI(item.url)));
    }
    if (item.kind === 'fbx') {
      const manager = trackedManager(label);
      const obj = new FBXLoader(manager).parse(buffer, dirOf(encodeURI(item.url)));
      await manager.whenIdle();
      return obj;
    }
    // Animation-only file: keep the clip and the source hip height, drop any mesh.
    const manager = trackedManager(label, { stubTextures: true });
    const obj = new FBXLoader(manager).parse(buffer, dirOf(encodeURI(item.url)));
    await manager.whenIdle();
    const clip = obj.animations[0];
    if (!clip) throw new Error('file contains no animation');
    let hipsRestY = null;
    obj.traverse((o) => {
      if (hipsRestY === null && o.isBone && canonicalBoneName(o.name) === 'Hips') hipsRestY = o.position.y;
    });
    const hadMesh = (() => { let m = false; obj.traverse((o) => { if (o.isMesh) m = true; }); return m; })();
    disposeObject(obj);
    return { clip, hipsRestY, hadMesh };
  } catch (err) {
    if (err instanceof AssetError) throw err;
    throw new AssetError(item.url, `could not be parsed (${err.message})`);
  }
}

// Downloads (4 at a time) then parses sequentially, yielding frames so the page stays responsive.
export async function loadAll(onProgress) {
  const manifest = buildManifest();
  const received = new Map();
  const report = (phase, detail, frac) => onProgress({ phase, detail, fraction: frac });
  const bytesFraction = () => {
    let r = 0, expected = 0;
    for (const v of received.values()) r += v;
    for (const i of manifest) expected += i.total || i.hint * 1048576;
    return Math.min(1, r / expected);
  };
  const onBytes = (item, bytes) => {
    received.set(item.url, bytes);
    report('download', decodeURI(item.url).split('/').pop(), bytesFraction() * 0.8);
  };

  const buffers = new Map();
  let cursor = 0;
  const worker = async () => {
    while (cursor < manifest.length) {
      const item = manifest[cursor++];
      const buf = await fetchWithProgress(item, onBytes);
      buffers.set(item.url, buf);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  const out = { clips: new Map(), stats: { files: manifest.length, bytes: 0 } };
  for (const v of received.values()) out.stats.bytes += v;
  for (let i = 0; i < manifest.length; i++) {
    const item = manifest[i];
    report('parse', decodeURI(item.url).split('/').pop(), 0.8 + (i / manifest.length) * 0.12);
    await nextFrame();
    const result = await parseItem(item, buffers.get(item.url));
    buffers.delete(item.url);
    if (item.kind === 'clip') out.clips.set(item.url, result);
    else out[item.key] = result;
  }
  return out;
}
