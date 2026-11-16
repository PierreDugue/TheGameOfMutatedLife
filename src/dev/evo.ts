// Dev-only: run the simulation headless from the console, e.g. `evo(1, 60, 20000)` = seed 1, 60 simulated
// minutes, at most 20 s of wall time. Prints population, species and recent events.
import { Sim } from '../life/sim';
import { PART_NAMES } from '../life/genome';
import { DayNight } from '../world/sky';
import type { Terrain } from '../world/terrain';

export function installEvo(T: Terrain): void {
  const w = window as unknown as Record<string, unknown>;
  w.evo = (seed: number, minutes: number, budget = 20000): string => {
    const S = new Sim(T, seed), sky = new DayNight();
    let day = 0, prev = sky.hour, steps = 0;
    const sun = (): number => { const L = sky.light; return L.night > 0.5 ? 0 : Math.min(1, Math.max(0, L.dir[1]) * (L.rgb[1] / 3) * 1.6); };
    const out: string[] = [], t0 = performance.now();
    for (let s = 0; s < minutes * 600; s++) {
      sky.update(0.1);
      if (sky.hour < prev) day++;
      prev = sky.hour;
      S.step(sun(), day + sky.hour / 24);
      steps++;
      if (s % 3000 === 0) {
        const parts = S.orgs.reduce((a, o) => a + o.phen.placed.length, 0) / Math.max(1, S.orgs.length);
        const cells = S.orgs.reduce((a, o) => a + o.phen.built, 0) / Math.max(1, S.orgs.length);
        out.push(`${(S.time / 60).toFixed(0)}m ${sky.clock()} n ${S.orgs.length} species ${S.species.living().length} gen ${S.stats.maxGen} parts ${parts.toFixed(1)} cells ${cells.toFixed(2)} (max ${S.stats.maxCells}) sex ${S.stats.sexual} eaten ${S.stats.eaten} · ${((performance.now() - t0) / steps).toFixed(2)} ms/step`);
      }
      if (!S.orgs.length) { out.push(`extinct at ${(S.time / 60).toFixed(1)} min`); break; }
      if (performance.now() - t0 > budget) { out.push(`stopped at ${(S.time / 60).toFixed(1)} min, n ${S.orgs.length}`); break; }
    }
    w.lastSim = S;
    // the most common body plans: socket contents front/back/left/right/top/bottom, × cells
    const plans = new Map<string, number>();
    for (const o of S.orgs) {
      const key = o.genome.types.map((t) => t.sockets.map((q) => (q.type < 0 ? '·' : PART_NAMES[q.type].slice(0, 4))).join(' ')).join(' | ') + (o.genome.cells.length > 1 ? ` ×${o.genome.cells.length} cells` : '');
      plans.set(key, (plans.get(key) ?? 0) + 1);
    }
    const topPlans = [...plans].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${n} × [F B L R T U] ${k}`);
    const top = S.species.living().sort((a, b) => b.count - a.count).slice(0, 6)
      .map((s) => `${s.name}: ${s.count} · ${(s.speedSum / Math.max(1, s.speedN) * 100).toFixed(2)} cm/s · intake ${(s.intake / Math.max(1, s.lived) * 100).toFixed(1)}/100s`);
    top.push('-- body plans --', ...topPlans);
    return [...out, '-- species --', ...top, '-- log --', ...S.log.slice(-15).map((e) => `${(e.t / 60).toFixed(1)}m ${e.text}`)].join('\n');
  };
}
