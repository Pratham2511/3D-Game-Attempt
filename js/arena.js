// Arena mesh (unlit photogrammetry -> lit PBR), BVH raycasts, and the walkable height map.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { CONFIG } from './config.js';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

const _ray = new THREE.Raycaster();
_ray.firstHitOnly = true;
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _hits = [];

export class Arena {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'arena';
    this.mesh = null;
    this.material = null;
    this.ground = null;
    this.stats = {};
  }

  // Bakes every submesh (and the arena scale) into one geometry so world space == geometry space.
  build(gltf, renderer) {
    const cfg = CONFIG.arena;
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    const parts = [];
    let sourceMaterial = null;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position' && key !== 'uv' && key !== 'normal') g.deleteAttribute(key);
      }
      g.applyMatrix4(o.matrixWorld);
      if (!g.index) {
        const idx = new Uint32Array(g.attributes.position.count);
        for (let i = 0; i < idx.length; i++) idx[i] = i;
        g.setIndex(new THREE.BufferAttribute(idx, 1));
      }
      parts.push(g);
      if (!sourceMaterial) sourceMaterial = Array.isArray(o.material) ? o.material[0] : o.material;
    });
    if (!parts.length) throw new Error('arena file contains no meshes');
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    merged.scale(cfg.scale, cfg.scale, cfg.scale);
    merged.computeBoundingBox();
    const box = merged.boundingBox;
    const cx = (box.min.x + box.max.x) * 0.5, cz = (box.min.z + box.max.z) * 0.5;
    merged.translate(-cx, 0, -cz);
    if (!merged.attributes.normal) merged.computeVertexNormals();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    merged.boundsTree = new MeshBVH(merged, { targetLeafSize: 8 });

    // KHR_materials_unlit gives MeshBasicMaterial: rebuild as a lit material with the same texture.
    const map = sourceMaterial && sourceMaterial.map ? sourceMaterial.map : null;
    if (map) {
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
      map.generateMipmaps = true;
      map.minFilter = THREE.LinearMipmapLinearFilter;
      map.needsUpdate = true;
    }
    this.material = new THREE.MeshStandardMaterial({
      map, color: 0xffffff, roughness: cfg.baseRoughness, metalness: 0, envMapIntensity: cfg.envMapIntensity,
    });
    this.mesh = new THREE.Mesh(merged, this.material);
    this.mesh.name = 'arena-merged';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = true;
    this.mesh.matrixAutoUpdate = false;
    this.group.add(this.mesh);
    this.stats.triangles = merged.index.count / 3;
    this.stats.footprint = [box.max.x - box.min.x, box.max.z - box.min.z];
    this.bounds = merged.boundingBox;
    return this;
  }

  // Samples a grid by raycasting down. Spread over frames via yieldFn so the loading UI stays alive.
  async buildGround(yieldFn, onProgress) {
    const cfg = CONFIG.arena;
    const size = cfg.gridSize;
    const b = this.bounds;
    const shrink = 0.98;
    const minX = b.min.x * shrink, maxX = b.max.x * shrink, minZ = b.min.z * shrink, maxZ = b.max.z * shrink;
    const heights = new Float32Array(size * size);
    const hit = new Uint8Array(size * size);
    const top = b.max.y + 2;
    const rayLen = b.max.y - b.min.y + 4;
    this.mesh.updateMatrixWorld(true);
    _ray.far = rayLen;
    let hits = 0;
    for (let j = 0; j < size; j++) {
      const z = minZ + (maxZ - minZ) * (j / (size - 1));
      for (let i = 0; i < size; i++) {
        const x = minX + (maxX - minX) * (i / (size - 1));
        _origin.set(x, top, z);
        _ray.set(_origin, _down);
        _hits.length = 0;
        this.mesh.raycast(_ray, _hits);
        const k = j * size + i;
        if (_hits.length) { heights[k] = _hits[0].point.y; hit[k] = 1; hits++; }
      }
      if (j % 8 === 7) {
        if (onProgress) onProgress(j / size);
        if (yieldFn) await yieldFn();
      }
    }
    const ground = new Ground(size, minX, maxX, minZ, maxZ, heights, hit);
    const hitFraction = hits / (size * size);
    if (hitFraction < 0.3) {
      console.warn(`[arena] only ${(hitFraction * 100).toFixed(0)}% of ground rays hit; using a flat plane`);
      ground.flat();
    } else {
      ground.classify(cfg);
    }
    // Put the walkable floor at world y = 0.
    this.mesh.position.y = -ground.floor;
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);
    for (let k = 0; k < heights.length; k++) heights[k] -= ground.floor;
    ground.floor = 0;
    ground.computeSpawnRing();
    this.ground = ground;
    this.stats.hitFraction = hitFraction;
    this.stats.walkableArea = ground.walkableArea;
    this.stats.boundaryRadius = ground.radius;
    console.info(`[arena] ${this.stats.triangles.toLocaleString()} tris, footprint ${this.stats.footprint.map((v) => v.toFixed(1)).join(' x ')} m, ` +
      `ground hits ${(hitFraction * 100).toFixed(0)}%, walkable ${ground.walkableArea.toFixed(0)} m^2, boundary r=${ground.radius.toFixed(1)} m`);
    return ground;
  }

  // First hit along a ray, used for camera collision. Returns distance or -1. No allocations.
  raycastDistance(origin, dir, maxDist) {
    _ray.set(origin, dir);
    _ray.far = maxDist;
    _hits.length = 0;
    this.mesh.raycast(_ray, _hits);
    return _hits.length ? _hits[0].distance : -1;
  }

  dispose() {
    if (this.mesh) {
      this.mesh.geometry.boundsTree = null;
      this.mesh.geometry.dispose();
    }
    if (this.material) {
      if (this.material.map) this.material.map.dispose();
      this.material.dispose();
    }
  }
}

const _n = new THREE.Vector2();

// Height field with bilinear sampling and a walkability mask. No per-call allocations.
export class Ground {
  constructor(size, minX, maxX, minZ, maxZ, heights, hit) {
    this.size = size;
    this.minX = minX; this.maxX = maxX; this.minZ = minZ; this.maxZ = maxZ;
    this.cellX = (maxX - minX) / (size - 1);
    this.cellZ = (maxZ - minZ) / (size - 1);
    this.heights = heights;
    this.hit = hit;
    this.blocked = new Uint8Array(size * size);
    this.floor = 0;
    this.centerX = 0; this.centerZ = 0;
    this.radius = Math.min(maxX - minX, maxZ - minZ) * 0.5 - CONFIG.arena.boundaryMargin;
    this.walkableArea = 0;
    this.spawnRing = [];
  }

  flat() {
    this.heights.fill(0);
    this.hit.fill(1);
    this.floor = 0;
    this.blocked.fill(0);
    const s = this.size;
    for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
      const x = this.minX + i * this.cellX, z = this.minZ + j * this.cellZ;
      if (Math.hypot(x, z) > this.radius) this.blocked[j * s + i] = 1;
    }
    this.walkableArea = Math.PI * this.radius * this.radius;
  }

  classify(cfg) {
    const s = this.size, h = this.heights, hit = this.hit, blocked = this.blocked;
    // Floor level: median height of the hit cells inside the inner half of the grid.
    const inner = [];
    for (let j = s >> 2; j < s - (s >> 2); j++) for (let i = s >> 2; i < s - (s >> 2); i++) {
      const k = j * s + i;
      if (hit[k]) inner.push(h[k]);
    }
    inner.sort((a, b) => a - b);
    this.floor = inner.length ? inner[inner.length >> 1] : 0;
    // Cells without a hit take the floor height but stay blocked.
    for (let k = 0; k < h.length; k++) if (!hit[k]) h[k] = this.floor;
    const wallHeight = 0.7;
    for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
      const k = j * s + i;
      let b = !hit[k] || Math.abs(h[k] - this.floor) > wallHeight;
      if (!b) {
        // Steps: a neighbour higher than stepHeight blocks; gentle slopes stay walkable.
        for (let dj = -1; dj <= 1 && !b; dj++) for (let di = -1; di <= 1 && !b; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= s || jj >= s) { b = true; break; }
          const kk = jj * s + ii;
          const dist = Math.hypot(di * this.cellX, dj * this.cellZ) || 1;
          const dh = Math.abs(h[kk] - h[k]);
          if (dh > cfg.stepHeight || dh / dist > cfg.maxSlope) b = true;
        }
      }
      const x = this.minX + i * this.cellX, z = this.minZ + j * this.cellZ;
      if (Math.hypot(x, z) > this.radius) b = true;
      blocked[k] = b ? 1 : 0;
    }
    // Keep only the region reachable from the centre so isolated pockets are not walkable.
    const ci = Math.round((0 - this.minX) / this.cellX), cj = Math.round((0 - this.minZ) / this.cellZ);
    let start = -1;
    for (let r = 0; r < s && start < 0; r++) {
      for (let dj = -r; dj <= r && start < 0; dj++) for (let di = -r; di <= r; di++) {
        const ii = ci + di, jj = cj + dj;
        if (ii < 0 || jj < 0 || ii >= s || jj >= s) continue;
        if (!blocked[jj * s + ii]) { start = jj * s + ii; break; }
      }
    }
    const reach = new Uint8Array(s * s);
    if (start >= 0) {
      const stack = [start];
      reach[start] = 1;
      while (stack.length) {
        const k = stack.pop();
        const i = k % s, j = (k - i) / s;
        const nb = [k - 1, k + 1, k - s, k + s];
        if (i === 0) nb[0] = -1; if (i === s - 1) nb[1] = -1;
        if (j === 0) nb[2] = -1; if (j === s - 1) nb[3] = -1;
        for (const q of nb) {
          if (q < 0 || reach[q] || blocked[q]) continue;
          reach[q] = 1; stack.push(q);
        }
      }
    }
    let count = 0;
    for (let k = 0; k < s * s; k++) { if (!reach[k]) blocked[k] = 1; else count++; }
    this.walkableArea = count * this.cellX * this.cellZ;
  }

  // Candidate spawn points around the edge of the walkable region, evenly spread in angle.
  computeSpawnRing() {
    const ring = [];
    const n = 24;
    for (let a = 0; a < n; a++) {
      const ang = (a / n) * Math.PI * 2;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      let found = null;
      for (let r = this.radius - 0.5; r > 2.5; r -= 0.4) {
        const x = dx * r, z = dz * r;
        if (this.clearAt(x, z, 1)) { found = { x, z, r, angle: ang }; break; }
      }
      if (found) ring.push(found);
    }
    this.spawnRing = ring;
  }

  clearAt(x, z, cells) {
    const i = Math.round((x - this.minX) / this.cellX), j = Math.round((z - this.minZ) / this.cellZ);
    for (let dj = -cells; dj <= cells; dj++) for (let di = -cells; di <= cells; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= this.size || jj >= this.size) return false;
      if (this.blocked[jj * this.size + ii]) return false;
    }
    return true;
  }

  heightAt(x, z) {
    const fx = THREE.MathUtils.clamp((x - this.minX) / this.cellX, 0, this.size - 1.0001);
    const fz = THREE.MathUtils.clamp((z - this.minZ) / this.cellZ, 0, this.size - 1.0001);
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const h = this.heights, s = this.size;
    const h00 = h[j * s + i], h10 = h[j * s + i + 1], h01 = h[(j + 1) * s + i], h11 = h[(j + 1) * s + i + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  isBlocked(x, z) {
    if (x * x + z * z > this.radius * this.radius) return true;
    const i = Math.round((x - this.minX) / this.cellX), j = Math.round((z - this.minZ) / this.cellZ);
    if (i < 0 || j < 0 || i >= this.size || j >= this.size) return true;
    return this.blocked[j * this.size + i] === 1;
  }

  // Moves pos by (dx, dz) with sliding along blocked cells. Returns true if any movement happened.
  tryMove(pos, dx, dz, radius) {
    if (dx === 0 && dz === 0) return false;
    if (this.canStand(pos.x + dx, pos.z + dz, dx, dz, radius)) { pos.x += dx; pos.z += dz; return true; }
    if (dx !== 0 && this.canStand(pos.x + dx, pos.z, dx, 0, radius)) { pos.x += dx; return true; }
    if (dz !== 0 && this.canStand(pos.x, pos.z + dz, 0, dz, radius)) { pos.z += dz; return true; }
    return false;
  }

  canStand(x, z, dx, dz, radius) {
    if (this.isBlocked(x, z)) return false;
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      _n.set(dx / len, dz / len).multiplyScalar(radius);
      if (this.isBlocked(x + _n.x, z + _n.y)) return false;
    }
    return true;
  }

  // Pushes a point back inside the circular boundary.
  clampToBoundary(pos, margin = 0) {
    const r = this.radius - margin;
    const d = Math.hypot(pos.x, pos.z);
    if (d > r) { pos.x *= r / d; pos.z *= r / d; }
  }
}
