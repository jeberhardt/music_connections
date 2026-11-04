import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RelatedSong, SongCredit } from './types.ts'

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

export function YoutubePlayer({ videoId, title }: { videoId: string; title: string }) {
  return (
    <div className="player">
      <iframe
        src={`https://www.youtube.com/embed/${videoId}?autoplay=1`}
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
    </div>
  )
}

/**
 * The open song, shown as a modal popover. While it is open the rest of the page is inert, so no other
 * song can be chosen; Esc, the close button or a click on the backdrop dismiss it.
 */
export function SongDialog({ label, onDismiss, children }: { label: string; onDismiss: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    // Keys pressed inside the YouTube player go to YouTube's page, never this one, so Esc would stop
    // working once the video was clicked. Clicks still reach the player; focus comes back right after.
    const reclaimFocus = () =>
      setTimeout(() => {
        const active = document.activeElement
        if (active instanceof HTMLIFrameElement && dialog.contains(active)) dialog.focus({ preventScroll: true })
      }, 0)
    window.addEventListener('blur', reclaimFocus)
    // Removing an open dialog from the page ends its modal state, so unmounting needs no close() call.
    return () => window.removeEventListener('blur', reclaimFocus)
  }, [])

  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      className="song-dialog"
      aria-label={label}
      onClose={onDismiss}
      onClick={(event) => {
        // A click on the dialog element itself, not on its content, landed on the backdrop.
        if (event.target === event.currentTarget) event.currentTarget.close()
      }}
    >
      <button type="button" className="song-dialog-close" aria-label="Close" onClick={() => ref.current?.close()}>
        ×
      </button>
      {children}
    </dialog>
  )
}
