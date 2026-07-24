// Loads the vendored Pixel Agents sprite sheets (MIT — see
// public/office/ATTRIBUTION.md) and exposes them to the renderer. We slice the
// sheets directly with drawImage source-rects.
//
// There are 6 base character PNGs, used with their original colours. Each
// department is assigned one of the 6 types (see DIVISION_CHAR in engine.ts), so
// everyone in a room looks the same "kind" of staff.

const BASE = import.meta.env.BASE_URL

export const TILE = 16
export const CHAR_W = 16
export const CHAR_H = 32
export const BASE_CHARS = 6 // char_0.png .. char_5.png
export const FLOOR_COUNT = 9 // floor_0.png .. floor_8.png (distinct textures per room)

// Decorations placed around rooms to give them life (see layout.ts). Names match
// public/office/decor/<name>.png. Dimensions (w×h) matter for placement.
export const DECOR_KINDS = [
  'double_bookshelf', // 32×32 — the proper bookshelf, in a row along the top wall
  'bookshelf', // 32×16
  'painting', // 32×32
  'small_painting', // 16×32 — framed wall art
  'small_painting2', // 16×32
  'hanging_plant', // 16×32 — wall-hung plant
  'clock', // 16×32
  'whiteboard', // 32×32
  'plant', // 16×32
  'plant2', // 16×32
  'cactus', // 16×32
  'large_plant', // 32×48
  'pot', // 16×16 — small potted plant
  'bin', // 16×16
  'coffee', // 16×16
] as const
export type DecorKind = (typeof DECOR_KINDS)[number]

export interface Sheets {
  chars: HTMLImageElement[] // the 6 base character types, original colours
  deskFront: HTMLImageElement
  pcOn: HTMLImageElement
  pcOff: HTMLImageElement
  pcBack: HTMLImageElement // monitor seen from behind (screen faces the seated agent)
  floors: HTMLImageElement[] // one texture per room, indexed by Room.floorIndex
  wall: HTMLImageElement
  decor: Record<DecorKind, HTMLImageElement>
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`failed to load ${src}`))
    img.src = src
  })
}

export async function loadSheets(): Promise<Sheets> {
  const url = (p: string) => `${BASE}office/${p}`
  const chars = await Promise.all(
    Array.from({ length: BASE_CHARS }, (_, i) => loadImage(url(`characters/char_${i}.png`))),
  )
  const floors = await Promise.all(
    Array.from({ length: FLOOR_COUNT }, (_, i) => loadImage(url(`floors/floor_${i}.png`))),
  )
  const [deskFront, pcOn, pcOff, pcBack, wall] = await Promise.all([
    loadImage(url('furniture/DESK/DESK_FRONT.png')),
    loadImage(url('furniture/PC/PC_FRONT_ON_1.png')),
    loadImage(url('furniture/PC/PC_FRONT_OFF.png')),
    loadImage(url('furniture/PC/PC_BACK.png')),
    loadImage(url('walls/wall_0.png')),
  ])
  const decorList = await Promise.all(DECOR_KINDS.map((k) => loadImage(url(`decor/${k}.png`))))
  const decor = Object.fromEntries(DECOR_KINDS.map((k, i) => [k, decorList[i]])) as Record<
    DecorKind,
    HTMLImageElement
  >
  return { chars, deskFront, pcOn, pcOff, pcBack, floors, wall, decor }
}
