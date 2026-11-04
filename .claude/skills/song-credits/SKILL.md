---
name: song-credits
description: Find the major credits for a song (performers, featured artists, songwriters, producers and the musicians who played on it) from real music reference sources, and optionally another song each person made. Use when the user asks who wrote, produced, sang or played on a song, or asks for a song's credits.
---

# Song credits

List who made a specific recording, using only what reference sources say. This follows the same rules as the Music Connections app (`server/credits.ts`, `server/creditsClaude.ts`), so results from the skill and the app should agree.

## Inputs
- **song** (required): a title and artist. The user may type both loosely ("amor amor amor j lo"). Work out the real title and billed artist, and say which recording you used. If the song is ambiguous (several songs share the title, or the artist is missing and the title is common), ask which one is meant. If the user can't be asked, use the best-known recording and say so.
- **related** (optional): if the user asks for it, add one other song for each person (see step 4).

## Rules
- **Sources only.** Every person you list must be named in a source you actually read in this session. Never add anyone from memory, even if you are sure they were involved. If the sources name nobody for a role, leave the role out.
- **This recording only.** Credit the version the user asked about. When a page covers several versions (an original and a cover, remixes, a re-recording), take the performers from the version whose billing matches, and leave out artists who appear only on other versions.
- **Roles.** Use exactly these five:
  - **performer**: the billed artist, and its members when it is a band
  - **featured artist**: billed as "featuring" or "with"
  - **songwriter**: wrote or composed it, including credited writers of a song it interpolates
  - **producer**: produced it, including a production team named as such
  - **musician**: anyone else a source names as playing or singing on this specific recording (session players, guest instrumentalists, backing vocalists)
- **One entry per person**, with all their roles. A writer or producer who also played keeps that role and gets their instruments; don't list them again as a musician. Merge stage names, nicknames and short references into the name the person is best known by.
- **Bands.** List the band as a performer. List members individually only if the song's own sources name them; use the band's lineup only when the song has no personnel list. Members listed only on the band's page (touring players, other eras) did not necessarily play on this recording, so leave them out. A role credited to the band as a whole ("producer: Queen") goes to the band's entry.
- **Leave out** engineers, mixers, mastering, programming-only credits, arrangers, conductors, labels, studios, managers, and anyone mentioned for another reason (an influence, a cover version, an earlier recording).
- **Names, not things.** Discography tables link chart names, certifications and works next to song titles: Ultratop, Billboard Hot 100, Hot Latin Songs, "BEA: Platinum", album and film titles, Wikipedia category pages. These are never people. If a name you're about to list is a chart, a certification, an album, a film or a page title, drop it.

## Steps

### 1. Identify the recording
Search Deezer to confirm the title and billed artist, and to get the track's album:

`https://api.deezer.com/search?q=artist:"<artist>" track:"<title>"`

Use the result's `title_short` without any "(feat. …)" or " - Remastered" suffix, and `artist.name`. If nothing matches, try `https://api.deezer.com/search?q=<title> <artist>` and pick the hit whose artist matches.

### 2. Read the sources
Fetch these with WebFetch. Wikipedia is the richest; the others fill gaps. Fetch Wikipedia pages one at a time, because it answers bursts of parallel requests with 429 Too Many Requests. On a 429, wait at least 5 seconds before retrying.

1. **The song's Wikipedia article.** Find it with `https://en.wikipedia.org/w/index.php?search=<title> <artist> song` and read it as wikitext (`https://en.wikipedia.org/wiki/<Page_title>?action=raw`). Use the infobox fields `artist`, `writer`, `producer`, plus any section titled Personnel, Credits and personnel, Writing, Production or Recording. Check that the page is about this song by this artist; a title match alone isn't enough.
2. **The album's Wikipedia article**, if the song article is missing or thin: its track listing (writers and producers per track) and its personnel section, but only lines that apply to this track.
3. **MusicBrainz**, when writers or producers are still missing: search `https://musicbrainz.org/ws/2/recording?query=recording:"<title>" AND artist:"<artist>"&fmt=json`, then read `https://musicbrainz.org/ws/2/recording/<id>?inc=artist-credits+artist-rels+work-rels&fmt=json`. Writers are on the linked work: `https://musicbrainz.org/ws/2/work/<id>?inc=artist-rels&fmt=json`. Make at most one MusicBrainz request per second.
4. **Discogs**, if a `DISCOGS_TOKEN` is available and you still need musicians: search the release and read its track-level `extraartists`. Use only credits whose track position covers this song.

Stop when you have the performer, at least one songwriter and at least one producer, or once every source has been tried.

### 3. Build the list
Apply the rules above to what you read. Then check each name once more: it must appear, spelled out, in the source text you are citing. Drop any name that doesn't.

### 4. Related songs (only if asked)
For each person, find one other song they made in the same role, from their own Wikipedia page or discography page (for example "<Name> production discography" or "<Name> singles discography"). Discography tables are where mistakes happen:
- Take the artist from the song's own row, the cell next to the title.
- A song in the singles list on the person's own page, with no other artist in its row, is theirs. "(featuring X)" means the person is the lead and X is featured.
- If the row's only other links are charts, certifications or works, the row has no artist of its own. Don't borrow the artist from an earlier row; skip the song.
- Prefer a different song from the one asked about, and not a remix, live or instrumental version.

## Output
**Title** by **Artist**

For each person, in this order: performers, featured artists, songwriters, producers, musicians:

- **Name**: role(s), plus instruments if a source names them
  - Also: "Other song" by Other Artist (as role), only when related songs were asked for

Then list the source URLs you used. Say which recording you chose if the request was ambiguous, and note any role the sources didn't cover ("No producer credit was found"). Add nothing else, such as trivia or chart history, unless the user asks.
