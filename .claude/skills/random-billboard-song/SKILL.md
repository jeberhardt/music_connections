---
name: random-billboard-song
description: Pick a truly random song from a Billboard song chart within the last N years; the user can name the chart (Hot 100, Country, R&B/Hip-Hop, Pop Airplay, Latin, Rock & Alternative) or leave it random.
---

# Random Billboard song

Pick a real song that appeared on a real Billboard chart during a random week in the last N years. This uses the same rules as the Music Connections app (`src/charts.ts`, `server/billboard.ts`).

## Inputs
- **years** (required): how many years back from today to look. If the user didn't give a number, ask. If they can't be asked, use 40, the app's default.
- **chart** (optional): the chart the user names. Match their wording to a slug using the table below. If they don't name a chart, pick one at random from the charts that have weeks in the range.
- **count** (optional, default 1): how many distinct songs to take from the same chart week.

## Charts
| slug | name | user might say | first week |
|---|---|---|---|
| hot-100 | Billboard Hot 100 | Hot 100, the Billboard chart, pop chart (no "airplay") | 1958-08-04 |
| country-songs | Hot Country Songs | country | 1958-10-20 |
| r-b-hip-hop-songs | Hot R&B/Hip-Hop Songs | R&B, hip-hop, rap, soul, urban | 1958-10-20 |
| pop-songs | Pop Airplay | Pop Airplay, Mainstream Top 40, pop radio | 1992-10-03 |
| latin-songs | Hot Latin Songs | Latin | 1986-09-20 |
| hot-rock-songs | Hot Rock & Alternative Songs | rock, alternative, alt | 2009-06-20 |

## Handling a named chart
- **Ambiguous names.** If the wording could match two charts (for example "pop" could be the Hot 100 or Pop Airplay), ask which one is meant. If the user can't be asked, use the closer match and say which chart you used.
- **Unsupported charts.** If the user names a chart not in the table (Billboard 200, Dance/Electronic, Adult Contemporary, a year-end chart, a non-US chart), say this skill covers only the six song charts above and ask which one to use. Don't substitute a chart quietly.
- **Charts that start later.** If a chart's first week falls inside the requested range, the window starts at that first week. Tell the user, for example: "Hot Rock & Alternative Songs began in June 2009, so the pick comes from June 2009 onward."
- **Retries stay on the named chart.** If the user named a chart, every retry draws a new week on that chart only.

## Rules
- **Use code for the randomness.** Never choose a week, chart or song "as if at random" in your head, because model picks are heavily biased toward famous songs. Run the scripts below for each random choice.
- **Only report songs read from the chart page itself.** Never fill in a title, artist or rank from memory.
- **Billboard chart weeks are Saturdays.** The window runs from the later of (today minus N years) and the chart's first week, up to the most recent Saturday on or before today.

## Steps

### 1. Pick the chart and week
Run this in Python, editing `YEARS` and `CHART`:

```python
import random, datetime as dt
YEARS = 10            # user's number of years
CHART = None          # slug of the chart the user named, or None for any chart
CHARTS = {
  'hot-100': ('Billboard Hot 100', '1958-08-04'),
  'country-songs': ('Hot Country Songs', '1958-10-20'),
  'r-b-hip-hop-songs': ('Hot R&B/Hip-Hop Songs', '1958-10-20'),
  'pop-songs': ('Pop Airplay', '1992-10-03'),
  'latin-songs': ('Hot Latin Songs', '1986-09-20'),
  'hot-rock-songs': ('Hot Rock & Alternative Songs', '2009-06-20'),
}
if CHART is not None and CHART not in CHARTS:
    raise SystemExit(f'Unknown chart {CHART!r}; use one of {list(CHARTS)}')
today = dt.date.today()
try:
    start = today.replace(year=today.year - YEARS)
except ValueError:  # today is Feb 29
    start = today.replace(year=today.year - YEARS, day=28)

def bounds(since):
    s = max(start, dt.date.fromisoformat(since))
    first = s + dt.timedelta(days=(5 - s.weekday()) % 7)        # first Saturday on/after s
    last = today - dt.timedelta(days=(today.weekday() - 5) % 7)  # last Saturday on/before today
    return (first, last) if first <= last else None

slugs = [CHART] if CHART else [k for k, (_, since) in CHARTS.items() if bounds(since)]
slug = random.choice(slugs)
first, last = bounds(CHARTS[slug][1])
week = first + dt.timedelta(weeks=random.randint(0, (last - first).days // 7))
clipped = dt.date.fromisoformat(CHARTS[slug][1]) > start
print(slug, CHARTS[slug][0], week.isoformat(), 'window starts at chart launch' if clipped else '')
```

If the script prints "window starts at chart launch", mention that in the output.

### 2. Read the chart
Fetch `https://www.billboard.com/charts/<slug>/<YYYY-MM-DD>/` with WebFetch, and ask for every row's rank, title and artist, plus the "Week of …" date in the page header.

- **Check the week.** The header must read "Week of <Month D, YYYY>" for the date you asked for. If Billboard redirected to another week or the latest chart, treat the fetch as a failure.
- **Hot 100 fallback.** If the Billboard page fails for the Hot 100, use `https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main/date/<YYYY-MM-DD>.json`. Its `data[]` rows have `song`, `artist` and `this_week` (the rank).
- **Other charts.** If any other chart's fetch fails, or the page has no rows, go back to step 1 and draw a new week. Draw a new chart too only if the user didn't name one. Give up after 8 tries and report which weeks failed.

### 3. Pick the song
Count the rows you actually got. Chart lengths vary: the Hot 100 has 100 rows, while the others have 25 or 50. Draw the position in code:

```python
import random
N_ROWS = 50   # number of rows read from the page
COUNT = 1
print(sorted(random.sample(range(1, N_ROWS + 1), COUNT)))
```

Take the songs at those positions in the ranked list.

## Output
For each song give:

**Title** by **Artist**: #rank on the *Chart name*, week of Month D, YYYY

Then add the chart page URL as a source. Also mention:
- if the window was shortened because the chart started later
- if the Hot 100 archive fallback was used
- if you had to retry

Add nothing else, such as trivia or credits, unless the user asks.
