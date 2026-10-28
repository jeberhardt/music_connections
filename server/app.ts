import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { CreditsResponse, SaveChainResponse, Song, SongLookupResponse, SongsResponse } from '../src/types.ts'
import { fetchRandomBillboardChart } from './billboard.ts'
import { lookupChartAppearance } from './charted.ts'
import { availableChartYears, findChart } from '../src/charts.ts'
import { selectSongs } from './selectSong.ts'
import { findYoutubeVideoId, identifyYoutubeSong, parseYoutubeVideoId, YOUTUBE_URL_ERROR } from './youtube.ts'
import { findConnections } from './connections.ts'
import { findMajorCredits } from './credits.ts'
import { chainInputSchema, loadChain, saveChain } from './chains.ts'
import { fetchIndexHtml, withShareTags } from './sharePage.ts'

export const app = new Hono()

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/connections', async (c) => {
  const title1 = c.req.query('title1')?.trim() ?? ''
  const artist1 = c.req.query('artist1')?.trim() ?? ''
  const title2 = c.req.query('title2')?.trim() ?? ''
  const artist2 = c.req.query('artist2')?.trim() ?? ''
  const week1 = c.req.query('week1')?.trim() || undefined
  const week2 = c.req.query('week2')?.trim() || undefined
  const chart1 = c.req.query('chart1')?.trim() || undefined
  const chart2 = c.req.query('chart2')?.trim() || undefined
  if (!title1 || !artist1 || !title2 || !artist2) {
    return c.json({ error: 'Both songs need a title and artist' }, 400)
  }

  c.header('Cache-Control', 'no-cache')
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const busy = {
      connections: [],
      unavailable: [],
      notice: 'MusicBrainz is busy right now. Try again in a moment.',
    }
    try {
      const result = await findConnections(
        { title: title1, artist: artist1, week: week1, chartName: chart1 },
        { title: title2, artist: artist2, week: week2, chartName: chart2 },
        (event) => stream.writeSSE({ event: 'trace', data: JSON.stringify(event) }),
      )
      await stream.writeSSE({ event: 'result', data: JSON.stringify(result) })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const notice = /MusicBrainz returned 503|MusicBrainz is busy|503|429/.test(message)
        ? busy.notice
        : 'The connection search stopped early. Try again.'
      await stream.writeSSE({ event: 'result', data: JSON.stringify({ ...busy, notice }) })
    }
  })
})

app.get('/api/youtube', async (c) => {
  const input = c.req.query('url')?.trim() ?? ''
  const videoId = parseYoutubeVideoId(input)
  if (!videoId) return c.json({ error: YOUTUBE_URL_ERROR }, 400)
  try {
    const identified = await identifyYoutubeSong(videoId)
    const chart = await lookupChartAppearance(identified.title, identified.artist)
    const body: SongLookupResponse = {
      title: identified.title,
      artist: identified.artist,
      youtubeVideoId: videoId,
      chart,
    }
    return c.json(body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read that YouTube video.'
    const status = message.startsWith('This video title') ? 422 : message.startsWith('Could not read') ? 404 : 502
    return c.json({ error: message }, status)
  }
})

app.get('/api/song', async (c) => {
  const title = c.req.query('title')?.trim() ?? ''
  const artist = c.req.query('artist')?.trim() ?? ''
  if (!title || !artist) return c.json({ error: 'A song needs a title and artist' }, 400)
  try {
    const [youtubeVideoId, chart] = await Promise.all([
      findYoutubeVideoId(artist, title),
      lookupChartAppearance(title, artist),
    ])
    const body: SongLookupResponse = { title, artist, youtubeVideoId, chart }
    return c.json(body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to look up this song'
    return c.json({ error: message }, 502)
  }
})

app.get('/api/credits', async (c) => {
  const title = c.req.query('title')?.trim() ?? ''
  const artist = c.req.query('artist')?.trim() ?? ''
  if (!title || !artist) return c.json({ error: 'A song needs a title and artist' }, 400)
  try {
    const requested = c.req.query('extractor')
    const extractor = requested === 'claude' || requested === 'parser' ? requested : undefined
    const body: CreditsResponse = await findMajorCredits(title, artist, extractor)
    return c.json(body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to look up credits'
    return c.json({ error: message }, 502)
  }
})

app.post('/api/chains', async (c) => {
  const parsed = chainInputSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'That chain could not be saved.' }, 400)
  try {
    const shareId = await saveChain(parsed.data.steps)
    const body: SaveChainResponse = { shareId, path: `/c/${shareId}` }
    return c.json(body, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save the chain'
    return c.json({ error: message }, 502)
  }
})

app.get('/api/chains/:shareId', async (c) => {
  try {
    const chain = await loadChain(c.req.param('shareId'))
    if (!chain) return c.json({ error: 'That chain does not exist.' }, 404)
    return c.json(chain)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load the chain'
    return c.json({ error: message }, 502)
  }
})

// A shared chain's page: the frontend's index.html with the chain's title and preview tags filled in.
app.get('/c/:shareId', async (c) => {
  const html = await fetchIndexHtml(c.req.url)
  if (!html) return c.text('This page is not available right now.', 503)
  try {
    const chain = await loadChain(c.req.param('shareId'))
    return c.html(chain ? withShareTags(html, chain, c.req.url) : html)
  } catch {
    // The page still loads and shows its own error if Sanity cannot be reached.
    return c.html(html)
  }
})

app.get('/api/songs', async (c) => {
  const raw = c.req.query('count') ?? '1'
  const count = Number(raw)
  if (count !== 1 && count !== 2) {
    return c.json({ error: 'count must be 1 or 2' }, 400)
  }

  const chartSlug = c.req.query('chart')
  if (chartSlug && !findChart(chartSlug)) {
    return c.json({ error: 'Unknown chart' }, 400)
  }

  const yearRaw = c.req.query('year')
  let year: number | undefined
  if (yearRaw) {
    const since = chartSlug ? findChart(chartSlug)?.since : undefined
    year = Number(yearRaw)
    if (!/^\d{4}$/.test(yearRaw) || !availableChartYears(new Date(), since).includes(year)) {
      return c.json({ error: 'That chart has no weeks in the selected year' }, 400)
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return c.json({ error: 'ANTHROPIC_API_KEY is missing' }, 503)
  }

  try {
    const chart = await fetchRandomBillboardChart(chartSlug || undefined, year)
    const picked = await selectSongs(chart, count)
    const songs: Song[] = await Promise.all(
      picked.map(async (entry) => ({
        title: entry.title,
        artist: entry.artist,
        rank: entry.rank,
        chart: chart.slug,
        chartName: chart.name,
        week: chart.week,
        youtubeVideoId: await findYoutubeVideoId(entry.artist, entry.title),
      })),
    )

    const body: SongsResponse = { songs }
    return c.json(body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to pick a song'
    const status = message.includes('ANTHROPIC_API_KEY') ? 503 : 502
    return c.json({ error: message }, status)
  }
})

// Vercel's Hono support runs the default export.
export default app
