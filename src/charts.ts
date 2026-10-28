export const SONG_CHARTS = [
  { slug: 'hot-100', name: 'Billboard Hot 100', since: '1958-08-04' },
  { slug: 'country-songs', name: 'Hot Country Songs', since: '1958-10-20' },
  { slug: 'r-b-hip-hop-songs', name: 'Hot R&B/Hip-Hop Songs', since: '1958-10-20' },
  { slug: 'pop-songs', name: 'Pop Airplay', since: '1992-10-03' },
  { slug: 'latin-songs', name: 'Hot Latin Songs', since: '1986-09-20' },
  { slug: 'hot-rock-songs', name: 'Hot Rock & Alternative Songs', since: '2009-06-20' },
] as const

export type ChartSlug = (typeof SONG_CHARTS)[number]['slug']

export function findChart(slug: string) {
  return SONG_CHARTS.find((chart) => chart.slug === slug)
}

const LOOKBACK_YEARS = 40
const DAY_MS = 24 * 60 * 60 * 1000

function utcDay(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day))
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

/** First and last Saturday inside the chart window, optionally limited to one year. */
export function chartWeekBounds(now = new Date(), since?: string, year?: number): { start: Date; end: Date } | null {
  const today = utcDay(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  let start = utcDay(today.getUTCFullYear() - LOOKBACK_YEARS, today.getUTCMonth(), today.getUTCDate())
  let end = today

  if (since) {
    const earliest = new Date(`${since}T00:00:00Z`)
    if (Number.isNaN(earliest.getTime())) return null
    if (earliest > start) start = earliest
  }

  if (year != null) {
    const yearStart = utcDay(year, 0, 1)
    const yearEnd = utcDay(year, 11, 31)
    if (yearStart > start) start = yearStart
    if (yearEnd < end) end = yearEnd
  }

  const firstSaturday = addUtcDays(start, (6 - start.getUTCDay() + 7) % 7)
  const lastSaturday = addUtcDays(end, -((end.getUTCDay() - 6 + 7) % 7))
  if (firstSaturday.getTime() > lastSaturday.getTime()) return null
  return { start: firstSaturday, end: lastSaturday }
}

export function availableChartYears(now = new Date(), since?: string): number[] {
  const endYear = now.getUTCFullYear()
  const years: number[] = []
  for (let year = endYear; year >= endYear - LOOKBACK_YEARS; year--) {
    if (chartWeekBounds(now, since, year)) years.push(year)
  }
  return years
}

export function randomSaturday(now = new Date(), since?: string, year?: number): string {
  const bounds = chartWeekBounds(now, since, year)
  if (!bounds) {
    throw new Error(year != null ? `No chart weeks in ${year}` : 'No chart weeks in range')
  }
  const weeks = Math.round((bounds.end.getTime() - bounds.start.getTime()) / (7 * DAY_MS))
  const index = Math.floor(Math.random() * (weeks + 1))
  return addUtcDays(bounds.start, index * 7).toISOString().slice(0, 10)
}
