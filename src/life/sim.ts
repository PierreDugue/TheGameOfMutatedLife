import { HALF, ROAM } from '../config';
import { clamp } from '../core/math';
import { Rng } from '../core/rng';
import type { Terrain } from '../world/terrain';
import { BUCKET, Environment, PARTICLE_ENERGY } from './environment';
import { CORE_IN, crossover, firstGenome, mutate, PART_NAMES, PartType, SENSE_CH, SIZES, SOCKETS, WLEN, type Genome } from './genome';
import { ACT, CHEMO, EYE, express, MOUTH, V0, type Phenotype } from './phenotype';
import { Species, SpeciesBook } from './species';

/** Fixed simulation step (s): the same at every speed, so a seed always plays out the same. */
export const STEP = 1 / 10;
export const MAX_ORGS = 4000;
/** Newborns start at this scale and grow to full size over GROW seconds. */
const BIRTH_SCALE = 0.75, GROW = 30;
/** Resting organisms are stepped once every REST steps. */
const REST = 5;
const NB = Math.round((2 * HALF) / BUCKET);

export interface LogEvent { t: number; text: string }

export class Organism {
  alive = true;
  death = '';
  children = 0;
  age = 0;
  scale = BIRTH_SCALE;
  qw = 1; qx = 0; qy = 0; qz = 0;
  vx = 0; vy = 0; vz = 0;
  activity = 0;
  tumble = 0;
  intake = 0;
  /** Water level and ground under the organism, refreshed when it moves. */
  wl = NaN;
  ground = 0;
  /** Thermal rotational jiggle for the current size. */
  jig = -1;
  /** Seconds since the last cell was grown (colonies develop one cell at a time). */
  growT = 0;
  inputs!: Float32Array;
  out!: Float32Array;
  chemoPrev!: Float32Array;
  color!: [number, number, number];
  phen!: Phenotype;
  constructor(
    readonly id: number, readonly genome: Genome, phen: Phenotype, public species: Species,
    readonly gen: number, readonly parent: number,
    public x: number, public y: number, public z: number, public energy: number, readonly lifespan: number, readonly born: number,
  ) {
    this.setPhen(phen);
  }

  /** Swaps in a new phenotype (a cell was grown) and resizes the brain buffers. */
  setPhen(phen: Phenotype): void {
    this.phen = phen;
    this.inputs = new Float32Array(phen.nIn);
    this.out = new Float32Array(phen.nOut);
    this.chemoPrev = new Float32Array(phen.nChemo);
    this.color = organismColor(this.genome, phen);
    this.jig = -1;
  }

  get grown(): boolean { return this.phen.built >= this.genome.cells.length; }
}

/** Membrane colour: hue-based, greened by chloroplasts, warmed by mouths. */
export function organismColor(g: Genome, p: Phenotype): [number, number, number] {
  const h = g.hue * 6, f = h - Math.floor(h), q = 1 - f;
  const base = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][Math.floor(h) % 6];
  const photo = Math.min(1, p.nPhoto * 0.6), mouth = Math.min(1, p.nMouth * 0.5);
  return base.map((c, i) => {
    let v = 0.45 + 0.55 * c;
    v = v * (1 - photo * 0.55) + [0.35, 0.95, 0.3][i] * photo * 0.55;
    return v * (1 - mouth * 0.35) + [1.0, 0.5, 0.55][i] * mouth * 0.35;
  }) as [number, number, number];
}

export interface Stats { births: number; deaths: number; maxGen: number; peak: number; eaten: number; sexual: number; maxCells: number }

/** Pressure presets: scale upkeep up and supply down. */
export const PRESSURES: Record<string, number> = { gentle: 0.8, normal: 1, harsh: 1.3 };

/** Quaternion rotation of a local vector into `o` (world frame). */
function rot(org: Organism, x: number, y: number, z: number, o: Float32Array): void {
  const { qw, qx, qy, qz } = org;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  o[0] = x + qw * tx + (qy * tz - qz * ty);
  o[1] = y + qw * ty + (qz * tx - qx * tz);
  o[2] = z + qw * tz + (qx * ty - qy * tx);
}
/** Inverse rotation (world → local). */
function irot(org: Organism, x: number, y: number, z: number, o: Float32Array): void {
  const qw = org.qw, qx = -org.qx, qy = -org.qy, qz = -org.qz;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  o[0] = x + qw * tx + (qy * tz - qz * ty);
  o[1] = y + qw * ty + (qz * tx - qx * tz);
  o[2] = z + qw * tz + (qx * ty - qy * tx);
}

const sigm = (x: number): number => 1 / (1 + Math.exp(-x));

/** The living world, stepped at a fixed rate. Runs in the simulation worker. */
export class Sim {
  readonly env: Environment;
  orgs: Organism[] = [];
  readonly byId = new Map<number, Organism>();
  readonly species = new SpeciesBook();
  readonly stats: Stats = { births: 0, deaths: 0, maxGen: 0, peak: 0, eaten: 0, sexual: 0, maxCells: 1 };
  readonly log: LogEvent[] = [];
  /** Events ever logged (the log itself keeps the last 300). */
  logCount = 0;
  time = 0;
  /** Population history: a sample every 30 simulated seconds (the last 4 000). */
  readonly samples: { t: number; total: number; top: [number, number][] }[] = [];
  /** Selection pressure multiplier (PRESSURES). */
  pressure = 1;
  /** Current event ('' if none). */
  event = '';
  private eventEnd = 0;
  private cold = 1;
  private nextId = 1;
  private readonly rng: Rng;
  private readonly firsts = new Set<number>();
  private readonly oHead = new Int32Array(NB * NB).fill(-1);
  private readonly oNext = new Int32Array(MAX_ORGS * 2);
  private readonly oCount = new Uint16Array(NB * NB);
  /** Buckets touched last step, so the hash is cleared without sweeping the whole grid. */
  private used: number[] = [];
  private tick = 0;
  private readonly v3 = new Float32Array(3);
  private readonly w3 = new Float32Array(3);
  private readonly e3 = new Float32Array(3);

  constructor(readonly T: Terrain, seed: number) {
    this.rng = new Rng(seed ^ 0x11fe);
    this.env = new Environment(T, this.rng.fork(1));
    for (let i = 0; i < 400; i++) this.env.step(0.5);
    this.seedLife();
  }

  private note(text: string): void {
    this.log.push({ t: this.time, text });
    this.logCount++;
    if (this.log.length > 300) this.log.shift();
  }

  /** Places one new first cell in the shallow part of the pond. */
  seedLife(): Organism {
    const T = this.T, P = T.layout.pond, r = this.rng;
    let x = P.c[0], z = P.c[1];
    for (let t = 0; t < 200; t++) {
      const a = r.range(0, Math.PI * 2), q = r.range(0.55, 0.85);
      const cx = P.c[0] + Math.cos(a) * P.rx * q, cz = P.c[1] + Math.sin(a) * P.rz * q;
      const d = T.waterAt(cx, cz) - T.groundAt(cx, cz);
      // shallow, sunny, and in still water away from the river's way in and out
      const flow = Math.hypot(T.sample(T.FX, cx, cz), T.sample(T.FZ, cx, cz));
      let still = true;
      for (const rs of T.river) if ((rs.x - cx) ** 2 + (rs.z - cz) ** 2 < (rs.w + 6) ** 2 && T.pondQ(rs.x, rs.z) > 0.9) { still = false; break; }
      if (d > 0.35 && d < 1.2 && flow < 0.012 && still) { x = cx; z = cz; break; }
    }
    const g = firstGenome(r);
    const sp = this.species.found(g, 0, this.time);
    sp.announced = true;
    // a sun-eater starts near the surface, an eater on the bed among the algae
    const eater = !g.types[0].sockets.some((s) => s.type === PartType.Chloro);
    const o = this.add(g, sp, x, eater ? T.groundAt(x, z) + 0.025 : T.waterAt(x, z) - 0.2, z, 7.5, 0, 0);
    o.scale = 1;
    this.orgs.push(o);
    this.note(`A first cell appears: ${sp.name}, a ${eater ? 'particle eater' : 'sun-eater'}`);
    return o;
  }

  private add(g: Genome, sp: Species, x: number, y: number, z: number, energy: number, gen: number, parent: number): Organism {
    // a newborn is a single cell; a colony grows its other cells afterwards
    const o = new Organism(this.nextId++, g, express(g, 1), sp, gen, parent, x, y, z, energy, this.rng.range(600, 1100), this.time);
    const a = this.rng.range(0, Math.PI * 2);
    o.qw = Math.cos(a / 2); o.qy = Math.sin(a / 2);
    this.byId.set(o.id, o);
    sp.count++; sp.born++; sp.peak = Math.max(sp.peak, sp.count);
    this.stats.maxGen = Math.max(this.stats.maxGen, gen);
    for (const p of g.types.flatMap((t) => t.sockets)) if (p.type >= 0 && !this.firsts.has(p.type)) {
      this.firsts.add(p.type);
      if (this.time > 0) this.note(`First ${PART_NAMES[p.type].toLowerCase()} — in ${sp.name}`);
    }
    return o;
  }

  private die(o: Organism, why: string): void {
    if (!o.alive) return;
    o.alive = false; o.death = why;
    this.stats.deaths++;
    const sp = o.species;
    sp.count--; sp.died++;
    const cause = why.startsWith('eaten') ? 'eaten' : why;
    sp.causes[cause] = (sp.causes[cause] ?? 0) + 1;
    if (sp.count === 0) {
      sp.extinctAt = this.time;
      if (sp.announced) this.note(`${sp.name} went extinct (peak ${sp.peak})`);
    }
    if (!why.startsWith('eaten')) {
      this.env.give(o.x, o.z, 0.15 + Math.max(0, o.energy) * 0.03);
      for (let k = 0; k < 2; k++) this.env.spawnParticle(o.x, o.y, o.z);
    }
  }

  /** Seasons on a 6-day cycle and occasional events; returns the effective surface light. */
  private climate(sun: number, day: number): number {
    const season = Math.sin((day / 6) * Math.PI * 2);
    if (this.event && this.time > this.eventEnd) { this.note(`The ${this.event} is over`); this.event = ''; }
    if (!this.event && this.rng.next() < (STEP / 600) * 0.3) {
      this.event = this.rng.pick(['algae bloom', 'nutrient flood', 'cold snap']);
      this.eventEnd = this.time + this.rng.range(300, 600);
      this.note(`Event: ${this.event}`);
    }
    this.env.supply = ((0.75 + 0.35 * season) * (this.event === 'nutrient flood' ? 3 : 1)) / this.pressure;
    this.env.bloom = this.event === 'algae bloom' ? 2 : 1;
    this.cold = this.event === 'cold snap' ? 0.55 : 1;
    return sun * (0.9 + 0.1 * season) * (this.event === 'cold snap' ? 0.7 : 1);
  }

  /** Advances the world by one fixed step. `sun` = surface light 0..1, `day` = days since the start. */
  step(sunIn: number, day: number): void {
    const env = this.env, T = this.T, r = this.rng;
    const sun = this.climate(sunIn, day);
    env.sun = sun;
    env.step(STEP);
    this.time += STEP;
    this.tick++;

    const orgs = this.orgs;
    for (const b of this.used) { this.oHead[b] = -1; this.oCount[b] = 0; }
    this.used.length = 0;
    for (let i = 0; i < orgs.length; i++) {
      const b = env.bucket(orgs[i].x, orgs[i].z);
      if (this.oCount[b] === 0) { this.oHead[b] = -1; this.used.push(b); }
      this.oNext[i] = this.oHead[b]; this.oHead[b] = i; this.oCount[b]++;
    }

    const born: Organism[] = [];
    const v = this.v3, w = this.w3, e = this.e3;
    for (let oi = 0; oi < orgs.length; oi++) {
      const o = orgs[oi];
      if (!o.alive) continue;
      // resting organisms (barely moving: asleep at night, grazing on the bed) are updated at 2 Hz in bigger steps
      const rest = o.activity < 0.05 && o.scale >= 1 && o.grown ? REST : 1;
      if (rest > 1 && (o.id + this.tick) % REST) continue;
      const dt = STEP * rest;
      const P = o.phen, s = o.scale;
      if (Number.isNaN(o.wl)) { o.ground = T.groundAt(o.x, o.z); o.wl = T.waterAt(o.x, o.z); }
      const wl = o.wl, ground = o.ground;
      if (Number.isNaN(wl)) { this.die(o, 'stranded'); continue; }
      const light = env.lightAt(o.y, wl);
      const crowd = this.oCount[env.bucket(o.x, o.z)];
      const size = P.size * s;

      // ---------- senses → brain (every other step, staggered: decisions at 5 Hz are plenty) ----------
      if (rest > 1 || (o.id + this.tick) & 1) {
      const inp = o.inputs;
      inp[0] = 1; inp[1] = Math.min(2, o.energy / P.divideAt); inp[2] = light; inp[3] = o.y - ground < size * 2.5 ? 1 : 0;
      for (let k = 0; k < P.nEye; k++) {
        const E = k * EYE;
        rot(o, P.eyes[E], P.eyes[E + 1], P.eyes[E + 2], e);
        rot(o, P.eyePos[k * 3] * s, P.eyePos[k * 3 + 1] * s, P.eyePos[k * 3 + 2] * s, v);
        const ex = o.x + v[0], ey = o.y + v[1], ez = o.z + v[2], cosH = P.eyes[E + 3], range = P.eyes[E + 4];
        let food = 0, prey = 0, threat = 0;
        const bi = Math.floor((ex + HALF) / BUCKET), bk = Math.floor((ez + HALF) / BUCKET);
        for (let kk = bk - 1; kk <= bk + 1; kk++) for (let ii = bi - 1; ii <= bi + 1; ii++) {
          if (ii < 0 || kk < 0 || ii >= NB || kk >= NB) continue;
          const b = kk * NB + ii;
          for (let p = env.head[b]; p >= 0; p = env.next[p]) {
            if (!env.palive[p]) continue;
            const dx = env.px[p] - ex, dy = env.py[p] - ey, dz = env.pz[p] - ez, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d < range && d > 1e-4 && (dx * e[0] + dy * e[1] + dz * e[2]) / d > cosH) food = Math.max(food, 1 - d / range);
          }
          for (let q = this.oHead[b]; q >= 0; q = this.oNext[q]) {
            const u = orgs[q];
            if (u === o || !u.alive) continue;
            const dx = u.x - ex, dy = u.y - ey, dz = u.z - ez, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d < range && d > 1e-4 && (dx * e[0] + dy * e[1] + dz * e[2]) / d > cosH) {
              const us = u.phen.size * u.scale;
              if (us < size * 0.8) prey = Math.max(prey, 1 - d / range);
              else if (u.phen.nMouth && us > size * 1.2) threat = Math.max(threat, 1 - d / range);
            }
          }
        }
        const ix = P.eyes[E + 5];
        inp[ix] = food; inp[ix + 1] = prey; inp[ix + 2] = threat;
      }
      for (let k = 0; k < P.nChemo; k++) {
        const C = k * CHEMO;
        rot(o, P.chemo[C] * s, P.chemo[C + 1] * s, P.chemo[C + 2] * s, v);
        const cx = o.x + v[0], cy = o.y + v[1], cz = o.z + v[2];
        let smell = 0;
        const bi = Math.floor((cx + HALF) / BUCKET), bk = Math.floor((cz + HALF) / BUCKET);
        for (let kk = bk - 1; kk <= bk + 1; kk++) for (let ii = bi - 1; ii <= bi + 1; ii++) {
          if (ii < 0 || kk < 0 || ii >= NB || kk >= NB) continue;
          for (let p = env.head[kk * NB + ii]; p >= 0; p = env.next[p]) {
            if (!env.palive[p]) continue;
            const qx = env.px[p] - cx, qy = env.py[p] - cy, qz = env.pz[p] - cz, d = Math.sqrt(qx * qx + qy * qy + qz * qz);
            if (d < 0.5) smell += 1 - d / 0.5;
          }
        }
        inp[P.chemo[C + 3]] = clamp((smell - o.chemoPrev[k]) * 2, -1, 1);
        o.chemoPrev[k] = smell;
      }
      // direct wiring: each output reads the core inputs and the sensors on its own cell
      const W = P.w;
      for (let j = 0; j < P.nOut; j++) {
        const wo = j * WLEN, so = CORE_IN + P.outCell[j] * SOCKETS * SENSE_CH - CORE_IN;
        let a = 0;
        for (let i = 0; i < CORE_IN; i++) a += W[wo + i] * inp[i];
        for (let i = CORE_IN; i < WLEN; i++) a += W[wo + i] * inp[so + i];
        o.out[j] = sigm(a);
      }

      }

      // ---------- forces & torques from the actuators (world frame) ----------
      let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0, work = 0, act = 0;
      for (let k = 0; k < P.nAct; k++) {
        const A = k * ACT, a = o.out[1 + k];
        act += a;
        rot(o, P.act[A + 3], P.act[A + 4], P.act[A + 5], e);
        let f = P.act[A + 6] * s * a, gx = e[0] * f, gy = e[1] * f, gz = e[2] * f;
        if (P.act[A + 7] > 0) {
          // limbs: a strong horizontal push while the tip touches the bed
          rot(o, P.act[A + 8] * s, P.act[A + 9] * s, P.act[A + 10] * s, w);
          if (o.y + w[1] <= T.groundAt(o.x + w[0], o.z + w[2]) + 0.006) {
            const hl = Math.sqrt(e[0] * e[0] + e[2] * e[2]) || 1, fb = P.act[A + 7] * s * a;
            gx += (e[0] / hl) * fb; gz += (e[2] / hl) * fb;
            f += fb;
          }
        }
        rot(o, P.act[A] * s, P.act[A + 1] * s, P.act[A + 2] * s, v);
        fx += gx; fy += gy; fz += gz;
        tx += v[1] * gz - v[2] * gy; ty += v[2] * gx - v[0] * gz; tz += v[0] * gy - v[1] * gx;
        work += f;
      }
      o.activity = P.nAct ? act / P.nAct : 0;
      o.tumble = o.out[0];

      // ---------- overdamped motion: velocity = force / drag, in the body frame ----------
      irot(o, fx, fy, fz, v);
      rot(o, v[0] / (P.kx * s), v[1] / (P.ky * s), v[2] / (P.kz * s), w);
      o.vx = w[0]; o.vy = w[1]; o.vz = w[2];
      // the current slows to nothing at the bed (boundary layer), so bottom dwellers can stay put
      const bl = Math.min(1, 0.25 + (o.y - ground) / 0.15);
      const flx = T.sample(T.FX, o.x, o.z) * bl, flz = T.sample(T.FZ, o.x, o.z) * bl;
      const nx = o.x + (w[0] + flx) * dt, nz = o.z + (w[2] + flz) * dt;
      // past the explorable valley the river carries them away for good
      if (Math.abs(nx) > ROAM + 4 || Math.abs(nz) > ROAM + 4) { this.die(o, 'washed downstream'); continue; }
      const ng = T.groundAt(nx, nz), nwl = T.sample(T.WL, nx, nz);
      if (nwl > ng) { o.x = nx; o.z = nz; o.wl = nwl; o.ground = ng; }
      // cells are a little denser than water: they sink slowly unless they swim
      o.y = clamp(o.y + (w[1] - 0.006) * dt, o.ground + size * 0.8, o.wl - size * 0.5);

      // rotation: torque / rotational drag, plus thermal jiggle (stronger for small cells, raised by tumbling)
      const kr = P.kRot * s * s * s;
      if (o.jig < 0 || s < 1) o.jig = 0.25 * Math.pow(0.02 / Math.max(0.004, size), 1.5) * 1.732;
      const jig = o.jig * (1 + 6 * o.tumble) * Math.sqrt(dt);
      let ax = (tx / kr) * dt + (r.next() * 2 - 1) * jig, ay = (ty / kr) * dt + (r.next() * 2 - 1) * jig, az = (tz / kr) * dt + (r.next() * 2 - 1) * jig;
      let ang = Math.sqrt(ax * ax + ay * ay + az * az);
      if (ang > 0.6) { ax *= 0.6 / ang; ay *= 0.6 / ang; az *= 0.6 / ang; ang = 0.6; }
      if (ang > 1e-7) {
        const bw = Math.cos(ang / 2), k = Math.sin(ang / 2) / ang, bx = ax * k, by = ay * k, bz = az * k;
        const { qw, qx, qy, qz } = o;
        o.qw = bw * qw - bx * qx - by * qy - bz * qz;
        o.qx = bw * qx + bx * qw + by * qz - bz * qy;
        o.qy = bw * qy - bx * qz + by * qw + bz * qx;
        o.qz = bw * qz + bx * qy - by * qx + bz * qw;
        const ql = Math.sqrt(o.qw * o.qw + o.qx * o.qx + o.qy * o.qy + o.qz * o.qz);
        o.qw /= ql; o.qx /= ql; o.qy /= ql; o.qz /= ql;
      }

      // ---------- feeding: mouths eat what they touch; chloroplasts eat light ----------
      let gain = 0;
      for (let k = 0; k < P.nMouth; k++) {
        const M = k * MOUTH, gape = P.mouths[M + 6], reach = (0.015 + gape * 0.05) * s;
        rot(o, P.mouths[M] * s, P.mouths[M + 1] * s, P.mouths[M + 2] * s, v);
        const mx = o.x + v[0], my = o.y + v[1], mz = o.z + v[2];
        // a mouth touching the bed grazes the algae there
        if (my - T.groundAt(mx, mz) < reach) gain += env.graze(mx, mz, 0.15 * gape * s * dt);
        // only the buckets the mouth's reach (plus the largest swallowable body) overlaps: usually just one
        const R = reach + size; // prey is never bigger than the predator
        const i0 = Math.floor((mx - R + HALF) / BUCKET), i1 = Math.floor((mx + R + HALF) / BUCKET);
        const k0 = Math.floor((mz - R + HALF) / BUCKET), k1 = Math.floor((mz + R + HALF) / BUCKET);
        let ate = false;
        for (let kk = k0; kk <= k1 && !ate; kk++) for (let ii = i0; ii <= i1 && !ate; ii++) {
          if (ii < 0 || kk < 0 || ii >= NB || kk >= NB) continue;
          const b = kk * NB + ii;
          for (let p = env.head[b]; p >= 0; p = env.next[p]) {
            if (!env.palive[p]) continue;
            if ((env.px[p] - mx) ** 2 + (env.py[p] - my) ** 2 + (env.pz[p] - mz) ** 2 < reach * reach) {
              env.palive[p] = 0; gain += PARTICLE_ENERGY * (0.6 + 0.5 * gape); ate = true; break;
            }
          }
          if (ate) break;
          for (let q = this.oHead[b]; q >= 0; q = this.oNext[q]) {
            const u = orgs[q];
            if (u === o || !u.alive) continue;
            const us = u.phen.size * u.scale;
            if (us > size * 0.75 * (0.4 + 0.6 * gape)) continue;
            if ((u.x - mx) ** 2 + (u.y - my) ** 2 + (u.z - mz) ** 2 > (us + reach) ** 2) continue;
            const fail = Math.min(0.85, u.phen.spikes * 0.35 + u.phen.shells * 0.25);
            if (r.next() < fail) o.energy -= u.phen.spikes * 1.2; // pricked
            else {
              gain += 0.7 * Math.max(0, u.energy) + 2 * (u.phen.size / 0.02) ** 3 * u.scale ** 3;
              if (this.stats.eaten++ === 0) this.note(`First predation: ${o.species.name} ate a ${u.species.name}`);
              this.die(u, `eaten by ${o.species.name}`);
            }
            ate = true;
            break;
          }
        }
      }
      if (P.nPhoto) {
        // patches add up, but a cell can't catch more light than its cross-section lets through
        let catchA = 0;
        for (let k = 0; k < P.nPhoto; k++) {
          rot(o, P.photo[k * 4], P.photo[k * 4 + 1], P.photo[k * 4 + 2], v);
          catchA += P.photo[k * 4 + 3] * (0.5 + 0.5 * v[1]);
        }
        catchA = Math.min(catchA, 1.2 * P.crossA);
        const n = env.nutrientAt(o.x, o.z), nf = n / (n + 0.4), shade = 1 / (1 + 0.05 * Math.max(0, crowd - 1));
        const gph = 0.8 * catchA * s * s * light * shade * nf * dt * this.cold;
        gain += gph;
        env.take(o.x, o.z, gph * 0.03);
      }
      o.energy += gain;
      o.intake += gain;

      // ---------- costs, growth, aging ----------
      const crowdCost = 1 + 0.03 * Math.max(0, crowd - 2);
      // resting organisms burn less: basal metabolism is 25 % of the active one
      o.energy -= (P.upkeep * s * s * s * (0.25 + 0.75 * Math.min(1, o.activity * 1.5)) + 3 * work) * this.pressure * crowdCost * (this.cold < 1 ? 0.8 : 1) * dt;
      o.age += dt;
      if (o.scale < 1) o.scale = Math.min(1, o.scale + ((1 - BIRTH_SCALE) / GROW) * dt);
      const sp = o.species;
      sp.speedSum += Math.sqrt(o.vx * o.vx + o.vy * o.vy + o.vz * o.vz); sp.speedN++; sp.intake += gain; sp.lived += dt;
      if (o.energy <= 0) { this.die(o, 'starved'); continue; }
      if (o.age > o.lifespan) { this.die(o, 'old age'); continue; }

      // ---------- development: a colony grows its next cell every 10 s while it can pay for it ----------
      if (o.scale >= 1 && !o.grown) {
        o.growT += dt;
        const next = o.genome.types[o.genome.cells[P.built].type];
        const cost = 2.5 * (SIZES[next.size] ** 3 * (4 / 3) * Math.PI) / V0 + 0.3 * next.sockets.filter((q) => q.type >= 0).length;
        if (o.growT >= 10 && o.energy > cost + 1.5) {
          o.energy -= cost; o.growT = 0;
          o.setPhen(express(o.genome, P.built + 1));
          if (o.phen.built > this.stats.maxCells) {
            this.stats.maxCells = o.phen.built;
            if (o.phen.built === 2) this.note(`First multicellular organism: a ${sp.name} grew a second cell`);
            else if (o.phen.built % 3 === 0) this.note(`A ${sp.name} reached ${o.phen.built} cells`);
          }
        }
        continue;
      }

      // ---------- reproduction: costs 20 % on top of splitting the reserve; only fully grown organisms ----------
      // Colonies mate when a ready partner of their species is close: offspring mix both genomes.
      if (o.scale >= 1 && o.energy >= P.divideAt && orgs.length + born.length < MAX_ORGS) {
        let mate: Organism | null = null;
        if (o.genome.cells.length > 1) {
          const bi = Math.floor((o.x + HALF) / BUCKET), bk = Math.floor((o.z + HALF) / BUCKET);
          for (let kk = bk - 1; kk <= bk + 1 && !mate; kk++) for (let ii = bi - 1; ii <= bi + 1 && !mate; ii++) {
            if (ii < 0 || kk < 0 || ii >= NB || kk >= NB) continue;
            for (let q = this.oHead[kk * NB + ii]; q >= 0; q = this.oNext[q]) {
              const u = orgs[q];
              if (u === o || !u.alive || u.species !== sp || !u.grown || u.energy < u.phen.divideAt * 0.6) continue;
              if ((u.x - o.x) ** 2 + (u.y - o.y) ** 2 + (u.z - o.z) ** 2 < 0.36) { mate = u; break; }
            }
          }
        }
        const half = (o.energy * 0.8) / 2, a = r.range(0, Math.PI * 2), off = P.bound * 1.1;
        o.energy = half; o.children++;
        this.stats.births++;
        let g: Genome;
        if (mate) {
          mate.energy *= 0.75; mate.children++;
          g = mutate(crossover(o.genome, mate.genome, r), r, o.gen + 1);
          g.history.push(`g${o.gen + 1} · born of two parents`);
          if (this.stats.sexual++ === 0) this.note(`First sexual reproduction: two ${sp.name} mixed their genomes`);
        } else g = mutate(o.genome, r, o.gen + 1);
        const csp = this.species.assign(g, sp, this.time);
        const dx = Math.cos(a) * off, dz = Math.sin(a) * off, wet = !Number.isNaN(T.waterAt(o.x + dx, o.z + dz));
        born.push(this.add(g, csp, o.x + (wet ? dx : 0), o.y, o.z + (wet ? dz : 0), half, o.gen + 1, o.id));
      }
    }
    let n = 0;
    for (const o of orgs) if (o.alive) orgs[n++] = o; else this.byId.delete(o.id);
    orgs.length = n;
    for (const c of born) {
      orgs.push(c);
      const sp = c.species;
      if (!sp.announced && sp.count >= 25) {
        sp.announced = true;
        const parent = this.species.get(sp.parent);
        this.note(`New species ${sp.name} is spreading${parent ? ` (from ${parent.name})` : ''}`);
      }
    }
    this.stats.peak = Math.max(this.stats.peak, orgs.length);
    if (this.tick % 300 === 0) {
      const living = this.species.living().sort((a, b) => b.count - a.count);
      this.samples.push({ t: this.time, total: orgs.length, top: living.slice(0, 12).map((sp) => [sp.id, sp.count]) });
      if (this.samples.length > 4000) this.samples.shift();
    }
  }
}
