import { hash2 } from './rng';

const fade = (t: number): number => t * t * (3 - 2 * t);

/**
 * 2D value noise in [-1, 1]. With `period` > 0 the lattice wraps, so the noise tiles every `period` units
 * (used for seamless textures).
 */
export function vnoise(x: number, y: number, seed: number, period = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = fade(x - ix), fy = fade(y - iy);
  const w = (v: number): number => (period > 0 ? ((v % period) + period) % period : v);
  const x0 = w(ix), x1 = w(ix + 1), y0 = w(iy), y1 = w(iy + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) * 2 - 1;
}

/** Fractal sum of value noise, roughly in [-1, 1]. */
export function fbm(x: number, y: number, seed: number, octaves = 4, period = 0): number {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * vnoise(x * f, y * f, seed + i * 101, period > 0 ? period * f : 0);
    n += a; a *= 0.5; f *= 2;
  }
  return s / n;
}

/** Cellular (Worley F1) noise in [0, ~1], optionally tiling. */
export function worley(x: number, y: number, seed: number, period = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    let cx = ix + i, cy = iy + j;
    if (period > 0) { cx = ((cx % period) + period) % period; cy = ((cy % period) + period) % period; }
    const px = ix + i + hash2(cx, cy, seed), py = iy + j + hash2(cx, cy, seed + 7);
    best = Math.min(best, Math.hypot(px - x, py - y));
  }
  return best;
}
