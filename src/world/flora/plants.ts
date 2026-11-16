import { add, scale, type V3 } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { MeshBuilder } from '../meshkit';
import { L } from '../textures';

const UP: V3 = [0, 1, 0];
const hsvTint = (r: number, g: number, b: number, v: number): V3 => [r * v, g * v, b * v];

// ---------- trees (solid) ----------

/** Broadleaf tree: trunk, a few branches, lumpy foliage blobs at their ends. */
export function broadleaf(m: MeshBuilder, rng: Rng, p: V3, size: number): void {
  const h = rng.range(3, 5) * size, r = 0.18 * size;
  m.layer = L.Bark; m.tint = [1, 1, 1]; m.ao = 1;
  const lean: V3 = [rng.range(-0.3, 0.3), 0, rng.range(-0.3, 0.3)];
  const top = add(p, add([0, h, 0], lean));
  m.tube(add(p, [0, -0.3, 0]), top, r, r * 0.6, 7, 0, 0.02);
  const tint = hsvTint(1 + rng.range(-0.1, 0.15), 1 + rng.range(-0.1, 0.1), 1, rng.range(0.85, 1.1));
  const blobs: [V3, number][] = [[add(top, [0, 0.9 * size, 0]), 1.7 * size]];
  const nb = rng.int(3, 5);
  for (let b = 0; b < nb; b++) {
    const a = (b / nb) * Math.PI * 2 + rng.range(-0.4, 0.4), from = rng.range(0.55, 0.85);
    const s = add(p, add([0, h * from, 0], scale(lean, from)));
    const len = rng.range(1.2, 2) * size;
    const e = add(s, [Math.cos(a) * len, len * rng.range(0.5, 0.9), Math.sin(a) * len]);
    m.layer = L.Bark; m.tint = [1, 1, 1];
    m.tube(s, e, r * 0.45, r * 0.25, 5, 0, 0.04, false);
    blobs.push([e, rng.range(1.1, 1.5) * size]);
  }
  m.layer = L.Leaves; m.tint = tint;
  for (const [c, br] of blobs) {
    m.ao = 1;
    m.blob(c, [br, br * 0.8, br], 1, rng.next() * 100, 0.25, 0.08, rng.next() * 6);
  }
}

/** Conifer: straight trunk, stacked cones. */
export function conifer(m: MeshBuilder, rng: Rng, p: V3, size: number): void {
  const h = rng.range(5, 8) * size;
  m.layer = L.Bark; m.tint = [0.85, 0.8, 0.8]; m.ao = 1;
  m.tube(add(p, [0, -0.3, 0]), add(p, [0, h * 0.5, 0]), 0.2 * size, 0.12 * size, 6);
  m.layer = L.Needles; m.tint = hsvTint(1, 1, 1, rng.range(0.85, 1.15));
  const tiers = rng.int(4, 5);
  for (let t = 0; t < tiers; t++) {
    const f = t / tiers, y0 = h * (0.18 + f * 0.62), rr = (1 - f * 0.75) * 1.9 * size;
    m.tube(add(p, [0, y0, 0]), add(p, [0, y0 + h * 0.36, 0]), rr, 0, 8, 0.02, 0.1, false, rng.next() * 3);
    // underside
    const c = add(p, [0, y0, 0]);
    for (let k = 0; k < 8; k++) {
      const a0 = (k / 8) * Math.PI * 2, a1 = ((k + 1) / 8) * Math.PI * 2;
      m.flatTri(c, add(c, [Math.cos(a0) * rr, 0, Math.sin(a0) * rr]), add(c, [Math.cos(a1) * rr, 0, Math.sin(a1) * rr]));
    }
  }
}

/** Birch: thin white trunk, small light canopy. */
export function birch(m: MeshBuilder, rng: Rng, p: V3, size: number): void {
  const h = rng.range(4.5, 6.5) * size;
  const lean: V3 = [rng.range(-0.5, 0.5), 0, rng.range(-0.5, 0.5)];
  const top = add(p, add([0, h, 0], lean));
  m.layer = L.Birch; m.tint = [1, 1, 1]; m.ao = 1;
  m.tube(add(p, [0, -0.3, 0]), top, 0.13 * size, 0.07 * size, 6, 0, 0.05);
  m.layer = L.Leaves; m.tint = [1.15, 1.2, 0.8];
  for (let b = 0; b < 4; b++) {
    const c = add(top, [rng.range(-0.8, 0.8) * size, rng.range(-1.6, 0.4) * size, rng.range(-0.8, 0.8) * size]);
    m.blob(c, [0.9 * size, 1.1 * size, 0.9 * size], 1, rng.next() * 100, 0.3, 0.12, rng.next() * 6);
  }
}

/** Willow: thick leaning trunk, a wide canopy and hanging curtains of strands (cutout cards in `cut`). */
export function willow(m: MeshBuilder, cut: MeshBuilder, rng: Rng, p: V3, size: number, leanDir: [number, number]): void {
  const h = rng.range(3.5, 4.5) * size;
  const lean: V3 = [leanDir[0] * 1.6 * size, 0, leanDir[1] * 1.6 * size];
  const top = add(p, add([0, h, 0], lean));
  m.layer = L.Bark; m.tint = [0.9, 0.9, 0.85]; m.ao = 1;
  m.tube(add(p, [0, -0.3, 0]), top, 0.32 * size, 0.2 * size, 7);
  m.layer = L.Leaves; m.tint = [1.1, 1.15, 0.75];
  const cr = 2.6 * size;
  m.blob(add(top, [0, 0.5 * size, 0]), [cr, 1.1 * size, cr], 1, rng.next() * 100, 0.2, 0.06, rng.next() * 6);
  cut.layer = L.Willow; cut.tint = [1, 1, 1]; cut.ao = 1;
  const n = 26;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng.range(-0.1, 0.1), rr = cr * rng.range(0.75, 1.0);
    const c: V3 = [top[0] + Math.cos(a) * rr, top[1] + 0.3 * size, top[2] + Math.sin(a) * rr];
    const len = rng.range(2.2, 3.4) * size;
    cut.card([c[0], c[1] - len, c[2]], 1.1 * size, len, a + Math.PI / 2, UP, -0.15);
  }
}

// ---------- low plants ----------

/** Bush: a few blobs, sometimes berries. */
export function bush(m: MeshBuilder, rng: Rng, p: V3, size: number, berries: boolean): void {
  m.layer = L.Bush; m.tint = hsvTint(1 + rng.range(-0.1, 0.2), 1, 1, rng.range(0.85, 1.15)); m.ao = 1;
  const nb = rng.int(2, 4), pts: V3[] = [];
  for (let b = 0; b < nb; b++) {
    const r = rng.range(0.45, 0.8) * size;
    const c = add(p, [rng.range(-0.5, 0.5) * size, r * 0.55, rng.range(-0.5, 0.5) * size]);
    m.blob(c, [r, r * 0.8, r], 1, rng.next() * 100, 0.3, 0.05, rng.next() * 6);
    pts.push(c);
  }
  if (!berries) return;
  m.layer = L.Berry; m.tint = [1, 1, 1];
  for (let k = 0; k < 10; k++) {
    const c = rng.pick(pts), a = rng.range(0, Math.PI * 2), e = rng.range(-0.2, 0.9);
    const r = 0.55 * size;
    const b: V3 = add(c, [Math.cos(a) * r * Math.cos(e), Math.sin(e) * r * 0.8, Math.sin(a) * r * Math.cos(e)]);
    m.blob(b, [0.06, 0.06, 0.06], 0, k, 0, 0.03);
  }
}
