/**
 * Seeded randomness. Every plan is compiled from a seed so a run can be replayed
 * exactly, and tests are deterministic. xoshiro128** seeded via splitmix32.
 */
function hashSeed(seed: string | number): number {
  if (typeof seed === "number") return seed >>> 0;
  // cyrb53-ish, folded to 32 bits
  let h1 = 0xdeadbeef ^ seed.length;
  let h2 = 0x41c6ce57 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

function splitmix32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0);
  };
}

export interface Weighted<T> {
  value: T;
  weight: number;
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  readonly seed: string;

  constructor(seed: string | number) {
    this.seed = String(seed);
    const sm = splitmix32(hashSeed(seed));
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
  }

  /** Uniform float in [0, 1). */
  next(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick() from empty array");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  weighted<T>(items: readonly Weighted<T>[]): T {
    const total = items.reduce((s, i) => s + Math.max(0, i.weight), 0);
    if (total <= 0) return this.pick(items).value;
    let r = this.next() * total;
    for (const it of items) {
      r -= Math.max(0, it.weight);
      if (r < 0) return it.value;
    }
    return items[items.length - 1]!.value;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j] as T, a[i] as T];
    }
    return a;
  }

  /** Standard normal via Box–Muller. */
  normal(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Log-normal sample with the given median and shape sigma, clamped to [min, max].
   * Human dwell times are heavy-tailed: most short, a few very long. Uniform bands
   * (e.g. uniform(120,240)) are themselves a detectable signature.
   */
  lognormal(median: number, sigma: number, min = 0, max = Number.POSITIVE_INFINITY): number {
    const x = Math.exp(Math.log(median) + sigma * this.normal());
    return Math.min(max, Math.max(min, x));
  }

  /** base ± pct (0.2 → ±20%). */
  jitter(base: number, pct: number): number {
    return base * (1 + (this.next() * 2 - 1) * pct);
  }

  /** Derive an independent child generator (for per-profile streams). */
  fork(label: string): Rng {
    return new Rng(`${this.seed}::${label}`);
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}
