import type { SavedChain } from '../src/types.ts'

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The built frontend page. On Vercel the FRONTEND_INTERNAL_URL binding reaches the frontend service directly,
 * which also works on protected preview deployments; elsewhere the page is fetched from the same origin.
 */
export async function fetchIndexHtml(requestUrl: string): Promise<string | null> {
  const base = process.env.FRONTEND_INTERNAL_URL || new URL(requestUrl).origin
  try {
    const response = await fetch(new URL('/index.html', base), { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    const html = await response.text()
    return html.includes('<div id="root">') ? html : null
  } catch {
    return null
  }
}

/** Adds a title and Open Graph tags so a shared chain shows a proper card on social media, which do not run JavaScript. */
export function withShareTags(html: string, chain: SavedChain, pageUrl: string): string {
  const count = chain.steps.length
  const first = chain.steps[0]
  const title = count > 1 ? `${chain.title}` : `${first?.title ?? 'A song'} by ${first?.artist ?? ''}`.trim()
  const description =
    count > 1
      ? `A chain of ${count} songs, each linked to the next by someone credited on both. Start from ${first?.title} by ${first?.artist}.`
      : `${first?.title} by ${first?.artist}, with its credits. Find the songs its writers, producers and players made next.`
  const image = chain.steps.find((step) => step.youtubeVideoId)?.youtubeVideoId
  const tags = [
    `<title>${escapeHtml(title)} · Music Connections</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Music Connections" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
    image ? `<meta property="og:image" content="https://i.ytimg.com/vi/${image}/hqdefault.jpg" />` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
  ].filter(Boolean)
  return html.replace(/<title>[\s\S]*?<\/title>/i, tags.join('\n    '))
}
