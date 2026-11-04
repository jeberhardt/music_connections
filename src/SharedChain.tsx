import { useEffect, useState } from 'react'
import { CreditList, SongBanner, SongDialog, YoutubePlayer } from './ChainParts.tsx'
import { SongGraph, type TreeSong } from './SongGraph.tsx'
import type { SavedChain } from './types.ts'
import { readJson } from './readJson.ts'
import './App.css'

/** A saved chain, shown read-only from its snapshot. Nothing is looked up again. */
export default function SharedChain({ shareId }: { shareId: string }) {
  const [chain, setChain] = useState<SavedChain | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/chains/${encodeURIComponent(shareId)}`, { signal: controller.signal })
      .then(async (res) => {
        const body = await readJson<SavedChain>(res)
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
        setChain(body)
        // A single shared song opens straight away; a chain starts by showing how its songs connect.
        if (body.steps.length === 1) setOpen(0)
        document.title = `${body.title} · Music Connections`
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : 'Could not load this chain')
      })
    return () => controller.abort()
  }, [shareId])

  const songs: TreeSong[] = (chain?.steps ?? []).map((step, index) => ({
    ...step,
    id: String(index),
    parentId: step.parent != null ? String(step.parent) : null,
    links: step.links.map((link) => ({ parentId: String(link.parent), via: link.via })),
  }))
  const step = open != null ? chain?.steps[open] : undefined

  return (
    <main className="page">
      <p className="eyebrow">Music Connections</p>
      <h1>{chain && chain.steps.length > 1 ? `A chain of ${chain.steps.length} songs` : 'A shared song'}</h1>
      <p className="lede">
        Each song links to the one it came from through someone credited on both. <a href="/">Start your own</a>.
      </p>
      <div className="rows">
        <section className="row" aria-label="Shared chain" aria-busy={!chain && !error}>
          {error ? <p className="error" role="alert">{error}</p> : null}
          {!chain && !error ? <p className="connections-status">Loading the chain…</p> : null}
          {chain ? <SongGraph songs={songs} openId={open != null ? String(open) : null} onSelect={(id) => setOpen(Number(id))} /> : null}
          {step ? (
            <SongDialog label={`${step.title} by ${step.artist}`} onDismiss={() => setOpen(null)}>
              <article className="song">
                <div className="watch">
                  <SongBanner song={step} expanded className="now-playing" onSelect={() => undefined} />
                  {step.youtubeVideoId ? (
                    <YoutubePlayer videoId={step.youtubeVideoId} title={`${step.title} by ${step.artist}`} />
                  ) : (
                    <p className="missing">No YouTube video was found for this song.</p>
                  )}
                </div>
                <section className="credits" aria-label="Credits">
                  <h3>Credits</h3>
                  {step.credits.length > 0 ? (
                    <CreditList credits={step.credits} />
                  ) : (
                    <p className="connections-status">No major credits were saved for this song.</p>
                  )}
                </section>
              </article>
            </SongDialog>
          ) : null}
        </section>
      </div>
    </main>
  )
}
