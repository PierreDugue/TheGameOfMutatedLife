import { HALF } from '../config';
import type { Light } from '../world/sky';

// Global uniform block (struct G in shaders/common.ts).
export const UB_FLOATS = 96;
export const TAN_HALF_FOV = 0.62;
export const NEAR = 0.05;
/** World box the shadow map is fitted around (y range). */
const YLO = -4, YHI = 30;

type V = [number, number, number];

export interface View { x: number; y: number; z: number; yaw: number; pitch: number }

export interface Frame {
  view: View; time: number; light: Light;
  lowW: number; lowH: number; canvasW: number; canvasH: number;
  underwater: boolean; pixel: boolean; levels: number; fog: number;
  /** Season blend weights: spring, summer, fall, winter. */
  season: [number, number, number, number];
}

/** Orthographic projection along the light fitted around the world box; depth 0 nearest the light. */
export function shadowMatrix(dir: V): Float32Array<ArrayBuffer> {
  const f = dir.map((c) => -c);
  let r = [f[2], 0, -f[0]];
  const rl = Math.hypot(r[0], r[2]) || 1; r = r.map((c) => c / rl);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const x of [-HALF, HALF]) for (const y of [YLO, YHI]) for (const z of [-HALF, HALF]) {
    const p = [x, y, z], v = [dot(p, r), dot(p, u), dot(p, f)];
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], v[i]); hi[i] = Math.max(hi[i], v[i]); }
  }
  const m = new Float32Array(16), axes = [r, u, f];
  for (let i = 0; i < 2; i++) {
    const h = (hi[i] - lo[i]) / 2, c = (hi[i] + lo[i]) / 2;
    m[i] = axes[i][0] / h; m[4 + i] = axes[i][1] / h; m[8 + i] = axes[i][2] / h; m[12 + i] = -c / h;
  }
  const zr = hi[2] - lo[2] + 2;
  m[2] = f[0] / zr; m[6] = f[1] / zr; m[10] = f[2] / zr; m[14] = -(lo[2] - 1) / zr;
  m[15] = 1;
  return m;
}

/** Writes the view-projection (reverse-Z, infinite far plane: depth = NEAR / view distance) and the rest of G. */
export function writeGlobals(m: Float32Array, F: Frame, shadowM: Float32Array): void {
  const { x: cx, y: cy, z: cz, yaw, pitch } = F.view, L = F.light;
  const cp = Math.cos(pitch), fy = Math.sin(pitch), rx = Math.cos(yaw), rz = Math.sin(yaw);
  const fx = cp * rz, fz = -cp * rx;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const asp = F.lowW / F.lowH, sx = 1 / (TAN_HALF_FOV * asp), sy = 1 / TAN_HALF_FOV;
  m[0] = rx * sx; m[4] = 0; m[8] = rz * sx; m[12] = -(rx * cx + rz * cz) * sx;
  m[1] = ux * sy; m[5] = uy * sy; m[9] = uz * sy; m[13] = -(ux * cx + uy * cy + uz * cz) * sy;
  m[2] = 0; m[6] = 0; m[10] = 0; m[14] = NEAR;
  m[3] = fx; m[7] = fy; m[11] = fz; m[15] = -(fx * cx + fy * cy + fz * cz);
  m.set([cx, cy, cz, F.time], 16);
  m.set([...L.dir, L.sky], 20);
  m.set([...L.rgb, L.night], 24);
  m.set([...L.ambSky, L.exposure], 28);
  m.set([...L.ambGround, F.fog], 32);
  m.set([...L.zenith, F.underwater ? 1 : 0], 36);
  m.set([...L.horizon, F.levels], 40);
  m.set([...L.glow, F.pixel ? 1 : 0], 44);
  m.set(shadowM, 48);
  m.set([rx, 0, rz, TAN_HALF_FOV * asp], 64);
  m.set([ux, uy, uz, TAN_HALF_FOV], 68);
  m.set([fx, fy, fz, NEAR], 72);
  m.set([F.lowW, F.lowH, F.canvasW, F.canvasH], 76);
  m.set(F.season, 80);
}
