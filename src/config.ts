// World-wide constants.

/** Terrain grid: N × N cells of CELL metres, centred on the origin. */
export const N = 320;
export const CELL = 0.5;
export const HALF = (N * CELL) / 2; // 80 m
/** The camera may roam inside this half-extent; the rest is hills hiding the edge. */
export const ROAM = 62;

/** Size of one low-resolution pixel, in CSS pixels (the `P` key toggles it with 1). */
export const PIXEL = 3;
/** Colour levels per channel after quantisation (with ordered dithering). */
export const LEVELS = 24;

/** Texture tiles: TEX × TEX texels, TEXEL_PER_M texels per metre in world-projected materials. */
export const TEX = 32;
export const TEXEL_PER_M = 16;

/** Sun shadow map resolution. */
export const SHADOW_SIZE = 4096;

/** Default seed (overridable with ?seed=… in the URL or the menu). */
export const DEFAULT_SEED = 1337;
