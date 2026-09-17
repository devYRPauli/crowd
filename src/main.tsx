import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { ErrorBoundary } from './app/ErrorBoundary'
import './styles/app.css'

const container = document.getElementById('root')
if (!container) throw new Error('CROWD could not find its mount point.')

// Outside `App`, so that a throw anywhere inside it — including in whatever
// renders the viewport — still has something left to render the apology.
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
