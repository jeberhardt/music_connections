import { useEffect, type KeyboardEvent } from 'react'
import {
  BaseEdge,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getStraightPath,
  useInternalNode,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { BannerSong } from './ChainParts.tsx'
import type { ChainVia } from './types.ts'
import { layoutSongMap } from './songMap.ts'
import { viaPhrase } from './viaPhrase.ts'

export type TreeSong = BannerSong & {
  id: string
  /** The song whose credits this one was picked from; null for a song that starts the map. */
  parentId: string | null
  via: ChainVia | null
  /** Other songs whose credits also led here after this song was on the map; each gets its own line. */
  links: { parentId: string; via: ChainVia }[]
}

type SongNodeData = { song: TreeSong; open: boolean }
type SongNode = Node<SongNodeData, 'song'>

/** Card size in the map, in pixels; the layout spaces the cards by it. */
const NODE = { width: 176, height: 72 }
const PAN_STEP = 80

const nodeTypes = { song: SongCard }
const edgeTypes = { centre: CentreEdge }

/**
 * The songs as a map you can pan and zoom. Each song picked from another song's credits has its own line
 * from that song, so any song can lead to any number of others.
 *
 * Mouse: drag to pan, scroll or pinch to zoom, click a song to open it.
 * Keyboard: Tab moves between songs, Enter or Space opens one, arrow keys pan, + and − zoom, 0 fits the map.
 */
export function SongGraph(props: { songs: TreeSong[]; openId: string | null; onSelect: (id: string) => void }) {
  return (
    <ReactFlowProvider>
      <SongGraphInner {...props} />
    </ReactFlowProvider>
  )
}

function SongGraphInner({ songs, openId, onSelect }: { songs: TreeSong[]; openId: string | null; onSelect: (id: string) => void }) {
  const { fitView, getViewport, setViewport, zoomIn, zoomOut } = useReactFlow()

  const layout = layoutSongMap(songs, NODE)
  // Which songs there are and where each came from; the view refits when this changes.
  const shape = songs.map((song) => `${song.id}<${song.parentId ?? ''}`).join(',')

  const nodes: SongNode[] = songs.flatMap((song) => {
    const point = layout.points.get(song.id)
    if (!point) return []
    const ways = [song.via, ...song.links.map((link) => link.via)].flatMap((via) => (via ? [viaPhrase(via)] : []))
    const label = [`${song.parentId === null ? 'Start: ' : ''}${song.title} by ${song.artist}`, ...ways].join(', ')
    return [
      {
        id: song.id,
        type: 'song',
        position: point,
        data: { song, open: song.id === openId },
        width: NODE.width,
        height: NODE.height,
        ariaLabel: label,
        draggable: false,
        connectable: false,
      },
    ]
  })
  const edges: Edge[] = songs.flatMap((song) =>
    [song.parentId, ...song.links.map((link) => link.parentId)].flatMap((from) =>
      from && layout.points.has(from) ? [{ id: `${from}>${song.id}`, source: from, target: song.id, type: 'centre', focusable: false }] : [],
    ),
  )

  // Fit the whole map in view whenever a song is added.
  useEffect(() => {
    const frame = requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 200, maxZoom: 1 }))
    return () => cancelAnimationFrame(frame)
  }, [shape, fitView])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (target.closest('.react-flow__controls')) return
    const nodeId = target.closest('.react-flow__node')?.getAttribute('data-id')
    if (nodeId && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      onSelect(nodeId)
      return
    }
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [PAN_STEP, 0],
      ArrowRight: [-PAN_STEP, 0],
      ArrowUp: [0, PAN_STEP],
      ArrowDown: [0, -PAN_STEP],
    }
    const step = pan[event.key]
    if (step) {
      event.preventDefault()
      const viewport = getViewport()
      void setViewport({ ...viewport, x: viewport.x + step[0], y: viewport.y + step[1] }, { duration: 100 })
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      void zoomIn({ duration: 150 })
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      void zoomOut({ duration: 150 })
    } else if (event.key === '0') {
      event.preventDefault()
      void fitView({ padding: 0.2, duration: 200, maxZoom: 1 })
    }
  }

  return (
    <div
      className="song-graph"
      role="group"
      aria-label="Song map. Tab to a song and press Enter to open it. Arrow keys pan, plus and minus zoom, 0 fits the map."
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodeOrigin={[0.5, 0.5]}
        onNodeClick={(_, node) => onSelect(node.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        minZoom={0.2}
        maxZoom={2}
        colorMode="system"
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
      >
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

/** A song on the map. The hidden handles exist only because React Flow attaches lines to handles. */
function SongCard({ data }: NodeProps<SongNode>) {
  const { song, open } = data
  // The song the map started from is marked, so the origin of every chain stays easy to find.
  const origin = song.parentId === null
  return (
    <div
      className={`song-map-card${origin ? ' song-map-origin' : ''}${open ? ' now-playing-current' : ''}`}
      aria-current={open ? 'true' : undefined}
    >
      <Handle type="target" position={Position.Top} className="song-graph-handle" isConnectable={false} />
      {origin ? <span className="song-map-start">Start</span> : null}
      <span className="song-map-title">{song.title}</span>
      <span className="song-map-artist">{song.artist}</span>
      {song.via ? <span className="song-map-via">via {song.via.person}</span> : null}
      <Handle type="source" position={Position.Bottom} className="song-graph-handle" isConnectable={false} />
    </div>
  )
}

/** A straight line from the centre of one song to the centre of another, so it can leave in any direction. */
function CentreEdge({ id, source, target }: EdgeProps) {
  const from = useInternalNode(source)
  const to = useInternalNode(target)
  if (!from || !to) return null
  const centre = (node: NonNullable<typeof from>) => ({
    x: node.internals.positionAbsolute.x + (node.measured.width ?? NODE.width) / 2,
    y: node.internals.positionAbsolute.y + (node.measured.height ?? NODE.height) / 2,
  })
  const a = centre(from)
  const b = centre(to)
  const [path] = getStraightPath({ sourceX: a.x, sourceY: a.y, targetX: b.x, targetY: b.y })
  return <BaseEdge id={id} path={path} className="song-graph-edge" />
}
