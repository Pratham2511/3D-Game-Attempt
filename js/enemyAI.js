// Brute AI: spawn/taunt, approach, circle, engage (attack tokens), telegraph, attack, block,
// hit, stagger and death, with separation steering and arena containment.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Character } from './characters.js';

export class AttackTokens {
  constructor() { this.max = 1; this.holders = new Set(); }
  setMax(n) { this.max = n; }
  tryAcquire(e) {
    if (this.holders.has(e)) return true;
    if (this.holders.size >= this.max) return false;
    this.holders.add(e);
    return true;
  }
  release(e) { this.holders.delete(e); }
  clear() { this.holders.clear(); }
}

const rand = (a, b) => a + Math.random() * (b - a);
const _to = new THREE.Vector3();
const _des = new THREE.Vector3();
const _sep = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class Enemy extends Character {
  constructor(template, lib, index) {
    super(template, lib, 'enemy');
    this.index = index;
    this.active = false;
    this.root.visible = false;
    this.state = 'inactive';
    this.stateTime = 0;
    this.timer = 0;
    this.cooldown = 0;
    this.orbitDir = 1;
    this.orbitFlip = 4;
    this.desiredRadius = 3.6;
    this.cfg = null;
    this.tokens = null;
    this.lastHeroAttack = -1;
    this.knock = new THREE.Vector3();
    this.deathTime = 0;
    this.events = [];
  }

  activate(cfg, x, z, delay, tokens) {
    this.cfg = cfg;
    this.tokens = tokens;
    this.root.position.set(x, 0, z);
    this.yaw = Math.atan2(-x, -z);
    this.vel.set(0, 0, 0);
    this.knock.set(0, 0, 0);
    this.maxHealth = cfg.enemyHealth;
    this.health = cfg.enemyHealth;
    this.dead = false;
    this.attack = null;
    this.blocking = false;
    this.flash = 0; this.glow = 0;
    this.animator.setBlock(false);
    this.animator.stopShots(0.01);
    this.animator.setLocomotion(0, 0);
    this.animator.update(0);
    this.active = true;
    this.state = 'spawnWait';
    this.timer = delay;
    this.stateTime = 0;
    this.cooldown = rand(cfg.attackCooldown[0] * 0.5, cfg.attackCooldown[1] * 0.6);
    this.orbitDir = Math.random() < 0.5 ? -1 : 1;
    this.desiredRadius = rand(CONFIG.enemy.circleRadius[0], CONFIG.enemy.circleRadius[1]);
    this.root.visible = false;
  }

  deactivate() {
    if (this.tokens) this.tokens.release(this);
    this.active = false;
    this.state = 'inactive';
    this.root.visible = false;
    this.attack = null;
    this.animator.stopShots(0.01);
  }

  setState(s) { this.state = s; this.stateTime = 0; }

  appear() {
    this.root.visible = true;
    const roles = this.lib.roles;
    const pool = Math.random() < 0.6 ? roles.taunts : roles.idleVariants;
    const e = pool && pool.length ? pool[(Math.random() * pool.length) | 0] : null;
    if (e) this.animator.play(e, { kind: 'shot', fade: 0.01, fadeOut: 0.3 });
    this.introLen = e ? Math.min(3.2, e.clip.duration - 0.25) : 0.6;
    this.setState('intro');
    this.events.push({ type: 'spawn' });
  }

  releaseToken() { if (this.tokens) this.tokens.release(this); }

  startAttack(hero) {
    const roles = this.lib.roles;
    let list = roles.attacks;
    if (hero.blocking && roles.kicks.length && Math.random() < 0.55) list = roles.kicks;
    const entry = list[(Math.random() * list.length) | 0];
    const shot = this.animator.play(entry, { kind: 'attack', fade: 0.12, fadeOut: 0.25 });
    const kick = entry.isKick;
    this.attack = {
      kind: kick ? 'kick' : 'light', entry, shot, damage: this.cfg.enemyDamage * (kick ? 0.6 : 1),
      hitSet: new Set(), windowIdx: -1, windows: entry.meta.damageWindows, breaksBlock: kick, heavy: false, strikeBone: entry.meta.strikeBone,
    };
    this.glow = 0;
    this.setState('attack');
    this.events.push({ type: 'swing' });
  }

  startGapCloser() {
    const entry = this.lib.roles.gapCloser;
    const shot = this.animator.play(entry, { kind: 'attack', fade: 0.12, fadeOut: 0.25 });
    this.attack = {
      kind: 'light', entry, shot, damage: this.cfg.enemyDamage * 1.2, hitSet: new Set(), windowIdx: -1, windows: entry.meta.damageWindows,
      breaksBlock: false, heavy: true, strikeBone: entry.meta.strikeBone,
    };
    this.setState('attack');
    this.events.push({ type: 'swing' });
  }

  endAttack() {
    this.attack = null;
    this.glow = 0;
    this.releaseToken();
    this.cooldown = rand(this.cfg.attackCooldown[0], this.cfg.attackCooldown[1]);
  }

  takeHit(dmg, attacker, lx, lz, pick) {
    this.health = Math.max(0, this.health - dmg);
    this.hitFlash(1);
    if (this.attack) this.endAttack();
    this.blocking = false;
    this.animator.setBlock(false);
    if (this.health <= 0) { this.die(); return; }
    const e = pick(this.lib.roles.hits, lx, lz);
    this.animator.play(e, { kind: 'hit', fadeOut: 0.22, rate: 1.15 });
    this.timer = Math.min(0.85, (e.clip.duration / 1.15) * 0.7);
    this.cooldown = Math.max(this.cooldown, 0.7);
    this.setState('hit');
  }

  stagger(time) {
    if (this.dead) return;
    if (this.attack) this.endAttack();
    this.blocking = false;
    this.animator.setBlock(false);
    const e = this.lib.roles.hitGut || this.lib.roles.blockReact;
    const rate = Math.max(0.5, Math.min(1.2, e.clip.duration / (time + 0.3)));
    this.animator.play(e, { kind: 'hit', rate, fadeOut: 0.25 });
    this.timer = time;
    this.cooldown = Math.max(this.cooldown, time + 0.4);
    this.setState('stagger');
  }

  blockHit() {
    const e = this.lib.roles.blockReact;
    if (e) this.animator.play(e, { kind: 'block', fade: 0.06, fadeOut: 0.2, rate: 1.4 });
    this.timer = Math.max(this.timer, 0.5);
  }

  die() {
    this.dead = true;
    this.releaseToken();
    this.attack = null;
    this.blocking = false;
    this.glow = 0;
    this.animator.setBlock(false);
    this.animator.setLocomotion(0, 0);
    this.animator.play(this.lib.roles.death, { kind: 'death', hold: true, fade: 0.12 });
    this.setState('dead');
    this.deathTime = 0;
    this.events.push({ type: 'death' });
  }

  update(dt, ctx) {
    if (!this.active) return;
    const E = CONFIG.enemy;
    const hero = ctx.hero;
    this.stateTime += dt;
    if (this.state === 'spawnWait') {
      this.timer -= dt;
      if (this.timer <= 0) this.appear();
      else return;
    }
    _to.subVectors(hero.position, this.position); _to.y = 0;
    const dist = _to.length();
    if (dist > 1e-4) _to.divideScalar(dist);
    this.cooldown -= dt;
    _des.set(0, 0, 0);
    let face = 'hero';
    const heroGone = hero.dead;

    // Reactive block: once per hero swing, if close, in front and the dice agree.
    if (hero.attack && hero.attack.startedAt !== this.lastHeroAttack && !this.dead) {
      this.lastHeroAttack = hero.attack.startedAt;
      const canBlock = this.state === 'circle' || this.state === 'approach' || this.state === 'engage';
      this.forward(_tmp);
      if (canBlock && dist < 3.2 && _tmp.dot(_to) > 0.5 && hero.attack.kind !== 'kick' && Math.random() < this.cfg.blockChance) {
        this.blocking = true;
        this.animator.setBlock(true);
        this.timer = rand(0.7, 1.2);
        this.setState('block');
      }
    }

    switch (this.state) {
      case 'intro':
        if (this.stateTime >= this.introLen) this.setState(heroGone ? 'idle' : 'approach');
        break;
      case 'idle':
        if (!heroGone) this.setState('approach');
        face = 'none';
        break;
      case 'approach': {
        if (heroGone) { this.setState('idle'); break; }
        if (dist <= E.circleRadius[1] + 0.4) { this.setState('circle'); break; }
        const run = dist > 6;
        _des.copy(_to).multiplyScalar(run ? E.runSpeed : E.walkSpeed);
        face = run ? 'move' : 'hero';
        if (this.cooldown <= 0 && this.cfg.gapCloserChance > 0 && dist > E.gapCloserRange[0] && dist < E.gapCloserRange[1] &&
          this.lib.roles.gapCloser && Math.random() < this.cfg.gapCloserChance * dt * 2 && this.tokens.tryAcquire(this)) {
          this.yaw = this.yawTo(hero.position);
          this.startGapCloser();
        }
        break;
      }
      case 'circle': {
        if (heroGone) { this.setState('idle'); break; }
        if (dist > E.circleRadius[1] + 2) { this.setState('approach'); break; }
        this.orbitFlip -= dt;
        if (this.orbitFlip <= 0) { this.orbitFlip = rand(2.5, 6); if (Math.random() < 0.5) this.orbitDir *= -1; }
        _des.set(-_to.z, 0, _to.x).multiplyScalar(this.orbitDir * E.circleSpeed);
        _des.addScaledVector(_to, THREE.MathUtils.clamp((dist - this.desiredRadius) * 1.2, -E.walkSpeed, E.walkSpeed));
        if (this.cooldown <= 0 && this.tokens.tryAcquire(this)) this.setState('engage');
        break;
      }
      case 'engage':
        if (heroGone) { this.releaseToken(); this.setState('idle'); break; }
        if (dist <= E.attackRange) { this.setState('telegraph'); break; }
        _des.copy(_to).multiplyScalar(dist > 4.5 ? E.runSpeed : E.walkSpeed * 1.3);
        if (this.stateTime > 4) { this.releaseToken(); this.cooldown = 1; this.setState('circle'); }
        break;
      case 'telegraph':
        this.glow = Math.min(0.35, this.stateTime / E.telegraph * 0.35);
        if (this.stateTime >= E.telegraph) {
          this.yaw = this.yawTo(hero.position);
          this.startAttack(hero);
        }
        break;
      case 'attack':
        face = 'none';
        if (this.attack && (this.attack.shot.ended || this.attack.shot.fadingOut)) { this.endAttack(); this.setState('circle'); }
        else if (this.attack && this.attack.shot.action.time < (this.attack.windows[0]?.start ?? 0)) {
          this.turnToward(this.yawTo(hero.position), E.turnRate * 0.6, dt);
        }
        break;
      case 'block':
        this.timer -= dt;
        if (this.timer <= 0) { this.blocking = false; this.animator.setBlock(false); this.setState('circle'); }
        break;
      case 'hit':
      case 'stagger':
        face = 'none';
        this.timer -= dt;
        if (this.timer <= 0) this.setState(heroGone ? 'idle' : 'circle');
        break;
      case 'dead':
        face = 'none';
        this.deathTime += dt;
        break;
      default: break;
    }

    // Separation from other brutes and the hero.
    if (!this.dead && this.state !== 'attack') {
      _sep.set(0, 0, 0);
      for (const o of ctx.enemies) {
        if (o === this || !o.active || o.dead || o.state === 'spawnWait') continue;
        _tmp.subVectors(this.position, o.position); _tmp.y = 0;
        const d = _tmp.length();
        if (d < E.separation && d > 1e-4) _sep.addScaledVector(_tmp, ((E.separation - d) / E.separation) * 2.4 / d);
      }
      if (dist < 1.3 && dist > 1e-4) _sep.addScaledVector(_to, -(1.3 - dist) * 3);
      _des.add(_sep);
    }
    const stopped = this.state === 'telegraph' || this.state === 'attack' || this.state === 'hit' || this.state === 'stagger' ||
      this.state === 'dead' || this.state === 'intro' || this.state === 'idle';
    if (stopped) _des.multiplyScalar(this.state === 'dead' || this.state === 'attack' ? 0 : 0.25);
    if (this.state === 'block') _des.multiplyScalar(0.3);
    const maxSpeed = E.runSpeed;
    if (_des.lengthSq() > maxSpeed * maxSpeed) _des.setLength(maxSpeed);
    const k = 1 - Math.exp(-E.accel * dt);
    this.vel.lerp(_des, k);

    if (face === 'hero' && !heroGone) this.turnToward(this.yawTo(hero.position), E.turnRate, dt);
    else if (face === 'move' && this.vel.lengthSq() > 0.1) this.turnToward(Math.atan2(this.vel.x, this.vel.z), E.turnRate, dt);

    if (this.vel.lengthSq() > 1e-6) ctx.ground.tryMove(this.root.position, this.vel.x * dt, this.vel.z * dt, this.radius);
    if (this.knock.lengthSq() > 1e-5) {
      ctx.ground.tryMove(this.root.position, this.knock.x * dt, this.knock.z * dt, this.radius);
      this.knock.multiplyScalar(Math.exp(-12 * dt));
    }
    this.feedLocomotion(this.dead ? 0 : this.vel.x, this.dead ? 0 : this.vel.z);
    const rd = this.animator.update(dt);
    if (this.state === 'attack' || this.state === 'hit' || this.state === 'stagger' || this.state === 'dead') this.applyRootDelta(rd, ctx.ground);
    ctx.ground.clampToBoundary(this.root.position, this.radius);
  }
}
