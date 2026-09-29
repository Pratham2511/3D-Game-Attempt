// Third-person orbit camera: mouse yaw/pitch, wheel zoom, smoothed follow, arena and ground collision, shake.
import * as THREE from 'three';
import { CONFIG } from './config.js';

const _pivot = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _right = new THREE.Vector3();
const _shake = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _look = new THREE.Vector3();

export class ThirdPersonCamera {
  constructor(camera, arena) {
    const C = CONFIG.camera;
    this.camera = camera;
    this.arena = arena;
    this.yaw = Math.PI;
    this.pitch = THREE.MathUtils.degToRad(14);
    this.distance = C.distance;
    this.targetDistance = C.distance;
    this.pivotSmoothed = new THREE.Vector3();
    this.position = new THREE.Vector3();
    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.lockTarget = null;
    this.initialized = false;
  }

  // Yaw applied to move input: camera-relative forward on the ground plane.
  forward(out) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  right(out) {
    return out.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }

  addShake(amount) {
    this.shakeAmp = Math.min(1, this.shakeAmp + amount);
  }

  snapBehind(hero) {
    this.yaw = hero.yaw + Math.PI;
    this.pitch = THREE.MathUtils.degToRad(14);
    this.initialized = false;
  }

  update(dt, input, hero, lockTarget) {
    const C = CONFIG.camera;
    if (input) {
      this.yaw -= input.lookDX * C.sensitivity;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch + input.lookDY * C.sensitivity,
        THREE.MathUtils.degToRad(C.pitchMin), THREE.MathUtils.degToRad(C.pitchMax));
      if (input.wheel) this.targetDistance = THREE.MathUtils.clamp(this.targetDistance + input.wheel * 0.5, C.minDistance, C.maxDistance);
    }
    // Soft lock-on assist: ease the yaw toward the target while the player is not turning.
    if (lockTarget && input && Math.abs(input.lookDX) < 1) {
      _look.subVectors(lockTarget.position, hero.position);
      const want = Math.atan2(-_look.x, -_look.z);
      let d = want - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * C.lockOnAssist * 0.6);
    }

    _pivot.set(hero.position.x, hero.position.y + C.pivotHeight, hero.position.z);
    const k = this.initialized ? 1 - Math.exp(-C.followRate * dt) : 1;
    this.pivotSmoothed.lerp(_pivot, k);
    this.right(_right);
    this.pivotSmoothed.addScaledVector(_right, 0); // pivot stays centred; shoulder offset is applied to the eye
    this.distance += (this.targetDistance - this.distance) * (this.initialized ? 1 - Math.exp(-C.zoomRate * dt) : 1);

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    _dir.set(Math.sin(this.yaw) * cp, sp, Math.cos(this.yaw) * cp); // from pivot toward camera
    _desired.copy(this.pivotSmoothed).addScaledVector(_dir, this.distance).addScaledVector(_right, C.shoulderOffset);

    // Collision: pull the camera in front of any wall between the pivot and the desired position.
    _offset.subVectors(_desired, this.pivotSmoothed);
    const len = _offset.length();
    if (len > 1e-4 && this.arena && this.arena.mesh) {
      _offset.divideScalar(len);
      const hit = this.arena.raycastDistance(this.pivotSmoothed, _offset, len + C.collisionPadding);
      if (hit >= 0) {
        const d = Math.max(C.minDistance * 0.5, hit - C.collisionPadding);
        _desired.copy(this.pivotSmoothed).addScaledVector(_offset, d);
      }
    }
    if (this.arena && this.arena.ground) {
      const g = this.arena.ground.heightAt(_desired.x, _desired.z) + C.minHeightAboveGround;
      if (_desired.y < g) _desired.y = g;
    }
    // Never inside the hero.
    _offset.subVectors(_desired, _pivot);
    if (_offset.length() < CONFIG.hero.radius + 0.4) {
      _offset.setLength(CONFIG.hero.radius + 0.4);
      _desired.copy(_pivot).add(_offset);
    }

    this.position.copy(_desired);
    if (this.shakeAmp > 0.001) {
      this.shakeTime += dt * 38;
      const a = this.shakeAmp * 0.12;
      _shake.set(Math.sin(this.shakeTime * 1.1) * a, Math.cos(this.shakeTime * 0.9) * a, 0);
      this.position.add(_shake);
      this.shakeAmp *= Math.exp(-dt * 9);
    } else this.shakeAmp = 0;

    this.camera.position.copy(this.position);
    _fwd.copy(this.pivotSmoothed);
    _fwd.y += (this.distance - C.minDistance) * 0.02;
    this.camera.lookAt(_fwd);
    this.initialized = true;
  }
}
