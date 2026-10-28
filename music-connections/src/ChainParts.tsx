import { useState } from 'react'
import type { ChainVia, RelatedSong, SongCredit } from './types.ts'

function creditSummary(credit: SongCredit): string {
  const otherRoles = credit.instruments ? credit.roles.filter((role) => role !== 'performer' && role !== 'musician') : credit.roles
  const instrumentLabel = credit.instruments
    ? credit.instruments.length > 0
      ? credit.instruments.join(', ')
      : 'instrument unknown'
    : null
  return [instrumentLabel, ...otherRoles].filter(Boolean).join(', ')
}

const MUSICIANS_SHOWN = 5

/** Everyone except musicians, plus the first few musicians unless the list is expanded. */
function visibleCredits(credits: SongCredit[], expanded: boolean): { shown: SongCredit[]; hidden: number; musicians: number } {
  const onlyMusician = (credit: SongCredit) => credit.roles.every((role) => role === 'musician')
  const musicians = credits.filter(onlyMusician).length
  if (expanded || musicians <= MUSICIANS_SHOWN) return { shown: credits, hidden: 0, musicians }
  let kept = 0
  const shown = credits.filter((credit) => !onlyMusician(credit) || kept++ < MUSICIANS_SHOWN)
  return { shown, hidden: credits.length - shown.length, musicians }
}

function relatedPhrase(related: RelatedSong): string {
  const verb =
    related.role === 'producer'
      ? 'Also produced'
      : related.role === 'songwriter'
        ? 'Also wrote'
        : related.role === 'featured artist'
          ? 'Also featured on'
          : related.role === 'musician'
            ? 'Also played on'
            : 'Also performed'
  return `${verb} “${related.title}” by ${related.artist}`
}

/** How a chain got from one song to the next, as in "via Paul Epworth, who also produced this". */
function viaPhrase(via: ChainVia): string {
  const verb =
    via.role === 'producer'
      ? 'produced'
      : via.role === 'songwriter'
        ? 'wrote'
        : via.role === 'featured artist'
          ? 'featured on'
          : via.role === 'musician'
            ? 'played on'
            : 'performed'
  return `via ${via.person}, who also ${verb} this`
}

/** Credits for one song. Without `onOpenRelated` the related songs show as plain text, as on a shared chain. */
export function CreditList({
  credits,
  linksDisabled = false,
  onOpenRelated,
}: {
  credits: SongCredit[]
  linksDisabled?: boolean
  onOpenRelated?: (related: RelatedSong, person: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const { shown, hidden, musicians } = visibleCredits(credits, expanded)
  return (
    <>
      <ol>
        {shown.map((credit) => (
          <li key={`${credit.person}-${credit.roles.join(',')}`}>
            <strong>{credit.person}</strong>
            {` — ${creditSummary(credit)}`}
            {credit.related && onOpenRelated ? (
              <button
                type="button"
                className="credit-related-link"
                disabled={linksDisabled}
                onClick={() => onOpenRelated(credit.related as RelatedSong, credit.person)}
              >
                {relatedPhrase(credit.related)}
              </button>
            ) : credit.related ? (
              <span className="credit-related">{relatedPhrase(credit.related)}</span>
            ) : null}
          </li>
        ))}
      </ol>
      {hidden > 0 ? (
        <button type="button" className="credits-more" onClick={() => setExpanded(true)}>
          Show {hidden} more {hidden === 1 ? 'musician' : 'musicians'}
        </button>
      ) : expanded && musicians > MUSICIANS_SHOWN ? (
        <button type="button" className="credits-more" onClick={() => setExpanded(false)}>
          Show fewer musicians
        </button>
      ) : null}
    </>
  )
}

export type BannerSong = {
  title: string
  artist: string
  rank: number | null
  chartName: string | null
  week: string | null
}

export function SongBanner({
  song,
  expanded,
  className,
  onSelect,
}: {
  song: BannerSong
  expanded: boolean
  className: string
  onSelect: () => void
}) {
  const showRank = song.rank != null && Boolean(song.chartName)
  return (
    <button type="button" className={className} aria-expanded={expanded} onClick={onSelect}>
      {showRank ? (
        <p className="now-playing-rank">
          <span className="rank-label">No.</span> {song.rank}
        </p>
      ) : null}
      <div className="now-playing-copy">
        <h2>{song.title}</h2>
        <p className="now-playing-artist">{song.artist}</p>
        {song.chartName ? (
          <p className="now-playing-meta">
            {song.chartName}
            {song.week ? ` · week of ${song.week}` : ''}
          </p>
        ) : null}
      </div>
    </button>
  )
}

/** The connector drawn between two songs in a chain, with who linked them when that is known. */
export function SongLink({ via }: { via: ChainVia | null | undefined }) {
  return (
    <>
      <div className="song-link" aria-hidden="true" />
      {via ? <p className="song-via">{viaPhrase(via)}</p> : null}
    </>
  )
}

export function YoutubePlayer({ videoId, title }: { videoId: string; title: string }) {
  return (
    <div className="player">
      <iframe
        src={`https://www.youtube.com/embed/${videoId}`}
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
    </div>
  )
}
