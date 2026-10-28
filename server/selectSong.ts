import { generateText, Output } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import type { BillboardChart, ChartEntry } from './billboard.ts'

const pickSchema = z.object({
  songs: z.array(
    z.object({
      title: z.string(),
      artist: z.string(),
      rank: z.number(),
    }),
  ),
})

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function findOnChart(chart: BillboardChart, pick: ChartEntry, used: Set<number>): ChartEntry | undefined {
  const byRank = chart.entries.find((entry) => entry.rank === pick.rank)
  if (byRank && !used.has(byRank.rank)) return byRank

  return chart.entries.find((entry) => {
    if (used.has(entry.rank)) return false
    return (
      normalize(entry.title) === normalize(pick.title) &&
      normalize(entry.artist) === normalize(pick.artist)
    )
  })
}

function fillRandom(chart: BillboardChart, resolved: ChartEntry[], count: number): ChartEntry[] {
  const used = new Set(resolved.map((entry) => entry.rank))
  const result = [...resolved]
  const remaining = chart.entries.filter((entry) => !used.has(entry.rank))

  while (result.length < count && remaining.length > 0) {
    const index = Math.floor(Math.random() * remaining.length)
    const [next] = remaining.splice(index, 1)
    if (!next) break
    result.push(next)
  }

  return result
}

export async function selectSongs(chart: BillboardChart, count: 1 | 2): Promise<ChartEntry[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is missing')
  }

  const list = chart.entries
    .map((entry) => `${entry.rank}. ${entry.title} — ${entry.artist}`)
    .join('\n')

  const { output } = await generateText({
    model: anthropic('claude-sonnet-4-5'),
    output: Output.object({ schema: pickSchema }),
    prompt: `You are selecting songs from a real Billboard chart. Pick exactly ${count} distinct song(s) as if at random from this list only. Do not invent titles, artists, or ranks. Return the exact title, artist, and rank from the list.

Chart: ${chart.name}
Week: ${chart.week}

${list}`,
  })

  if (!output) {
    throw new Error('Claude did not return a song selection')
  }

  const used = new Set<number>()
  const resolved: ChartEntry[] = []
  for (const pick of output.songs) {
    const match = findOnChart(chart, pick, used)
    if (!match) continue
    resolved.push(match)
    used.add(match.rank)
    if (resolved.length >= count) break
  }

  return fillRandom(chart, resolved, count).slice(0, count)
}
