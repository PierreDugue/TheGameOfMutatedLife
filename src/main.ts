import { DEFAULT_SEED } from './config';
import { Rng } from './core/rng';
import { initGPU, UserError } from './gpu/device';
import { FlyCamera } from './input/camera';
import { Renderer } from './render/renderer';
import { EventLog, HeadlessPanel, hueCss, Inspector, lifeBar, UI, esc } from './ui/ui';
import { Charts } from './ui/charts';
import { LifeClient } from './life/client';
import { LifeDraw } from './life/draw';
import { MAX_SPEED, SPEEDS } from './life/protocol';
import { MAX_PARTICLES } from './life/environment';
import { House } from './world/house';
import { makeLayout, type Pose } from './world/layout';
import { scatter } from './world/scatter';
import { SEASONS, Seasons, type SeasonMode } from './world/season';
import { DayNight } from './world/sky';
import { TOGGLES, Weather, type Toggle } from './world/weather';
import { Terrain } from './world/terrain';
import { uploadTextures } from './world/textures';
import { waterMesh } from './world/water';

function readSeed(): number {
  const s = new URLSearchParams(location.search).get('seed');
  const n = s === null ? NaN : Number.parseInt(s, 10);
  return Number.isFinite(n) ? n >>> 0 : DEFAULT_SEED;
}

/** Life is off unless the URL says `?life=1` (the environment alone is the default). */
const readLife = (): boolean => new URLSearchParams(location.search).get('life') === '1';

/** Preset viewpoints derived from the layout: pond, river, shore, under water, whole valley. */
function poses(T: Terrain): Pose[] {
  const P = T.layout.pond, c = P.c, cr = Math.cos(P.rot), sr = Math.sin(P.rot);
  const r = T.river[Math.floor(T.river.length * 0.22)];
  const shore: [number, number] = [c[0] + cr * P.rx * 1.08, c[1] + sr * P.rx * 1.08];
  return [
    [c[0] - 24, 7, c[1] - 22, c[0], 0, c[1]],
    [r.x - r.tz * 9, 3.6, r.z + r.tx * 9, r.x + r.tx * 4, r.level, r.z + r.tz * 4],
    [shore[0], 0.9, shore[1], c[0], 0, c[1]],
    [c[0] + cr * 3, 1.0, c[1] + sr * 3, shore[0], -0.8, shore[1]],
    [-56, 22, -56, 0, 0, 0],
  ];
}

async function main(): Promise<void> {
  const ui = new UI();
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const seed = readSeed();
  ui.seed.value = String(seed);
  let lifeOn = readLife();
  document.documentElement.classList.toggle('nolife', !lifeOn);
  /** New world: same URL options (life, season), new seed. */
  const goSeed = (s: number): void => {
    const q = new URLSearchParams(location.search);
    q.set('seed', String(s >>> 0));
    location.search = `?${q}`;
  };
  /** Sets or removes one URL option without reloading. */
  const setParam = (k: string, v: string | null): void => {
    const q = new URLSearchParams(location.search);
    if (v === null) q.delete(k); else q.set(k, v);
    window.history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  };
  ui.reseed.onclick = () => goSeed(Math.floor(Math.random() * 1e6));
  ui.seed.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') goSeed(Number.parseInt(ui.seed.value, 10) || 0); });
  try {
    await ui.progress('Waking the GPU…', 0.05);
    const gpu = await initGPU(canvas);

    await ui.progress('Shaping the valley…', 0.15);
    let t0 = performance.now();
    const layout = makeLayout(new Rng(seed));
    const T = new Terrain(layout, seed);
    const terrain = T.mesh();
    const water = waterMesh(T);
    console.info(`terrain: ${(performance.now() - t0).toFixed(0)} ms, ${terrain.ib.length / 3} tris; water ${water.ib.length / 3} tris`);

    await ui.progress('Painting the pixels…', 0.45);
    const atlas = uploadTextures(gpu.device, seed);

    await ui.progress('Growing trees and grass…', 0.6);
    t0 = performance.now();
    const POSES = poses(T);
    const house = new House(T, POSES.map((p) => [p[0], p[2]]));
    const S = scatter(T, seed, POSES.map((p) => [p[0], p[2], 2.5]), [house.cx, house.cz, house.clearR]);
    console.info(`scatter: ${(performance.now() - t0).toFixed(0)} ms, solid ${S.solid.nv} v, cutout ${S.cutout.nv} v`, S.counts);

    await ui.progress('Stirring the primordial soup…', 0.8);
    t0 = performance.now();
    const draw = new LifeDraw(T, 4000, MAX_PARTICLES);
    const life = new LifeClient(seed, draw, lifeOn);
    await life.ready();
    console.info(`life worker ready: ${(performance.now() - t0).toFixed(0)} ms`);

    await ui.progress('Lighting the sun…', 0.9);
    const renderer = new Renderer(gpu, { terrain, solid: S.solid, cutout: S.cutout, water, houseSolid: house.solid, houseCutout: house.cutout }, atlas);
    const cam = new FlyCamera(T, canvas);
    const sky = new DayNight();
    // seasons: follow the calendar (auto) or stay pinned to one, from the menu, K, or ?season=… in the URL
    const seasons = new Seasons();
    const MODES: SeasonMode[] = ['auto', ...SEASONS];
    const qs = new URLSearchParams(location.search).get('season') as SeasonMode | null;
    if (qs && MODES.includes(qs)) seasons.mode = qs;
    const seasonBtns = [...document.querySelectorAll<HTMLButtonElement>('.season button')];
    const setSeason = (m: SeasonMode): void => {
      seasons.mode = m;
      for (const b of seasonBtns) b.classList.toggle('on', b.dataset.s === m);
      setParam('season', m === 'auto' ? null : m);
    };
    for (const b of seasonBtns) b.onclick = () => setSeason(b.dataset.s as SeasonMode);
    setSeason(seasons.mode);
    // weather: auto (by season, rolled from the seed) or each part forced on / off, from the menu or ?rain= ?fog= ?wind=
    const weather = new Weather(seed);
    type Part = 'rain' | 'fog' | 'wind';
    const modeKey = { rain: 'precipMode', fog: 'fogMode', wind: 'windMode' } as const;
    const weatherBtns = [...document.querySelectorAll<HTMLButtonElement>('.weather button')];
    const labelWeather = (): void => {
      for (const b of weatherBtns) {
        const part = b.dataset.w as Part, m = weather[modeKey[part]];
        const name = part === 'rain' ? (seasons.name === 'winter' ? 'Snow' : 'Rain') : part === 'fog' ? 'Fog' : 'Wind';
        b.textContent = `${name}: ${m}`;
        b.classList.toggle('on', m !== 'auto');
      }
    };
    const setWeather = (part: Part, m: Toggle): void => {
      weather[modeKey[part]] = m;
      setParam(part, m === 'auto' ? null : m);
      labelWeather();
    };
    for (const b of weatherBtns) b.onclick = () => {
      const part = b.dataset.w as Part;
      setWeather(part, TOGGLES[(TOGGLES.indexOf(weather[modeKey[part]]) + 1) % TOGGLES.length]);
    };
    for (const part of ['rain', 'fog', 'wind'] as Part[]) {
      const v = new URLSearchParams(location.search).get(part) as Toggle | null;
      setWeather(part, v && TOGGLES.includes(v) ? v : 'auto');
    }
    const seasonLabel = (): string => {
      const n = seasons.name;
      const w = weather.label();
      return `${n[0].toUpperCase()}${n.slice(1)}${seasons.mode === 'auto' ? '' : ' (pinned)'}${w ? ` · ${w}` : ''}`;
    };
    cam.pose(POSES[0]);
    addEventListener('resize', () => renderer.resize());

    // ---- life: the worker simulates; here we draw, select, follow and steer time ----
    let speedI = 2, lifePaused = false, selected = 0;
    const inspector = new Inspector(), events = new EventLog();
    const clock = (t: number, hour?: number, dayN?: number): string => {
      const day = dayN ?? Math.floor((8.5 + (t * 24) / 600) / 24) + 1, h = hour ?? (8.5 + (t * 24) / 600) % 24;
      return `Day ${day} ${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
    };
    // ---- headless mode: the worker runs flat out, the page shows statistics and the full log ----
    const panel = new HeadlessPanel();
    const history: { t: number; text: string }[] = [];
    let headless = false, headlessSpeed = MAX_SPEED;
    life.onLog = (list) => {
      for (const e of list) {
        events.push(clock(e.t), e.text);
        history.push(e);
        if (headless) panel.add(clock(e.t), e.text);
      }
      if (history.length > 1000) history.splice(0, history.length - 1000);
    };
    const markSpeed = (): void => {
      for (const b of panel.speeds) b.classList.toggle('on', (b.dataset.s === 'max' ? MAX_SPEED : Number(b.dataset.s)) === headlessSpeed);
    };
    // screenshots (C): the next rendered frame is saved as a PNG named after the seed and the simulated time
    const toast = document.getElementById('toast')!;
    let toastTimer = 0;
    const showToast = (text: string): void => {
      toast.textContent = text;
      toast.className = 'on';
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => { toast.className = ''; }, 2200);
    };
    const saveScreenshot = (): void => {
      const s = life.snap!, h = Math.floor(s.hour), m = Math.floor((s.hour % 1) * 60);
      const name = `mutated-life-seed${seed}-day${s.day + 1}-${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}.png`;
      void renderer.capture().then((blob) => {
        if (!blob) { toast.textContent = 'Screenshot failed'; return; }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        showToast(`Saved ${name}`);
      });
      // render one frame now, so it also works while paused or with the page hidden
      const snap = life.snap!;
      draw.build(snap.orgs, snap.n, snap.particles, snap.np, [cam.x, cam.y, cam.z], renderer.lowH / (2 * 0.62), selected, time);
      renderer.setLife(draw.imp, draw.impCount, draw.firstCell);
      renderer.setCreatures(draw.prim, draw.counts);
      renderer.render(cam, time, sky.light, cam.underwater());
      document.body.classList.add('flash');
      setTimeout(() => document.body.classList.remove('flash'), 150);
    };
    (document.getElementById('shotBtn') as HTMLButtonElement).onclick = () => saveScreenshot();
    // charts: in the headless page, or as an overlay in 3D (V); refreshed every second while shown
    const charts = new Charts();
    let chartsOverlay = false;
    life.onCharts = (c) => charts.set(c);
    setInterval(() => { if (headless || chartsOverlay) life.send({ t: 'charts' }); }, 1000);
    const showOverlay = (on: boolean): void => {
      chartsOverlay = on;
      if (on) { charts.el.className = 'overlay'; document.body.appendChild(charts.el); life.send({ t: 'charts' }); }
      else charts.el.remove();
    };
    const enterHeadless = (): void => {
      headless = true;
      showOverlay(false);
      charts.el.className = '';
      document.getElementById('hlCharts')!.appendChild(charts.el);
      life.send({ t: 'charts' });
      document.body.className = 'headless';
      life.send({ t: 'lite', on: true });
      life.send({ t: 'speed', speed: headlessSpeed });
      markSpeed();
      panel.clear();
      for (const e of history) panel.add(clock(e.t), e.text);
    };
    const exitHeadless = (): void => {
      headless = false;
      charts.el.remove();
      life.send({ t: 'lite', on: false });
      life.send({ t: 'speed', speed: SPEEDS[speedI] });
      ui.menu(true);
    };
    for (const b of panel.speeds) b.onclick = () => {
      headlessSpeed = b.dataset.s === 'max' ? MAX_SPEED : Number(b.dataset.s);
      life.send({ t: 'speed', speed: headlessSpeed });
      markSpeed();
    };
    const togglePause = (): void => {
      lifePaused = !lifePaused;
      life.send({ t: 'pause', paused: lifePaused });
      panel.pause.textContent = lifePaused ? 'Resume' : 'Pause';
    };
    panel.pause.onclick = togglePause;
    panel.seed.onclick = () => life.send({ t: 'seedLife' });
    panel.back.onclick = exitHeadless;
    (document.getElementById('headlessGo') as HTMLButtonElement).onclick = enterHeadless;
    /** Headless statistics refresh on a timer, so they stay live even when the tab is in the background. */
    const updatePanel = (): void => {
      const snap = life.snap!;
      if (!headless || !snap.lite) return;
      const act = snap.actual, req = snap.requested >= MAX_SPEED ? 'max' : `×${snap.requested}`;
      const causes = snap.species.reduce<Record<string, number>>((a, sp) => { for (const [k, v] of Object.entries(sp.causes)) a[k] = (a[k] ?? 0) + v; return a; }, {});
      panel.show(
        `<b>${clock(snap.time, snap.hour, snap.day + 1)}</b>${snap.paused ? ' · paused' : ''}${snap.event ? ` · event: ${esc(snap.event)}` : ''}\n` +
        `Speed ${req} requested · <b>×${act.toFixed(0)}</b> actual · ${(act / 600).toFixed(2)} days/s · ${snap.stepsPerSec.toFixed(0)} steps/s\n` +
        `Simulation thread ${(snap.busy * 100).toFixed(0)}% busy · ${snap.stepsPerSec > 0 ? ((snap.busy * 1000) / snap.stepsPerSec).toFixed(2) : '–'} ms per step\n` +
        `<b>${snap.count}</b> organisms · ${snap.speciesAlive} species · generation ${snap.maxGen} · largest organism ${snap.maxCells} cell${snap.maxCells > 1 ? 's' : ''}\n` +
        `${snap.births} born (${snap.sexual} of two parents) · ${snap.deaths} died · ${snap.eaten} eaten · pressure ×${snap.pressure}\n` +
        (snap.count ? `Deaths in the top species: ${Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}`
          : 'Life went extinct — press “New first cell”.'),
        snap.species,
      );
    };
    setInterval(updatePanel, 250);

    const follow = (): void => {
      const id = selected;
      if (id) cam.startFollow(() => life.pos(id));
    };
    life.onFocus = (id) => { selected = id; life.send({ t: 'select', id }); follow(); };
    const select = (id: number): void => { selected = id; life.send({ t: 'select', id }); inspector.show(null); barT = 1; };
    for (const b of document.querySelectorAll<HTMLButtonElement>('.pressure button')) {
      b.onclick = () => {
        life.send({ t: 'pressure', value: { gentle: 0.8, normal: 1, harsh: 1.3 }[b.dataset.p as 'gentle' | 'normal' | 'harsh'] });
        for (const o of document.querySelectorAll('.pressure button')) o.classList.toggle('on', o === b);
      };
    }
    // the cabin: off by default, from the menu or ?house=1; key 6 goes inside by the fire
    const houseBtn = document.getElementById('houseToggle') as HTMLButtonElement;
    let houseOn = false;
    const setHouse = (on: boolean): void => {
      houseOn = on;
      renderer.setHouse(house.uniforms(on));
      cam.house = on ? house : null;
      houseBtn.textContent = on ? 'House: on' : 'House: off';
      houseBtn.classList.toggle('on', on);
      setParam('house', on ? '1' : null);
    };
    houseBtn.onclick = () => setHouse(!houseOn);
    setHouse(new URLSearchParams(location.search).get('house') === '1');
    const insidePose = (): Pose => {
      const [ex, ez] = house.world(0.2, 1.9), f = house.firePos();
      return [ex, house.floor + 1.6 - T.groundAt(ex, ez), ez, f[0], f[1] + 0.3, f[2]];
    };
    const lifeBtn = document.getElementById('lifeToggle') as HTMLButtonElement;
    const setLife = (on: boolean): void => {
      lifeOn = on;
      life.send({ t: 'life', on });
      document.documentElement.classList.toggle('nolife', !on);
      lifeBtn.textContent = on ? 'Life: on' : 'Life: off';
      lifeBtn.classList.toggle('on', on);
      setParam('life', on ? '1' : null);
      if (!on) {
        selected = 0; cam.follow = null; inspector.show(null); showOverlay(false);
        renderer.setLife(draw.imp, 0, 0);
        renderer.setCreatures(draw.prim, [0, 0, 0]);
      }
    };
    lifeBtn.onclick = () => setLife(!lifeOn);
    lifeBtn.textContent = lifeOn ? 'Life: on' : 'Life: off';
    lifeBtn.classList.toggle('on', lifeOn);

    if (import.meta.env.DEV) {
      Object.assign(window, { life: { cam, renderer, T, sky, POSES, S, client: life, draw, house, insidePose } });
      void import('./dev/evo').then((m) => m.installEvo(T));
    }

    let time = 0, last = performance.now(), hudT = 0, hudN = 0, worst = 0, barT = 1;
    const frame = (now: number): void => {
      requestAnimationFrame(frame);
      const dtr = now - last; last = now;
      const dt = Math.min(dtr / 1000, 0.1);
      time += dt;
      const snap = life.snap!;
      if (headless) {
        return;
      }
      sky.hour = snap.hour; sky.update(0);
      const days = snap.day + snap.hour / 24;
      seasons.update(days, dt);
      renderer.season = seasons.w;
      weather.update(days, seasons.w, dt);
      weather.dim(sky.light);
      renderer.weather.set([
        weather.precip, weather.snow, weather.fog, weather.wind,
        weather.drift[0], weather.drift[1], weather.fall, 0,
        Math.cos(weather.heading), Math.sin(weather.heading), weather.cloud[0], weather.cloud[1],
      ]);
      renderer.precipCount = Math.round(weather.precip * (weather.snow > 0.5 ? 18000 : 14000));
      cam.update(dt);
      if (lifeOn) {
        const pxPerRad = renderer.lowH / (2 * 0.62);
        draw.build(snap.orgs, snap.n, snap.particles, snap.np, [cam.x, cam.y, cam.z], pxPerRad, selected, time);
        renderer.setLife(draw.imp, draw.impCount, draw.firstCell);
        renderer.setCreatures(draw.prim, draw.counts);
      }
      renderer.render(cam, time, sky.light, cam.underwater());

      barT += dt;
      if (barT > 0.25) {
        barT = 0;
        const req = snap.requested, act = snap.actual;
        const speedTxt = snap.paused ? '<span class="warn">paused</span>'
          : `×${req}${act < req * 0.9 ? ` requested · <span class="warn">×${act.toFixed(0)} actual</span>` : ''}${act >= 30 ? ` · ${(act / 600).toFixed(2)} days/s` : ''}`;
        labelWeather();
        const top = snap.species.slice(0, 4).map((sp) => `<span class="sp" style="color:${hueCss(sp.hue)}">${esc(sp.name)}</span> ${sp.count}`).join(' · ');
        if (!lifeOn) lifeBar(`${clock(snap.time, snap.hour, snap.day + 1)} · ${seasonLabel()}${snap.sunPaused ? ' (sun paused)' : ''} · ${speedTxt}`);
        else lifeBar(`${clock(snap.time, snap.hour, snap.day + 1)} · ${seasonLabel()}${snap.sunPaused ? ' (sun paused)' : ''} · ${speedTxt}${snap.event ? ` · <span class="warn">${esc(snap.event)}</span>` : ''}\n` +
          (snap.n ? `${snap.n} organisms · ${snap.speciesAlive} species · gen ${snap.maxGen} · up to ${snap.maxCells} cells · ${snap.births} born (${snap.sexual} of two parents) · ${snap.deaths} died · ${snap.eaten} eaten\n${top}`
            : '<span class="warn">Life went extinct — press N for a new first cell</span>'));
        const d = snap.detail;
        if (selected && d && d.id === selected) inspector.show({ ...d, following: !!cam.follow });
      }
      if (ui.hudOn) {
        hudN++; hudT += dtr; worst = Math.max(worst, dtr);
        if (hudT > 500) {
          ui.stats(`seed ${seed} · ${((hudN * 1000) / hudT).toFixed(0)} fps · worst ${worst.toFixed(1)} ms · sim ${snap.stepsPerSec.toFixed(0)} steps/s (×${snap.actual.toFixed(1)})\n` +
            `${renderer.lowW}×${renderer.lowH} → ${renderer.width}×${renderer.height} · ${draw.counts.reduce((a, b) => a + b, 0)} parts drawn · ${cam.walking ? 'walking' : `fly ${cam.speed.toFixed(1)} m/s`} · ` +
            `${cam.x.toFixed(1)}, ${cam.y.toFixed(1)}, ${cam.z.toFixed(1)}${cam.underwater() ? ' · underwater' : ''}`);
          hudT = hudN = worst = 0;
        }
      }
    };

    const play = (): void => { void canvas.requestPointerLock(); };
    ui.go.onclick = play;
    canvas.addEventListener('click', () => {
      if (!document.pointerLockElement) { play(); return; }
      if (!lifeOn) return;
      select(life.pick([cam.x, cam.y, cam.z], cam.forward()));
      if (!selected) cam.follow = null;
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      cam.enabled = locked;
      if (!locked) cam.release();
      ui.menu(!locked);
      if (locked) ui.go.textContent = 'Resume';
    });
    addEventListener('keydown', (e) => {
      if (e.repeat || e.target instanceof HTMLInputElement) return;
      if (headless) {
        if (e.code === 'Space') { e.preventDefault(); togglePause(); }
        else if (e.code === 'Escape') exitHeadless();
        return;
      }
      if (!lifeOn && ['KeyL', 'KeyV', 'KeyF', 'KeyN', 'KeyG'].includes(e.code)) return;
      if (e.code === 'KeyH') ui.toggleHud();
      else if (e.code === 'KeyK') {
        setSeason(MODES[(MODES.indexOf(seasons.mode) + 1) % MODES.length]);
        showToast(seasons.mode === 'auto' ? 'Seasons follow the calendar' : `Season: ${seasons.mode}`);
      }
      else if (e.code === 'KeyM') {
        cam.setWalking(!cam.walking);
        showToast(cam.walking ? 'Walking · WASD move · Shift run · E jump · M to fly' : 'Flying · E / Q up / down · M to walk');
      }
      else if (e.code === 'KeyP') renderer.setPixel(!renderer.pixel);
      else if (e.code === 'KeyL') events.toggle();
      else if (e.code === 'KeyV') showOverlay(!chartsOverlay);
      else if (e.code === 'KeyC') saveScreenshot();
      else if (e.code === 'KeyT') life.send({ t: 'sunPause' });
      else if (e.code === 'Space') togglePause();
      else if (e.code === 'Equal' || e.code === 'NumpadAdd') { speedI = Math.min(SPEEDS.length - 1, speedI + 1); life.send({ t: 'speed', speed: SPEEDS[speedI] }); }
      else if (e.code === 'Minus' || e.code === 'NumpadSubtract') { speedI = Math.max(0, speedI - 1); life.send({ t: 'speed', speed: SPEEDS[speedI] }); }
      else if (e.code === 'KeyF') { if (cam.follow) cam.follow = null; else follow(); }
      else if (e.code === 'KeyN') life.send({ t: 'seedLife' });
      else if (e.code === 'KeyG') {
        const id = life.randomId(), p = id ? life.pos(id) : null;
        if (p) {
          select(id);
          const f = cam.forward();
          cam.x = p[0] - f[0] * 0.3; cam.y = p[1] - f[1] * 0.3; cam.z = p[2] - f[2] * 0.3;
          follow();
        }
      }
      else if (e.code === 'BracketLeft') life.send({ t: 'hour', delta: -1 });
      else if (e.code === 'BracketRight') life.send({ t: 'hour', delta: 1 });
      else if (/^Digit[1-9]$/.test(e.code)) {
        const i = e.code.charCodeAt(5) - 49;
        const p = i === 5 && houseOn ? insidePose() : POSES[i];
        if (p) cam.pose(p);
      }
    });

    renderer.render(cam, 0, sky.light, cam.underwater());
    await gpu.device.queue.onSubmittedWorkDone();
    await ui.progress('Ready', 1);
    ui.menu(true);
    requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
  } catch (err) {
    console.error(err);
    ui.error(err instanceof UserError ? err.message : `Something went wrong: ${(err as Error).message}`);
  }
}

void main();
