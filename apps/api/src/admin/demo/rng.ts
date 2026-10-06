// Tiny deterministic PRNG (mulberry32) for the demo generators. A fixed seed produces
// the same synthetic baseline / migration every time, so demos are reproducible and
// tests can assert on counts. Not for anything security-sensitive - demo data only.
export interface Rng {
  /** Next float in [0, 1). */
  next(): number
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number
  /** Pick one element of a non-empty array. */
  pick<T>(items: T[]): T
}

/** Build a seeded mulberry32 generator. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  const next = (): number => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1))
  const pick = <T>(items: T[]): T => items[int(0, items.length - 1)] as T
  return { next, int, pick }
}
