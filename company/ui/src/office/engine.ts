// The Office world: a lightweight game loop with a per-agent state machine.
// Agents sit at desks and type when working; when one messages another it walks
// over and shows a speech bubble; task events pop reaction bubbles. Fed live by
// the office-server WebSocket (see useOfficeSocket + office-server/).

import { CHAR_H, CHAR_W, TILE, type Sheets } from './sprites'
import { NAMEPLATE, TOP_BAND, type OfficeAgent, type OfficeLayout } from './layout'

// Dark wall behind the top decor band so bookshelves read as mounted on a wall
// (like the reference) instead of floating on the floor.
const WALL = '#332d40'
const WALL_SHADE = 'rgba(0,0,0,0.28)'

// One base character type (char_0..5) per department. 8 departments share 6
// types: Project Management + Specialized use the same, Security + Support too.
const DIVISION_CHAR: Record<string, number> = {
  design: 0,
  engineering: 1,
  product: 2,
  'project-management': 3,
  specialized: 3,
  security: 4,
  support: 4,
  testing: 5,
  hr: 2, // shares a look with Product
}

function charForDivision(division: string, count: number): number {
  if (division in DIVISION_CHAR) return DIVISION_CHAR[division] % count
  // Fallback for any division not listed: stable hash into the base types.
  let h = 0
  for (let i = 0; i < division.length; i++) h = (h * 31 + division.charCodeAt(i)) >>> 0
  return h % count
}

// Direction rows in the sheet: 0=DOWN, 1=UP, 2=RIGHT (LEFT = flipped RIGHT).
const DOWN = 0
const UP = 1
const RIGHT = 2
const LEFT = 3
type Dir = typeof DOWN | typeof UP | typeof RIGHT | typeof LEFT

type State = 'idle' | 'typing' | 'reading' | 'walking'

const SPEED = 52 // px/s
const WALK_FRAME = 0.15
const TYPE_FRAME = 0.3

type Step =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'wait'; t: number }
  | { kind: 'face'; dir: Dir }
  | { kind: 'say'; text: string; color: string; t: number }
  | { kind: 'work'; on: boolean }
  // Stand and wait until another agent finishes its current task (is not working),
  // then continue. Times out so an agent never waits forever.
  | { kind: 'waitFor'; slug: string; timeout: number }

interface Bubble {
  text: string
  color: string
  until: number
}

interface Ent {
  slug: string
  name: string
  role: string // short label shown above the head (full name is on hover)
  emoji: string
  color: string
  palette: number
  home: { x: number; y: number }
  pos: { x: number; y: number }
  dir: Dir
  working: boolean
  reviewing: boolean
  reading: boolean
  chatting: boolean // composing a chat reply right now (transient, from 'activity' events)
  chatUntil: number // safety deadline so a lost 'idle' can't leave it typing forever
  anim: number
  bubble?: Bubble
  queue: Step[]
}

// ---- WS event shapes (subset we act on) -----------------------------------
export interface OfficeEvent {
  type: 'hello' | 'message' | 'taskStatus' | 'comment' | 'tool' | string
  tasks?: { id: string; assignee?: string | null; reporter?: string | null; status: string }[]
  composing?: string[] // hello: agent slugs mid chat-reply → restore the ⌨️ pose on reconnect
  from?: string | null
  to?: string | null
  kind?: string
  taskId?: string
  assignee?: string | null
  reporter?: string | null
  agent?: string | null
  mentions?: string[]
  phase?: string
  tool?: string
  state?: string // 'activity' events: 'typing' while composing a chat reply | 'idle'
}

/** An HTML overlay item positioned over an agent (world coords; scale by zoom). */
export interface OfficeOverlay {
  slug: string
  x: number // char top-left, world px
  y: number
  badge: string | null // '⌨️' working | '⏳' waiting | null
  bubble: { text: string; color: string } | null
}

const KIND_BUBBLE: Record<string, string> = {
  chat: '💬',
  handoff: '📦',
  qa_verdict: '🔍',
  escalation: '⚠️',
  ruling: '⚖️',
  note: '📝',
}

// Task-status → bubble emoji (also drives the taskStatus handler below).
const STATUS_BUBBLE: Record<string, { emoji: string; color: string }> = {
  todo: { emoji: '📋', color: '#8A90A8' }, // ticket mới được giao
  in_progress: { emoji: '⌨️', color: '#4E5AE8' },
  in_qa: { emoji: '🔍', color: '#F5A93F' },
  accepted: { emoji: '✅', color: '#21C286' },
  rejected: { emoji: '❌', color: '#F2547D' },
  deferred: { emoji: '⏸️', color: '#8A90A8' },
  escalated: { emoji: '🚨', color: '#F2547D' },
  cancelled: { emoji: '⛔', color: '#6b7280' },
}

// Mirror of the backend reviewer rule (worker: the reporting lead reviews; PO is
// the fallback gatekeeper) — keeps the 🔍 badge on the SAME agent the worker uses.
const REVIEW_LEADS = new Set([
  'engagement-director',
  'project-manager-senior',
  'product-owner',
  'engineering-software-architect',
  'security-architect',
  'hr-talent-acquisition-lead',
])
const reviewerOf = (reporter?: string | null): string =>
  reporter && REVIEW_LEADS.has(reporter) ? reporter : 'product-owner'

/** The complete legend for every emoji the office can show (badges + bubbles).
    Keep in sync with KIND_BUBBLE, STATUS_BUBBLE, and the badge/comment icons. */
export const OFFICE_LEGEND: { e: string; t: string }[] = [
  { e: '⌨️', t: 'đang làm task' },
  { e: '✍️', t: 'đang soạn trả lời (chat)' },
  { e: '⏳', t: 'đang đợi agent khác' },
  { e: '💬', t: 'nhắn / trao đổi' },
  { e: '📦', t: 'bàn giao việc' },
  { e: '🔍', t: 'đang review (lead/QA)' },
  { e: '📋', t: 'task mới được giao' },
  { e: '⚖️', t: 'phán quyết (owner)' },
  { e: '⚠️', t: 'escalate' },
  { e: '📝', t: 'ghi chú' },
  { e: '❗', t: 'bị nhắc tên' },
  { e: '✅', t: 'task được duyệt' },
  { e: '❌', t: 'task bị trả lại' },
  { e: '⏸️', t: 'task hoãn' },
  { e: '🚨', t: 'task escalate lên CEO/CTO' },
  { e: '⛔', t: 'task bị huỷ' },
  { e: '📖', t: 'đang đọc / tra cứu (tool)' },
]

function dirTo(from: { x: number; y: number }, to: { x: number; y: number }): Dir {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? RIGHT : LEFT
  return dy > 0 ? DOWN : UP
}

export class OfficeWorld {
  private ents = new Map<string, Ent>()
  private t = 0

  constructor(
    private layout: OfficeLayout,
    agents: OfficeAgent[],
    private sheets: Sheets,
  ) {
    for (const a of agents) {
      const seat = layout.seats.get(a.slug)
      if (!seat) continue
      this.ents.set(a.slug, {
        slug: a.slug,
        name: a.name,
        role: abbreviate(a.name),
        emoji: a.emoji || '👤',
        color: a.color || '#8A90A8',
        palette: charForDivision(a.division, sheets.chars.length),
        home: { x: seat.seatX, y: seat.seatY },
        pos: { x: seat.seatX, y: seat.seatY },
        dir: DOWN, // seated, facing the viewer so we see the face + role label
        working: false,
        reviewing: false,
        reading: false,
        chatting: false,
        chatUntil: 0,
        anim: Math.random() * 2, // desync animations
        queue: [],
      })
    }
  }

  /** Apply the hello snapshot AUTHORITATIVELY: an agent is "working" iff it holds
      an in_progress task right now, and "chatting" iff it's mid chat-reply (from the
      server's composing set). This also runs on WS reconnect, so a stale ⌨️ (task/reply
      finished while we were away) is cleared, and an ongoing one is restored. */
  setInitial(tasks: OfficeEvent['tasks'], composing: string[] = []): void {
    if (!tasks) return
    const working = new Set(
      tasks.filter((t) => t.status === 'in_progress' && t.assignee).map((t) => t.assignee as string),
    )
    const reviewing = new Set(tasks.filter((t) => t.status === 'in_qa').map((t) => reviewerOf(t.reporter)))
    const chatting = new Set(composing)
    for (const e of this.ents.values()) {
      e.working = working.has(e.slug)
      e.reviewing = reviewing.has(e.slug)
      e.chatting = chatting.has(e.slug)
      if (e.chatting) e.chatUntil = this.t + 30 // same safety window as a live 'activity' event
    }
  }

  private say(e: Ent, text: string, color: string, t: number): void {
    e.queue.push({ kind: 'say', text, color, t })
  }

  /** `a` walks over to `b`'s desk, WAITS for b to be free (one task at a time), shows a
      bubble as the handoff happens, then walks home. Used for BOTH a chat message A→B
      and a task handoff (submit for review / deliver a verdict). */
  private walkHandoff(a: Ent, b: Ent, bubble: string, color: string): void {
    a.queue.push({ kind: 'move', x: b.home.x - 20, y: b.home.y + 4 })
    a.queue.push({ kind: 'face', dir: RIGHT })
    a.queue.push({ kind: 'waitFor', slug: b.slug, timeout: 14 })
    this.say(a, bubble, color, 2.6)
    a.queue.push({ kind: 'move', x: a.home.x, y: a.home.y })
    a.queue.push({ kind: 'face', dir: DOWN })
  }

  onEvent(ev: OfficeEvent): void {
    if (ev.type === 'hello') {
      this.setInitial(ev.tasks, ev.composing ?? [])
      return
    }
    if (ev.type === 'message' && ev.from) {
      const a = this.ents.get(ev.from)
      if (!a) return
      const bubble = KIND_BUBBLE[ev.kind ?? 'chat'] ?? '💬'
      const b = ev.to ? this.ents.get(ev.to) : null
      if (!b || b === a) {
        this.say(a, bubble, a.color, 2.4) // to owner / self: emote in place
        return
      }
      this.walkHandoff(a, b, bubble, a.color) // walk to B, hand off, return home
      return
    }
    if (ev.type === 'taskStatus' && ev.assignee) {
      const e = this.ents.get(ev.assignee)
      if (!e || !ev.to) return
      // BOARD ↔ OFFICE parity: in_progress = ⌨️ on the assignee; in_qa = 🔍 on the
      // REVIEWER (reporting lead, PO fallback — same rule as the worker); every
      // other-than-in_progress status frees the assignee, INCLUDING cancelled
      // (before this, a task cancelled mid-work left the ⌨️ badge stuck).
      if (ev.to === 'in_progress') e.queue.push({ kind: 'work', on: true })
      else e.queue.push({ kind: 'work', on: false })
      const reviewer = this.ents.get(reviewerOf(ev.reporter))
      if (reviewer) {
        if (ev.to === 'in_qa') reviewer.reviewing = true
        else if (['accepted', 'rejected', 'escalated', 'deferred', 'cancelled'].includes(ev.to))
          reviewer.reviewing = false // reconnect hello re-derives if several tasks overlap
      }
      const b = STATUS_BUBBLE[ev.to]
      // A task handoff is a real BÀN GIAO between two people → make them WALK, not just
      // emote in place: in_qa = the assignee carries the deliverable TO the reviewer
      // (submit for review); accepted/rejected = the reviewer walks TO the assignee to
      // deliver the verdict. Other transitions (escalate/defer/cancel) stay in-place.
      if (ev.to === 'in_qa' && reviewer && reviewer !== e) {
        this.walkHandoff(e, reviewer, b?.emoji ?? '🔍', b?.color ?? '#F5A93F')
      } else if ((ev.to === 'accepted' || ev.to === 'rejected') && reviewer && reviewer !== e) {
        this.walkHandoff(reviewer, e, b?.emoji ?? '✅', b?.color ?? '#21C286')
      } else if (b) {
        this.say(e, b.emoji, b.color, 1.8)
      }
      return
    }
    if (ev.type === 'comment' && ev.agent) {
      const e = this.ents.get(ev.agent)
      if (e) this.say(e, '💬', e.color, 1.5)
      for (const m of ev.mentions ?? []) {
        const t = this.ents.get(m)
        if (t) this.say(t, '❗', '#F2547D', 1.8)
      }
      return
    }
    if (ev.type === 'tool' && ev.agent) {
      const e = this.ents.get(ev.agent)
      if (!e) return
      const isRead = /read|grep|glob|search|list/i.test(ev.tool ?? '')
      if (ev.phase === 'start') {
        e.working = true
        e.reading = isRead
        this.say(e, isRead ? '📖' : '⌨️', '#4E5AE8', 1.0)
      } else if (ev.phase === 'done') {
        e.reading = false
      }
      return
    }
    // Live chat-reply signal: the agent is composing an answer right now → show the
    // ⌨️ typing pose at its desk until the backend says 'idle' (or the safety timeout).
    if (ev.type === 'activity' && ev.agent) {
      const e = this.ents.get(ev.agent)
      if (!e) return
      if (ev.state === 'typing') {
        e.chatting = true
        e.chatUntil = this.t + 30 // clears itself if 'idle' is ever lost
        this.say(e, '💬', e.color, 1.2)
      } else {
        e.chatting = false
      }
      return
    }
  }

  update(dt: number): void {
    this.t += dt
    for (const e of this.ents.values()) {
      e.anim += dt
      if (e.bubble && e.bubble.until < this.t) e.bubble = undefined
      if (e.chatting && e.chatUntil < this.t) e.chatting = false // safety: lost 'idle'

      const step = e.queue[0]
      if (!step) continue
      switch (step.kind) {
        case 'move': {
          const dx = step.x - e.pos.x
          const dy = step.y - e.pos.y
          const dist = Math.hypot(dx, dy)
          if (dist < 1.5) {
            e.pos.x = step.x
            e.pos.y = step.y
            e.queue.shift()
          } else {
            e.dir = dirTo(e.pos, step)
            const s = Math.min(SPEED * dt, dist)
            e.pos.x += (dx / dist) * s
            e.pos.y += (dy / dist) * s
          }
          break
        }
        case 'wait':
          step.t -= dt
          if (step.t <= 0) e.queue.shift()
          break
        case 'face':
          e.dir = step.dir
          e.queue.shift()
          break
        case 'say':
          e.bubble = { text: step.text, color: step.color, until: this.t + step.t }
          e.queue.shift()
          break
        case 'work':
          e.working = step.on
          e.queue.shift()
          break
        case 'waitFor': {
          const target = this.ents.get(step.slug)
          if (!target || !target.working) {
            e.queue.shift() // target is free (or gone) → proceed
          } else {
            step.timeout -= dt
            if (step.timeout <= 0) e.queue.shift() // don't wait forever
            // else: stand and wait (the render shows a ⏳ badge)
          }
          break
        }
      }
    }
  }

  private isWaiting(e: Ent): boolean {
    return e.queue[0]?.kind === 'waitFor'
  }

  private stateOf(e: Ent): State {
    if (e.queue[0]?.kind === 'move') return 'walking'
    if (e.reviewing) return 'reading' // review = reading pose at the desk
    if (e.working || e.chatting) return e.reading ? 'reading' : 'typing'
    return 'idle'
  }

  private frame(e: Ent, state: State): { row: number; col: number; flip: boolean } {
    const flip = e.dir === LEFT
    const row = e.dir === LEFT ? RIGHT : e.dir
    if (state === 'walking') {
      const seq = [0, 1, 2, 1]
      return { row, col: seq[Math.floor(e.anim / WALK_FRAME) % 4], flip }
    }
    if (state === 'typing') return { row, col: 3 + (Math.floor(e.anim / TYPE_FRAME) % 2), flip }
    if (state === 'reading') return { row, col: 5 + (Math.floor(e.anim / TYPE_FRAME) % 2), flip }
    return { row, col: 0, flip } // idle stand
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { rooms, seats } = this.layout

    // 1. Per-room floor + wall band. The dark stage shows in the gaps between rooms.
    for (const room of rooms) {
      const floor = this.sheets.floors[room.floorIndex % this.sheets.floors.length]
      const iy = room.y + NAMEPLATE
      const ih = room.h - NAMEPLATE
      ctx.save()
      ctx.beginPath()
      ctx.rect(room.x, iy, room.w, ih)
      ctx.clip()
      for (let y = iy; y < iy + ih; y += TILE) {
        for (let x = room.x; x < room.x + room.w; x += TILE) {
          ctx.drawImage(floor, 0, 0, TILE, TILE, x, y, TILE, TILE)
        }
      }
      // Wall band behind the top decorations (bookshelves mount on it).
      ctx.fillStyle = WALL
      ctx.fillRect(room.x, iy, room.w, TOP_BAND)
      ctx.fillStyle = WALL_SHADE // baseboard shadow where wall meets floor
      ctx.fillRect(room.x, iy + TOP_BAND - 2, room.w, 2)
      ctx.restore()
      // Border + coloured nameplate.
      ctx.strokeStyle = room.color + 'aa'
      ctx.lineWidth = 1
      ctx.strokeRect(room.x + 0.5, room.y + 0.5, room.w - 1, room.h - 1)
      ctx.fillStyle = room.color
      ctx.fillRect(room.x, room.y, room.w, NAMEPLATE)
      ctx.fillStyle = '#fff'
      ctx.font = '9px "Be Vietnam Pro", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      // Centre the label, clipped to leave the top-right corner free for the
      // floor dropdown so it never covers the text.
      const labelW = room.w - 32
      ctx.save()
      ctx.beginPath()
      ctx.rect(room.x + 2, room.y, labelW, NAMEPLATE)
      ctx.clip()
      ctx.fillText(room.label, room.x + 2 + labelW / 2, room.y + NAMEPLATE / 2 + 0.5)
      ctx.restore()
      // Decorations (wall + floor bands) — drawn behind desks and characters.
      for (const dec of room.decor) ctx.drawImage(this.sheets.decor[dec.kind], dec.x, dec.y)
    }

    // Workstation layering, bottom → top: (2) agent, (3) desk, (4) monitor on top.
    // So the monitor is the frontmost object, then the desk, and the agent sits
    // behind both.

    // 2. Characters, sorted by feet Y for correct overlap among themselves.
    for (const e of [...this.ents.values()].sort((a, b) => a.pos.y - b.pos.y)) {
      this.drawChar(ctx, e)
    }

    // 3. Desks (middle), sorted by Y so nearer desks overlap farther ones.
    for (const seat of [...seats.values()].sort((a, b) => a.deskY - b.deskY)) {
      ctx.drawImage(this.sheets.deskFront, seat.deskX, seat.deskY)
    }

    // 4. Monitors ON TOP (PC_BACK — screen faces the seated agent), plus a mug on
    //    the desks that have one.
    for (const seat of [...seats.values()].sort((a, b) => a.pcY - b.pcY)) {
      ctx.drawImage(this.sheets.pcBack, seat.pcX, seat.pcY)
      if (seat.coffee) ctx.drawImage(this.sheets.decor.coffee, seat.coffee.x, seat.coffee.y)
    }

    // 5. Role labels on canvas. Status badges + speech bubbles are HTML overlays
    //    (see OfficePage.overlays) — HTML/CSS centres emoji reliably; canvas does not.
    for (const e of this.ents.values()) this.drawLabel(ctx, e)
  }

  /** Current overlay items in WORLD coords — a status badge (⌨️ working / ⏳
      waiting) and/or a speech bubble per agent. Rendered as DOM, not canvas, so
      the emoji centre cleanly. Only agents that have one are returned. */
  overlays(): OfficeOverlay[] {
    const out: OfficeOverlay[] = []
    for (const e of this.ents.values()) {
      const badge = this.isWaiting(e)
        ? '⏳'
        : e.reviewing
          ? '🔍'
          : e.working
            ? '⌨️'
            : e.chatting
              ? '✍️'
              : null
      const bubble = e.bubble ? { text: e.bubble.text, color: e.bubble.color } : null
      if (!badge && !bubble) continue
      out.push({ slug: e.slug, x: Math.round(e.pos.x), y: Math.round(e.pos.y), badge, bubble })
    }
    return out
  }

  private drawChar(ctx: CanvasRenderingContext2D, e: Ent): void {
    const f = this.frame(e, this.stateOf(e))
    const px = Math.round(e.pos.x)
    const py = Math.round(e.pos.y)
    const sheet = this.sheets.chars[e.palette]
    if (f.flip) {
      ctx.save()
      ctx.translate(px + CHAR_W, py)
      ctx.scale(-1, 1)
      ctx.drawImage(sheet, f.col * CHAR_W, f.row * CHAR_H, CHAR_W, CHAR_H, 0, 0, CHAR_W, CHAR_H)
      ctx.restore()
    } else {
      ctx.drawImage(sheet, f.col * CHAR_W, f.row * CHAR_H, CHAR_W, CHAR_H, px, py, CHAR_W, CHAR_H)
    }
  }

  private drawLabel(ctx: CanvasRenderingContext2D, e: Ent): void {
    const cx = Math.round(e.pos.x) + CHAR_W / 2
    const ty = Math.round(e.pos.y) - 6
    ctx.font = '6px "Be Vietnam Pro", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const tw = Math.ceil(ctx.measureText(e.role).width)
    ctx.fillStyle = 'rgba(18,20,38,0.82)'
    roundRect(ctx, cx - tw / 2 - 3, ty - 5, tw + 6, 10, 3)
    ctx.fill()
    ctx.fillStyle = '#f2f3f8'
    ctx.fillText(e.role, cx, ty + 0.5)
    ctx.textAlign = 'left'
  }

  /** Change a room's floor texture live (the render loop reads it each frame). */
  setFloor(slug: string, floorIndex: number): void {
    const room = this.layout.rooms.find((r) => r.slug === slug)
    if (room) room.floorIndex = floorIndex
  }

  /** Nearest agent whose char box contains the point (world px), for hover/labels. */
  agentAt(x: number, y: number): { slug: string; name: string } | null {
    for (const e of this.ents.values()) {
      if (x >= e.pos.x && x <= e.pos.x + CHAR_W && y >= e.pos.y && y <= e.pos.y + CHAR_H) {
        return { slug: e.slug, name: e.name }
      }
    }
    return null
  }
}

const STOP = new Set(['of', 'and', 'the', 'for', 'to', 'a', 'an', 'with', 'in', 'on', '&'])

/**
 * Short label for a role name: initials of the significant words, but any word
 * that is already an acronym (all-caps, e.g. "AI", "RAG", "QA") is kept whole.
 *   "Data Engineer" -> "DE", "AI Engineer" -> "AIE", "Orchestrator" -> "ORC".
 */
function abbreviate(name: string): string {
  const words = name
    .replace(/\([^)]*\)/g, ' ') // drop parentheticals, e.g. "SRE (Site Reliability...)"
    .split(/[\s\-/]+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, '')) // strip stray punctuation
    .filter((w) => w && !STOP.has(w.toLowerCase()))
  if (words.length === 0) return name.slice(0, 3).toUpperCase()
  if (words.length === 1) {
    const w = words[0]
    return /^[A-Z0-9]{2,}$/.test(w) ? w.slice(0, 5) : w.slice(0, 3).toUpperCase()
  }
  let out = ''
  for (const w of words) out += /^[A-Z0-9]{2,}$/.test(w) ? w : w[0].toUpperCase()
  return out.slice(0, 5)
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
