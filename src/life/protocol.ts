// Messages between the main thread and the simulation worker.
import type { Genome } from './genome';

/** Per-organism snapshot record: id, position, orientation, scale, body size, bound, colour, activity, kind. */
export const ORG = 17;
export const O_ID = 0, O_X = 1, O_Y = 2, O_Z = 3, O_QW = 4, O_QX = 5, O_QY = 6, O_QZ = 7, O_SCALE = 8, O_SIZE = 9,
  O_BOUND = 10, O_R = 11, O_G = 12, O_B = 13, O_ACT = 14, O_KIND = 15, O_BUILT = 16;

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 150, 300, 600];
/** "As fast as the machine can go" (headless mode). */
export const MAX_SPEED = 1e6;

export type ToWorker =
  | { t: 'init'; seed: number }
  | { t: 'speed'; speed: number }
  | { t: 'pause'; paused: boolean }
  | { t: 'pressure'; value: number }
  | { t: 'hour'; delta: number }
  | { t: 'sunPause' }
  | { t: 'seedLife' }
  | { t: 'select'; id: number }
  | { t: 'genomes'; ids: number[] }
  /** Headless: snapshots without per-organism / particle arrays, more species and every log line. */
  | { t: 'lite'; on: boolean }
  | { t: 'charts' };

/** One population sample: time, total, and the counts of the largest species ([id, count] pairs). */
export interface Sample { t: number; total: number; top: [number, number][] }
/** A species for the lineage tree. */
export interface TreeNode { id: number; name: string; hue: number; parent: number; first: number; extinct: number; peak: number; count: number }
export interface Charts { t: 'charts'; samples: Sample[]; tree: TreeNode[]; now: number }

export interface SpeciesInfo {
  id: number; name: string; hue: number; count: number; peak: number;
  /** Mean speed (cm/s), energy intake per organism-second, offspring per individual, causes of death. */
  speed: number; intake: number; offspring: number; causes: Record<string, number>; parent: string;
}

export interface Detail {
  id: number; alive: boolean; death: string; gen: number; age: number; energy: number; divideAt: number; children: number;
  body: string; parts: string[]; history: string[]; species: SpeciesInfo; speed: number;
}

export interface Snapshot {
  t: 'snap';
  orgs: Float32Array<ArrayBuffer>; n: number;
  particles: Float32Array<ArrayBuffer>; np: number;
  time: number; hour: number; day: number; sunPaused: boolean;
  requested: number; actual: number; stepsPerSec: number; paused: boolean;
  births: number; deaths: number; eaten: number; maxGen: number; sexual: number; maxCells: number;
  species: SpeciesInfo[]; speciesAlive: number;
  log: { t: number; text: string }[]; logTotal: number;
  event: string; pressure: number;
  detail: Detail | null;
  focus: number;
  /** Organisms alive (in lite snapshots `orgs` is empty) and whether this is a lite snapshot. */
  count: number;
  lite: boolean;
  /** Share of wall time the worker spent simulating (1 = never idle). */
  busy: number;
}

export type FromWorker =
  | Snapshot
  | Charts
  | { t: 'genomes'; list: { id: number; genome: Genome }[] }
  | { t: 'error'; message: string };
