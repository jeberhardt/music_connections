/**
 * Reads an API response that should be JSON. A dropped connection, a dev server restart or a
 * platform timeout page can leave the body empty or HTML, so those become a readable error.
 */
export async function readJson<T>(res: Response): Promise<T & { error?: string }> {
  const text = await res.text()
  try {
    return JSON.parse(text) as T & { error?: string }
  } catch {
    const reason = res.status === 504 || res.status === 408 ? 'took too long' : 'stopped before it finished'
    throw new Error(`The server ${reason}. Try again.`)
  }
}
