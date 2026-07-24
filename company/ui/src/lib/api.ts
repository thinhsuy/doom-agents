// Where the FastAPI backend lives. Default '' = same origin — works in prod
// (FastAPI serves this FE) and in dev (Vite proxies /api and /ws to :8000).
// Override with VITE_API_BASE to point at an absolute backend.
const BASE = import.meta.env.VITE_API_BASE ?? ''

/** Absolute URL for a REST path, e.g. apiUrl('/api/chat'). */
export const apiUrl = (path: string): string => `${BASE}${path}`

/** WebSocket URL for a path, e.g. wsUrl('/ws/office'). */
export function wsUrl(path: string): string {
  if (BASE) {
    const u = new URL(BASE)
    return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}${path}`
  }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`
}
