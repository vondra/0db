import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { getH3Availability } from './utils/h3-binary'

// Kick off the tile manifest fetch in parallel with React bootstrap and the
// basemap style load, instead of waiting for HexLayer's first effect.
void getH3Availability()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
