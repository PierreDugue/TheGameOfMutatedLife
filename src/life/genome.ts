import type { Rng } from '../core/rng';

/**
 * A deliberately small design space, so selection can actually find good designs with the compute available:
 * every cell has six fixed sockets (front, back, left, right, top, bottom), each empty or holding one part of a
 * fixed, standard size that points straight out of its socket; the body comes in four sizes; the brain wires
 * sensors straight to actuators (no hidden layer) with weights that keep their meaning when parts change.
 */
export enum PartType { Cilia, Flagellum, Fin, Limb, Mouth, Eye, Chemo, Spike, Shell, Chloro, Adhesion }
export const PART_TYPES = 11;
export const PART_NAMES = ['Cilia', 'Flagellum', 'Fin', 'Limb', 'Mouth', 'Eye', 'Chemoreceptor', 'Spike', 'Shell plate', 'Chloroplasts', 'Adhesion site'];

/** Sockets: outward direction in the cell frame (x = front, y = up, z = right) and their mirror. */
export const SOCKETS = 6;
export const SOCKET_NAMES = ['at the front', 'at the back', 'on the left', 'on the right', 'on top', 'underneath'];
export const SOCKET_DIR: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, -1, 0]];
export const MIRROR = [1, 0, 3, 2, 5, 4];
/** Body radius by size class. */
export const SIZES = [0.015, 0.02, 0.027, 0.036];

/** Brain: every actuator (and the tumble reflex) has CORE_IN core weights + 3 per socket of its own cell. */
export const CORE_IN = 4; // bias, energy, light, touching the bed
export const SENSE_CH = 3; // per socket: food / prey / threat seen by an eye, or smell change for a chemoreceptor
export const WLEN = CORE_IN + SOCKETS * SENSE_CH;

export const isActuator = (t: PartType): boolean => t === PartType.Cilia || t === PartType.Flagellum || t === PartType.Fin || t === PartType.Limb;

/** Standard part geometry: length, thickness, segments, type-specific value (beat / gape / aperture / sharpness). */
export const STANDARD: Record<PartType, { len: number; thick: number; seg: number; p1: number }> = {
  [PartType.Cilia]: { len: 0.012, thick: 0.002, seg: 1, p1: 5 },
  [PartType.Flagellum]: { len: 0.04, thick: 0.0025, seg: 4, p1: 2.5 },
  [PartType.Fin]: { len: 0.022, thick: 0.014, seg: 1, p1: 1.2 },
  [PartType.Limb]: { len: 0.03, thick: 0.004, seg: 3, p1: 1.2 },
  [PartType.Mouth]: { len: 0.008, thick: 0.008, seg: 1, p1: 0.6 },
  [PartType.Eye]: { len: 0.006, thick: 0.007, seg: 1, p1: 0.8 },
  [PartType.Chemo]: { len: 0.012, thick: 0.0015, seg: 2, p1: 0 },
  [PartType.Spike]: { len: 0.015, thick: 0.003, seg: 1, p1: 0.8 },
  [PartType.Shell]: { len: 0.02, thick: 0.003, seg: 1, p1: 0 },
  [PartType.Chloro]: { len: 0.019, thick: 0.002, seg: 1, p1: 0 },
  [PartType.Adhesion]: { len: 0.005, thick: 0.005, seg: 1, p1: 0 },
};

/** A socket: empty (-1) or a part type; actuators carry their brain weights. */
export interface Socket { type: number; w: number[] }

/** One kind of cell: its size class and its six sockets. Several cells of a colony can share a type. */
export interface CellType { size: number; sockets: Socket[] }

/** A cell of the colony: its type, and the adhesion socket of its parent cell it hangs on. */
export interface CellGene { type: number; parent: number; site: number }

export interface Genome {
  types: CellType[];
  /** The colony, root first; parents always come before their children. */
  cells: CellGene[];
  hue: number;
  pattern: number;
  /** Tumble reflex weights (read from the root cell's sockets). */
  tumble: number[];
  /** Expected mutations per division. */
  mutRate: number;
  /** Recent mutations, newest last. */
  history: string[];
}

export const MAX_CELLS = 12;
const MAX_TYPES = 4;

const zeros = (): number[] => Array(WLEN).fill(0);
const randW = (rng: Rng, s = 0.5): number[] => Array.from({ length: WLEN }, () => rng.gauss() * s);
const empty = (): Socket => ({ type: -1, w: [] });

/** The first cell: a sun-eater (cilia + chloroplasts) or an eater (cilia + mouth + chemoreceptor), by seed. */
export function firstGenome(rng: Rng): Genome {
  const sunEater = rng.chance(0.5);
  const sockets = Array.from({ length: SOCKETS }, empty);
  const cilia: Socket = { type: PartType.Cilia, w: zeros() };
  sockets[1] = cilia; // at the back: pushes the cell forward
  const tumble = zeros();
  if (sunEater) {
    sockets[4] = { type: PartType.Chloro, w: [] };
    // beat by day, rest at night
    cilia.w[0] = -1.5; cilia.w[2] = 5;
    tumble[0] = -1.2;
  } else {
    sockets[0] = { type: PartType.Mouth, w: [] };
    sockets[4] = { type: PartType.Chemo, w: [] };
    // beat unless touching the bed (settle and graze); smelling more food → tumble less (chemotaxis)
    cilia.w[0] = 2.5; cilia.w[3] = -6;
    tumble[0] = -0.3; tumble[CORE_IN + 4 * SENSE_CH] = -4;
  }
  return {
    types: [{ size: 1, sockets }], cells: [{ type: 0, parent: -1, site: -1 }],
    hue: rng.next(), pattern: rng.next(), tumble, mutRate: 0.4, history: [],
  };
}

const cloneType = (t: CellType): CellType => ({ size: t.size, sockets: t.sockets.map((s) => ({ type: s.type, w: s.w.slice() })) });

export function cloneGenome(g: Genome): Genome {
  return { ...g, types: g.types.map(cloneType), cells: g.cells.map((c) => ({ ...c })), tumble: g.tumble.slice(), history: g.history.slice() };
}

/** Sockets taken by cells hanging on cell `ci`. */
const usedSites = (g: Genome, ci: number): Set<number> => new Set(g.cells.filter((c) => c.parent === ci).map((c) => c.site));

/** Puts a part type in a socket (weights only for actuators; kept if it already was an actuator). */
function setSocket(s: Socket, type: number, rng: Rng): void {
  const wasAct = s.type >= 0 && isActuator(s.type);
  s.type = type;
  if (type >= 0 && isActuator(type)) { if (!wasAct) s.w = randW(rng); } else s.w = [];
}

/**
 * Keeps the colony valid: a non-root cell must hang on an adhesion socket of its parent that no other cell
 * uses; cells that lost their socket fall off with the cells hanging on them. Unused types are dropped.
 */
export function fixColony(g: Genome): void {
  const keep: boolean[] = [];
  const used = new Set<string>();
  g.cells.forEach((c, i) => {
    if (i === 0) { keep[0] = true; return; }
    const parent = g.cells[c.parent], key = `${c.parent}:${c.site}`;
    keep[i] = !!(keep[c.parent] && parent && g.types[parent.type]?.sockets[c.site]?.type === PartType.Adhesion && !used.has(key) && g.types[c.type]);
    if (keep[i]) used.add(key);
  });
  const map: number[] = [], cells: CellGene[] = [];
  g.cells.forEach((c, i) => { if (keep[i]) { map[i] = cells.length; cells.push({ ...c, parent: c.parent >= 0 ? map[c.parent] : -1 }); } });
  const tmap: number[] = [], types: CellType[] = [];
  g.types.forEach((t, i) => { if (cells.some((c) => c.type === i)) { tmap[i] = types.length; types.push(t); } });
  for (const c of cells) c.type = tmap[c.type];
  g.cells = cells; g.types = types;
}

/** Sexual reproduction: cell types and the tumble reflex are mixed from both parents, the colony layout from `a`. */
export function crossover(a: Genome, b: Genome, rng: Rng): Genome {
  const g = cloneGenome(a);
  for (let i = 0; i < g.types.length && i < b.types.length; i++) {
    // socket by socket: real recombination of body plans
    for (let s = 0; s < SOCKETS; s++) if (rng.chance(0.5)) g.types[i].sockets[s] = { type: b.types[i].sockets[s].type, w: b.types[i].sockets[s].w.slice() };
    if (rng.chance(0.5)) g.types[i].size = b.types[i].size;
  }
  for (let i = 0; i < WLEN; i++) if (rng.chance(0.5)) g.tumble[i] = b.tumble[i];
  g.hue = rng.chance(0.5) ? a.hue : b.hue;
  g.mutRate = (a.mutRate + b.mutRate) / 2;
  fixColony(g);
  return g;
}

export const describePart = (type: number, socket: number): string => `${PART_NAMES[type]} ${SOCKET_NAMES[socket]}`;

/** Copies `parent` with random mutations, recorded in the history. */
export function mutate(parent: Genome, rng: Rng, gen: number): Genome {
  const g = cloneGenome(parent);
  let k = 0;
  for (let L = Math.exp(-g.mutRate), p = rng.next(); p > L; p *= rng.next()) k++;
  const log = (s: string): void => { g.history.push(`g${gen} · ${s}`); if (g.history.length > 10) g.history.shift(); };
  for (let m = 0; m < k; m++) {
    const t = g.types[rng.int(0, g.types.length - 1)], si = rng.int(0, SOCKETS - 1), s = t.sockets[si];
    const r = rng.next();
    if (r < 0.32) {
      // new content for a socket: a random part, or empty
      const before = s.type, type = rng.chance(0.3) ? -1 : rng.int(0, PART_TYPES - 1);
      if (type === before) continue;
      setSocket(s, type, rng);
      log(type < 0 ? `− ${describePart(before, si).toLowerCase()}` : `+ ${describePart(type, si).toLowerCase()}`);
    } else if (r < 0.46) {
      // copy to the mirror socket (symmetry has to evolve)
      if (s.type < 0) continue;
      const mi = MIRROR[si];
      t.sockets[mi] = { type: s.type, w: s.w.slice() };
      log(`mirrored ${PART_NAMES[s.type].toLowerCase()} ${SOCKET_NAMES[mi]}`);
    } else if (r < 0.54) {
      const sj = rng.int(0, SOCKETS - 1);
      if (sj === si) continue;
      [t.sockets[si], t.sockets[sj]] = [t.sockets[sj], t.sockets[si]];
      log('two parts swapped places');
    } else if (r < 0.82) {
      // brain: nudge (or silence) one weight of an actuator or of the tumble reflex
      const acts = t.sockets.filter((q) => q.w.length);
      const w = acts.length && rng.chance(0.75) ? rng.pick(acts).w : g.tumble, i = rng.int(0, WLEN - 1);
      w[i] = rng.chance(0.1) ? 0 : w[i] + rng.gauss() * 1.2;
      log('brain rewired');
    } else if (r < 0.9) {
      const before = t.size;
      t.size = Math.max(0, Math.min(SIZES.length - 1, t.size + (rng.chance(0.5) ? 1 : -1)));
      if (t.size === before) continue;
      log(`cell ${t.size > before ? 'bigger' : 'smaller'}`);
    } else if (r < 0.92) {
      g.mutRate = Math.min(1.5, Math.max(0.05, g.mutRate * Math.exp(rng.gauss() * 0.3)));
      log(`mutation rate ${g.mutRate > parent.mutRate ? 'up' : 'down'}`);
    } else colonyMutation(g, rng, log);
    g.hue = (g.hue + rng.gauss() * 0.01 + 1) % 1;
  }
  fixColony(g);
  return g;
}

/** Grow the colony by a cell, lose a cell, or let a cell specialise into a new type. */
function colonyMutation(g: Genome, rng: Rng, log: (s: string) => void): void {
  const r = rng.next();
  if (r < 0.5 && g.cells.length < MAX_CELLS) {
    // a daughter stays stuck: on a free adhesion socket, or one grown on an empty socket for the purpose
    const ci = rng.int(0, g.cells.length - 1), t = g.types[g.cells[ci].type], used = usedSites(g, ci);
    let site = t.sockets.findIndex((s, i) => s.type === PartType.Adhesion && !used.has(i));
    if (site < 0) {
      site = t.sockets.findIndex((s) => s.type < 0);
      if (site < 0) return;
      setSocket(t.sockets[site], PartType.Adhesion, rng);
    }
    g.cells.push({ type: rng.chance(0.75) ? g.cells[ci].type : rng.int(0, g.types.length - 1), parent: ci, site });
    log(`+ a cell stays attached ${SOCKET_NAMES[site]} (${g.cells.length} cells)`);
  } else if (r < 0.75 && g.cells.length > 1) {
    const leaves = g.cells.map((_, i) => i).filter((i) => i > 0 && !g.cells.some((c) => c.parent === i));
    const i = rng.pick(leaves);
    g.cells.splice(i, 1);
    for (const c of g.cells) if (c.parent > i) c.parent--;
    log(`− a cell (${g.cells.length} cells)`);
  } else if (g.cells.length > 1 && g.types.length < MAX_TYPES) {
    const i = rng.int(1, g.cells.length - 1);
    g.types.push(cloneType(g.types[g.cells[i].type]));
    g.cells[i].type = g.types.length - 1;
    log(`a cell specialised (${g.types.length} cell types)`);
  }
}

/** Body-plan signature for species: size, cells, types, and how many of each part. */
export function signature(g: Genome): number[] {
  const counts = Array(PART_TYPES).fill(0);
  for (const c of g.cells) for (const s of g.types[c.type].sockets) if (s.type >= 0) counts[s.type]++;
  return [g.types[0].size * 1.5, (g.cells.length - 1) * 1.5, (g.types.length - 1) * 1.5, ...counts.map((n) => n / Math.max(1, Math.sqrt(g.cells.length)))];
}

export function sigDistance(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d;
}
