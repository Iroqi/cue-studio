/**
 * The one primitive the whole read side stands on: `values` is non-decreasing, return the index of
 * the first entry strictly greater than `t` (so `lo` is also "how many entries are <= t").
 *
 * Every timeline in `types.ts` exists because something on the tape is sorted by this. A cue list is
 * sorted by `t` because the clock only moves forward; a prefix maximum of `end` is sorted by
 * construction; a prop's revisions are sorted because `compile` stamps them in tape order.
 */
export function upperBound(values: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
