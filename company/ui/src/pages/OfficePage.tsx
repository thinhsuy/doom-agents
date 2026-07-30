import { useEffect, useMemo, useRef, useState } from 'react'
import rosterJson from '../data/agents.json'
import type { AgentRoster, Workspace } from '../types'
import { TeamChatPanel } from './TeamChatPage'
import { loadSheets, FLOOR_COUNT } from '../office/sprites'
import { buildLayout, NAMEPLATE as NAMEPLATE_PX, type DivisionMeta, type OfficeAgent } from '../office/layout'
import { OfficeWorld, OFFICE_LEGEND, type OfficeEvent, type OfficeOverlay } from '../office/engine'
import { useOfficeSocket } from '../office/useOfficeSocket'
import { apiUrl, wsUrl } from '../lib/api'
import s from './OfficePage.module.css'

const roster = rosterJson as AgentRoster

// Live office stream + durable floor config come from the FastAPI backend.
const WS_URL = wsUrl('/ws/office')
const CONFIG_URL = apiUrl('/api/config/floors')
// Hired roster LIVE from the DB, so a newly-approved hire gets a room/desk without a
// rebuild (the static agents.json is only the offline fallback).
const AGENTS_URL = apiUrl('/api/agents')

const LEGEND = OFFICE_LEGEND // complete set, co-located with the emoji the office emits

// A scripted NEXUS-style flow to preview how agents interact: intake → spec →
// ruling → build → QA (fail then pass). Client-side only — it drives the office
// animation without writing to the DB. Slugs must be hired agents.
const BA_ENG = 'engineering-backend-architect'
const DEMO_FLOW: { t: number; ev: OfficeEvent }[] = [
  // Backend Architect is ALREADY busy on a task (⌨️ working badge).
  { t: 0, ev: { type: 'taskStatus', assignee: BA_ENG, to: 'in_progress' } },
  // Intake handoffs among free agents — quick.
  { t: 1500, ev: { type: 'message', from: 'engagement-director', to: 'product-business-analyst', kind: 'handoff' } },
  { t: 4000, ev: { type: 'message', from: 'product-business-analyst', to: 'product-owner', kind: 'handoff' } },
  { t: 6500, ev: { type: 'message', from: 'product-owner', to: 'project-manager-senior', kind: 'ruling' } },
  // SPM brings the build task to the Backend Architect, who is STILL working →
  // SPM walks over and WAITS (⏳) beside them until they're free.
  { t: 8500, ev: { type: 'message', from: 'project-manager-senior', to: BA_ENG, kind: 'handoff' } },
  // Backend Architect finishes the old task → free → SPM's handoff lands.
  { t: 16000, ev: { type: 'taskStatus', assignee: BA_ENG, to: 'in_qa' } },
  // Now the Architect picks up the new task and runs the QA loop.
  { t: 18500, ev: { type: 'taskStatus', assignee: BA_ENG, to: 'in_progress' } },
  { t: 21000, ev: { type: 'message', from: BA_ENG, to: 'testing-evidence-collector', kind: 'handoff' } },
  { t: 22500, ev: { type: 'taskStatus', assignee: BA_ENG, to: 'in_qa' } },
  { t: 24500, ev: { type: 'message', from: 'testing-evidence-collector', to: BA_ENG, kind: 'qa_verdict' } },
  { t: 26000, ev: { type: 'taskStatus', assignee: BA_ENG, to: 'rejected' } },
  { t: 28500, ev: { type: 'taskStatus', assignee: BA_ENG, to: 'in_progress' } },
  { t: 31500, ev: { type: 'taskStatus', assignee: BA_ENG, to: 'accepted' } },
  { t: 33500, ev: { type: 'comment', agent: 'project-manager-senior', mentions: ['engagement-director'] } },
]
const DEMO_MS = DEMO_FLOW[DEMO_FLOW.length - 1].t + 3500

// Per-department floor overrides, remembered across sessions.
const FLOOR_KEY = 'office-floors-v1'
function loadFloors(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(FLOOR_KEY) || '{}')
  } catch {
    return {}
  }
}

interface RoomBox {
  slug: string
  label: string
  x: number
  y: number
  w: number
}

export function OfficePage({ workspace }: { workspace: Workspace }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<OfficeWorld | null>(null)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const [ready, setReady] = useState(false)
  const [demoRunning, setDemoRunning] = useState(false)
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null)
  // Floor picker overlay state.
  const [board, setBoard] = useState<{ rooms: RoomBox[]; worldW: number; worldH: number } | null>(null)
  const [zoom, setZoom] = useState(2)
  // Width the office column LOCKS to (= board width + padding) so Team Chat takes
  // every remaining px — no leftover stage gutter. Computed in fit() from the
  // SPLIT width (stable: the split's size doesn't depend on its children).
  const [officeW, setOfficeW] = useState<number | null>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  const [floors, setFloors] = useState<Record<string, number>>({})
  const [overlays, setOverlays] = useState<OfficeOverlay[]>([]) // HTML badges + bubbles
  const overlaySig = useRef('')
  const [legendOpen, setLegendOpen] = useState(false)
  const legendRef = useRef<HTMLDivElement>(null)
  const { status, drain } = useOfficeSocket(WS_URL)

  const runDemo = () => {
    if (!worldRef.current || demoRunning) return
    setDemoRunning(true)
    for (const step of DEMO_FLOW) {
      timersRef.current.push(setTimeout(() => worldRef.current?.onEvent(step.ev), step.t))
    }
    timersRef.current.push(setTimeout(() => setDemoRunning(false), DEMO_MS))
  }

  const setFloor = (slug: string, idx: number) => {
    worldRef.current?.setFloor(slug, idx) // live: the render loop redraws it next frame
    setFloors((prev) => {
      const next = { ...prev, [slug]: idx }
      try {
        localStorage.setItem(FLOOR_KEY, JSON.stringify(next)) // instant + offline fallback
      } catch {
        /* ignore quota errors */
      }
      return next
    })
    // Durable: persist to Postgres via the office-server (best-effort).
    fetch(CONFIG_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, index: idx }),
    }).catch(() => {
      /* backend offline — localStorage still holds it */
    })
  }

  // Close the legend dropdown on outside click / Escape.
  useEffect(() => {
    if (!legendOpen) return
    const onDoc = (e: MouseEvent) => {
      if (legendRef.current && !legendRef.current.contains(e.target as Node)) setLegendOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setLegendOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [legendOpen])

  // Live hired roster: poll /api/agents; only swap in a new roster when the hired set
  // (or divisions) actually CHANGES, so the office isn't rebuilt (animations reset)
  // every poll — only when a hire is approved / removed.
  const [liveRoster, setLiveRoster] = useState<AgentRoster | null>(null)
  const rosterSig = useRef('')
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch(AGENTS_URL)
        if (!r.ok) return
        const d = await r.json()
        if (!alive || !Array.isArray(d?.agents) || !Array.isArray(d?.divisions)) return
        const sig =
          d.agents.filter((a: { hired?: boolean }) => a.hired).map((a: { slug: string }) => a.slug).sort().join(',') +
          '|' +
          d.divisions.map((x: { slug: string }) => x.slug).join(',')
        if (sig === rosterSig.current) return // no change → don't rebuild the world
        rosterSig.current = sig
        setLiveRoster(d as AgentRoster)
      } catch {
        /* backend offline — static roster stays */
      }
    }
    load()
    const id = setInterval(load, 10000) // a new hire appears within ~10s of approval
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const { agents, divisions } = useMemo(() => {
    const src = liveRoster ?? roster
    const agents: OfficeAgent[] = src.agents
      .filter((a) => a.hired)
      .map((a) => ({ slug: a.slug, name: a.name, emoji: a.emoji, color: a.color, division: a.division }))
    const divisions: DivisionMeta[] = src.divisions.map((d) => ({
      slug: d.slug,
      label: d.label,
      color: d.color,
    }))
    return { agents, divisions }
  }, [liveRoster])

  useEffect(() => {
    let cancelled = false
    let raf = 0
    let ro: ResizeObserver | undefined
    let world: OfficeWorld | null = null
    let zoom = 2
    let dpr = 1

    loadSheets().then((sheets) => {
      if (cancelled) return
      const canvas = canvasRef.current
      const wrap = wrapRef.current
      if (!canvas || !wrap) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Pack rooms to a ≥560 world so rows keep TWO rooms side by side (the owner
      // wants the overview — cross-room interactions visible at a glance). The
      // HALF-STEP zoom in fit() handles filling the column width (560 × 1.5 ≈ 840px),
      // so a narrower world here would only collapse the layout to one column.
      const layout = buildLayout(agents, divisions, Math.max(560, (wrap.clientWidth - 8) / 2))
      // Apply remembered per-department floor choices before first render.
      const saved = loadFloors()
      for (const room of layout.rooms) if (saved[room.slug] != null) room.floorIndex = saved[room.slug]
      world = new OfficeWorld(layout, agents, sheets)
      worldRef.current = world
      setBoard({
        rooms: layout.rooms.map((r) => ({ slug: r.slug, label: r.label, x: r.x, y: r.y, w: r.w })),
        worldW: layout.worldW,
        worldH: layout.worldH,
      })
      setFloors(Object.fromEntries(layout.rooms.map((r) => [r.slug, r.floorIndex])))
      setReady(true)

      // Durable config: pull the saved floors from Postgres (via office-server).
      // DB wins over localStorage/defaults; if the backend is down this no-ops.
      fetch(CONFIG_URL)
        .then((r) => (r.ok ? r.json() : null))
        .then((cfg) => {
          if (cancelled || !cfg || typeof cfg !== 'object' || !worldRef.current) return
          const applied: Record<string, number> = {}
          for (const [slug, v] of Object.entries(cfg)) {
            const idx = Number(v)
            if (Number.isFinite(idx)) {
              worldRef.current.setFloor(slug, idx)
              applied[slug] = idx
            }
          }
          if (Object.keys(applied).length) {
            setFloors((prev) => ({ ...prev, ...applied }))
            try {
              localStorage.setItem(FLOOR_KEY, JSON.stringify({ ...loadFloors(), ...applied }))
            } catch {
              /* ignore */
            }
          }
        })
        .catch(() => {
          /* backend offline — keep localStorage/default floors */
        })

      const CHAT_MIN = 340 // keep in sync with .chatCol min-width
      const GAP = 16 // .split gap
      const PAD = 10 // stage padding + scrollbar allowance
      const fit = () => {
        dpr = window.devicePixelRatio || 1
        const total = splitRef.current?.clientWidth ?? wrap.clientWidth
        const stacked = window.innerWidth <= 1100 // media query: columns stacked
        const avail = stacked ? wrap.clientWidth - 4 : Math.max(320, total - CHAT_MIN - GAP - PAD)
        // HALF-step zoom (1, 1.5, 2, …): integer-only flooring wasted up to half the
        // stage as side gutters (e.g. 880px avail / 560px world → 1× → 320px empty).
        zoom = Math.max(1, Math.min(4, Math.floor((avail / layout.worldW) * 2) / 2 || 1))
        setOfficeW(stacked ? null : Math.round(layout.worldW * zoom) + PAD)
        canvas.width = Math.round(layout.worldW * zoom * dpr)
        canvas.height = Math.round(layout.worldH * zoom * dpr)
        canvas.style.width = `${layout.worldW * zoom}px`
        canvas.style.height = `${layout.worldH * zoom}px`
        ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, 0, 0)
        ctx.imageSmoothingEnabled = false
        setZoom(zoom) // keep the floor-picker overlay aligned with the canvas
      }
      fit()
      ro = new ResizeObserver(fit)
      ro.observe(splitRef.current ?? wrap)

      // Map a mouse position to world px for the hover label.
      canvas.onmousemove = (ev) => {
        if (!world) return
        const r = canvas.getBoundingClientRect()
        const wx = (ev.clientX - r.left) / zoom
        const wy = (ev.clientY - r.top) / zoom
        const hit = world.agentAt(wx, wy)
        setHover(hit ? { name: hit.name, x: ev.clientX - r.left, y: ev.clientY - r.top } : null)
      }
      canvas.onmouseleave = () => setHover(null)

      let last = performance.now()
      const frame = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000)
        last = now
        for (const e of drain()) world!.onEvent(e)
        world!.update(dt)
        ctx.clearRect(0, 0, layout.worldW, layout.worldH)
        world!.render(ctx)
        // Sync HTML badge/bubble overlays only when they actually change (so
        // stationary badges don't re-render React every frame).
        const ovs = world!.overlays()
        const sig = ovs.map((o) => `${o.slug}:${o.x},${o.y}:${o.badge ?? ''}:${o.bubble?.text ?? ''}`).join('|')
        if (sig !== overlaySig.current) {
          overlaySig.current = sig
          setOverlays(ovs)
        }
        raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      ro?.disconnect()
      worldRef.current = null
      timersRef.current.forEach(clearTimeout)
      timersRef.current = []
    }
  }, [agents, divisions, drain])

  // One screen: the pixel office (left) + Team Chat (right) — watch agents work
  // and talk to them without switching tabs.
  return (
    <div className={s.split} ref={splitRef}>
      <div className={s.officeCol} style={officeW != null ? { flex: `0 0 ${officeW}px` } : undefined}>
        <div className={s.page}>
          <div className={s.bar}>
        <div className={s.left}>
          <span className={`${s.dot} ${s[status]}`} />
          <span className={s.status}>
            {status === 'online'
              ? 'Kết nối trực tiếp'
              : status === 'connecting'
                ? 'Đang kết nối…'
                : 'Ngoại tuyến'}
          </span>
          <span className={s.count}>· {agents.length} nhân sự</span>
          <button
            className={s.demo}
            onClick={runDemo}
            disabled={!ready || demoRunning}
            title="Diễn hoạt một luồng agent giao tiếp & xử lý vấn đề (demo phía client, không ghi DB)"
          >
            {demoRunning ? '⏳ Đang diễn…' : '▶ Chạy thử flow'}
          </button>
        </div>
        <div className={s.legendWrap} ref={legendRef}>
          <button
            className={legendOpen ? `${s.legendBtn} ${s.legendBtnOn}` : s.legendBtn}
            onClick={() => setLegendOpen((o) => !o)}
            aria-expanded={legendOpen}
          >
            Chú thích {legendOpen ? '▴' : '▾'}
          </button>
          {legendOpen && (
            <div className={s.legendMenu}>
              {LEGEND.map((l) => (
                <span key={l.e} className={s.leg}>
                  <span className={s.legE}>{l.e}</span> {l.t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Only when the WS is definitively down — not during the transient 'connecting'
          phase, so a running backend never shows this hint. */}
      {status === 'offline' && (
        <div className={s.hint}>
          Văn phòng vẫn hiển thị (agent ngồi tại bàn), nhưng để thấy hoạt động <b>trực tiếp</b> hãy chạy
          backend FastAPI: <code>cd company/api &amp;&amp; ./.venv/bin/uvicorn main:app --port 8000</code>. Nó
          đọc Postgres và đẩy sự kiện qua WebSocket <code>/ws/office</code>.
        </div>
      )}

      <div className={s.stage} ref={wrapRef}>
        {!ready && <div className={s.loading}>Đang tải văn phòng…</div>}
        <div
          className={s.board}
          style={board ? { width: board.worldW * zoom, height: board.worldH * zoom } : undefined}
        >
          <canvas ref={canvasRef} className={s.canvas} />
          {board && (
            <div className={s.overlay}>
              {board.rooms.map((r) => (
                <select
                  key={r.slug}
                  className={s.floorSelect}
                  value={floors[r.slug] ?? 0}
                  onChange={(e) => setFloor(r.slug, Number(e.target.value))}
                  title={`Chọn sàn cho ${r.label}`}
                  style={{ left: (r.x + r.w) * zoom - 52, top: r.y * zoom + (NAMEPLATE_PX * zoom - 22) / 2 }}
                >
                  {Array.from({ length: FLOOR_COUNT }, (_, i) => (
                    <option key={i} value={i}>
                      Sàn {i + 1}
                    </option>
                  ))}
                </select>
              ))}

              {/* Status badges + speech bubbles as HTML (flexbox centres emoji cleanly). */}
              {overlays.map((o) => (
                <div key={o.slug} className={s.avatar}>
                  {o.bubble && (
                    <div
                      className={s.bubble}
                      style={{
                        left: (o.x + 8) * zoom,
                        top: (o.y - 3) * zoom,
                        borderColor: o.bubble.color,
                        height: 15 * zoom,
                        minWidth: 17 * zoom,
                        fontSize: 11 * zoom,
                        borderRadius: 5 * zoom,
                        borderWidth: Math.max(1, zoom),
                      }}
                    >
                      {o.bubble.text}
                    </div>
                  )}
                  {o.badge && (
                    <div
                      className={`${s.badge} ${o.badge === '⏳' ? s.badgeWait : s.badgeWork}`}
                      style={{
                        left: (o.x + 15) * zoom,
                        top: o.y * zoom,
                        width: 13 * zoom,
                        height: 13 * zoom,
                        fontSize: 8.5 * zoom,
                        borderWidth: Math.max(1, zoom * 0.6),
                      }}
                    >
                      {o.badge}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {hover && (
            <div className={s.tip} style={{ left: hover.x + 12, top: hover.y + 12 }}>
              {hover.name}
            </div>
          )}
        </div>
      </div>
        </div>
      </div>

      <div className={s.chatCol}>
        <TeamChatPanel workspace={workspace} />
      </div>
    </div>
  )
}
