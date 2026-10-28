import type { TraceEvent } from '../src/types.ts'

type TraceFn = (event: TraceEvent) => Promise<void> | void

export async function startFollow(onTrace: TraceFn | undefined, line: { title: string; artist?: string; detail: string }) {
  const id = crypto.randomUUID()
  const event = { kind: 'following' as const, id, title: line.title, artist: line.artist, detail: line.detail }
  await onTrace?.({ ...event, active: true })
  return {
    end: () => onTrace?.({ ...event, active: false }),
  }
}
