import { CELL, HALF, N as GRID } from '../config';

const GNV = GRID + 1;
import { clamp } from '../core/math';
import type { Rng } from '../core/rng';
import type { Terrain } from '../world/terrain';

/** Nutrient / algae grid resolution (metres per cell). */
const GS = 1;
const NG = Math.round((2 * HALF) / GS);
/** Hash buckets for food particles (metres per bucket). */
export const BUCKET = 0.5;
const NB = Math.round((2 * HALF) / BUCKET);

export const MAX_PARTICLES = 6000;
/** Energy a cell gains from eating one particle. */
export const PARTICLE_ENERGY = 2.4;

/**
 * The water as a habitat: dissolved nutrients on a 1 m grid (diffused and carried by the flow, fed by the river and
 * by decay), algae on the bed that grows in light and sheds drifting organic particles, and those particles.
 */
export class Environment {
  /** Nutrients per water column. */
  readonly N = new Float32Array(NG * NG);
  /** Algae biomass on the bed, 0..1. */
  readonly A = new Float32Array(NG * NG);
  /** Water column depth at the grid cell centre (0 = dry). */
  private readonly depth = new Float32Array(NG * NG);
  private readonly wl = new Float32Array(NG * NG);
  private readonly water: number[] = [];
  /** Per water cell: flow (static) and the share of surface light reaching the bed. */
  private cfx = new Float32Array(0);
  private cfz = new Float32Array(0);
  private bedLight = new Float32Array(0);
  private readonly inflow: number[] = [];
  private tmp = new Float32Array(NG * NG);
  private acc = 0;
  private tick = 0;

  // particles (structure of arrays)
  readonly px = new Float32Array(MAX_PARTICLES);
  readonly py = new Float32Array(MAX_PARTICLES);
  readonly pz = new Float32Array(MAX_PARTICLES);
  readonly page = new Float32Array(MAX_PARTICLES);
  readonly palive = new Uint8Array(MAX_PARTICLES);
  np = 0;
  // particle hash: head per bucket, next per particle
  readonly head = new Int32Array(NB * NB);
  readonly next = new Int32Array(MAX_PARTICLES);

  /** Sun strength at the surface (0 at night, ~1 at noon). */
  sun = 1;
  /** Nutrient supply multiplier (seasons, floods, pressure setting) and algae growth multiplier (blooms). */
  supply = 1;
  bloom = 1;

  constructor(readonly T: Terrain, private readonly rng: Rng) {
    for (let k = 0; k < NG; k++) for (let i = 0; i < NG; i++) {
      const x = -HALF + (i + 0.5) * GS, z = -HALF + (k + 0.5) * GS, o = k * NG + i;
      const w = T.waterAt(x, z);
      if (Number.isNaN(w)) continue;
      const d = w - T.groundAt(x, z);
      if (d < 0.08) continue;
      this.depth[o] = d; this.wl[o] = w;
      this.water.push(o);
      this.N[o] = 1;
      this.A[o] = 0.2;
    }
    this.cfx = new Float32Array(this.water.length); this.cfz = new Float32Array(this.water.length);
    this.bedLight = new Float32Array(this.water.length);
    this.water.forEach((o, j) => {
      const i = o % NG, k = (o - i) / NG, x = -HALF + (i + 0.5) * GS, z = -HALF + (k + 0.5) * GS;
      this.cfx[j] = T.sample(T.FX, x, z); this.cfz[j] = T.sample(T.FZ, x, z);
      this.bedLight[j] = Math.exp(-this.depth[o] * 0.9);
    });
    // the river's first stretch brings fresh nutrients in
    for (const r of T.river) if (r.s < 12) {
      const i = Math.floor((r.x + HALF) / GS), k = Math.floor((r.z + HALF) / GS);
      if (i >= 0 && k >= 0 && i < NG && k < NG && this.depth[k * NG + i] > 0) this.inflow.push(k * NG + i);
    }
  }

  private gi(x: number, z: number): number {
    const i = clamp(Math.floor((x + HALF) / GS), 0, NG - 1), k = clamp(Math.floor((z + HALF) / GS), 0, NG - 1);
    return k * NG + i;
  }

  nutrientAt(x: number, z: number): number { return this.N[this.gi(x, z)]; }
  take(x: number, z: number, a: number): void { const o = this.gi(x, z); this.N[o] = Math.max(0, this.N[o] - a); }
  /** Grazing: a mouth on the bed eats algae; returns the energy gained. */
  graze(x: number, z: number, rate: number): number {
    const o = this.gi(x, z), gain = rate * Math.max(0, this.A[o] - 0.08); // the last of it clings on and regrows
    this.A[o] = Math.max(0, this.A[o] - gain * 0.004);
    return gain;
  }

  give(x: number, z: number, a: number): void { const o = this.gi(x, z); if (this.depth[o] > 0) this.N[o] += a; }

  /** Light at a point under the surface `wl` (absorbed with depth). */
  lightAt(y: number, wl: number): number { return this.sun * Math.exp(-Math.max(0, wl - y) * 0.9); }

  flowAt(x: number, z: number): [number, number] { return [this.T.sample(this.T.FX, x, z), this.T.sample(this.T.FZ, x, z)]; }

  spawnParticle(x: number, y: number, z: number): void {
    if (this.np >= MAX_PARTICLES) return;
    const i = this.np++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.page[i] = 0; this.palive[i] = 1;
  }

  /** Advances the habitat: slow fields every half second, particles (which drift slowly) once a simulated second. */
  step(dt: number): void {
    this.acc += dt;
    if (this.acc >= 0.5) { this.updateFields(this.acc); this.acc = 0; }
    if (this.tick++ % 10 === 0) this.moveParticles(dt * 10);
  }

  private moveParticles(dt: number): void {
    const T = this.T, H = T.H, WL = T.WL, FX = T.FX, FZ = T.FZ, r = this.rng, inv = 1 / CELL, lim = GRID - 1e-4;
    const px = this.px, py = this.py, pz = this.pz, page = this.page, palive = this.palive;
    let w = 0;
    for (let i = 0; i < this.np; i++) {
      if (!palive[i]) continue;
      let x = px[i], y = py[i], z = pz[i];
      const age = page[i] + dt;
      if (age > 420) { this.give(x, z, 0.06); continue; } // decays back into nutrients
      // bilinear terrain samples, inlined (this loop runs over thousands of particles)
      let gx = (x + HALF) * inv, gz = (z + HALF) * inv;
      gx = gx < 0 ? 0 : gx > lim ? lim : gx; gz = gz < 0 ? 0 : gz > lim ? lim : gz;
      let ci = gx | 0, ck = gz | 0, o = ck * GNV + ci, ux = gx - ci, uz = gz - ck;
      let wa = (1 - ux) * (1 - uz), wb = ux * (1 - uz), wc = (1 - ux) * uz, wd = ux * uz;
      const vx = FX[o] * wa + FX[o + 1] * wb + FX[o + GNV] * wc + FX[o + GNV + 1] * wd;
      const vz = FZ[o] * wa + FZ[o + 1] * wb + FZ[o + GNV] * wc + FZ[o + GNV + 1] * wd;
      const g0 = H[o] * wa + H[o + 1] * wb + H[o + GNV] * wc + H[o + GNV + 1] * wd;
      const t0 = WL[o] * wa + WL[o + 1] * wb + WL[o + GNV] * wc + WL[o + GNV + 1] * wd;
      const nx = x + (vx + (r.next() - 0.5) * 0.02) * dt, nz = z + (vz + (r.next() - 0.5) * 0.02) * dt;
      if (nx > HALF - 1 || nx < 1 - HALF || nz > HALF - 1 || nz < 1 - HALF) continue; // washed out of the valley
      gx = (nx + HALF) * inv; gz = (nz + HALF) * inv;
      gx = gx < 0 ? 0 : gx > lim ? lim : gx; gz = gz < 0 ? 0 : gz > lim ? lim : gz;
      ci = gx | 0; ck = gz | 0; o = ck * GNV + ci; ux = gx - ci; uz = gz - ck;
      wa = (1 - ux) * (1 - uz); wb = ux * (1 - uz); wc = (1 - ux) * uz; wd = ux * uz;
      let g = H[o] * wa + H[o + 1] * wb + H[o + GNV] * wc + H[o + GNV + 1] * wd;
      let top = WL[o] * wa + WL[o + 1] * wb + WL[o + GNV] * wc + WL[o + GNV + 1] * wd;
      if (top > g) { x = nx; z = nz; } else { g = g0; top = t0; }
      if (!(top > g)) top = g + 0.02;
      y += (Math.sin(age * 0.7 + i) * 0.04 - 0.02) * dt;
      y = y < g + 0.01 ? g + 0.01 : y > top - 0.01 ? top - 0.01 : y;
      px[w] = x; py[w] = y; pz[w] = z; page[w] = age; palive[w] = 1;
      w++;
    }
    this.np = w;
    this.head.fill(-1);
    for (let i = 0; i < this.np; i++) {
      const b = this.bucket(px[i], pz[i]);
      this.next[i] = this.head[b]; this.head[b] = i;
    }
  }

  bucket(x: number, z: number): number {
    const i = clamp(Math.floor((x + HALF) / BUCKET), 0, NB - 1), k = clamp(Math.floor((z + HALF) / BUCKET), 0, NB - 1);
    return k * NB + i;
  }

  /** Visits particle indices in the 3×3 buckets around (x, z). */
  near(x: number, z: number, f: (i: number) => void): void {
    const bi = clamp(Math.floor((x + HALF) / BUCKET), 0, NB - 1), bk = clamp(Math.floor((z + HALF) / BUCKET), 0, NB - 1);
    for (let k = Math.max(0, bk - 1); k <= Math.min(NB - 1, bk + 1); k++) for (let i = Math.max(0, bi - 1); i <= Math.min(NB - 1, bi + 1); i++) {
      for (let p = this.head[k * NB + i]; p >= 0; p = this.next[p]) if (this.palive[p]) f(p);
    }
  }

  /** Nutrients: advect, diffuse, replenish; algae: grow and shed particles. */
  private updateFields(dt: number): void {
    const N = this.N, A = this.A, D = this.depth, out = this.tmp, W = this.water;
    for (let j = 0; j < W.length; j++) {
      const o = W[j], i = o % NG, k = (o - i) / NG;
      const fx = this.cfx[j], fz = this.cfz[j];
      // semi-Lagrangian advection: take the value from upstream
      const si = clamp(Math.round(i - (fx * dt) / GS), 0, NG - 1), sk = clamp(Math.round(k - (fz * dt) / GS), 0, NG - 1);
      const up = D[sk * NG + si] > 0 ? N[sk * NG + si] : N[o];
      let s = 0, c = 0;
      if (D[o - 1] > 0) { s += N[o - 1]; c++; }
      if (D[o + 1] > 0) { s += N[o + 1]; c++; }
      if (D[o - NG] > 0) { s += N[o - NG]; c++; }
      if (D[o + NG] > 0) { s += N[o + NG]; c++; }
      const v = c ? up + (s / c - up) * Math.min(1, 0.6 * dt) : up;
      out[o] = Math.min(4, v + 0.004 * dt * this.supply);
    }
    for (const o of this.water) N[o] = out[o];
    for (const o of this.inflow) N[o] = Math.min(4, 3 * this.supply);

    // algae on the bed: logistic growth with light and nutrients, sheds particles
    const r = this.rng;
    for (let j = 0; j < W.length; j++) {
      const o = W[j], light = this.sun * this.bedLight[j];
      const n = N[o] / (N[o] + 0.6);
      A[o] = clamp(A[o] + (0.1 * this.bloom * light * n * A[o] * (1 - A[o]) - 0.004 * A[o] + 0.0005) * dt, 0, 1);
      if (r.next() < A[o] * (0.25 + light) * 0.07 * this.bloom * dt) {
        const i = o % NG, k = (o - i) / NG;
        const x = -HALF + (i + r.next()) * GS, z = -HALF + (k + r.next()) * GS;
        const g = this.T.groundAt(x, z);
        this.spawnParticle(x, g + 0.02 + r.next() * Math.min(0.5, this.wl[o] - g), z);
        N[o] = Math.max(0, N[o] - 0.02);
      }
    }
  }

  /** Total nutrients and mean algae, for the HUD. */
  totals(): { nutrients: number; algae: number } {
    let n = 0, a = 0;
    for (const o of this.water) { n += this.N[o]; a += this.A[o]; }
    return { nutrients: n, algae: a / Math.max(1, this.water.length) };
  }
}
