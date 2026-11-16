// Population graph (stacked areas of the largest species over time) and the species lineage tree, drawn on
// 2D canvases. Used in the headless page and as an overlay in 3D (V).
import type { Charts as Data, TreeNode } from '../life/protocol';

const hsl = (h: number, l = 60, a = 1): string => `hsla(${Math.round(h * 360)}, 70%, ${l}%, ${a})`;
const DAY = 600;

export class Charts {
  readonly el: HTMLDivElement;
  private readonly pop: HTMLCanvasElement;
  private readonly tree: HTMLCanvasElement;
  private data: Data | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'charts';
    this.el.innerHTML = '<h3>Population</h3><canvas class="pop"></canvas><h3>Species tree <small>(time →, thickness = peak population)</small></h3><canvas class="tree"></canvas>';
    this.pop = this.el.querySelector('.pop')!;
    this.tree = this.el.querySelector('.tree')!;
    addEventListener('resize', () => this.draw());
  }

  set(d: Data): void { this.data = d; this.draw(); }

  private fit(c: HTMLCanvasElement): CanvasRenderingContext2D {
    const r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    g.font = '11px ui-monospace, Menlo, monospace';
    return g;
  }

  draw(): void {
    const d = this.data;
    if (!d || !this.el.isConnected) return;
    this.drawPop(d);
    this.drawTree(d);
  }

  private drawPop(d: Data): void {
    const g = this.fit(this.pop), W = this.pop.clientWidth, H = this.pop.clientHeight, S = d.samples;
    if (S.length < 2) { g.fillStyle = '#9fbf90'; g.fillText('collecting…', 8, 16); return; }
    const t0 = S[0].t, t1 = S[S.length - 1].t, max = Math.max(...S.map((s) => s.total), 1);
    const L = 34, B = 16, x = (t: number): number => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - 4), y = (v: number): number => H - B - (v / max) * (H - B - 6);
    // species seen in the samples, ordered by how much they mattered
    const weight = new Map<number, number>();
    for (const s of S) for (const [id, n] of s.top) weight.set(id, (weight.get(id) ?? 0) + n);
    const ids = [...weight.keys()].sort((a, b) => weight.get(b)! - weight.get(a)!).slice(0, 14);
    const hue = new Map(d.tree.map((n) => [n.id, n.hue]));
    // stacked areas, bottom up
    const base = S.map(() => 0);
    for (const id of ids) {
      g.beginPath();
      S.forEach((s, i) => { const v = base[i] + (s.top.find((p) => p[0] === id)?.[1] ?? 0); g.lineTo(x(s.t), y(v)); });
      for (let i = S.length - 1; i >= 0; i--) g.lineTo(x(S[i].t), y(base[i]));
      g.closePath();
      g.fillStyle = hsl(hue.get(id) ?? (id * 0.137) % 1, 55, 0.85);
      g.fill();
      S.forEach((s, i) => { base[i] += s.top.find((p) => p[0] === id)?.[1] ?? 0; });
    }
    // total outline (includes the small species not stacked)
    g.strokeStyle = '#e8ffd8'; g.lineWidth = 1; g.beginPath();
    S.forEach((s, i) => (i ? g.lineTo(x(s.t), y(s.total)) : g.moveTo(x(s.t), y(s.total))));
    g.stroke();
    // axes
    g.fillStyle = '#9fbf90';
    g.fillText(String(max), 2, 12); g.fillText('0', 2, H - B);
    const days = (t1 - t0) / DAY, step = Math.max(1, Math.ceil(days / 8));
    for (let dd = Math.ceil(t0 / DAY / step) * step; dd * DAY <= t1; dd += step) g.fillText(`d${dd + 1}`, x(dd * DAY) - 6, H - 3);
  }

  private drawTree(d: Data): void {
    const g = this.fit(this.tree), W = this.tree.clientWidth, H = this.tree.clientHeight, N = d.tree;
    if (!N.length) return;
    const byId = new Map(N.map((n) => [n.id, n]));
    const kids = new Map<number, TreeNode[]>();
    for (const n of N) { const p = byId.has(n.parent) ? n.parent : 0; if (!kids.has(p)) kids.set(p, []); kids.get(p)!.push(n); }
    for (const l of kids.values()) l.sort((a, b) => a.first - b.first);
    // depth-first order gives each species a row; children sit right under their parent
    const rows: TreeNode[] = [];
    const walk = (p: number): void => { for (const c of kids.get(p) ?? []) { rows.push(c); walk(c.id); } };
    walk(0);
    const rowH = Math.max(2, Math.min(14, (H - 8) / rows.length)), L = 4, R = 150;
    const x = (t: number): number => L + (t / Math.max(1, d.now)) * (W - L - R);
    const row = new Map(rows.map((n, i) => [n.id, 4 + i * rowH + rowH / 2]));
    for (const n of rows) {
      const yy = row.get(n.id)!, end = n.extinct >= 0 ? n.extinct : d.now;
      const parentY = row.get(n.parent);
      if (parentY !== undefined) { g.strokeStyle = 'rgba(160,200,150,0.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x(n.first), parentY); g.lineTo(x(n.first), yy); g.stroke(); }
      g.strokeStyle = hsl(n.hue, n.count > 0 ? 62 : 38, n.count > 0 ? 1 : 0.7);
      g.lineWidth = Math.max(1, Math.min(rowH * 0.8, Math.log2(1 + n.peak) * 0.7));
      g.beginPath(); g.moveTo(x(n.first), yy); g.lineTo(Math.max(x(end), x(n.first) + 1), yy); g.stroke();
      if (n.count > 0 && rowH >= 6) {
        g.fillStyle = hsl(n.hue, 70);
        g.fillText(`${n.name} ${n.count}`, x(end) + 4, yy + 4);
      } else if (n.count > 0) { g.fillStyle = hsl(n.hue, 70); g.fillRect(x(end) + 2, yy - 1, 3, 3); }
    }
  }
}
