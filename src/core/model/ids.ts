/** Short, collision-resistant identifiers for plan objects. */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

const randomChars = (length: number): string => {
  let out = ''
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(length)
    crypto.getRandomValues(bytes)
    for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
    return out
  }
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return out
}

/** e.g. `wall_k3f9a1`. The prefix makes documents readable when inspected by hand. */
export const newId = (prefix: string): string => `${prefix}_${randomChars(6)}`

export const newDocumentId = (): string => `doc_${randomChars(10)}`
