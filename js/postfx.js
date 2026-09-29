// Post-processing chain (HalfFloat + MSAA target): Render -> GTAO -> Bloom -> Output (tone map,
// sRGB) -> Grade (vignette, contrast, warmth) -> SMAA on Low. Quality tiers and dynamic resolution.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { CONFIG } from './config.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    vignette: { value: 0.32 },
    contrast: { value: 1.06 },
    saturation: { value: 1.04 },
    warm: { value: new THREE.Vector3(1.03, 1.0, 0.95) },
    lift: { value: 0.012 },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float vignette; uniform float contrast; uniform float saturation; uniform vec3 warm; uniform float lift;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb * warm;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, saturation);
      col = (col - 0.5) * contrast + 0.5;
      col = col * (1.0 - lift) + lift * vec3(0.9, 0.85, 1.0);
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.85, 0.2, length(d * vec2(1.0, 0.8)) * 1.25);
      col *= mix(1.0 - vignette, 1.0, v);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }`,
};

export function detectTier(renderer) {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
  let tier = 'High';
  if (/swiftshader|llvmpipe|software|basic render|microsoft basic/.test(name)) tier = 'Low';
  else if (/intel|mali|adreno|powervr|uhd|iris/.test(name)) tier = 'Medium';
  else if (/rtx\s?(30|40|50)|rx\s?(6|7|9)\d{3}|radeon pro|apple m[2-9]|m[2-9] (pro|max|ultra)/.test(name)) tier = 'Ultra';
  if (Math.min(window.screen.width, window.screen.height) * (window.devicePixelRatio || 1) > 2200 && tier === 'Ultra') tier = 'High';
  return { tier, gpu: name };
}

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.tierName = 'High';
    this.tier = CONFIG.quality.tiers.High;
    this.renderScale = 1;
    this.width = 1; this.height = 1;
    this.composer = null;
    this.frameTimes = new Float32Array(CONFIG.quality.dynamicResolution.window);
    this.ftIndex = 0;
    this.ftCount = 0;
    this.goodWindows = 0;
    this.dynamic = true;
  }

  build() {
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      for (const p of this.composer.passes) if (p.dispose) p.dispose();
    }
    const t = this.tier;
    const rt = new THREE.WebGLRenderTarget(this.width, this.height, { type: THREE.HalfFloatType, samples: t.msaa || 0 });
    const composer = new EffectComposer(this.renderer, rt);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = null;
    if (t.ao) {
      const g = new GTAOPass(this.scene, this.camera, this.width, this.height);
      g.output = GTAOPass.OUTPUT.Default;
      g.blendIntensity = 0.85;
      g.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.6, thickness: 1.5, scale: 1, samples: t.ao === 'full' ? 16 : 8, distanceFallOff: 1 });
      g.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: t.ao === 'full' ? 6 : 4, rings: 2, samples: t.ao === 'full' ? 16 : 8 });
      composer.addPass(g);
      this.gtao = g;
    }
    this.bloom = null;
    if (t.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 0.22, 0.45, 0.92);
      composer.addPass(this.bloom);
    }
    composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    composer.addPass(this.grade);
    this.smaa = null;
    if (t.smaa) { this.smaa = new SMAAPass(); composer.addPass(this.smaa); }
    this.composer = composer;
    this.applySize();
  }

  setTier(name) {
    this.tierName = name;
    this.tier = CONFIG.quality.tiers[name];
    this.renderScale = 1;
    this.build();
  }

  pixelRatio() {
    return Math.min(2, window.devicePixelRatio || 1, this.tier.pixelRatio) * this.renderScale;
  }

  setSize(w, h) { this.width = w; this.height = h; this.applySize(); }

  applySize() {
    const pr = this.pixelRatio();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.width, this.height, false);
    if (this.composer) {
      this.composer.setPixelRatio(pr);
      this.composer.setSize(this.width, this.height);
    }
  }

  // Dynamic resolution: drop the render scale when frames run over budget, restore at vsync.
  trackFrame(ms) {
    if (!this.dynamic) return;
    const D = CONFIG.quality.dynamicResolution;
    this.frameTimes[this.ftIndex] = ms;
    this.ftIndex = (this.ftIndex + 1) % D.window;
    if (++this.ftCount < D.window) return;
    this.ftCount = 0;
    let sum = 0;
    for (let i = 0; i < D.window; i++) sum += this.frameTimes[i];
    const avg = sum / D.window;
    let next = this.renderScale;
    if (avg > D.overBudgetMs) { next = Math.max(D.min, this.renderScale - D.step); this.goodWindows = 0; }
    else if (avg < D.headroomMs) { if (++this.goodWindows >= 2) { next = Math.min(D.max, this.renderScale + D.step); this.goodWindows = 0; } }
    else this.goodWindows = 0;
    if (Math.abs(next - this.renderScale) > 1e-3) { this.renderScale = next; this.applySize(); }
  }

  render() {
    this.composer.render();
  }
}
