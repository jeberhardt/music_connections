import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { ChainStep, SavedChain } from '../src/types.ts'

const API_VERSION = 'v2025-02-19'
const SHARE_ID = /^[a-z0-9]{10}$/
const ROLES = ['performer', 'featured artist', 'songwriter', 'producer', 'musician'] as const

const text = (max: number) => z.string().trim().min(1).max(max)

const creditSchema = z.object({
  person: text(200),
  roles: z.array(z.enum(ROLES)).min(1).max(5),
  instruments: z.array(text(200)).max(30).optional(),
  related: z.object({ title: text(300), artist: text(300), role: z.enum(ROLES) }).optional(),
})

const stepSchema = z.object({
  title: text(300),
  artist: text(300),
  youtubeVideoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).nullable(),
  rank: z.number().int().min(1).max(500).nullable(),
  chartName: z.string().max(200).nullable(),
  week: z.string().max(100).nullable(),
  via: z.object({ person: text(200), role: z.enum(ROLES) }).nullable(),
  credits: z.array(creditSchema).max(80),
})

export const chainInputSchema = z.object({ steps: z.array(stepSchema).min(1).max(50) })

function sanity(): { projectId: string; dataset: string; writeToken?: string } {
  const projectId = process.env.SANITY_PROJECT_ID?.trim()
  const dataset = process.env.SANITY_DATASET?.trim() || 'production'
  if (!projectId) throw new Error('SANITY_PROJECT_ID is missing')
  return { projectId, dataset, writeToken: process.env.SANITY_WRITE_TOKEN?.trim() }
}

/** Ten lowercase letters and digits, which keeps shared links short. */
function newShareId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return [...randomBytes(10)].map((byte) => alphabet[byte % alphabet.length]).join('')
}

function chainTitle(steps: ChainStep[]): string {
  return steps.map((step) => step.title).join(' → ')
}

/** Arrays of objects in Sanity need a _key on each item and a _type naming the object type. */
function toDocument(shareId: string, steps: ChainStep[]) {
  const key = () => randomBytes(6).toString('hex')
  return {
    _type: 'chain',
    shareId,
    title: chainTitle(steps),
    createdAt: new Date().toISOString(),
    steps: steps.map((step) => ({
      ...step,
      _key: key(),
      _type: 'chainStep',
      credits: step.credits.map((credit) => ({ ...credit, _key: key(), _type: 'songCredit' })),
    })),
  }
}

export async function saveChain(steps: ChainStep[]): Promise<string> {
  const { projectId, dataset, writeToken } = sanity()
  if (!writeToken) throw new Error('SANITY_WRITE_TOKEN is missing')
  const shareId = newShareId()
  const response = await fetch(`https://${projectId}.api.sanity.io/${API_VERSION}/data/mutate/${dataset}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${writeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutations: [{ create: toDocument(shareId, steps) }] }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Sanity refused the chain (${response.status}): ${(await response.text()).slice(0, 200)}`)
  return shareId
}

const CHAIN_QUERY = `*[_type == "chain" && shareId == $shareId][0]{
  shareId, title, createdAt,
  steps[]{ title, artist, youtubeVideoId, rank, chartName, week, via,
    credits[]{ person, roles, instruments, related } }
}`

/** Reads a saved chain from Sanity's CDN. The dataset is public, so no token is needed. */
export async function loadChain(shareId: string): Promise<SavedChain | null> {
  if (!SHARE_ID.test(shareId)) return null
  const { projectId, dataset } = sanity()
  const params = new URLSearchParams({ query: CHAIN_QUERY, $shareId: JSON.stringify(shareId) })
  const response = await fetch(`https://${projectId}.apicdn.sanity.io/${API_VERSION}/data/query/${dataset}?${params}`, {
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Could not read the chain from Sanity (${response.status})`)
  const body = (await response.json()) as { result?: SavedChain | null }
  const chain = body.result
  if (!chain) return null
  // Sanity leaves out empty fields, so missing ones come back as null rather than undefined.
  return {
    ...chain,
    steps: (chain.steps ?? []).map((step) => ({
      title: step.title,
      artist: step.artist,
      youtubeVideoId: step.youtubeVideoId ?? null,
      rank: step.rank ?? null,
      chartName: step.chartName ?? null,
      week: step.week ?? null,
      via: step.via ?? null,
      credits: (step.credits ?? []).map((credit) => ({
        person: credit.person,
        roles: credit.roles ?? [],
        ...(credit.instruments ? { instruments: credit.instruments } : {}),
        ...(credit.related ? { related: credit.related } : {}),
      })),
    })),
  }
}
