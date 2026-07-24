import { useCallback, useEffect, useRef, useState } from 'react'

type CopyState = 'idle' | 'ok' | 'fail'

/**
 * Clipboard write with a transient result flag for button feedback.
 * Falls back to execCommand because navigator.clipboard is unavailable on
 * insecure origins — which includes opening a built bundle over file://.
 */
export function useCopy(resetMs = 1600): [CopyState, (text: string) => void] {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = useCallback(
    (text: string) => {
      const settle = (next: CopyState) => {
        setState(next)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setState('idle'), resetMs)
      }

      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
          () => settle('ok'),
          () => settle('fail'),
        )
        return
      }

      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        settle(document.execCommand('copy') ? 'ok' : 'fail')
      } catch {
        settle('fail')
      }
      document.body.removeChild(ta)
    },
    [resetMs],
  )

  return [state, copy]
}
