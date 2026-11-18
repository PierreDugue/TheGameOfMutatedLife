// Weather: precipitation (rain, or snow in winter), fog and wind. In auto mode it changes every half day, rolled from
// the seed and the season; each part can also be forced on or off. Values ease toward their targets so showers
// build up and clear rather than switching.

import { hash2 } from '../core/rng';
import type { Light } from './sky';
import type { Weights } from './season';

export type Toggle = 'auto' | 'on' | 'off';
export const TOGGLES: Toggle[] = ['auto', 'on', 'off'];

/** Side of the box of rain or snow kept around the camera (m); the shader wraps particles inside it. */
export const PRECIP_BOX = 32;
/** Weather spells per simulated day in auto mode. */
const SPELLS_PER_DAY = 2;

const smooth = (v: number, target: number, k: number): number => v + (target - v) * k;

export class Weather {
  precipMode: Toggle = 'auto';
  fogMode: Toggle = 'auto';
  windMode: Toggle = 'auto';
  /** Current amounts, 0..1. `snow` is how much the precipitation is snow rather than rain. */
  precip = 0; fog = 0; wind = 0.3; snow = 0;
  /** Wind heading (radians, in the xz plane). */
  heading = 0;
  /** Accumulated particle drift (x, z) and fall (m, wrapped to the box), and cloud scroll (x, z). */
  readonly drift: [number, number] = [0, 0];
  fall = 0;
  readonly cloud: [number, number] = [0, 0];
  private first = true;

  constructor(private readonly seed: number) {}

  /** What auto mode wants for a date (days) and season: [precipitation, fog, wind, heading]. */
  private auto(days: number, s: Weights): [number, number, number, number] {
    const spell = Math.floor(days * SPELLS_PER_DAY), r = (k: number): number => hash2(spell, k, this.seed ^ 0x3ea7);
    const [spring, , fall, winter] = s;
    const wet = spring * 0.75 + fall * 0.3 + winter * 0.65; // summer stays dry
    const misty = fall * 0.45 + winter * 0.15 + spring * 0.1;
    const precip = r(1) < wet ? 0.35 + 0.65 * r(2) : 0;
    const fog = r(3) < misty ? 0.45 + 0.55 * r(4) : 0;
    const wind = Math.min(1, r(5) ** 1.5 * 1.1 + precip * 0.2);
    // the heading wanders from spell to spell rather than jumping anywhere
    const heading = (hash2(Math.floor(spell / 4), 6, this.seed) * 2 + (r(7) - 0.5) * 0.5) * Math.PI;
    return [precip, fog, wind, heading];
  }

  update(days: number, season: Weights, dt: number): void {
    const [ap, af, aw, ah] = this.auto(days, season);
    const pick = (m: Toggle, auto: number, on: number, off: number): number => (m === 'auto' ? auto : m === 'on' ? on : off);
    const k = this.first ? 1 : 1 - Math.exp(-dt * 0.35);
    this.first = false;
    this.precip = smooth(this.precip, pick(this.precipMode, ap, 1, 0), k);
    this.fog = smooth(this.fog, pick(this.fogMode, af, 0.85, 0), k);
    this.wind = smooth(this.wind, pick(this.windMode, aw, 0.9, 0.04), k);
    this.snow = smooth(this.snow, season[3] > 0.5 ? 1 : 0, k);
    let dh = ah - this.heading;
    dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI;
    this.heading += dh * k * 0.3;

    // particles: snow drifts with the wind and falls slowly, rain falls fast and slants
    const dx = Math.cos(this.heading), dz = Math.sin(this.heading), w = this.wind * (2 + this.snow * 2);
    const B = PRECIP_BOX, wrap = (v: number): number => ((v % B) + B) % B;
    this.drift[0] = wrap(this.drift[0] + dx * w * dt);
    this.drift[1] = wrap(this.drift[1] + dz * w * dt);
    this.fall = wrap(this.fall + (7 + (1.1 - 7) * this.snow) * dt);
    const cs = (0.004 + this.wind * 0.03) * dt;
    this.cloud[0] = (this.cloud[0] + dx * cs) % 1000;
    this.cloud[1] = (this.cloud[1] + dz * cs) % 1000;
  }

  /** Horizontal wind velocity (m/s) used to slant rain streaks. */
  windVec(): [number, number] { const w = this.wind * (2 + this.snow * 2); return [Math.cos(this.heading) * w, Math.sin(this.heading) * w]; }

  /** Grey skies: dims the sun and desaturates the sky under rain, snow and fog. Call after DayNight.update. */
  dim(L: Light): void {
    const o = Math.min(1, this.precip * 1.1 + this.fog * 0.6);
    if (o <= 0.001) return;
    const grey = (c: [number, number, number], keep: number): [number, number, number] => {
      const l = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
      return [c[0] + (l - c[0]) * (1 - keep), c[1] + (l - c[1]) * (1 - keep), c[2] + (l - c[2]) * (1 - keep)];
    };
    const sun = 1 - 0.7 * o;
    L.rgb = [L.rgb[0] * sun, L.rgb[1] * sun, L.rgb[2] * sun];
    L.zenith = grey(L.zenith, 1 - 0.75 * o).map((v) => v * (1 - 0.25 * o)) as [number, number, number];
    L.horizon = grey(L.horizon, 1 - 0.7 * o);
    L.glow = L.glow.map((v) => v * (1 - 0.8 * o)) as [number, number, number];
    L.ambSky = grey(L.ambSky, 1 - 0.5 * o);
  }

  /** Short description for the status bar ('' when calm and clear). */
  label(): string {
    const parts: string[] = [];
    if (this.precip > 0.15) parts.push(`${this.precip > 0.7 ? 'heavy ' : ''}${this.snow > 0.5 ? 'snow' : 'rain'}`);
    if (this.fog > 0.25) parts.push('fog');
    if (this.wind > 0.65) parts.push('windy'); else if (this.wind > 0.35) parts.push('breezy');
    const s = parts.join(', ');
    return s ? s[0].toUpperCase() + s.slice(1) : '';
  }
}
