import { CORE_IN, isActuator, PartType, SENSE_CH, SIZES, SOCKET_DIR, SOCKETS, STANDARD, WLEN, type Genome } from './genome';

type V3 = [number, number, number];

/** A part placed in the colony's frame (x = front, y = up). */
export interface Placed {
  type: PartType;
  /** Where it attaches, the direction it points, the surface normal at the attachment. */
  base: V3;
  dir: V3;
  normal: V3;
  length: number;
  thick: number;
  segments: number;
  p1: number;
  /** Socket index on its cell, and which cell of the colony. */
  index: number;
  cell: number;
}

/** A cell body in the colony frame (round cells: rx = ry = rz). */
export interface Body { c: V3; rx: number; ry: number; rz: number; type: number }

/** Volume of the reference cell (radius 2 cm). */
export const V0 = (4 / 3) * Math.PI * 0.02 ** 3;

/** Strides of the packed per-part physics arrays. */
export const ACT = 13; // base xyz, force dir xyz, force, bed force, tip xyz, kind, cell
export const EYE = 6; // dir xyz, cos half-angle, range, brain input index (positions in eyePos)
export const CHEMO = 4; // pos xyz, brain input index
export const MOUTH = 7; // pos xyz, dir xyz, gape

/**
 * Everything the simulation needs from a genome, computed once per organism (and again when a colony grows a
 * cell): the placed parts, drag, costs, and the brain as one weight row per output.
 */
export interface Phenotype {
  bodies: Body[];
  /** Cells expressed (a newborn colony grows its cells one by one). */
  built: number;
  /** Equivalent body radius (predation size) and bounding radius including parts. */
  size: number;
  bound: number;
  placed: Placed[];
  /** Linear drag per local axis (overdamped: velocity = force / drag) and rotational drag. */
  kx: number; ky: number; kz: number; kRot: number;
  act: Float32Array; nAct: number;
  eyes: Float32Array; eyePos: Float32Array; nEye: number;
  chemo: Float32Array; nChemo: number;
  mouths: Float32Array; nMouth: number;
  /** Chloroplast patches: normal xyz, area. */
  photo: Float32Array; nPhoto: number;
  spikes: number; shells: number;
  /** Total cell cross-section (in reference-cell units): caps the light a colony can catch. */
  crossA: number;
  upkeep: number;
  divideAt: number;
  /**
   * Brain: inputs are CORE_IN core values then SOCKETS × SENSE_CH sensor values per cell; output j (0 = tumble,
   * then one per actuator) reads the core inputs and the sensors of its own cell (`outCell`) with WLEN weights.
   */
  nIn: number; nOut: number;
  w: Float32Array; outCell: Int32Array;
}

const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const madd = (a: V3, b: V3, k: number): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/** Lays out the colony: root cell at the origin, each further cell against its parent's adhesion socket. */
export function place(g: Genome, built = g.cells.length): { bodies: Body[]; placed: Placed[] } {
  const bodies: Body[] = [], placed: Placed[] = [];
  for (let ci = 0; ci < Math.min(built, g.cells.length); ci++) {
    const cg = g.cells[ci], t = g.types[cg.type], r = SIZES[t.size];
    let c: V3 = [0, 0, 0];
    if (ci > 0) {
      const p = bodies[cg.parent];
      if (!p) break;
      c = madd(p.c, SOCKET_DIR[cg.site], p.rx + r * 0.95);
    }
    bodies.push({ c, rx: r, ry: r, rz: r, type: cg.type });
    t.sockets.forEach((s, si) => {
      if (s.type < 0) return;
      const n = SOCKET_DIR[si], S = STANDARD[s.type as PartType];
      // limbs angle down and back, so pushing on the bed moves the body
      const dir = s.type === PartType.Limb ? norm([n[0] - 0.45, n[1] - 0.6, n[2]]) : n;
      placed.push({ type: s.type, base: madd(c, n, r), dir, normal: n, length: S.len, thick: S.thick, segments: S.seg, p1: S.p1, index: si, cell: ci });
    });
  }
  return { bodies, placed };
}

const BASE_COST: Record<PartType, number> = {
  [PartType.Cilia]: 0.004, [PartType.Flagellum]: 0.006, [PartType.Fin]: 0.004, [PartType.Limb]: 0.006,
  [PartType.Mouth]: 0.01, [PartType.Eye]: 0.008, [PartType.Chemo]: 0.003, [PartType.Spike]: 0.003,
  [PartType.Shell]: 0.006, [PartType.Chloro]: 0.004, [PartType.Adhesion]: 0.002,
};

export function express(g: Genome, built = g.cells.length): Phenotype {
  const { bodies, placed } = place(g, built);
  let vBody = 0, bound = 0, kx = 0, ky = 0, kz = 0, kRot = 0, crossA = 0;
  for (const B of bodies) {
    const r = B.rx, off = Math.hypot(B.c[0], B.c[1], B.c[2]);
    vBody += (4 / 3) * Math.PI * r ** 3;
    bound = Math.max(bound, off + r);
    kx += 6 * r; ky += 6 * r; kz += 6 * r;
    kRot += 10 * r ** 3 + 6 * r * off * off;
    crossA += (r / 0.02) ** 2;
  }
  const size = Math.cbrt(vBody / ((4 / 3) * Math.PI));
  // gluing cells together costs a little upkeep per extra cell
  let upkeep = 0.03 * (vBody / V0) + 0.004 * (bodies.length - 1), vParts = 0;
  const act: number[] = [], eyes: number[] = [], eyePos: number[] = [], chemo: number[] = [], mouths: number[] = [], photo: number[] = [];
  const w: number[] = [], outCell: number[] = [0];
  for (let i = 0; i < WLEN; i++) w.push(g.tumble[i] ?? 0);
  let spikes = 0, shells = 0;
  for (const P of placed) {
    const L = P.length, t = P.thick, u = P.dir, b = P.base, n = P.normal;
    const reach = Math.hypot(b[0], b[1], b[2]);
    bound = Math.max(bound, reach + L);
    let vol = Math.PI * (t / 2) ** 2 * L;
    // drag: rods resist moving across them more than along; fins and shells resist across their face
    if (P.type === PartType.Fin) {
      const area = Math.sqrt(L * t);
      kx += 3 * area * (1 - Math.abs(n[0])); ky += 3 * area; kz += 3 * area * (1 - Math.abs(n[2]));
      vol = L * t * 0.002;
    } else if (P.type === PartType.Shell) {
      kx += 2 * L; ky += 2 * L; kz += 2 * L;
      vol = L * L * t;
    } else {
      const k = (P.type === PartType.Cilia ? 1.5 : 3) * L;
      kx += k * (1 - 0.5 * u[0] * u[0]); ky += k * (1 - 0.5 * u[1] * u[1]); kz += k * (1 - 0.5 * u[2] * u[2]);
    }
    kRot += 3 * L * (reach + L / 2) ** 2;
    vParts += vol;
    upkeep += BASE_COST[P.type] + 0.12 * (vol / V0);
    const sensorIx = CORE_IN + (P.cell * SOCKETS + P.index) * SENSE_CH;

    if (isActuator(P.type)) {
      const f = Math.sqrt(P.p1 / 2);
      const force = P.type === PartType.Cilia ? 0.35 * L : P.type === PartType.Flagellum ? 0.25 * L * f : P.type === PartType.Fin ? 0.12 * L * f : 0.08 * L * f;
      const bed = P.type === PartType.Limb ? 0.6 * L * f * Math.min(P.segments, 3) / 2 : 0;
      const tip = madd(b, u, L);
      act.push(b[0], b[1], b[2], -u[0], -u[1], -u[2], force, bed, tip[0], tip[1], tip[2], P.type, P.cell);
      const sw = g.types[g.cells[P.cell].type].sockets[P.index].w;
      for (let i = 0; i < WLEN; i++) w.push(sw[i] ?? 0);
      outCell.push(P.cell);
    } else if (P.type === PartType.Eye) {
      const ap = P.p1;
      eyes.push(u[0], u[1], u[2], Math.cos(ap), Math.min(0.75, t * 80 * (1.3 - ap * 0.5)), sensorIx);
      eyePos.push(b[0], b[1], b[2]);
    } else if (P.type === PartType.Chemo) {
      const tip = madd(b, u, L);
      chemo.push(tip[0], tip[1], tip[2], sensorIx);
    } else if (P.type === PartType.Mouth) {
      mouths.push(b[0], b[1], b[2], u[0], u[1], u[2], P.p1);
    } else if (P.type === PartType.Chloro) {
      photo.push(n[0], n[1], n[2], (L / 0.02) ** 2);
    } else if (P.type === PartType.Spike) spikes += P.p1;
    else if (P.type === PartType.Shell) shells += 1;
  }

  return {
    bodies, built: bodies.length, size, bound, placed, kx, ky, kz, kRot, crossA,
    act: new Float32Array(act), nAct: act.length / ACT,
    eyes: new Float32Array(eyes), eyePos: new Float32Array(eyePos), nEye: eyes.length / EYE,
    chemo: new Float32Array(chemo), nChemo: chemo.length / CHEMO,
    mouths: new Float32Array(mouths), nMouth: mouths.length / MOUTH,
    photo: new Float32Array(photo), nPhoto: photo.length / 4,
    spikes, shells, upkeep,
    divideAt: Math.max(4, 8 * ((vBody + vParts) / V0) + 0.3 * placed.length),
    nIn: CORE_IN + bodies.length * SOCKETS * SENSE_CH, nOut: outCell.length,
    w: new Float32Array(w), outCell: new Int32Array(outCell),
  };
}
