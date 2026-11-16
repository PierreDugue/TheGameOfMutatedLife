import { CELL, HALF, N } from '../config';
import { catmullRom, clamp, lerp, smoothstep, type V2 } from '../core/math';
import { fbm, vnoise } from '../core/noise';
import type { Layout } from './layout';

/** Terrain vertex: position (3), normal (3), material weights grass / dirt / sand / rock (4), mud, water depth. */
export const TERRAIN_STRIDE = 12;

const NV = N + 1;

interface RiverSample { x: number; z: number; tx: number; tz: number; s: number; w: number; level: number }

/**
 * The valley heightfield and everything derived from it: water levels, distance to the shore, flow, materials.
 * Grid vertex (i, k) sits at x = -HALF + i·CELL, z = -HALF + k·CELL.
 */
export class Terrain {
  readonly H = new Float32Array(NV * NV);
  /** Water surface height, NaN where there is no water nearby. */
  readonly WL = new Float32Array(NV * NV);
  /** Signed distance to the shore (negative in the water). */
  readonly D = new Float32Array(NV * NV);
  /** Water flow (m/s), x and z. */
  readonly FX = new Float32Array(NV * NV);
  readonly FZ = new Float32Array(NV * NV);
  readonly river: RiverSample[] = [];
  /** Raw material weights per vertex: grass, dirt, sand, rock outcrop, mud. */
  readonly mat = new Float32Array(NV * NV * 5);

  constructor(readonly layout: Layout, readonly seed: number) {
    this.buildRiver();
    this.buildHeights();
  }

  private buildRiver(): void {
    const L = this.layout, pts = catmullRom(L.river, 0.5);
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const w = 2.1 + 0.7 * vnoise(s * 0.05, 3.3, this.seed + 11);
      this.river.push({ x: pts[i][0], z: pts[i][1], tx: (b[0] - a[0]) / tl, tz: (b[1] - a[1]) / tl, s, w, level: 0 });
    }
    // water level: falls to 0 where the river enters the pond, flat across it, falls again after it leaves
    const inPond = this.river.map((r) => this.pondQ(r.x, r.z) < 1);
    const iIn = inPond.indexOf(true), iOut = inPond.lastIndexOf(true);
    const sIn = this.river[iIn].s, sOut = this.river[iOut].s, sEnd = s;
    for (const r of this.river) {
      r.level = r.s < sIn ? L.riverTop * (1 - r.s / sIn) : r.s > sOut ? L.riverBottom * ((r.s - sOut) / (sEnd - sOut)) : 0;
      // the river widens as it meets the pond
      r.w *= 1 + 0.6 * smoothstep(14, 0, Math.min(Math.abs(r.s - sIn), Math.abs(r.s - sOut)));
    }
  }

  /** Normalised pond radius at (x, z): 0 at the centre, 1 on the (noisy) shore. */
  pondQ(x: number, z: number): number {
    const p = this.layout.pond, dx = x - p.c[0], dz = z - p.c[1];
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;
    const q = Math.hypot(lx / p.rx, lz / p.rz);
    const a = Math.atan2(lz, lx);
    const wob = 1 + 0.13 * vnoise(Math.cos(a) * 2.2 + 5, Math.sin(a) * 2.2 + 5, this.seed + 23) + 0.05 * vnoise(Math.cos(a) * 6, Math.sin(a) * 6, this.seed + 29);
    return q / wob;
  }

  /** Nearest river sample index and the distance to the centre line. */
  private nearestRiver(x: number, z: number): { i: number; d: number } {
    const R = this.river;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < R.length; i += 8) {
      const d = (R[i].x - x) ** 2 + (R[i].z - z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    for (let i = Math.max(0, bi - 10); i < Math.min(R.length, bi + 11); i++) {
      const d = (R[i].x - x) ** 2 + (R[i].z - z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return { i: bi, d: Math.sqrt(bd) };
  }

  private buildHeights(): void {
    const sd = this.seed, P = this.layout.pond, pr = Math.min(P.rx, P.rz);
    for (let k = 0; k < NV; k++) for (let i = 0; i < NV; i++) {
      const x = -HALF + i * CELL, z = -HALF + k * CELL, o = k * NV + i;
      const { i: ri, d: dr } = this.nearestRiver(x, z);
      const R = this.river[ri];
      const q = this.pondQ(x, z);
      const dRiver = dr - R.w, dPond = (q - 1) * pr;
      const dW = Math.min(dRiver, dPond);

      // dry land: rolling ground tilted with the river, hills rising toward the edge (cut open along the river)
      const edge = Math.max(Math.abs(x), Math.abs(z)) * 0.75 + Math.hypot(x, z) * 0.25;
      let land = 0.9 + 0.75 * R.level + 1.5 * fbm(x * 0.022, z * 0.022, sd + 1, 4) + 0.25 * fbm(x * 0.13, z * 0.13, sd + 2, 3);
      const hill = smoothstep(40, 74, edge) * (8 + 9 * (0.5 + 0.5 * fbm(x * 0.03, z * 0.03, sd + 3, 4)));
      land += hill * smoothstep(2, 20, dRiver) + 2.5 * smoothstep(20, 60, dW) * (0.5 + 0.5 * fbm(x * 0.05, z * 0.05, sd + 4, 3));
      // banks: near the water the ground settles just above the waterline
      const wl = dPond < dRiver ? 0 : R.level;
      const bank = wl + 0.22 + 0.06 * Math.max(0, dW) + 0.08 * vnoise(x * 0.4, z * 0.4, sd + 5);
      land = lerp(bank, Math.max(land, bank), smoothstep(0, 16, dW));

      // beds: carve the channel and the pond basin
      let h = land;
      const carve = (u: number, level: number, depth: number): void => {
        if (u > 1.8) return;
        const bed = level + 0.25 - (depth + 0.25) * smoothstep(1.05, 0.35, u) + 0.12 * vnoise(x * 0.5, z * 0.5, sd + 6);
        h = Math.min(h, lerp(bed, land, smoothstep(1.0, 1.8, u)));
      };
      carve(dr / R.w, R.level, 0.85 + 0.25 * vnoise(R.s * 0.08, 1, sd + 7));
      carve(q, 0, 2.3 + 0.4 * vnoise(x * 0.08, z * 0.08, sd + 8));
      this.H[o] = h;
      this.D[o] = dW;
      this.WL[o] = dW < 6 ? wl : NaN;

      // flow: along the river, a slow swirl in the pond
      const core = clamp(1 - (dr / R.w) ** 2, 0, 1);
      const sp = (0.25 + 0.9 * Math.abs(R.level - (this.river[Math.min(this.river.length - 1, ri + 4)].level)) * 4) * core;
      const inP = smoothstep(0.1, -2, dPond);
      const cx = x - P.c[0], cz = z - P.c[1], cl = Math.hypot(cx, cz) || 1;
      this.FX[o] = R.tx * sp * (1 - 0.97 * inP) + (-cz / cl) * 0.012 * inP;
      this.FZ[o] = R.tz * sp * (1 - 0.97 * inP) + (cx / cl) * 0.012 * inP;

      // materials (normalised later with the slope)
      const m = o * 5;
      this.mat[m] = 0.55 + 0.25 * fbm(x * 0.07, z * 0.07, sd + 9, 3); // grass
      this.mat[m + 1] = smoothstep(0.2, 0.55, fbm(x * 0.05, z * 0.05, sd + 10, 4)) + 0.5 * smoothstep(2.5, 1.2, dW) * smoothstep(-0.2, 0.8, dW); // dirt
      this.mat[m + 2] = smoothstep(1.4 + 0.8 * vnoise(x * 0.2, z * 0.2, sd + 12), 0.2, dW); // sand
      this.mat[m + 3] = smoothstep(0.5, 0.75, fbm(x * 0.06, z * 0.06, sd + 13, 3)) * smoothstep(30, 60, edge); // rock outcrops
      this.mat[m + 4] = smoothstep(0.35, 1.0, wl - h) * (0.6 + 0.4 * vnoise(x * 0.3, z * 0.3, sd + 14)); // mud
    }
  }

  private idx(x: number, z: number): { i: number; k: number; fx: number; fz: number } {
    const gx = clamp((x + HALF) / CELL, 0, N - 1e-4), gz = clamp((z + HALF) / CELL, 0, N - 1e-4);
    const i = Math.floor(gx), k = Math.floor(gz);
    return { i, k, fx: gx - i, fz: gz - k };
  }

  /** Bilinear sample of a per-vertex array (allocation-free: it runs millions of times in the simulation). */
  sample(A: Float32Array, x: number, z: number): number {
    let gx = (x + HALF) / CELL, gz = (z + HALF) / CELL;
    gx = gx < 0 ? 0 : gx > N - 1e-4 ? N - 1e-4 : gx;
    gz = gz < 0 ? 0 : gz > N - 1e-4 ? N - 1e-4 : gz;
    const i = gx | 0, k = gz | 0, fx = gx - i, fz = gz - k, o = k * NV + i;
    const a = A[o], b = A[o + 1], c = A[o + NV], d = A[o + NV + 1];
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }

  /** Bilinear sample of raw material weight `c` (0 grass … 4 mud). */
  matAt(x: number, z: number, c: number): number {
    const { i, k, fx, fz } = this.idx(x, z), o = (k * NV + i) * 5 + c;
    const a = this.mat[o], b = this.mat[o + 5], e = this.mat[o + NV * 5], d = this.mat[o + NV * 5 + 5];
    return lerp(lerp(a, b, fx), lerp(e, d, fx), fz);
  }

  groundAt(x: number, z: number): number { return this.sample(this.H, x, z); }
  /** Water surface height at (x, z), or NaN on dry land. */
  waterAt(x: number, z: number): number {
    const w = this.sample(this.WL, x, z);
    return w > this.groundAt(x, z) ? w : NaN;
  }
  shoreDist(x: number, z: number): number { return this.sample(this.D, x, z); }

  normalAt(x: number, z: number): [number, number, number] {
    const e = CELL;
    const nx = this.groundAt(x - e, z) - this.groundAt(x + e, z), nz = this.groundAt(x, z - e) - this.groundAt(x, z + e);
    const l = Math.hypot(nx, 2 * e, nz);
    return [nx / l, (2 * e) / l, nz / l];
  }

  /** Builds the GPU mesh: one vertex per grid point, two triangles per cell. */
  mesh(): { vb: Float32Array<ArrayBuffer>; ib: Uint32Array<ArrayBuffer> } {
    const vb = new Float32Array(NV * NV * TERRAIN_STRIDE);
    for (let k = 0; k < NV; k++) for (let i = 0; i < NV; i++) {
      const o = k * NV + i, v = o * TERRAIN_STRIDE, m = o * 5;
      const x = -HALF + i * CELL, z = -HALF + k * CELL;
      const h = (a: number, b: number): number => this.H[clamp(b, 0, N) * NV + clamp(a, 0, N)];
      const nx = h(i - 1, k) - h(i + 1, k), nz = h(i, k - 1) - h(i, k + 1), ny = 2 * CELL;
      const l = Math.hypot(nx, ny, nz);
      const slope = 1 - ny / l;
      const rock = Math.max(this.mat[m + 3], smoothstep(0.28, 0.5, slope));
      const wl = this.WL[o];
      vb.set([x, this.H[o], z, nx / l, ny / l, nz / l,
        this.mat[m] * (1 - rock), this.mat[m + 1] * (1 - rock * 0.5), this.mat[m + 2] * (1 - rock * 0.7), rock,
        this.mat[m + 4], Number.isNaN(wl) ? -9 : wl - this.H[o]], v);
    }
    const ib = new Uint32Array(N * N * 6);
    let p = 0;
    for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) {
      const a = k * NV + i, b = a + 1, c = a + NV, d = c + 1;
      if ((i + k) & 1) ib.set([a, c, b, b, c, d], p); else ib.set([a, c, d, a, d, b], p);
      p += 6;
    }
    return { vb, ib };
  }
}

export const GRID_NV = NV;
export type { V2 };
