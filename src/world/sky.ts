// Day / night cycle: the sun's path, the moon opposite it, and the palette (key light, ambient, sky) keyed on the
// sun's elevation. Adapted from ProceduralWest, re-tinted for a green valley.

type RGB = [number, number, number];

/** Everything the renderer needs to light a moment of the day. */
export interface Light {
  /** Direction towards the key light: the sun by day, the moon by night (unit). */
  dir: RGB;
  rgb: RGB;
  sky: number;
  ambSky: RGB;
  ambGround: RGB;
  zenith: RGB;
  horizon: RGB;
  glow: RGB;
  /** 0 by day, 1 at full night. */
  night: number;
  exposure: number;
}

const ss = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];

interface Key { e: number; sun: RGB; ambSky: RGB; ambGround: RGB; zenith: RGB; horizon: RGB; glow: RGB; sky: number; exposure: number }
const KEYS: Key[] = [
  { e: -0.35, sun: [0, 0, 0], ambSky: [0.03, 0.05, 0.13], ambGround: [0.01, 0.018, 0.03], zenith: [0.08, 0.14, 0.4], horizon: [0.18, 0.26, 0.5], glow: [0.5, 0.6, 0.9], sky: 0.1, exposure: 1.3 },
  { e: -0.12, sun: [0, 0, 0], ambSky: [0.09, 0.1, 0.22], ambGround: [0.035, 0.04, 0.06], zenith: [0.12, 0.16, 0.42], horizon: [0.5, 0.36, 0.5], glow: [0.9, 0.45, 0.4], sky: 0.22, exposure: 1.0 },
  { e: 0.0, sun: [1.5, 0.65, 0.3], ambSky: [0.3, 0.26, 0.28], ambGround: [0.12, 0.12, 0.07], zenith: [0.16, 0.26, 0.58], horizon: [0.95, 0.6, 0.42], glow: [1.0, 0.52, 0.3], sky: 0.6, exposure: 0.66 },
  { e: 0.2, sun: [3.0, 2.5, 1.7], ambSky: [0.34, 0.38, 0.44], ambGround: [0.13, 0.15, 0.08], zenith: [0.17, 0.36, 0.78], horizon: [0.7, 0.78, 0.82], glow: [1.0, 0.8, 0.55], sky: 0.95, exposure: 0.52 },
  { e: 0.6, sun: [3.3, 3.1, 2.7], ambSky: [0.36, 0.42, 0.52], ambGround: [0.14, 0.16, 0.09], zenith: [0.15, 0.38, 0.85], horizon: [0.66, 0.8, 0.9], glow: [1.0, 0.92, 0.75], sky: 1.1, exposure: 0.48 },
];

const MOON: RGB = [0.1, 0.14, 0.28];
const RISE: RGB = [0.77, 0, 0.64];
const NOON: RGB = (() => { const v: RGB = [-0.64 * 0.5, 0.86, 0.77 * 0.5]; const l = Math.hypot(...v); return scale(v, 1 / l); })();

export class DayNight {
  hour = 8.5;
  /** Real seconds for a full day. */
  dayLength = 600;
  paused = false;
  readonly light: Light;

  constructor() {
    this.light = { dir: [0, 1, 0], rgb: [0, 0, 0], sky: 1, ambSky: [0, 0, 0], ambGround: [0, 0, 0], zenith: [0, 0, 0], horizon: [0, 0, 0], glow: [0, 0, 0], night: 0, exposure: 0.5 };
    this.update(0);
  }

  update(dt: number): void {
    if (!this.paused) this.hour = (this.hour + (dt * 24) / this.dayLength) % 24;
    const th = ((this.hour - 6) / 12) * Math.PI;
    const sun = mixc(scale(RISE, Math.cos(th)), scale(NOON, Math.sin(th)), 0.5).map((c) => c * 2) as RGB;
    const sl = Math.hypot(...sun), sd = scale(sun, 1 / sl), e = sd[1];
    let i = 0;
    while (i < KEYS.length - 2 && e > KEYS[i + 1].e) i++;
    const a = KEYS[i], b = KEYS[i + 1], t = ss(a.e, b.e, e);
    const L = this.light;
    L.ambSky = mixc(a.ambSky, b.ambSky, t); L.ambGround = mixc(a.ambGround, b.ambGround, t);
    L.zenith = mixc(a.zenith, b.zenith, t); L.horizon = mixc(a.horizon, b.horizon, t); L.glow = mixc(a.glow, b.glow, t);
    L.sky = a.sky + (b.sky - a.sky) * t; L.exposure = a.exposure + (b.exposure - a.exposure) * t;
    L.night = ss(-0.02, -0.25, e);
    if (e > -0.08) {
      L.dir = sd;
      L.rgb = scale(mixc(a.sun, b.sun, t), ss(-0.06, 0.06, e));
    } else {
      L.dir = scale(sd, -1);
      L.rgb = scale(MOON, ss(-0.1, -0.3, e));
    }
  }

  clock(): string {
    const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
