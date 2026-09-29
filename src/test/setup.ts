/**
 * Test setup, applied to every file in the suite.
 *
 * Most of it runs in `node` and never touches the DOM; the few files that
 * render components opt into jsdom with a `@vitest-environment jsdom` docblock,
 * and only those need tearing down between tests. Guarding on `document` keeps
 * this file free for the node-side majority.
 */

import { afterEach, beforeEach } from 'vitest'

// Taken before any file can fake the timers.
const { setTimeout: realSetTimeout } = globalThis

// The worker gives the runner 60 s to acknowledge each test update and can
// only read the answer when the event loop gets a turn. Synchronous tests run
// back to back without one, so engine.test.ts and exitChoice.test.ts, a
// minute or more of simulation each, failed the run with every assertion
// green: "Timeout calling onTaskUpdate". A turn before each test lets the
// answer in, which leaves only a single test over 60 s able to trip it.
beforeEach(() => new Promise<void>((resolve) => realSetTimeout(resolve, 0)))

afterEach(async () => {
  if (typeof document === 'undefined') return
  const { cleanup } = await import('@testing-library/react')
  cleanup()
})
