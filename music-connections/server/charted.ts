import { chartWeekBounds, SONG_CHARTS } from '../src/charts.ts'
import type { ChartAppearance } from '../src/types.ts'
import { fetchChart } from './billboard.ts'
import { wikiUrl } from './early.ts'

const WIKI_API = 'https://en.wikipedia.org/w/api.php'
const APP_UA = 'music-connections/0.1 (local development)'
const DAY_MS = 24 * 60 * 60 * 1000
const LOOKUP_BUDGET = 6

const TEMPLATE_CHARTS: Record<string, { slug: string; name: string }> = {
  billboardhot100: { slug: 'hot-100', name: 'Billboard Hot 100' },
  billboardcountrysongs: { slug: 'country-songs', name: 'Hot Country Songs' },
  billboardrandbhiphop: { slug: 'r-b-hip-hop-songs', name: 'Hot R&B/Hip-Hop Songs' },
  billboardpopsongs: { slug: 'pop-songs', name: 'Pop Airplay' },
  billboardlatinsongs: { slug: 'latin-songs', name: 'Hot Latin Songs' },
  billboardrocksongs: { slug: 'hot-rock-songs', name: 'Hot Rock & Alternative Songs' },
}

const PROSE_CHARTS: { slug: string; name: string; re: RegExp }[] = [
  { slug: 'r-b-hip-hop-songs', name: 'Hot R&B/Hip-Hop Songs', re: /hot r\s*&\s*b(?:\/hip-hop)? songs|r&b\/hip-hop songs/gi },
  { slug: 'hot-rock-songs', name: 'Hot Rock & Alternative Songs', re: /hot rock(?:\s*(?:&|and)\s*alternative)? songs/gi },
  { slug: 'country-songs', name: 'Hot Country Songs', re: /hot country songs/gi },
  { slug: 'latin-songs', name: 'Hot Latin Songs', re: /hot latin songs/gi },
  { slug: 'pop-songs', name: 'Pop Airplay', re: /pop airplay|mainstream top 40|(?<!adult )pop songs/gi },
  { slug: 'hot-100', name: 'Billboard Hot 100', re: /(?<!canadian )hot 100/gi },
]

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
}

type DatedCandidate = { slug: string; name: string; week: string }

const appearanceCache = new Map<string, ChartAppearance | null>()

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/(\p{L})!(\p{L})/gu, '$1i$2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function primaryArtist(artist: string): string {
  return artist.split(/\s+(?:feat\.?|featuring|ft\.?|with|x|&)\s+/i)[0]?.trim() || artist
}

function titlesMatch(wanted: string, entry: string): boolean {
  const a = fold(wanted)
  const b = fold(entry)
  if (!a || !b) return false
  if (a === b) return true
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  if (shorter.length < 4 || !longer.startsWith(shorter)) return false
  const rest = longer.slice(shorter.length).trim()
  return /^(remix|radio edit|edit|version|remaster|remastered)\b/.test(rest)
}

function artistsMatch(wanted: string, entry: string): boolean {
  const wantedPrimary = fold(primaryArtist(wanted))
  const entryPrimary = fold(primaryArtist(entry))
  if (wantedPrimary && wantedPrimary === entryPrimary) return true
  return fold(wanted) !== '' && fold(wanted) === fold(entry)
}

function cacheKey(title: string, artist: string): string {
  return `${fold(title)}|${fold(primaryArtist(artist))}`
}

async function getText(url: string): Promise<{ status: number; text: string } | null> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': APP_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    })
    return { status: response.status, text: await response.text() }
  } catch {
    return null
  }
}

async function wikiRaw(title: string, depth = 0): Promise<{ title: string; wikitext: string } | null> {
  if (depth > 2) return null
  const response = await getText(`${wikiUrl(title)}?action=raw`)
  if (!response || response.status !== 200) return null
  const wikitext = response.text
  if (!wikitext || wikitext.startsWith('<!DOCTYPE') || wikitext.includes('<html')) return null
  const redirect = wikitext.match(/^#REDIRECT\s+\[\[([^\]|#]+)/i)
  if (redirect?.[1]) return wikiRaw(redirect[1].replace(/_/g, ' ').trim(), depth + 1)
  return { title, wikitext }
}

async function wikiPage(title: string): Promise<{ title: string; wikitext: string } | null> {
  const url = `${WIKI_API}?${new URLSearchParams({
    action: 'parse',
    page: title,
    prop: 'wikitext',
    format: 'json',
    redirects: '1',
  })}`
  const response = await getText(url)
  if (response?.status === 200) {
    try {
      const data = JSON.parse(response.text) as { parse?: { title?: string; wikitext?: { '*'?: string } } }
      const wikitext = data.parse?.wikitext?.['*']
      if (wikitext) return { title: data.parse?.title || title, wikitext }
    } catch {
      // The parse API can return a maintenance page. The raw article is the fallback.
    }
  }
  return wikiRaw(title)
}

async function wikiSearch(query: string): Promise<string[]> {
  const url = `${WIKI_API}?${new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: '5',
    format: 'json',
  })}`
  const response = await getText(url)
  if (response?.status === 200) {
    try {
      const data = JSON.parse(response.text) as { query?: { search?: { title: string }[] } }
      const hits = data.query?.search?.map((item) => item.title) ?? []
      if (hits.length > 0) return hits
    } catch {
      // Fall through to the public search page.
    }
  }

  const searchUrl = `https://en.wikipedia.org/w/index.php?${new URLSearchParams({
    search: query,
    title: 'Special:Search',
    ns0: '1',
  })}`
  try {
    const page = await fetch(searchUrl, {
      headers: { 'User-Agent': APP_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    })
    if (!page.ok) return []
    const html = await page.text()
    const canonical = html.match(/<link rel="canonical" href="https:\/\/en\.wikipedia\.org\/wiki\/([^"]+)"/i)
    const canonicalTitle = canonical?.[1] ? decodeURIComponent(canonical[1]).replace(/_/g, ' ') : ''
    if (canonicalTitle && !canonicalTitle.startsWith('Special:')) return [canonicalTitle]
    return [...html.matchAll(/mw-search-result-heading[\s\S]{0,400}?href="\/wiki\/([^"#]+)"/g)]
      .map((match) => decodeURIComponent(match[1] ?? '').replace(/_/g, ' '))
      .filter((title) => title && !title.startsWith('Special:'))
      .slice(0, 5)
  } catch {
    return []
  }
}

function pageScore(pageTitle: string, title: string, artist: string): number {
  const base = pageTitle.replace(/\s*\([^)]*\)\s*$/, '').trim()
  if (fold(base) !== fold(title)) return -1
  let score = 1
  if (/\(song\)$/i.test(pageTitle)) score += 5
  const artistFold = fold(primaryArtist(artist))
  if (artistFold && fold(pageTitle).includes(artistFold)) score += 6
  if (/\((?:album|ep|film|soundtrack|mixtape)\)$/i.test(pageTitle)) score -= 4
  return score
}

function mentionsArtist(wikitext: string, artist: string): boolean {
  const primary = fold(primaryArtist(artist))
  if (!primary) return false
  return fold(wikitext.slice(0, 8000)).includes(primary)
}

function disambiguationTarget(wikitext: string, title: string, artist: string): string | null {
  if (!/\{\{\s*(?:disambiguation|hndis|song disambiguation)/i.test(wikitext) && !/may refer to/i.test(wikitext.slice(0, 800))) {
    return null
  }
  const artistFold = fold(primaryArtist(artist))
  const titleFold = fold(title)
  for (const match of wikitext.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g)) {
    const link = match[1]?.replace(/_/g, ' ').trim() ?? ''
    const base = fold(link.replace(/\s*\([^)]*\)\s*$/, ''))
    if (base === titleFold && artistFold && fold(link).includes(artistFold)) return link
  }
  return null
}

async function findSongPage(title: string, artist: string): Promise<{ title: string; wikitext: string } | null> {
  const hits = await wikiSearch(`"${title}" ${primaryArtist(artist)}`)
  const ranked = hits
    .map((hit) => ({ hit, score: pageScore(hit, title, artist) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score)
  const ordered = ranked.length > 0 ? ranked.map((item) => item.hit) : hits.slice(0, 3)

  for (const hit of ordered.slice(0, 3)) {
    const page = await wikiPage(hit)
    if (!page) continue
    const redirect = disambiguationTarget(page.wikitext, title, artist)
    const songPage = redirect ? await wikiPage(redirect) : page
    if (!songPage || pageScore(songPage.title, title, artist) < 0) continue
    if (!mentionsArtist(songPage.wikitext, artist)) continue
    return songPage
  }
  return null
}

function nearestSaturday(year: number, monthIndex: number, day: number): string | null {
  const date = new Date(Date.UTC(year, monthIndex, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day) return null
  const forward = (6 - date.getUTCDay() + 7) % 7
  const back = (date.getUTCDay() - 6 + 7) % 7
  const delta = forward <= back ? forward : -back
  return new Date(date.getTime() + delta * DAY_MS).toISOString().slice(0, 10)
}

function chartInWindow(windowText: string, dateOffset: number): { slug: string; name: string } | null {
  const lower = windowText.toLowerCase()
  let best: { slug: string; name: string; distance: number } | null = null
  for (const chart of PROSE_CHARTS) {
    const re = new RegExp(chart.re.source, 'gi')
    for (const match of lower.matchAll(re)) {
      const distance = Math.abs((match.index ?? 0) - dateOffset)
      if (!best || distance < best.distance) best = { slug: chart.slug, name: chart.name, distance }
    }
  }
  return best && best.distance <= 240 ? { slug: best.slug, name: best.name } : null
}

function chartBySlug(slug: string): { slug: string; name: string } | null {
  const chart = SONG_CHARTS.find((item) => item.slug === slug)
  return chart ? { slug: chart.slug, name: chart.name } : null
}

function pushCandidate(list: DatedCandidate[], seen: Set<string>, candidate: DatedCandidate | null) {
  if (!candidate || seen.has(`${candidate.slug}:${candidate.week}`)) return
  seen.add(`${candidate.slug}:${candidate.week}`)
  list.push(candidate)
}

function datedCandidates(wikitext: string): DatedCandidate[] {
  const found: DatedCandidate[] = []
  const seen = new Set<string>()

  for (const match of wikitext.matchAll(/billboard\.com\/charts\/([a-z0-9-]+)\/(\d{4}-\d{2}-\d{2})/gi)) {
    const chart = chartBySlug(match[1] ?? '')
    const week = match[2] ?? ''
    if (!chart || !/^\d{4}-\d{2}-\d{2}$/.test(week)) continue
    const [year, month, day] = week.split('-').map(Number)
    if (!year || !month || !day || !nearestSaturday(year, month - 1, day) || new Date(`${week}T00:00:00Z`).getUTCDay() !== 6) continue
    pushCandidate(found, seen, { slug: chart.slug, name: chart.name, week })
  }

  const dateRe = /(?:issue dated|chart dated|charts? dated|week ending|charting week ending|week of)\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/g
  for (const match of wikitext.matchAll(dateRe)) {
    const month = MONTHS[(match[1] ?? '').toLowerCase()]
    const day = Number(match[2])
    const year = Number(match[3])
    if (month == null || !day || !year) continue
    const week = nearestSaturday(year, month, day)
    if (!week) continue
    const start = Math.max(0, (match.index ?? 0) - 240)
    const windowText = wikitext.slice(start, (match.index ?? 0) + match[0].length + 240)
    const chart = chartInWindow(windowText, (match.index ?? 0) - start)
    if (!chart) continue
    pushCandidate(found, seen, { slug: chart.slug, name: chart.name, week })
  }

  return found
}

function yearsBefore(wikitext: string, index: number): number[] {
  const before = wikitext.slice(Math.max(0, index - 5000), index)
  const matches = [...before.matchAll(/Chart \((\d{4})(?:\s*[–-]\s*(\d{4}))?\)/g)]
  const last = matches.at(-1)
  if (!last) return []
  const start = Number(last[1])
  const end = last[2] ? Number(last[2]) : start
  if (!start || !end || end < start || end - start > 2) return [start]
  const years: number[] = []
  for (let year = start; year <= end; year++) years.push(year)
  return years
}

function sampledWeeks(slug: string, years: number[]): string[] {
  const meta = SONG_CHARTS.find((chart) => chart.slug === slug)
  if (!meta) return []
  const perYear = years.length > 1 ? 2 : 4
  const weeks: string[] = []
  for (const year of years) {
    const bounds = chartWeekBounds(new Date(), meta.since, year)
    if (!bounds) continue
    const count = Math.round((bounds.end.getTime() - bounds.start.getTime()) / (7 * DAY_MS))
    for (let i = 0; i < perYear; i++) {
      const index = Math.round((i * count) / (perYear - 1))
      weeks.push(new Date(bounds.start.getTime() + index * 7 * DAY_MS).toISOString().slice(0, 10))
    }
  }
  return [...new Set(weeks)]
}

function sampleCandidates(wikitext: string): DatedCandidate[] {
  const found: DatedCandidate[] = []
  const seen = new Set<string>()
  const templateRe = /\{\{\s*single\s*chart\s*\|\s*([A-Za-z0-9]+)\s*\|/gi
  for (const match of wikitext.matchAll(templateRe)) {
    const chart = TEMPLATE_CHARTS[(match[1] ?? '').toLowerCase()]
    if (!chart) continue
    const years = yearsBefore(wikitext, match.index ?? 0)
    for (const week of sampledWeeks(chart.slug, years)) {
      pushCandidate(found, seen, { slug: chart.slug, name: chart.name, week })
    }
  }
  return found
}

async function confirm(candidate: DatedCandidate, title: string, artist: string): Promise<ChartAppearance | null> {
  try {
    const chart = await fetchChart(candidate.slug, candidate.week, candidate.name)
    const hit = chart.entries.find((entry) => titlesMatch(title, entry.title) && artistsMatch(artist, entry.artist))
    if (!hit) return null
    return { chart: candidate.slug, chartName: candidate.name, rank: hit.rank, week: candidate.week }
  } catch {
    return null
  }
}

async function firstConfirmed(candidates: DatedCandidate[], title: string, artist: string, budget: { left: number }): Promise<ChartAppearance | null> {
  for (const candidate of candidates) {
    if (budget.left <= 0) return null
    budget.left -= 1
    const hit = await confirm(candidate, title, artist)
    if (hit) return hit
  }
  return null
}

/** A Billboard rank for this title and primary artist, or null when none can be confirmed. */
export async function lookupChartAppearance(title: string, artist: string): Promise<ChartAppearance | null> {
  const key = cacheKey(title, artist)
  if (appearanceCache.has(key)) return appearanceCache.get(key) ?? null

  try {
    const page = await findSongPage(title, artist)
    if (!page) return null
    const budget = { left: LOOKUP_BUDGET }
    const dated = await firstConfirmed(datedCandidates(page.wikitext).slice(0, 3), title, artist, budget)
    const appearance = dated ?? (await firstConfirmed(sampleCandidates(page.wikitext).slice(0, 3), title, artist, budget))
    appearanceCache.set(key, appearance)
    return appearance
  } catch {
    return null
  }
}
