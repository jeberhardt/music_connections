# Task: Connect two Billboard-charting songs through a chain of hard links

**Song A:** [Title] by [Artist]
**Song B:** [Title] by [Artist]

Find the shortest chain of songs connecting Song A to Song B, where every
step between two songs is a documented, verifiable "hard link." Aim for
6 links or fewer.

## What counts as a link (allowed)

A link connects two songs that share a real person or a direct musical
relationship:

1. **Same performer:** the same artist is the lead or featured performer
   on both songs (a band counts as its members, e.g. a duo member links
   the duo's songs to that member's solo or featured work).
2. **Shared songwriter:** the same person has a writing credit on both songs.
3. **Shared producer:** the same person or production team produced both songs.
4. **Sample or interpolation:** one song officially samples or
   interpolates the other.
5. **Cover:** one song is a recording of the other's composition.
6. **Production-team member:** when a track credits a production team or
   duo, a member that a source actually names counts as that person on
   the track. The step must name the member and the team. S*A*M and
   Sluggo are Sam Hollander and Dave Katz when their page says so; The
   Neptunes are Pharrell Williams and Chad Hugo on the same kind of
   evidence. If both songs credit the team itself, that shared team
   credit is still one link.

## What does NOT count (disallowed)

- Shared chart weeks or being on the chart at the same time
- Shared themes, moods, titles, words or wordplay
- Shared genre, label, publisher, nationality or hometown
- Viral trends, memes or social media moments
- Awards, festivals, tours or award-show appearances
- Influence, admiration or "inspired by" claims
- Unofficial mashups or fan remixes

## Method

1. **Pull full credits for both endpoint songs.** List every performer,
   featured artist, songwriter and producer. Record real names as well as
   stage names, since credits often list legal names (e.g. a rapper's
   writing credit may appear under their birth name).
2. **Search from both ends at once.** For each person on Song A and Song B,
   find their other hit songs. Look for any person or song that appears
   on both sides. This meet-in-the-middle approach is much faster than
   searching from one end.
3. **Prioritize hubs.** Producers and songwriters with many hits (and
   featured artists who appear on many tracks) connect far more songs
   than single-album artists. When stuck, move toward the most
   prolific collaborator available.
4. **Prefer charting intermediate songs.** Where possible, every song in
   the chain should itself have charted on the Billboard Hot 100. Note
   any intermediate song that did not chart.
5. **Shorten the chain.** Once one path is found, check whether any two
   non-adjacent songs in it share a person, which would let you skip steps.
6. **Verify every link individually.** Confirm each credit from a source
   before using it. Do not rely on memory for credits. If a credit cannot
   be confirmed, drop that link and find another.

## Sources to use

Check sources in this order. MusicBrainz is last and only fills credits
the sources above did not already establish.

1. **Wikipedia** song and album pages, for songwriter and producer credits.
   Use the public MediaWiki API. Parse infoboxes and credit sections.
   Follow album pages when the song page is thin. Record legal names and
   stage names, including S*A*M = Sam Hollander when a page says so.
   When a credit names a team or duo, use that team's page for the
   members it actually lists.
2. **Billboard** chart pages and articles, which also print songwriter and
   producer credits. Chart co-appearance is not a link. Credits printed
   by Billboard are usable. Look up a Billboard article when a chart page
   has no credits.
3. **Streaming services**, especially Deezer and Shazam, for credits on
   newer or less-documented songs. Use an official Deezer or Shazam
   endpoint when it returns writer, producer, or performer credits. If
   Shazam has no official API, read the public song page's structured
   credit data. Do not subscribe to a paid unofficial API.
4. **Music news sites and label press releases**, to confirm features,
   remixes, and production roles. Use web search and fetch the specific
   article that states the credit. A credit counts only when the page
   states it.
5. **SecondHandSongs** for covers and samples, **Discogs** only when
   DISCOGS_TOKEN is set, and **Wikidata** only for band membership when
   a membership link is not already confirmed.
6. **MusicBrainz** last, for credits and relationships the sources above
   did not already establish. A member-of relation is membership
   evidence when an earlier source has not already stated it.

WhoSampled has no public API. Do not scrape it.

When sources conflict, prefer the official credit (label press release,
streaming service, or Billboard listing) over a Wikipedia write-up, and
prefer any of those over MusicBrainz.

## Edge cases to flag

- **Remixes and alternate versions:** if a link only exists through an
  official remix (e.g. a version with a new featured artist), say so
  explicitly, since some people will not count it as the same song.
- **Group vs. member:** if a link runs through a band or team member
  rather than the group itself, name the member and the team.
- **Uncredited contributions:** do not use them unless an official credit
  confirms them.

## Output format

1. One line stating the number of links.
2. A numbered list, one step per link. For each step, name the connecting
   person or relationship in bold, the two songs it connects, and the
   specific role on each song (performer, featured artist, songwriter,
   producer).
3. A sources list with a link for each credit used.
4. Any caveats (remixes, non-charting intermediate songs, unverified
   details).
5. If no chain of 6 or fewer links can be found, say so, show the
   shortest verified chain found, and name the steps that were hardest
   to bridge.
