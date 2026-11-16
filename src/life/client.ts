// Main-thread side of the simulation: starts the worker, keeps the latest snapshot, answers position / picking
// queries, and forwards body plans to the drawing code.
import type { LifeDraw } from './draw';
import { ORG, O_BOUND, O_ID, O_SCALE, O_X, O_Y, O_Z, type Charts, type FromWorker, type Snapshot, type ToWorker } from './protocol';

export class LifeClient {
  snap: Snapshot | null = null;
  private readonly worker: Worker;
  private readonly index = new Map<number, number>();
  private readonly firstSnap: Promise<void>;
  /** Called with each new batch of log events. */
  onLog: (events: { t: number; text: string }[]) => void = () => {};
  onFocus: (id: number) => void = () => {};
  onCharts: (c: Charts) => void = () => {};

  constructor(seed: number, private readonly draw: LifeDraw) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    let resolve: () => void = () => {};
    this.firstSnap = new Promise((r) => { resolve = r; });
    this.worker.onmessage = (e: MessageEvent<FromWorker>): void => {
      const m = e.data;
      if (m.t === 'snap') {
        this.snap = m;
        this.index.clear();
        for (let i = 0; i < m.n && !m.lite; i++) this.index.set(m.orgs[i * ORG + O_ID], i);
        if (m.log.length) this.onLog(m.log);
        if (m.focus) this.onFocus(m.focus);
        resolve();
        const want = this.draw.takeRequests();
        if (want.length) this.send({ t: 'genomes', ids: want });
      } else if (m.t === 'genomes') for (const { id, genome } of m.list) this.draw.addGenome(id, genome);
      else if (m.t === 'charts') this.onCharts(m);
      else console.error('simulation: ' + m.message);
    };
    this.worker.onerror = (e) => console.error('simulation worker', e);
    this.send({ t: 'init', seed });
  }

  ready(): Promise<void> { return this.firstSnap; }
  send(m: ToWorker): void { this.worker.postMessage(m); }

  /** Latest known position of an organism, or null if it is gone. */
  pos(id: number): [number, number, number] | null {
    const s = this.snap, i = this.index.get(id);
    if (!s || i === undefined) return null;
    const k = i * ORG;
    return [s.orgs[k + O_X], s.orgs[k + O_Y], s.orgs[k + O_Z]];
  }

  /** The organism closest to a view ray within a small angle (0 if none). */
  pick(o: [number, number, number], d: [number, number, number]): number {
    const s = this.snap;
    if (!s) return 0;
    let best = 0, bestA = 0.05;
    for (let i = 0; i < s.n; i++) {
      const k = i * ORG, vx = s.orgs[k + O_X] - o[0], vy = s.orgs[k + O_Y] - o[1], vz = s.orgs[k + O_Z] - o[2];
      const dist = Math.hypot(vx, vy, vz);
      if (dist > 40 || dist < 1e-3) continue;
      const cos = (vx * d[0] + vy * d[1] + vz * d[2]) / dist;
      if (cos <= 0) continue;
      const ang = Math.acos(Math.min(1, cos)) - (s.orgs[k + O_BOUND] * s.orgs[k + O_SCALE]) / dist;
      if (ang < bestA) { bestA = ang; best = s.orgs[k + O_ID]; }
    }
    return best;
  }

  randomId(): number {
    const s = this.snap;
    return s && s.n ? s.orgs[Math.floor(Math.random() * s.n) * ORG + O_ID] : 0;
  }
}
