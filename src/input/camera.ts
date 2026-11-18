import { ROAM } from '../config';
import { clamp } from '../core/math';
import type { View } from '../render/uniforms';
import type { Pose } from '../world/layout';
import type { Terrain } from '../world/terrain';

const CLEARANCE = 0.08; // eye height above the ground at the lowest
const FAST = 4;
// walking: eye height, pace (m/s), running multiplier, gravity, jump take-off speed, highest step taken without falling
const EYE = 1.6, WALK = 1.6, RUN = 2.6, GRAVITY = 9.8, JUMP = 3.6, STEP = 0.35;
/** Swimming: the eye floats this far above the water surface, and moves at this share of the walking pace. */
const SWIM_EYE = 0.25, SWIM = 0.5;

/**
 * First-person camera with two ways of moving: free flight (smoothed mouse look, eased velocity, kept above the
 * ground, may dive under water) and walking (on the ground at eye height, with gravity, jumping and swimming).
 */
export class FlyCamera implements View {
  x = 0; y = 0; z = 0; yaw = 0; pitch = 0;
  speed = 6;
  enabled = false;
  /** Walking on the ground instead of flying. */
  walking = false;
  private grounded = false;
  /** Orbit target while following an organism (null = free flight). Returning null ends the follow. */
  follow: (() => [number, number, number] | null) | null = null;
  /** Orbit distance in follow mode (m). */
  dist = 0.35;
  private fx = 0; private fy = 0; private fz = 0;
  private vx = 0; private vy = 0; private vz = 0;
  private keys = new Set<string>();
  private lookX = 0; private lookY = 0;

  constructor(private readonly T: Terrain, canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => { if (this.enabled) this.keys.add(e.code); });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.lookX += e.movementX * 0.0022;
      this.lookY += e.movementY * 0.0022;
    });
    addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      if (this.follow) this.dist = clamp(this.dist * Math.exp(e.deltaY * 0.0015), 0.06, 15);
      else this.speed = clamp(this.speed * Math.exp(-e.deltaY * 0.001), 0.1, 40);
    }, { passive: true });
  }

  /** Unit view direction. */
  forward(): [number, number, number] {
    const cp = Math.cos(this.pitch);
    return [cp * Math.sin(this.yaw), Math.sin(this.pitch), -cp * Math.cos(this.yaw)];
  }

  /** Starts orbiting whatever `target` returns, from the current viewing direction. */
  startFollow(target: () => [number, number, number] | null): void {
    const t = target();
    if (!t) return;
    this.follow = target;
    [this.fx, this.fy, this.fz] = t;
    this.dist = clamp(Math.hypot(t[0] - this.x, t[1] - this.y, t[2] - this.z), 0.15, 0.6);
  }

  release(): void { this.keys.clear(); this.lookX = this.lookY = 0; }

  pose(p: Pose): void {
    this.x = p[0]; this.z = p[2]; this.y = this.T.groundAt(p[0], p[2]) + p[1];
    const dx = p[3] - this.x, dy = p[4] - this.y, dz = p[5] - this.z;
    this.yaw = Math.atan2(dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    this.vx = this.vy = this.vz = 0;
  }

  /** Switches between walking and flying; walking starts with a fall to the ground from wherever the camera is. */
  setWalking(on: boolean): void {
    this.walking = on;
    this.grounded = false;
    this.vy = 0;
  }

  /** Is the eye below the water surface? */
  underwater(): boolean {
    const w = this.T.waterAt(this.x, this.z);
    return !Number.isNaN(w) && this.y < w;
  }

  update(dt: number): void {
    const kq = 1 - Math.exp(-dt * 25);
    const dyaw = this.lookX * kq, dpitch = this.lookY * kq;
    this.lookX -= dyaw; this.lookY -= dpitch;
    this.yaw += dyaw;
    this.pitch = clamp(this.pitch - dpitch, -1.55, 1.55);

    const k = this.keys, on = (c: string): number => (k.has(c) ? 1 : 0);
    if (this.follow && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ'].some((c) => k.has(c))) this.follow = null;
    const t = this.follow?.() ?? null;
    if (this.follow && !t) this.follow = null;
    if (t) {
      // orbit: ease toward the target, stay `dist` behind it along the view direction
      const ke = 1 - Math.exp(-dt * 8);
      this.fx += (t[0] - this.fx) * ke; this.fy += (t[1] - this.fy) * ke; this.fz += (t[2] - this.fz) * ke;
      const f = this.forward();
      this.x = this.fx - f[0] * this.dist; this.y = this.fy - f[1] * this.dist; this.z = this.fz - f[2] * this.dist;
      this.y = Math.max(this.y, this.T.groundAt(this.x, this.z) + 0.03);
      this.vx = this.vy = this.vz = 0;
      return;
    }
    const mf = on('KeyW') - on('KeyS'), mr = on('KeyD') - on('KeyA'), mu = on('KeyE') - on('KeyQ');
    if (this.walking) { this.walk(dt, mf, mr, k.has('ShiftLeft') || k.has('ShiftRight'), k.has('KeyE')); return; }
    let sp = (k.has('ShiftLeft') || k.has('ShiftRight') ? FAST : 1) * this.speed;
    if (this.underwater()) sp *= 0.4;
    const cp = Math.cos(this.pitch), sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const ke = 1 - Math.exp(-dt * 5);
    this.vx += ((sy * cp * mf + cy * mr) * sp - this.vx) * ke;
    this.vy += ((Math.sin(this.pitch) * mf + mu) * sp - this.vy) * ke;
    this.vz += ((-cy * cp * mf + sy * mr) * sp - this.vz) * ke;
    this.x = clamp(this.x + this.vx * dt, -ROAM, ROAM);
    this.z = clamp(this.z + this.vz * dt, -ROAM, ROAM);
    this.y = Math.min(this.y + this.vy * dt, 60);
    const floor = this.T.groundAt(this.x, this.z) + CLEARANCE;
    if (this.y < floor) { this.y = floor; this.vy = Math.max(this.vy, 0); }
  }

  /** Walking: moves along the ground in the looking direction (pitch ignored), falls, jumps and swims at the surface. */
  private walk(dt: number, mf: number, mr: number, run: boolean, jump: boolean): void {
    const ground = this.T.groundAt(this.x, this.z), w = this.T.waterAt(this.x, this.z);
    const water = Number.isNaN(w) ? -Infinity : w;
    const swimming = water > ground + EYE - SWIM_EYE; // too deep to stand: float with the head out
    const n = Math.hypot(mf, mr) || 1;
    let sp = (run ? RUN : 1) * WALK * (swimming ? SWIM : water > ground ? 0.7 : 1);
    sp /= n;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const ke = 1 - Math.exp(-dt * (this.grounded || swimming ? 10 : 1.5)); // little control in the air
    this.vx += ((sy * mf + cy * mr) * sp - this.vx) * ke;
    this.vz += ((-cy * mf + sy * mr) * sp - this.vz) * ke;
    this.x = clamp(this.x + this.vx * dt, -ROAM, ROAM);
    this.z = clamp(this.z + this.vz * dt, -ROAM, ROAM);

    const g = this.T.groundAt(this.x, this.z), wn = this.T.waterAt(this.x, this.z);
    const stand = g + EYE, float = Number.isNaN(wn) ? -Infinity : wn + SWIM_EYE, rest = Math.max(stand, float);
    if (this.grounded && jump && rest === stand) { this.vy = JUMP; this.grounded = false; }
    if (this.grounded && this.vy <= 0 && this.y - rest < STEP) {
      // on the ground: follow it up steps and down slopes without bouncing
      this.y = rest; this.vy = 0;
    } else {
      this.vy -= GRAVITY * dt;
      if (this.y < float) this.vy = Math.max(this.vy, -1) + (float - this.y) * 6 * dt; // buoyancy in deep water
      this.y = Math.min(this.y + this.vy * dt, 60);
      if (this.y <= rest) { this.y = rest; this.vy = 0; this.grounded = true; }
      else this.grounded = false;
    }
  }
}
