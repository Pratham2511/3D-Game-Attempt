// Synthesized sound effects (Web Audio, no files). A fixed pool of voice chains
// (filter -> gain -> master) is reused; only the source nodes are created per sound.
import { CONFIG } from './config.js';

export class AudioFX {
  constructor() {
    this.ctx = null;
    this.voices = [];
    this.cursor = 0;
    this.enabled = true;
    this.counts = {};
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = CONFIG.audio.master;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(c.destination);
    const len = c.sampleRate;
    this.noise = c.createBuffer(1, len, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    for (let i = 0; i < CONFIG.audio.maxVoices; i++) {
      const filter = c.createBiquadFilter();
      const gain = c.createGain();
      gain.gain.value = 0;
      filter.connect(gain).connect(this.master);
      this.voices.push({ filter, gain, busyUntil: 0 });
    }
  }

  voice(dur) {
    const now = this.ctx.currentTime;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[(this.cursor + i) % this.voices.length];
      if (v.busyUntil <= now) { this.cursor = (this.cursor + i + 1) % this.voices.length; v.busyUntil = now + dur; return v; }
    }
    const v = this.voices[this.cursor];
    this.cursor = (this.cursor + 1) % this.voices.length;
    v.busyUntil = now + dur;
    return v;
  }

  env(v, t, peak, attack, decay) {
    const g = v.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  noiseSrc(v, t, dur, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = rate;
    s.connect(v.filter);
    s.start(t, Math.random() * 0.5, dur + 0.05);
    return s;
  }

  osc(v, t, type, f0, f1, dur) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    o.connect(v.filter);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  play(name, vol = 1) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    this.counts[name] = (this.counts[name] || 0) + 1;
    const t = this.ctx.currentTime + 0.005;
    const f = (v, type, freq, q) => { v.filter.type = type; v.filter.frequency.setValueAtTime(freq, t); v.filter.Q.setValueAtTime(q, t); };
    switch (name) {
      case 'swing': {
        const v = this.voice(0.3);
        f(v, 'bandpass', 900, 1.2);
        v.filter.frequency.exponentialRampToValueAtTime(2600, t + 0.16);
        this.env(v, t, 0.35 * vol, 0.05, 0.2);
        this.noiseSrc(v, t, 0.28, 0.9);
        break;
      }
      case 'hit': case 'hitHeavy': {
        const heavy = name === 'hitHeavy';
        const v1 = this.voice(0.4);
        f(v1, 'lowpass', heavy ? 420 : 620, 0.8);
        this.env(v1, t, (heavy ? 1.0 : 0.75) * vol, 0.004, heavy ? 0.32 : 0.2);
        this.osc(v1, t, 'sine', heavy ? 140 : 190, 45, 0.3);
        const v2 = this.voice(0.25);
        f(v2, 'bandpass', 1800, 0.9);
        this.env(v2, t, 0.45 * vol, 0.002, 0.12);
        this.noiseSrc(v2, t, 0.15, 1.2);
        break;
      }
      case 'block': case 'parry': {
        const parry = name === 'parry';
        const base = parry ? 1320 : 780;
        for (const [mul, amp] of [[1, 0.28], [2.76, 0.16], [5.4, 0.08]]) {
          const v = this.voice(parry ? 0.9 : 0.5);
          f(v, 'highpass', 300, 0.7);
          this.env(v, t, amp * vol * (parry ? 1.25 : 1), 0.002, parry ? 0.8 : 0.38);
          this.osc(v, t, 'triangle', base * mul, base * mul * 0.985, parry ? 0.85 : 0.42);
        }
        const n = this.voice(0.12);
        f(n, 'highpass', 3000, 0.7);
        this.env(n, t, 0.3 * vol, 0.001, 0.06);
        this.noiseSrc(n, t, 0.08, 1.5);
        break;
      }
      case 'kick': {
        const v = this.voice(0.3);
        f(v, 'lowpass', 300, 1);
        this.env(v, t, 0.8 * vol, 0.003, 0.18);
        this.osc(v, t, 'sine', 110, 40, 0.2);
        break;
      }
      case 'death': {
        const v = this.voice(1.1);
        f(v, 'lowpass', 700, 2);
        v.filter.frequency.exponentialRampToValueAtTime(160, t + 0.9);
        this.env(v, t, 0.35 * vol, 0.03, 0.9);
        this.osc(v, t, 'sawtooth', 150, 60, 0.95);
        break;
      }
      case 'levelStart': {
        [196, 294, 392].forEach((fr, i) => {
          const v = this.voice(1.8);
          f(v, 'lowpass', 1400, 0.6);
          this.env(v, t + i * 0.06, 0.18 * vol, 0.12, 1.5);
          this.osc(v, t + i * 0.06, 'sawtooth', fr, fr * 1.003, 1.7);
        });
        break;
      }
      case 'levelClear': {
        [392, 494, 588, 784].forEach((fr, i) => {
          const v = this.voice(1.4);
          f(v, 'lowpass', 2200, 0.6);
          this.env(v, t + i * 0.09, 0.14 * vol, 0.02, 1.1);
          this.osc(v, t + i * 0.09, 'triangle', fr, fr, 1.2);
        });
        break;
      }
      case 'step': {
        const v = this.voice(0.12);
        f(v, 'lowpass', 520, 0.7);
        this.env(v, t, 0.07 * vol, 0.004, 0.08);
        this.noiseSrc(v, t, 0.1, 0.6);
        break;
      }
      default: break;
    }
  }
}
