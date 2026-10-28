import { Fragment, useEffect, useState } from 'react'
import { CreditList, SongBanner, SongLink, YoutubePlayer } from './ChainParts.tsx'
import type { SavedChain } from './types.ts'
import './App.css'

/** A saved chain, shown read-only from its snapshot. Nothing is looked up again. */
export default function SharedChain({ shareId }: { shareId: string }) {
  const [chain, setChain] = useState<SavedChain | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/chains/${encodeURIComponent(shareId)}`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json()) as SavedChain & { error?: string }
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
        setChain(body)
        document.title = `${body.title} · Music Connections`
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : 'Could not load this chain')
      })
    return () => controller.abort()
  }, [shareId])

  return (
    <main className="page">
      <p className="eyebrow">Music Connections</p>
      <h1>{chain && chain.steps.length > 1 ? `A chain of ${chain.steps.length} songs` : 'A shared song'}</h1>
      <p className="lede">
        Each song links to the next through someone credited on both. <a href="/random">Start your own</a>.
      </p>
      <div className="rows">
        <section className="row" aria-label="Shared chain" aria-busy={!chain && !error}>
          {error ? <p className="error" role="alert">{error}</p> : null}
          {!chain && !error ? <p className="connections-status">Loading the chain…</p> : null}
          {chain ? (
            <div className="song-stack">
              {chain.steps.map((step, index) => (
                <Fragment key={index}>
                  {index > 0 ? <SongLink via={step.via} /> : null}
                  {index !== open ? (
                    <SongBanner
                      song={step}
                      expanded={false}
                      className="now-playing now-playing-collapsed"
                      onSelect={() => setOpen(index)}
                    />
                  ) : (
                    <article className="song">
                      <div className="watch">
                        <SongBanner song={step} expanded className="now-playing" onSelect={() => setOpen(index)} />
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
                  )}
                </Fragment>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  )
}
