/** Reads a stream of server-sent events, handing each one over as it arrives, until the stream ends or is aborted. */
export async function readEvents(res: Response, signal: AbortSignal, onEvent: (event: string, data: string) => void) {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('The response did not stream')
  const decoder = new TextDecoder()
  let buffer = ''
  while (!signal.aborted) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      let event = 'message'
      let data = ''
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (data) onEvent(event, data)
    }
    if (done) break
  }
}
