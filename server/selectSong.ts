import type { BillboardChart, ChartEntry } from './billboard.ts'

/**
 * Draws distinct songs from the chart rows actually read, using code for the randomness.
 * Asking a model to pick "as if at random" leans heavily toward famous songs.
 */
export function selectSongs(chart: BillboardChart, count: 1 | 2): ChartEntry[] {
  const remaining = [...chart.entries]
  const picked: ChartEntry[] = []

  while (picked.length < count && remaining.length > 0) {
    const index = Math.floor(Math.random() * remaining.length)
    const [next] = remaining.splice(index, 1)
    if (next) picked.push(next)
  }

  return picked
}
