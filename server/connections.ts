import type { TraceEvent } from '../src/types.ts'
import { findEarlyChain } from './early.ts'
import { startFollow } from './follow.ts'
import { addOutsideSources } from './outside.ts'

const USER_AGENT = 'music-connections/0.1 (local development)'
const MIN_INTERVAL_MS = 1200
const TRACE_LIMIT = 50

type MbArtist = { id?: string; name?: string; type?: string }
type MbCredit = { name?: string; artist?: MbArtist }
type MbRelease = {
  id?: string
  title?: string
  'release-group'?: { 'primary-type'?: string; 'secondary-types'?: string[] }
}
type MbRelation = {
  type?: string
  direction?: string
  attributes?: string[]
  artist?: MbArtist
  recording?: { id?: string; title?: string; video?: boolean; disambiguation?: string; 'artist-credit'?: MbCredit[] }
  work?: { id?: string; title?: string }
  place?: { id?: string; name?: string }
  label?: { id?: string; name?: string }
  event?: { id?: string; name?: string }
}
type MbRecording = {
  id: string
  title?: string
  score?: number
  length?: number
  video?: boolean
  disambiguation?: string
  releases?: MbRelease[]
  relations?: MbRelation[]
  'artist-credit'?: MbCredit[]
}

type PersonCredit = {
  id: string
  name: string
  roles: Set<string>
}

type SampleRef = {
  recordingId: string
  title: string
  artist: string
}

type SongCredits = {
  recordingId: string
  title: string
  artist: string
  people: Map<string, PersonCredit>
  billedIds: Set<string>
  samples: SampleRef[]
  sampledByIds: Set<string>
}

type GraphEdge = {
  to: string
  summary: string
  rank: number
  kind?: string
  roles?: string[]
  personName?: string
  sourceUrl?: string
}

export type SongConnection = {
  summary: string
  emphasis?: string
}

export type ChainSource = {
  label: string
  url: string
}

export type ConnectionRequest = {
  title: string
  artist: string
  week?: string
  chartName?: string
}

export type ConnectionsResult = {
  connections: SongConnection[]
  unavailable: string[]
  notice?: string
  traceTrimmed?: number
  headline?: string
  sources?: ChainSource[]
  caveats?: string[]
  hardest?: string
}

const TRACE_LIMIT_NOTE = TRACE_LIMIT

let traceCount = 0
let traceTrimmed = 0
let emitTrace: ((event: TraceEvent) => Promise<void> | void) | null = null
const songInfo = new Map<string, { title: string; artist: string; remix: boolean }>()
type BridgeSong = { id: string; title: string; roleRank: number; releaseCount: number }
const bridgeCandidates = new Map<string, BridgeSong[]>()

async function trace(event: TraceEvent) {
  if (!(event.kind === 'following' && event.active === false)) {
    traceCount++
    if (traceCount > TRACE_LIMIT_NOTE) traceTrimmed = traceCount - TRACE_LIMIT_NOTE
  }
  await emitTrace?.(event)
}

const BUSY_NOTE = 'MusicBrainz is busy right now. Try again in a moment.'
const MAX_ATTEMPTS = 6

let queue: Promise<void> = Promise.resolve()
let nextSlot = 0
let musicBrainzBusy = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
  return Math.min(20_000, 1500 * 2 ** attempt)
}

function mbFetch(url: string): Promise<Response> {
  const run = queue.then(async () => {
    const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    let res: Response | null = null
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const wait = Math.max(0, nextSlot - Date.now())
      nextSlot = Date.now() + wait + MIN_INTERVAL_MS
      if (wait > 0) await sleep(wait)
      res = await fetch(url, { headers })
      if (res.status !== 503 && res.status !== 429) return res
      nextSlot = Math.max(nextSlot, Date.now() + retryDelay(res, attempt))
    }
    return res as Response
  })
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function mbJson<T>(url: string): Promise<T | null> {
  try {
    const res = await mbFetch(url)
    if (res.ok) return (await res.json()) as T
    if (res.status === 404) return null
    if (res.status === 503 || res.status === 429 || res.status >= 500) musicBrainzBusy = true
    return null
  } catch {
    musicBrainzBusy = true
    return null
  }
}

function busyNotice(): string | undefined {
  return musicBrainzBusy ? BUSY_NOTE : undefined
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

function lucenePhrase(value: string): string {
  return `"${value.replace(/["\\]/g, ' ').trim()}"`
}

function joinAnd(items: string[]): string {
  const unique = [...new Set(items.filter(Boolean))]
  if (unique.length <= 1) return unique[0] ?? ''
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`
  return `${unique.slice(0, -1).join(', ')}, and ${unique.at(-1)}`
}

function artistNames(credits: MbCredit[] | undefined): string {
  return (credits ?? [])
    .map((credit) => credit.name || credit.artist?.name)
    .filter((name): name is string => Boolean(name))
    .join(', ')
}

function roleLabel(type: string, attributes: string[]): string | null {
  if (type === 'producer') return 'produced'
  if (type === 'writer' || type === 'composer' || type === 'lyricist') return 'wrote'
  if (type === 'performer') return 'performed'
  if (type === 'remixer') return 'remixed'
  if (type === 'mix') return 'mixed'
  if (type === 'engineer') return 'engineered'
  if (type === 'programming') return 'programmed'
  if (type === 'recording') return 'recorded'
  if (type === 'arranger' || type === 'instrument arranger') return 'arranged'
  if (type === 'conductor') return 'conducted'
  if (type === 'musical director') return 'was musical director'
  if (type === 'vocal') {
    const kind = attributes.find((attribute) => /vocal/i.test(attribute))
    if (!kind || kind.toLowerCase() === 'vocal') return 'sang'
    if (kind.toLowerCase() === 'lead vocals') return 'sang lead vocals'
    if (kind.toLowerCase() === 'background vocals') return 'sang background vocals'
    return `sang ${kind}`
  }
  if (type === 'instrument') {
    const instruments = attributes.map((attribute) => attribute.replace(/\s*\([^)]*\)/g, '').trim()).filter(Boolean)
    return instruments.length > 0 ? `played ${joinAnd(instruments)}` : 'played'
  }
  return null
}

function addRole(people: Map<string, PersonCredit>, id: string, name: string, role: string) {
  const existing = people.get(id)
  if (existing) {
    existing.roles.add(role)
    return
  }
  people.set(id, { id, name, roles: new Set([role]) })
}

function mergeRoles(roles: Iterable<string>): string[] {
  const played: string[] = []
  const rest: string[] = []
  for (const role of roles) {
    if (role === 'played') {
      played.push('')
    } else if (role.startsWith('played ')) {
      played.push(...role.slice('played '.length).split(', ').flatMap((part) => part.split(' and ')))
    } else {
      rest.push(role)
    }
  }
  const order = ['wrote', 'produced', 'arranged', 'recorded', 'programmed']
  const merged = [...new Set(rest)]
  merged.sort((a, b) => {
    const aRank = order.indexOf(a)
    const bRank = order.indexOf(b)
    return (aRank === -1 ? order.length : aRank) - (bRank === -1 ? order.length : bRank)
  })
  const instruments = [...new Set(played.map((item) => item.trim()).filter(Boolean))]
  if (instruments.length > 0) merged.push(`played ${joinAnd(instruments)}`)
  else if (played.length > 0) merged.push('played')
  if (merged.some((role) => role !== 'performed')) {
    return merged.filter((role) => role !== 'performed')
  }
  return merged
}

function noiseReason(recording: { video?: boolean; length?: number; disambiguation?: string }): string | null {
  if (recording.video) return 'video'
  if (recording.length != null && recording.length < 30_000) return 'too short'
  const note = recording.disambiguation ?? ''
  if (/live/i.test(note)) return 'live'
  if (/dj[-‐\s]?mix/i.test(note)) return 'DJ mix'
  if (/remix/i.test(note)) return 'remix'
  if (/karaoke/i.test(note)) return 'karaoke'
  if (/music video/i.test(note)) return 'video'
  if (/instrumental/i.test(note)) return 'instrumental'
  if (/commentary/i.test(note)) return 'commentary'
  if (/demo/i.test(note)) return 'demo'
  if (/bootleg/i.test(note)) return 'bootleg'
  if (/mash/i.test(note)) return 'mashup'
  return null
}

function isNoise(recording: MbRecording): boolean {
  return noiseReason(recording) != null
}

async function searchRecordings(title: string, artist: string): Promise<MbRecording[]> {
  const query = `recording:${lucenePhrase(title)} AND artist:${lucenePhrase(artist)}`
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=10`
  const data = await mbJson<{ recordings?: MbRecording[] }>(url)
  return data?.recordings ?? []
}

async function loadRecording(id: string): Promise<MbRecording | null> {
  return mbJson<MbRecording>(
    `https://musicbrainz.org/ws/2/recording/${id}?inc=artist-credits+artist-rels+recording-rels+work-rels+place-rels+label-rels+releases+release-groups&fmt=json`,
  )
}

function personCreditCount(recording: MbRecording): number {
  const ids = new Set<string>()
  for (const relation of recording.relations ?? []) {
    const label = relation.artist?.id ? roleLabel(relation.type ?? '', relation.attributes ?? []) : null
    if (label && relation.artist?.id) ids.add(relation.artist.id)
  }
  return ids.size
}

function songLabel(recording: { title?: string; 'artist-credit'?: MbCredit[] }, fallbackTitle: string, fallbackArtist: string) {
  return {
    title: recording.title || fallbackTitle,
    artist: artistNames(recording['artist-credit']) || fallbackArtist,
  }
}

async function chooseRecording(title: string, artist: string): Promise<MbRecording | null> {
  const follow = await startFollow(trace, { title, artist, detail: 'looking up recordings' })
  try {
  const primary = primaryArtist(artist)
  let hits = await searchRecordings(title, primary)
  if (hits.length === 0 && !musicBrainzBusy && normalize(primary) !== normalize(artist)) {
    hits = await searchRecordings(title, artist)
  }

  const kept: MbRecording[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    const label = songLabel(hit, title, artist)
    if (seen.has(hit.id)) {
      await trace({ kind: 'discarded', ...label, detail: 'already seen' })
      continue
    }
    seen.add(hit.id)
    if ((hit.score ?? 0) < 80) {
      await trace({ kind: 'discarded', ...label, detail: 'weak match' })
      continue
    }
    const reason = noiseReason(hit)
    if (reason) {
      await trace({ kind: 'discarded', ...label, detail: reason })
      continue
    }
    kept.push(hit)
  }
  kept.sort((a, b) => (b.releases?.length ?? 0) - (a.releases?.length ?? 0))
  for (const extra of kept.slice(3)) {
    await trace({ kind: 'discarded', ...songLabel(extra, title, artist), detail: 'not expanded' })
  }

  let best: MbRecording | null = null
  let bestCount = -1
  const loaded: { recording: MbRecording; count: number }[] = []
  for (const hit of kept.slice(0, 3)) {
    const recording = await loadRecording(hit.id)
    if (!recording) {
      await trace({ kind: 'discarded', ...songLabel(hit, title, artist), detail: 'not expanded' })
      continue
    }
    const count = personCreditCount(recording)
    loaded.push({ recording, count })
    if (count > bestCount) {
      best = recording
      bestCount = count
    }
  }
  for (const item of loaded) {
    const label = songLabel(item.recording, title, artist)
    if (item.recording.id === best?.id) await trace({ kind: 'found', ...label, detail: 'MusicBrainz · selected recording' })
    else await trace({ kind: 'discarded', ...label, detail: 'not selected' })
  }
  return best
  } finally {
    await follow.end()
  }
}

type MbWork = { id?: string; title?: string; relations?: MbRelation[] }

async function loadWorks(recording: MbRecording, people: Map<string, PersonCredit>): Promise<MbWork[]> {
  const workIds = [
    ...new Set(
      (recording.relations ?? [])
        .filter((relation) => relation.type === 'performance' && relation.work?.id)
        .map((relation) => relation.work!.id!),
    ),
  ].slice(0, 2)

  const works: MbWork[] = []
  for (const workId of workIds) {
    const work = await mbJson<MbWork>(`https://musicbrainz.org/ws/2/work/${workId}?inc=artist-rels+work-rels+label-rels&fmt=json`)
    if (!work) continue
    works.push(work)
    for (const relation of work.relations ?? []) {
      const id = relation.artist?.id
      const name = relation.artist?.name
      const role = roleLabel(relation.type ?? '', relation.attributes ?? [])
      if (!id || !name || !role) continue
      addRole(people, id, name, role)
    }
  }
  return works
}

function collectCredits(recording: MbRecording, requestedTitle: string, requestedArtist: string): SongCredits {
  const people = new Map<string, PersonCredit>()
  const billedIds = new Set<string>()
  for (const credit of recording['artist-credit'] ?? []) {
    const id = credit.artist?.id
    const name = credit.name || credit.artist?.name
    if (!id || !name) continue
    billedIds.add(id)
    addRole(people, id, name, billedIds.size === 1 ? 'performed' : 'featured')
  }

  const samples: SampleRef[] = []
  const sampledByIds = new Set<string>()
  for (const relation of recording.relations ?? []) {
    if (relation.type === 'samples material' && relation.recording?.id && relation.recording.title) {
      if (relation.direction === 'forward') {
        samples.push({
          recordingId: relation.recording.id,
          title: relation.recording.title,
          artist: artistNames(relation.recording['artist-credit']),
        })
      } else if (relation.direction === 'backward') {
        sampledByIds.add(relation.recording.id)
      }
      continue
    }
    const id = relation.artist?.id
    const name = relation.artist?.name
    const role = roleLabel(relation.type ?? '', relation.attributes ?? [])
    if (!id || !name || !role) continue
    addRole(people, id, name, role)
  }

  return {
    recordingId: recording.id,
    title: requestedTitle,
    artist: requestedArtist,
    people,
    billedIds,
    samples,
    sampledByIds,
  }
}

type ResolvedSong = {
  credits: SongCredits
  recording: MbRecording
  works: MbWork[]
}

type Graph = {
  adj: Map<string, GraphEdge[]>
  best: Map<string, number>
}

const creditCache = new Map<string, ResolvedSong | null>()
const MAX_ARTIST_FETCHES = 10
const BRIDGE_RECORDINGS_PER_PERSON = 10
const MAX_LINKS_PER_ARTIST = 60

function needsOn(role: string): boolean {
  return (
    role.startsWith('played') ||
    role.startsWith('sang') ||
    role === 'performed' ||
    role === 'engineered' ||
    role === 'mixed' ||
    role === 'remixed' ||
    role === 'conducted' ||
    role.startsWith('was musical director')
  )
}

function roleRank(role: string): number {
  if (role === 'wrote' || role === 'produced') return 0
  if (role.startsWith('sang') || role === 'performed') return 1
  if (role === 'arranged' || role === 'programmed' || role === 'recorded' || role === 'remixed' || role === 'conducted' || role.startsWith('was musical director')) return 2
  if (role.startsWith('played')) return 3
  if (role === 'engineered' || role === 'mixed') return 5
  return 6
}

function creditSummary(person: string, roles: string[], title: string, also: boolean): string {
  const general = roles.filter((role) => !needsOn(role))
  const specific = roles.filter((role) => needsOn(role))
  const parts: string[] = []
  if (general.length > 0) parts.push(`${joinAnd(general)} “${title}”`)
  if (specific.length > 0) parts.push(`${joinAnd(specific)} on “${title}”`)
  return `${also ? `${person} also` : person} ${joinAnd(parts)}.`
}

function createGraph(): Graph {
  return { adj: new Map(), best: new Map() }
}

function creditKind(role: string): string | null {
  if (role === 'wrote') return 'songwriter'
  if (role === 'produced') return 'producer'
  if (role === 'featured') return 'featured artist'
  if (role === 'performed' || role.startsWith('sang')) return 'performer'
  if (role === 'remixed') return 'remixer'
  return null
}

function addEdge(graph: Graph, from: string, to: string, summary: string, rank: number, meta: Partial<GraphEdge> = {}) {
  if (!from || !to || from === to || !summary) return
  const key = `${from}>${to}`
  const list = graph.adj.get(from) ?? []
  const index = list.findIndex((edge) => edge.to === to)
  const previous = graph.best.get(key)
  if (previous != null && previous < rank) return
  if (previous === rank && index >= 0) {
    const existing = list[index]
    if (!existing) return
    existing.roles = [...new Set([...(existing.roles ?? []), ...(meta.roles ?? [])])]
    if (!existing.sourceUrl && meta.sourceUrl) existing.sourceUrl = meta.sourceUrl
    return
  }
  graph.best.set(key, rank)
  if (index >= 0) list.splice(index, 1)
  list.push({ to, summary, rank, ...meta })
  graph.adj.set(from, list)
}

function linkCredit(graph: Graph, personId: string, personName: string, roles: Iterable<string>, recordingId: string, title: string) {
  const merged = mergeRoles(roles).filter((role) => creditKind(role))
  if (merged.length === 0) return
  const rank = roleRank(merged[0] ?? '')
  const sourceUrl = `https://musicbrainz.org/artist/${personId}`
  const meta = { roles: merged, personName, sourceUrl }
  addEdge(graph, `r:${recordingId}`, `a:${personId}`, creditSummary(personName, merged, title, false), rank, meta)
  addEdge(graph, `a:${personId}`, `r:${recordingId}`, creditSummary(personName, merged, title, true), rank, meta)
  songInfo.set(recordingId, { title, artist: songInfo.get(recordingId)?.artist ?? '', remix: songInfo.get(recordingId)?.remix ?? false })
}

function linkSamples(graph: Graph, fromId: string, fromTitle: string, toId: string, toTitle: string, sourceUrl?: string) {
  const summary = `“${fromTitle}” samples “${toTitle}”.`
  const meta = { kind: 'sample', sourceUrl }
  addEdge(graph, `r:${fromId}`, `r:${toId}`, summary, 10, meta)
  addEdge(graph, `r:${toId}`, `r:${fromId}`, summary, 10, meta)
}

function allowedRecordingKind(type: string): string | null {
  if (type === 'samples material') return 'sample'
  if (type === 'interpolation' || type === 'based on') return 'interpolation'
  if (type === 'cover') return 'cover'
  if (type === 'remix') return 'remix'
  return null
}

function recordingRank(type: string): number {
  if (type === 'samples material') return 10
  if (type === 'cover' || type === 'remix') return 20
  if (type === 'other version' || type === 'arrangement') return 25
  if (type === 'interpolation' || type === 'based on') return 30
  if (type === 'medley') return 40
  return 40
}

function recordingLink(subject: string, object: string, type: string, alreadyTitled = false): string {
  const left = alreadyTitled ? subject : `“${subject}”`
  const right = alreadyTitled ? object : `“${object}”`
  if (type === 'remix') return `${left} is a remix of ${right}.`
  if (type === 'cover') return `${left} covers ${right}.`
  if (type === 'interpolation') return `${left} interpolates ${right}.`
  if (type === 'based on') return `${left} is based on ${right}.`
  if (type === 'other version') return `${left} is another version of ${right}.`
  if (type === 'medley') return `${left} includes ${right} in a medley.`
  if (type === 'arrangement') return `${left} is an arrangement of ${right}.`
  return `${left} is connected to ${right} (${type}).`
}

function addPeople(graph: Graph, credits: SongCredits) {
  for (const person of credits.people.values()) {
    linkCredit(graph, person.id, person.name, person.roles, credits.recordingId, credits.title)
  }
}

function addNamedEdge(graph: Graph, from: string, to: string, summary: string, rank: number, meta: Partial<GraphEdge> = {}) {
  addEdge(graph, from, to, summary, rank, meta)
  addEdge(graph, to, from, summary, rank, meta)
}

function titled(title: string, artist?: string): string {
  return artist ? `“${title}” by ${artist}` : `“${title}”`
}

function addRecordingRelations(graph: Graph, recording: MbRecording, title: string, artist = '') {
  for (const relation of recording.relations ?? []) {
    const type = relation.type ?? ''
    const kind = allowedRecordingKind(type)
    if (kind && relation.direction === 'forward' && relation.recording?.id && relation.recording.title && !relation.recording.video) {
      const otherArtist = artistNames(relation.recording['artist-credit'])
      const summary = recordingLink(titled(title, artist), titled(relation.recording.title, otherArtist), type, true)
      const meta = { kind, sourceUrl: `https://musicbrainz.org/recording/${recording.id}` }
      addNamedEdge(graph, `r:${recording.id}`, `r:${relation.recording.id}`, summary, recordingRank(type), meta)
    }
  }
}

function compilationReleases(recording: MbRecording): { id: string; title: string }[] {
  const releases: { id: string; title: string }[] = []
  for (const release of recording.releases ?? []) {
    if (!release.id || !release.title) continue
    const primary = release['release-group']?.['primary-type']
    const secondary = release['release-group']?.['secondary-types'] ?? []
    if (primary === 'Compilation' || primary === 'Soundtrack' || secondary.includes('Compilation') || secondary.includes('Soundtrack')) {
      releases.push({ id: release.id, title: release.title })
    }
  }
  return releases
}

async function noteCompilations(left: ResolvedSong, right: ResolvedSong) {
  const rightIds = new Map(compilationReleases(right.recording).map((release) => [release.id, release.title]))
  for (const release of compilationReleases(left.recording)) {
    if (!rightIds.has(release.id)) continue
    await trace({ kind: 'discarded', title: release.title, detail: 'compilation or soundtrack' })
  }
}

function addWorks(graph: Graph, credits: SongCredits, works: MbWork[]) {
  for (const work of works) {
    if (!work.id) continue
    const workTitle = work.title || 'a composition'
    addNamedEdge(graph, `r:${credits.recordingId}`, `w:${work.id}`, `“${credits.title}” is a recording of “${workTitle}”.`, 25, {
      kind: 'cover',
      sourceUrl: `https://musicbrainz.org/work/${work.id}`,
    })
  }
}

async function noteDisallowed(recording: MbRecording, title: string, works: MbWork[]) {
  const reasons = new Set<string>()
  for (const relation of recording.relations ?? []) {
    const type = relation.type ?? ''
    if (relation.place?.id) reasons.add('studio')
    if (relation.label?.id) reasons.add('label or publisher')
    if (['engineer', 'mix', 'instrument', 'programming', 'arranger', 'instrument arranger'].includes(type)) reasons.add('engineer or session credit')
    if (['medley', 'mashes up', 'DJ-mix', 'music video'].includes(type)) reasons.add(type === 'mashes up' ? 'unofficial mashup' : type)
  }
  for (const work of works) {
    for (const relation of work.relations ?? []) {
      if (relation.type === 'publisher' || (relation.label?.id && /publish/i.test(relation.type ?? ''))) reasons.add('publisher')
    }
  }
  if (reasons.size === 0) return
  await trace({ kind: 'discarded', title, detail: `not an allowed link (${[...reasons].join(', ')})` })
}

async function addResolved(graph: Graph, song: ResolvedSong) {
  songInfo.set(song.credits.recordingId, {
    title: song.credits.title,
    artist: song.credits.artist,
    remix: /remix/i.test(song.recording.disambiguation ?? ''),
  })
  addPeople(graph, song.credits)
  addRecordingRelations(graph, song.recording, song.credits.title, song.credits.artist)
  addWorks(graph, song.credits, song.works)
  await noteDisallowed(song.recording, song.credits.title, song.works)
}

type FoundPath = { steps: string[]; nodes: string[]; links: number; maxRank: number; sumRank: number }
function shortestPath(graph: Graph, start: string, goal: string): FoundPath | null {
  if (start === goal) return { steps: [], nodes: [start], links: 0, maxRank: 0, sumRank: 0 }
  type Item = { node: string; links: number; maxRank: number; sumRank: number }
  const best = new Map<string, Item>()
  const prev = new Map<string, { node: string; summary: string }>()
  const queue: Item[] = [{ node: start, links: 0, maxRank: 0, sumRank: 0 }]
  best.set(start, queue[0]!)
  while (queue.length > 0) {
    queue.sort((a, b) => a.links - b.links || a.maxRank - b.maxRank || a.sumRank - b.sumRank)
    const current = queue.shift()
    if (!current) break
    const known = best.get(current.node)
    if (!known || current.links !== known.links || current.maxRank !== known.maxRank || current.sumRank !== known.sumRank) continue
    if (current.links > 12) continue
    for (const edge of graph.adj.get(current.node) ?? []) {
      const next = {
        node: edge.to,
        links: current.links + (edge.to.startsWith('r:') ? 1 : 0),
        maxRank: Math.max(current.maxRank, edge.rank),
        sumRank: current.sumRank + edge.rank,
      }
      const prior = best.get(edge.to)
      const worse = prior && (prior.links < next.links || (prior.links === next.links && (prior.maxRank < next.maxRank || (prior.maxRank === next.maxRank && prior.sumRank <= next.sumRank))))
      if (worse) continue
      best.set(edge.to, next)
      prev.set(edge.to, { node: current.node, summary: edge.summary })
      queue.push(next)
    }
  }
  if (!prev.has(goal)) return null
  const nodes: string[] = []
  const steps: string[] = []
  let node = goal
  while (node !== start) {
    const parent = prev.get(node)
    if (!parent) return null
    nodes.push(node)
    steps.push(parent.summary)
    node = parent.node
  }
  nodes.push(start)
  nodes.reverse()
  steps.reverse()
  const goalState = best.get(goal)
  return {
    steps: steps.map((summary) => summary.replace(/\s+/g, ' ').trim()).filter(Boolean),
    nodes,
    links: goalState?.links ?? nodes.filter((item) => item.startsWith('r:')).length - 1,
    maxRank: goalState?.maxRank ?? 0,
    sumRank: goalState?.sumRank ?? 0,
  }
}

function betterPath(current: FoundPath | null, next: FoundPath | null): FoundPath | null {
  if (!current) return next
  if (!next) return current
  if (current.links !== next.links) return current.links < next.links ? current : next
  if (current.maxRank !== next.maxRank) return current.maxRank < next.maxRank ? current : next
  return current.sumRank <= next.sumRank ? current : next
}

function endpointCover(graph: Graph, start: string, goal: string): FoundPath | null {
  const works = new Set((graph.adj.get(start) ?? []).filter((edge) => edge.to.startsWith('w:')).map((edge) => edge.to))
  const shared = (graph.adj.get(goal) ?? []).find((edge) => works.has(edge.to))
  if (!shared) return null
  return { steps: ['cover'], nodes: [start, goal], links: 1, maxRank: 25, sumRank: 25 }
}

function directMusical(graph: Graph, start: string, goal: string): FoundPath | null {
  const edge = (graph.adj.get(start) ?? []).find((item) => item.to === goal && ['sample', 'interpolation', 'cover', 'remix'].includes(item.kind ?? ''))
  if (!edge) return null
  return { steps: [edge.summary], nodes: [start, goal], links: 1, maxRank: edge.rank, sumRank: edge.rank }
}

async function expandArtist(graph: Graph, id: string, knownName?: string) {
  const follow = await startFollow(trace, { title: knownName || 'An artist', detail: 'following credits' })
  try {
  const artist = await mbJson<{ name?: string; relations?: MbRelation[] }>(
    `https://musicbrainz.org/ws/2/artist/${id}?inc=recording-rels+artist-rels+event-rels&fmt=json`,
  )
  if (!artist) return
  const name = artist.name || 'This artist'
  const recordingRels = (artist.relations ?? [])
    .filter((relation) => relation.recording?.id && relation.recording.title && roleLabel(relation.type ?? '', relation.attributes ?? []))
    .sort((a, b) => roleRank(roleLabel(a.type ?? '', a.attributes ?? []) ?? '') - roleRank(roleLabel(b.type ?? '', b.attributes ?? []) ?? ''))

  const seen = new Set<string>()
  const candidates: { song: BridgeSong; role: string }[] = []
  for (const relation of recordingRels) {
    const recording = relation.recording
    if (!recording?.id || !recording.title || isNoise(recording as MbRecording)) continue
    if (seen.has(recording.id)) continue
    seen.add(recording.id)
    const role = roleLabel(relation.type ?? '', relation.attributes ?? [])
    if (!role) continue
    candidates.push({ song: { id: recording.id, title: recording.title, roleRank: roleRank(role), releaseCount: 0 }, role })
  }
  bridgeCandidates.set(id, candidates.map((item) => item.song))
  for (const item of candidates.slice(0, MAX_LINKS_PER_ARTIST)) {
    linkCredit(graph, id, name, [item.role], item.song.id, item.song.title)
  }

  const disallowed = new Set<string>()
  for (const relation of artist.relations ?? []) {
    const otherId = relation.artist?.id
    const otherName = relation.artist?.name
    const relationType = relation.type
    if (!otherId || !otherName || !relationType) continue
    if (/url|image|social|catalog|isni|wikidata|discogs|allmusic|online data/i.test(relationType)) continue
    if (relationType === 'member of band') {
      const summary = relation.direction === 'backward' ? `${otherName} was a member of ${name}.` : `${name} was a member of ${otherName}.`
      addNamedEdge(graph, `a:${id}`, `a:${otherId}`, summary, 7, { kind: 'member', personName: name, sourceUrl: `https://musicbrainz.org/artist/${id}` })
      continue
    }
    disallowed.add(relationType === 'influenced by' ? 'influence' : relationType === 'tour' || relationType === 'supporting musician' ? 'tour or supporting appearance' : relationType)
  }
  if ((artist.relations ?? []).some((relation) => relation.event?.id)) disallowed.add('tour')
  if (disallowed.size > 0) await trace({ kind: 'discarded', title: name, detail: `not an allowed link (${[...disallowed].join(', ')})` })
  } finally {
    await follow.end()
  }
}

function peopleByPriority(credits: SongCredits): { id: string; name: string }[] {
  return [...credits.people.values()]
    .filter((person) => [...person.roles].some((role) => creditKind(role)))
    .sort((a, b) => roleRank(mergeRoles([...a.roles].filter((role) => creditKind(role)))[0] ?? '') - roleRank(mergeRoles([...b.roles].filter((role) => creditKind(role)))[0] ?? ''))
    .map((person) => ({ id: person.id, name: person.name }))
}

function interleave(left: { id: string; name: string }[], right: { id: string; name: string }[]): { id: string; name: string }[] {
  const people: { id: string; name: string }[] = []
  const seen = new Set<string>()
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    for (const person of [left[index], right[index]]) {
      if (!person || seen.has(person.id)) continue
      seen.add(person.id)
      people.push(person)
    }
  }
  return people
}

function personLabel(graph: Graph, personId: string): string {
  for (const edge of graph.adj.get(`a:${personId}`) ?? []) {
    if (edge.personName) return edge.personName
  }
  return 'An artist'
}

function recordingsForPerson(graph: Graph, personId: string): BridgeSong[] {
  const stored = bridgeCandidates.get(personId)
  if (stored) return stored
  const byId = new Map<string, BridgeSong>()
  for (const edge of graph.adj.get(`a:${personId}`) ?? []) {
    if (!edge.to.startsWith('r:')) continue
    const id = edge.to.slice(2)
    const title = songInfo.get(id)?.title || 'A recording'
    const existing = byId.get(id)
    if (existing && existing.roleRank <= edge.rank) continue
    byId.set(id, { id, title, roleRank: edge.rank, releaseCount: existing?.releaseCount ?? 0 })
  }
  return [...byId.values()]
}

async function deezerRanks(name: string): Promise<Map<string, number>> {
  const ranks = new Map<string, number>()
  try {
    const search = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    })
    if (!search.ok) return ranks
    const artists = (await search.json()) as { data?: { id: number; name: string; nb_fan?: number }[] }
    const artist = (artists.data ?? [])
      .filter((item) => normalize(item.name) === normalize(name))
      .sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0]
    if (!artist) return ranks
    const top = await fetch(`https://api.deezer.com/artist/${artist.id}/top?limit=50`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    })
    if (!top.ok) return ranks
    const tracks = (await top.json()) as { data?: { title?: string; rank?: number }[] }
    for (const track of tracks.data ?? []) {
      if (!track.title || typeof track.rank !== 'number') continue
      const key = normalize(track.title)
      ranks.set(key, Math.max(ranks.get(key) ?? 0, track.rank))
    }
  } catch {
    return ranks
  }
  return ranks
}

const CHART_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

function chartNumber(token: string): number | undefined {
  const word = CHART_WORDS[token.toLowerCase()]
  if (word) return word
  const value = Number(token)
  return value >= 1 && value <= 100 ? value : undefined
}

function passageAt(text: string, index: number, title: string): string {
  const start = Math.max(0, index - 40)
  let end = Math.min(text.length, index + title.length + 360)
  const other = /"([^"]{1,80})"/.exec(text.slice(index + title.length, end))
  if (other && other[1].toLowerCase() !== title.toLowerCase()) end = index + title.length + other.index
  return text.slice(start, end)
}

function chartNear(text: string, title: string): { peak?: number; weeks?: number; hit: boolean; charted: boolean } {
  const lower = text.toLowerCase()
  const needle = title.toLowerCase()
  let best: { peak?: number; weeks?: number; hit: boolean; charted: boolean } = { hit: false, charted: false }
  let from = 0
  while (from < lower.length) {
    const index = lower.indexOf(needle, from)
    if (index < 0) break
    from = index + needle.length
    const before = lower[index - 1]
    const after = lower[index + needle.length]
    if ((before && /[a-z0-9]/i.test(before)) || (after && /[a-z0-9]/i.test(after))) continue
    const passage = passageAt(text, index, title)
    if (/\bhit\b/i.test(passage)) best.hit = true
    const charted = /(?:on|entered|spent|peaked|reached)[\s\S]{0,80}Hot 100|Hot 100[\s\S]{0,40}(?:for|chart)/i.test(passage)
    if (!charted) continue
    best.charted = true
    let peak: number | undefined
    if (/peaked the\s+[\s\S]{0,40}Hot 100/i.test(passage)) peak = 1
    const numbered = passage.match(/(?:peaked at|reached|peak of|number|no\.|#)\s*#?\s*(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i)
    const parsed = numbered ? chartNumber(numbered[1]) : undefined
    if (parsed && (peak == null || parsed < peak)) peak = parsed
    const weeks = [...passage.matchAll(/(\d{1,3})\s+(?:consecutive\s+)?weeks/gi)].reduce((max, match) => Math.max(max, Number(match[1])), 0)
    if (peak == null) continue
    if (best.peak == null || peak < best.peak || (peak === best.peak && weeks > (best.weeks ?? 0))) {
      best = { peak, weeks: weeks || undefined, hit: best.hit, charted: true }
    }
  }
  return best
}

async function wikipediaCharts(name: string): Promise<string> {
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?${new URLSearchParams({ action: 'query', list: 'search', srsearch: name, srlimit: '3', format: 'json' })}`
    const search = await fetch(searchUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) })
    if (!search.ok) return ''
    const found = (await search.json()) as { query?: { search?: { title: string }[] } }
    const title = (found.query?.search ?? []).find((item) => normalize(item.title).includes(normalize(name)))?.title ?? found.query?.search?.[0]?.title
    if (!title) return ''
    const pageUrl = `https://en.wikipedia.org/w/api.php?${new URLSearchParams({ action: 'parse', page: title, prop: 'wikitext', format: 'json', redirects: '1' })}`
    const page = await fetch(pageUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) })
    if (!page.ok) return ''
    const body = (await page.json()) as { parse?: { wikitext?: { '*'?: string } } }
    return (body.parse?.wikitext?.['*'] ?? '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
  } catch {
    return ''
  }
}

function popularityNote(song: { peak?: number; weeks?: number; charted?: boolean; deezerRank?: number; wikiHit?: boolean }): string {
  if (song.peak != null) return `Hot 100 peak ${song.peak}${song.weeks ? `, ${song.weeks} weeks` : ''}`
  if (song.charted) return `Hot 100 chart entry${song.weeks ? `, ${song.weeks} weeks` : ''}`
  if (song.deezerRank != null) return `Deezer rank ${song.deezerRank}`
  if (song.wikiHit) return 'described as a hit'
  return 'no chart position, role ranking'
}

async function selectBridgeRecordings(personName: string, songs: BridgeSong[]): Promise<(BridgeSong & { peak?: number; weeks?: number; charted?: boolean; deezerRank?: number; wikiHit?: boolean })[]> {
  const [ranks, text] = await Promise.all([deezerRanks(personName), wikipediaCharts(personName)])
  const ranked = songs.map((song) => {
    const chart = text ? chartNear(text, song.title) : { hit: false, charted: false, peak: undefined, weeks: undefined }
    return {
      ...song,
      peak: chart.peak,
      weeks: chart.weeks,
      charted: chart.charted,
      deezerRank: ranks.get(normalize(song.title)),
      wikiHit: chart.hit,
    }
  })
  ranked.sort((a, b) => {
    const aPeak = a.peak != null
    const bPeak = b.peak != null
    if (aPeak !== bPeak) return aPeak ? -1 : 1
    if (a.peak != null && b.peak != null && a.peak !== b.peak) return a.peak - b.peak
    if (aPeak && bPeak && (a.weeks ?? 0) !== (b.weeks ?? 0)) return (b.weeks ?? 0) - (a.weeks ?? 0)
    if (Boolean(a.charted) !== Boolean(b.charted)) return a.charted ? -1 : 1
    if (a.charted && b.charted && (a.weeks ?? 0) !== (b.weeks ?? 0)) return (b.weeks ?? 0) - (a.weeks ?? 0)
    const aDeezer = a.deezerRank != null
    const bDeezer = b.deezerRank != null
    if (aDeezer !== bDeezer) return aDeezer ? -1 : 1
    if (a.deezerRank != null && b.deezerRank != null && a.deezerRank !== b.deezerRank) return b.deezerRank - a.deezerRank
    if (a.wikiHit !== b.wikiHit) return a.wikiHit ? -1 : 1
    if (a.roleRank !== b.roleRank) return a.roleRank - b.roleRank
    return b.releaseCount - a.releaseCount
  })
  return ranked
}

async function expandBridge(graph: Graph, start: string, goal: string, expanded: Set<string>): Promise<FoundPath | null> {
  const opened = new Set([start.slice(2), goal.slice(2)])
  let found: FoundPath | null = null
  for (const personId of expanded) {
    if (musicBrainzBusy || found) break
    const personName = personLabel(graph, personId)
    const seenTitles = new Set<string>()
    const unique: BridgeSong[] = []
    for (const song of recordingsForPerson(graph, personId).sort((a, b) => a.roleRank - b.roleRank || b.releaseCount - a.releaseCount)) {
      if (opened.has(song.id)) continue
      const key = normalize(song.title)
      if (seenTitles.has(key)) continue
      seenTitles.add(key)
      unique.push(song)
    }
    if (unique.length === 0) continue
    const ranked = await selectBridgeRecordings(personName, unique)
    const chosen = ranked.slice(0, BRIDGE_RECORDINGS_PER_PERSON)
    if (ranked.length > chosen.length) {
      await trace({ kind: 'discarded', title: personName, detail: `${ranked.length - chosen.length} less popular songs were not opened` })
    }
    for (const song of chosen) {
      if (musicBrainzBusy) break
      opened.add(song.id)
      const recording = await loadRecording(song.id)
      if (!recording) {
        await trace({ kind: 'discarded', title: song.title, detail: 'not expanded' })
        continue
      }
      const label = songLabel(recording, recording.title ?? song.title, '')
      await trace({ kind: 'found', title: label.title, artist: label.artist || undefined, detail: `MusicBrainz · examined recording · ${popularityNote(song)}` })
      const credits = collectCredits(recording, recording.title ?? song.title, artistNames(recording['artist-credit']))
      const works = await loadWorks(recording, credits.people)
      await addResolved(graph, { credits, recording, works })
    }
    found = shortestPath(graph, start, goal)
  }
  return found
}

async function resolveSong(title: string, artist: string): Promise<ResolvedSong | null> {
  const key = `${normalize(title)}|${normalize(artist)}`
  if (creditCache.has(key)) {
    const cached = creditCache.get(key) ?? null
    if (cached) await trace({ kind: 'found', title, artist, detail: 'MusicBrainz · selected recording' })
    return cached
  }
  const recording = await chooseRecording(title, artist)
  if (!recording) {
    if (!musicBrainzBusy) creditCache.set(key, null)
    return null
  }
  const credits = collectCredits(recording, title, artist)
  const works = await loadWorks(recording, credits.people)
  const resolved = { credits, recording, works }
  creditCache.set(key, resolved)
  return resolved
}

function billedPeople(credits: SongCredits): { id: string; name: string }[] {
  return [...credits.billedIds].flatMap((id) => {
    const person = credits.people.get(id)
    return person ? [{ id: person.id, name: person.name }] : []
  })
}

function songLabelFor(id: string): string {
  const info = songInfo.get(id)
  if (!info) return 'a recording'
  return info.artist ? `“${info.title}” by ${info.artist}` : `“${info.title}”`
}

function displayRoles(roles: string[]): string {
  const labels = roles.map((role) => creditKind(role)).filter((role): role is string => Boolean(role))
  return joinAnd([...new Set(labels)])
}

function peopleOn(graph: Graph, recordingId: string) {
  return (graph.adj.get(`r:${recordingId}`) ?? []).flatMap((edge) => {
    if (!edge.to.startsWith('a:') || !edge.personName) return []
    return [{ id: edge.to.slice(2), name: edge.personName, roles: edge.roles ?? [], sourceUrl: edge.sourceUrl }]
  })
}

function formatPair(graph: Graph, leftId: string, rightId: string): SongConnection & { remix: boolean; sources: ChainSource[] } {
  const left = songLabelFor(leftId)
  const right = songLabelFor(rightId)
  const sources: ChainSource[] = [
    { label: `MusicBrainz: ${songInfo.get(leftId)?.title ?? 'recording'}`, url: `https://musicbrainz.org/recording/${leftId}` },
    { label: `MusicBrainz: ${songInfo.get(rightId)?.title ?? 'recording'}`, url: `https://musicbrainz.org/recording/${rightId}` },
  ]
  const direct = (graph.adj.get(`r:${leftId}`) ?? []).find((edge) => edge.to === `r:${rightId}` && ['sample', 'interpolation', 'cover', 'remix'].includes(edge.kind ?? ''))
  const remix = Boolean(songInfo.get(leftId)?.remix || songInfo.get(rightId)?.remix || direct?.kind === 'remix')
  if (direct?.sourceUrl) sources.push({ label: 'MusicBrainz relationship', url: direct.sourceUrl })
  if (direct?.kind === 'sample') return { emphasis: 'Sample', summary: `${left} officially samples ${right}.`, remix, sources }
  if (direct?.kind === 'interpolation') return { emphasis: 'Interpolation', summary: `${left} officially interpolates ${right}.`, remix, sources }
  if (direct?.kind === 'remix') return { emphasis: 'Official remix', summary: `${left} is an official remix of ${right}.`, remix: true, sources }
  if (direct?.kind === 'cover') return { emphasis: 'Cover', summary: `${left} is a recording of the composition recorded as ${right}.`, remix, sources }

  const works = new Set((graph.adj.get(`r:${leftId}`) ?? []).filter((edge) => edge.to.startsWith('w:')).map((edge) => edge.to))
  const sharedWork = (graph.adj.get(`r:${rightId}`) ?? []).find((edge) => works.has(edge.to))
  if (sharedWork?.sourceUrl) {
    sources.push({ label: 'MusicBrainz work', url: sharedWork.sourceUrl })
    return { emphasis: 'Cover', summary: `${left} and ${right} are recordings of the same composition.`, remix, sources }
  }

  const leftPeople = peopleOn(graph, leftId)
  const rightPeople = peopleOn(graph, rightId)
  const shared = leftPeople.find((person) => rightPeople.some((other) => other.id === person.id))
  const otherSide = shared ? rightPeople.find((person) => person.id === shared.id) : undefined
  if (shared && otherSide) {
    if (shared.sourceUrl) sources.push({ label: `MusicBrainz: ${shared.name}`, url: shared.sourceUrl })
    return {
      emphasis: shared.name,
      summary: `${displayRoles(shared.roles)} on ${left}, and ${displayRoles(otherSide.roles)} on ${right}.`,
      remix,
      sources,
    }
  }
  const membershipBetween = (bandId: string, memberId: string) =>
    (graph.adj.get(`a:${bandId}`) ?? []).find((edge) => edge.to === `a:${memberId}` && edge.kind === 'member')
    ?? (graph.adj.get(`a:${memberId}`) ?? []).find((edge) => edge.to === `a:${bandId}` && edge.kind === 'member')
  for (const [bandSong, memberSong, bandPeople, memberPeople] of [
    [left, right, leftPeople, rightPeople],
    [right, left, rightPeople, leftPeople],
  ] as const) {
    for (const band of bandPeople) {
      for (const member of memberPeople) {
        const membership = membershipBetween(band.id, member.id)
        if (!membership) continue
        if (member.sourceUrl) sources.push({ label: `MusicBrainz: ${member.name}`, url: member.sourceUrl })
        if (membership.sourceUrl && !sources.some((source) => source.url === membership.sourceUrl)) {
          sources.push({ label: `MusicBrainz: ${band.name}`, url: membership.sourceUrl })
        }
        return {
          emphasis: member.name,
          summary: `as a member of ${band.name}, ${displayRoles(band.roles)} on ${bandSong}, and ${displayRoles(member.roles)} on ${memberSong}.`,
          remix,
          sources,
        }
      }
    }
  }
  return { emphasis: 'Link', summary: `${left} and ${right} share a documented credit.`, remix, sources }
}

function recordingsIn(nodes: string[]): string[] {
  return nodes.filter((node) => node.startsWith('r:')).map((node) => node.slice(2))
}

function pairConnected(graph: Graph, leftId: string, rightId: string): boolean {
  if ((graph.adj.get(`r:${leftId}`) ?? []).some((edge) => edge.to === `r:${rightId}` && edge.kind)) return true
  const leftPeople = peopleOn(graph, leftId)
  const rightPeople = peopleOn(graph, rightId)
  if (rightPeople.some((person) => leftPeople.some((other) => other.id === person.id))) return true
  const linked = (bandId: string, memberId: string) =>
    (graph.adj.get(`a:${bandId}`) ?? []).some((edge) => edge.to === `a:${memberId}` && edge.kind === 'member')
    || (graph.adj.get(`a:${memberId}`) ?? []).some((edge) => edge.to === `a:${bandId}` && edge.kind === 'member')
  if (leftPeople.some((band) => rightPeople.some((member) => linked(band.id, member.id)))) return true
  const works = new Set((graph.adj.get(`r:${leftId}`) ?? []).filter((edge) => edge.to.startsWith('w:')).map((edge) => edge.to))
  return (graph.adj.get(`r:${rightId}`) ?? []).some((edge) => works.has(edge.to))
}

function shortenRecordings(graph: Graph, ids: string[]): string[] {
  let current = ids
  let changed = true
  while (changed) {
    changed = false
    for (let start = 0; start < current.length; start++) {
      for (let end = current.length - 1; end > start + 1; end--) {
        const left = current[start]
        const right = current[end]
        if (!left || !right || !pairConnected(graph, left, right)) continue
        current = [...current.slice(0, start + 1), ...current.slice(end)]
        changed = true
        break
      }
      if (changed) break
    }
  }
  return current
}

async function legalName(id: string): Promise<string | undefined> {
  const artist = await mbJson<{ name?: string; aliases?: { name?: string; type?: string }[] }>(`https://musicbrainz.org/ws/2/artist/${id}?inc=aliases&fmt=json`)
  const legal = artist?.aliases?.find((alias) => alias.type === 'Legal name' && alias.name)?.name
  if (!legal || legal === artist?.name) return undefined
  return legal
}

function withTrace(result: ConnectionsResult): ConnectionsResult {
  return { ...result, traceTrimmed: traceTrimmed > 0 ? traceTrimmed : undefined }
}

async function findConnectionsInner(left: ConnectionRequest, right: ConnectionRequest): Promise<ConnectionsResult> {
  musicBrainzBusy = false
  const unavailable: string[] = []
  const early = await findEarlyChain(left, right, trace)
  if (early && early.connections.length > 0) return withTrace(early)
  const [leftSong, rightSong] = await Promise.all([resolveSong(left.title, left.artist), resolveSong(right.title, right.artist)])
  if (!leftSong || !rightSong) {
    if (musicBrainzBusy) return withTrace({ connections: [], unavailable, notice: busyNotice() })
    if (!leftSong) unavailable.push(`${left.title} by ${left.artist}`)
    if (!rightSong) unavailable.push(`${right.title} by ${right.artist}`)
    return withTrace({ connections: [], unavailable })
  }

  const graph = createGraph()
  await addResolved(graph, leftSong)
  await addResolved(graph, rightSong)
  await noteCompilations(leftSong, rightSong)
  if (left.week && right.week && left.week === right.week) {
    await trace({ kind: 'discarded', title: `${left.title} and ${right.title}`, detail: 'shared chart week' })
  }
  if (leftSong.credits.sampledByIds.has(rightSong.credits.recordingId)) {
    linkSamples(graph, rightSong.credits.recordingId, rightSong.credits.title, leftSong.credits.recordingId, leftSong.credits.title)
  }
  if (rightSong.credits.sampledByIds.has(leftSong.credits.recordingId)) {
    linkSamples(graph, leftSong.credits.recordingId, leftSong.credits.title, rightSong.credits.recordingId, rightSong.credits.title)
  }

  const start = `r:${leftSong.credits.recordingId}`
  const goal = `r:${rightSong.credits.recordingId}`
  let found = shortestPath(graph, start, goal)
  const expanded = new Set<string>()
  if (!found) {
    let fetches = 0
    let skipped = 0
    for (const person of interleave(peopleByPriority(leftSong.credits), peopleByPriority(rightSong.credits))) {
      if (found || fetches >= MAX_ARTIST_FETCHES) {
        skipped++
        continue
      }
      if (musicBrainzBusy || expanded.has(person.id)) continue
      expanded.add(person.id)
      fetches++
      await expandArtist(graph, person.id, person.name)
      found = shortestPath(graph, start, goal)
    }
    if (skipped > 0) await trace({ kind: 'discarded', title: `${skipped} more people`, detail: 'not expanded' })
  }
  if (!found && !musicBrainzBusy) found = await expandBridge(graph, start, goal, expanded)
  if (!musicBrainzBusy) {
    const side = (song: ResolvedSong) => ({
      title: song.credits.title,
      artist: song.credits.artist,
      recordingId: song.credits.recordingId,
      billed: billedPeople(song.credits),
    })
    await addOutsideSources(
      side(leftSong),
      side(rightSong),
      (from, to, summary, rank, meta) => addEdge(graph, from, to, summary, rank, meta),
      trace,
      !found || found.links > 1,
    )
    found = directMusical(graph, start, goal) ?? endpointCover(graph, start, goal) ?? betterPath(found, shortestPath(graph, start, goal))
  }
  found = directMusical(graph, start, goal) ?? endpointCover(graph, start, goal) ?? found

  const recordingIds = shortenRecordings(graph, recordingsIn(found?.nodes ?? []))
  const formatted = []
  for (let index = 0; index < recordingIds.length - 1; index++) {
    const leftId = recordingIds[index]
    const rightId = recordingIds[index + 1]
    if (!leftId || !rightId) continue
    formatted.push(formatPair(graph, leftId, rightId))
  }
  const connections = formatted.map(({ emphasis, summary }) => ({ emphasis, summary })).filter((step) => step.summary)
  const sources = [...new Map(formatted.flatMap((step) => step.sources).map((source) => [source.url, source])).values()]
  const caveats: string[] = []
  if (formatted.some((step) => step.remix)) caveats.push('A step uses an official remix. Some people will not count that as the same song.')
  if (connections.length > 1) caveats.push('Billboard Hot 100 status for intermediate songs was not confirmed, so their chart status is unknown.')
  const personIds = [...new Set(formatted.flatMap((step) => step.sources).map((source) => source.url.match(/artist\/([0-9a-f-]{36})/i)?.[1]).filter((id): id is string => Boolean(id)))]
  for (const id of personIds.slice(0, 4)) {
    const legal = await legalName(id)
    if (!legal) continue
    caveats.push(`MusicBrainz lists ${legal} as a legal name for this credit.`)
  }
  const hardest = connections.length > 6 ? `Hardest to bridge: ${recordingIds.slice(1, -1).map((id) => songLabelFor(id)).join('; ') || 'the middle songs'}.` : undefined
  const count = connections.length
  const headline = count === 0 ? undefined : count > 6 ? `No chain of 6 or fewer links was found. The shortest verified chain has ${count} links.` : `${count} ${count === 1 ? 'link' : 'links'}.`
  return withTrace({
    connections,
    unavailable,
    notice: connections.length === 0 ? busyNotice() : undefined,
    headline,
    sources,
    caveats,
    hardest,
  })
}

let lookupChain: Promise<void> = Promise.resolve()

export function findConnections(
  left: ConnectionRequest,
  right: ConnectionRequest,
  onTrace?: (event: TraceEvent) => Promise<void> | void,
): Promise<ConnectionsResult> {
  const run = lookupChain.then(async () => {
    emitTrace = onTrace ?? null
    traceCount = 0
    traceTrimmed = 0
    songInfo.clear()
    bridgeCandidates.clear()
    try {
      return await findConnectionsInner(left, right)
    } finally {
      emitTrace = null
    }
  })
  lookupChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
