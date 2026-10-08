import type { Cue, Gate, GateIndex, Prop, Revision, Staged, Timeline } from "./types";
import { upperBound } from "./search";

/*
 * A frame's worth of reading, for a tape longer than what the eye can hold.
 *
 * None of these return a new array of cues. The old read built one every frame — `cues.filter(...)` for
 * the camera, again for the highlights, again for the motions, `gates.filter(...)` for the cards, and
 * `revisions.filter(...)` once *per prop* — which at 60fps and 64k props is millions of arrays a second,
 * thrown away to answer a question that has a prefix answer. Measured before this file existed (jsdom,
 * min-of-7, one frame each): 1k props 0.086ms, 16k 2.746ms, 64k **15.317ms** — and a frame's whole
 * budget is 16.7ms, so the show spent it finding out what to draw.
 *
 * What is sorted gets searched. What is not sorted gets read inside one overlay window, whose size is
 * "how many cues are stacked at this instant", not "how long the lesson is". Everything here hands back
 * an index or a `Cue` from the list it was given — never a copy — because `loop.ts` recognises the cut it
 * just issued by object identity.
 */

/** A cue list plus its running maximum of `end`: the two arrays a binary search needs. */
export function watermarks(cues: Cue[]): Timeline {
  const t: number[] = new Array(cues.length);
  const open: number[] = new Array(cues.length);
  let high = -Infinity;
  for (let i = 0; i < cues.length; i++) {
    t[i] = cues[i].t;
    if (cues[i].end > high) high = cues[i].end;
    open[i] = high;
  }
  return { cues, t, open };
}

/** How many cues on this line have started by `t` (`t` is non-decreasing, so this is a count). */
export function startedBy(line: Timeline, t: number): number {
  return upperBound(line.t, t);
}

/**
 * A lower bound for "still running": every cue below it has `end <= t`, because `open` is the prefix
 * maximum. A bound, not the answer — a short cue swallowed by a longer one ahead of it sits above this
 * index with `end <= t`, and the old sequential loop still read it as settled.
 */
export function endedPast(line: Timeline, t: number): number {
  return upperBound(line.open, t);
}

/** The window a frame may read: started, and not known to have finished. */
export function windowOf(line: Timeline, t: number): { from: number; to: number } {
  return { from: endedPast(line, t), to: startedBy(line, t) };
}

/**
 * The two indexes the camera needs, found in one walk of the window.
 *
 * `running` is the first cue started and not finished — where the old sequential loop did its `return`,
 * mid-glide. `settled` is the index of the last cue before it that had finished — what that loop had left
 * in `rect`/`follow` by then. The cap is not cosmetic: the old loop `break`s on the first cue that has
 * not started and `return`s on the running one, so a frame the tape landed *after* the glide started is
 * still in the future of the picture and was never read.
 *
 * Both are -1 when there is nothing to report. Cost: two binary searches and the window, never the tape.
 */
export function framingAt(line: Timeline, t: number): { settled: number; running: number } {
  const to = startedBy(line, t);
  const floor = endedPast(line, t);
  // Below the bound every cue has finished by `t`, so the first running one is at or after it — and every
  // cue before that one is settled, which is why `settled` is just the index above it.
  for (let i = floor; i < to; i++) if (line.cues[i].end > t) return { settled: i - 1, running: i };
  return { settled: to - 1, running: -1 };
}

/** The last running cue at `t`, or null — what the old `filter(...).pop()` left. */
export function runningLast(line: Timeline, t: number): Cue | null {
  const { from, to } = windowOf(line, t);
  for (let i = to - 1; i >= from; i--) if (line.cues[i].end > t) return line.cues[i];
  return null;
}

/** The first running cue at `t`, or null — what the old `filter(...).find(...)` left, in tape order. */
export function runningFirst(line: Timeline, t: number): Cue | null {
  const { from, to } = windowOf(line, t);
  for (let i = from; i < to; i++) if (line.cues[i].end > t) return line.cues[i];
  return null;
}

/**
 * The revision standing on the board at `t`, or undefined if the prop had not appeared yet.
 *
 * `compile` stamps `r.t` in tape order, with one deliberate exception: filling a placeholder inherits
 * the moment the frame was laid down, which is *earlier*, never later. So a prop's list is
 * non-decreasing and "the last one at `t`" is one subtraction.
 */
export function revisionAt(p: Prop, t: number): Revision | undefined {
  const revs = p.revisions;
  if (revs.length === 0 || revs[0].t > t) return undefined;
  let lo = 0;
  let hi = revs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (revs[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return revs[lo - 1];
}

/**
 * Props with artwork, in tape order.
 *
 * `at` is *not* sorted: a name the director only ever `link`s enters the prop table when it is mentioned,
 * but its first revision lands whenever it is finally built — possibly after a prop named later. So the
 * searchable array is `reach[i] = min(at[i..])`, the running minimum from the right: non-decreasing by
 * construction, and `reach[i] > t` means no prop at or after `i` has landed yet. A lesson that never
 * mentions a name before painting it has `reach === at`, so the bound is exact for the common shape and
 * only as loose as the few late props in the weird one — and the order stays the tape's, because paint
 * order is z-order. A name only ever mentioned by `link` has no revision and is not in here at all, the
 * same rule that keeps it out of `agentSnapshot`.
 */
export function staged(props: Iterable<Prop>): Staged {
  const list: Prop[] = [];
  const at: number[] = [];
  for (const p of props) {
    const first = p.revisions[0];
    if (!first) continue;
    list.push(p);
    at.push(first.t);
  }
  const reach: number[] = new Array(at.length);
  let low = Infinity;
  for (let i = at.length - 1; i >= 0; i--) {
    if (at[i] < low) low = at[i];
    reach[i] = low;
  }
  return { props: list, at, reach };
}

/**
 * The card the playhead is standing in, exactly as the old `cardAt` chose it: an open question wins,
 * otherwise the latest answered card whose own beat is still on screen.
 *
 * `open` is in tape order, so if its first card has not been reached, none has. `said` is in tape order
 * too, and a card's window is the beat that asked it: beats are sequential and each ends no earlier
 * than the one before, so `until` is non-decreasing along `said` — the last reached card is the one
 * still showing its answer, and nothing further back is worth scanning.
 */
export function cardAt(gates: GateIndex, t: number): Gate | null {
  const next = gates.open[0];
  if (next && next.t <= t) return next;
  const k = upperBound(gates.saidT, t);
  if (k === 0) return null;
  const last = gates.said[k - 1];
  return last.until > t ? last : null;
}
