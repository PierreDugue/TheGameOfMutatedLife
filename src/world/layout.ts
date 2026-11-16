import type { V2 } from '../core/math';
import type { Rng } from '../core/rng';

/** Hand-shaped parts of the valley, jittered by the seed. All in metres. */
export interface Layout {
  /** River centre line control points, from the upstream edge, through the pond, to the downstream edge. */
  river: V2[];
  /** Pond: centre, radii, rotation. */
  pond: { c: V2; rx: number; rz: number; rot: number };
  /** River water level at the upstream edge and at the downstream edge (the pond sits at 0). */
  riverTop: number;
  riverBottom: number;
}

export function makeLayout(rng: Rng): Layout {
  const j = (v: number, a: number): number => v + rng.range(-a, a);
  const flip = rng.chance(0.5) ? 1 : -1; // mirror the valley for variety
  const pond = { c: [j(4, 4) * flip, j(4, 4)] as V2, rx: j(15, 2), rz: j(11, 1.5), rot: rng.range(0, Math.PI) };
  const P = (x: number, z: number, a = 3): V2 => [j(x, a) * flip, j(z, a)];
  const river: V2[] = [
    P(-84, -46, 0), P(-66, -40), P(-50, -26), P(-38, -14), P(-24, -10), P(-12, -2),
    pond.c,
    P(20, 16), P(26, 30), P(38, 36), P(50, 50), P(64, 54), P(84, 62, 0),
  ];
  return { river, pond, riverTop: 1.8, riverBottom: -1.6 };
}

/** Preset viewpoints: eye (x, height above ground, z) and target (x, y, z). Filled once the terrain exists. */
export type Pose = [number, number, number, number, number, number];
