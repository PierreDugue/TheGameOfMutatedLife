import { TEX } from '../config';
import { clamp } from '../core/math';
import { fbm, vnoise, worley } from '../core/noise';
import { hash2, Rng } from '../core/rng';

/** Texture array layers. */
export enum L {
  Grass, Dirt, Sand, Rock, Mud, Bark, Leaves, Needles, Willow, Blades, Flowers, Reed, Lily, LilyFlower, Bush, Berry, Water, Birch,
  /** Mushrooms (pale, tinted per mushroom); only drawn in fall. */
  Fungus,
  Count,
}

type RGBA = [number, number, number, number];
type Px = (x: number, y: number) => RGBA;

const C = (hex: number, a = 255): RGBA => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, a];
const mix = (a: RGBA, b: RGBA, t: number): RGBA => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
/** Snap a 0..1 value onto one of `n` ramp entries (keeps the palette small and the texels crisp). */
const ramp = (cols: RGBA[], t: number): RGBA => cols[clamp(Math.floor(t * cols.length), 0, cols.length - 1)];
const CLEAR: RGBA = [0, 0, 0, 0];

/** Periodic noise over the tile: `f` = lattice cells across the tile. */
const tn = (x: number, y: number, f: number, seed: number, oct = 3): number => 0.5 + 0.5 * fbm((x / TEX) * f, (y / TEX) * f, seed, oct, f);

/** Paints the layers, each TEX × TEX texels, RGBA8 (sRGB). */
export function paintTextures(seed: number): Uint8Array[] {
  const rng = new Rng(seed ^ 0x51ed);
  const layers: Uint8Array[] = [];
  const fill = (px: Px): void => {
    const d = new Uint8Array(TEX * TEX * 4);
    for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) d.set(px(x, y).map((v) => clamp(Math.round(v), 0, 255)), (y * TEX + x) * 4);
    layers.push(d);
  };
  const h = (x: number, y: number, s: number): number => hash2(x, y, seed + s);

  // cutout sprite painter: a list of strokes drawn into a transparent tile
  const sprite = (draw: (put: (x: number, y: number, c: RGBA) => void) => void): Px => {
    const d: RGBA[] = Array.from({ length: TEX * TEX }, () => CLEAR);
    draw((x, y, c) => {
      x = Math.round(x); y = Math.round(y);
      if (x >= 0 && x < TEX && y >= 0 && y < TEX) d[y * TEX + x] = c;
    });
    return (x, y) => d[y * TEX + x];
  };
  const blade = (put: (x: number, y: number, c: RGBA) => void, x0: number, hgt: number, lean: number, cols: RGBA[], w = 1): void => {
    for (let t = 0; t < hgt; t++) {
      const f = t / hgt, x = x0 + lean * f * f * hgt;
      const c = ramp(cols, f);
      for (let k = 0; k < (f < 0.6 ? w : 1); k++) put(x + k, TEX - 1 - t, c);
    }
  };

  // Grass
  const G = [C(0x2f5a1e), C(0x3c7024), C(0x4a842a), C(0x5c9a30), C(0x74b03a)];
  fill((x, y) => {
    let t = tn(x, y, 4, seed + 1) * 0.7 + h(x, y, 2) * 0.3;
    if (h(x >> 1, y, 3) > 0.93) t += 0.25; // light blade tips
    if (h(x, y >> 1, 4) > 0.94) t -= 0.3;
    return ramp(G, t);
  });
  // Dirt
  const D = [C(0x3d2a1a), C(0x553a22), C(0x6b4a2c), C(0x7d5934), C(0x94704a)];
  fill((x, y) => {
    let t = tn(x, y, 4, seed + 5) * 0.6 + h(x, y, 6) * 0.4;
    if (worley((x / TEX) * 6, (y / TEX) * 6, seed + 7, 6) < 0.18) t = 0.85 + h(x, y, 8) * 0.15; // pebbles
    return ramp(D, t);
  });
  // Sand
  const S = [C(0xa38a5c), C(0xb89c68), C(0xc9ae78), C(0xd8c08a), C(0xe6d29c)];
  fill((x, y) => {
    const rip = Math.sin(((y + 2 * vnoise((x / TEX) * 4, 0, seed + 9, 4)) / TEX) * Math.PI * 8) * 0.5 + 0.5;
    return ramp(S, tn(x, y, 4, seed + 10) * 0.4 + rip * 0.25 + h(x, y, 11) * 0.35);
  });
  // Rock
  const R = [C(0x3a3a3e), C(0x4c4b4e), C(0x5e5c5c), C(0x716e6a), C(0x88847c), C(0x9c978c)];
  fill((x, y) => {
    let t = tn(x, y, 3, seed + 12, 4) * 0.65 + h(x, y, 13) * 0.25;
    const w = worley((x / TEX) * 4, (y / TEX) * 4, seed + 14, 4);
    if (w > 0.62) t -= 0.35; // cracks between plates
    if ((y + Math.floor(tn(x, 0, 2, seed + 15) * 6)) % 11 === 0) t -= 0.15; // faint bedding
    return ramp(R, t + 0.1);
  });
  // Mud
  const M = [C(0x2a2418), C(0x342c1c), C(0x403522), C(0x4e4228)];
  fill((x, y) => {
    const t = tn(x, y, 4, seed + 16) * 0.7 + h(x, y, 17) * 0.3;
    return h(x, y, 18) > 0.97 ? C(0x6a6040) : ramp(M, t);
  });
  // Bark (vertical grooves)
  const B = [C(0x2a1c12), C(0x3b2818), C(0x4c3420), C(0x5e432a), C(0x6e5234)];
  fill((x, y) => {
    const g = tn(x * 3, y * 0.4, 4, seed + 19);
    let t = g * 0.75 + h(x, y, 20) * 0.25;
    if (Math.abs(Math.sin((x / TEX) * Math.PI * 6 + g * 3)) < 0.18) t -= 0.4;
    return ramp(B, t);
  });
  // Leaves (broadleaf canopy)
  const LV = [C(0x1d3d14), C(0x2a5419), C(0x386a1f), C(0x478026), C(0x5a962e), C(0x74ad3a)];
  fill((x, y) => {
    const w = worley((x / TEX) * 6, (y / TEX) * 6, seed + 21, 6);
    const t = (1 - w) * 0.75 + h(x, y, 22) * 0.25 + (w > 0.75 ? -0.5 : 0);
    return ramp(LV, t);
  });
  // Needles (conifer)
  const ND = [C(0x10261a), C(0x173422), C(0x1f432a), C(0x295434), C(0x37683e)];
  fill((x, y) => {
    const s = ((x + y) % 4 === 0 ? 0.3 : 0) + ((x - y + 64) % 5 === 0 ? 0.25 : 0);
    return ramp(ND, tn(x, y, 4, seed + 23) * 0.45 + s + h(x, y, 24) * 0.25);
  });
  // Willow strands (cutout): hanging lines with leaves
  fill(sprite((put) => {
    const cols = [C(0x4f7d2a), C(0x62922f), C(0x78a83a), C(0x8fbc48)];
    for (let s = 0; s < 7; s++) {
      const x0 = 2 + s * 4.3 + rng.range(-1, 1), len = rng.int(18, 31);
      for (let t = 0; t < len; t++) {
        const x = x0 + Math.sin(t * 0.25 + s) * 0.8;
        put(x, t, ramp(cols, rng.next()));
        if (t % 3 === 1) put(x + (t % 6 < 3 ? 1 : -1), t, ramp(cols, rng.next()));
      }
    }
  }));
  // Grass blades (cutout)
  const BL = [C(0x2c5a1c), C(0x3e7424), C(0x51892c), C(0x69a236), C(0x86b844)];
  const bladesTile = (flowers: boolean): Px => sprite((put) => {
    for (let b = 0; b < 16; b++) blade(put, rng.range(1, TEX - 2), rng.int(12, 30), rng.range(-0.35, 0.35), BL, b % 3 === 0 ? 2 : 1);
    if (flowers) {
      const FC = [C(0xf4f0e0), C(0xf2d040), C(0xb070d8), C(0xe85050)];
      for (let f = 0; f < 5; f++) {
        const x = rng.int(3, TEX - 4), y = rng.int(3, 14), c = rng.pick(FC);
        for (let t = y + 2; t < TEX; t++) put(x, t, BL[1 + (t & 1)]);
        put(x, y, c); put(x + 1, y, c); put(x, y + 1, c); put(x + 1, y + 1, c); put(x, y - 1, c); put(x - 1, y, c);
        put(x, y, C(0xf8e060));
      }
    }
  });
  fill(bladesTile(false));
  fill(bladesTile(true));
  // Reeds and cattails (cutout)
  fill(sprite((put) => {
    const RC = [C(0x3e5a22), C(0x52702a), C(0x688834), C(0x80a040)];
    for (let b = 0; b < 9; b++) blade(put, rng.range(2, TEX - 3), rng.int(20, 32), rng.range(-0.25, 0.25), RC, 1);
    for (let c = 0; c < 3; c++) {
      const x = 5 + c * 10 + rng.int(-2, 2), top = rng.int(1, 6);
      for (let t = top; t < TEX; t++) put(x, t, RC[t & 1]);
      for (let t = top + 2; t < top + 9; t++) { put(x, t, C(0x5a3418)); put(x + 1, t, C(t % 3 ? 0x6e4220 : 0x4a2a12)); }
    }
  }));
  // Lily pad (cutout) with and without a flower
  const lily = (flower: boolean): Px => (x, y) => {
    const dx = x - 15.5, dy = y - 15.5, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    if (r > 14.5 || (a > -0.25 && a < 0.2 && r > 1.5)) return CLEAR;
    if (flower && r < 6) {
      const petal = Math.cos(a * 6) * 0.5 + 0.5;
      if (r < 2) return C(0xf2d040);
      return r < 3.5 + petal * 2.5 ? mix(C(0xf8c8dc), C(0xe06c9c), r / 6) : C(0x3f7a2a);
    }
    const vein = Math.abs(Math.sin(a * 5)) < 0.12 && r > 3;
    const t = 0.35 + 0.3 * tn(x, y, 3, seed + 25) + (r > 13 ? 0.25 : 0) - (vein ? 0.3 : 0);
    return ramp([C(0x234c1c), C(0x2f6224), C(0x3f7a2a), C(0x569334), C(0x6aa83c)], t);
  };
  fill(lily(false));
  fill(lily(true));
  // Bush leaves
  const BU = [C(0x1a3a1c), C(0x255024), C(0x31662c), C(0x407c34), C(0x55943c)];
  fill((x, y) => {
    const w = worley((x / TEX) * 8, (y / TEX) * 8, seed + 26, 8);
    return ramp(BU, (1 - w) * 0.7 + h(x, y, 27) * 0.3 - (w > 0.7 ? 0.4 : 0));
  });
  // Berries
  fill((x, y) => {
    const w = worley((x / TEX) * 6, (y / TEX) * 6, seed + 28, 6);
    return w < 0.12 ? C(0xff9a9a) : ramp([C(0x5a0c14), C(0x8a1420), C(0xb81e2a), C(0xd8303a)], 1 - w * 1.4);
  });
  // Water ripples (grey mask, read as highlight strength by the water shader)
  fill((x, y) => {
    const n = tn(x, y, 4, seed + 29, 2);
    const band = Math.abs(Math.sin((y / TEX) * Math.PI * 4 + n * 6));
    const v = band < 0.12 ? 255 : band < 0.3 ? 120 : 0;
    return [v, v, v, 255];
  });
  // Birch bark (white with dark marks)
  fill((x, y) => {
    const mark = h(x >> 2, y >> 1, 30) > 0.86 || (y % 9 === 0 && h(x >> 3, y, 31) > 0.4);
    return mark ? C(0x2a2622) : ramp([C(0xb8b2a4), C(0xcac4b6), C(0xdcd6c8), C(0xe8e4d8)], tn(x, y, 4, seed + 32) * 0.6 + h(x, y, 33) * 0.4);
  });
  // Fungus: pale flesh with light speckles (caps and stems get their colour from the vertex tint)
  fill((x, y) => (h(x, y, 34) > 0.9 ? C(0xfff8ec) : ramp([C(0xc8bca8), C(0xd6ccb8), C(0xe2d8c6)], tn(x, y, 4, seed + 35) * 0.6 + h(x, y, 36) * 0.4)));
  return layers;
}

/** Box-filtered mip chain of one layer (alpha-weighted so cutouts don't fringe dark). */
function mips(base: Uint8Array): Uint8Array[] {
  const out = [base];
  for (let s = TEX; s > 1; s >>= 1) {
    const src = out[out.length - 1], n = s >> 1, d = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const o = ((y * 2 + j) * s + x * 2 + i) * 4, w = src[o + 3];
        r += src[o] * w; g += src[o + 1] * w; b += src[o + 2] * w; a += w;
      }
      const o = (y * n + x) * 4;
      if (a > 0) { d[o] = r / a; d[o + 1] = g / a; d[o + 2] = b / a; }
      // keep coverage a little higher so distant grass doesn't thin out to nothing
      d[o + 3] = Math.min(255, (a / 4) * 1.25);
    }
    out.push(d);
  }
  return out;
}

export function uploadTextures(device: GPUDevice, seed: number): GPUTexture {
  const layers = paintTextures(seed);
  const levels = Math.log2(TEX) + 1;
  const tex = device.createTexture({
    size: [TEX, TEX, layers.length], format: 'rgba8unorm-srgb', mipLevelCount: levels,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  layers.forEach((data, z) => mips(data).forEach((m, level) => {
    const s = TEX >> level;
    device.queue.writeTexture({ texture: tex, mipLevel: level, origin: [0, 0, z] }, m.buffer, { bytesPerRow: s * 4, rowsPerImage: s }, [s, s, 1]);
  }));
  return tex;
}
