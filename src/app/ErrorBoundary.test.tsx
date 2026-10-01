/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'
import { WebGLUnavailableError } from '../render/webgl'

const Boom = ({ throws }: { throws: boolean }) => {
  if (throws) throw new Error('the viewport fell over')
  return <p>the editor</p>
}

describe('the crash screen', () => {
  beforeEach(() => {
    // React logs the caught error itself; the noise is not the test's fault and
    // silencing it keeps a passing run readable.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stays out of the way while nothing is wrong', () => {
    render(
      <ErrorBoundary>
        <Boom throws={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('the editor')).toBeDefined()
  })

  it('catches a thrown render instead of leaving a blank page', () => {
    render(
      <ErrorBoundary>
        <Boom throws />
      </ErrorBoundary>,
    )
    // Without this the whole tree unmounts and the user gets white nothing.
    expect(screen.getByRole('alert')).toBeDefined()
    expect(screen.getByText('CROWD stopped')).toBeDefined()
  })

  it('tells the user their venue survived, because it did', () => {
    render(
      <ErrorBoundary>
        <Boom throws />
      </ErrorBoundary>,
    )
    // The editor autosaves a couple of seconds after every edit, so the venue
    // really is still there. Nobody can guess that from an empty page.
    expect(screen.getByRole('alert').textContent).toMatch(/saved in this browser/i)
  })

  it('offers the reload that brings it back', () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    })

    render(
      <ErrorBoundary>
        <Boom throws />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('says what the browser lacks when it cannot draw the 3D view at all', () => {
    const NoGpu = () => {
      throw new WebGLUnavailableError(new Error('Error creating WebGL context.'))
    }
    render(
      <ErrorBoundary>
        <NoGpu />
      </ErrorBoundary>,
    )
    // The general screen promised a reload would bring the venue back, and a
    // browser with acceleration off fails the same way every time.
    expect(screen.getByText('CROWD needs WebGL 2')).toBeDefined()
    expect(screen.getByRole('alert').textContent).toMatch(/hardware acceleration/)
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
    expect(screen.getByText('Error: Error creating WebGL context.')).toBeDefined()
  })

  it('keeps the stack where somebody debugging it can reach it', () => {
    render(
      <ErrorBoundary>
        <Boom throws />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/the viewport fell over/)).toBeDefined()
  })
})
