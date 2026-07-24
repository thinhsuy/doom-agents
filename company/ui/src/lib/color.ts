/** Translucent version of a hex brand colour, for tinted icon/chip backgrounds. */
export function tint(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if ([r, g, b].some(Number.isNaN)) return `rgba(138,144,168,${alpha})`
  return `rgba(${r},${g},${b},${alpha})`
}
