import { add, cross, norm, scale, sub, type V3 } from '../core/math';
import { vnoise } from '../core/noise';

/**
 * Prop vertex: position (3), normal (3), uv (2), texture layer, sway, tint rgb (3), ambient occlusion — 14 floats.
 * Solid props ignore the uv and project the texture from world space; cutout props (grass, reeds, lily pads…)
 * use it and alpha-test the texture.
 */
export const PROP_STRIDE = 14;

export interface Mesh { vb: Float32Array<ArrayBuffer>; ib: Uint32Array<ArrayBuffer>; nv: number }

/** Unit icospheres by subdivision level (shared vertices, outward triangles). */
const icoCache: { v: V3[]; f: number[] }[] = [];
export function icosphere(level: number): { v: V3[]; f: number[] } {
  if (icoCache[level]) return icoCache[level];
  const t = (1 + Math.sqrt(5)) / 2;
  let v: V3[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => norm(p as V3));
  let f = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let l = 0; l < level; l++) {
    const mid = new Map<number, number>(), nf: number[] = [];
    const m = (a: number, b: number): number => {
      const k = a < b ? a * 65536 + b : b * 65536 + a;
      let i = mid.get(k);
      if (i === undefined) { i = v.length; v.push(norm(scale(add(v[a], v[b]), 0.5))); mid.set(k, i); }
      return i;
    };
    for (let i = 0; i < f.length; i += 3) {
      const a = f[i], b = f[i + 1], c = f[i + 2], ab = m(a, b), bc = m(b, c), ca = m(c, a);
      nf.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    f = nf; v = v.slice();
  }
  return (icoCache[level] = { v, f });
}

/** Accumulates prop geometry. Material state (layer, tint, ao) applies to the vertices added after it is set. */
export class MeshBuilder {
  private v: number[] = [];
  private i: number[] = [];
  layer = 0;
  tint: V3 = [1, 1, 1];
  ao = 1;

  get count(): number { return this.v.length / PROP_STRIDE; }

  vert(p: V3, n: V3, u = 0, w = 0, sway = 0): number {
    const t = this.tint;
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], u, w, this.layer, sway, t[0], t[1], t[2], this.ao);
    return this.count - 1;
  }

  tri(a: number, b: number, c: number): void { this.i.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number): void { this.i.push(a, b, c, a, c, d); }

  /** Flat-shaded triangle (its own three vertices, face normal). */
  flatTri(a: V3, b: V3, c: V3, sa = 0, sb = 0, sc = 0): void {
    const n = norm(cross(sub(b, a), sub(c, a)));
    const i0 = this.vert(a, n, 0, 0, sa), i1 = this.vert(b, n, 0, 0, sb), i2 = this.vert(c, n, 0, 0, sc);
    this.tri(i0, i1, i2);
  }

  /**
   * Tapered tube from `a` (radius r0) to `b` (radius r1) with `sides` facets, flat shaded, end caps optional.
   * Sway grows linearly from s0 at `a` to s1 at `b`.
   */
  tube(a: V3, b: V3, r0: number, r1: number, sides: number, s0 = 0, s1 = 0, caps = true, twist = 0): void {
    const ax = norm(sub(b, a));
    const ref: V3 = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(ax, ref)), w = cross(ax, u);
    const ring = (c: V3, r: number, k: number): V3 => {
      const t = (k / sides) * Math.PI * 2 + twist;
      return add(c, add(scale(u, Math.cos(t) * r), scale(w, Math.sin(t) * r)));
    };
    for (let k = 0; k < sides; k++) {
      const p0 = ring(a, r0, k), p1 = ring(a, r0, k + 1), p2 = ring(b, r1, k + 1), p3 = ring(b, r1, k);
      this.flatTri(p0, p1, p2, s0, s0, s1);
      if (r1 > 1e-4) this.flatTri(p0, p2, p3, s0, s1, s1);
    }
    if (caps && r1 > 1e-4) for (let k = 0; k < sides; k++) this.flatTri(b, ring(b, r1, k), ring(b, r1, k + 1), s1, s1, s1);
  }

  /**
   * Lumpy flat-shaded blob: an icosphere scaled by `r`, displaced by noise (`rough` = fraction of the radius).
   * `sink` drops the vertices below `floorY` onto it (rocks sitting in the ground). Sway ∝ height above `c`,
   * unless `flatSway`: then every vertex gets `sway` as is (it carries a per-object value, e.g. for mushrooms).
   */
  blob(c: V3, r: V3, level: number, seed: number, rough: number, sway = 0, rotY = 0, flatSway = false): void {
    const ico = icosphere(level), cs = Math.cos(rotY), sn = Math.sin(rotY);
    const P = ico.v.map((d) => {
      const k = 1 + rough * vnoise(d[0] * 2.1 + seed * 7.13, d[1] * 2.1 + d[2] * 1.7, seed) +
        rough * 0.5 * vnoise(d[2] * 4.3 + seed, d[0] * 4.3 - d[1] * 3.1, seed + 3);
      const x = d[0] * r[0] * k, z = d[2] * r[2] * k;
      return [c[0] + x * cs - z * sn, c[1] + d[1] * r[1] * k, c[2] + x * sn + z * cs] as V3;
    });
    const sw = (p: V3): number => flatSway ? sway : sway * Math.max(0, (p[1] - c[1] + r[1]) / (2 * r[1]));
    for (let i = 0; i < ico.f.length; i += 3) {
      const a = P[ico.f[i]], b = P[ico.f[i + 1]], d = P[ico.f[i + 2]];
      this.flatTri(a, b, d, sw(a), sw(b), sw(d));
    }
  }

  /**
   * Vertical cutout card standing at `p`, `w` wide and `h` tall, facing `angle`, texture rect u0..u1.
   * Normal `n` is shared by all vertices (grass uses straight up so it lights like the ground).
   */
  card(p: V3, w: number, h: number, angle: number, n: V3, sway: number, u0 = 0, u1 = 1, lean: V3 = [0, 0, 0]): void {
    const dx = Math.cos(angle) * w * 0.5, dz = Math.sin(angle) * w * 0.5;
    const top: V3 = [p[0] + lean[0], p[1] + h + lean[1], p[2] + lean[2]];
    const a = this.vert([p[0] - dx, p[1], p[2] - dz], n, u0, 1, 0);
    const b = this.vert([p[0] + dx, p[1], p[2] + dz], n, u1, 1, 0);
    const c = this.vert([top[0] + dx, top[1], top[2] + dz], n, u1, 0, sway);
    const d = this.vert([top[0] - dx, top[1], top[2] - dz], n, u0, 0, sway);
    this.quad(a, b, c, d);
  }

  /** Horizontal cutout quad (lily pads), centred at `p`, size `s`, rotated `angle`. */
  flat(p: V3, s: number, angle: number, sway = 0): void {
    const n: V3 = [0, 1, 0], c = Math.cos(angle) * s * 0.5, d = Math.sin(angle) * s * 0.5;
    const a = this.vert([p[0] - c + d, p[1], p[2] - d - c], n, 0, 0, sway);
    const b = this.vert([p[0] + c + d, p[1], p[2] + d - c], n, 1, 0, sway);
    const e = this.vert([p[0] + c - d, p[1], p[2] + d + c], n, 1, 1, sway);
    const f = this.vert([p[0] - c - d, p[1], p[2] - d + c], n, 0, 1, sway);
    this.quad(a, f, e, b);
  }

  build(): Mesh {
    return { vb: new Float32Array(this.v), ib: new Uint32Array(this.i), nv: this.count };
  }
}
