import { signature, sigDistance, type Genome } from './genome';

const SYL = ['ba', 'ce', 'di', 'fo', 'gu', 'ka', 'le', 'mi', 'no', 'pu', 'ra', 'se', 'ti', 'vo', 'xa', 'zu', 'lo', 'mor', 'vel', 'rix', 'nar', 'tho', 'quo', 'lis', 'pha', 'dro', 'gly', 'syn'];
const END = ['a', 'us', 'ix', 'on', 'ella', 'ida', 'um', 'is', 'or', 'ax'];

function speciesName(id: number): string {
  let h = Math.imul(id + 7, 2654435761) >>> 0;
  const r = (n: number): number => { const v = h % n; h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; return v; };
  const n = 1 + r(2);
  let s = '';
  for (let i = 0; i < n; i++) s += SYL[r(SYL.length)];
  s += END[r(END.length)];
  return s[0].toUpperCase() + s.slice(1);
}

/** A cluster of similar body plans and its running statistics. */
export class Species {
  count = 0;
  peak = 0;
  born = 0;
  died = 0;
  causes: Record<string, number> = {};
  extinctAt = -1;
  announced = false;
  /** For averages: speed samples, energy gathered, organism-seconds lived. */
  speedSum = 0; speedN = 0; intake = 0; lived = 0;
  constructor(readonly id: number, readonly name: string, readonly sig: number[], readonly hue: number, readonly parent: number, readonly firstSeen: number) {}
}

/** Assigns newborns to species: a child that drifted too far from its species' founder starts a new one. */
export class SpeciesBook {
  readonly all: Species[] = [];
  private next = 1;
  /** Signature distance that splits a species (≈ two part gains / losses, or a large shape change). */
  threshold = 2.5;
  private readonly names = new Set<string>();

  found(g: Genome, parent: number, time: number): Species {
    const id = this.next++;
    let name = speciesName(id);
    for (let k = 2; this.names.has(name); k++) name = `${speciesName(id)} ${['', '', 'II', 'III', 'IV', 'V', 'VI', 'VII'][k] ?? k}`;
    this.names.add(name);
    // label colour: spread around the wheel by id so related species stay tellable apart in charts
    const s = new Species(id, name, signature(g), (id * 0.618034 + 0.25) % 1, parent, time);
    this.all.push(s);
    return s;
  }

  assign(g: Genome, parent: Species, time: number): Species {
    return sigDistance(signature(g), parent.sig) > this.threshold ? this.found(g, parent.id, time) : parent;
  }

  get(id: number): Species | undefined { return this.all[id - 1]; }
  living(): Species[] { return this.all.filter((s) => s.count > 0); }
}
