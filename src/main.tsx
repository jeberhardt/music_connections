import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import RandomSong from './RandomSong.tsx'
import SharedChain from './SharedChain.tsx'

// The two-song page is not ready for production, so only development builds include it.
const TwoSongs = import.meta.env.DEV ? lazy(() => import('./App.tsx')) : null

const path = window.location.pathname.replace(/\/+$/, '') || '/'
const shared = path.match(/^\/c\/([a-z0-9]{10})$/)
const page = shared ? (
  <SharedChain shareId={shared[1]!} />
) : TwoSongs && path === '/two-songs' ? (
  <Suspense>
    <TwoSongs />
  </Suspense>
) : (
  <RandomSong />
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page}
  </StrictMode>,
)
