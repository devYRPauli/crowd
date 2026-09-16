import { afterEach, describe, expect, it, vi } from 'vitest'
import { newDocumentId, newId } from './ids'

/** The prefixes the product actually mints, as they appear in a saved file. */
const PREFIXES = ['wall', 'open', 'item', 'zone', 'svc', 'pop', 'step', 'profile']

const draw = (count: number, mint: () => string): string[] => Array.from({ length: count }, mint)

const bodies = (ids: string[]): string[] => ids.map((id) => id.slice(id.indexOf('_') + 1))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('minting an id', () => {
  it('stamps the kind of thing on the front of six random characters', () => {
    for (const prefix of PREFIXES) {
      const id = newId(prefix)
      // The prefix is the only thing that makes a hand-inspected `.crowd.json`
      // readable: every reference in it is an opaque string otherwise.
      expect([prefix, id]).toEqual([
        prefix,
        expect.stringMatching(new RegExp(`^${prefix}_[0-9a-z]{6}$`)),
      ])
    }
  })

  it('gives a document a longer id than the objects inside it', () => {
    // Document ids are compared across files that never met — a saved project
    // list, an emailed report — so they carry more entropy than an id that only
    // has to be unique within one plan.
    expect(newDocumentId()).toMatch(/^doc_[0-9a-z]{10}$/)
  })

  it('draws a plan-sized run of ids without repeating one', () => {
    // Paste re-mints an id for every copied object and rewrites the openings'
    // `wallId` to match; two walls that share an id take each other's doors.
    // The sample is deliberately small: a collision is a real outcome of a
    // random source, and a bigger draw buys power this suite already gets from
    // the per-position check below while making a genuine one likelier.
    const ids = draw(500, () => newId('wall'))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('fills every position from the whole alphabet, not a corner of it', () => {
    // Every one of the six characters has to be random over all 36 symbols. A
    // position stuck on one value, or an off-by-one that made the last letter
    // unreachable, costs entropy silently: the ids still look right and collide
    // sooner. Over 1000 draws a live position misses a symbol essentially never.
    const positions = [0, 1, 2, 3, 4, 5]
    const sample = bodies(draw(1000, () => newId('zone')))
    const coverage = positions.map((index) => new Set(sample.map((body) => body[index])).size)
    expect(coverage).toEqual([36, 36, 36, 36, 36, 36])
  })

  it('mints a fresh id for two things built exactly alike', () => {
    // Ids are per document and not derived from content, which is why the
    // simulation names its random streams after a thing's position in the plan:
    // a stream named after an id makes the same venue built twice simulate
    // differently, and a comparison against a baseline then measures the ids.
    expect(newId('pop')).not.toBe(newId('pop'))
    expect(newDocumentId()).not.toBe(newDocumentId())
  })

  it('takes one character per random byte, wrapping past the end of the alphabet', () => {
    const bytes = [0, 1, 10, 35, 36, 255]
    const fallback = vi.spyOn(Math, 'random')
    vi.stubGlobal('crypto', {
      getRandomValues: (out: Uint8Array) => {
        out.set(bytes.slice(0, out.length))
        return out
      },
    })

    // 36 wraps to '0' and 255 to '3'; a byte used unwrapped would index off the
    // end of the alphabet and put `undefined` in the middle of an id.
    expect(newId('wall')).toBe('wall_01az03')
    // A document asks for ten bytes, not six: the trailing zeroes are the four
    // bytes this stub left untouched, so the length really is passed through.
    expect(newDocumentId()).toBe('doc_01az030000')
    // Where WebCrypto exists it is the only source consulted.
    expect(fallback).not.toHaveBeenCalled()
  })

  it('still mints usable ids where WebCrypto is missing', () => {
    // An insecure context or an older worker has no `crypto.getRandomValues`.
    // Ids are minted before anything can be drawn, so falling over here would
    // take the editor with it.
    vi.stubGlobal('crypto', undefined)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(newId('wall')).toBe('wall_iiiiii')

    // Both ends of `Math.random`'s range have to land inside the alphabet:
    // 0.999… scaled without a floor would index past 'z' and yield `undefined`.
    random.mockReturnValue(0)
    expect(newId('wall')).toBe('wall_000000')
    random.mockReturnValue(0.9999999999999999)
    expect(newId('wall')).toBe('wall_zzzzzz')
    random.mockRestore()

    // A `crypto` that exists but carries no `getRandomValues` takes the same
    // path — the guard tests the method, not the object.
    vi.stubGlobal('crypto', {})
    const ids = draw(200, () => newId('item'))
    expect(ids.filter((id) => !/^item_[0-9a-z]{6}$/.test(id))).toEqual([])
    expect(new Set(ids).size).toBe(ids.length)
  })
})
