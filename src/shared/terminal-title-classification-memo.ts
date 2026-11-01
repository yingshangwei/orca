/** Pure title classifiers can reuse verdicts across unrelated store writes; changed titles become new keys, so no invalidation signal is needed. */
import { memoizeStringResult } from './string-result-cache'

/**
 * Cap: comfortably above the live working set (one title per open pane plus
 * retained rows) so steady-state hit rate stays ~100%, small enough that the
 * map cannot grow with session length. Entries hold a reference to a string the
 * store already retains, so the marginal cost is the map entry itself.
 */
const MAX_MEMOIZED_TITLES = 1024

export function memoizeTitleClassification<T>(
  classify: (title: string) => T
): (title: string) => T {
  return memoizeStringResult(classify, MAX_MEMOIZED_TITLES)
}
