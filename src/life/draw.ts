// Main-thread drawing of life: glowing impostors for everything, and full body plans (instanced primitives) for
// the organisms close enough to show their parts.
import { icosphere } from '../world/meshkit';
import type { Terrain } from '../world/terrain';
import { PartType, type Genome } from './genome';
import { place, type Body, type Placed } from './phenotype';
import { ORG, O_ACT, O_B, O_BOUND, O_BUILT, O_G, O_ID, O_KIND, O_QW, O_QX, O_QY, O_QZ, O_R, O_SCALE, O_SIZE, O_X, O_Y, O_Z } from './protocol';

/** Impostor instance floats (see shaders/life.ts) and creature primitive instance floats (shaders/creatures.ts). */
export const LIFE_FLOATS = 12;
export const PRIM = 20;
export const MAX_NEAR = 250;
const MAX_PRIMS = 24000;

type V = [number, number, number];

/** Unit meshes, non-indexed, position + normal: sphere, tube (z 0..1, radius 1), fan (x ±½, z 0..1). */
export function primitiveMeshes(): Float32Array<ArrayBuffer>[] {
  const out: number[][] = [[], [], []];
  const tri = (m: number, a: V, b: V, c: V, n?: V): void => {
    const u: V = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v: V = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nn: V = n ?? [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...nn) || 1; nn = [nn[0] / l, nn[1] / l, nn[2] / l];
    for (const p of [a, b, c]) out[m].push(p[0], p[1], p[2], nn[0], nn[1], nn[2]);
  };
  const ico = icosphere(1);
  for (let i = 0; i < ico.f.length; i += 3) tri(0, ico.v[ico.f[i]], ico.v[ico.f[i + 1]], ico.v[ico.f[i + 2]]);
  const S = 6;
  for (let k = 0; k < S; k++) {
    const a0 = (k / S) * Math.PI * 2, a1 = ((k + 1) / S) * Math.PI * 2, am = (a0 + a1) / 2;
    const p0: V = [Math.cos(a0), Math.sin(a0), 0], p1: V = [Math.cos(a1), Math.sin(a1), 0];
    const n: V = [Math.cos(am), Math.sin(am), 0];
    tri(1, p0, p1, [p1[0], p1[1], 1], n); tri(1, p0, [p1[0], p1[1], 1], [p0[0], p0[1], 1], n);
  }
  tri(2, [-0.5, 0, 0], [0.5, 0, 0], [0.5, 0, 1], [0, 1, 0]); tri(2, [-0.5, 0, 0], [0.5, 0, 1], [-0.5, 0, 1], [0, 1, 0]);
  return out.map((a) => new Float32Array(a));
}

interface Plan { genome: Genome; built: number; placed: Placed[]; bodies: Body[]; pattern: number }

const COL: Partial<Record<PartType, V>> = {
  [PartType.Mouth]: [0.75, 0.3, 0.35], [PartType.Eye]: [0.95, 0.95, 0.88], [PartType.Chemo]: [0.9, 0.8, 0.3],
  [PartType.Spike]: [0.88, 0.84, 0.72], [PartType.Shell]: [0.55, 0.42, 0.28], [PartType.Chloro]: [0.2, 0.72, 0.18],
  [PartType.Adhesion]: [0.95, 0.6, 0.8],
};

const norm = (v: V): V => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class LifeDraw {
  /** Impostors: near organisms first (halo only), then far organisms and particles. */
  readonly imp: Float32Array<ArrayBuffer>;
  impCount = 0;
  firstCell = 0;
  /** Primitive instances grouped by mesh: spheres, tubes, fans. */
  readonly prim = new Float32Array(MAX_PRIMS * PRIM);
  readonly counts = [0, 0, 0];
  private readonly lists: number[][] = [[], [], []];
  private readonly plans = new Map<number, Plan>();
  private readonly wanted = new Set<number>();
  private sweep = 0;

  constructor(private readonly T: Terrain, maxOrgs: number, maxParticles: number) {
    this.imp = new Float32Array((maxOrgs + maxParticles) * LIFE_FLOATS);
  }

  /** Genomes arrive from the worker on request. */
  addGenome(id: number, g: Genome): void {
    const { placed, bodies } = place(g, 1);
    this.plans.set(id, { genome: g, built: 1, placed, bodies, pattern: g.pattern });
    this.wanted.delete(id);
  }

  /** Ids whose body plan is needed but not known yet (sent once). */
  takeRequests(): number[] {
    const ids = [...this.wanted].filter((id) => !this.plans.has(id));
    this.wanted.clear();
    return ids;
  }

  build(orgs: Float32Array, n: number, particles: Float32Array, np: number, cam: V, pxPerRad: number, selected: number, time: number): void {
    const imp = this.imp, T = this.T;
    for (const l of this.lists) l.length = 0;
    const near: number[] = [], far: number[] = [];
    for (let i = 0; i < n; i++) {
      const k = i * ORG, id = orgs[k + O_ID];
      const d = Math.hypot(orgs[k + O_X] - cam[0], orgs[k + O_Y] - cam[1], orgs[k + O_Z] - cam[2]);
      const px = (orgs[k + O_BOUND] * orgs[k + O_SCALE] * pxPerRad) / Math.max(d, 1e-3);
      if (px > 3.5 && near.length < MAX_NEAR) {
        if (this.plans.has(id)) { near.push(i); continue; }
        this.wanted.add(id);
      }
      far.push(i);
    }
    let c = 0;
    const put = (i: number): void => {
      const k = i * ORG, o = c * LIFE_FLOATS, x = orgs[k + O_X], y = orgs[k + O_Y], z = orgs[k + O_Z], id = orgs[k + O_ID];
      const w = T.waterAt(x, z);
      imp[o] = x; imp[o + 1] = y; imp[o + 2] = z; imp[o + 3] = orgs[k + O_SIZE] * orgs[k + O_SCALE];
      imp[o + 4] = orgs[k + O_R]; imp[o + 5] = orgs[k + O_G]; imp[o + 6] = orgs[k + O_B]; imp[o + 7] = orgs[k + O_KIND];
      imp[o + 8] = Number.isNaN(w) ? 0 : Math.max(0, w - y); imp[o + 9] = id === selected ? 1 : 0; imp[o + 10] = (id * 0.618) % 1;
      imp[o + 11] = c < nearN ? 1 : 0; // drawn in full: keep its glow faint
      c++;
    };
    const nearN = near.length;
    for (const i of near) put(i);
    this.firstCell = c;
    for (const i of far) put(i);
    for (let i = 0; i < np && c < imp.length / LIFE_FLOATS; i++) {
      const o = c * LIFE_FLOATS, x = particles[i * 3], y = particles[i * 3 + 1], z = particles[i * 3 + 2], w = T.waterAt(x, z);
      imp.set([x, y, z, 0.006, 0.85, 0.9, 0.5, 2, Number.isNaN(w) ? 0 : Math.max(0, w - y), 0, 0, 0], o);
      c++;
    }
    this.impCount = c;

    for (const i of near) this.creature(orgs, i * ORG, time);
    let o = 0;
    for (let m = 0; m < 3; m++) {
      const l = this.lists[m];
      const room = Math.min(l.length, (MAX_PRIMS - o / PRIM) * PRIM);
      this.prim.set(l.slice(0, room), o);
      this.counts[m] = room / PRIM;
      o += room;
    }
    // forget plans of organisms that are gone, now and then
    if (++this.sweep % 300 === 0) {
      const alive = new Set<number>();
      for (let i = 0; i < n; i++) alive.add(orgs[i * ORG + O_ID]);
      for (const id of this.plans.keys()) if (!alive.has(id)) this.plans.delete(id);
    }
  }

  private emit(mesh: number, o: V, ax: V, ay: V, az: V, col: V, em: number, taper: number, depth: number, pattern: number): void {
    this.lists[mesh].push(
      ax[0], ay[0], az[0], o[0], ax[1], ay[1], az[1], o[1], ax[2], ay[2], az[2], o[2],
      col[0], col[1], col[2], em, taper, depth, pattern, 0,
    );
  }

  private creature(org: Float32Array, k: number, time: number): void {
    const id = org[k + O_ID], plan = this.plans.get(id)!;
    if (plan.built !== org[k + O_BUILT]) {
      // the colony grew a cell since we last laid it out
      plan.built = org[k + O_BUILT];
      const p = place(plan.genome, plan.built);
      plan.placed = p.placed; plan.bodies = p.bodies;
    }
    const P: V = [org[k + O_X], org[k + O_Y], org[k + O_Z]], s = org[k + O_SCALE], act = org[k + O_ACT];
    const qw = org[k + O_QW], qx = org[k + O_QX], qy = org[k + O_QY], qz = org[k + O_QZ];
    // rotation matrix columns
    const c0: V = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qw * qz), 2 * (qx * qz - qw * qy)];
    const c1: V = [2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx)];
    const c2: V = [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)];
    const R = (v: V): V => [c0[0] * v[0] + c1[0] * v[1] + c2[0] * v[2], c0[1] * v[0] + c1[1] * v[1] + c2[1] * v[2], c0[2] * v[0] + c1[2] * v[1] + c2[2] * v[2]];
    const w = this.T.waterAt(P[0], P[2]), depth = Number.isNaN(w) ? 0 : Math.max(0, w - P[1]);
    const body: V = [org[k + O_R], org[k + O_G], org[k + O_B]];
    const sc = (v: V, f: number): V => [v[0] * f, v[1] * f, v[2] * f];
    const add = (a: V, b: V, f = 1): V => [a[0] + b[0] * f, a[1] + b[1] * f, a[2] + b[2] * f];
    plan.bodies.forEach((B, i) => {
      const c = add(P, R(B.c), s);
      // specialised cell types get a slightly shifted shade
      const col: V = B.type ? [body[0] * (1 - 0.12 * B.type), body[1], body[2] * (1 + 0.1 * B.type)] : body;
      this.emit(0, c, sc(c0, B.rx * s), sc(c1, B.ry * s), sc(c2, B.rz * s), col, 0.3, 1, depth, 1 + plan.pattern + i * 0.13);
    });

    const tube = (p0: V, d: V, len: number, rad: number, taper: number, col: V, em = 0.15): void => {
      const a = norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), b = cross(d, a);
      this.emit(1, p0, sc(a, rad), sc(b, rad), sc(d, len), col, em, taper, depth, 0);
    };
    const blob = (c: V, a: V, b: V, n: V, ra: number, rn: number, col: V, em = 0.15): void =>
      this.emit(0, c, sc(a, ra), sc(b, ra), sc(n, rn), col, em, 1, depth, 0);

    plan.placed.forEach((pl, idx) => {
      const base = add(P, R(pl.base), s), u = R(pl.dir), nrm = R(pl.normal);
      let a = cross(u, nrm);
      if (Math.hypot(...a) < 1e-3) a = cross(u, Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
      a = norm(a);
      const b = cross(u, a), L = pl.length * s, t = pl.thick * s;
      const beat = time * (1 + pl.p1 * 2) * (0.4 + act) + id * 0.37 + idx;
      const dim = (f: number): V => sc(body, f);
      switch (pl.type) {
        case PartType.Flagellum:
        case PartType.Limb: {
          const n = Math.max(2, pl.segments + (pl.type === PartType.Flagellum ? 2 : 0)), sl = L / n;
          let p = base;
          for (let j = 0; j < n; j++) {
            const amp = pl.type === PartType.Flagellum ? 0.7 * (j + 1) / n : 0.35;
            const th = amp * Math.sin(beat * (pl.type === PartType.Flagellum ? 6 : 3) - j * 1.2) * (0.3 + act);
            const d = norm(add(sc(u, Math.cos(th)), pl.type === PartType.Flagellum ? a : b, Math.sin(th)));
            const r0 = t * (pl.type === PartType.Flagellum ? 1 - (j / n) * 0.7 : 1);
            tube(p, d, sl * 1.05, r0, pl.type === PartType.Flagellum ? 1 - 0.7 / n : 0.85, dim(pl.type === PartType.Flagellum ? 0.9 : 0.75));
            p = add(p, d, sl);
          }
          if (pl.type === PartType.Limb) blob(p, a, b, u, t * 1.2, t * 1.2, dim(0.6));
          break;
        }
        case PartType.Cilia: {
          for (let j = 0; j < 7; j++) {
            const an = (j / 7) * Math.PI * 2, rr = L * 0.5;
            const off = add(sc(a, Math.cos(an) * rr), b, Math.sin(an) * rr);
            const d = norm(add(nrm, u, 0.8 * Math.sin(beat * 8 + j)));
            tube(add(base, off), d, L * 0.9, t * 0.5, 0.4, dim(1.15), 0.3);
          }
          break;
        }
        case PartType.Fin: {
          const sw = 0.35 * Math.sin(beat * 3) * (0.3 + act);
          const d = norm(add(sc(u, Math.cos(sw)), a, Math.sin(sw)));
          const side = norm(cross(d, b));
          this.emit(2, base, sc(side, t * 1.4), b, sc(d, L), dim(1.1), 0.2, 1, depth, 0);
          break;
        }
        case PartType.Mouth: {
          const r = (0.005 + pl.p1 * 0.008) * s;
          blob(base, a, b, u, r * 1.3, r * 0.35, COL[PartType.Mouth]!);
          blob(add(base, u, r * 0.2), a, b, u, r, r * 0.3, [0.05, 0.02, 0.02], 0);
          break;
        }
        case PartType.Eye: {
          blob(base, a, b, u, t, t, COL[PartType.Eye]!, 0.35);
          blob(add(base, u, t * 0.65), a, b, u, t * 0.5, t * 0.45, [0.02, 0.02, 0.04], 0);
          break;
        }
        case PartType.Chemo: {
          const d = norm(add(u, a, 0.15 * Math.sin(beat * 2)));
          tube(base, d, L, t, 0.6, COL[PartType.Chemo]!);
          blob(add(base, d, L), a, b, d, t * 1.6, t * 1.6, COL[PartType.Chemo]!, 0.3);
          break;
        }
        case PartType.Spike: tube(base, u, L, t, 0, COL[PartType.Spike]!); break;
        case PartType.Shell: blob(add(base, nrm, t * 0.5), a, b, nrm, L * 0.7, t * 1.5, COL[PartType.Shell]!, 0.05); break;
        case PartType.Chloro: blob(add(base, nrm, 0.0008 * s), a, b, nrm, L * 0.75, 0.0018 * s, COL[PartType.Chloro]!, 0.2); break;
        default: blob(base, a, b, u, t, t, COL[PartType.Adhesion]!, 0.2);
      }
    });
  }
}
