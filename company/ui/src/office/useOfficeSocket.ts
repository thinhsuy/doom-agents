import { useCallback, useEffect, useRef, useState } from 'react'
import type { OfficeEvent } from './engine'

export type SocketStatus = 'connecting' | 'online' | 'offline'

/**
 * Connect to the office-server WebSocket and buffer events for the game loop to
 * drain each frame (so React re-renders don't fight the canvas). Auto-reconnects.
 */
export function useOfficeSocket(url: string): { status: SocketStatus; drain: () => OfficeEvent[] } {
  const [status, setStatus] = useState<SocketStatus>('connecting')
  const buffer = useRef<OfficeEvent[]>([])

  useEffect(() => {
    let stopped = false
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined

    function connect() {
      if (stopped) return
      setStatus((s) => (s === 'online' ? s : 'connecting'))
      ws = new WebSocket(url)
      ws.onopen = () => setStatus('online')
      ws.onmessage = (e) => {
        try {
          buffer.current.push(JSON.parse(e.data as string) as OfficeEvent)
        } catch {
          /* ignore malformed frames */
        }
      }
      ws.onerror = () => ws?.close()
      ws.onclose = () => {
        setStatus('offline')
        if (!stopped) retry = setTimeout(connect, 2000)
      }
    }
    connect()

    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      ws?.close()
    }
  }, [url])

  const drain = useCallback(() => {
    const b = buffer.current
    buffer.current = []
    return b
  }, [])

  return { status, drain }
}
