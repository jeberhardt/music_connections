import { load } from 'cheerio'
import { chartWeekBounds, randomSaturday, SONG_CHARTS } from '../src/charts.ts'

export type ChartEntry = {
  rank: number
  title: string
  artist: string
}

export type BillboardChart = {
  slug: string
  name: string
  week: string
  entries: ChartEntry[]
}

const MAX_ATTEMPTS = 8
const cache = new Map<string, BillboardChart>()

const BILLBOARD_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

/** "1986-10-25" -> "Week of October 25, 1986", matching Billboard's chart header. */
export function chartWeekLabel(week: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(week)
  if (!match) throw new Error(`Invalid chart week ${week}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day)))
  return `Week of ${formatted}`
}

/** Billboard weekly charts are published with Saturday dates. */
export function randomSaturdayInLast40Years(now = new Date(), since?: string, year?: number): string {
  return randomSaturday(now, since, year)
}

function parseBillboardHtml(html: string): ChartEntry[] {
  const $ = load(html)
  const entries: ChartEntry[] = []

  $('.o-chart-results-list-row-container').each((_, row) => {
    const $row = $(row)
    const rankAttr = $row.find('ul.o-chart-results-list-row').attr('data-detail-target')
    const rank = Number.parseInt(rankAttr ?? '', 10)
    const title = $row.find('h3.c-title').first().text().trim()
    const artist = $row.find('span.c-label.a-no-trucate').first().text().trim()
    if (!Number.isFinite(rank) || !title || !artist) return
    entries.push({ rank, title, artist })
  })

  return entries
}

async function fetchBillboardPage(slug: string, week: string): Promise<ChartEntry[]> {
  const url = `https://www.billboard.com/charts/${slug}/${week}/`
  const res = await fetch(url, { headers: BILLBOARD_HEADERS })
  if (!res.ok) {
    throw new Error(`Billboard ${slug} ${week} returned ${res.status}`)
  }

  const finalPath = new URL(res.url).pathname.replace(/\/+$/, '')
  if (finalPath !== `/charts/${slug}/${week}`) {
    throw new Error(`Billboard ${slug} ${week} redirected to ${finalPath}`)
  }

  const html = (await res.text()).replace(/\u00a0/g, ' ')
  const label = chartWeekLabel(week)
  if (!html.includes(label)) {
    throw new Error(`Billboard ${slug} ${week} was not ${label}`)
  }

  const entries = parseBillboardHtml(html)
  if (entries.length === 0) {
    throw new Error(`Billboard ${slug} ${week} had no chart rows`)
  }
  return entries
}

async function fetchHot100Archive(week: string): Promise<ChartEntry[]> {
  const url = `https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main/date/${week}.json`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Hot 100 archive ${week} returned ${res.status}`)
  }
  const json = (await res.json()) as {
    data?: Array<{ song: string; artist: string; this_week: number }>
  }
  const entries = (json.data ?? [])
    .map((row) => ({
      rank: row.this_week,
      title: row.song,
      artist: row.artist,
    }))
    .filter((row) => row.title && row.artist && Number.isFinite(row.rank))
  if (entries.length === 0) {
    throw new Error(`Hot 100 archive ${week} had no songs`)
  }
  return entries
}

export async function fetchChart(slug: string, week: string, name: string): Promise<BillboardChart> {
  const key = `${slug}:${week}`
  const cached = cache.get(key)
  if (cached) return cached

  let entries: ChartEntry[]
  try {
    entries = await fetchBillboardPage(slug, week)
  } catch (error) {
    if (slug !== 'hot-100') throw error
    entries = await fetchHot100Archive(week)
  }

  const chart: BillboardChart = { slug, name, week, entries }
  cache.set(key, chart)
  return chart
}

export async function fetchRandomBillboardChart(slug?: string, year?: number): Promise<BillboardChart> {
  const charts = slug ? SONG_CHARTS.filter((chart) => chart.slug === slug) : SONG_CHARTS
  if (charts.length === 0) {
    throw new Error(`Unknown chart ${slug}`)
  }

  const eligible = charts.filter((chart) => chartWeekBounds(new Date(), chart.since, year))
  if (eligible.length === 0) {
    throw new Error(year != null ? `No charts in ${year}` : 'No charts in range')
  }

  const errors: string[] = []

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const meta = pick(eligible)
    const week = randomSaturdayInLast40Years(new Date(), meta.since, year)
    try {
      return await fetchChart(meta.slug, week, meta.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${meta.slug} ${week}: ${message}`)
    }
  }

  throw new Error(`Could not load a Billboard chart after ${MAX_ATTEMPTS} tries. ${errors.join('; ')}`)
}
