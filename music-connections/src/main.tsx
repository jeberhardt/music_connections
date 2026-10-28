import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import RandomSong from './RandomSong.tsx'
import SharedChain from './SharedChain.tsx'

const path = window.location.pathname
const shared = path.match(/^\/c\/([a-z0-9]{10})\/?$/)
const page = shared ? <SharedChain shareId={shared[1]!} /> : path === '/random' ? <RandomSong /> : <App />

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page}
  </StrictMode>,
)
