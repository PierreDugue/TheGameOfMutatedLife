// The simulation worker: owns the world's life, steps it at the requested speed within a time budget, and posts
// snapshots ~30 times a second.
import { Rng } from '../core/rng';
import { makeLayout } from '../world/layout';
import { DayNight } from '../world/sky';
import { Terrain } from '../world/terrain';
import { describePart } from './genome';
import { ORG, type Detail, type FromWorker, type SpeciesInfo, type ToWorker, type TreeNode } from './protocol';
import { Sim, STEP, type Organism } from './sim';
import type { Species } from './species';

let sim: Sim | null = null;
const sky = new DayNight();
let speed = 1, paused = false, owed = 0, last = 0, lastSnap = 0, day = 0, prevHour = sky.hour;
let selected: Organism | null = null, focus = 0, logSent = 0, lite = false;
// actual-speed measurement over a sliding window
let winStart = 0, winSim = 0, winSteps = 0, winBusy = 0, actual = 0, stepsPerSec = 0, busy = 0;

const post = (m: FromWorker, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(m, transfer);

const sunLevel = (): number => {
  const L = sky.light;
  return L.night > 0.5 ? 0 : Math.min(1, Math.max(0, L.dir[1]) * (L.rgb[1] / 3) * 1.6);
};

function speciesInfo(s: Species): SpeciesInfo {
  const parent = sim?.species.get(s.parent);
  return {
    id: s.id, name: s.name, hue: s.hue, count: s.count, peak: s.peak,
    speed: s.speedN ? (s.speedSum / s.speedN) * 100 : 0,
    intake: s.lived > 0 ? s.intake / s.lived : 0,
    offspring: s.born > 1 ? (s.born - 1) / Math.max(1, s.died + s.count) : 0,
    causes: s.causes, parent: parent?.name ?? '',
  };
}

function detail(o: Organism): Detail {
  const g = o.genome, P = o.phen, t = g.types[0];
  const shape = ['small', 'medium', 'large', 'huge'][t.size];
  const nCells = g.cells.length;
  const parts = g.types.flatMap((ty, i) => {
    const n = g.cells.filter((c) => c.type === i).length;
    const list = ty.sockets.map((s, si) => (s.type >= 0 ? describePart(s.type, si) : '')).filter(Boolean);
    return g.types.length > 1 || nCells > 1 ? [`▸ cell type ${i + 1} ×${n}`, ...list.map((x) => `   ${x}`)] : list;
  });
  return {
    id: o.id, alive: o.alive, death: o.death, gen: o.gen, age: o.age, energy: o.energy, divideAt: P.divideAt, children: o.children,
    body: `${nCells > 1 ? `${P.built}/${nCells} cells · ` : ''}⌀ ${(P.size * o.scale * 200).toFixed(1)} cm · ${shape}${o.scale < 1 || P.built < nCells ? ' · growing' : ''}`,
    parts, history: g.history.slice(), species: speciesInfo(o.species),
    speed: Math.hypot(o.vx, o.vy, o.vz) * 100,
  };
}

/** Population history and the lineage of every species that ever reached 25 individuals (plus their ancestors). */
function charts(S: Sim): FromWorker {
  const keep = new Set<number>();
  for (const s of S.species.all) if (s.peak >= 25 || s.count >= 25) for (let a = s; a; a = S.species.get(a.parent)!) { if (keep.has(a.id)) break; keep.add(a.id); }
  const tree: TreeNode[] = [...keep].map((id) => S.species.get(id)!).map((s) => ({
    id: s.id, name: s.name, hue: s.hue, parent: s.parent, first: s.firstSeen, extinct: s.count > 0 ? -1 : s.extinctAt, peak: s.peak, count: s.count,
  }));
  return { t: 'charts', samples: S.samples, tree, now: S.time };
}

function snapshot(): void {
  if (!sim) return;
  const S = sim, n = lite ? 0 : S.orgs.length;
  const orgs = new Float32Array(Math.max(1, n) * ORG);
  for (let i = 0; i < n; i++) {
    const o = S.orgs[i], k = i * ORG;
    orgs[k] = o.id; orgs[k + 1] = o.x; orgs[k + 2] = o.y; orgs[k + 3] = o.z;
    orgs[k + 4] = o.qw; orgs[k + 5] = o.qx; orgs[k + 6] = o.qy; orgs[k + 7] = o.qz;
    orgs[k + 8] = o.scale; orgs[k + 9] = o.phen.size; orgs[k + 10] = o.phen.bound;
    orgs[k + 11] = o.color[0]; orgs[k + 12] = o.color[1]; orgs[k + 13] = o.color[2];
    orgs[k + 14] = o.activity; orgs[k + 15] = o.phen.nPhoto > 0 ? 0 : 1; orgs[k + 16] = o.phen.built;
  }
  const env = S.env, np = lite ? 0 : env.np;
  const particles = new Float32Array(Math.max(1, np) * 3);
  let m = 0;
  for (let i = 0; i < np; i++) if (env.palive[i]) { particles[m * 3] = env.px[i]; particles[m * 3 + 1] = env.py[i]; particles[m * 3 + 2] = env.pz[i]; m++; }
  const living = S.species.living().sort((a, b) => b.count - a.count);
  const fresh = Math.min(lite ? 300 : 20, S.logCount - logSent);
  const newLog = fresh > 0 ? S.log.slice(-fresh) : [];
  logSent = S.logCount;
  const total = S.logCount;
  post({
    t: 'snap', orgs, n, particles, np: m, time: S.time, hour: sky.hour, day, sunPaused: sky.paused,
    requested: speed, actual, stepsPerSec, paused,
    births: S.stats.births, deaths: S.stats.deaths, eaten: S.stats.eaten, maxGen: S.stats.maxGen,
    sexual: S.stats.sexual, maxCells: S.stats.maxCells,
    species: living.slice(0, lite ? 15 : 6).map(speciesInfo), speciesAlive: living.length,
    log: newLog, logTotal: total, event: S.event, pressure: S.pressure,
    detail: selected && !lite ? detail(selected) : null, focus, count: S.orgs.length, lite, busy,
  }, [orgs.buffer, particles.buffer]);
  focus = 0;
}

function loop(): void {
  const now = performance.now();
  const dtReal = Math.min((now - last) / 1000, 0.25);
  last = now;
  if (sim && !paused) {
    owed = Math.min(owed + dtReal * speed, speed * 0.25 + STEP); // never build a backlog bigger than ¼ s of wall time
    const t0 = performance.now();
    let steps = 0;
    while (owed >= STEP && performance.now() - t0 < 12) {
      sky.update(STEP);
      if (sky.hour < prevHour) day++;
      prevHour = sky.hour;
      sim.step(sunLevel(), day + sky.hour / 24);
      owed -= STEP;
      steps++;
    }
    winSim += steps * STEP; winSteps += steps; winBusy += performance.now() - t0;
  }
  if (now - winStart > 500) {
    const span = (now - winStart) / 1000;
    actual = winSim / span; stepsPerSec = winSteps / span; busy = winBusy / (span * 1000);
    winStart = now; winSim = 0; winSteps = 0; winBusy = 0;
  }
  if (now - lastSnap > (lite ? 100 : 33)) { lastSnap = now; snapshot(); }
  channel.port2.postMessage(0);
}

// MessageChannel re-schedules faster than setTimeout (which clamps to 4 ms when nested)
const channel = new MessageChannel();
channel.port1.onmessage = loop;

self.onmessage = (e: MessageEvent<ToWorker>): void => {
  const m = e.data;
  try {
    if (m.t === 'init') {
      const T = new Terrain(makeLayout(new Rng(m.seed)), m.seed);
      sim = new Sim(T, m.seed);
      last = winStart = performance.now();
      channel.port2.postMessage(0);
    } else if (m.t === 'speed') speed = m.speed;
    else if (m.t === 'pause') paused = m.paused;
    else if (m.t === 'lite') lite = m.on;
    else if (m.t === 'charts' && sim) post(charts(sim));
    else if (m.t === 'pressure' && sim) sim.pressure = m.value;
    else if (m.t === 'hour') { sky.hour = (sky.hour + m.delta + 24) % 24; prevHour = sky.hour; sky.update(0); }
    else if (m.t === 'sunPause') sky.paused = !sky.paused;
    else if (m.t === 'seedLife' && sim) { selected = sim.seedLife(); focus = selected.id; }
    else if (m.t === 'select' && sim) selected = sim.byId.get(m.id) ?? null;
    else if (m.t === 'genomes' && sim) {
      const S = sim;
      post({ t: 'genomes', list: m.ids.map((id) => S.byId.get(id)).filter((o): o is Organism => !!o).map((o) => ({ id: o.id, genome: o.genome })) });
    }
  } catch (err) {
    post({ t: 'error', message: (err as Error).message });
  }
};
