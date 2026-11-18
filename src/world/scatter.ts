import { HALF } from '../config';
import { smoothstep, type V3 } from '../core/math';
import { fbm, vnoise } from '../core/noise';
import { Rng } from '../core/rng';
import { MeshBuilder, type Mesh } from './meshkit';
import { birch, broadleaf, bush, conifer, willow } from './flora/plants';
import type { Terrain } from './terrain';
import { L } from './textures';

const UP: V3 = [0, 1, 0];

/** Bridson Poisson-disc samples in the square [-ext, ext]², at least `r` apart. */
function poisson(rng: Rng, ext: number, r: number): [number, number][] {
  const cs = r / Math.SQRT2, n = Math.ceil((2 * ext) / cs), grid = new Int32Array(n * n).fill(-1);
  const pts: [number, number][] = [], active: number[] = [];
  const put = (x: number, z: number): void => {
    pts.push([x, z]); active.push(pts.length - 1);
    grid[Math.floor((z + ext) / cs) * n + Math.floor((x + ext) / cs)] = pts.length - 1;
  };
  put(rng.range(-ext, ext), rng.range(-ext, ext));
  while (active.length) {
    const ai = Math.floor(rng.next() * active.length), [px, pz] = pts[active[ai]];
    let found = false;
    for (let t = 0; t < 20 && !found; t++) {
      const a = rng.range(0, Math.PI * 2), d = rng.range(r, 2 * r), x = px + Math.cos(a) * d, z = pz + Math.sin(a) * d;
      if (Math.abs(x) >= ext || Math.abs(z) >= ext) continue;
      const gx = Math.floor((x + ext) / cs), gz = Math.floor((z + ext) / cs);
      let ok = true;
      for (let j = Math.max(0, gz - 2); j <= Math.min(n - 1, gz + 2) && ok; j++) for (let i = Math.max(0, gx - 2); i <= Math.min(n - 1, gx + 2); i++) {
        const q = grid[j * n + i];
        if (q >= 0 && (pts[q][0] - x) ** 2 + (pts[q][1] - z) ** 2 < r * r) { ok = false; break; }
      }
      if (ok) { put(x, z); found = true; }
    }
    if (!found) active.splice(ai, 1);
  }
  return pts;
}

export interface Scatter { solid: Mesh; cutout: Mesh; counts: Record<string, number> }

/** Places every static plant and rock in the valley. */
/** `clear`: spots (x, z, radius) kept free of trees and bushes, e.g. around the preset viewpoints. */
/** `keepOut`: a spot (x, z, radius) also kept free of rocks and mushrooms (the cabin site; grass is hidden by shader). */
export function scatter(T: Terrain, seed: number, clear: [number, number, number][] = [], keepOut: [number, number, number] | null = null): Scatter {
  const rng = new Rng(seed ^ 0x5ca7), solid = new MeshBuilder(), cut = new MeshBuilder();
  const counts: Record<string, number> = { trees: 0, bushes: 0, rocks: 0, grass: 0, reeds: 0, lilies: 0, mushrooms: 0 };
  const EXT = HALF - 4;
  const slope = (x: number, z: number): number => 1 - T.normalAt(x, z)[1];
  const edge = (x: number, z: number): number => Math.max(Math.abs(x), Math.abs(z)) * 0.75 + Math.hypot(x, z) * 0.25;
  const forest = (x: number, z: number): number => fbm(x * 0.03, z * 0.03, seed + 40, 3);
  if (keepOut) clear = [...clear, keepOut];
  const blocked = (x: number, z: number, r: number): boolean => clear.some(([cx, cz, cr]) => (x - cx) ** 2 + (z - cz) ** 2 < (cr + r) ** 2);
  const out = (x: number, z: number, r: number): boolean => !!keepOut && (x - keepOut[0]) ** 2 + (z - keepOut[1]) ** 2 < (keepOut[2] + r) ** 2;

  // ---- trees ----
  const tr = rng.fork(1);
  for (const [x, z] of poisson(tr, EXT, 5)) {
    const d = T.shoreDist(x, z), s = slope(x, z), e = edge(x, z);
    if (d < 2.2 || s > 0.35 || blocked(x, z, 3)) continue;
    const f = forest(x, z);
    if (tr.next() > smoothstep(-0.35, 0.25, f) * 0.9 + (d < 7 ? 0.25 : 0)) continue;
    const p: V3 = [x, T.groundAt(x, z), z], size = tr.range(0.8, 1.25);
    if (d < 6.5 && tr.chance(0.55)) {
      // lean toward the water (down the shore-distance gradient)
      const gx = T.shoreDist(x + 1, z) - T.shoreDist(x - 1, z), gz = T.shoreDist(x, z + 1) - T.shoreDist(x, z - 1), gl = Math.hypot(gx, gz) || 1;
      willow(solid, cut, tr, p, size, [-gx / gl, -gz / gl]);
    } else if (e > 46 || (f > 0.2 && vnoise(x * 0.05, z * 0.05, seed + 41) > 0.1)) conifer(solid, tr, p, size);
    else if (vnoise(x * 0.04, z * 0.04, seed + 42) > 0.35) birch(solid, tr, p, size);
    else broadleaf(solid, tr, p, size);
    counts.trees++;
  }

  // ---- bushes ----
  const br = rng.fork(2);
  for (const [x, z] of poisson(br, EXT, 2.6)) {
    const d = T.shoreDist(x, z);
    if (d < 0.8 || slope(x, z) > 0.4 || blocked(x, z, 1)) continue;
    if (br.next() > 0.1 + 0.35 * smoothstep(-0.4, 0.3, forest(x, z)) + (d < 4 ? 0.15 : 0)) continue;
    bush(solid, br, [x, T.groundAt(x, z) - 0.1, z], br.range(0.7, 1.3), br.chance(0.3));
    counts.bushes++;
  }

  // ---- rocks ----
  const rr = rng.fork(3);
  const rock = (x: number, z: number, r: number): void => {
    if (out(x, z, r)) return;
    solid.layer = L.Rock;
    const g = rr.range(0.75, 1.1);
    solid.tint = [g * rr.range(0.95, 1.1), g, g * rr.range(0.85, 1)]; solid.ao = 1;
    const y = T.groundAt(x, z);
    solid.blob([x, y - r * 0.3, z], [r * rr.range(0.9, 1.4), r * rr.range(0.55, 0.9), r * rr.range(0.9, 1.3)], r > 0.6 ? 2 : 1, rr.next() * 100, 0.22, 0, rr.next() * 6);
    counts.rocks++;
  };
  for (let n = 0; n < 160; n++) { // boulders, often in small clusters, more on the hills
    const x = rr.range(-EXT, EXT), z = rr.range(-EXT, EXT);
    if (rr.next() > 0.25 + smoothstep(30, 60, edge(x, z))) continue;
    const big = rr.range(0.6, 1.8), k = rr.int(1, 4);
    for (let c = 0; c < k; c++) rock(x + rr.range(-2, 2) * (c > 0 ? 1 : 0), z + rr.range(-2, 2) * (c > 0 ? 1 : 0), c ? big * rr.range(0.3, 0.6) : big);
  }
  for (let n = 0; n < 500; n++) { // stones and pebbles, mostly by the water
    const x = rr.range(-EXT, EXT), z = rr.range(-EXT, EXT), d = T.shoreDist(x, z);
    if (rr.next() > (Math.abs(d) < 3 ? 0.9 : 0.15)) continue;
    rock(x, z, rr.range(0.1, 0.35));
  }
  for (let n = 0; n < 120; n++) { // river bed stones
    const s = T.river[rr.int(0, T.river.length - 1)], o = rr.range(-1, 1) * s.w * 0.9;
    rock(s.x - s.tz * o, s.z + s.tx * o, rr.range(0.12, 0.45));
  }

  // ---- mushrooms: small clusters on the forest floor, drawn only in fall (the sway slot holds when each comes up) ----
  const mu = rng.fork(7);
  const CAPS: V3[] = [[0.78, 0.52, 0.32], [1.0, 0.86, 0.62], [0.95, 0.68, 0.3], [0.55, 0.36, 0.22]];
  for (let n = 0; n < 700; n++) {
    const cx = mu.range(-EXT, EXT), cz = mu.range(-EXT, EXT);
    if (out(cx, cz, 1) || T.shoreDist(cx, cz) < 1.5 || slope(cx, cz) > 0.3 || mu.next() > smoothstep(-0.15, 0.35, forest(cx, cz))) continue;
    const cap = mu.chance(0.15) ? [1.1, 0.22, 0.14] as V3 : mu.pick(CAPS), comes = mu.range(0.1, 0.75), k = mu.int(1, 5);
    for (let c = 0; c < k; c++) {
      const x = cx + (c ? mu.range(-0.6, 0.6) : 0), z = cz + (c ? mu.range(-0.6, 0.6) : 0), y = T.groundAt(x, z) - 0.02;
      const s = mu.range(0.7, 1.3), h = 0.11 * s, rc = 0.12 * s;
      solid.layer = L.Fungus; solid.ao = 1;
      solid.tint = [1, 0.96, 0.88];
      solid.tube([x, y, z], [x, y + h, z], 0.025 * s, 0.02 * s, 5, comes, comes, false);
      solid.tint = cap.map((v) => v * mu.range(0.9, 1.1)) as V3;
      solid.blob([x, y + h, z], [rc, rc * 0.5, rc], 1, mu.next() * 100, 0.1, comes, 0, true);
    }
    counts.mushrooms++;
  }

  // ---- grass, flowers (jittered grid, 3 crossed cards per clump) ----
  const gr = rng.fork(4), step = 0.55;
  for (let z = -EXT; z < EXT; z += step) for (let x = -EXT; x < EXT; x += step) {
    const px = x + gr.range(0, step), pz = z + gr.range(0, step);
    const d = T.shoreDist(px, pz);
    if (d < 0.3) continue;
    const g = T.matAt(px, pz, 0), dirt = T.matAt(px, pz, 1), sand = T.matAt(px, pz, 2), rk = T.matAt(px, pz, 3);
    const p = g - dirt * 0.6 - sand * 1.2 - rk * 1.5 - slope(px, pz) * 2 + 0.15;
    if (gr.next() > p * 1.4) continue;
    const y = T.groundAt(px, pz), lush = smoothstep(12, 1, d), dry = smoothstep(30, 65, edge(px, pz));
    const flowers = vnoise(px * 0.15, pz * 0.15, seed + 43) > 0.45 && gr.chance(0.5);
    cut.layer = flowers ? L.Flowers : L.Blades;
    const v = gr.range(0.85, 1.1);
    cut.tint = [v * (1 + dry * 0.35 - lush * 0.1), v * (1 + lush * 0.1 - dry * 0.05), v * (1 - dry * 0.3)]; cut.ao = 1;
    const h = gr.range(0.35, 0.6) * (1 + lush * 0.5), w = h * 1.3, a0 = gr.range(0, Math.PI);
    for (let c = 0; c < 3; c++) cut.card([px, y - 0.03, pz], w, h, a0 + (c * Math.PI) / 3, UP, 0.1 * h);
    counts.grass++;
  }

  // ---- reeds along the shore ----
  const re = rng.fork(5);
  for (let z = -EXT; z < EXT; z += 0.7) for (let x = -EXT; x < EXT; x += 0.7) {
    const px = x + re.range(0, 0.7), pz = z + re.range(0, 0.7), d = T.shoreDist(px, pz);
    if (d < -1.4 || d > 0.9) continue;
    if (vnoise(px * 0.18, pz * 0.18, seed + 44) < 0.0 || re.next() > 0.7) continue;
    cut.layer = L.Reed; cut.tint = [re.range(0.9, 1.1), re.range(0.9, 1.1), 1]; cut.ao = 1;
    const h = re.range(1.1, 1.9), a0 = re.range(0, Math.PI), y = T.groundAt(px, pz);
    for (let c = 0; c < 2; c++) cut.card([px, y - 0.05, pz], 0.9, h, a0 + (c * Math.PI) / 2, UP, 0.12);
    counts.reeds++;
  }

  // ---- lily pads on the pond ----
  const li = rng.fork(6);
  for (let z = -EXT; z < EXT; z += 1.1) for (let x = -EXT; x < EXT; x += 1.1) {
    const px = x + li.range(0, 1.1), pz = z + li.range(0, 1.1);
    if (T.pondQ(px, pz) > 0.88 || T.waterAt(px, pz) !== 0) continue;
    if (vnoise(px * 0.12, pz * 0.12, seed + 45) < 0.3 || li.next() > 0.45) continue;
    cut.layer = li.chance(0.12) ? L.LilyFlower : L.Lily; cut.tint = [1, 1, 1]; cut.ao = 1;
    cut.flat([px, 0.015 + li.range(0, 0.008), pz], li.range(0.55, 1.0), li.range(0, Math.PI * 2), 0.02);
    counts.lilies++;
  }

  return { solid: solid.build(), cutout: cut.build(), counts };
}
