// Sun, sky, image-based lighting, fog, and the cheap atmosphere effects (dust motes, light shafts).
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CONFIG } from './config.js';

const _v = new THREE.Vector3();
const _target = new THREE.Vector3();

export class Lighting {
  constructor(scene, renderer) {
    const L = CONFIG.lighting;
    this.scene = scene;
    this.renderer = renderer;

    this.sunDir = new THREE.Vector3();
    const phi = THREE.MathUtils.degToRad(90 - L.sunElevation);
    const theta = THREE.MathUtils.degToRad(L.sunAzimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);

    // Sky + environment map. The sky is rendered once into a PMREM so every PBR surface gets IBL.
    this.sky = new Sky();
    this.sky.scale.setScalar(4000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = L.turbidity;
    u.rayleigh.value = L.rayleigh;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    u.sunPosition.value.copy(this.sunDir);
    scene.add(this.sky);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(this.sky);
    this.envTarget = pmrem.fromScene(envScene, 0.02);
    envScene.remove(this.sky);
    scene.add(this.sky);
    scene.environment = this.envTarget.texture;
    scene.environmentIntensity = 1;
    pmrem.dispose();

    // Fog matched to the horizon haze.
    this.fogColor = new THREE.Color(0xc9b8a2);
    scene.fog = new THREE.FogExp2(this.fogColor, L.fogDensity);

    this.sun = new THREE.DirectionalLight(L.sunColor, L.sunIntensity);
    this.sun.position.copy(this.sunDir).multiplyScalar(60);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.near = 5; sc.far = 140;
    this.setShadowExtent(18);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 2;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xb8c8e8, 0x6b5a45, L.hemiIntensity);
    scene.add(this.hemi);

    this.dust = null;
    this.shafts = null;
    this.shadowMapSize = 2048;
  }

  setShadowExtent(half) {
    const sc = this.sun.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.updateProjectionMatrix();
  }

  setShadowMapSize(size) {
    if (this.shadowMapSize === size) return;
    this.shadowMapSize = size;
    this.sun.shadow.mapSize.set(size, size);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
  }

  // The shadow camera follows the hero (snapped to texel-sized steps to avoid shimmering).
  follow(pos) {
    const half = this.sun.shadow.camera.right;
    const texel = (half * 2) / this.shadowMapSize;
    _target.set(Math.round(pos.x / texel) * texel, 0, Math.round(pos.z / texel) * texel);
    this.sun.target.position.copy(_target);
    this.sun.position.copy(this.sunDir).multiplyScalar(60).add(_target);
    this.sun.target.updateMatrixWorld();
    if (this.shafts) this.shafts.position.set(_target.x, 0, _target.z);
  }

  // Floating dust motes drifting in a box around the hero.
  buildDust(count) {
    if (this.dust) { this.scene.remove(this.dust); this.dust.geometry.dispose(); this.dust.material.dispose(); this.dust = null; }
    if (!count) return;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const R = 14;
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() * 2 - 1) * R;
      pos[i * 3 + 1] = Math.random() * 5;
      pos[i * 3 + 2] = (Math.random() * 2 - 1) * R;
      seed[i] = Math.random() * 100;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { time: { value: 0 }, sunDir: { value: this.sunDir }, size: { value: 4.5 }, color: { value: new THREE.Color(0xffe6b8) } },
      vertexShader: `
        uniform float time; uniform float size; attribute float seed; varying float vA;
        void main() {
          vec3 p = position;
          p.x += sin(time * 0.31 + seed) * 0.6;
          p.y += sin(time * 0.17 + seed * 1.3) * 0.4;
          p.z += cos(time * 0.23 + seed * 0.7) * 0.6;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          vA = smoothstep(26.0, 4.0, d) * (0.55 + 0.45 * sin(time * 0.9 + seed * 2.0));
          gl_PointSize = size * (18.0 / max(d, 1.0));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 color; varying float vA;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.2, r) * vA * 0.5;
          gl_FragColor = vec4(color * a, a);
        }`,
    });
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  // A few additive sprites stretched along the sun direction read as light shafts through the ruin.
  buildShafts(enabled) {
    if (this.shafts) {
      this.scene.remove(this.shafts);
      this.shafts.traverse((o) => { if (o.material) o.material.dispose(); if (o.geometry) o.geometry.dispose(); });
      this.shafts = null;
    }
    if (!enabled) return;
    if (!this.shaftTexture) {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 256;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, 'rgba(255,240,210,0)');
      g.addColorStop(0.3, 'rgba(255,240,210,0.6)');
      g.addColorStop(0.8, 'rgba(255,240,210,0.15)');
      g.addColorStop(1, 'rgba(255,240,210,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 256);
      const gx = ctx.createLinearGradient(0, 0, 64, 0);
      gx.addColorStop(0, 'rgba(0,0,0,1)'); gx.addColorStop(0.5, 'rgba(0,0,0,0)'); gx.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = gx;
      ctx.fillRect(0, 0, 64, 256);
      this.shaftTexture = new THREE.CanvasTexture(c);
      this.shaftTexture.colorSpace = THREE.SRGBColorSpace;
    }
    this.shafts = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      map: this.shaftTexture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      opacity: 0.14, side: THREE.DoubleSide, fog: false,
    });
    const geo = new THREE.PlaneGeometry(1.6, 12);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.sunDir);
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(geo, mat);
      const a = (i / 7) * Math.PI * 2 + 0.4;
      const r = 3 + (i % 3) * 2.5;
      m.position.set(Math.cos(a) * r, 5.5, Math.sin(a) * r);
      m.quaternion.copy(q);
      m.rotateY(a);
      m.scale.x = 0.7 + (i % 4) * 0.35;
      this.shafts.add(m);
    }
    this.scene.add(this.shafts);
  }

  update(time, heroPos) {
    if (this.dust) {
      this.dust.material.uniforms.time.value = time;
      _v.set(heroPos.x, 0, heroPos.z);
      this.dust.position.copy(_v);
    }
  }
}
