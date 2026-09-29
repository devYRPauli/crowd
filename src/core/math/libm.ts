/**
 * Transcendental functions that return the same bits on every machine.
 *
 * `Math.sin`, `Math.exp` and the rest are only specified to be approximately
 * right, and V8 builds them from C that the compiler is free to contract into
 * fused multiply-adds on arm64 and not on x86. The last bit differs, a crowd
 * amplifies it, and the same seed then simulates differently on a Mac and on
 * CI: a 300-person exit-choice run split 160/140 on one and 150/150 on the
 * other. These are fdlibm's algorithms written with nothing but `+ - * /`,
 * which JavaScript rounds the same way everywhere, so anything the simulation
 * computes from them is a function of the seed alone.
 *
 * Accurate to within an ulp of the true value, like the libraries they replace.
 *
 * Derived from fdlibm. Copyright (C) 1993 by Sun Microsystems, Inc. All rights
 * reserved. Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this software is freely
 * granted, provided that this notice is preserved.
 */

const scratch = new DataView(new ArrayBuffer(8))

const highWord = (x: number): number => {
  scratch.setFloat64(0, x)
  return scratch.getUint32(0)
}

const withHighWord = (x: number, high: number): number => {
  scratch.setFloat64(0, x)
  scratch.setUint32(0, high)
  return scratch.getFloat64(0)
}

/** 2^k for an integer k from -1022 to 1023. */
const twoTo = (k: number): number => withHighWord(0, (k + 0x3ff) << 20)

const signBit = (x: number): boolean => x < 0 || Object.is(x, -0)

// pi/2 as three 33-bit parts and a tail. Each part times an n below 2^20 is
// exact, which is what lets the reduction below lose nothing.
const INV_PIO2 = 6.36619772367581382433e-1
const PIO2_1 = 1.57079632673412561417
const PIO2_2 = 6.0771005063039659766e-11
const PIO2_3 = 2.0222662487111664558e-21
const PIO2_3T = 8.47842766036889956997e-32
const PIO4 = 0.7853981633974483
const REDUCE_LIMIT = 1647099.3291652855
const TWO_PI = 6.283185307179586

let remainderHi = 0
let remainderLo = 0

/**
 * x - n*pi/2 as `remainderHi + remainderLo`, for the nearest n, which it
 * returns. The subtractions are exact two-sums rather than fdlibm's checks on
 * how much cancelled. It stops where fdlibm's second pass does, good to about
 * n * 2^-122, and leaves out the third, which only an angle within n * 2^-70
 * of a multiple of pi/2 needs. No double below 6400 comes within 25 times that.
 */
const reducePio2 = (x: number): number => {
  // Past 2^20 quarter-turns the parts stop being exact. No angle a venue
  // produces gets there; one that did loses what its own last bit is worth.
  if (Math.abs(x) >= REDUCE_LIMIT) x %= TWO_PI
  const n = Math.round(x * INV_PIO2)
  const r = x - n * PIO2_1
  const w = -n * PIO2_2
  const s = r + w
  const sw = s - r
  const e = r - (s - sw) + (w - sw)
  const tail = e - n * PIO2_3 - n * PIO2_3T
  const hi = s + tail
  const tw = hi - s
  remainderHi = hi
  remainderLo = s - (hi - tw) + (tail - tw)
  return n
}

const S1 = -1.66666666666666324348e-1
const S2 = 8.33333333332248946124e-3
const S3 = -1.98412698298579493134e-4
const S4 = 2.75573137070700676789e-6
const S5 = -2.50507602534068634195e-8
const S6 = 1.58969099521155010221e-10

/** sin(x + y) for |x| <= pi/4, where y is the tail of a reduced argument. */
const kernelSin = (x: number, y: number): number => {
  const z = x * x
  const v = z * x
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
  return x - (z * (0.5 * y - v * r) - y - v * S1)
}

const C1 = 4.16666666666666019037e-2
const C2 = -1.38888888888741095749e-3
const C3 = 2.48015872894767294178e-5
const C4 = -2.75573143513906633035e-7
const C5 = 2.0875723212981748279e-9
const C6 = -1.13596475577881948265e-11

/** cos(x + y) for |x| <= pi/4. */
const kernelCos = (x: number, y: number): number => {
  const z = x * x
  const w = z * z
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6))
  const hz = 0.5 * z
  const one = 1 - hz
  return one + (1 - one - hz + (z * r - x * y))
}

export const sin = (x: number): number => {
  const ax = Math.abs(x)
  // Keeps sin(-0) = -0, which the polynomial would round to +0.
  if (ax < 7.450580596923828e-9) return x
  if (ax <= PIO4) return kernelSin(x, 0)
  const n = reducePio2(x)
  switch (n & 3) {
    case 0:
      return kernelSin(remainderHi, remainderLo)
    case 1:
      return kernelCos(remainderHi, remainderLo)
    case 2:
      return -kernelSin(remainderHi, remainderLo)
    default:
      return -kernelCos(remainderHi, remainderLo)
  }
}

export const cos = (x: number): number => {
  if (Math.abs(x) <= PIO4) return kernelCos(x, 0)
  const n = reducePio2(x)
  switch (n & 3) {
    case 0:
      return kernelCos(remainderHi, remainderLo)
    case 1:
      return -kernelSin(remainderHi, remainderLo)
    case 2:
      return -kernelCos(remainderHi, remainderLo)
    default:
      return kernelSin(remainderHi, remainderLo)
  }
}

const ATAN_HI = [
  4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1,
  1.570796326794896558,
]
const ATAN_LO = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17,
  6.12323399573676603587e-17,
]
const AT0 = 3.33333333333329318027e-1
const AT1 = -1.99999999998764832476e-1
const AT2 = 1.42857142725034663711e-1
const AT3 = -1.1111110405462355788e-1
const AT4 = 9.09088713343650656196e-2
const AT5 = -7.69187620504482999495e-2
const AT6 = 6.66107313738753120669e-2
const AT7 = -5.83357013379057348645e-2
const AT8 = 4.97687799461593236017e-2
const AT9 = -3.6531572744216915527e-2
const AT10 = 1.62858201153657823623e-2

export const atan = (x: number): number => {
  const ax = Math.abs(x)
  if (ax >= 7.378697629483821e19) {
    return x > 0 ? ATAN_HI[3] + ATAN_LO[3] : -ATAN_HI[3] - ATAN_LO[3]
  }
  let id: number
  let t: number
  if (ax < 0.4375) {
    if (ax < 7.450580596923828e-9) return x
    id = -1
    t = x
  } else if (ax < 0.6875) {
    id = 0
    t = (2 * ax - 1) / (2 + ax)
  } else if (ax < 1.1875) {
    id = 1
    t = (ax - 1) / (ax + 1)
  } else if (ax < 2.4375) {
    id = 2
    t = (ax - 1.5) / (1 + 1.5 * ax)
  } else {
    id = 3
    t = -1 / ax
  }
  const z = t * t
  const w = z * z
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))))
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))))
  if (id < 0) return t - t * (s1 + s2)
  const result = ATAN_HI[id] - (t * (s1 + s2) - ATAN_LO[id] - t)
  return x < 0 ? -result : result
}

const PI = 3.141592653589793116
const PI_LO = 1.2246467991473532e-16
const PIO2 = 1.5707963267948966

export const atan2 = (y: number, x: number): number => {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN
  if (x === 1) return atan(y)
  const quadrant = (signBit(y) ? 1 : 0) | (signBit(x) ? 2 : 0)
  if (y === 0) return quadrant < 2 ? y : quadrant === 2 ? PI : -PI
  if (x === 0) return y < 0 ? -PIO2 : PIO2
  if (!Number.isFinite(x)) {
    if (!Number.isFinite(y)) return [PIO4, -PIO4, 3 * PIO4, -3 * PIO4][quadrant]
    return [0, -0, PI, -PI][quadrant]
  }
  if (!Number.isFinite(y)) return y < 0 ? -PIO2 : PIO2
  const z = atan(Math.abs(y / x))
  switch (quadrant) {
    case 0:
      return z
    case 1:
      return -z
    case 2:
      return PI - (z - PI_LO)
    default:
      return z - PI_LO - PI
  }
}

const LN2_HI = 6.9314718036912381649e-1
const LN2_LO = 1.90821492927058770002e-10
const INV_LN2 = 1.442695040888963387
const HALF_LN2 = 0.34657359027997264
const THREE_HALVES_LN2 = 1.0397207708399179
const EXP_OVERFLOW = 7.09782712893383973096e2
const EXP_UNDERFLOW = -7.4513321910194110842e2
const P1 = 1.66666666666666019037e-1
const P2 = -2.77777777770155933842e-3
const P3 = 6.61375632143793436117e-5
const P4 = -1.6533902205465251539e-6
const P5 = 4.13813679705723846039e-8

export const exp = (x: number): number => {
  if (Number.isNaN(x)) return x
  if (x > EXP_OVERFLOW) return Infinity
  if (x < EXP_UNDERFLOW) return 0
  const ax = Math.abs(x)
  let k = 0
  let hi = 0
  let lo = 0
  let r = x
  if (ax > HALF_LN2) {
    if (ax < THREE_HALVES_LN2) {
      k = x < 0 ? -1 : 1
      hi = x - k * LN2_HI
      lo = k * LN2_LO
    } else {
      k = Math.trunc(INV_LN2 * x + (x < 0 ? -0.5 : 0.5))
      hi = x - k * LN2_HI
      lo = k * LN2_LO
    }
    r = hi - lo
  } else if (ax < 3.725290298461914e-9) {
    return 1 + x
  }
  const t = r * r
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
  if (k === 0) return 1 - ((r * c) / (c - 2) - r)
  const y = 1 - (lo - (r * c) / (2 - c) - hi)
  if (k >= -1021) return k === 1024 ? y * 2 * twoTo(1023) : y * twoTo(k)
  return y * twoTo(k + 1000) * 9.332636185032189e-302
}

const TWO54 = 1.8014398509481984e16
const LG1 = 6.66666666666673513e-1
const LG2 = 3.999999999940941908e-1
const LG3 = 2.857142874366239149e-1
const LG4 = 2.222219843214978396e-1
const LG5 = 1.818357216161805012e-1
const LG6 = 1.531383769920937332e-1
const LG7 = 1.479819860511658591e-1

export const log = (x: number): number => {
  if (Number.isNaN(x) || x < 0) return NaN
  if (x === 0) return -Infinity
  if (x === Infinity) return x
  let k = 0
  let hx = highWord(x)
  if (hx < 0x00100000) {
    k -= 54
    x *= TWO54
    hx = highWord(x)
  }
  k += (hx >> 20) - 1023
  hx &= 0x000fffff
  const i = (hx + 0x95f64) & 0x100000
  // Scaled into [sqrt(2)/2, sqrt(2)), halving it if it would land above.
  x = withHighWord(x, hx | (i ^ 0x3ff00000))
  k += i >> 20
  const f = x - 1
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) return k === 0 ? 0 : k * LN2_HI + k * LN2_LO
    const r = f * f * (0.5 - 0.3333333333333333 * f)
    return k === 0 ? f - r : k * LN2_HI - (r - k * LN2_LO - f)
  }
  const s = f / (2 + f)
  const z = s * s
  const w = z * z
  const t1 = w * (LG2 + w * (LG4 + w * LG6))
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)))
  const r = t2 + t1
  if (((hx - 0x6147a) | (0x6b851 - hx)) > 0) {
    const hfsq = 0.5 * f * f
    if (k === 0) return f - (hfsq - s * (hfsq + r))
    return k * LN2_HI - (hfsq - (s * (hfsq + r) + k * LN2_LO) - f)
  }
  if (k === 0) return f - s * (f - r)
  return k * LN2_HI - (s * (f - r) - k * LN2_LO - f)
}

/**
 * The length of (x, y). `Math.hypot` is not required to be correctly rounded
 * and engines compute it differently; the square root is. Squaring saturates
 * to Infinity above about 1e154 and to zero below about 1e-154, and either
 * answer survives into whatever divides by it, so out there the components are
 * scaled by the larger first. Lengths in metres never get near either end.
 */
export const hypot = (x: number, y: number): number => {
  const s = x * x + y * y
  if (s > 1e300 || s < 1e-300) {
    const m = Math.max(Math.abs(x), Math.abs(y))
    if (m === 0 || m === Infinity) return m
    const a = x / m
    const b = y / m
    return m * Math.sqrt(a * a + b * b)
  }
  return Math.sqrt(s)
}
