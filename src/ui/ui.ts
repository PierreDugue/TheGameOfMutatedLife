const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Loading bar, start / pause menu and stats HUD (markup in index.html). */
export class UI {
  private readonly status = $('status');
  private readonly fill = $('fill');
  private readonly hud = $('hud');
  readonly go = $<HTMLButtonElement>('go');
  readonly seed = $<HTMLInputElement>('seed');
  readonly reseed = $<HTMLButtonElement>('reseed');
  hudOn = false;

  /** Shows a loading message and moves the bar, then yields so the browser can paint it. */
  async progress(message: string, share: number): Promise<void> {
    this.status.textContent = message;
    this.fill.style.transform = `scaleX(${share})`;
    await new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 50); });
  }

  error(message: string): void {
    document.body.className = 'error';
    this.status.textContent = message;
  }

  menu(open: boolean): void {
    document.body.className = open ? 'menu' : 'playing';
    if (open) setTimeout(() => this.go.focus(), 100);
  }

  stats(text: string): void { this.hud.textContent = text; }
  toggleHud(): void { this.hudOn = !this.hudOn; this.hud.textContent = ''; }
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** CSS colour for a species hue. */
export const hueCss = (h: number): string => `hsl(${Math.round(h * 360)}, 75%, 65%)`;

export interface InspectorData {
  id: number; alive: boolean; death: string; gen: number; age: number; energy: number; divideAt: number; children: number;
  body: string; parts: string[]; history: string[]; speed: number;
  species: { name: string; hue: number; count: number; peak: number; speed: number; intake: number; offspring: number; causes: Record<string, number>; parent: string };
  following: boolean;
}

/** Selected-organism panel. */
export class Inspector {
  private readonly el = $('inspector');
  show(c: InspectorData | null): void {
    if (!c) { this.el.className = ''; return; }
    this.el.className = 'on';
    const sp = c.species;
    const pct = Math.max(0, Math.min(100, (c.energy / c.divideAt) * 100));
    const deaths = Object.entries(sp.causes).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${esc(k)} ${Math.round((v / Math.max(1, Object.values(sp.causes).reduce((x, y) => x + y, 0))) * 100)}%`).join(' · ');
    this.el.innerHTML =
      `<h2>#${c.id} · <span class="sp" style="color:${hueCss(sp.hue)}">${esc(sp.name)}</span></h2>` +
      (c.alive ? '' : `<div class="dead">Dead — ${esc(c.death)}</div>`) +
      `Generation ${c.gen} · age ${c.age.toFixed(0)} s · ${c.children} children<br />` +
      `${esc(c.body)} · ${c.speed.toFixed(1)} cm/s<br />` +
      `Energy ${c.energy.toFixed(1)} / ${c.divideAt.toFixed(1)} to divide<div class="bar"><div style="width:${pct}%"></div></div>` +
      `Body plan (${c.parts.length} parts)<ul>${c.parts.map((t) => `<li>${esc(t)}</li>`).join('') || '<li>bare membrane</li>'}</ul>` +
      (c.history.length ? `<div class="sub">Recent mutations</div><ul>${c.history.slice(-5).reverse().map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '') +
      `<div class="sub">Species: ${sp.count} alive (peak ${sp.peak})${sp.parent ? ` · from ${esc(sp.parent)}` : ''}<br />` +
      `speed ${sp.speed.toFixed(1)} cm/s · intake ${(sp.intake * 100).toFixed(1)} /100 s · ${sp.offspring.toFixed(2)} offspring each` +
      (deaths ? `<br />deaths: ${deaths}` : '') + `</div>` +
      `<div class="hint">${c.following ? 'Following · wheel zoom · WASD to leave' : 'F follow · click elsewhere to deselect'}</div>`;
  }
}

/** Always-on lines with the state of life. */
export function lifeBar(html: string): void { $('lifebar').innerHTML = html; }

/** Evolution log: the latest events. */
export class EventLog {
  private readonly el = $('log');
  private readonly lines: string[] = [];
  push(when: string, text: string): void {
    this.lines.push(`<div><span class="t">${esc(when)}</span> ${esc(text)}</div>`);
    if (this.lines.length > 8) this.lines.shift();
    this.el.innerHTML = this.lines.join('');
  }
  clear(): void { this.lines.length = 0; this.el.innerHTML = ''; }
  toggle(): void { this.el.classList.toggle('off'); }
}

/** Headless mode: live statistics, species table and the full log, no 3D. */
export class HeadlessPanel {
  private readonly stats = $('hlStats');
  private readonly table = $('hlSpecies');
  private readonly log = $('hlLog');
  private readonly count = $('hlLogCount');
  readonly pause = $<HTMLButtonElement>('hlPause');
  readonly seed = $<HTMLButtonElement>('hlSeed');
  readonly back = $<HTMLButtonElement>('hlBack');
  readonly speeds = [...document.querySelectorAll<HTMLButtonElement>('#headless .speeds button')];
  private lines = 0;

  show(html: string, species: { name: string; hue: number; count: number; peak: number; speed: number; intake: number; offspring: number; parent: string }[]): void {
    this.stats.innerHTML = html;
    this.table.innerHTML = '<tr><th>Species</th><th>alive</th><th>peak</th><th>cm/s</th><th>intake</th><th>offspring</th><th>from</th></tr>' +
      species.map((s) => `<tr><td style="color:${hueCss(s.hue)}">${esc(s.name)}</td><td>${s.count}</td><td>${s.peak}</td>` +
        `<td>${s.speed.toFixed(2)}</td><td>${(s.intake * 100).toFixed(1)}</td><td>${s.offspring.toFixed(2)}</td><td>${esc(s.parent)}</td></tr>`).join('');
  }

  /** Newest first; keeps the last 1000 lines. */
  add(when: string, text: string): void {
    const d = document.createElement('div');
    d.innerHTML = `<span class="t">${esc(when)}</span> ${esc(text)}`;
    this.log.prepend(d);
    if (++this.lines > 1000) { this.log.lastElementChild?.remove(); this.lines--; }
    this.count.textContent = `(${this.lines})`;
  }

  clear(): void { this.log.innerHTML = ''; this.lines = 0; this.count.textContent = ''; }
}

export { esc };
