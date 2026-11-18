// Seasons: a year of four seasons on the simulated calendar, or one season pinned by the viewer. The renderer gets
// four blend weights (spring, summer, fall, winter) that always sum to 1 and change smoothly.

export const SEASONS = ['spring', 'summer', 'fall', 'winter'] as const;
export type SeasonName = (typeof SEASONS)[number];
export type SeasonMode = 'auto' | SeasonName;
export type Weights = [number, number, number, number];

/** Simulated days per season in auto mode (a day lasts 10 minutes at ×1). */
export const SEASON_DAYS = 3;
/** Share of each season spent blending into the next one. */
const BLEND = 0.25;

const one = (i: number): Weights => { const w: Weights = [0, 0, 0, 0]; w[i] = 1; return w; };
const ss = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Seasons {
  mode: SeasonMode = 'auto';
  /** Current blend weights, eased toward the target so a pinned season fades in over a couple of seconds. */
  readonly w: Weights = one(0);
  private first = true;

  /** Weights for a calendar date in days (day 0 = the first morning of spring). */
  static calendar(days: number): Weights {
    const p = (((days / SEASON_DAYS) % 4) + 4) % 4, s = Math.floor(p), t = ss(1 - BLEND, 1, p - s);
    const w: Weights = [0, 0, 0, 0];
    w[s] += 1 - t; w[(s + 1) % 4] += t;
    return w;
  }

  /** The season that dominates right now. */
  get name(): SeasonName { return SEASONS[this.w.indexOf(Math.max(...this.w))]; }

  update(days: number, dt: number): void {
    const target = this.mode === 'auto' ? Seasons.calendar(days) : one(SEASONS.indexOf(this.mode));
    const k = this.first ? 1 : 1 - Math.exp(-dt * 1.5);
    this.first = false;
    for (let i = 0; i < 4; i++) this.w[i] += (target[i] - this.w[i]) * k;
  }
}
