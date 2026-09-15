import { afterEach, describe, expect, it, vi } from 'vitest'
import { newDocumentId, newId } from './ids'

/** The prefixes the product actually mints, as they appear in a saved file. */
const PREFIXES = ['wall', 'open', 'item', 'zone', 'svc', 'pop', 'step', 'profile']

const draw = (count: number, mint: () => string): string[] => Array.from({ length: count }, mint)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('minting an id', () => {
  it('stamps the kind of thing on the front of six random characters', () => {
    for (const prefix of PREFIXES) {
      const id = newId(prefix)
      // The prefix is what makes a `.crowd.json` readable by hand, and half the
      // editor reads a kind off an id rather than carrying it alongside.
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

  it('draws a venue-sized run of ids without repeating one', () => {
    // A large plan holds a few thousand objects, and two that share an id are
    // one object as far as selection, undo and the renderer's diff are
    // concerned: editing one moves the other.
    const ids = draw(2000, () => newId('wall'))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('uses the whole alphabet rather than a corner of it', () => {
    // Every byte maps into 36 characters. An off-by-one that made the last
    // letter unreachable would cost entropy silently — the ids would still look
    // right and collide sooner.
    const seen = new Set(
      draw(2000, () => newId('zone'))
        .join('')
        .replace(/zone_/g, ''),
    )
    expect(seen.size).toBe(36)
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
    vi.stubGlobal('crypto', {
      getRandomValues: (out: Uint8Array) => {
        out.set(bytes.slice(0, out.length))
        return out
      },
    })
    // 36 wraps to '0' and 255 to '3'; a byte used unwrapped would index off the
    // end of the alphabet and put `undefined` in the middle of an id.
    expect(newId('wall')).toBe('wall_01az03')
  })

  it('still mints usable ids where WebCrypto is missing', () => {
    // An insecure context or an older worker has no `crypto.getRandomValues`.
    // Ids are minted before anything can be drawn, so falling over here would
    // take the editor with it.
    vi.stubGlobal('crypto', undefined)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(newId('wall')).toBe('wall_iiiiii')

    vi.spyOn(Math, 'random').mockRestore()
    vi.stubGlobal('crypto', {})
    const ids = draw(500, () => newId('item'))
    expect(ids.every((id) => /^item_[0-9a-z]{6}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
