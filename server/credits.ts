import type { ChainSource, CreditRole, CreditsResponse, RelatedSong, SongCredit } from '../src/types.ts'
import { extractCredits, type CreditSource } from './creditsClaude.ts'
import { extractTemplate, fieldMap, namesIn, wikiUrl } from './early.ts'

const WIKI_API = 'https://en.wikipedia.org/w/api.php'
const APP_UA = 'music-connections/0.1 (local development)'
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const MB_UA = 'music-connections/0.1 (local development)'
const ROLE_ORDER: CreditRole[] = ['performer', 'featured artist', 'songwriter', 'producer', 'musician']
const MIN_INTERVAL_MS = 1100

type RawCredit = {
  person: string
  role: CreditRole
  source: string
  url: string
  priority: number
  order: number
}

type MbCredit = { name?: string; joinphrase?: string; artist?: { id?: string; name?: string } }
type MbRelation = {
  type?: string
  attributes?: string[]
  artist?: { id?: string; name?: string }
  work?: { id?: string; title?: string }
}
type MbRecording = {
  id: string
  title?: string
  score?: number
  video?: boolean
  length?: number
  disambiguation?: string
  relations?: MbRelation[]
  'artist-credit'?: MbCredit[]
}

let mbQueue: Promise<void> = Promise.resolve()
let mbNextSlot = 0
const nameAliases: { stage: string; legal: string }[] = []

function norm(value: string): string {
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

function personName(name: string): string {
  return name.replace(/ \([^)]*\)$/, '').replace(/\s+/g, ' ').trim()
}

function usableName(name: string): boolean {
  if (name.length < 2) return false
  return !/^(various artists|various|unknown|n\/a|none|see below|not documented|uncredited)$/i.test(name)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getText(url: string, headers: Record<string, string>): Promise<{ status: number; text: string } | null> {
  // Wikipedia answers parallel lookups with 429s, which used to drop whole sections of credits.
  const attempts = 3
  for (let attempt = 0; attempt < attempts; attempt++) {
    const last = attempt === attempts - 1
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(12000) })
      if (!last && (response.status === 429 || response.status >= 500)) {
        const retryAfter = Number(response.headers.get('retry-after'))
        await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt, 5000))
        continue
      }
      return { status: response.status, text: await response.text() }
    } catch {
      if (!last) await sleep(1000 * 2 ** attempt)
    }
  }
  return null
}

function addRaw(credits: RawCredit[], credit: Omit<RawCredit, 'order'>) {
  let person = personName(credit.person)
  const nickname = person.match(/^(\S.*?)\s+["“]([^"”]+)["”]\s+(\S.*)$/)
  if (nickname) {
    rememberAlias(nickname[2]!, `${nickname[1]} ${nickname[3]}`)
    person = nickname[2]!
  }
  if (!usableName(person)) return
  const duplicate = credits.some((item) => norm(item.person) === norm(person) && item.role === credit.role && item.source === credit.source)
  if (duplicate) return
  credits.push({ ...credit, person, order: credits.length })
}

function splitPipes(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let braces = 0
  let brackets = 0
  for (let index = 0; index < value.length; index++) {
    const pair = value.slice(index, index + 2)
    if (pair === '{{') braces++
    else if (pair === '}}' && braces > 0) braces--
    else if (pair === '[[') brackets++
    else if (pair === ']]' && brackets > 0) brackets--
    if (value[index] === '|' && braces === 0 && brackets === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += value[index]
  }
  if (current.trim()) parts.push(current)
  return parts
}

function rememberAlias(stage: string, legal: string) {
  if (!stage || !legal || norm(stage) === norm(legal)) return
  if (nameAliases.some((alias) => norm(alias.stage) === norm(stage) && norm(alias.legal) === norm(legal))) return
  nameAliases.push({ stage, legal })
}

function linkedPersonName(link: { page?: string; name: string }): string {
  const display = personName(link.name)
  const page = link.page?.replace(/_/g, ' ').trim() ?? ''
  const pageBase = personName(page.replace(/ \([^)]*\)$/, ''))
  if (!pageBase || norm(pageBase) === norm(display)) return display
  if (/\([^)]*(?:song|album|single|film|band|group|entertainer|singer|rapper)[^)]*\)/i.test(page)) return display
  rememberAlias(pageBase, display)
  return pageBase
}

function namesMatch(a: string, b: string): boolean {
  if (samePerson(a, b)) return true
  return nameAliases.some((alias) => {
    const pair = [norm(alias.stage), norm(alias.legal)]
    return pair.includes(norm(a)) && pair.includes(norm(b))
  })
}

function sameIdentity(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true
  const left = nameTokens(a)
  const right = nameTokens(b)
  if (left.length !== right.length || left.length === 0) return false
  return left.every((token, index) => {
    const other = right[index] ?? ''
    if (token === other) return true
    const short = token.length <= other.length ? token : other
    const long = token.length <= other.length ? other : token
    return short.length === 1 && long.startsWith(short)
  })
}

const NOT_A_PERSON = /\b(?:records|recordings|music group|entertainment)\b|\((?:record label|music|genre|album|song|single)\)/i

function stripNotes(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[\s\S]*?<\/ref>/gi, '')
}

/** Splits a list of names on commas, "and", "&", bullets and line breaks that sit outside links and templates. */
function splitNameList(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  for (let index = 0; index < value.length; index++) {
    const pair = value.slice(index, index + 2)
    if (pair === '{{' || pair === '[[') depth++
    else if ((pair === '}}' || pair === ']]') && depth > 0) depth--
    if (depth === 0) {
      const separator = value.slice(index).match(/^(?:,|;|\n|\*|\s+and\s+|\s+&\s+)/i)
      if (separator) {
        parts.push(current)
        current = ''
        index += separator[0].length - 1
        continue
      }
    }
    current += value[index]
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

function creditPeople(value: string): string[] {
  const stripped = stripNotes(value).replace(/<br\s*\/?>/gi, '\n').replace(/\(\s*\[\[[^\]]+\]\]\s*\)/g, '')
  const lists = [...stripped.matchAll(/\{\{(?:hlist|ubl|unbulleted list)\|([\s\S]*?)\}\}/gi)]
  const source = lists.length > 0 ? lists.flatMap((match) => splitPipes(match[1] ?? '')) : [stripped]
  const names = source
    .flatMap((part) => splitNameList(part))
    .flatMap((part) => namesIn(part))
    .filter((person) => !NOT_A_PERSON.test(person.page ?? ''))
    .map((person) => linkedPersonName(person))
  return [...new Set(names.map((name) => personName(name)).filter(usableName))]
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }

/** Resolves "the former three", "the latter", "himself" and similar back-references in a lead sentence. */
function backReference(part: string, earlier: string[], performers: string[]): string[] | null {
  const text = plainText(part).toLowerCase()
  if (/^(?:him|her|them)sel(?:f|ves)$/.test(text)) return performers
  const counted = text.match(/^(?:the\s+)?(?:aforementioned\s+)?(former|first|latter|last)(?:\s+(\w+))?$/)
  if (counted) {
    const count = NUMBER_WORDS[counted[2] ?? ''] ?? (Number(counted[2]) || 1)
    return /former|first/.test(counted[1]!) ? earlier.slice(0, count) : earlier.slice(-count)
  }
  if (/^(?:all\s+\w+|all of them|the same \w+|the trio|the duo|the pair)$/.test(text.replace(/^the\s+(?=all)/, ''))) return earlier
  return null
}

const NAME_PATTERN = /^(?:the\s+)?\p{Lu}[\p{L}\p{N}.'’-]*(?:\s+(?:\p{Lu}|de |van |von |la |del )[\p{L}\p{N}.'’-]*){0,3}$/u
const PROSE_STOP = /\b(?:released|recorded|issued|engineered|mixed|mastered|on|in|at|for|from|during|which|who|whom|as|its|it|album|label|single|track)\b/i

/** Names in one "written by ..." clause, stopping at the first segment that is not a name. */
function proseNames(clause: string, earlier: string[], known: string[]): string[] {
  const names: string[] = []
  const linked = /\[\[/.test(clause)
  for (const raw of splitNameList(clause)) {
    const part = raw.replace(/^(?:and|&)\s+/i, '').replace(/^by\s+/i, '').trim()
    if (!part) continue
    const back = backReference(part, earlier.length > 0 ? earlier : names, known)
    if (back) {
      names.push(...back)
      continue
    }
    if (/\[\[/.test(part)) {
      const outside = plainText(part.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\([^)]*\)/g, ' '))
      if (PROSE_STOP.test(outside) || outside.split(/\s+/).filter(Boolean).length > 4) break
      names.push(...creditPeople(part))
      continue
    }
    const name = plainText(part).replace(/\([^)]*\)/g, '').trim()
    if (!NAME_PATTERN.test(name)) break
    const resolved = known.find((other) => samePerson(other, name))
    // Inside a linked list a plain word is a short reference ("Ronson"), so it has to resolve to someone already credited.
    if (resolved) names.push(resolved)
    else if (!linked) names.push(name)
  }
  return [...new Set(names)]
}

/** Credits stated in an article's lead, such as "It was written by X and Y, and produced by the former." */
function leadCredits(lead: string, credits: RawCredit[], url: string, roles: CreditRole[]) {
  const text = stripNotes(lead).replace(/\n+/g, ' ')
  const anchor = /\b(?:was|were|is|are|been|being)\s+(?:(?:co-?)?(written and produced|written|composed|produced))\s+by\s+|\bproduction was handled by\s+/gi
  const sentenceEnd = /(?<!\b(?:\p{Lu}|Jr|Sr|St|Dr|Mr|Mrs|Ms))\.(?!\d)|;|:|,?\s+while\s+|,\s+which\s+|\s+with\s+the\s+/u
  let writers: string[] = []
  for (const match of text.matchAll(anchor)) {
    const clause = text.slice((match.index ?? 0) + match[0].length).split(sentenceEnd)[0] ?? ''
    const known = credits.map((credit) => credit.person)
    const verb = (match[1] ?? 'produced').toLowerCase()
    const wanted: CreditRole[] = verb === 'written and produced' ? ['songwriter', 'producer'] : /produc/.test(verb) ? ['producer'] : ['songwriter']
    const names = proseNames(clause, writers, known)
    if (wanted.includes('songwriter')) writers = names
    for (const role of wanted) {
      if (!roles.includes(role)) continue
      for (const person of names) addRaw(credits, { person, role, source: 'Wikipedia', url, priority: 1 })
    }
  }
}

function peopleIn(value: string): { performers: string[]; featured: string[] } {
  const parts = value.split(/\b(?:featuring|feat\.?|ft\.)\b/i)
  if (parts.length < 2) return { performers: creditPeople(value), featured: [] }
  return {
    performers: creditPeople(parts[0] ?? ''),
    featured: creditPeople(parts.slice(1).join(' ')),
  }
}

function hasRole(credits: RawCredit[], role: CreditRole): boolean {
  return credits.some((credit) => credit.role === role)
}

function nameTokens(name: string): string[] {
  return norm(name).split(' ').filter(Boolean)
}

function samePerson(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true
  const left = nameTokens(a)
  const right = nameTokens(b)
  if (left.length === 0 || right.length === 0) return false
  if (left.length === 1 && right.length > 1) return right.at(-1) === left[0]
  if (right.length === 1 && left.length > 1) return left.at(-1) === right[0]
  if (left.length >= 2 && left.length < right.length && left.every((token, index) => right[right.length - left.length + index] === token)) return true
  if (right.length >= 2 && right.length < left.length && right.every((token, index) => left[left.length - right.length + index] === token)) return true
  // A stage name followed by a surname, as in "Billie Eilish" and "Billie Eilish O'Connell".
  if (left.length >= 2 && left.length < right.length && left.every((token, index) => right[index] === token)) return true
  if (right.length >= 2 && right.length < left.length && right.every((token, index) => left[index] === token)) return true
  if (left.length !== right.length) return false
  return left.every((token, index) => {
    const other = right[index] ?? ''
    if (token === other) return true
    const short = token.length <= other.length ? token : other
    const long = token.length <= other.length ? other : token
    return short.length > 0 && short.length <= 2 && long.startsWith(short)
  })
}

function fullerName(names: string[]): string {
  return [...names].sort((a, b) => b.replace(/[^\p{L}\p{N}]/gu, '').length - a.replace(/[^\p{L}\p{N}]/gu, '').length)[0] ?? ''
}

function sourceLabel(source: string, url: string): string {
  if (source === 'Wikipedia') {
    const slug = decodeURIComponent(url.split('/wiki/')[1] ?? '').replace(/_/g, ' ')
    return slug ? `Wikipedia: ${slug}` : 'Wikipedia'
  }
  if (source === 'MusicBrainz') return 'MusicBrainz'
  return source
}

function present(credits: RawCredit[]): CreditsResponse {
  const grouped: RawCredit[][] = []
  for (const credit of credits) {
    const matches = grouped.filter((group) => group.some((item) => namesMatch(item.person, credit.person)))
    const cluster = matches.length === 1 ? matches[0] : undefined
    if (cluster) cluster.push(credit)
    else grouped.push([credit])
  }

  const songs: { credit: SongCredit; rank: number; order: number }[] = []
  for (const list of grouped) {
    const roles: CreditRole[] = []
    let order = list[0]?.order ?? 0
    for (const role of ROLE_ORDER) {
      const matches = list.filter((credit) => credit.role === role).sort((a, b) => a.priority - b.priority || a.order - b.order)
      const best = matches[0]
      if (!best) continue
      // A person sorts by where their top role was listed, so a band member who also wrote the song stays among the performers.
      if (roles.length === 0) order = best.order
      roles.push(role)
    }
    const uniqueNames = [...new Set(list.map((credit) => credit.person))]
    const mashups = uniqueNames.filter((name) =>
      uniqueNames.some((other) => other !== name && norm(name).startsWith(`${norm(other)} `) && nameTokens(name).length > nameTokens(other).length),
    )
    const pool = uniqueNames.filter((name) => !mashups.includes(name))
    const stage = nameAliases.find((alias) => pool.some((name) => norm(name) === norm(alias.stage) || norm(name) === norm(alias.legal)))
    const staged = stage ? pool.find((name) => norm(name) === norm(stage.stage)) : undefined
    const display = staged || fullerName(pool)
    if (roles.length === 0 || !display) continue
    songs.push({ credit: { person: display, roles }, rank: ROLE_ORDER.indexOf(roles[0]!), order })
  }
  songs.sort((a, b) => a.rank - b.rank || a.order - b.order)

  const sources: ChainSource[] = []
  for (const credit of credits) {
    if (!credit.url || sources.some((source) => source.url === credit.url)) continue
    sources.push({ label: sourceLabel(credit.source, credit.url), url: credit.url })
  }

  return {
    credits: songs.map((item) => item.credit),
    sources,
    notice: songs.length === 0 ? 'No major credits were found.' : undefined,
  }
}

async function wikiRaw(title: string, depth = 0): Promise<{ title: string; wikitext: string } | null> {
  if (depth > 2) return null
  const response = await getText(`${wikiUrl(title)}?action=raw`, { 'User-Agent': APP_UA })
  if (!response || response.status !== 200) return null
  const wikitext = response.text
  if (!wikitext || wikitext.startsWith('<!DOCTYPE') || wikitext.includes('<html')) return null
  const redirect = wikitext.match(/^#REDIRECT\s+\[\[([^\]|#]+)/i)
  if (redirect?.[1]) return wikiRaw(redirect[1].replace(/_/g, ' ').trim(), depth + 1)
  return { title, wikitext }
}

async function wikiPage(title: string): Promise<{ title: string; wikitext: string } | null> {
  const url = `${WIKI_API}?${new URLSearchParams({ action: 'parse', page: title, prop: 'wikitext', format: 'json', redirects: '1' })}`
  const response = await getText(url, { 'User-Agent': APP_UA, Accept: 'application/json' })
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
  const url = `${WIKI_API}?${new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: '5', format: 'json' })}`
  const response = await getText(url, { 'User-Agent': APP_UA, Accept: 'application/json' })
  if (response?.status === 200) {
    try {
      const data = JSON.parse(response.text) as { query?: { search?: { title: string }[] } }
      const hits = data.query?.search?.map((item) => item.title) ?? []
      if (hits.length > 0) return hits
    } catch {
      // Fall through to the public search page.
    }
  }

  const searchUrl = `https://en.wikipedia.org/w/index.php?${new URLSearchParams({ search: query, title: 'Special:Search', ns0: '1' })}`
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

function extractTemplates(wikitext: string, name: RegExp): string[] {
  const found: string[] = []
  let rest = wikitext
  while (rest.length > 0) {
    const template = extractTemplate(rest, name)
    if (!template) break
    found.push(template)
    const index = rest.indexOf(template)
    if (index < 0) break
    rest = rest.slice(index + template.length)
  }
  return found
}

function artistListed(field: string, artist: string): boolean {
  const names = namesIn(field).map((person) => norm(person.name))
  const wanted = norm(primaryArtist(artist))
  if (!wanted || names.length === 0) return false
  return names.some((name) => name.includes(wanted) || wanted.includes(name))
}

function songTitleMatches(fields: Map<string, string>, pageTitle: string, requestedTitle: string): boolean {
  const named = namesIn(fields.get('name') || '')[0]?.name
  if (named) return norm(named) === norm(requestedTitle)
  return norm(pageTitle).includes(norm(requestedTitle))
}

/** A composition article names this artist as a performer or as someone who covered the song. */
function pageMentionsArtist(wikitext: string, artist: string): boolean {
  const wanted = norm(primaryArtist(artist))
  if (wanted.length < 3) return false
  for (const match of wikitext.matchAll(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g)) {
    const pageName = (match[1] ?? '').replace(/_/g, ' ').replace(/ \([^)]*\)$/, '')
    const display = match[2] || pageName
    if (norm(pageName) === wanted || norm(display) === wanted) return true
  }
  const lead = wikitext.split('\n==')[0] ?? ''
  return norm(plainText(lead)).includes(wanted)
}

function readSongPage(page: { title: string; wikitext: string }, requestedTitle: string, requestedArtist: string, credits: RawCredit[]): { thin: boolean; album?: string } | null {
  const boxes = extractTemplates(page.wikitext, /\{\{Infobox song\b/i)
  const pageMatches = norm(page.title).includes(norm(requestedTitle))
  const fieldsFor = boxes.map((box) => fieldMap(box))
  const matching = fieldsFor.filter((fields) => {
    return songTitleMatches(fields, page.title, requestedTitle) && (artistListed(fields.get('artist') || '', requestedArtist) || !fields.get('artist'))
  })
  const fields = matching[0]
  if (boxes.length > 0 && !fields) {
    const composition = fieldsFor.find((item) => songTitleMatches(item, page.title, requestedTitle) && Boolean(item.get('writer')))
    if (!composition || !pageMentionsArtist(page.wikitext, requestedArtist)) return null
    const url = wikiUrl(page.title)
    addRaw(credits, { person: primaryArtist(requestedArtist), role: 'performer', source: 'Wikipedia', url, priority: 1 })
    const noteWriter = (value: string) => {
      for (const person of creditPeople(value)) addRaw(credits, { person, role: 'songwriter', source: 'Wikipedia', url, priority: 1 })
    }
    noteWriter(`${composition.get('writer') || ''}\n${composition.get('writer_links') || ''}`)
    if (!composition.get('writer')) leadCredits(page.wikitext.split('\n==')[0] ?? '', credits, url, ['songwriter'])
    const performed = fieldsFor.find((item) => songTitleMatches(item, page.title, requestedTitle) && artistListed(item.get('artist') || '', requestedArtist))
    if (performed?.get('producer')) {
      for (const person of creditPeople(performed.get('producer') || '')) {
        addRaw(credits, { person, role: 'producer', source: 'Wikipedia', url, priority: 1 })
      }
    }
    return { thin: !hasRole(credits, 'songwriter') || !hasRole(credits, 'producer') }
  }
  if (!fields && !pageMatches) return null
  const chosen = fields ?? new Map<string, string>()
  const url = wikiUrl(page.title)
  const artistField = chosen.get('artist') || ''
  const billed = peopleIn(artistField || requestedArtist)
  for (const name of billed.performers) addRaw(credits, { person: name, role: 'performer', source: 'Wikipedia', url, priority: 1 })
  for (const name of billed.featured) addRaw(credits, { person: name, role: 'featured artist', source: 'Wikipedia', url, priority: 1 })
  if (billed.performers.length === 0) addRaw(credits, { person: primaryArtist(requestedArtist), role: 'performer', source: 'Wikipedia', url, priority: 1 })

  const note = (role: CreditRole, value: string) => {
    for (const person of creditPeople(value)) addRaw(credits, { person, role, source: 'Wikipedia', url, priority: 1 })
  }
  note('songwriter', `${chosen.get('writer') || ''}\n${chosen.get('writer_links') || ''}`)
  note('producer', chosen.get('producer') || '')

  const firstBox = fieldsFor[0]
  const usingFirstBox = !firstBox || chosen === firstBox
  if (usingFirstBox) leadCredits(page.wikitext.split('\n==')[0] ?? '', credits, url, ['songwriter', 'producer'])

  const album = namesIn(chosen.get('album') || '')[0]?.page
  const thin = !hasRole(credits, 'songwriter') || !hasRole(credits, 'producer')
  return { thin, album }
}

function readAlbumTracks(page: { title: string; wikitext: string }, onlyTitle: string, credits: RawCredit[]) {
  const tracklist = extractTemplate(page.wikitext, /\{\{Track listing\b/i) ?? (page.wikitext.includes('title1') ? page.wikitext : '')
  const fields = fieldMap(extractTemplate(tracklist || page.wikitext, /\{\{Track listing\b/i) ?? tracklist)
  const artist = namesIn(fieldMap(extractTemplate(page.wikitext, /\{\{Infobox album\b/i) ?? '').get('artist') || '')[0]?.name
  const producerColumn = /producer/i.test(fields.get('extra_column') || '')
  const url = wikiUrl(page.title)
  for (let index = 1; index <= 40; index++) {
    const title = personName(namesIn(fields.get(`title${index}`) || '')[0]?.name || fields.get(`title${index}`) || '')
    if (!title || norm(title) !== norm(onlyTitle)) continue
    if (artist) addRaw(credits, { person: artist, role: 'performer', source: 'Wikipedia', url, priority: 1 })
    for (const person of creditPeople(fields.get(`writer${index}`) || '')) {
      addRaw(credits, { person, role: 'songwriter', source: 'Wikipedia', url, priority: 1 })
    }
    if (producerColumn) {
      for (const person of creditPeople(fields.get(`extra${index}`) || '')) {
        addRaw(credits, { person, role: 'producer', source: 'Wikipedia', url, priority: 1 })
      }
    }
  }
}

async function readWikipediaPage(page: { title: string; wikitext: string }, title: string, artist: string, credits: RawCredit[]): Promise<boolean> {
  const before = credits.length
  const read = readSongPage(page, title, artist, credits)
  if (!read) {
    credits.splice(before)
    return false
  }
  if (read.thin && read.album && (!hasRole(credits, 'songwriter') || !hasRole(credits, 'producer'))) {
    const album = await wikiPage(read.album)
    if (album) readAlbumTracks(album, title, credits)
  }
  return true
}

type WikiPage = { title: string; wikitext: string }

async function wikipediaCredits(title: string, artist: string, credits: RawCredit[]): Promise<WikiPage | null> {
  const hits = await wikiSearch(`${title} ${primaryArtist(artist)}`)
  const ordered = [
    ...hits.filter((hit) => norm(hit).includes(norm(title))),
    ...hits.filter((hit) => !norm(hit).includes(norm(title))),
  ].slice(0, 3)
  let found: WikiPage | null = null
  const seen = new Set<string>()
  for (const hit of ordered) {
    seen.add(norm(hit))
    const page = await wikiPage(hit)
    if (!page) continue
    const accepted = await readWikipediaPage(page, title, artist, credits)
    if (!accepted) continue
    found = page
    if (hasRole(credits, 'songwriter')) return found
  }

  if (!hasRole(credits, 'songwriter')) {
    const composition = await wikiPage(`${title} (song)`)
    if (composition && !seen.has(norm(composition.title))) {
      const accepted = await readWikipediaPage(composition, title, artist, credits)
      if (accepted) found = composition
    }
  }
  return found
}

function sameSong(title: string, artist: string, otherTitle: string, otherArtist: string): boolean {
  if (norm(title) !== norm(otherTitle)) return false
  const left = norm(primaryArtist(artist)).replace(/^the /, '')
  const right = norm(primaryArtist(otherArtist)).replace(/^the /, '')
  return Boolean(left) && left === right
}

/** A store title without its edition note, so "Hotel California (2013 Remaster)" matches "Hotel California". */
function releaseTitle(title: string): string {
  return title
    .replace(/\s*[([][^)\]]*\b(?:remaster(?:ed)?|version|edit|mono|stereo|deluxe|anniversary)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+[-–]\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|single version|radio edit|mono|stereo)\b.*$/i, '')
    .trim()
}

/** Store credits sometimes pack several people into one string, such as "Don Felder / Don Henley / Glenn Frey". */
function storeNames(names: string[]): string[] {
  return names.flatMap((name) => name.split(/\s+\/\s+|\s*;\s*/)).map((name) => name.trim()).filter((name) => name && !/:/.test(name))
}

type DeezerTrack = { url: string; title: string; artist: string; contributors: Record<string, string[]> }

async function deezerCredits(title: string, artist: string, credits: RawCredit[]): Promise<DeezerTrack | null> {
  const search = await getText(`https://api.deezer.com/search?q=${encodeURIComponent(`${title} ${primaryArtist(artist)}`)}`, {
    'User-Agent': APP_UA,
    Accept: 'application/json',
  })
  if (!search || search.status !== 200) return null
  const data = JSON.parse(search.text) as { data?: { id: number; title: string; artist?: { name?: string } }[] }
  const hit = (data.data ?? []).find(
    (item) => !/\b(?:live|karaoke|instrumental|tribute|cover)\b/i.test(item.title) && sameSong(title, artist, releaseTitle(item.title), item.artist?.name ?? ''),
  )
  if (!hit) return null
  const page = await getText(`https://www.deezer.com/en/track/${hit.id}`, { 'User-Agent': BROWSER_UA, Accept: 'text/html' })
  const raw = page?.text.match(/"SNG_CONTRIBUTORS":(\{.*?\})/)?.[1]
  if (!raw) return null
  let contributors: Record<string, string[]>
  try {
    contributors = JSON.parse(raw) as Record<string, string[]>
  } catch {
    return null
  }
  const url = `https://www.deezer.com/track/${hit.id}`
  const roleFor = (key: string): CreditRole | null => {
    if (key === 'composer' || key === 'author') return 'songwriter'
    if (key === 'producer') return 'producer'
    if (key === 'main_artist') return 'performer'
    if (key === 'featured' || key === 'feature') return 'featured artist'
    return null
  }
  for (const [key, names] of Object.entries(contributors)) {
    const role = roleFor(key)
    if (!role) continue
    for (const name of storeNames(names)) addRaw(credits, { person: name, role, source: 'Deezer', url, priority: 0 })
  }
  return { url, title: hit.title, artist: hit.artist?.name ?? '', contributors }
}

type DiscogsCredit = { name?: string; anv?: string; role?: string; tracks?: string }
type DiscogsTrack = { position?: string; type_?: string; title?: string; extraartists?: DiscogsCredit[] }
type DiscogsRelease = {
  id: number
  title?: string
  year?: number
  artists?: { name?: string }[]
  tracklist?: DiscogsTrack[]
  extraartists?: DiscogsCredit[]
}
type DiscogsSource = { url: string; text: string; instruments: Map<string, string[]> }

function discogsHeaders(): Record<string, string> | null {
  const token = process.env.DISCOGS_TOKEN?.trim()
  if (!token) return null
  return { 'User-Agent': APP_UA, Authorization: `Discogs token=${token}`, Accept: 'application/json' }
}

async function discogsJson<T>(path: string, headers: Record<string, string>): Promise<T | null> {
  const response = await getText(`https://api.discogs.com${path}`, headers)
  if (!response || response.status !== 200) return null
  try {
    return JSON.parse(response.text) as T
  } catch {
    return null
  }
}

/** Discogs disambiguates names with a number, as in "Kenny Brown (2)". */
function discogsName(credit: DiscogsCredit): string {
  return (credit.anv || credit.name || '').replace(/\s+\(\d+\)$/, '').trim()
}

/** Whether a release credit's track list, such as "A1 to A4, B6", includes this track. An empty list covers the whole release. */
function coversTrack(spec: string | undefined, position: string, positions: string[]): boolean {
  if (!spec?.trim()) return true
  return spec.split(/\s*,\s*/).some((part) => {
    const range = part.split(/\s+to\s+/i)
    if (range.length !== 2) return part.trim() === position
    const start = positions.indexOf(range[0]!.trim())
    const end = positions.indexOf(range[1]!.trim())
    const at = positions.indexOf(position)
    return start >= 0 && end >= start && at >= start && at <= end
  })
}

function discogsRole(role: string): CreditRole | null {
  if (/^(?:co-)?producer\b|^produced by/i.test(role)) return 'producer'
  if (/written|composed|lyrics|songwriter|music by|words by/i.test(role)) return 'songwriter'
  if (/^featuring/i.test(role)) return 'featured artist'
  // Discogs names instruments plainly ("Drums", "Guitar [Slide]") and other jobs with "By" ("Mixed By") or a title ("Engineer").
  if (/\bby\b|engineer|producer|technician|design|photo|artwork|liner|management|a&r|coordinat|copyist|conduct|orchestra|arrang|lacquer|master/i.test(role)) return null
  return 'musician'
}

/** Credits for one track on the song's original album, read from that album's main release on Discogs. */
async function discogsCredits(title: string, artist: string, credits: RawCredit[]): Promise<DiscogsSource | null> {
  const headers = discogsHeaders()
  if (!headers) return null
  // Discogs' track search finds nothing when the title has an apostrophe, as in "It's Bad You Know".
  const track = title.replace(/['’]/g, '')
  const query = (type: string) => `/database/search?${new URLSearchParams({ track, artist: primaryArtist(artist), type, per_page: '10' })}`
  type Hit = { id: number; year?: string; title?: string }
  // The artist's own earliest album is usually the original, ahead of compilations and later reissues.
  const original = (hits: Hit[]) => {
    const dated = hits.filter((item) => item.year).sort((a, b) => Number(a.year) - Number(b.year))
    return dated.find((item) => samePrimary((item.title ?? '').split(' - ')[0] ?? '', artist)) ?? dated[0]
  }
  const masters = await discogsJson<{ results?: Hit[] }>(query('master'), headers)
  const earliest = original(masters?.results ?? [])
  let releaseId: number | undefined
  if (earliest) {
    const master = await discogsJson<{ main_release?: number }>(`/masters/${earliest.id}`, headers)
    releaseId = master?.main_release
  }
  if (!releaseId) {
    const releases = await discogsJson<{ results?: Hit[] }>(query('release'), headers)
    releaseId = original(releases?.results ?? [])?.id
  }
  if (!releaseId) return null
  const release = await discogsJson<DiscogsRelease>(`/releases/${releaseId}`, headers)
  if (!release) return null
  const billed = (release.artists ?? []).some((item) => samePrimary(discogsName(item), artist))
  const tracks = (release.tracklist ?? []).filter((track) => track.type_ !== 'heading' && track.position)
  const song = tracks.find((item) => norm(item.title ?? '') === norm(title))
  if (!billed || !song?.position) return null

  const positions = tracks.map((item) => item.position!)
  const applying = [
    ...(release.extraartists ?? []).filter((credit) => coversTrack(credit.tracks, song.position!, positions)),
    ...(song.extraartists ?? []),
  ].filter((credit) => discogsName(credit) && credit.role)
  const url = `https://www.discogs.com/release/${release.id}`
  const instruments = new Map<string, string[]>()
  for (const credit of applying) {
    const person = discogsName(credit)
    for (const role of credit.role!.split(/\s*,\s*/)) {
      const mapped = discogsRole(role)
      if (!mapped) continue
      addRaw(credits, { person, role: mapped, source: 'Discogs', url, priority: 1 })
      if (mapped === 'musician') instruments.set(person, [...(instruments.get(person) ?? []), role.toLowerCase()])
    }
  }
  const lines = applying.map((credit) => `${credit.role}: ${discogsName(credit)}`)
  const albumArtist = (release.artists ?? []).map(discogsName).join(', ')
  return {
    url,
    instruments,
    text: `Album "${release.title}" (${release.year ?? 'year unknown'}) by ${albumArtist}, track ${song.position} "${song.title}".\nCredits that apply to this track:\n${lines.join('\n')}`,
  }
}

function mbRole(type: string): CreditRole | null {
  if (type === 'producer') return 'producer'
  if (type === 'writer' || type === 'composer' || type === 'lyricist') return 'songwriter'
  return null
}

function noiseReason(recording: { video?: boolean; length?: number; disambiguation?: string }): boolean {
  if (recording.video) return true
  if (recording.length != null && recording.length < 30_000) return true
  const note = recording.disambiguation ?? ''
  return /live|dj[-‐\s]?mix|remix|karaoke|music video|instrumental|commentary|demo|bootleg|mash/i.test(note)
}

async function mbJson<T>(url: string): Promise<T | null> {
  const run = mbQueue.then(async () => {
    const wait = Math.max(0, mbNextSlot - Date.now())
    mbNextSlot = Date.now() + wait + MIN_INTERVAL_MS
    if (wait > 0) await sleep(wait)
    const response = await fetch(url, {
      headers: { 'User-Agent': MB_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) return null
    return (await response.json()) as T
  })
  mbQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run.catch(() => null)
}

function lucenePhrase(value: string): string {
  return `"${value.replace(/["\\]/g, ' ').trim()}"`
}

function readMbPeople(recording: MbRecording, credits: RawCredit[], url: string) {
  let nextFeatured = false
  for (const credit of recording['artist-credit'] ?? []) {
    const name = credit.name || credit.artist?.name
    if (name) {
      addRaw(credits, {
        person: name,
        role: nextFeatured ? 'featured artist' : 'performer',
        source: 'MusicBrainz',
        url,
        priority: 2,
      })
    }
    nextFeatured = /\b(?:feat\.?|featuring|ft\.?)\b/i.test(credit.joinphrase ?? '')
  }
  for (const relation of recording.relations ?? []) {
    const role = mbRole(relation.type ?? '')
    const name = relation.artist?.name
    if (!role || !name) continue
    addRaw(credits, { person: name, role, source: 'MusicBrainz', url, priority: 2 })
  }
}

async function musicBrainzCredits(title: string, artist: string, credits: RawCredit[]) {
  const query = `recording:${lucenePhrase(title)} AND artist:${lucenePhrase(primaryArtist(artist))}`
  const found = await mbJson<{ recordings?: MbRecording[] }>(
    `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=8`,
  )
  const hits = (found?.recordings ?? []).filter((hit) => (hit.score ?? 0) >= 80 && !noiseReason(hit)).slice(0, 3)
  let best: MbRecording | null = null
  let bestCount = -1
  for (const hit of hits) {
    const recording = await mbJson<MbRecording>(
      `https://musicbrainz.org/ws/2/recording/${hit.id}?inc=artist-credits+artist-rels+work-rels&fmt=json`,
    )
    if (!recording || noiseReason(recording)) continue
    const count = (recording.relations ?? []).filter((relation) => mbRole(relation.type ?? '') && relation.artist?.name).length
    if (count > bestCount) {
      best = recording
      bestCount = count
    }
  }
  if (!best) return
  const url = `https://musicbrainz.org/recording/${best.id}`
  const collected: RawCredit[] = []
  readMbPeople(best, collected, url)
  const workIds = [
    ...new Set(
      (best.relations ?? [])
        .filter((relation) => relation.type === 'performance' && relation.work?.id)
        .map((relation) => relation.work!.id!),
    ),
  ].slice(0, 2)
  for (const workId of workIds) {
    const work = await mbJson<MbRecording>(`https://musicbrainz.org/ws/2/work/${workId}?inc=artist-rels&fmt=json`)
    if (work) readMbPeople(work, collected, url)
  }
  const missing = new Set<CreditRole>(ROLE_ORDER.filter((role) => !hasRole(credits, role)))
  for (const credit of collected) {
    if (missing.has(credit.role)) addRaw(credits, credit)
  }
}

function samePrimary(left: string, right: string): boolean {
  const a = norm(primaryArtist(left))
  const b = norm(primaryArtist(right))
  if (!a || !b) return false
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)
}

function plainText(value: string): string {
  return value
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function songDisplayName(linkPage: string | undefined, linkName: string | undefined, plain?: string): string {
  const display = personName(plainText(linkName || plain || linkPage || ''))
  return display.replace(/ \([^)]*\)$/, '').trim()
}

function rememberParentheticalAliases(wikitext: string) {
  for (const match of wikitext.matchAll(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]\s+\(([^)\n]+)\)/g)) {
    const stage = linkedPersonName({ page: match[1], name: match[2] || match[1] })
    const legal = personName(plainText((match[3] ?? '').split(/,| formerly | aka /i)[0] ?? ''))
    if (!usableName(stage) || !usableName(legal)) continue
    if (/\d{4}|born|died|guitar|vocal|bass|drum|keyboard/i.test(legal)) continue
    rememberAlias(stage, legal)
  }
}

function roleFromText(value: string): CreditRole | null {
  if (/producer|producing|production/i.test(value)) return 'producer'
  if (/songwrit|writer|writing|wrote|written|compos/i.test(value)) return 'songwriter'
  if (/featured/i.test(value)) return 'featured artist'
  if (/performer|vocal|sang|discograph/i.test(value)) return 'performer'
  return null
}

function songsFromPersonPage(wikitext: string, roles: CreditRole[] = [], subject = ''): RelatedSong[] {
  const found: RelatedSong[] = []
  let sectionRole: CreditRole | null = null
  let sectionHeading = ''
  let currentArtist = ''
  let headingRole: CreditRole | null = null
  let tableArtist = ''
  let pendingTitle = ''
  let loosePerformer = false
  const push = (title: string, artistName: string, role: CreditRole | null) => {
    if (
      loosePerformer &&
      role === 'performer' &&
      roles.length > 0 &&
      !roles.includes('performer') &&
      !roles.includes('featured artist')
    ) {
      return
    }
    const cleanTitle = songDisplayName(undefined, title)
    const cleanArtist = personName(artistName)
    if (!cleanTitle || !cleanArtist || !role || !usableName(cleanArtist)) return
    if (cleanTitle.length > 80 || cleanArtist.length > 80) return
    if (/[{}|<>=]/.test(cleanTitle) || /[{}|<>=]/.test(cleanArtist)) return
    if (/wikitable|scope|rowspan|colspan|class=/i.test(`${cleanTitle} ${cleanArtist}`)) return
    if (/^(outro|intro|interlude|skit)$/i.test(cleanTitle)) return
    if (/remix|instrumental|sample credit/i.test(cleanTitle)) return
    if (found.some((item) => norm(item.title) === norm(cleanTitle) && samePrimary(item.artist, cleanArtist))) return
    found.push({ title: cleanTitle, artist: cleanArtist, role })
  }

  for (const line of wikitext.split('\n')) {
    const section = line.match(/^==+\s*(.+?)\s*==+\s*$/)
    if (section) {
      const heading = section[1] ?? ''
      const level = line.match(/^=+/)?.[0].length ?? 2
      if (/early life|personal|references|external|awards|notes|see also/i.test(heading)) {
        sectionRole = null
        sectionHeading = ''
        currentArtist = ''
        headingRole = null
        tableArtist = ''
        pendingTitle = ''
        loosePerformer = false
        continue
      }
      const nextRole = roleFromText(heading) ?? (/^singles?$/i.test(heading) ? 'performer' : null)
      sectionHeading = heading
      if (nextRole || level <= 2) {
        sectionRole = nextRole
        loosePerformer = nextRole === 'performer' && /discograph/i.test(heading) && !/vocal|sang|perform/i.test(heading)
      }
      currentArtist = ''
      headingRole = null
      tableArtist = ''
      pendingTitle = ''
      const alias = heading.match(/^as\s+(.+)$/i)
      if (alias) currentArtist = personName(plainText(alias[1] ?? ''))
      continue
    }

    const artistHeading = line.match(/^'''+\s*\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/)
    if (artistHeading) {
      currentArtist = songDisplayName(artistHeading[1], artistHeading[2])
      headingRole = roleFromText(line) ?? sectionRole
      continue
    }

    const listed = line.match(/^\*\s*\d{4}\s+[–—-]\s+(.+?)\s+"(.+?)"\s+[–—-]\s+([^<]+)/)
    if (listed) {
      const listedRole = /producer/i.test(listed[3] ?? '') ? 'producer' : /writer/i.test(listed[3] ?? '') ? 'songwriter' : roleFromText(listed[3] ?? '')
      const listedArtist = creditPeople(listed[1] ?? '')[0] || personName(listed[1] ?? '')
      const listedTitle = namesIn(listed[2] ?? '')[0]
      const title = listedTitle ? songDisplayName(listedTitle.page, listedTitle.name) : songDisplayName(undefined, listed[2])
      if (listedRole) push(title, listedArtist, listedRole)
    }

    const byArtist = line.match(/^\*\s+"\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]".*\b(?:by|with|featuring)\s+\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/i)
    if (byArtist && (sectionRole === 'featured artist' || sectionRole === 'performer')) {
      push(songDisplayName(byArtist[1], byArtist[2]), songDisplayName(byArtist[3], byArtist[4]), sectionRole)
    }

    const role = headingRole ?? sectionRole
    if (currentArtist && role && line.startsWith('*') && !line.startsWith('**')) {
      const linked = line.match(/^\*+\s*(?:\d+\.\s*)?"\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]"/)
      const plain = line.match(/^\*+\s*(?:\d+\.\s*)?"([^"\[][^"]*)"/)
      const title = linked ? songDisplayName(linked[1], linked[2]) : songDisplayName(undefined, plain?.[1])
      if (title) push(title, currentArtist, role)
    }

    const prose = line.replace(/<ref[\s\S]*?<\/ref>/gi, ' ').replace(/<ref[^/>]*\/>/gi, ' ')
    const produced = prose.match(/produced\s+(?:\[\[([^\]|#]+)(?:\|([^\]]+))?\]\](?:'s)?\s+)?"\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]"/i)
    if (produced) push(songDisplayName(produced[3], produced[4]), songDisplayName(produced[1], produced[2] || produced[1]), 'producer')
    const wrote = prose.match(/wrote\s+"\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]"\s+for\s+\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/i)
    if (wrote) push(songDisplayName(wrote[1], wrote[2]), songDisplayName(wrote[3], wrote[4]), 'songwriter')
    if (/became hits for other artists|his songs became hits/i.test(prose)) {
      const hitForOthers = /"\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]"\s*(?:by\s+\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]|\(\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]\))/gi
      for (const hit of prose.matchAll(hitForOthers)) {
        push(songDisplayName(hit[1], hit[2]), songDisplayName(hit[3] || hit[5], hit[4] || hit[6]), 'songwriter')
      }
    }
    const featured = prose.match(/featured on\s+\[\[([^\]|#]+)(?:\|([^\]]+))?\]\](?:'s)?\s+"\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]"/i)
    if (featured) push(songDisplayName(featured[3], featured[4]), songDisplayName(featured[1], featured[2]), 'featured artist')
    const release = line.match(/^\*\s*(?:\d{4}:\s*)?(?:"\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]"|"([^"]{1,80})")(.*)$/)
    if (release && sectionRole) {
      const releaseTitle = release[1] ? songDisplayName(release[1], release[2]) : songDisplayName(undefined, release[3])
      const rest = release[4] ?? ''
      const asLink = rest.match(/\bas\s+\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/i)
      const asPlain = rest.match(/\bas\s+'''([^']+)'''/i)
      const billed = asLink ? songDisplayName(asLink[1], asLink[2]) : asPlain ? personName(plainText(asPlain[1] ?? '')) : currentArtist || subject
      const releaseRole =
        loosePerformer && sectionRole === 'performer' && !roles.includes('performer') && !roles.includes('featured artist')
          ? roles.includes('producer')
            ? 'producer'
            : roles.includes('songwriter')
              ? 'songwriter'
              : null
          : sectionRole
      if (releaseTitle && billed && releaseRole) push(releaseTitle, billed, releaseRole)
    }

    const worked = prose.match(/worked with\s+\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]\s+on\s+"([^"]+)"/i)
    if (worked) push(songDisplayName(undefined, worked[3]), songDisplayName(worked[1], worked[2]), 'producer')

    const withoutAttrs = line
      .replace(/\b[\w:-]+=(?:"[^"]*"|'[^']*')/g, ' ')
      .replace(/\b(?:align|style|width|colspan|rowspan|valign|bgcolor|scope)\s*=\s*[^\s|]+/gi, ' ')
    if (sectionRole && !/["“”]/.test(withoutAttrs) && /\[\[[^\]|]+\]\]/.test(withoutAttrs) && !/''\[\[[^\]]+\]\]''/.test(line)) {
      const people = creditPeople(withoutAttrs).filter((name) => name.length > 1 && !/^\d{4}$/.test(name) && !/[{}|<>=]|scope|rowspan|colspan/i.test(name))
      if (people.length > 0 && people.length <= 3) {
        tableArtist = people[0] ?? ''
        if (pendingTitle && tableArtist) {
          push(pendingTitle, tableArtist, sectionRole)
          pendingTitle = ''
        }
      }
    }
    if (sectionRole && /^\s*[|!]/.test(line) && !/wikitable|scope="col"/i.test(line)) {
      const linked = withoutAttrs.match(/["“”]\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]["“”]/)
      const plain = linked ? null : withoutAttrs.match(/["“”]([^"“”|]{2,80})["“”]/)
      const title = linked ? songDisplayName(linked[1], linked[2]) : songDisplayName(undefined, plain?.[1])
      if (title && !/^(?:col|row|left|center|right|title|year|artist|album|credits)$/i.test(title)) {
        const billing = withoutAttrs
          .replace(/\{\{small\|([^{}]*)\}\}/gi, (match, inner: string) => (/\b(?:featuring|feat\.?|ft\.?)\b/i.test(inner) ? ' ' : match))
          .replace(/\((?:[^()]{0,180}\b(?:featuring|feat\.?|ft\.?)\b[^()]{0,180})\)/gi, ' ')
        const artists = creditPeople(billing.replace(linked?.[0] ?? plain?.[0] ?? '', ' ')).filter(
          (name) => norm(name) !== norm(title) && /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(name) && !/[{}|<>=]/.test(name),
        )
        const artistName = artists[0] || tableArtist
        if (artistName) {
          push(title, artistName, sectionRole)
          pendingTitle = ''
        } else if (subject && sectionRole === 'performer' && /^singles?$/i.test(sectionHeading)) {
          push(title, subject, 'performer')
          pendingTitle = ''
        } else {
          pendingTitle = title
        }
      }
    }
  }
  return found
}

function plausibleRelated(candidate: RelatedSong): boolean {
  const songTitle = candidate.title.trim()
  const artistName = candidate.artist.trim()
  if (songTitle.length < 2 || artistName.length < 2 || songTitle.length > 80 || artistName.length > 80) return false
  if (/[{}|<>=]|wikitable|plainrowheaders|rowspan|colspan|class=/i.test(`${songTitle} ${artistName}`)) return false
  if (!/[A-ZÀ-ÖØ-Þ]/.test(artistName)) return false
  if (songTitle.split(/\s+/).length > 12) return false
  return true
}

function chooseRelated(candidates: RelatedSong[], title: string, artist: string, roles: CreditRole[]): RelatedSong | undefined {
  const possible = candidates.filter((candidate) => {
    if (!plausibleRelated(candidate)) return false
    if (samePrimary(candidate.artist, artist)) return false
    if (/^(various artists|itunes|spotify|youtube|deezer|amazon|apple music|soundcloud)$/i.test(candidate.artist)) return false
    if (sameSong(candidate.title, candidate.artist, title, artist)) return false
    if (/\bremix\b/i.test(candidate.title)) return false
    return true
  })
  return possible.find((candidate) => roles.includes(candidate.role)) ?? possible[0]
}

function listPages(wikitext: string): string[] {
  const found: string[] = []
  for (const match of wikitext.matchAll(/\{\{Main\|([^}]+)\}\}/gi)) {
    for (const piece of (match[1] ?? '').split('|')) {
      const title = piece.trim()
      if (/discograph|songs written|production discograph|songwriting/i.test(title)) found.push(title)
    }
  }
  return [...new Set(found)].slice(0, 2)
}

async function wikiRelated(person: string, roles: CreditRole[], title: string, artist: string): Promise<RelatedSong | undefined> {
  const hits = await wikiSearch(person)
  const pages = hits.filter((hit) => !/\((?:song|album|single|film)\)/i.test(hit))
  const chosen =
    pages.find((hit) => sameIdentity(hit.replace(/ \([^)]*\)$/, ''), person)) ??
    pages.find((hit) => sameIdentity(hit, person)) ??
    null
  if (!chosen) return undefined
  const page = await wikiPage(chosen)
  if (!page) return undefined
  const own = chooseRelated(songsFromPersonPage(page.wikitext, roles, person), title, artist, roles)
  if (own) return own
  for (const extra of listPages(page.wikitext)) {
    const sub = await wikiPage(extra)
    if (!sub) continue
    const related = chooseRelated(songsFromPersonPage(sub.wikitext, roles, person), title, artist, roles)
    if (related) return related
  }
  return undefined
}

async function deezerRelated(person: string, roles: CreditRole[], title: string, artist: string): Promise<RelatedSong | undefined> {
  if (!roles.some((role) => role === 'performer' || role === 'featured artist')) return undefined
  const search = await getText(`https://api.deezer.com/search/artist?q=${encodeURIComponent(person)}`, {
    'User-Agent': APP_UA,
    Accept: 'application/json',
  })
  if (!search || search.status !== 200) return undefined
  const data = JSON.parse(search.text) as { data?: { id: number; name: string; nb_fan?: number }[] }
  const match = (data.data ?? [])
    .filter((item) => sameIdentity(item.name, person))
    .sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0]
  if (!match) return undefined
  const top = await getText(`https://api.deezer.com/artist/${match.id}/top?limit=15`, {
    'User-Agent': APP_UA,
    Accept: 'application/json',
  })
  if (!top || top.status !== 200) return undefined
  const tracks = JSON.parse(top.text) as { data?: { title: string; artist?: { name?: string } }[] }
  const candidates: RelatedSong[] = []
  for (const track of tracks.data ?? []) {
    const trackArtist = track.artist?.name ?? ''
    const title = track.title.replace(/\s*\((?:feat\.?|featuring|ft\.?)\b[^)]*\)/i, '').trim()
    if (!title || !trackArtist || !sameIdentity(primaryArtist(trackArtist), person)) continue
    candidates.push({ title, artist: trackArtist, role: 'performer' })
  }
  return chooseRelated(candidates, title, artist, roles)
}

type MbArtistHit = { id: string; name?: string; score?: number; type?: string }
type MbRel = { type?: string; recording?: { id?: string; title?: string; video?: boolean; disambiguation?: string; length?: number } }

function mbCreditRole(type: string): CreditRole | null {
  if (type === 'producer') return 'producer'
  if (type === 'writer' || type === 'composer' || type === 'lyricist') return 'songwriter'
  if (type === 'vocal' || type === 'performer' || type === 'performance') return 'performer'
  if (type === 'instrument') return 'musician'
  return null
}

async function mbRelated(person: string, roles: CreditRole[], title: string, artist: string): Promise<RelatedSong | undefined> {
  const found = await mbJson<{ artists?: MbArtistHit[] }>(
    `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(`artist:${lucenePhrase(person)}`)}&fmt=json&limit=4`,
  )
  const hits = (found?.artists ?? []).filter((hit) => sameIdentity(hit.name ?? '', person)).slice(0, 3)
  for (const hit of hits) {
    const artistPage = await mbJson<{ relations?: MbRel[] }>(
      `https://musicbrainz.org/ws/2/artist/${hit.id}?inc=recording-rels&fmt=json`,
    )
    const allRelations = artistPage?.relations ?? []
    const workedOnOriginal = allRelations.some((relation) => norm(relation.recording?.title ?? '') === norm(title))
    if (!workedOnOriginal) continue
    const relations = allRelations.filter((relation) => {
      const role = mbCreditRole(relation.type ?? '')
      const recording = relation.recording
      return role && recording?.id && recording.title && !noiseReason(recording)
    })
    const preferred = [
      ...relations.filter((relation) => roles.includes(mbCreditRole(relation.type ?? '')!)),
      ...relations,
    ]
    const picked: { id: string; title: string; role: CreditRole }[] = []
    const seen = new Set<string>()
    for (const relation of preferred) {
      const recording = relation.recording
      const role = mbCreditRole(relation.type ?? '')
      if (!recording?.id || !recording.title || !role || seen.has(recording.id)) continue
      if (norm(recording.title) === norm(title)) continue
      seen.add(recording.id)
      picked.push({ id: recording.id, title: recording.title, role })
      if (picked.length >= 12) break
    }
    if (picked.length === 0) continue
    const query = picked.map((item) => `rid:${item.id}`).join(' OR ')
    const recordings = await mbJson<{ recordings?: MbRecording[] }>(
      `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=20`,
    )
    const candidates: RelatedSong[] = []
    for (const recording of recordings?.recordings ?? []) {
      const credit = picked.find((item) => item.id === recording.id)
      const primary = recording['artist-credit']?.[0]?.name || recording['artist-credit']?.[0]?.artist?.name
      if (!credit || !primary || !recording.title) continue
      const role = credit.role === 'performer' && !sameIdentity(primary, person) ? 'featured artist' : credit.role
      candidates.push({ title: recording.title, artist: primary, role })
    }
    const related = chooseRelated(candidates, title, artist, roles)
    if (related) return related
  }
  return undefined
}

async function mapPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let index = 0
  async function worker() {
    while (index < items.length) {
      const current = items[index]
      index += 1
      if (current) await task(current)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}

const NOT_AN_INSTRUMENT = /^(?:co-)?(?:production|producer|produced|audio programming|programming|engineer|engineering|recording(?: engineer)?|mix(?:ing| engineer)?|songwriter|writer|executive producer|assistant(?: recording)?(?: engineer)?)$/i

function cleanInstrumentText(value: string): string {
  return value
    .replace(/<ref[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<small>[\s\S]*?<\/small>/gi, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\([^)]*\d{4}[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function instrumentsFrom(value: string): string[] {
  const text = cleanInstrumentText(value).replace(/[.;]\s*$/, '')
  if (!text) return []
  const parts = text.split(/\s*,\s*|\s*;\s*/).map((part) => part.replace(/^(?:and|with)\s+/i, '').trim())
  return [...new Set(parts.filter((part) => part.length > 1 && !NOT_AN_INSTRUMENT.test(part) && !/^assistant\b/i.test(part)))]
}

function sectionText(wikitext: string, heading: RegExp): string {
  const lines = wikitext.split('\n')
  let capture = false
  let level = 0
  const body: string[] = []
  for (const line of lines) {
    const headingMatch = line.match(/^(==+)\s*(.+?)\s*\1\s*$/)
    if (headingMatch) {
      const thisLevel = headingMatch[1]!.length
      if (capture && thisLevel <= level) break
      if (!capture && heading.test(headingMatch[2] ?? '')) {
        capture = true
        level = thisLevel
        continue
      }
    }
    // Subheadings stay in the body so callers can tell "Current members" from "Touring members".
    if (capture) body.push(line)
  }
  return body.join('\n')
}

function parseMemberLines(block: string): { person: string; instruments: string[] }[] {
  const found: { person: string; instruments: string[] }[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('*') || line.startsWith('**')) continue
    const link = line.match(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/)
    if (!link) continue
    const person = linkedPersonName({ page: link[1], name: link[2] || link[1] })
    if (!usableName(person) || found.some((item) => samePerson(item.person, person))) continue
    const after = line.slice((link.index ?? 0) + link[0].length)
    const dash = after.match(/^(?:&nbsp;|\s)*(?:\([^)]*\)\s*)?(?:–|—|-)\s*(.+)$/)
    const remainder = dash?.[1] ?? ''
    const instruments = remainder && remainder.length < 180 && !/\b(?:preceded|joined|replaced|formerly)\b/i.test(remainder)
      ? instrumentsFrom(remainder)
      : []
    found.push({ person, instruments })
  }
  return found
}

const NOT_CORE_MEMBERS = /early|temporary|touring|session|additional|in addition|other people|guest|vocalists|live|substitute|contribut|collaborat|timeline/i

/** Member lists split by subheadings, bold labels, or a prose paragraph such as "In addition to the four members...". */
function memberBlocks(section: string): { label: string; body: string }[] {
  const blocks: { label: string; body: string }[] = [{ label: '', body: '' }]
  for (const line of section.split('\n')) {
    const trimmed = line.trim()
    const label = trimmed.match(/^(?:==+\s*(.+?)\s*==+|'''([^'\n]+)'''|;\s*(.+))$/)
    if (label) {
      blocks.push({ label: label[1] ?? label[2] ?? label[3] ?? '', body: '' })
      continue
    }
    if (trimmed && !/^[*{[|!<]/.test(trimmed)) {
      blocks.push({ label: trimmed, body: '' })
      continue
    }
    blocks.at(-1)!.body += `${line}\n`
  }
  return blocks.filter((block) => block.body.trim())
}

function uniqueMembers(members: { person: string; instruments: string[] }[]): { person: string; instruments: string[] }[] {
  return members.filter((member, index) => members.findIndex((item) => samePerson(item.person, member.person)) === index)
}

/** The band's core lineup: `all` is every current and former member, `usual` is the shorter list used when a song has no personnel section. */
function rosterFromMemberSection(wikitext: string): { all: { person: string; instruments: string[] }[]; usual: { person: string; instruments: string[] }[] } {
  const section = sectionText(wikitext, /^(?:band )?members$/i)
  if (!section) return { all: [], usual: [] }
  const core = memberBlocks(section).filter((block) => !NOT_CORE_MEMBERS.test(block.label))
  const preferred = core.filter((block) => /principal|current/i.test(block.label))
  const usual = preferred.length > 0 ? preferred : core.filter((block) => !/former|past/i.test(block.label))
  return {
    all: uniqueMembers(core.flatMap((block) => parseMemberLines(block.body))),
    usual: uniqueMembers(usual.flatMap((block) => parseMemberLines(block.body))),
  }
}

function mergeInstruments(
  roster: { person: string; instruments: string[] }[],
  extra: { person: string; instruments: string[] }[],
): { person: string; instruments: string[] }[] {
  return roster.map((member) => {
    const match = extra.find((item) => samePerson(item.person, member.person) && item.instruments.length > 0)
    return match ? { person: member.person, instruments: match.instruments } : member
  })
}

async function bandMembers(
  artist: string,
  songWikitext: string | null,
): Promise<{ people: { person: string; instruments: string[] }[]; url: string; title: string; text: string } | null> {
  const hits = await wikiSearch(primaryArtist(artist))
  const wanted = norm(primaryArtist(artist))
  const pages = hits.filter((hit) => !/\((?:song|album|single|film)\)/i.test(hit))
  const exact = pages.filter((hit) => norm(hit.replace(/ \([^)]*\)$/, '')) === wanted)
  // "Queen" and "Nirvana" are other articles first, so a musical disambiguation goes ahead of the bare title.
  const candidates = [
    ...new Set([
      ...exact.filter((hit) => /\([^)]*(?:band|group|duo|trio|musician|rapper|singer)[^)]*\)$/i.test(hit)),
      ...exact,
      ...pages.filter((hit) => norm(hit).includes(wanted)),
      `${primaryArtist(artist)} (band)`,
    ]),
  ].slice(0, 3)
  let page: { title: string; wikitext: string } | null = null
  let infobox: string | null = null
  for (const candidate of candidates) {
    const found = await wikiPage(candidate)
    const box = found ? extractTemplate(found.wikitext, /\{\{Infobox (?:musical artist|musical group|band)\b/i) : null
    if (found && box) {
      page = found
      infobox = box
      break
    }
  }
  if (!page || !infobox) return null
  rememberParentheticalAliases(page.wikitext)
  const fields = fieldMap(infobox)
  const background = fields.get('background') || ''
  const fromSection = rosterFromMemberSection(page.wikitext)
  const infoboxBlock = `${fields.get('members') || ''}\n${fields.get('current_members') || ''}`
  const fromInfobox = parseMemberLines(infoboxBlock)
  const past = parseMemberLines(fields.get('past_members') || '')
  const group = /group_or_band|\bband\b|\bgroup\b/i.test(background)
    || /\{\{Infobox musical group\b|\{\{Infobox band\b/i.test(infobox)
    || fromSection.all.length > 0
    || fromInfobox.length > 0
    || past.length > 0
  if (!group) return null
  const notArtist = (member: { person: string }) => !samePrimary(member.person, artist)
  const everyone = uniqueMembers([...fromSection.all, ...fromInfobox, ...past]).filter(notArtist)
  let roster = (fromSection.usual.length > 0 ? fromSection.usual : fromInfobox.length > 0 ? fromInfobox : past).filter(notArtist)
  if (songWikitext) {
    const personnel = parseMemberLines(sectionText(songWikitext, /personnel/i)).filter(notArtist)
    // When the song lists who played on it, only those band members are credited.
    const played = everyone.filter((member) => personnel.some((item) => samePerson(item.person, member.person)))
    if (played.length > 0) roster = played
    else if (roster.length === 0) roster = personnel
    roster = mergeInstruments(roster, personnel)
  }
  roster = roster.slice(0, 12)
  if (roster.length === 0) return null
  const text = [`Infobox members:\n${infoboxBlock}\nPast members:\n${fields.get('past_members') || ''}`, sectionText(page.wikitext, /^(?:band )?members$/i)]
    .map((part) => stripNotes(part).slice(0, 6000))
    .join('\n\n')
  return { people: roster, url: wikiUrl(page.title), title: page.title, text }
}

async function deezerContributors(trackId: number): Promise<{ name: string; role: CreditRole }[]> {
  const page = await getText(`https://www.deezer.com/en/track/${trackId}`, { 'User-Agent': BROWSER_UA, Accept: 'text/html' })
  const raw = page?.text.match(/"SNG_CONTRIBUTORS":(\{.*?\})/)?.[1]
  if (!raw) return []
  let contributors: Record<string, string[]>
  try {
    contributors = JSON.parse(raw) as Record<string, string[]>
  } catch {
    return []
  }
  const found: { name: string; role: CreditRole }[] = []
  for (const [key, names] of Object.entries(contributors)) {
    const role = key === 'composer' || key === 'author' ? 'songwriter' : key === 'producer' ? 'producer' : key === 'main_artist' ? 'performer' : key === 'featured' || key === 'feature' ? 'featured artist' : null
    if (!role) continue
    for (const name of storeNames(names)) found.push({ name, role })
  }
  return found
}

async function deezerVerified(person: string, roles: CreditRole[], title: string, artist: string): Promise<RelatedSong | undefined> {
  const search = await getText(`https://api.deezer.com/search?q=${encodeURIComponent(person)}&limit=20`, {
    'User-Agent': APP_UA,
    Accept: 'application/json',
  })
  if (!search || search.status !== 200) return undefined
  const data = JSON.parse(search.text) as { data?: { id: number; title: string; artist?: { name?: string } }[] }
  const tracks = (data.data ?? []).filter((track) => {
    const trackArtist = track.artist?.name ?? ''
    return track.id && track.title && trackArtist && !samePrimary(trackArtist, artist) && !sameSong(track.title, trackArtist, title, artist)
  })
  const candidates: RelatedSong[] = []
  for (const track of tracks.slice(0, 4)) {
    const contributors = await deezerContributors(track.id)
    const hits = contributors.filter((item) => sameIdentity(item.name, person) || sameIdentity(primaryArtist(item.name), person))
    const hit = hits.find((item) => roles.includes(item.role)) ?? hits[0]
    if (!hit || !track.artist?.name) continue
    candidates.push({ title: track.title, artist: track.artist.name, role: hit.role })
    if (roles.includes(hit.role)) break
  }
  return chooseRelated(candidates, title, artist, roles)
}

async function attachRelated(credits: SongCredit[], title: string, artist: string) {
  await mapPool(credits, 3, async (credit) => {
    try {
      const related =
        (await wikiRelated(credit.person, credit.roles, title, artist)) ??
        (await deezerRelated(credit.person, credit.roles, title, artist)) ??
        (await deezerVerified(credit.person, credit.roles, title, artist)) ??
        (await mbRelated(credit.person, credit.roles, title, artist))
      if (related) credit.related = related
    } catch {
      // A missed related song still leaves the credit itself visible.
    }
  })
}

export type CreditsExtractor = 'parser' | 'claude'

export function defaultExtractor(): CreditsExtractor {
  return process.env.CREDITS_EXTRACTOR === 'claude' ? 'claude' : 'parser'
}

/** The parts of a song article that name credits: the lead with its infobox, and any personnel or production sections. */
function articleExcerpt(wikitext: string): string {
  const clean = stripNotes(wikitext).replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, '')
  const parts = [
    clean.split('\n==')[0]?.slice(0, 12000) ?? '',
    sectionText(clean, /personnel|credits/i).slice(0, 6000),
    sectionText(clean, /writing|composition|production|recording/i).slice(0, 6000),
  ]
  return parts.filter((part) => part.trim()).join('\n\n')
}

function sourceTexts(
  song: WikiPage | null,
  deezer: DeezerTrack | null,
  band: { url: string; title: string; text: string } | null,
  discogs: DiscogsSource | null,
  credits: RawCredit[],
): CreditSource[] {
  const sources: CreditSource[] = []
  if (song) sources.push({ id: 'wikipedia', label: `Wikipedia: ${song.title}`, url: wikiUrl(song.title), text: articleExcerpt(song.wikitext) })
  if (deezer) {
    const roles = Object.entries(deezer.contributors).map(([role, names]) => `${role}: ${names.join(', ')}`)
    sources.push({ id: 'deezer', label: 'Deezer', url: deezer.url, text: `Track "${deezer.title}" by ${deezer.artist}\n${roles.join('\n')}` })
  }
  if (band) sources.push({ id: 'band', label: `Wikipedia: ${band.title}`, url: band.url, text: band.text })
  if (discogs) sources.push({ id: 'discogs', label: 'Discogs', url: discogs.url, text: discogs.text })
  const musicBrainz = credits.filter((credit) => credit.source === 'MusicBrainz')
  if (musicBrainz.length > 0) {
    sources.push({
      id: 'musicbrainz',
      label: 'MusicBrainz',
      url: musicBrainz[0]!.url,
      text: musicBrainz.map((credit) => `${credit.role}: ${credit.person}`).join('\n'),
    })
  }
  return sources
}

export async function findMajorCredits(title: string, artist: string, extractor: CreditsExtractor = defaultExtractor()): Promise<CreditsResponse> {
  nameAliases.length = 0
  const fromWikipedia: RawCredit[] = []
  const fromDeezer: RawCredit[] = []
  let songPage: WikiPage | null = null
  let deezer: DeezerTrack | null = null
  let discogs: DiscogsSource | null = null
  const fromDiscogs: RawCredit[] = []
  await Promise.all([
    wikipediaCredits(title, artist, fromWikipedia).then((page) => {
      songPage = page
    }),
    deezerCredits(title, artist, fromDeezer).then((track) => {
      deezer = track
    }),
    discogsCredits(title, artist, fromDiscogs).then((found) => {
      discogs = found
    }),
  ])
  const songWikitext = (songPage as WikiPage | null)?.wikitext ?? null
  const credits = [...fromDeezer, ...fromWikipedia, ...fromDiscogs]
  credits.forEach((credit, index) => {
    credit.order = index
  })
  const needsMore = !hasRole(credits, 'performer') || !hasRole(credits, 'songwriter') || !hasRole(credits, 'producer')
  if (needsMore) await musicBrainzCredits(title, artist, credits)
  if (!hasRole(credits, 'performer')) {
    addRaw(credits, { person: primaryArtist(artist), role: 'performer', source: 'Billboard', url: '', priority: 2 })
  }
  if (songWikitext) rememberParentheticalAliases(songWikitext)
  const members = await bandMembers(artist, songWikitext)
  if (members) {
    for (const member of members.people) {
      addRaw(credits, { person: member.person, role: 'performer', source: 'Wikipedia', url: members.url, priority: 1 })
    }
  }
  let result = present(credits)
  if (members) {
    for (const credit of result.credits) {
      const member = members.people.find((item) => samePerson(item.person, credit.person))
      if (member) credit.instruments = member.instruments
    }
  }
  for (const credit of result.credits) {
    if (!credit.roles.includes('musician') || credit.instruments) continue
    const played = [...((discogs as DiscogsSource | null)?.instruments ?? [])].find(([name]) => samePerson(name, credit.person))
    credit.instruments = played?.[1] ?? []
  }
  if (extractor === 'claude') {
    try {
      const read = await extractCredits(title, artist, sourceTexts(songPage, deezer, members, discogs, credits))
      if (read && read.credits.length > 0) result = { credits: read.credits, sources: read.sources }
    } catch (error) {
      // The parser's result above still stands when the Claude call fails.
      console.warn('Claude credit extraction failed:', error instanceof Error ? error.message : error)
    }
  }
  if (result.credits.length === 0) return { credits: [], sources: [], notice: 'No major credits were found.' }
  await attachRelated(result.credits, title, artist)
  return result
}
