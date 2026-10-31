/** Nearest-rank percentile; a probe reports what it actually observed, not an interpolation. */
export function nearestRankPercentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null
  }
  const rank = Math.ceil(fraction * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index] ?? null
}
