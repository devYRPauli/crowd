import { describe, expect, it } from 'vitest'
import { atan2, cos, exp, log, sin } from './libm'
import { Rng, hashString } from './random'

const bits = new DataView(new ArrayBuffer(8))

/** Doubles in order as integers, so the distance between two is in ulps. */
const ordinal = (x: number): bigint => {
  bits.setFloat64(0, x)
  const raw = bits.getBigInt64(0)
  return raw < 0n ? -(raw & 0x7fffffffffffffffn) : raw
}

const ulps = (a: number, b: number): number => {
  if (Number.isNaN(a) && Number.isNaN(b)) return 0
  const d = ordinal(a) - ordinal(b)
  return Number(d < 0n ? -d : d)
}

const worstUlps = <T>(
  count: number,
  draw: () => T,
  ours: (v: T) => number,
  reference: (v: T) => number,
) => {
  let worst = 0
  for (let i = 0; i < count; i++) {
    const v = draw()
    worst = Math.max(worst, ulps(ours(v), reference(v)))
  }
  return worst
}

describe('libm', () => {
  const rng = new Rng('libm')
  const signed = (lo: number, hi: number) =>
    (rng.next() < 0.5 ? -1 : 1) * Math.pow(2, rng.uniform(lo, hi))

  it('agrees with the platform to within an ulp', () => {
    const n = 20000
    expect(worstUlps(n, () => rng.uniform(-10, 10), sin, Math.sin)).toBeLessThanOrEqual(1)
    expect(worstUlps(n, () => rng.uniform(-10, 10), cos, Math.cos)).toBeLessThanOrEqual(1)
    expect(worstUlps(n, () => signed(-30, 20), sin, Math.sin)).toBeLessThanOrEqual(1)
    expect(worstUlps(n, () => signed(-30, 20), cos, Math.cos)).toBeLessThanOrEqual(1)
    // The hard case for a reduction: just off a multiple of a quarter turn.
    const nearQuarter = () =>
      Math.round(rng.uniform(-2e5, 2e5)) * (Math.PI / 2) * (1 + (rng.next() - 0.5) * 1e-15)
    expect(worstUlps(n, nearQuarter, sin, Math.sin)).toBeLessThanOrEqual(1)
    expect(worstUlps(n, nearQuarter, cos, Math.cos)).toBeLessThanOrEqual(1)
    const pair = (): [number, number] => [signed(-60, 60), signed(-60, 60)]
    expect(
      worstUlps(
        n,
        pair,
        ([y, x]) => atan2(y, x),
        ([y, x]) => Math.atan2(y, x),
      ),
    ).toBeLessThanOrEqual(1)
    expect(worstUlps(n, () => rng.uniform(-745, 709.7), exp, Math.exp)).toBeLessThanOrEqual(1)
    expect(
      worstUlps(n, () => Math.pow(2, rng.uniform(-1070, 1023)), log, Math.log),
    ).toBeLessThanOrEqual(1)
    expect(worstUlps(n, () => 1 + (rng.next() - 0.5) * 1e-5, log, Math.log)).toBeLessThanOrEqual(1)
  })

  it('gives the correctly rounded value where one is known', () => {
    expect(sin(1)).toBe(0.8414709848078965)
    expect(cos(1)).toBe(0.5403023058681398)
    expect(sin(100)).toBe(-0.5063656411097588)
    expect(atan2(1, 2)).toBe(0.4636476090008061)
    expect(atan2(-3, -4)).toBe(-2.498091544796509)
    expect(log(10)).toBe(2.302585092994046)
    expect(log(0.001)).toBe(-6.907755278982137)
  })

  it("gives fdlibm's answer where fdlibm is not correctly rounded", () => {
    // fdlibm's exp is good to within an ulp rather than correctly rounded, and
    // these are two of the places that shows: e is 2.718281828459045 and
    // exp(-10) is 4.5399929762484854e-5. A transcription of fdlibm's e_exp.c
    // gives the same two answers.
    expect(exp(1)).toBe(2.7182818284590455)
    expect(exp(-10)).toBe(4.539992976248485e-5)
  })

  it('keeps the special values the platform has', () => {
    expect(Object.is(sin(-0), -0)).toBe(true)
    expect(cos(0)).toBe(1)
    expect(sin(Infinity)).toBeNaN()
    expect(cos(NaN)).toBeNaN()
    expect(Object.is(atan2(-0, 1), -0)).toBe(true)
    expect(atan2(0, -0)).toBe(Math.PI)
    expect(atan2(-0, -1)).toBe(-Math.PI)
    expect(atan2(1, 0)).toBe(Math.PI / 2)
    expect(atan2(1, -Infinity)).toBe(Math.PI)
    expect(atan2(-Infinity, Infinity)).toBe(-Math.PI / 4)
    expect(exp(0)).toBe(1)
    expect(exp(-Infinity)).toBe(0)
    expect(exp(710)).toBe(Infinity)
    expect(exp(-740)).toBe(Math.exp(-740))
    expect(log(1)).toBe(0)
    expect(log(0)).toBe(-Infinity)
    expect(log(-1)).toBeNaN()
    expect(log(5e-324)).toBe(Math.log(5e-324))
  })

  it('stays within what the last bit of a huge angle is worth', () => {
    for (const x of [2e6, -3.3e7, 1e12]) {
      expect(Math.abs(sin(x) - Math.sin(x))).toBeLessThan(Math.abs(x) * 2 ** -52)
      expect(Math.abs(cos(x) - Math.cos(x))).toBeLessThan(Math.abs(x) * 2 ** -52)
    }
  })

  // The point of the module. Every result folded bit for bit into one hash, so
  // a machine that rounds any of them differently fails here rather than in a
  // simulation that has quietly drifted from everybody else's.
  it('computes the same bits on every machine', () => {
    const draw = new Rng('libm fingerprint')
    let text = ''
    const fold = (x: number) => {
      bits.setFloat64(0, x)
      text += bits.getUint32(0).toString(16) + bits.getUint32(4).toString(16)
    }
    for (let i = 0; i < 2000; i++) {
      const angle = draw.uniform(-50, 50)
      fold(sin(angle))
      fold(cos(angle))
      fold(atan2(draw.uniform(-5, 5), draw.uniform(-5, 5)))
      fold(exp(draw.uniform(-30, 30)))
      fold(log(draw.uniform(0, 100)))
    }
    expect(hashString(text)).toBe(1148718059)
  })
})
