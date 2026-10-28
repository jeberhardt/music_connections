import type { TraceEvent } from '../src/types.ts'
import { startFollow } from './follow.ts'

const USER_AGENT = 'music-connections/0.1 (local development)'
const MIN_INTERVAL_MS = 1200

type Side = {
  title: string
  artist: string
  recordingId: string
  billed: { id: string; name: string }[]
}

type EdgeMeta = { kind?: string; roles?: string[]; personName?: string; sourceUrl?: string }
type Link = (from: string, to: string, summary: string, rank: number, meta?: EdgeMeta) => void

let nextSlot = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pacedFetch(url: string, headers: Record<string, string>): Promise<Response | null> {
  const wait = Math.max(0, nextSlot - Date.now())
  nextSlot = Date.now() + wait + MIN_INTERVAL_MS
  if (wait > 0) await sleep(wait)
  try {
    const response = await fetch(url, { headers })
    if (response.status === 429 || response.status === 503 || response.status >= 500) return null
    if (!response.ok) return null
    return response
  } catch {
    return null
  }
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function primaryArtist(artist: string): string {
  return artist.split(/\s+(?:feat\.?|featuring|ft\.?|with|x|&)\s+/i)[0]?.trim() || artist
}

function sameSong(title: string, artist: string, otherTitle: string, otherArtist: string): boolean {
  if (!title || !otherTitle || !artist || !otherArtist) return false
  if (normalize(title) !== normalize(otherTitle)) return false
  const left = normalize(primaryArtist(artist))
  const right = normalize(primaryArtist(otherArtist))
  if (left === right) return true
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left]
  return longer.startsWith(`${shorter} `)
}

function quote(title: string): string {
  return `“${title}”`
}

async function addWikidata(side: Side, other: Side, link: Link, onTrace?: (event: TraceEvent) => Promise<void> | void) {
  const artists = [...side.billed, ...other.billed].filter((artist, index, all) => all.findIndex((item) => item.id === artist.id) === index).slice(0, 4)
  for (const artist of artists) {
    if (!/^[0-9a-f-]{36}$/i.test(artist.id)) continue
    const follow = await startFollow(onTrace, { title: artist.name, detail: 'checking Wikidata' })
    try {
    const query = `
      SELECT ?artist ?other ?otherMb ?otherLabel ?prop WHERE {
        ?artist wdt:P434 "${artist.id}" .
        {
          ?artist wdt:P463 ?other . BIND("member of" AS ?prop)
        } UNION {
          ?other wdt:P527 ?artist . BIND("member of" AS ?prop)
        }
        OPTIONAL { ?other wdt:P434 ?otherMb . }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
      }
      LIMIT 25`
    const response = await pacedFetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, {
      'User-Agent': USER_AGENT,
      Accept: 'application/sparql-results+json',
    })
    if (!response) continue
    const body = (await response.json()) as {
      results?: { bindings?: { artist?: { value?: string }; other?: { value?: string }; otherMb?: { value?: string }; otherLabel?: { value?: string }; prop?: { value?: string } }[] }
    }
    const rows = body.results?.bindings ?? []
    const artistIds = new Set(rows.map((row) => row.artist?.value).filter((value): value is string => Boolean(value)))
    if (artistIds.size !== 1) continue
    const byOther = new Map<string, { name: string; mbids: Set<string>; prop: string }>()
    for (const row of rows) {
      const otherId = row.other?.value
      const name = row.otherLabel?.value
      const prop = row.prop?.value
      if (!otherId || !name || !prop || name === otherId) continue
      const entry = byOther.get(otherId) ?? { name, mbids: new Set<string>(), prop }
      if (row.otherMb?.value) entry.mbids.add(row.otherMb.value)
      byOther.set(otherId, entry)
    }
    for (const entry of byOther.values()) {
      if (entry.prop !== 'member of') {
        await onTrace?.({ kind: 'discarded', title: entry.name, detail: 'influence' })
        continue
      }
      if (entry.mbids.size !== 1) continue
      const mbid = [...entry.mbids][0]
      if (!mbid) continue
      const summary = `${artist.name} was a member of ${entry.name}.`
      const meta = { kind: 'member', personName: artist.name, sourceUrl: `https://musicbrainz.org/artist/${artist.id}` }
      link(`a:${artist.id}`, `a:${mbid}`, summary, 7, meta)
      link(`a:${mbid}`, `a:${artist.id}`, summary, 7, meta)
    }
    } finally {
      await follow.end()
    }
  }
}

function discogsHeaders(): Record<string, string> | null {
  const token = process.env.DISCOGS_TOKEN?.trim()
  if (!token) return null
  return {
    'User-Agent': USER_AGENT,
    Authorization: `Discogs token=${token}`,
    Accept: 'application/json',
  }
}

function creditPhrase(name: string, role: string, title: string): { summary: string; rank: number; roles: string[] } | null {
  const normalized = role.toLowerCase()
  if (/writer|written|composed|lyric/.test(normalized)) return { summary: `${name} wrote ${quote(title)}.`, rank: 0, roles: ['wrote'] }
  if (/producer/.test(normalized)) return { summary: `${name} produced ${quote(title)}.`, rank: 0, roles: ['produced'] }
  if (/remix/.test(normalized)) return { summary: `${name} remixed ${quote(title)}.`, rank: 2, roles: ['remixed'] }
  if (/engineer|\bmix\b/.test(normalized)) return null
  return null
}

async function addDiscogs(side: Side, link: Link, onTrace?: (event: TraceEvent) => Promise<void> | void) {
  const headers = discogsHeaders()
  if (!headers) return
  const follow = await startFollow(onTrace, { title: side.title, artist: side.artist, detail: 'checking Discogs' })
  try {
  const searchUrl = `https://api.discogs.com/database/search?${new URLSearchParams({ track: side.title, artist: primaryArtist(side.artist), type: 'release', per_page: '3' })}`
  const searchResponse = await pacedFetch(searchUrl, headers)
  if (!searchResponse) return
  const search = (await searchResponse.json()) as { results?: { id?: number; title?: string }[] }
  const result = (search.results ?? []).find((item) => item.id && item.title && normalize(item.title).includes(normalize(side.title)))
  if (!result?.id) return
  const releaseResponse = await pacedFetch(`https://api.discogs.com/releases/${result.id}`, headers)
  if (!releaseResponse) return
  const release = (await releaseResponse.json()) as {
    artists?: { name?: string }[]
    tracklist?: { title?: string }[]
    labels?: { id?: number; name?: string }[]
    extraartists?: { id?: number; name?: string; role?: string }[]
  }
  const trackMatches = (release.tracklist ?? []).some((track) => normalize(track.title ?? '') === normalize(side.title))
  const artistMatches = (release.artists ?? []).some((artist) => sameSong(side.title, side.artist, side.title, artist.name ?? ''))
  if (!trackMatches || !artistMatches) return
  if ((release.labels ?? []).length > 0) await onTrace?.({ kind: 'discarded', title: side.title, detail: 'label or publisher' })
  for (const credit of release.extraartists ?? []) {
    if (!credit.id || !credit.name || !credit.role) continue
    const phrase = creditPhrase(credit.name, credit.role, side.title)
    if (!phrase) {
      if (/engineer|\bmix\b|studio/i.test(credit.role)) await onTrace?.({ kind: 'discarded', title: credit.name, detail: 'engineer or studio' })
      continue
    }
    const meta = { roles: phrase.roles, personName: credit.name, sourceUrl: `https://www.discogs.com/release/${result.id}` }
    link(`r:${side.recordingId}`, `dg:a:${credit.id}`, phrase.summary, phrase.rank, meta)
    link(`dg:a:${credit.id}`, `r:${side.recordingId}`, phrase.summary, phrase.rank, meta)
  }
  } finally {
    await follow.end()
  }
}

type ShsPerformance = {
  title?: string
  isOriginal?: boolean
  performer?: { name?: string }
  performance?: ShsPerformance
  covers?: ShsPerformance[]
  originals?: ShsPerformance[]
  usesSamplesFrom?: { performance?: ShsPerformance }[]
  sampledBy?: { performance?: ShsPerformance }[]
}

function listed(items: { performance?: ShsPerformance; title?: string; performer?: { name?: string } }[] | undefined): ShsPerformance[] {
  const performances: ShsPerformance[] = []
  for (const item of items ?? []) {
    const performance = item.performance?.title ? item.performance : item
    if (performance.title && performance.performer?.name) performances.push(performance)
  }
  return performances
}

async function addSecondHandSongs(left: Side, right: Side, link: Link, onTrace?: (event: TraceEvent) => Promise<void> | void) {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
  const key = process.env.SECONDHANDSONGS_API_KEY?.trim()
  if (key) headers['X-API-Key'] = key
  for (const side of [left, right]) {
    const other = side === left ? right : left
    const follow = await startFollow(onTrace, { title: side.title, artist: side.artist, detail: 'checking covers and samples' })
    try {
    const searchUrl = `https://api.secondhandsongs.com/search/performance?${new URLSearchParams({ title: side.title, performer: primaryArtist(side.artist) })}`
    const searchResponse = await pacedFetch(searchUrl, headers)
    if (!searchResponse) continue
    const search = (await searchResponse.json()) as { resultPage?: { uri?: string; title?: string; performer?: { name?: string } }[] }
    const hit = (search.resultPage ?? []).find((item) => item.uri && sameSong(side.title, side.artist, item.title ?? '', item.performer?.name ?? ''))
    if (!hit?.uri) continue
    const performanceResponse = await pacedFetch(hit.uri, headers)
    if (!performanceResponse) continue
    const performance = (await performanceResponse.json()) as ShsPerformance
    for (const sample of listed(performance.usesSamplesFrom)) {
      if (!sameSong(other.title, other.artist, sample.title ?? '', sample.performer?.name ?? '')) continue
      const summary = `${quote(side.title)} by ${side.artist} samples ${quote(other.title)} by ${other.artist}.`
      const meta = { kind: 'sample', sourceUrl: hit.uri }
      link(`r:${side.recordingId}`, `r:${other.recordingId}`, summary, 10, meta)
      link(`r:${other.recordingId}`, `r:${side.recordingId}`, summary, 10, meta)
    }
    const originals = listed(performance.originals)
    for (const original of originals) {
      if (!sameSong(other.title, other.artist, original.title ?? '', original.performer?.name ?? '')) continue
      const summary = `${quote(side.title)} by ${side.artist} covers ${quote(other.title)} by ${other.artist}.`
      const meta = { kind: 'cover', sourceUrl: hit.uri }
      link(`r:${side.recordingId}`, `r:${other.recordingId}`, summary, 20, meta)
      link(`r:${other.recordingId}`, `r:${side.recordingId}`, summary, 20, meta)
    }
    for (const cover of listed(performance.covers)) {
      if (!sameSong(other.title, other.artist, cover.title ?? '', cover.performer?.name ?? '')) continue
      const summary = `${quote(other.title)} by ${other.artist} covers ${quote(side.title)} by ${side.artist}.`
      const meta = { kind: 'cover', sourceUrl: hit.uri }
      link(`r:${other.recordingId}`, `r:${side.recordingId}`, summary, 20, meta)
      link(`r:${side.recordingId}`, `r:${other.recordingId}`, summary, 20, meta)
    }
    } finally {
      await follow.end()
    }
  }
}

export async function addOutsideSources(
  left: Side,
  right: Side,
  link: Link,
  onTrace?: (event: TraceEvent) => Promise<void> | void,
  includeSparse = false,
): Promise<void> {
  try {
    await addSecondHandSongs(left, right, link, onTrace)
  } catch {
    // A cover service failure leaves the MusicBrainz chain intact.
  }
  if (!includeSparse) return
  try {
    await addWikidata(left, right, link, onTrace)
  } catch {
    // Wikidata is optional.
  }
  try {
    await addDiscogs(left, link, onTrace)
    await addDiscogs(right, link, onTrace)
  } catch {
    // Discogs is optional.
  }
}
