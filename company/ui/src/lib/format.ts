export function fmtInt(n: number): string {
  return n.toLocaleString('vi-VN')
}

/** Compact token count: 1234 -> "1.2K", 162100 -> "162K", 2_500_000 -> "2.5M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** USD with enough precision to be meaningful at sub-cent agent costs. */
export function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(4)}`
}
