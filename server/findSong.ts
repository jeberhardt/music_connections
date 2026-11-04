import { generateText, Output } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'

export type FoundSong = {
  title: string
  artist: string
  /** Set when the result needs a word of explanation, such as a random pick from an artist's songs. */
  note: string | null
}

type DeezerTrack = { title?: string; title_short?: string; artist?: { id?: number; name?: string } }
type DeezerArtist = { id?: number; name?: string }

const readingSchema = z.object({
  artist: z.string().nullable(),
  title: z.string().nullable(),
})

const INSTRUCTIONS = `Someone typed a message to say which song or artist they want to hear. Work out what they mean.

- They may type a song, an artist, or both, in any order and with any wording ("hello adele", "adele - hello", "that song hello by adele", "the weeknd").
- Fix misspellings and nicknames to the real names ("beyonse" is Beyoncé, "MJ thriller" is Thriller by Michael Jackson).
- If they describe a song or quote a line from it rather than naming it, give the song you are confident they mean.
- If they name only an artist, leave title empty. If they name only a song, give its best-known artist.
- Leave a field empty rather than guess when you are not confident.`

function norm(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function loosely(a: string, b: string): boolean {
  const x = norm(a)
  const y = norm(b)
  return x !== '' && y !== '' && (x === y || x.includes(y) || y.includes(x))
}

/** Deezer adds release notes to titles, such as "Hello (Remastered 2011)" or "Hello - Live". */
function cleanTitle(track: DeezerTrack): string {
  const title = (track.title_short || track.title || '').trim()
  return title
    .replace(/\s*\((?:feat\.?|featuring|ft\.?|with)\s[^)]*\)/gi, '')
    .replace(/\s+-\s+(?:remaster|live|mono|stereo|single|radio|edit|\d{4}).*$/i, '')
    .trim()
}

async function deezer<T>(path: string): Promise<T[]> {
  try {
    const res = await fetch(`https://api.deezer.com${path}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: T[] }
    return body.data ?? []
  } catch {
    return []
  }
}

function toSong(track: DeezerTrack | undefined, note: string | null = null): FoundSong | null {
  const title = track ? cleanTitle(track) : ''
  const artist = track?.artist?.name?.trim() ?? ''
  return title && artist ? { title, artist, note } : null
}

/** What Claude reads from the text. Null without an API key or when the call fails, so the caller can fall back. */
async function readQuery(query: string): Promise<{ artist: string | null; title: string | null } | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null
  try {
    const { output } = await generateText({
      model: anthropic('claude-opus-5-5'),
      output: Output.object({ schema: readingSchema }),
      providerOptions: { anthropic: { effort: 'low' } },
      system: INSTRUCTIONS,
      prompt: query,
      abortSignal: AbortSignal.timeout(15000),
    })
    if (!output) return null
    return { artist: output.artist?.trim() || null, title: output.title?.trim() || null }
  } catch (error) {
    console.warn('Claude could not read the song search:', error instanceof Error ? error.message : error)
    return null
  }
}

async function findTrack(title: string, artist: string | null): Promise<FoundSong | null> {
  if (artist) {
    const exact = await deezer<DeezerTrack>(`/search?q=${encodeURIComponent(`artist:"${artist}" track:"${title}"`)}&limit=10`)
    const loose = exact.length > 0 ? exact : await deezer<DeezerTrack>(`/search?q=${encodeURIComponent(`${title} ${artist}`)}&limit=10`)
    const match =
      loose.find((track) => loosely(track.artist?.name ?? '', artist) && loosely(cleanTitle(track), title)) ??
      loose.find((track) => loosely(track.artist?.name ?? '', artist))
    if (match) return toSong(match)
  }
  const hits = await deezer<DeezerTrack>(`/search?q=${encodeURIComponent(title)}&limit=10`)
  return toSong(hits.find((track) => loosely(cleanTitle(track), title)) ?? hits[0])
}

/** One of the artist's top songs, chosen at random in code rather than by a model, which would lean to the biggest hit. */
async function randomTopTrack(artist: string): Promise<FoundSong | null> {
  const artists = await deezer<DeezerArtist>(`/search/artist?q=${encodeURIComponent(artist)}&limit=5`)
  const found = artists.find((item) => loosely(item.name ?? '', artist)) ?? artists[0]
  if (!found?.id) return null
  const tracks = (await deezer<DeezerTrack>(`/artist/${found.id}/top?limit=25`)).filter((track) => toSong(track))
  const track = tracks[Math.floor(Math.random() * tracks.length)]
  return toSong(track, `A random pick from ${found.name}'s top songs.`)
}

/** Turns whatever someone typed into a real song, confirmed against Deezer's catalog. */
export async function findSong(query: string): Promise<FoundSong | null> {
  const reading = await readQuery(query)
  if (reading?.title) {
    const song = await findTrack(reading.title, reading.artist)
    if (song) return song
  }
  if (reading?.artist) {
    const song = await randomTopTrack(reading.artist)
    if (song) return song
  }
  // When Claude read the text and found no song or artist in it, a raw search would only return noise.
  if (reading) return null
  // Without Claude (no API key, or the call failed), Deezer's own search gets the raw text.
  const hits = await deezer<DeezerTrack>(`/search?q=${encodeURIComponent(query)}&limit=5`)
  return toSong(hits[0])
}
