import { CELL, HALF, N } from '../config';
import { GRID_NV, type Terrain } from './terrain';

/** Water vertex: position (3), flow x / z (2), still-water depth below the surface (1). */
export const WATER_STRIDE = 6;

/**
 * The water surface of the river and the pond as one mesh on the terrain grid: a cell is kept when every corner
 * has a water level and at least one corner's ground lies below it. The terrain hides the parts above the banks.
 */
export function waterMesh(T: Terrain): { vb: Float32Array<ArrayBuffer>; ib: Uint32Array<ArrayBuffer> } {
  const NV = GRID_NV, map = new Int32Array(NV * NV).fill(-1), v: number[] = [], ix: number[] = [];
  const vert = (o: number): number => {
    if (map[o] < 0) {
      const i = o % NV, k = Math.floor(o / NV);
      map[o] = v.length / WATER_STRIDE;
      v.push(-HALF + i * CELL, T.WL[o], -HALF + k * CELL, T.FX[o], T.FZ[o], T.WL[o] - T.H[o]);
    }
    return map[o];
  };
  for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) {
    const a = k * NV + i, b = a + 1, c = a + NV, d = c + 1;
    if ([a, b, c, d].some((o) => Number.isNaN(T.WL[o]))) continue;
    if (![a, b, c, d].some((o) => T.H[o] < T.WL[o] + 0.05)) continue;
    const A = vert(a), B = vert(b), C = vert(c), D = vert(d);
    ix.push(A, C, D, A, D, B);
  }
  return { vb: new Float32Array(v), ib: new Uint32Array(ix) };
}
