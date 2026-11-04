import { useEffect, useRef, useState, type FormEvent } from 'react'
import { availableChartYears, findChart, SONG_CHARTS } from './charts.ts'
import { CreditList, SongBanner, SongDialog, YoutubePlayer } from './ChainParts.tsx'
import { SongGraph } from './SongGraph.tsx'
import type { ChainStep, ChainVia, CreditsResponse, FindSongResponse, RelatedSong, SaveChainResponse, Song, SongCredit, SongLookupResponse } from './types.ts'
import { readEvents } from './readEvents.ts'
import { readJson } from './readJson.ts'
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
  /** Who led here from the song it was picked from; null for the first song. */
  via: ChainVia | null
  /** The song whose credits this one was picked from; null for the first song. */
  parentId: string | null
  /** Later songs whose credits also pointed here after this song was already on the map. */
  links: { parentId: string; via: ChainVia }[]
}

type ShareState =
  | { status: 'idle' }
  | { status: 'saving'; key: string }
  | { status: 'saved'; key: string; url: string; copied: boolean }
  | { status: 'error'; key: string; message: string }

/** The songs in a chain exactly as shown, so the shared link never looks anything up again. */
function chainSnapshot(panels: Panel[]): ChainStep[] {
  const indexOf = new Map(panels.map((panel, index) => [panel.id, index]))
  return panels.map((panel) => ({
    title: panel.title,
    artist: panel.artist,
    youtubeVideoId: panel.youtubeVideoId,
    rank: panel.rank,
    chartName: panel.chartName,
    week: panel.week,
    via: panel.via,
    parent: panel.parentId ? (indexOf.get(panel.parentId) ?? null) : null,
    links: panel.links.flatMap((link) => {
      const parent = indexOf.get(link.parentId)
      return parent != null ? [{ parent, via: link.via }] : []
    }),
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
  const [loadingKind, setLoadingKind] = useState<'pick' | 'youtube' | 'find' | null>(null)
  const [searchText, setSearchText] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchNote, setSearchNote] = useState<string | null>(null)
  const [following, setFollowing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [youtubeError, setYoutubeError] = useState<string | null>(null)
  const requestId = useRef(0)
  const searchInput = useRef<HTMLInputElement>(null)
  /** Credits lookups still running, by song, so Start over can stop them. */
  const creditLookups = useRef(new Map<string, AbortController>())
  const panelsRef = useRef(panels)
  panelsRef.current = panels
  const years = availableChartYears(new Date(), chart ? findChart(chart)?.since : undefined)
  const openPanel = panels.find((panel) => !panel.collapsed) ?? null
  // Once there is a song on the map, the ways to pick one give way to a Start over button.
  const started = panels.length > 0
  const [share, setShare] = useState<ShareState>({ status: 'idle' })
  // A saved link belongs to the chain it was made from; adding a song makes it stale.
  const chainKey = panels.map((panel) => [panel.id, ...panel.links.map((link) => link.parentId)].join('<')).join(',')
  const currentShare: ShareState = share.status !== 'idle' && share.key === chainKey ? share : { status: 'idle' }
  const chainBusy = panels.some((panel) => panel.detailLoading || panel.creditsLoading)
  const openId = openPanel?.id
  const openDetailLoading = openPanel?.detailLoading
  const openTitle = openPanel?.title
  const openArtist = openPanel?.artist

  /** Clears the map and brings back the ways to pick a first song, dropping any lookup still running. */
  function startOver() {
    requestId.current += 1
    for (const controller of creditLookups.current.values()) controller.abort()
    creditLookups.current.clear()
    setPanels([])
    setLoading(false)
    setLoadingKind(null)
    setFollowing(false)
    setError(null)
    setSearchError(null)
    setSearchNote(null)
    setYoutubeError(null)
    setShare({ status: 'idle' })
    // The button disappears, so focus goes to the first way to pick a song once it is back.
    setTimeout(() => searchInput.current?.focus(), 0)
  }

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
      const body = await readJson<{ songs?: Song[] }>(res)
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
          parentId: null,
          links: [],
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

  function startFromYoutube(event: FormEvent) {
    event.preventDefault()
    const url = youtubeUrl.trim()
    if (url) void startFromLookup('youtube', `/api/youtube?${new URLSearchParams({ url })}`, setYoutubeError, 'Could not start from that video')
  }

  function startFromSearch(event: FormEvent) {
    event.preventDefault()
    const q = searchText.trim()
    if (q) void startFromLookup('find', `/api/find?${new URLSearchParams({ q })}`, setSearchError, 'Could not find that song')
  }

  /** Starts a new chain from one song the server looked up, from a YouTube link or from typed text. */
  async function startFromLookup(kind: 'youtube' | 'find', path: string, setFormError: (message: string | null) => void, fallback: string) {
    if (loading) return
    const request = ++requestId.current
    setLoading(true)
    setLoadingKind(kind)
    setFollowing(false)
    setError(null)
    setYoutubeError(null)
    setSearchError(null)
    setSearchNote(null)
    setPanels([])
    try {
      const res = await fetch(path)
      const body = await readJson<FindSongResponse>(res)
      if (requestId.current !== request) return
      if (!res.ok || !body.title || !body.artist) {
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      if (kind === 'youtube' && !body.youtubeVideoId) throw new Error(body.error ?? fallback)
      setSearchNote(body.note ?? null)
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
          parentId: null,
          links: [],
          ...emptyCredits(),
        },
      ])
    } catch (err) {
      if (requestId.current !== request) return
      setFormError(err instanceof Error ? err.message : fallback)
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
    // The new song branches from the song whose credits it was picked from.
    const parentId = openPanel?.id ?? panels.at(-1)?.id ?? null
    // A song already on the map opens where it is, with a line from this song unless the two are already joined.
    const existing = panels.find((panel) => sameSong(panel.title, panel.artist, related.title, related.artist))
    if (existing) {
      const parent = panels.find((panel) => panel.id === parentId)
      const joined = (a: Panel | undefined, b: Panel) =>
        a?.parentId === b.id || a?.links.some((link) => link.parentId === b.id)
      if (parentId && parent && parentId !== existing.id && !joined(existing, parent) && !joined(parent, existing)) {
        const link = { parentId, via: { person, role: related.role } }
        setPanels((prev) => prev.map((panel) => (panel.id === existing.id ? { ...panel, links: [...panel.links, link] } : panel)))
      }
      expandPanel(existing.id)
      return
    }
    const request = ++requestId.current
    const id = crypto.randomUUID()
    setFollowing(true)
    setError(null)
    setPanels((prev) => [
      ...prev.map((panel) => ({ ...panel, collapsed: true })),
      {
        parentId,
        links: [],
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
      const body = await readJson<SongLookupResponse>(res)
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
      const body = await readJson<Partial<SaveChainResponse>>(res)
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

  /** Folds the open song back into the chain, which closes its popover. */
  function dismissSong() {
    setPanels((prev) => (prev.some((panel) => !panel.collapsed) ? prev.map((panel) => ({ ...panel, collapsed: true })) : prev))
  }

  function expandPanel(id: string) {
    setPanels((prev) => {
      const target = prev.find((panel) => panel.id === id)
      if (!target || !target.collapsed) return prev
      return prev.map((panel) => ({ ...panel, collapsed: panel.id !== id }))
    })
  }

  // A song's credits lookup starts the first time it opens and keeps running if the song is closed,
  // so what it found is still there, or still arriving, when the song opens again.
  useEffect(() => {
    if (!openId || openDetailLoading || !openTitle || !openArtist) return
    const current = panelsRef.current.find((panel) => panel.id === openId)
    if (!current || creditLookups.current.has(openId) || current.credits !== null || current.creditsError) return
    const controller = new AbortController()
    creditLookups.current.set(openId, controller)
    const id = openId
    setPanels((prev) =>
      prev.map((panel) =>
        panel.id === id ? { ...panel, creditsLoading: true, creditsError: null, credits: null, creditsNotice: null } : panel,
      ),
    )
    const params = new URLSearchParams({ title: openTitle, artist: openArtist })
    // Songs already on the map, so no credit suggests one of them again.
    for (const panel of panelsRef.current) if (panel.id !== id) params.append('seen', panel.title)
    const showCredits = (credits: SongCredit[], notice: string | null) =>
      setPanels((prev) => prev.map((panel) => (panel.id === id ? { ...panel, credits, creditsNotice: notice } : panel)))
    // Each person shows up as soon as a source names them; their other songs fill in as they are found.
    fetch(`/api/credits?${params}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await readJson<object>(res)
          throw new Error(body.error ?? `Request failed (${res.status})`)
        }
        let finished = false
        await readEvents(res, controller.signal, (event, data) => {
          if (event === 'credits') showCredits((JSON.parse(data) as { credits: SongCredit[] }).credits, null)
          else if (event === 'error') throw new Error((JSON.parse(data) as { error?: string }).error || 'Could not look up credits')
          else if (event === 'result') {
            const body = JSON.parse(data) as CreditsResponse
            showCredits(body.credits, body.notice ?? null)
            finished = true
          }
        })
        if (!finished && !controller.signal.aborted) throw new Error('The credits lookup stopped before it finished. Try again.')
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
        creditLookups.current.delete(id)
        if (controller.signal.aborted) return
        setPanels((prev) => prev.map((panel) => (panel.id === id ? { ...panel, creditsLoading: false } : panel)))
      })
  }, [openId, openDetailLoading, openTitle, openArtist])

  const linksDisabled = loading || following

  return (
    <main className="page">
      <p className="eyebrow">Music Connections</p>
      <h1>One random song</h1>
      {started ? null : (
        <p className="lede">
          Paste a YouTube link, or pick one song from a Billboard chart and year in the last 40 years. Then watch the video, see the major credits, and open another song each person made with someone else.
        </p>
      )}
      <div className="rows">
        <section className="row" aria-label="Random song">
          {started ? (
            <div className="start-over">
              <button type="button" className="pick" onClick={startOver}>
                Start over
              </button>
              {searchNote ? (
                <p className="search-note" role="status">
                  {searchNote}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <form className="youtube-start" onSubmit={startFromSearch}>
                <label className="field youtube-field">
                  <span className="field-label">Song or artist</span>
                  <input
                    ref={searchInput}
                    type="search"
                    value={searchText}
                    onChange={(event) => {
                      setSearchText(event.target.value)
                      setSearchError(null)
                    }}
                    placeholder="hello adele, the weeknd, that rain song by new edition…"
                    disabled={loading}
                    aria-label="Song or artist"
                    aria-invalid={searchError ? true : undefined}
                    aria-describedby={searchError ? 'song-search-error' : undefined}
                  />
                </label>
                <button type="submit" className="pick" disabled={loading || searchText.trim() === ''}>
                  {loading && loadingKind === 'find' ? (
                    <>
                      <span className="trace-spinner" aria-hidden="true" />
                      Finding…
                    </>
                  ) : (
                    'Find song'
                  )}
                </button>
                {searchError ? (
                  <p id="song-search-error" className="error youtube-error" role="alert">
                    {searchError}
                  </p>
                ) : null}
              </form>
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
                  ) : (
                    'Pick a song'
                  )}
                </button>
              </div>
            </>
          )}
          {error ? <p className="error" role="alert">{error}</p> : null}
          {started ? (
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
          {started ? (
            <SongGraph songs={panels} openId={openPanel?.id ?? null} onSelect={expandPanel} />
          ) : null}
          {openPanel ? (
            <SongDialog label={`${openPanel.title} by ${openPanel.artist}`} onDismiss={dismissSong}>
              <article className="song" aria-busy={openPanel.detailLoading || openPanel.creditsLoading}>
                <div className="watch">
                  <SongBanner song={openPanel} expanded className="now-playing" onSelect={() => expandPanel(openPanel.id)} />
                  {openPanel.youtubeVideoId ? (
                    <YoutubePlayer videoId={openPanel.youtubeVideoId} title={`${openPanel.title} by ${openPanel.artist}`} />
                  ) : openPanel.detailLoading ? (
                    <p className="connections-status" role="status">
                      <span className="trace-spinner" aria-hidden="true" />
                      Looking up this song…
                    </p>
                  ) : (
                    <p className="missing">{openPanel.lookupError ?? 'No YouTube video found for this song.'}</p>
                  )}
                </div>
                {!openPanel.detailLoading ? (
                  <section className="credits" aria-label="Credits" aria-busy={openPanel.creditsLoading}>
                    <h3>Credits</h3>
                    {openPanel.creditsLoading && !openPanel.credits ? (
                      <p className="connections-status" role="status">
                        <span className="trace-spinner" aria-hidden="true" />
                        Looking up credits…
                      </p>
                    ) : null}
                    {openPanel.creditsError ? <p className="error" role="alert">{openPanel.creditsError}</p> : null}
                    {openPanel.credits && openPanel.credits.length > 0 ? (
                      <CreditList credits={openPanel.credits} linksDisabled={linksDisabled} onOpenRelated={openRelated} />
                    ) : null}
                    {openPanel.creditsLoading && openPanel.credits ? (
                      <p className="connections-status" role="status">
                        <span className="trace-spinner" aria-hidden="true" />
                        Finding more credits and other songs…
                      </p>
                    ) : null}
                    {!openPanel.creditsLoading && !openPanel.creditsError && openPanel.credits && openPanel.credits.length === 0 ? (
                      <p className="connections-status">{openPanel.creditsNotice ?? 'No major credits were found.'}</p>
                    ) : null}
                  </section>
                ) : null}
              </article>
            </SongDialog>
          ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  )
}
