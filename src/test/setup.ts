/**
 * Test setup, applied to every file in the suite.
 *
 * Most of it runs in `node` and never touches the DOM; the few files that
 * render components opt into jsdom with a `@vitest-environment jsdom` docblock,
 * and only those need tearing down between tests. Guarding on `document` keeps
 * this file free for the node-side majority.
 */

import { afterEach } from 'vitest'

afterEach(async () => {
  if (typeof document === 'undefined') return
  const { cleanup } = await import('@testing-library/react')
  cleanup()
})
