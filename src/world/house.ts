// A small cabin by the pond: plank walls with a door and windows, a shingled gable roof, a stone fireplace with a
// fire, a couch and a rug. It is placed on the flattest dry spot near the pond, door toward the water, and can be
// switched on and off (the spot is always kept clear of trees and rocks).

import { ROAM } from '../config';
import { cross, sub, type V3 } from '../core/math';
import { MeshBuilder, type Mesh } from './meshkit';
import type { Terrain } from './terrain';
import { L } from './textures';

/** Half sizes of the outer walls (m): along the ridge (x) and front to back (z). */
const HX = 3.2, HZ = 2.5;
const WALL = 0.2, HEIGHT = 2.5, RISE = 1.8, OVERHANG = 0.45, ROOF_T = 0.15;
const DOOR = 0.5, DOOR_H = 2.1;

/** A wall opening: from `a` to `b` along the wall, `y0` to `y1` above the floor. */
interface Opening { a: number; b: number; y0: number; y1: number }
/** An axis-aligned box in house space (x along the ridge, y above the floor, z toward the door). */
type Box = [number, number, number, number, number, number];

export class House {
  /** Centre (world x, z), rotation (local +z, the door side, faces the pond), floor height, eave and ridge heights. */
  readonly cx: number; readonly cz: number; readonly cos: number; readonly sin: number;
  readonly floor: number; readonly eave: number; readonly peak: number;
  readonly solid: Mesh; readonly cutout: Mesh;
  /** Boxes the walker bumps into (walls, fireplace, couch), in house space. */
  private readonly blockers: Box[] = [];
  /** Radius around the centre that the scatter keeps free. */
  readonly clearR = Math.hypot(HX, HZ) + 1.5;

  constructor(private readonly T: Terrain, avoid: [number, number][]) {
    [this.cx, this.cz, this.cos, this.sin] = House.site(T, avoid);
    let hi = -Infinity;
    for (const [lx, lz] of this.footprint(1)) hi = Math.max(hi, T.groundAt(...this.world(lx, lz)));
    this.floor = hi + 0.25;
    this.eave = this.floor + HEIGHT;
    this.peak = this.eave + RISE;
    const s = new MeshBuilder(), c = new MeshBuilder();
    this.build(s, c);
    this.solid = s.build(); this.cutout = c.build();
  }

  /** Picks the spot: on a ring around the pond, dry, flat, inside the roaming area and away from the viewpoints. */
  private static site(T: Terrain, avoid: [number, number][]): [number, number, number, number] {
    const P = T.layout.pond, [px, pz] = P.c;
    let best: [number, number, number, number] = [px + 20, pz, 1, 0], bestScore = Infinity;
    for (let r = 12; r <= 34; r += 2.5) for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2, x = px + Math.cos(a) * (r + P.rx * 0.5), z = pz + Math.sin(a) * (r + P.rz * 0.5);
      if (Math.max(Math.abs(x), Math.abs(z)) > ROAM - 8) continue;
      if (avoid.some(([ax, az]) => Math.hypot(x - ax, z - az) < 7)) continue;
      // door faces the pond: local +z points from the house to the pond centre
      const dl = Math.hypot(px - x, pz - z), dx = (px - x) / dl, dz = (pz - z) / dl;
      const cos = dz, sin = -dx;
      let lo = Infinity, hi = -Infinity, dry = Infinity;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        const lx = (i / 2) * (HX + 1), lz = (j / 2) * (HZ + 1);
        const wx = x + lx * cos - lz * sin, wz = z + lx * sin + lz * cos;
        const h = T.groundAt(wx, wz);
        lo = Math.min(lo, h); hi = Math.max(hi, h); dry = Math.min(dry, T.shoreDist(wx, wz));
      }
      if (dry < 4) continue;
      const score = hi - lo + r * 0.01;
      if (score < bestScore) { bestScore = score; best = [x, z, cos, sin]; }
    }
    return best;
  }

  /** House space (x, z) to world (x, z). */
  world(lx: number, lz: number): [number, number] {
    return [this.cx + lx * this.cos - lz * this.sin, this.cz + lx * this.sin + lz * this.cos];
  }
  /** World (x, z) to house space. */
  local(x: number, z: number): [number, number] {
    const dx = x - this.cx, dz = z - this.cz;
    return [dx * this.cos + dz * this.sin, -dx * this.sin + dz * this.cos];
  }
  private footprint(m: number): [number, number][] {
    const out: [number, number][] = [];
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) out.push([(i / 2) * (HX + m), (j / 2) * (HZ + m)]);
    return out;
  }
  private p(lx: number, y: number, lz: number): V3 { const [x, z] = this.world(lx, lz); return [x, this.floor + y, z]; }
  private dir(lx: number, y: number, lz: number): V3 { return [lx * this.cos - lz * this.sin, y, lx * this.sin + lz * this.cos]; }

  /** Floor height when (x, z) is inside the walls, else null. */
  floorAt(x: number, z: number): number | null {
    const [lx, lz] = this.local(x, z);
    return Math.abs(lx) < HX && Math.abs(lz) < HZ ? this.floor : null;
  }

  /** Pushes a walker of radius `r` with feet at `feet` out of the walls and furniture; returns the corrected (x, z). */
  collide(x: number, z: number, feet: number, r = 0.25): [number, number] {
    let [lx, lz] = this.local(x, z);
    const y = feet - this.floor;
    for (const [x0, y0, z0, x1, y1, z1] of this.blockers) {
      if (y > y1 - 0.05 || y + 1.5 < y0) continue; // stepped over, or passing beneath
      const ax = x0 - r, bx = x1 + r, az = z0 - r, bz = z1 + r;
      if (lx <= ax || lx >= bx || lz <= az || lz >= bz) continue;
      const push = [lx - ax, bx - lx, lz - az, bz - lz], m = Math.min(...push);
      if (m === push[0]) lx = ax; else if (m === push[1]) lx = bx; else if (m === push[2]) lz = az; else lz = bz;
    }
    return this.world(lx, lz);
  }

  /** Uniform block values: centre + rotation, half sizes + floor + eave, ridge + overhang. */
  uniforms(on: boolean): number[] {
    return [this.cx, this.cz, this.cos, this.sin, HX, HZ, this.floor, this.eave, this.peak, OVERHANG, on ? 1 : 0, 0];
  }

  /** Where the fire burns (world). */
  firePos(): V3 { return this.p(0, 0.35, -HZ + 0.6); }

  // ---------- geometry ----------

  /** One flat face (3 or 4 corners) wound so it faces `out` (back faces are culled). */
  private face(m: MeshBuilder, pts: V3[], out: V3): void {
    const n = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
    const q = n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0 ? pts.slice().reverse() : pts;
    m.flatTri(q[0], q[1], q[2]);
    if (q.length === 4) m.flatTri(q[0], q[2], q[3]);
  }

  /** Box in house space, with optional collision. */
  private box(m: MeshBuilder, b: Box, block = true): void {
    const [x0, y0, z0, x1, y1, z1] = b;
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3 || z1 - z0 < 1e-3) return;
    const P = (x: number, y: number, z: number): V3 => this.p(x, y, z);
    this.face(m, [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], this.dir(0, 0, 1));
    this.face(m, [P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0)], this.dir(0, 0, -1));
    this.face(m, [P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0)], this.dir(1, 0, 0));
    this.face(m, [P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], this.dir(-1, 0, 0));
    this.face(m, [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], [0, 1, 0]);
    this.face(m, [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)], [0, -1, 0]);
    if (block) this.blockers.push(b);
  }

  /** A wall from a to b along x (at z0..z1) or along z (at x0..x1), split around its openings. */
  private wall(m: MeshBuilder, alongX: boolean, a: number, b: number, t0: number, t1: number, openings: Opening[]): void {
    const seg = (s0: number, s1: number, y0: number, y1: number): void =>
      this.box(m, alongX ? [s0, y0, t0, s1, y1, t1] : [t0, y0, s0, t1, y1, s1]);
    let s = a;
    for (const o of [...openings].sort((p, q) => p.a - q.a)) {
      seg(s, o.a, 0, HEIGHT);
      seg(o.a, o.b, 0, o.y0);
      seg(o.a, o.b, o.y1, HEIGHT);
      s = o.b;
    }
    seg(s, b, 0, HEIGHT);
  }

  private build(m: MeshBuilder, cut: MeshBuilder): void {
    m.ao = 1;
    // foundation and floor
    let lo = Infinity;
    for (const [lx, lz] of this.footprint(0.2)) lo = Math.min(lo, this.T.groundAt(...this.world(lx, lz)));
    m.layer = L.Rock; m.tint = [0.9, 0.88, 0.85];
    this.box(m, [-HX - 0.1, lo - this.floor - 0.4, -HZ - 0.1, HX + 0.1, -0.1, HZ + 0.1], false);
    m.layer = L.Planks; m.tint = [0.78, 0.66, 0.55];
    this.box(m, [-HX, -0.1, -HZ, HX, 0, HZ], false);
    // door step
    m.layer = L.Rock; m.tint = [0.85, 0.85, 0.82];
    this.box(m, [-0.7, lo - this.floor - 0.2, HZ, 0.7, -0.12, HZ + 0.6], false);

    // walls: door in front, a window either side of it, one in each gable wall, one at the back
    m.layer = L.Planks; m.tint = [1, 1, 1];
    const win = (c: number, w = 0.55): Opening => ({ a: c - w, b: c + w, y0: 0.9, y1: 1.8 });
    this.wall(m, true, -HX, HX, HZ - WALL, HZ, [{ a: -DOOR, b: DOOR, y0: 0, y1: DOOR_H }, win(-2), win(2)]);
    this.wall(m, true, -HX, HX, -HZ, -HZ + WALL, [win(-2.2, 0.4), win(2.2, 0.4)]);
    this.wall(m, false, -HZ + WALL, HZ - WALL, -HX, -HX + WALL, [win(0)]);
    this.wall(m, false, -HZ + WALL, HZ - WALL, HX - WALL, HX, [win(0)]);
    // corner posts and door frame (darker)
    m.tint = [0.62, 0.5, 0.42];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.box(m, [sx * HX - 0.13, 0, sz * HZ - 0.13, sx * HX + 0.13, HEIGHT, sz * HZ + 0.13], false);
    this.box(m, [-DOOR - 0.08, 0, HZ - WALL - 0.03, -DOOR, DOOR_H, HZ + 0.03], false);
    this.box(m, [DOOR, 0, HZ - WALL - 0.03, DOOR + 0.08, DOOR_H, HZ + 0.03], false);
    this.box(m, [-DOOR - 0.08, DOOR_H, HZ - WALL - 0.03, DOOR + 0.08, DOOR_H + 0.1, HZ + 0.03], false);

    // gables: triangles closing the ends under the roof (inside and outside faces)
    m.tint = [0.92, 0.9, 0.88];
    for (const sx of [-1, 1]) for (const [x, out] of [[sx * HX, sx], [sx * (HX - WALL), -sx]] as const) {
      this.face(m, [this.p(x, HEIGHT, -HZ), this.p(x, HEIGHT, HZ), this.p(x, HEIGHT + RISE, 0)], this.dir(out, 0, 0));
    }

    // roof: two slabs from the ridge past the eaves, shingled on top
    m.layer = L.Shingles; m.tint = [1, 1, 1];
    const run = HZ + OVERHANG, drop = (RISE * run) / HZ, xr = HX + OVERHANG;
    for (const sz of [-1, 1]) {
      const top = (x: number, z: number, t: number): V3 => this.p(x, HEIGHT + RISE - (drop * Math.abs(z)) / run + t, z);
      const ridge = 0, eaveZ = sz * run, T = ROOF_T;
      const a = top(-xr, ridge, T), b = top(xr, ridge, T), c = top(xr, eaveZ, T), d = top(-xr, eaveZ, T);
      const a2 = top(-xr, ridge, 0), b2 = top(xr, ridge, 0), c2 = top(xr, eaveZ, 0), d2 = top(-xr, eaveZ, 0);
      const up = this.dir(0, run, sz * drop);
      this.face(m, [a, b, c, d], up);
      this.face(m, [a2, b2, c2, d2], [-up[0], -up[1], -up[2]]);
      this.face(m, [d, c, c2, d2], this.dir(0, 0, sz));
      this.face(m, [b, c, c2, b2], this.dir(1, 0, 0));
      this.face(m, [a, d, d2, a2], this.dir(-1, 0, 0));
    }
    // ridge beam
    m.layer = L.Bark; m.tint = [0.8, 0.7, 0.6];
    this.box(m, [-HX - OVERHANG, HEIGHT + RISE - 0.05, -0.1, HX + OVERHANG, HEIGHT + RISE + ROOF_T + 0.08, 0.1], false);

    // fireplace on the back wall: hearth, firebox with logs and a fire, chimney through the roof
    const bz = -HZ + WALL;
    m.layer = L.Rock; m.tint = [0.95, 0.9, 0.85];
    this.box(m, [-1.1, 0, bz, 1.1, 0.12, bz + 1.0], false);
    this.box(m, [-0.95, 0, bz, -0.5, 1.3, bz + 0.65]);
    this.box(m, [0.5, 0, bz, 0.95, 1.3, bz + 0.65]);
    this.box(m, [-0.95, 0.85, bz, 0.95, 1.3, bz + 0.65]);
    this.box(m, [-1.0, 1.3, bz, 1.0, 1.42, bz + 0.72], false); // mantel
    m.tint = [0.85, 0.82, 0.8];
    this.box(m, [-0.6, 1.42, bz - WALL, 0.6, HEIGHT + RISE + 0.9, bz + 0.5], false);
    m.layer = L.Mud; m.tint = [0.35, 0.3, 0.28];
    this.box(m, [-0.5, 0.12, bz, 0.5, 0.85, bz + 0.12], false); // soot-black back of the firebox
    m.layer = L.Bark; m.tint = [0.9, 0.8, 0.7];
    const f = this.firePos();
    m.tube(this.p(-0.35, 0.2, -HZ + 0.55), this.p(0.35, 0.2, -HZ + 0.65), 0.07, 0.07, 6);
    m.tube(this.p(-0.3, 0.2, -HZ + 0.72), this.p(0.3, 0.22, -HZ + 0.5), 0.06, 0.06, 6);
    cut.layer = L.Fire; cut.tint = [1, 1, 1]; cut.ao = 1;
    const ang = Math.atan2(this.sin, this.cos);
    for (let k = 0; k < 3; k++) cut.card([f[0], f[1] - 0.15, f[2]], 0.75, 0.6, ang + (k * Math.PI) / 3, [0, 1, 0], 0);

    // couch facing the fire, rug between
    m.layer = L.Fabric; m.tint = [0.75, 0.3, 0.22];
    this.box(m, [-1.0, 0, 0.45, 1.0, 0.45, 1.25]);
    this.box(m, [-1.0, 0.45, 1.05, 1.0, 0.95, 1.3]);
    this.box(m, [-1.2, 0, 0.45, -1.0, 0.65, 1.3]);
    this.box(m, [1.0, 0, 0.45, 1.2, 0.65, 1.3]);
    m.tint = [0.55, 0.45, 0.25];
    this.box(m, [-0.8, 0.45, 0.55, -0.05, 0.55, 1.05], false);
    this.box(m, [0.05, 0.45, 0.55, 0.8, 0.55, 1.05], false);
    m.tint = [0.35, 0.42, 0.62];
    this.box(m, [-1.3, 0, -1.25, 1.3, 0.02, 0.35], false);
  }
}
