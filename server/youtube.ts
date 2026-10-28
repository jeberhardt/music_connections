const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const VIDEO_LABEL = /official|lyric|lyrics|audio|visuali[sz]er|music\s+video|\bmv\b|\bhd\b|\b4k\b/i

export const YOUTUBE_URL_ERROR =
  'Paste a YouTube link (watch, youtu.be, embed, or shorts) or an 11-character video id.'

/** watch, youtu.be, embed, shorts, or a bare 11-character id. */
export function parseYoutubeVideoId(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (VIDEO_ID.test(raw)) return raw

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? ''
    return VIDEO_ID.test(id) ? id : null
  }

  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') return null

  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v') ?? ''
    return VIDEO_ID.test(id) ? id : null
  }

  const parts = url.pathname.split('/').filter(Boolean)
  if ((parts[0] === 'embed' || parts[0] === 'shorts') && parts[1] && VIDEO_ID.test(parts[1])) return parts[1]
  return null
}

function stripVideoLabels(value: string): string {
  return value
    .replace(/\s*[([【][^()[\]【】]{0,120}[)\]】]/gu, (match) => (VIDEO_LABEL.test(match) ? '' : match))
    .replace(/\s*\|\s*(?:official(?:\s+music)?\s+(?:video|audio)|lyrics|audio)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function stripFeaturing(title: string): string {
  return title
    .replace(/\s*[([【][^()[\]【】]*(?:featuring|feat\.?|ft\.?)[^()[\]【】]*[)\]】]/gi, '')
    .replace(/\s+(?:featuring|feat\.?|ft\.?)\s+.+$/i, '')
    .trim()
}

function usablePart(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value) && !/^(official|video|audio|lyrics|topic)$/i.test(value.trim())
}

/** Artist and song read from a video title, or from a YouTube Topic channel. */
export function parseSongFromVideo(title: string, author: string): { title: string; artist: string } | null {
  const cleaned = stripVideoLabels(title)
  const separators = [' — ', ' – ', ' - ', ' | ']
  for (const separator of separators) {
    const index = cleaned.indexOf(separator)
    if (index <= 0) continue
    const artist = cleaned.slice(0, index).trim()
    const song = stripFeaturing(stripVideoLabels(cleaned.slice(index + separator.length)))
    if (usablePart(artist) && usablePart(song)) return { artist, title: song }
  }

  const topic = author.trim().match(/^(.*?)\s+-\s+Topic$/i)
  const song = stripFeaturing(cleaned)
  if (topic?.[1] && usablePart(topic[1]) && usablePart(song)) return { artist: topic[1].trim(), title: song }
  return null
}

async function fetchOembed(videoId: string): Promise<{ title: string; author: string } | null> {
  const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(12000) })
    if (!res.ok) return null
    const json = (await res.json()) as { title?: string; author_name?: string }
    if (!json.title?.trim()) return null
    return { title: json.title.trim(), author: json.author_name?.trim() ?? '' }
  } catch {
    return null
  }
}

async function fetchSnippet(videoId: string): Promise<{ title: string; author: string } | null> {
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) return null
  const url = new URL('https://www.googleapis.com/youtube/v3/videos')
  url.searchParams.set('part', 'snippet')
  url.searchParams.set('id', videoId)
  url.searchParams.set('key', apiKey)
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
    if (!res.ok) return null
    const json = (await res.json()) as { items?: Array<{ snippet?: { title?: string; channelTitle?: string } }> }
    const snippet = json.items?.[0]?.snippet
    if (!snippet?.title?.trim()) return null
    return { title: snippet.title.trim(), author: snippet.channelTitle?.trim() ?? '' }
  } catch {
    return null
  }
}

export async function identifyYoutubeSong(videoId: string): Promise<{ title: string; artist: string }> {
  const meta = (await fetchOembed(videoId)) ?? (await fetchSnippet(videoId))
  if (!meta) throw new Error('Could not read that YouTube video.')
  const song = parseSongFromVideo(meta.title, meta.author)
  if (!song) throw new Error("This video title doesn't name both a song and an artist.")
  return song
}

type SearchItem = { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; description?: string } }

const NOT_THE_RECORDING = /\b(?:live|cover|karaoke|tutorial|lesson|reaction|remix|instrumental|slowed|sped up|nightcore|8d|bass boosted|muffled)\b/i

function norm(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function mentions(text: string, name: string): boolean {
  return ` ${norm(text)} `.includes(` ${norm(name)} `)
}

/**
 * How well a search result fits the requested recording, or null when it is someone else's.
 * Official uploads rank first: "Official" from the artist's own or VEVO channel, then other official uploads,
 * then the artist's auto-generated "- Topic" channel, then any other upload by the artist.
 */
function scoreResult(item: SearchItem, artist: string, title: string): number | null {
  const videoTitle = decodeEntities(item.snippet?.title ?? '')
  const channel = decodeEntities(item.snippet?.channelTitle ?? '')
  const description = decodeEntities(item.snippet?.description ?? '')
  const lead = artist.split(/\s+(?:feat\.?|featuring|ft\.?|with|x|&)\s+/i)[0]?.trim() || artist
  if (!mentions(videoTitle, stripFeaturing(title))) return null

  const channelName = norm(channel.replace(/\s+-\s+topic$/i, '').replace(/vevo$/i, '').replace(/\bofficial\b/gi, ''))
  const ownChannel = channelName === norm(lead)
  const topic = /\s+-\s+topic$/i.test(channel) && ownChannel
  const billed = ownChannel || mentions(videoTitle, lead) || mentions(description, lead)
  if (!billed) return null
  // A title like "Howlin' Wolf - Wang Dang Doodle" names a different artist.
  const named = parseSongFromVideo(videoTitle, channel)
  const otherArtist = named && mentions(named.title, stripFeaturing(title)) && !mentions(named.artist, lead) && !mentions(lead, named.artist)
  if (otherArtist && !ownChannel) return null
  if (NOT_THE_RECORDING.test(videoTitle) && !NOT_THE_RECORDING.test(title)) return -1

  const official = /\bofficial\b/i.test(videoTitle) || /vevo$/i.test(channel.replace(/\s+/g, ''))
  if (official && ownChannel) return 4
  if (official) return 3
  if (topic) return 2
  return 1
}

export async function findYoutubeVideoId(artist: string, title: string): Promise<string | null> {
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) return null

  const url = new URL('https://www.googleapis.com/youtube/v3/search')
  url.searchParams.set('part', 'snippet')
  url.searchParams.set('q', `${artist} ${title}`)
  url.searchParams.set('type', 'video')
  // A search costs the same quota for 10 results as for 1, and the top hit is often a more famous version by someone else.
  url.searchParams.set('maxResults', '10')
  url.searchParams.set('key', apiKey)

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
    if (!res.ok) return null
    const json = (await res.json()) as { items?: SearchItem[] }
    let best: { id: string; score: number } | null = null
    for (const item of json.items ?? []) {
      const id = item.id?.videoId
      const score = id ? scoreResult(item, artist, title) : null
      if (id && score !== null && (!best || score > best.score)) best = { id, score }
    }
    return best?.id ?? null
  } catch {
    return null
  }
}
