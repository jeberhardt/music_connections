import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react'
import { availableChartYears, findChart, SONG_CHARTS } from './charts.ts'
import { CreditList, SongBanner, SongLink, YoutubePlayer } from './ChainParts.tsx'
import type { ChainStep, ChainVia, RelatedSong, SaveChainResponse, Song, SongCredit, SongLookupResponse } from './types.ts'
import './App.css'

type Panel = {
  id: string
  title: string
  artist: string
  rank: number | null
  chartName: string | null
  week: string | null
  youtubeVideoId: string | null
  collapsed: boolean
  detailLoading: boolean
  lookupError: string | null
  credits: SongCredit[] | null
  creditsLoading: boolean
  creditsError: string | null
  creditsNotice: string | null
  /** Who led here from the previous song; null for the first song. */
  via: ChainVia | null
}

type ShareState =
  | { status: 'idle' }
  | { status: 'saving'; key: string }
  | { status: 'saved'; key: string; url: string; copied: boolean }
  | { status: 'error'; key: string; message: string }

/** The songs in a chain exactly as shown, so the shared link never looks anything up again. */
function chainSnapshot(panels: Panel[]): ChainStep[] {
  return panels.map((panel) => ({
    title: panel.title,
    artist: panel.artist,
    youtubeVideoId: panel.youtubeVideoId,
    rank: panel.rank,
    chartName: panel.chartName,
    week: panel.week,
    via: panel.via,
    credits: panel.credits ?? [],
  }))
}

function sameSong(title: string, artist: string, otherTitle: string, otherArtist: string): boolean {
  return title.trim().toLowerCase() === otherTitle.trim().toLowerCase() && artist.trim().toLowerCase() === otherArtist.trim().toLowerCase()
}

function emptyCredits(): Pick<Panel, 'credits' | 'creditsLoading' | 'creditsError' | 'creditsNotice'> {
  return { credits: null, creditsLoading: false, creditsError: null, creditsNotice: null }
}

export default function RandomSong() {
  const [chart, setChart] = useState('')
  const [year, setYear] = useState('')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [panels, setPanels] = useState<Panel[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingKind, setLoadingKind] = useState<'pick' | 'youtube' | null>(null)
  const [following, setFollowing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [youtubeError, setYoutubeError] = useState<string | null>(null)
  const requestId = useRef(0)
  const panelsRef = useRef(panels)
  panelsRef.current = panels
  const years = availableChartYears(new Date(), chart ? findChart(chart)?.since : undefined)
  const openPanel = panels.find((panel) => !panel.collapsed) ?? null
  const [share, setShare] = useState<ShareState>({ status: 'idle' })
  // A saved link belongs to the chain it was made from; adding a song makes it stale.
  const chainKey = panels.map((panel) => panel.id).join(',')
  const currentShare: ShareState = share.status !== 'idle' && share.key === chainKey ? share : { status: 'idle' }
  const chainBusy = panels.some((panel) => panel.detailLoading || panel.creditsLoading)
  const openId = openPanel?.id
  const openDetailLoading = openPanel?.detailLoading
  const openTitle = openPanel?.title
  const openArtist = openPanel?.artist

  async function pickSong() {
    requestId.current += 1
    const request = requestId.current
    setLoading(true)
    setLoadingKind('pick')
    setFollowing(false)
    setError(null)
    setYoutubeError(null)
    setPanels([])
    try {
      const params = new URLSearchParams({ count: '1' })
      if (chart) params.set('chart', chart)
      if (year) params.set('year', year)
      const res = await fetch(`/api/songs?${params}`)
      const body = (await res.json()) as { songs?: Song[]; error?: string }
      if (requestId.current !== request) return
      if (!res.ok || !body.songs?.[0]) {
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      const song = body.songs[0]
      setPanels([
        {
          id: crypto.randomUUID(),
          title: song.title,
          artist: song.artist,
          rank: song.rank,
          chartName: song.chartName,
          week: song.week,
          youtubeVideoId: song.youtubeVideoId,
          collapsed: false,
          detailLoading: false,
          lookupError: null,
          via: null,
          ...emptyCredits(),
        },
      ])
    } catch (err) {
      if (requestId.current !== request) return
      setError(err instanceof Error ? err.message : 'Could not pick a song')
    } finally {
      if (requestId.current === request) {
        setLoading(false)
        setLoadingKind(null)
      }
    }
  }

  async function startFromYoutube(event: FormEvent) {
    event.preventDefault()
    const url = youtubeUrl.trim()
    if (!url || loading) return
    const request = ++requestId.current
    setLoading(true)
    setLoadingKind('youtube')
    setFollowing(false)
    setError(null)
    setYoutubeError(null)
    setPanels([])
    try {
      const params = new URLSearchParams({ url })
      const res = await fetch(`/api/youtube?${params}`)
      const body = (await res.json()) as SongLookupResponse & { error?: string }
      if (requestId.current !== request) return
      if (!res.ok || !body.title || !body.artist || !body.youtubeVideoId) {
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      setPanels([
        {
          id: crypto.randomUUID(),
          title: body.title,
          artist: body.artist,
          rank: body.chart?.rank ?? null,
          chartName: body.chart?.chartName ?? null,
          week: body.chart?.week ?? null,
          youtubeVideoId: body.youtubeVideoId,
          collapsed: false,
          detailLoading: false,
          lookupError: null,
          via: null,
          ...emptyCredits(),
        },
      ])
    } catch (err) {
      if (requestId.current !== request) return
      setYoutubeError(err instanceof Error ? err.message : 'Could not start from that video')
    } finally {
      if (requestId.current === request) {
        setLoading(false)
        setLoadingKind(null)
      }
    }
  }

  async function openRelated(related: RelatedSong, person: string) {
    if (loading || following) return
    if (openPanel && sameSong(openPanel.title, openPanel.artist, related.title, related.artist)) return
    const request = ++requestId.current
    const id = crypto.randomUUID()
    setFollowing(true)
    setError(null)
    setPanels((prev) => [
      ...prev.map((panel) => ({ ...panel, collapsed: true })),
      {
        id,
        title: related.title,
        artist: related.artist,
        rank: null,
        chartName: null,
        week: null,
        youtubeVideoId: null,
        collapsed: false,
        detailLoading: true,
        lookupError: null,
        via: { person, role: related.role },
        ...emptyCredits(),
      },
    ])
    try {
      const params = new URLSearchParams({ title: related.title, artist: related.artist })
      const res = await fetch(`/api/song?${params}`)
      const body = (await res.json()) as SongLookupResponse & { error?: string }
      if (requestId.current !== request) return
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setPanels((prev) =>
        prev.map((panel) =>
          panel.id === id
            ? {
                ...panel,
                detailLoading: false,
                youtubeVideoId: body.youtubeVideoId,
                rank: body.chart?.rank ?? null,
                chartName: body.chart?.chartName ?? null,
                week: body.chart?.week ?? null,
              }
            : panel,
        ),
      )
    } catch (err) {
      if (requestId.current !== request) return
      const message = err instanceof Error ? err.message : 'Could not look up this song'
      setPanels((prev) =>
        prev.map((panel) => (panel.id === id ? { ...panel, detailLoading: false, lookupError: message } : panel)),
      )
    } finally {
      if (requestId.current === request) setFollowing(false)
    }
  }

  async function shareChain() {
    const key = chainKey
    setShare({ status: 'saving', key })
    try {
      const res = await fetch('/api/chains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: chainSnapshot(panels) }),
      })
      const body = (await res.json()) as Partial<SaveChainResponse> & { error?: string }
      if (!res.ok || !body.path) throw new Error(body.error ?? `Request failed (${res.status})`)
      setShare({ status: 'saved', key, url: `${window.location.origin}${body.path}`, copied: false })
    } catch (err) {
      setShare({ status: 'error', key, message: err instanceof Error ? err.message : 'Could not save this chain' })
    }
  }

  async function copyShareLink(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setShare((prev) => (prev.status === 'saved' && prev.url === url ? { ...prev, copied: true } : prev))
    } catch {
      // Copying can be blocked; the link stays on screen to copy by hand.
    }
  }

  function expandPanel(id: string) {
    setPanels((prev) => {
      const target = prev.find((panel) => panel.id === id)
      if (!target || !target.collapsed) return prev
      return prev.map((panel) => ({ ...panel, collapsed: panel.id !== id }))
    })
  }

  useEffect(() => {
    if (!openId || openDetailLoading || !openTitle || !openArtist) return
    const current = panelsRef.current.find((panel) => panel.id === openId)
    if (current && (current.credits !== null || current.creditsError)) return
    const controller = new AbortController()
    const id = openId
    setPanels((prev) =>
      prev.map((panel) =>
        panel.id === id ? { ...panel, creditsLoading: true, creditsError: null, credits: null, creditsNotice: null } : panel,
      ),
    )
    const params = new URLSearchParams({ title: openTitle, artist: openArtist })
    fetch(`/api/credits?${params}`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json()) as { credits?: SongCredit[]; notice?: string; error?: string }
        if (controller.signal.aborted) return
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
        setPanels((prev) =>
          prev.map((panel) =>
            panel.id === id
              ? { ...panel, credits: body.credits ?? [], creditsNotice: body.notice ?? null }
              : panel,
          ),
        )
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setPanels((prev) =>
          prev.map((panel) =>
            panel.id === id
              ? {
                  ...panel,
                  credits: null,
                  creditsError: err instanceof Error ? err.message : 'Could not look up credits',
                }
              : panel,
          ),
        )
      })
      .finally(() => {
        if (controller.signal.aborted) return
        setPanels((prev) => prev.map((panel) => (panel.id === id ? { ...panel, creditsLoading: false } : panel)))
      })

    return () => controller.abort()
  }, [openId, openDetailLoading, openTitle, openArtist])

  const linksDisabled = loading || following

  return (
    <main className="page">
      <p className="eyebrow">Music Connections</p>
      <h1>One random song</h1>
      <p className="lede">
        Paste a YouTube link, or pick one song from a Billboard chart and year in the last 40 years. Then watch the video, see the major credits, and open another song each person made with someone else.
      </p>
      <div className="rows">
        <section className="row" aria-label="Random song">
          <form className="youtube-start" onSubmit={startFromYoutube}>
            <label className="field youtube-field">
              <span className="field-label">YouTube</span>
              <input
                type="text"
                value={youtubeUrl}
                onChange={(event) => {
                  setYoutubeUrl(event.target.value)
                  setYoutubeError(null)
                }}
                placeholder="youtube.com/watch?v=… or youtu.be/…"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                disabled={loading}
                aria-label="YouTube URL"
                aria-invalid={youtubeError ? true : undefined}
                aria-describedby={youtubeError ? 'youtube-url-error' : undefined}
              />
            </label>
            <button type="submit" className="pick" disabled={loading || youtubeUrl.trim() === ''}>
              {loading && loadingKind === 'youtube' ? (
                <>
                  <span className="trace-spinner" aria-hidden="true" />
                  Starting…
                </>
              ) : (
                'Start from video'
              )}
            </button>
            {youtubeError ? (
              <p id="youtube-url-error" className="error youtube-error" role="alert">
                {youtubeError}
              </p>
            ) : null}
          </form>
          <div className="controls">
            <label className="field">
              <span className="field-label">Chart</span>
              <select
                value={chart}
                onChange={(event) => {
                  const next = event.target.value
                  const since = next ? findChart(next)?.since : undefined
                  const yearStillValid = !year || availableChartYears(new Date(), since).includes(Number(year))
                  setChart(next)
                  if (!yearStillValid) setYear('')
                }}
                disabled={loading}
              >
                <option value="">Any chart</option>
                {SONG_CHARTS.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Year</span>
              <select
                className="year"
                value={year}
                onChange={(event) => setYear(event.target.value)}
                disabled={loading}
              >
                <option value="">Any year</option>
                {years.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="pick" onClick={pickSong} disabled={loading}>
              {loading && loadingKind === 'pick' ? (
                <>
                  <span className="trace-spinner" aria-hidden="true" />
                  Picking…
                </>
              ) : panels.length > 0 ? (
                'Pick again'
              ) : (
                'Pick a song'
              )}
            </button>
          </div>
          {error ? <p className="error" role="alert">{error}</p> : null}
          {panels.length > 0 ? (
            <div className="song-stack">
              {panels.map((panel, index) => (
                <Fragment key={panel.id}>
                  {index > 0 ? <SongLink via={panel.via} /> : null}
                  {panel.collapsed ? (
                  <SongBanner
                    song={panel}
                    expanded={false}
                    className="now-playing now-playing-collapsed"
                    onSelect={() => expandPanel(panel.id)}
                  />
                ) : (
                  <article className="song" aria-busy={panel.detailLoading || panel.creditsLoading}>
                    <div className="watch">
                      <SongBanner song={panel} expanded className="now-playing" onSelect={() => expandPanel(panel.id)} />
                      {panel.youtubeVideoId ? (
                        <YoutubePlayer videoId={panel.youtubeVideoId} title={`${panel.title} by ${panel.artist}`} />
                      ) : panel.detailLoading ? (
                        <p className="connections-status">Looking up this song…</p>
                      ) : (
                        <p className="missing">{panel.lookupError ?? 'No YouTube video found for this song.'}</p>
                      )}
                    </div>
                    {!panel.detailLoading ? (
                      <section className="credits" aria-label="Credits" aria-busy={panel.creditsLoading}>
                        <h3>Credits</h3>
                        {panel.creditsLoading && !panel.credits ? <p className="connections-status">Looking up credits…</p> : null}
                        {panel.creditsError ? <p className="error" role="alert">{panel.creditsError}</p> : null}
                        {panel.credits && panel.credits.length > 0 ? (
                          <CreditList credits={panel.credits} linksDisabled={linksDisabled} onOpenRelated={openRelated} />
                        ) : null}
                        {!panel.creditsLoading && !panel.creditsError && panel.credits && panel.credits.length === 0 ? (
                          <p className="connections-status">{panel.creditsNotice ?? 'No major credits were found.'}</p>
                        ) : null}
                      </section>
                    ) : null}
                  </article>
                  )}
                </Fragment>
              ))}
            </div>
          ) : null}
          {panels.length > 0 ? (
            <div className="share-chain">
              {currentShare.status === 'saved' ? (
                <>
                  <a href={currentShare.url} className="share-link">
                    {currentShare.url}
                  </a>
                  <button type="button" className="pick" onClick={() => copyShareLink(currentShare.url)}>
                    {currentShare.copied ? 'Copied' : 'Copy link'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="pick"
                  onClick={shareChain}
                  disabled={currentShare.status === 'saving' || loading || following || chainBusy}
                >
                  {currentShare.status === 'saving' ? 'Saving…' : panels.length === 1 ? 'Share this song' : `Share this chain of ${panels.length}`}
                </button>
              )}
              {currentShare.status === 'error' ? (
                <p className="error" role="alert">
                  {currentShare.message}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  )
}
