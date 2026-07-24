import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icon'
import s from './Drawer.module.css'

interface Props {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  footer?: ReactNode
  onClose: () => void
  children: ReactNode
}

export function Drawer({ open, title, subtitle, footer, onClose, children }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)

  // Escape closes from anywhere, matching the scrim.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Reset scroll and move focus into the dialog when it shows a different record.
  // Focus lands on the panel itself, not the close button: focusing a button paints
  // a focus ring for a mouse-driven open, which reads as a pressed control.
  useEffect(() => {
    if (!open) return
    if (bodyRef.current) bodyRef.current.scrollTop = 0
    panelRef.current?.focus({ preventScroll: true })
  }, [open, title])

  return (
    <>
      <div
        className={open ? `${s.scrim} ${s.scrimOpen}` : s.scrim}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        className={open ? `${s.drawer} ${s.drawerOpen}` : s.drawer}
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        // Keep the offscreen panel out of the tab order entirely.
        inert={!open}
      >
        <div className={s.head}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 className={s.title}>{title}</h3>
            {subtitle && <div className={s.sub}>{subtitle}</div>}
          </div>
          <button className={s.close} onClick={onClose} aria-label="Đóng">
            <Icon name="close" size={19} strokeWidth={2.2} />
          </button>
        </div>

        <div className={s.body} ref={bodyRef}>
          {children}
        </div>

        {footer && <div className={s.foot}>{footer}</div>}
      </aside>
    </>
  )
}

export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.section}>
      <div className={s.label}>{label}</div>
      {children}
    </div>
  )
}

export const drawerStyles = s
