export type Song = {
  title: string
  artist: string
  rank: number
  chart: string
  chartName: string
  week: string
  youtubeVideoId: string | null
}

export type SongsResponse = {
  songs: Song[]
}

/** A musician played or sang on the recording without being the billed artist or a band member. */
export type CreditRole = 'performer' | 'featured artist' | 'songwriter' | 'producer' | 'musician'

export type RelatedSong = {
  title: string
  artist: string
  role: CreditRole
}

export type SongCredit = {
  person: string
  roles: CreditRole[]
  /** Set for band members and musicians. An empty list means no source named an instrument. */
  instruments?: string[]
  related?: RelatedSong
}

/** The credited person who led from one song in a chain to the next, and their role on the next song. */
export type ChainVia = {
  person: string
  role: CreditRole
}

/** A second way into a song: another song on the map whose credits also pointed to it. */
export type ChainLink = {
  parent: number
  via: ChainVia
}

/** One song in a saved chain, kept exactly as it was shown so a shared link never looks anything up again. */
export type ChainStep = {
  title: string
  artist: string
  youtubeVideoId: string | null
  rank: number | null
  chartName: string | null
  week: string | null
  via: ChainVia | null
  /** Index of the step whose credits this song was picked from; null for the first song. */
  parent: number | null
  /** Later songs whose credits also led here, after this song was already on the map. */
  links: ChainLink[]
  credits: SongCredit[]
}

export type SavedChain = {
  shareId: string
  title: string
  createdAt: string
  steps: ChainStep[]
}

export type SaveChainResponse = {
  shareId: string
  path: string
}

export type SongConnection = {
  summary: string
  emphasis?: string
}

export type ChainSource = {
  label: string
  url: string
}

export type CreditsResponse = {
  credits: SongCredit[]
  sources: ChainSource[]
  notice?: string
}

/** A rank read from a Billboard chart page for a specific week. */
export type ChartAppearance = {
  chart: string
  chartName: string
  rank: number
  week: string
}

export type SongLookupResponse = {
  title: string
  artist: string
  youtubeVideoId: string | null
  chart: ChartAppearance | null
}

export type FindSongResponse = SongLookupResponse & {
  /** Explains the pick when it needs it, such as a random song from an artist named on its own. */
  note: string | null
}

export type TraceEvent = {
  kind: 'found' | 'discarded' | 'following'
  title: string
  artist?: string
  detail: string
  id?: string
  active?: boolean
}

export type ConnectionsResponse = {
  connections: SongConnection[]
  unavailable: string[]
  notice?: string
  traceTrimmed?: number
  headline?: string
  sources?: ChainSource[]
  caveats?: string[]
  hardest?: string
}
