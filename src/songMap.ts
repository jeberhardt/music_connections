/**
 * Positions for a map of songs: the first song in the middle, and each song picked from another song's
 * credits placed around it on its own line. Branches fan outward, so six or more songs can come from one
 * song, and rings move further out until no two cards overlap.
 */

export type MapInput = { id: string; parentId: string | null }
export type MapPoint = { x: number; y: number }
export type MapLayout = { points: Map<string, MapPoint>; width: number; height: number }

const FULL = Math.PI * 2
const DOWN = Math.PI / 2
const GAP = 16

type Placed = { id: string; depth: number; angle: number }

export function layoutSongMap(songs: MapInput[], node: { width: number; height: number }): MapLayout {
  const ids = new Set(songs.map((song) => song.id))
  const childrenOf = new Map<string | null, string[]>()
  for (const song of songs) {
    const parent = song.parentId !== null && ids.has(song.parentId) ? song.parentId : null
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), song.id])
  }

  const leaves = new Map<string, number>()
  const countLeaves = (id: string): number => {
    const kids = childrenOf.get(id) ?? []
    const count = kids.length === 0 ? 1 : kids.reduce((sum, kid) => sum + countLeaves(kid), 0)
    leaves.set(id, count)
    return count
  }

  // Several starting songs hang off an unseen centre; one starting song is the centre itself.
  const roots = childrenOf.get(null) ?? []
  const centre = roots.length === 1 ? roots[0]! : null
  const placed: Placed[] = []

  const fan = (kids: string[], depth: number, start: number, span: number) => {
    const total = kids.reduce((sum, kid) => sum + countLeaves(kid), 0)
    let at = start
    for (const kid of kids) {
      const share = (span * (leaves.get(kid) ?? 1)) / total
      const angle = at + share / 2
      placed.push({ id: kid, depth, angle })
      // A branch fans within half a circle around its own direction, so it never doubles back over its parent.
      const width = Math.min(share, Math.PI)
      const grandkids = childrenOf.get(kid) ?? []
      if (grandkids.length > 0) fan(grandkids, depth + 1, angle - width / 2, width)
      at += share
    }
  }

  const firstRing = centre ? (childrenOf.get(centre) ?? []) : roots
  // One or two songs leave the centre downward; four or more go all the way round.
  const span = Math.min(FULL, Math.max(1, firstRing.length) * (Math.PI / 2))
  if (centre) placed.push({ id: centre, depth: 0, angle: 0 })
  fan(firstRing, 1, DOWN - span / 2, span)

  // Each ring starts just outside the one before and moves out until its cards clear every card placed so far.
  const points = new Map<string, MapPoint>()
  const stepX = node.width + 48
  const stepY = node.height + 56
  let radiusX = 0
  let radiusY = 0
  const maxDepth = placed.reduce((max, item) => Math.max(max, item.depth), 0)
  if (centre) points.set(centre, { x: 0, y: 0 })

  for (let depth = 1; depth <= maxDepth; depth++) {
    const ring = placed.filter((item) => item.depth === depth)
    const earlier = [...points.values()]
    let scale = 1
    let candidate = new Map<string, MapPoint>()
    for (let attempt = 0; attempt < 60; attempt++) {
      const rx = radiusX + stepX * scale
      const ry = radiusY + stepY * scale
      candidate = new Map(ring.map((item) => [item.id, { x: rx * Math.cos(item.angle), y: ry * Math.sin(item.angle) }]))
      const mine = [...candidate.values()]
      const clashes =
        mine.some((point) => earlier.some((other) => overlaps(point, other, node))) ||
        mine.some((point, index) => mine.slice(index + 1).some((other) => overlaps(point, other, node)))
      if (!clashes) {
        radiusX = rx
        radiusY = ry
        break
      }
      scale *= 1.15
    }
    for (const [id, point] of candidate) points.set(id, point)
  }

  // Move everything so the map starts at the top left, with room for whole cards.
  const all = [...points.values()]
  const minX = Math.min(...all.map((point) => point.x)) - node.width / 2 - GAP
  const minY = Math.min(...all.map((point) => point.y)) - node.height / 2 - GAP
  const maxX = Math.max(...all.map((point) => point.x)) + node.width / 2 + GAP
  const maxY = Math.max(...all.map((point) => point.y)) + node.height / 2 + GAP
  for (const [id, point] of points) points.set(id, { x: point.x - minX, y: point.y - minY })
  return { points, width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY) }
}

function overlaps(a: MapPoint, b: MapPoint, node: { width: number; height: number }): boolean {
  return Math.abs(a.x - b.x) < node.width + GAP && Math.abs(a.y - b.y) < node.height + GAP
}
