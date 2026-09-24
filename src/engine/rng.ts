import { createHash } from 'node:crypto';

/**
 * Small seeded PRNG (mulberry32) whose whole state is one uint32, so it can
 * be checkpointed and restored exactly: a restart continues the same
 * sequence instead of rerolling.
 */
export class Rng {
  private s: number;

  constructor(state: number) {
    this.s = state >>> 0;
  }

  get state(): number {
    return this.s;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(this.s ^ (this.s >>> 15), this.s | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/**
 * Derives an independent stream seed from the run seed. Occupancy and device
 * decisions use separate streams, so switching devices never changes the
 * occupancy sequence (needed for matched original/improved comparisons).
 */
export function streamSeed(seed: number, stream: 'occupancy' | 'devices'): number {
  return createHash('sha256').update(`${seed >>> 0}:${stream}`).digest().readUInt32BE(0);
}

export const isSeed = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff;
