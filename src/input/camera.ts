import { ROAM } from '../config';
import { clamp } from '../core/math';
import type { View } from '../render/uniforms';
import type { Pose } from '../world/layout';
import type { Terrain } from '../world/terrain';

const CLEARANCE = 0.08; // eye height above the ground at the lowest
const FAST = 4;

/** Free-flying camera: smoothed mouse look, eased velocity, kept above the ground; it may dive under water. */
export class FlyCamera implements View {
  x = 0; y = 0; z = 0; yaw = 0; pitch = 0;
  speed = 6;
  enabled = false;
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
}
