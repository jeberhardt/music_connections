import type { TraceEvent } from '../src/types.ts'
import { startFollow } from './follow.ts'

type Role = 'songwriter' | 'producer' | 'performer' | 'featured artist'
type Trace = (event: TraceEvent) => Promise<void> | void

type Credit = {
  person: string
  page?: string
  role: Role
  source: string
  url: string
  priority: number
}

type SongRec = {
  title: string
  artist: string
  credits: Credit[]
  cover?: { title: string; artist: string; source: string; url: string }
}

type MemberLink = { member: string; group: string; page?: string; source: string; url: string }
type AliasLink = { alias: string; person: string; source: string; url: string }

export type EarlyChain = {
  connections: { summary: string; emphasis?: string }[]
  unavailable: string[]
  headline?: string
  sources?: { label: string; url: string }[]
  caveats?: string[]
  hardest?: string
}

const WIKI_API = 'https://en.wikipedia.org/w/api.php'
const APP_UA = 'music-connections/0.1 (local development)'
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const ROLE_ORDER: Role[] = ['performer', 'featured artist', 'songwriter', 'producer']
const wikiCache = new Map<string, { title: string; wikitext: string }>()

function norm(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function primary(artist: string): string {
  return artist.split(/\s+(?:feat\.?|featuring|ft\.?|with|x|&)\s+/i)[0]?.trim() || artist
}

function songKey(title: string, artist: string): string {
  return `${norm(title)}|${norm(primary(artist))}`
}

function joinAnd(items: string[]): string {
  const unique = [...new Set(items.filter(Boolean))]
  if (unique.length <= 1) return unique[0] ?? ''
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`
  return `${unique.slice(0, -1).join(', ')}, and ${unique.at(-1)}`
}

function cleanWiki(value: string): string {
  return value
    .replace(/\{\{nowrap\|([^{}|]+)\}\}/gi, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[\s\S]*?<\/ref>/gi, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/''+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function wikiLinks(value: string): { page: string; name: string }[] {
  return [...value.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)].map((match) => ({
    page: match[1]!.replace(/_/g, ' ').trim(),
    name: cleanWiki(match[2] || match[1]!).replace(/ \([^)]*\)$/, '').trim(),
  })).filter((link) => link.name)
}

export function namesIn(value: string): { page?: string; name: string }[] {
  const hlist = [...value.matchAll(/\{\{(?:hlist|ubl|unbulleted list)\|([\s\S]*?)\}\}/gi)]
  if (hlist.length > 0) {
    return hlist.flatMap((match) => namesIn(match[1]!.replace(/\|/g, '\n')))
  }
  const links = wikiLinks(value)
  if (links.length > 0) return links.map((link) => ({ page: link.page, name: link.name }))
  return value
    .split(/\n|\*/)
    .flatMap((part) => part.split(/,| and /i))
    .map((part) => cleanWiki(part))
    .filter((name) => name.length > 1 && !/^[\d\s:.-]+$/.test(name))
    .map((name) => ({ name }))
}

function sameSong(title: string, artist: string, otherTitle: string, otherArtist: string): boolean {
  if (norm(title) !== norm(otherTitle)) return false
  const left = norm(primary(artist))
  const right = norm(primary(otherArtist))
  if (!left || !right) return false
  return left === right || left.startsWith(`${right} `) || right.startsWith(`${left} `)
}

async function getText(url: string, headers: Record<string, string>): Promise<{ status: number; text: string } | null> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(12000) })
    return { status: response.status, text: await response.text() }
  } catch {
    return null
  }
}

export function wikiUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
}

function topParts(template: string): string[] {
  const inner = template.slice(2, -2)
  const parts: string[] = []
  let current = ''
  let braces = 0
  let brackets = 0
  for (let index = 0; index < inner.length; index++) {
    const pair = inner.slice(index, index + 2)
    if (pair === '{{') braces++
    else if (pair === '}}' && braces > 0) braces--
    else if (pair === '[[') brackets++
    else if (pair === ']]' && brackets > 0) brackets--
    if (inner[index] === '|' && braces === 0 && brackets === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += inner[index]
  }
  if (current.trim()) parts.push(current)
  return parts
}

export function extractTemplate(wikitext: string, name: RegExp): string | null {
  const start = wikitext.search(name)
  if (start < 0) return null
  let depth = 0
  for (let index = start; index < wikitext.length - 1; index++) {
    if (wikitext.startsWith('{{', index)) {
      depth++
      index++
      continue
    }
    if (wikitext.startsWith('}}', index)) {
      depth--
      index++
      if (depth === 0) return wikitext.slice(start, index + 1)
    }
  }
  return null
}

export function fieldMap(template: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const part of topParts(template).slice(1)) {
    const match = part.match(/^\s*([^=]+?)\s*=\s*([\s\S]*)$/)
    if (!match) continue
    fields.set(match[1]!.trim().toLowerCase(), match[2]!.trim())
  }
  return fields
}

function quotedAlias(display: string): { name: string; alias?: string } {
  const match = display.match(/^(.*?)"([^"]+)"(.*)$/)
  if (!match) return { name: display.replace(/ \([^)]*\)$/, '').trim() }
  return { name: `${match[1]} ${match[3]}`.replace(/\s+/g, ' ').trim(), alias: match[2] }
}

export async function findEarlyChain(
  left: { title: string; artist: string },
  right: { title: string; artist: string },
  onTrace: Trace,
): Promise<EarlyChain | null> {
  try {
    return await search(left, right, onTrace)
  } catch {
    return null
  }
}

async function search(
  left: { title: string; artist: string },
  right: { title: string; artist: string },
  onTrace: Trace,
): Promise<EarlyChain | null> {
  const songs = new Map<string, SongRec>()
  const members: MemberLink[] = []
  const aliases: AliasLink[] = []
  const opened = new Set<string>()
  let shazamDown = false
  const pages: { title: string; wikitext: string }[] = []

  const ensure = (title: string, artist: string): SongRec => {
    const key = songKey(title, artist)
    const existing = songs.get(key)
    if (existing) return existing
    const created = { title, artist: primary(artist), credits: [] }
    songs.set(key, created)
    return created
  }

  const addCredit = (song: SongRec, credit: Credit) => {
    const person = credit.person.replace(/ \([^)]*\)$/, '').trim()
    if (!person) return
    const duplicate = song.credits.some((item) => norm(item.person) === norm(person) && item.role === credit.role && item.source === credit.source)
    if (duplicate) return
    song.credits.push({ ...credit, person })
  }

  const activeCredits = (song: SongRec): Credit[] => {
    const official = new Set(
      song.credits.filter((credit) => credit.priority === 0 && (credit.role === 'songwriter' || credit.role === 'producer')).map((credit) => credit.role),
    )
    return song.credits.filter((credit) => credit.priority === 0 || !official.has(credit.role))
  }

  const wikiPage = async (title: string) => {
    const cached = wikiCache.get(norm(title)) ?? pages.find((page) => norm(page.title) === norm(title))
    if (cached) return cached
    const url = `${WIKI_API}?${new URLSearchParams({ action: 'parse', page: title, prop: 'wikitext', format: 'json', redirects: '1' })}`
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await getText(url, { 'User-Agent': APP_UA, Accept: 'application/json' })
      if (!response || response.status === 429 || response.status === 503) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)))
        continue
      }
      if (response.status !== 200) return null
      const data = JSON.parse(response.text) as { parse?: { title?: string; wikitext?: { '*'?: string } }; error?: { code?: string } }
      if (!data.parse?.wikitext?.['*']) return null
      const page = { title: data.parse.title || title, wikitext: data.parse.wikitext['*'] }
      pages.push(page)
      wikiCache.set(norm(page.title), page)
      wikiCache.set(norm(title), page)
      return page
    }
    return null
  }

  const wikiSearch = async (query: string) => {
    const url = `${WIKI_API}?${new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: '5', format: 'json' })}`
    const response = await getText(url, { 'User-Agent': APP_UA, Accept: 'application/json' })
    if (!response || response.status !== 200) return []
    const data = JSON.parse(response.text) as { query?: { search?: { title: string }[] } }
    return data.query?.search?.map((item) => item.title) ?? []
  }

  const readSongPage = (page: { title: string; wikitext: string }, requestedTitle: string, requestedArtist: string) => {
    const infobox = extractTemplate(page.wikitext, /\{\{Infobox song\b/i)
    const fields = infobox ? fieldMap(infobox) : new Map<string, string>()
    const artistLink = wikiLinks(fields.get('artist') || '')[0]
    const artist = artistLink?.name || requestedArtist
    const title = cleanWiki(fields.get('name') || '') || requestedTitle
    if (norm(title) !== norm(requestedTitle) && !norm(page.title).includes(norm(requestedTitle))) return null
    const song = ensure(title, artist)
    const url = wikiUrl(page.title)
    const note = (role: Role, people: { name: string; page?: string }[]) => {
      for (const person of people) addCredit(song, { person: person.name, page: person.page, role, source: 'Wikipedia', url, priority: 1 })
    }
    note('performer', namesIn(fields.get('artist') || ''))
    note('songwriter', namesIn(`${fields.get('writer') || ''}\n${fields.get('writer_links') || ''}`))
    note('producer', namesIn(fields.get('producer') || ''))
    const lead = page.wikitext.split('\n==')[0] ?? ''
    const written = lead.match(/written by ([\s\S]{0,400}?)\.(?!\d)/i)
    const produced = lead.match(/(?:produced by|production was handled by) ([\s\S]{0,300}?)\.(?!\d)/i)
    if (written) note('songwriter', namesIn(written[1]!))
    if (produced) note('producer', namesIn(produced[1]!))
    const cover = lead.match(/cover of \[\[([^\]|]+)(?:\|([^\]]+))?\]\][\s\S]{0,240}?recorded by \[\[([^\]|]+)(?:\|([^\]]+))?\]\]/i)
    if (cover) {
      song.cover = {
        title: cleanWiki(cover[1]!).replace(/ \([^)]*\)$/, ''),
        artist: cleanWiki(cover[4] || cover[3]!),
        source: 'Wikipedia',
        url,
      }
      ensure(song.cover.title, song.cover.artist)
    }
    const named = [...song.credits.reduce((map, credit) => map.set(credit.role, [...(map.get(credit.role) ?? []), credit.person]), new Map<Role, string[]>())]
    return { song, summary: named.map(([role, people]) => `${role} ${joinAnd(people)}`).join('; '), thin: !song.credits.some((credit) => credit.role === 'songwriter' || credit.role === 'producer') , album: wikiLinks(fields.get('album') || '')[0]?.page }
  }

  const loadWikipediaSong = async (title: string, artist: string) => {
    const follow = await startFollow(onTrace, { title, artist, detail: 'checking Wikipedia' })
    let read: ReturnType<typeof readSongPage> = null
    try {
      const hits = await wikiSearch(`${title} ${artist}`)
      const chosen = hits.find((hit) => norm(hit).includes(norm(title))) ?? hits[0]
      if (!chosen) return null
      const page = await wikiPage(chosen)
      if (!page) return null
      read = readSongPage(page, title, artist)
      if (!read) return null
      if (read.summary) await onTrace({ kind: 'found', title: read.song.title, artist: read.song.artist, detail: `Wikipedia · ${read.summary}` })
    } finally {
      await follow.end()
    }
    if (read?.thin && read.album) {
      const albumFollow = await startFollow(onTrace, { title: read.album, detail: 'checking Wikipedia album page' })
      try {
        const album = await wikiPage(read.album)
        if (album) readAlbumTracks(album, read.song.title)
      } finally {
        await albumFollow.end()
      }
    }
    return read?.song ?? null
  }

  const readAlbumTracks = (page: { title: string; wikitext: string }, onlyTitle?: string) => {
    const infobox = extractTemplate(page.wikitext, /\{\{Infobox album\b|\{\{Track listing\b/i)
    const tracklist = extractTemplate(page.wikitext, /\{\{Track listing\b/i) ?? (page.wikitext.includes('title1') ? page.wikitext : '')
    const fields = fieldMap(extractTemplate(tracklist || page.wikitext, /\{\{Track listing\b/i) ?? (infobox ?? ''))
    const artist = wikiLinks(fieldMap(extractTemplate(page.wikitext, /\{\{Infobox album\b/i) ?? '').get('artist') || '')[0]?.name
    if (!artist) return
    const producerColumn = /producer/i.test(fields.get('extra_column') || '')
    for (let index = 1; index <= 30; index++) {
      const title = cleanWiki(fields.get(`title${index}`) || '')
      if (!title) continue
      if (onlyTitle && norm(title) !== norm(onlyTitle)) continue
      const song = ensure(title, artist)
      const url = wikiUrl(page.title)
      for (const person of namesIn(fields.get(`writer${index}`) || '')) {
        addCredit(song, { person: person.name, page: person.page, role: 'songwriter', source: 'Wikipedia', url, priority: 1 })
      }
      if (producerColumn) {
        for (const person of namesIn(fields.get(`extra${index}`) || '')) {
          addCredit(song, { person: person.name, page: person.page, role: 'producer', source: 'Wikipedia', url, priority: 1 })
        }
      }
      addCredit(song, { person: artist, role: 'performer', source: 'Wikipedia', url, priority: 1 })
    }
  }

  const deezerCredits = async (title: string, artist: string, trackId?: number) => {
    const follow = await startFollow(onTrace, { title, artist, detail: 'checking Deezer' })
    try {
    let id = trackId
    if (!id) {
      const search = await getText(`https://api.deezer.com/search?q=${encodeURIComponent(`${title} ${artist}`)}`, { 'User-Agent': APP_UA, Accept: 'application/json' })
      if (!search || search.status !== 200) return
      const data = JSON.parse(search.text) as { data?: { id: number; title: string; artist?: { name?: string }; album?: { title?: string } }[] }
      const hit = (data.data ?? []).find((item) => sameSong(title, artist, item.title, item.artist?.name ?? ''))
      id = hit?.id
    }
    if (!id) return
    const page = await getText(`https://www.deezer.com/en/track/${id}`, { 'User-Agent': BROWSER_UA, Accept: 'text/html' })
    const raw = page?.text.match(/"SNG_CONTRIBUTORS":(\{.*?\})/)?.[1]
    if (!page || !raw) return
    let contributors: Record<string, string[]>
    try {
      contributors = JSON.parse(raw) as Record<string, string[]>
    } catch {
      return
    }
    const song = ensure(title, artist)
    const url = `https://www.deezer.com/track/${id}`
    const roleFor = (key: string): Role | null => {
      if (key === 'composer' || key === 'author') return 'songwriter'
      if (key === 'producer') return 'producer'
      if (key === 'main_artist') return 'performer'
      if (key === 'featured' || key === 'feature') return 'featured artist'
      return null
    }
    const used: string[] = []
    const skipped = new Set<string>()
    for (const [key, names] of Object.entries(contributors)) {
      const role = roleFor(key)
      if (!role) {
        if (/engineer|mix|master/i.test(key)) skipped.add('engineer or session credit')
        continue
      }
      for (const name of names) addCredit(song, { person: name, role, source: 'Deezer', url, priority: 0 })
      used.push(`${role} ${joinAnd(names)}`)
    }
    if (used.length > 0) await onTrace({ kind: 'found', title: song.title, artist: song.artist, detail: `Deezer · ${[...new Set(used)].join('; ')}` })
    if (skipped.size > 0) await onTrace({ kind: 'discarded', title: song.title, artist: song.artist, detail: `Deezer · ${[...skipped].join(', ')}` })
    } finally {
      await follow.end()
    }
  }

  const billboardCredits = async (title: string, artist: string) => {
    const follow = await startFollow(onTrace, { title, artist, detail: 'checking Billboard' })
    try {
    const query = `site:billboard.com "${title}" "${artist}" (written OR produced OR songwriter)`
    const search = await getText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { 'User-Agent': BROWSER_UA, Accept: 'text/html' })
    const link = [...(search?.text.matchAll(/uddg=([^&"]+)/g) ?? [])].map((match) => decodeURIComponent(match[1]!)).find((item) => item.includes('billboard.com') && !/tour|festival|award/i.test(item))
    if (!link) {
      await onTrace({ kind: 'discarded', title, artist, detail: 'Billboard page had no songwriter or producer credit' })
      return
    }
    const article = await getText(link, { 'User-Agent': BROWSER_UA, Accept: 'text/html' })
    const text = (article?.text ?? '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    const song = ensure(title, artist)
    let found = false
    for (const sentence of text.split(/(?<=\.)\s+/)) {
      if (!norm(sentence).includes(norm(title))) continue
      const written = sentence.match(/written by ([^.]+)/i)
      const produced = sentence.match(/produced by ([^.]+)/i)
      if (written) {
        for (const name of namesIn(written[1]!).slice(0, 8)) addCredit(song, { person: name.name, role: 'songwriter', source: 'Billboard', url: link, priority: 0 })
        found = true
      }
      if (produced) {
        for (const name of namesIn(produced[1]!).slice(0, 6)) addCredit(song, { person: name.name, role: 'producer', source: 'Billboard', url: link, priority: 0 })
        found = true
      }
    }
    if (found) await onTrace({ kind: 'found', title, artist, detail: 'Billboard · printed songwriter or producer credit' })
    else await onTrace({ kind: 'discarded', title, artist, detail: 'Billboard page had no songwriter or producer credit' })
    } finally {
      await follow.end()
    }
  }

  const shazamCredits = async (title: string, artist: string) => {
    if (shazamDown) return
    const follow = await startFollow(onTrace, { title, artist, detail: 'checking Shazam' })
    try {
    const response = await getText(`https://www.shazam.com/services/search/v4/en-US/US/web/search?term=${encodeURIComponent(`${title} ${artist}`)}&limit=5`, {
      'User-Agent': BROWSER_UA,
      Accept: 'application/json,text/html',
    })
    if (!response || response.status === 405 || response.status >= 400) {
      shazamDown = true
      await onTrace({ kind: 'discarded', title, artist, detail: 'Shazam was not available' })
      return
    }
    const blocks = [...response.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => match[1]!)
    if (blocks.length === 0 && !/"composer"|"producer"/i.test(response.text)) {
      await onTrace({ kind: 'discarded', title, artist, detail: 'Shazam page had no credits' })
    }
    } finally {
      await follow.end()
    }
  }

  const pressCredits = async (title: string, artist: string) => {
    const song = songs.get(songKey(title, artist))
    const hasWriter = song?.credits.some((credit) => credit.role === 'songwriter')
    const hasProducer = song?.credits.some((credit) => credit.role === 'producer')
    if (hasWriter && hasProducer) {
      await onTrace({ kind: 'following', title, artist, detail: 'press already covered by an earlier credit' })
      return
    }
    const follow = await startFollow(onTrace, { title, artist, detail: 'checking press' })
    try {
    const query = `"${title}" "${artist}" ("written by" OR "produced by" OR songwriter) -site:wikipedia.org -site:musicbrainz.org -site:whosampled.com`
    const search = await getText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { 'User-Agent': BROWSER_UA, Accept: 'text/html' })
    const link = [...(search?.text.matchAll(/uddg=([^&"]+)/g) ?? [])].map((match) => decodeURIComponent(match[1]!)).find((item) => /^https?:/i.test(item) && !/wikipedia|musicbrainz|whosampled|duckduckgo/i.test(item))
    if (!link) return
    const article = await getText(link, { 'User-Agent': BROWSER_UA, Accept: 'text/html' })
    const text = (article?.text ?? '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    const target = song ?? ensure(title, artist)
    let found = false
    for (const sentence of text.split(/(?<=\.)\s+/)) {
      if (!norm(sentence).includes(norm(title))) continue
      const written = sentence.match(/written by ([^.]+)/i)
      const produced = sentence.match(/produced by ([^.]+)/i)
      if (written) {
        for (const name of namesIn(written[1]!).slice(0, 8)) addCredit(target, { person: name.name, role: 'songwriter', source: 'press', url: link, priority: 0 })
        found = true
      }
      if (produced) {
        for (const name of namesIn(produced[1]!).slice(0, 6)) addCredit(target, { person: name.name, role: 'producer', source: 'press', url: link, priority: 0 })
        found = true
      }
    }
    if (found) await onTrace({ kind: 'found', title, artist, detail: 'press · stated credit' })
    } finally {
      await follow.end()
    }
  }

  const rememberAlias = (alias: string | undefined, person: string, source: string, url: string) => {
    if (!alias || norm(alias) === norm(person)) return
    aliases.push({ alias, person, source, url })
    void onTrace({ kind: 'found', title: person, detail: `${source} · ${alias} is a name for ${person}` })
  }

  const rememberMembers = (group: string, people: { name: string; page?: string; alias?: string }[], source: string, url: string) => {
    for (const person of people) {
      if (!person.name || norm(person.name) === norm(group)) continue
      members.push({ member: person.name, group, page: person.page, source, url })
      rememberAlias(person.alias, person.name, source, url)
      queuePerson(person.name, person.page)
    }
  }

  const readPersonPage = (page: { title: string; wikitext: string }) => {
    const infobox = extractTemplate(page.wikitext, /\{\{Infobox (?:musical artist|person|band|musical group)\b/i)
    const fields = infobox ? fieldMap(infobox) : new Map<string, string>()
    const subject = cleanWiki(fields.get('name') || '') || page.title.replace(/ \([^)]*\)$/, '')
    const url = wikiUrl(page.title)
    for (const alias of namesIn(fields.get('alias') || fields.get('aliases') || '')) rememberAlias(alias.name, subject, 'Wikipedia', url)
    const memberField = `${fields.get('members') || ''}\n${fields.get('past_members') || ''}\n${fields.get('current_members') || ''}`
    const memberPeople = wikiLinks(memberField).map((link) => ({ ...quotedAlias(link.name), page: link.page }))
    rememberMembers(subject, memberPeople, 'Wikipedia', url)
    const composed = page.wikitext.match(/composed of ([\s\S]{0,240}?)\./i)
    if (composed) rememberMembers(subject, wikiLinks(composed[1]!).map((link) => ({ ...quotedAlias(link.name), page: link.page })), 'Wikipedia', url)
    const lead = page.wikitext.match(/lead vocalist (?:for|of) the [\s\S]{0,160}?band \[\[([^\]|]+)(?:\|([^\]]+))?\]\]/i)
    if (lead) members.push({ member: subject, group: cleanWiki(lead[2] || lead[1]!), source: 'Wikipedia', url })
    const performed = page.wikitext.match(/performed and wrote[\s\S]{0,900}?\./i)
    if (performed && lead) {
      for (const link of wikiLinks(performed[0])) {
        const song = ensure(link.name, cleanWiki(lead[2] || lead[1]!))
        addCredit(song, { person: subject, page: page.title, role: 'performer', source: 'Wikipedia', url, priority: 1 })
        addCredit(song, { person: subject, page: page.title, role: 'songwriter', source: 'Wikipedia', url, priority: 1 })
      }
      void onTrace({ kind: 'found', title: subject, detail: `Wikipedia · performer and songwriter for ${cleanWiki(lead[2] || lead[1]!)}` })
    }
    let listed = 0
    for (const line of page.wikitext.split('\n')) {
      if (!line.startsWith('*') || listed > 60) continue
      const roleMatch = line.match(/\((writer|co-writer|songwriter|producer|vocalist|vocals|performer)\)\s*$/i)
      if (!roleMatch) continue
      const role: Role = /produc/i.test(roleMatch[1]!) ? 'producer' : /vocal|perform/i.test(roleMatch[1]!) ? 'performer' : 'songwriter'
      const artistLink = wikiLinks(line)[0]
      const songLink = line.match(/"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]"/)
      const plain = line.match(/"([^"\[][^"]*)"/)
      const songTitle = cleanWiki(songLink?.[2] || songLink?.[1] || plain?.[1] || '').replace(/ \([^)]*\)$/, '')
      if (!artistLink || !songTitle) continue
      const song = ensure(songTitle, artistLink.name)
      addCredit(song, { person: subject, page: page.title, role, source: 'Wikipedia', url, priority: 1 })
      addCredit(song, { person: artistLink.name, page: artistLink.page, role: 'performer', source: 'Wikipedia', url, priority: 1 })
      listed++
    }
    if (listed > 0) void onTrace({ kind: 'found', title: subject, detail: `Wikipedia · ${listed} stated song credits` })
  }

  const buildAdj = () => {
    const adj = new Map<string, { to: string; cost: number }[]>()
    const add = (from: string, to: string, cost: number) => {
      const list = adj.get(from) ?? []
      if (!list.some((edge) => edge.to === to && edge.cost === cost)) list.push({ to, cost })
      adj.set(from, list)
    }
    const personId = (name: string) => {
      const alias = aliases.find((item) => norm(item.alias) === norm(name))
      return `p:${norm(alias?.person ?? name)}`
    }
    for (const [key, song] of songs) {
      const songId = `s:${key}`
      for (const credit of activeCredits(song)) {
        const person = personId(credit.person)
        add(songId, person, 0)
        add(person, songId, 1)
      }
      if (song.cover) {
        const other = [...songs.entries()].find(([, item]) => sameSong(song.cover!.title, song.cover!.artist, item.title, item.artist))
        if (other) {
          add(songId, `s:${other[0]}`, 1)
          add(`s:${other[0]}`, songId, 1)
        }
      }
    }
    for (const member of members) {
      add(personId(member.member), personId(member.group), 0)
      add(personId(member.group), personId(member.member), 0)
    }
    return { adj, personId }
  }

  const shortest = (startKey: string, goalKey: string, directCover: boolean) => {
    const { adj } = buildAdj()
    const start = `s:${startKey}`
    const goal = `s:${goalKey}`
    if (directCover && (adj.get(start) ?? []).some((edge) => edge.to === goal)) return [start, goal]
    const dist = new Map<string, number>([[start, 0]])
    const prev = new Map<string, string>()
    const queue = [start]
    while (queue.length > 0) {
      queue.sort((a, b) => (dist.get(a) ?? 0) - (dist.get(b) ?? 0))
      const node = queue.shift()
      if (!node || node === goal) break
      for (const edge of adj.get(node) ?? []) {
        const next = (dist.get(node) ?? 0) + edge.cost
        if (next >= (dist.get(edge.to) ?? Infinity)) continue
        dist.set(edge.to, next)
        prev.set(edge.to, node)
        queue.push(edge.to)
      }
    }
    if (!prev.has(goal) && start !== goal) return null
    const nodes = [goal]
    let cursor = goal
    while (cursor !== start) {
      const parent = prev.get(cursor)
      if (!parent) return null
      nodes.push(parent)
      cursor = parent
    }
    return nodes.reverse()
  }

  const displayPerson = (name: string) => aliases.find((item) => norm(item.alias) === norm(name))?.person ?? name

  const format = (nodes: string[]): EarlyChain | null => {
    const songNodes = nodes.filter((node) => node.startsWith('s:'))
    const records = songNodes.map((node) => songs.get(node.slice(2))).filter((song): song is SongRec => Boolean(song))
    if (records.length < 2) return null
    const steps: { emphasis?: string; summary: string; sources: { label: string; url: string }[]; remix: boolean }[] = []
    for (let index = 0; index < records.length - 1; index++) {
      const from = records[index]!
      const to = records[index + 1]!
      const fromPos = nodes.indexOf(`s:${songKey(from.title, from.artist)}`)
      const toPos = nodes.indexOf(`s:${songKey(to.title, to.artist)}`, fromPos + 1)
      const between = nodes.slice(fromPos + 1, toPos).filter((node) => node.startsWith('p:')).map((node) => node.slice(2))
      if (from.cover && sameSong(from.cover.title, from.cover.artist, to.title, to.artist)) {
        steps.push({
          emphasis: 'Cover',
          summary: `“${from.title}” by ${from.artist} is a cover of “${to.title}” by ${to.artist}.`,
          sources: [{ label: `${from.cover.source}: ${from.title}`, url: from.cover.url }],
          remix: false,
        })
        continue
      }
      const teamOn = (song: SongRec, key: string) => members.find((item) => norm(displayPerson(item.member)) === key && rolesOn(song, norm(displayPerson(item.group))).length > 0)
      const sideText = (song: SongRec, key: string) => {
        const roles = rolesOn(song, key)
        const group = teamOn(song, key)
        const alias = aliases.find((item) => norm(item.person) === key)
        if (group) {
          const teamRoles = rolesOn(song, norm(displayPerson(group.group)))
          const own = roles.filter((role) => !teamRoles.includes(role))
          const throughTeam = `as a member of ${group.group}, ${joinAnd(teamRoles)} on “${song.title}” by ${song.artist}`
          return own.length > 0 ? `${joinAnd(own)} on “${song.title}” by ${song.artist}, and ${throughTeam}` : throughTeam
        }
        if (roles.length === 0) return ''
        const via = alias ? ` as ${alias.alias}` : ''
        return `${joinAnd(roles)} on “${song.title}” by ${song.artist}${via}`
      }
      const personKey = between.find((key) => rolesOn(from, key).length > 0 && rolesOn(to, key).length > 0) ?? between.find((key) => sideText(from, key) && sideText(to, key)) ?? between[0]
      if (!personKey) continue
      const name = [...from.credits, ...to.credits, ...members.map((item) => ({ person: item.member }))].find((item) => norm(displayPerson(item.person)) === personKey)?.person ?? personKey
      const shown = displayPerson(name)
      const leftText = sideText(from, personKey)
      const rightText = sideText(to, personKey)
      if (!leftText || !rightText) continue
      const sources = [
        ...creditsFor(from, personKey).map((credit) => ({ label: `${credit.source}: ${from.title}`, url: credit.url })),
        ...creditsFor(to, personKey).map((credit) => ({ label: `${credit.source}: ${to.title}`, url: credit.url })),
      ]
      for (const song of [from, to]) {
        const group = teamOn(song, personKey)
        if (!group) continue
        for (const credit of creditsFor(song, norm(displayPerson(group.group)))) {
          if (!sources.some((source) => source.url === credit.url)) sources.push({ label: `${credit.source}: ${song.title}`, url: credit.url })
        }
        if (!sources.some((source) => source.url === group.url)) sources.push({ label: `${group.source}: ${group.group}`, url: group.url })
      }
      steps.push({
        emphasis: shown,
        summary: `${leftText}${leftText && rightText ? ', and ' : ''}${rightText}.`.replace(/\s+/g, ' '),
        sources,
        remix: false,
      })
    }
    const connections = steps.filter((step) => step.summary.length > 2).map(({ emphasis, summary }) => ({ emphasis, summary }))
    if (connections.length === 0) return null
    const sources = [...new Map(steps.flatMap((step) => step.sources).map((source) => [source.url, source])).values()]
    const count = connections.length
    const caveats = count > 1 ? ['Billboard Hot 100 status for intermediate songs was not confirmed, so their chart status is unknown.'] : []
    return {
      connections,
      unavailable: [],
      headline: count > 6 ? `No chain of 6 or fewer links was found. The shortest verified chain has ${count} links.` : `${count} ${count === 1 ? 'link' : 'links'}.`,
      sources,
      caveats,
      hardest: count > 6 ? `Hardest to bridge: ${records.slice(1, -1).map((song) => `“${song.title}” by ${song.artist}`).join('; ')}.` : undefined,
    }
  }

  const rolesOn = (song: SongRec, personKey: string) => {
    const roles = activeCredits(song).filter((credit) => norm(displayPerson(credit.person)) === personKey).map((credit) => credit.role)
    return ROLE_ORDER.filter((role) => roles.includes(role))
  }

  const creditsFor = (song: SongRec, personKey: string) => {
    const matching = activeCredits(song).filter((credit) => norm(displayPerson(credit.person)) === personKey)
    const best = new Map<string, Credit>()
    for (const credit of matching.sort((a, b) => a.priority - b.priority)) {
      if (!best.has(credit.role)) best.set(credit.role, credit)
    }
    return [...best.values()]
  }

  await loadWikipediaSong(left.title, left.artist)
  await loadWikipediaSong(right.title, right.artist)
  for (const side of [left, right]) {
    await billboardCredits(side.title, side.artist)
    await deezerCredits(side.title, side.artist)
    await shazamCredits(side.title, side.artist)
    await pressCredits(side.title, side.artist)
  }

  const endpoints = [songKey(left.title, left.artist), songKey(right.title, right.artist)]
  const openQueue: { name: string; page?: string }[] = []
  const seenPeople = new Set<string>()
  const queuePerson = (name: string, page?: string, first = false) => {
    const key = norm(page || name)
    if (!key || seenPeople.has(key)) return
    seenPeople.add(key)
    if (first) openQueue.unshift({ name, page })
    else openQueue.push({ name, page })
  }
  for (const song of songs.values()) {
    for (const credit of song.credits) {
      if (credit.role === 'producer' || credit.role === 'songwriter') queuePerson(credit.person, credit.page, credit.role === 'producer')
    }
  }

  let openedCount = 0
  while (openQueue.length > 0 && openedCount < 10) {
    const person = openQueue.shift()
    if (!person) break
    if (person.page && opened.has(norm(person.page))) continue
    const follow = await startFollow(onTrace, { title: person.name, detail: 'checking Wikipedia' })
    try {
    const title = person.page || (await wikiSearch(`${person.name} songwriter`)).find((hit) => norm(hit).includes(norm(person.name)))
    if (!title || opened.has(norm(title))) continue
    opened.add(norm(title))
    const page = await wikiPage(title)
    if (!page) {
      await onTrace({ kind: 'discarded', title: person.name, detail: 'Wikipedia page was not loaded' })
      continue
    }
    openedCount++
    const membersBefore = members.length
    readPersonPage(page)
    if (members.length > membersBefore) {
      await onTrace({ kind: 'found', title: page.title, detail: `Wikipedia · ${members.length - membersBefore} membership links` })
    }
    for (const member of members) queuePerson(member.member, member.page, true)
    } finally {
      await follow.end()
    }
    const path = shortest(endpoints[0]!, endpoints[1]!, true)
    if (path && format(path)) break
  }

  let path = shortest(endpoints[0]!, endpoints[1]!, true)
  if (path) {
    const records = path.filter((node) => node.startsWith('s:')).map((node) => songs.get(node.slice(2))).filter((song): song is SongRec => Boolean(song))
    for (const song of records) {
      if (song.credits.some((credit) => credit.source === 'Deezer')) continue
      if (sameSong(song.title, song.artist, left.title, left.artist) || sameSong(song.title, song.artist, right.title, right.artist)) continue
      await deezerCredits(song.title, song.artist)
    }
    path = shortest(endpoints[0]!, endpoints[1]!, true)
  }

  if (!path) {
    const hub = [...songs.values()].flatMap((song) => activeCredits(song)).find((credit) => credit.role === 'songwriter' || credit.role === 'producer')
    if (hub) await expandDeezerAlbum(hub.person, ensure, addCredit, onTrace, () => shortest(endpoints[0]!, endpoints[1]!, true) != null)
    path = shortest(endpoints[0]!, endpoints[1]!, true)
  }

  const leftSong = [...songs.values()].find((song) => sameSong(song.title, song.artist, left.title, left.artist))
  const rightSong = [...songs.values()].find((song) => sameSong(song.title, song.artist, right.title, right.artist))
  if (!path || !leftSong || !rightSong) return null
  return format(path)
}

async function expandDeezerAlbum(
  person: string,
  ensure: (title: string, artist: string) => SongRec,
  addCredit: (song: SongRec, credit: Credit) => void,
  onTrace: Trace,
  done: () => boolean,
) {
  const follow = await startFollow(onTrace, { title: person, detail: 'checking Deezer albums' })
  try {
  const search = await getTextPublic(`https://api.deezer.com/search/artist?q=${encodeURIComponent(person)}`)
  if (!search) return
  const data = JSON.parse(search) as { data?: { id: number; name: string; nb_fan?: number }[] }
  const artist = (data.data ?? []).filter((item) => norm(item.name) === norm(person)).sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0]
  if (!artist) return
  const albums = await getTextPublic(`https://api.deezer.com/artist/${artist.id}/albums?limit=5`)
  if (!albums) return
  const list = JSON.parse(albums) as { data?: { id: number; title: string; release_date?: string }[] }
  const album = (list.data ?? []).slice().sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''))[0]
  if (!album) return
  const albumJson = await getTextPublic(`https://api.deezer.com/album/${album.id}`)
  if (!albumJson) return
  const tracks = (JSON.parse(albumJson) as { tracks?: { data?: { id: number; title: string }[] } }).tracks?.data ?? []
  for (const track of tracks.slice(0, 12)) {
    if (done()) return
    const page = await getText(`https://www.deezer.com/en/track/${track.id}`, { 'User-Agent': BROWSER_UA, Accept: 'text/html' })
    const raw = page?.text.match(/"SNG_CONTRIBUTORS":(\{.*?\})/)?.[1]
    if (!raw) continue
    const contributors = JSON.parse(raw) as Record<string, string[]>
    const song = ensure(track.title, person)
    const url = `https://www.deezer.com/track/${track.id}`
    for (const name of contributors.composer ?? contributors.author ?? []) addCredit(song, { person: name, role: 'songwriter', source: 'Deezer', url, priority: 0 })
    for (const name of contributors.producer ?? []) addCredit(song, { person: name, role: 'producer', source: 'Deezer', url, priority: 0 })
    for (const name of contributors.main_artist ?? [person]) addCredit(song, { person: name, role: 'performer', source: 'Deezer', url, priority: 0 })
    await onTrace({ kind: 'found', title: track.title, artist: person, detail: 'Deezer · album track credits' })
  }
  } finally {
    await follow.end()
  }
}

async function getTextPublic(url: string): Promise<string | null> {
  const response = await getText(url, { 'User-Agent': APP_UA, Accept: 'application/json' })
  if (!response || response.status !== 200) return null
  return response.text
}
