import { useEffect, useRef, useState } from 'react'
import { availableChartYears, findChart, SONG_CHARTS } from './charts.ts'
import type { ConnectionsResponse, Song, TraceEvent } from './types.ts'
import './App.css'

type Slot = {
  chart: string
  year: string
  song: Song | null
  loading: boolean
  error: string | null
}

function emptySlot(): Slot {
  return { chart: '', year: '', song: null, loading: false, error: null }
}

function songKey(song: Song | null): string {
  return song ? `${song.title}|${song.artist}|${song.week}|${song.chart}` : ''
}

function App() {
  const [slots, setSlots] = useState<Slot[]>(() => [emptySlot(), emptySlot()])
  const [connections, setConnections] = useState<ConnectionsResponse | null>(null)
  const [connectionsLoading, setConnectionsLoading] = useState(false)
  const [connectionsError, setConnectionsError] = useState<string | null>(null)
  const [trace, setTrace] = useState<TraceEvent[]>([])
  const [traceTrimmed, setTraceTrimmed] = useState(0)
  const traceCount = useRef(0)
  const leftSong = slots[0]?.song ?? null
  const rightSong = slots[1]?.song ?? null
  const leftKey = songKey(leftSong)
  const rightKey = songKey(rightSong)

  useEffect(() => {
    if (!leftSong || !rightSong) {
      setConnections(null)
      setConnectionsError(null)
      setConnectionsLoading(false)
      setTrace([])
      setTraceTrimmed(0)
      traceCount.current = 0
      return
    }

    const controller = new AbortController()
    setConnectionsLoading(true)
    setConnectionsError(null)
    setConnections(null)
    setTrace([])
    setTraceTrimmed(0)
    traceCount.current = 0
    const params = new URLSearchParams({
      title1: leftSong.title,
      artist1: leftSong.artist,
      title2: rightSong.title,
      artist2: rightSong.artist,
      week1: leftSong.week,
      week2: rightSong.week,
      chart1: leftSong.chartName,
      chart2: rightSong.chartName,
    })

    fetch(`/api/connections?${params}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error ?? `Request failed (${res.status})`)
        }
        const reader = res.body?.getReader()
        if (!reader) throw new Error('The connection search did not stream')
        const decoder = new TextDecoder()
        let buffer = ''
        let result: ConnectionsResponse | null = null
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read()
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
          const chunks = buffer.split('\n\n')
          buffer = chunks.pop() ?? ''
          for (const chunk of chunks) {
            let event = 'message'
            let data = ''
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim()
              else if (line.startsWith('data:')) data += line.slice(5).trim()
            }
            if (!data) continue
            if (event === 'trace') {
              const line = JSON.parse(data) as TraceEvent
              if (line.kind === 'following' && line.active === false && line.id) {
                setTrace((current) => current.map((item) => (item.id === line.id ? { ...item, active: false } : item)))
                continue
              }
              traceCount.current += 1
              if (traceCount.current > 50) setTraceTrimmed(traceCount.current - 50)
              setTrace((current) => (current.length < 50 ? [...current, line] : [...current.slice(1), line]))
            } else if (event === 'result') {
              result = JSON.parse(data) as ConnectionsResponse
              setTrace((current) => current.map((item) => (item.active ? { ...item, active: false } : item)))
            }
          }
          if (done) break
        }
        if (controller.signal.aborted) return
        if (!result) throw new Error('The connection search stopped before it finished')
        setConnections(result)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setConnections(null)
        const message = err instanceof Error ? err.message : 'Could not find connections'
        setConnectionsError(message.includes('MusicBrainz returned 503') ? 'MusicBrainz is busy right now. Try again in a moment.' : message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setConnectionsLoading(false)
      })

    return () => controller.abort()
  }, [leftKey, rightKey, leftSong, rightSong])

  function updateSlot(index: number, patch: Partial<Slot>) {
    setSlots((current) => current.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)))
  }

  async function pickSong(index: number) {
    const slot = slots[index]
    if (!slot) return
    updateSlot(index, { loading: true, error: null })
    try {
      const params = new URLSearchParams({ count: '1' })
      if (slot.chart) params.set('chart', slot.chart)
      if (slot.year) params.set('year', slot.year)
      const res = await fetch(`/api/songs?${params}`)
      const body = (await res.json()) as { songs?: Song[]; error?: string }
      if (!res.ok || !body.songs?.[0]) {
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      updateSlot(index, { loading: false, song: body.songs[0] })
    } catch (err) {
      updateSlot(index, {
        loading: false,
        error: err instanceof Error ? err.message : 'Could not pick a song',
      })
    }
  }

  return (
    <main className="page">
      <p className="eyebrow">Music Connections</p>
      <h1>Random Billboard songs</h1>
      <p className="lede">
        Pick two songs. Each row uses its own Billboard chart and year from the last 40 years,
        then finds a YouTube clip and a chain of documented connections between the songs.
        Or <a href="/random">pick one random song</a>.
      </p>
      <div className="rows">
        {slots.map((slot, index) => {
          const years = availableChartYears(new Date(), slot.chart ? findChart(slot.chart)?.since : undefined)
          return (
            <section className="row" key={index} aria-label={`Song ${index + 1}`}>
              <p className="row-label">Song {index + 1}</p>
              <div className="controls">
                <label className="field">
                  <span className="field-label">Chart</span>
                  <select
                    value={slot.chart}
                    onChange={(event) => {
                      const next = event.target.value
                      const since = next ? findChart(next)?.since : undefined
                      const yearStillValid = !slot.year || availableChartYears(new Date(), since).includes(Number(slot.year))
                      updateSlot(index, { chart: next, year: yearStillValid ? slot.year : '' })
                    }}
                    disabled={slot.loading}
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
                    value={slot.year}
                    onChange={(event) => updateSlot(index, { year: event.target.value })}
                    disabled={slot.loading}
                  >
                    <option value="">Any year</option>
                    {years.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="pick" onClick={() => pickSong(index)} disabled={slot.loading}>
                  {slot.loading ? (
                    <>
                      <span className="trace-spinner" aria-hidden="true" />
                      Picking…
                    </>
                  ) : slot.song ? (
                    'Pick again'
                  ) : (
                    'Pick a song'
                  )}
                </button>
              </div>
              {slot.error ? <p className="error" role="alert">{slot.error}</p> : null}
              {slot.song ? (
                <article className="song">
                  <p className="rank">
                    <span className="rank-label">No.</span>
                    <span className="rank-value">{slot.song.rank}</span>
                  </p>
                  <h2>{slot.song.title}</h2>
                  <p className="artist">{slot.song.artist}</p>
                  <p className="meta">
                    {slot.song.chartName} · week of {slot.song.week}
                  </p>
                  {slot.song.youtubeVideoId ? (
                    <div className="player">
                      <iframe
                        src={`https://www.youtube.com/embed/${slot.song.youtubeVideoId}`}
                        title={`${slot.song.title} by ${slot.song.artist}`}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                      />
                    </div>
                  ) : (
                    <p className="missing">No YouTube video found for this pick.</p>
                  )}
                </article>
              ) : null}
            </section>
          )
        })}
      </div>
      {slots[0]?.song && slots[1]?.song ? (
        <section className="connections" aria-label="Connections">
          <h2>Connections</h2>
          {connectionsLoading ? <p className="connections-status">Tracing a chain of connections…</p> : null}
          {connectionsError ? <p className="error" role="alert">{connectionsError}</p> : null}
          {!connectionsLoading && !connectionsError && connections ? (
            <>
              {connections.unavailable.map((label) => (
                <p className="connections-status" key={label}>
                  Couldn’t find credits for {label}.
                </p>
              ))}
              {connections.notice ? <p className="connections-status">{connections.notice}</p> : null}
              {connections.headline ? <p className="link-count">{connections.headline}</p> : null}
              {connections.connections.length > 0 ? (
                <ol>
                  {connections.connections.map((connection, index) => (
                    <li key={`${index}-${connection.summary}`}>
                      {connection.emphasis ? <strong>{connection.emphasis}</strong> : null}
                      {connection.emphasis ? ' — ' : ''}
                      {connection.summary}
                    </li>
                  ))}
                </ol>
              ) : !connections.notice && connections.unavailable.length === 0 ? (
                <p className="connections-status">No documented chain was found. A link has to be a shared performer, songwriter, or producer, or an official sample, interpolation, or cover.</p>
              ) : null}
              {connections.hardest ? <p className="connections-status">{connections.hardest}</p> : null}
              {connections.sources && connections.sources.length > 0 ? (
                <>
                  <h3>Sources</h3>
                  <ul className="sources">
                    {connections.sources.map((source) => (
                      <li key={source.url}>
                        <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {connections.caveats && connections.caveats.length > 0 ? (
                <ul className="caveats">
                  {connections.caveats.map((caveat) => (
                    <li key={caveat}>{caveat}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {trace.length > 0 ? (
            <div className="trace-wrap">
              <h3>Songs checked</h3>
              <ol className="trace">
                {trace.map((event, index) => (
                  <li key={event.id ?? `${index}-${event.kind}-${event.title}`} className={`trace-${event.kind}${event.active ? ' trace-active' : ''}`}>
                    <span className="trace-kind">{event.kind === 'discarded' ? 'Set aside' : event.kind === 'following' ? (event.active ? 'Following' : 'Followed') : 'Found'}</span>
                    <span>
                      {event.active ? <span className="trace-spinner" aria-hidden="true" /> : null}
                      <strong>{event.title}</strong>
                      {event.artist ? ` — ${event.artist}` : ''}
                      <span className="trace-detail">{event.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
              {traceTrimmed > 0 || connections?.traceTrimmed ? <p className="connections-status">Earlier lines were trimmed.</p> : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  )
}

export default App
