// Computes the office floor plan: one room per division (that grouping IS the org
// chart, same as the Nhân sự tab), a stable desk per hired agent. All in world px.
//
// Rooms are packed masonry-style: the number of columns is derived from the
// available width, and each room drops into the currently-shortest column. That
// pulls small rooms up to fill the space beside the big one (Engineering), so the
// layout stays compact and uses the full width instead of leaving side gutters.
//
// Each room reserves a WALL band (top) and a FLOOR band (bottom) for decorations
// (bookshelves, paintings, plants…) so decor never collides with desks.

import type { DecorKind } from './sprites'

export interface OfficeAgent {
  slug: string
  name: string
  emoji: string
  color: string
  division: string
}

export interface DivisionMeta {
  slug: string
  label: string
  color: string
}

export interface Seat {
  slug: string
  seatX: number // char top-left
  seatY: number
  deskX: number // desk top-left (drawn IN FRONT of the char)
  deskY: number
  pcX: number // monitor on the desk
  pcY: number
  coffee?: { x: number; y: number } // a mug on the desk, on ~some desks only
}

export interface DecorItem {
  kind: DecorKind
  x: number
  y: number
}

export interface Room {
  slug: string
  label: string
  color: string
  x: number
  y: number
  w: number
  h: number
  floorIndex: number // which floor texture tiles this room
  decor: DecorItem[]
}

export interface OfficeLayout {
  worldW: number
  worldH: number
  rooms: Room[]
  seats: Map<string, Seat>
}

const PAD = 16
export const NAMEPLATE = 16 // coloured division bar at the top
export const TOP_BAND = 34 // wall band: decorations mount here (bookshelf / painting)
const BOTTOM_BAND = 38 // floor decorations (plants / bin)
const MAX_COLS = 3 // desks per row inside a room
const CELL_W = 72 // desk 48 + gap
const CELL_H = 88 // label + char 32 + desk + gap
const DESK_W = 48
const ROOM_GAP = 20
const MIN_ROOM_W = 200 // so a long division name fits on the nameplate

// Curated floor textures so adjacent rooms look distinct (like the reference).
const FLOOR_ORDER = [0, 3, 6, 1, 4, 7, 2, 5, 8]

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

/** Decorations along the room's reserved wall (top) and floor (bottom) bands. */
function roomDecor(slug: string, x: number, y: number, w: number, h: number): DecorItem[] {
  const items: DecorItem[] = []
  const hash = hashStr(slug)
  const wallY = y + NAMEPLATE + 2 // 32-tall shelves fit the 34px wall band
  const floorBase = y + h - 4 // floor items sit their bottom edge here
  const cx = x + w / 2

  // Wall: mostly a row of bookshelves, with the middle slot a framed painting and
  // some slots swapped for a hanging plant / small painting so the wall has life.
  const SLOT = 32
  const count = Math.max(1, Math.floor((w - 2 * PAD) / SLOT))
  const startX = Math.round(cx - (count * SLOT) / 2)
  const mid = Math.floor(count / 2)
  const smallArt: DecorKind[] = ['small_painting', 'small_painting2']
  for (let i = 0; i < count; i++) {
    const sx = startX + i * SLOT
    if (count >= 3 && i === mid) {
      items.push({ kind: slug === 'engineering' ? 'whiteboard' : 'painting', x: sx, y: wallY })
      continue
    }
    const pick = (hash + i * 7) % 5
    if (pick === 3) items.push({ kind: 'hanging_plant', x: sx + 8, y: wallY }) // 16-wide, centred in slot
    else if (pick === 4) items.push({ kind: smallArt[(hash + i) % 2], x: sx + 8, y: wallY })
    else items.push({ kind: 'double_bookshelf', x: sx, y: wallY })
  }

  // Floor: potted plants in the corners, a small pot beside them, a bin/coffee
  // centred in wider rooms.
  const plants: DecorKind[] = ['plant', 'plant2', 'cactus']
  items.push({ kind: plants[hash % 3], x: x + 5, y: floorBase - 32 })
  if (w >= 150) items.push({ kind: 'pot', x: x + 23, y: floorBase - 16 })
  if (w >= 130) items.push({ kind: plants[(hash + 1) % 3], x: x + w - 5 - 16, y: floorBase - 32 })
  if (w >= 150) items.push({ kind: 'pot', x: x + w - 23 - 16, y: floorBase - 16 })
  if (w >= 210) items.push({ kind: 'bin', x: Math.round(cx - 8), y: floorBase - 16 }) // coffee moved onto desks

  return items
}

/** Build the plan. `targetWidth` (px) sets how many room-columns we pack into. */
export function buildLayout(
  agents: OfficeAgent[],
  divisions: DivisionMeta[],
  targetWidth = 1280,
): OfficeLayout {
  const byDiv = new Map<string, OfficeAgent[]>()
  for (const a of agents) {
    if (!byDiv.has(a.division)) byDiv.set(a.division, [])
    byDiv.get(a.division)!.push(a)
  }
  const divMeta = new Map(divisions.map((d) => [d.slug, d]))
  const order = divisions.map((d) => d.slug).filter((slug) => byDiv.has(slug))

  // Room descriptors (size derived from headcount).
  const descs = order.map((divSlug, idx) => {
    const members = byDiv.get(divSlug)!
    const cols = Math.max(1, Math.min(MAX_COLS, members.length))
    const rows = Math.max(1, Math.ceil(members.length / cols))
    const meta = divMeta.get(divSlug)
    return {
      divSlug,
      members,
      cols,
      w: Math.max(PAD * 2 + cols * CELL_W, MIN_ROOM_W),
      h: NAMEPLATE + TOP_BAND + rows * CELL_H + BOTTOM_BAND,
      label: meta?.label ?? divSlug,
      color: meta?.color ?? '#4E5AE8',
      floorIndex: FLOOR_ORDER[idx % FLOOR_ORDER.length],
    }
  })

  const colWidth = Math.max(...descs.map((d) => d.w))
  const numCols = Math.max(
    1,
    Math.min(descs.length, Math.floor((targetWidth - ROOM_GAP) / (colWidth + ROOM_GAP))),
  )

  // Masonry: place the tallest rooms first, each into the shortest column.
  const colH = new Array<number>(numCols).fill(ROOM_GAP)
  const rooms: Room[] = []
  const seats = new Map<string, Seat>()

  for (const d of [...descs].sort((a, b) => b.h - a.h)) {
    let ci = 0
    for (let k = 1; k < numCols; k++) if (colH[k] < colH[ci]) ci = k
    const colX = ROOM_GAP + ci * (colWidth + ROOM_GAP)
    const x = colX + Math.round((colWidth - d.w) / 2) // centre the room in its column
    const y = colH[ci]

    rooms.push({
      slug: d.divSlug,
      label: d.label,
      color: d.color,
      x,
      y,
      w: d.w,
      h: d.h,
      floorIndex: d.floorIndex,
      decor: roomDecor(d.divSlug, x, y, d.w, d.h),
    })

    const gridW = d.cols * CELL_W
    const offsetX = Math.round((d.w - PAD * 2 - gridW) / 2) // centre desks in a widened room
    d.members.forEach((a, i) => {
      const c = i % d.cols
      const r = Math.floor(i / d.cols)
      const cellLeft = x + PAD + offsetX + c * CELL_W
      const cellTop = y + NAMEPLATE + TOP_BAND + r * CELL_H
      // Workstation stacks: character head (top) → monitor on the desk → desk
      // (front). The monitor sits centred on the desk; the head shows above it.
      const seatX = cellLeft + (CELL_W - 16) / 2
      const seatY = cellTop + 14
      const deskX = seatX + 8 - DESK_W / 2
      const deskY = seatY + 15 // desk pulled up so it meets the monitor (no gap)
      // A coffee mug on ~40% of desks (stable per agent), to the right of the monitor.
      const coffee = hashStr(a.slug) % 5 < 2 ? { x: seatX + 13, y: seatY + 23 } : undefined
      seats.set(a.slug, { slug: a.slug, seatX, seatY, deskX, deskY, pcX: seatX, pcY: seatY + 12, coffee })
    })

    colH[ci] += d.h + ROOM_GAP
  }

  const worldW = ROOM_GAP + numCols * (colWidth + ROOM_GAP)
  const worldH = Math.max(...colH)
  return { worldW, worldH, rooms, seats }
}
