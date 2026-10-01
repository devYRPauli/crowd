/**
 * The last thing between a thrown render and a blank page.
 *
 * React unmounts the whole tree when a component throws, so without this the
 * user gets a white screen: no message, no way back, and no reason to think
 * their venue still exists. It does — the editor autosaves a couple of seconds
 * after every edit — but nobody can be expected to guess that from an empty
 * page, so this says it, and offers the reload that brings the venue back.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { WebGLUnavailableError } from '../render/webgl'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept for the console rather than swallowed: whoever is debugging this
    // needs the component stack, which the error alone does not carry.
    console.error('CROWD crashed while rendering', error, info.componentStack)
  }

  private reload = (): void => {
    window.location.reload()
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    // A reload cannot bring back a context the browser will not create, and
    // telling the user it would sent them round the same failure again.
    if (error instanceof WebGLUnavailableError) {
      return (
        <div className="crash" role="alert">
          <h1>CROWD needs WebGL 2</h1>
          <p>
            This browser could not start the 3D view. Turn on hardware acceleration in its settings,
            or open CROWD in a current Chrome, Edge, Firefox or Safari. Any venue you have saved is
            still in this browser.
          </p>
          <details>
            <summary>What happened</summary>
            <pre>{String(error.cause ?? error.message)}</pre>
          </details>
        </div>
      )
    }

    return (
      <div className="crash" role="alert">
        <h1>CROWD stopped</h1>
        <p>
          Something went wrong while drawing the editor. Your venue is safe — it is saved in this
          browser a couple of seconds after every edit, and reloading will bring it back.
        </p>
        <button className="btn is-primary" onClick={this.reload}>
          Reload
        </button>
        <details>
          <summary>What happened</summary>
          <pre>{error.stack ?? error.message}</pre>
        </details>
      </div>
    )
  }
}
