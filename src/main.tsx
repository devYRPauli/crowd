import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './styles/app.css'

const container = document.getElementById('root')
if (!container) throw new Error('CROWD could not find its mount point.')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
