import { generateText, Output } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import type { ChainSource, CreditRole, SongCredit } from '../src/types.ts'

/** Raw text from one lookup, handed to Claude as-is so it reads the source instead of a regex. */
export type CreditSource = {
  id: string
  label: string
  url: string
  text: string
}

const ROLES = ['performer', 'featured artist', 'songwriter', 'producer', 'musician'] as const satisfies readonly CreditRole[]

const creditsSchema = z.object({
  credits: z.array(
    z.object({
      person: z.string(),
      roles: z.array(z.enum(ROLES)),
      instruments: z.array(z.string()),
      sources: z.array(z.string()),
    }),
  ),
})

function norm(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** True when the name, or at least its surname, is written somewhere in the cited sources. */
function grounded(person: string, texts: string[]): boolean {
  const haystack = ` ${texts.map(norm).join(' ')} `
  const name = norm(person)
  if (!name) return false
  if (haystack.includes(` ${name} `)) return true
  const surname = name.split(' ').at(-1) ?? ''
  return surname.length > 2 && haystack.includes(` ${surname} `)
}

const INSTRUCTIONS = `You read music reference sources and list a recording's major credits.

Rules:
- Use only the sources below. Do not add anyone from your own knowledge, even if you believe they were involved.
- Roles: "performer" (only the billed artist and, when the billed artist is a band, its members), "featured artist" (billed as featuring), "songwriter" (wrote or composed it, including credited writers of interpolated songs), "producer", "musician" (anyone else a source names as playing or singing on this specific recording: session players, guest instrumentalists, backing vocalists).
- The billed artist and band members are always "performer", plus any other roles they had.
- Anyone else who wrote or produced the song and also played keeps their writer or producer role and gets their instruments; do not also mark them "musician" or "performer".
- Musicians listed only on a band's page (touring members, players from other eras) did not necessarily play on this recording, so leave them out unless the song's own sources name them.
- Exclude engineers, mixers, mastering, programming-only credits, arrangers, conductors, labels, studios, managers, and anyone mentioned for some other reason (inspiration, a cover version, an earlier recording).
- Order musicians last.
- Credit only the version billed above. When a source covers several versions (an original, remixes, covers, re-recordings), take performers and featured artists from the version whose billing matches, and leave out artists who appear only on other versions.
- When a source credits a band as a whole for a role (for example "producer: Queen"), give that role to the band's own entry, not to one of its members.
- When the billed artist is a band, list members individually only if the song's own personnel names them. Use the band's lineup only when the song has no personnel list.
- One entry per person. Merge nicknames, stage names and short references ("Ronson", "the former three", "Abel 'The Weeknd' Tesfaye") into the person they refer to, using the name the artist is best known by.
- When the billed artist is a band, list the band itself as a performer too.
- instruments: what this person played or sang on the recording, only if a source says so; otherwise an empty list.
- sources: the ids of the sources that support the entry.
- Order: billed artist, then band members, then featured artists, then songwriters, then producers, then musicians.`

export async function extractCredits(
  title: string,
  artist: string,
  sources: CreditSource[],
): Promise<{ credits: SongCredit[]; sources: ChainSource[] } | null> {
  if (!process.env.ANTHROPIC_API_KEY || sources.length === 0) return null

  const material = sources.map((source) => `<source id="${source.id}" label="${source.label}">\n${source.text}\n</source>`).join('\n\n')
  const { output } = await generateText({
    model: anthropic('claude-haiku-5-5'),
    output: Output.object({ schema: creditsSchema }),
    providerOptions: { anthropic: { effort: 'low' } },
    system: INSTRUCTIONS,
    prompt: `Recording: "${title}" by ${artist}\n\n${material}`,
  })
  if (!output) return null

  const byId = new Map(sources.map((source) => [source.id, source]))
  const credits: SongCredit[] = []
  const used = new Set<string>()
  for (const item of output.credits) {
    const cited = item.sources.map((id) => byId.get(id)).filter((source) => source !== undefined)
    const named = ROLES.filter((role) => item.roles.includes(role))
    // "musician" is for people with no other role; anyone else's playing shows through their instruments.
    const roles = named.some((role) => role !== 'musician') ? named.filter((role) => role !== 'musician') : named
    const person = item.person.trim()
    if (!person || roles.length === 0 || cited.length === 0) continue
    // A name that appears in none of the cited text was not read from them, so it is dropped.
    if (!grounded(person, cited.map((source) => source.text))) continue
    if (credits.some((credit) => norm(credit.person) === norm(person))) continue
    const credit: SongCredit = { person, roles }
    if (item.instruments.length > 0) credit.instruments = item.instruments
    credits.push(credit)
    for (const source of cited) used.add(source.id)
  }
  credits.sort((a, b) => ROLES.indexOf(a.roles[0]!) - ROLES.indexOf(b.roles[0]!))

  return {
    credits,
    sources: sources.filter((source) => used.has(source.id) && source.url).map((source) => ({ label: source.label, url: source.url })),
  }
}
