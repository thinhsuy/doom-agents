export function fmtInt(n: number): string {
  return n.toLocaleString('vi-VN')
}

/** Compact token count: 1234 -> "1.2K", 162100 -> "162K", 2_500_000 -> "2.5M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** USD, at most 2 decimals (integer for ≥$100 to avoid noise on large sums). Uses the
    MAGNITUDE for the threshold so negatives format like positives — e.g. $-52.19, not
    $-52.1900 (the raw-`n` check used to drop negatives into a 4-decimal branch). */
export function fmtUsd(n: number): string {
  if (Math.abs(n) >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

// ---- VND ------------------------------------------------------------------
// USD_VND is the OFFLINE FALLBACK rate only. The LIVE rate + all $/₫ conversion now live
// in the currency context (lib/currency.tsx → backend /api/fx, no-key FX APIs), which
// formats through fmtUsd / fmtVnd here. Edit this only as the last-resort offline default.
export const USD_VND = 25400

const vndFmt = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0,
})
/** Format a VND amount, e.g. 1234567 -> "1.234.567 ₫". */
export function fmtVnd(n: number): string {
  return vndFmt.format(Math.round(n))
}
