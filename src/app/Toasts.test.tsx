/**
 * @vitest-environment jsdom
 */

/**
 * Transient messages.
 *
 * The rule the component exists to enforce is that a message you have to close
 * had better be worth closing: warnings and errors wait for the user, anything
 * else clears itself. Getting that backwards either buries a warning under the
 * next success or leaves a stack of "Project saved." on screen all afternoon.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Toasts } from './Toasts'
import { useEditor, type Toast } from '../state/editorStore'

const editor = () => useEditor.getState()

const say = (message: string, tone: Toast['tone']): void => {
  act(() => editor().toast(message, tone))
}

const tick = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  useEditor.setState({ toasts: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('toasts', () => {
  it('takes up no room at all when there is nothing to say', () => {
    const { container } = render(<Toasts />)
    expect(container.firstChild).toBeNull()

    say('Project saved.', 'success')
    // And announces itself politely when there is, rather than stealing focus.
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
  })

  it('clears the chatter by itself and leaves the warnings for the user', () => {
    render(<Toasts />)
    say('Project saved.', 'success')
    say('Copied 2 objects.', 'info')
    say('Two doorways overlap on the north wall.', 'warn')
    say('The simulation worker failed.', 'error')

    tick(4199)
    expect(screen.queryByText('Project saved.')).not.toBeNull()

    tick(1)
    expect(screen.queryByText('Project saved.')).toBeNull()
    expect(screen.queryByText('Copied 2 objects.')).toBeNull()
    // A warning about the plan and a failed run are findings, not chatter.
    expect(screen.queryByText('Two doorways overlap on the north wall.')).not.toBeNull()
    expect(screen.queryByText('The simulation worker failed.')).not.toBeNull()
    expect(editor().toasts).toHaveLength(2)
  })

  it('dismisses only the message whose close button was pressed', () => {
    render(<Toasts />)
    say('First warning.', 'warn')
    say('Second warning.', 'warn')

    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0])

    expect(screen.queryByText('First warning.')).toBeNull()
    expect(screen.queryByText('Second warning.')).not.toBeNull()
    expect(editor().toasts.map((toast) => toast.message)).toEqual(['Second warning.'])
  })

  it('shows the four most recent and brings the older ones back as they clear', () => {
    render(<Toasts />)
    for (const n of [1, 2, 3, 4, 5, 6]) say(`Warning ${n}.`, 'warn')

    // Six warnings from one run would otherwise cover the plan they are about.
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(4)
    expect(screen.queryByText('Warning 1.')).toBeNull()
    expect(screen.queryByText('Warning 6.')).not.toBeNull()

    // Nothing is lost, only queued: clearing one uncovers the next oldest.
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[3])
    expect(screen.queryByText('Warning 6.')).toBeNull()
    expect(screen.queryByText('Warning 2.')).not.toBeNull()
  })

  it('gives a warning back once the chatter that covered it has cleared', () => {
    render(<Toasts />)
    say('Two doorways overlap on the north wall.', 'warn')
    for (const n of [1, 2, 3, 4]) say(`Copied ${n} objects.`, 'info')

    // Four self-clearing messages are enough to push the warning off the end of
    // the stack, which is the one way a finding can leave the screen without
    // the user having read it.
    expect(screen.queryByText('Two doorways overlap on the north wall.')).toBeNull()

    tick(4200)

    // It was never dismissed, only covered, so it is still there to be read.
    expect(screen.queryByText('Two doorways overlap on the north wall.')).not.toBeNull()
    expect(editor().toasts.map((toast) => toast.tone)).toEqual(['warn'])
  })

  it('counts each message down from the moment it appeared', () => {
    render(<Toasts />)
    say('Project saved.', 'success')
    tick(4000)

    // The save was 200 ms from clearing when the warning landed beside it.
    say('Two doorways overlap on the north wall.', 'warn')
    tick(200)

    // A countdown that restarted whenever anything else arrived would never
    // finish: a run that reports its findings one after another would leave
    // "Project saved." sitting under them for as long as the findings keep
    // coming, and the user reads a stale success beside a fresh warning.
    expect(screen.queryByText('Project saved.')).toBeNull()
    expect(screen.queryByText('Two doorways overlap on the north wall.')).not.toBeNull()

    // A second message of its own starts its own countdown, from now.
    say('Copied 2 objects.', 'info')
    tick(4199)
    expect(screen.queryByText('Copied 2 objects.')).not.toBeNull()
    tick(1)
    expect(editor().toasts.map((toast) => toast.message)).toEqual([
      'Two doorways overlap on the north wall.',
    ])
  })

  it('clears a message that was already waiting when the app mounted', () => {
    say('Project saved.', 'success')

    // The app's root is StrictMode, which creates every effect, tears it down
    // and creates it again before the first paint. The countdown outlives that
    // teardown, so a message the editor said something about while the panel
    // was still mounting still goes away by itself — otherwise it would sit
    // there for the rest of the session in the only build anybody runs.
    render(
      <StrictMode>
        <Toasts />
      </StrictMode>,
    )

    tick(4199)
    expect(screen.queryByText('Project saved.')).not.toBeNull()
    tick(1)
    expect(screen.queryByText('Project saved.')).toBeNull()
  })
})
