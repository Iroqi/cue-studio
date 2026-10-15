import type { Beat, Compiled, DialOp, DragOp, ProbeOp, QuizOp, TypeOp } from "../engine/types";
import { ESC_RETRY, ESC_SKIP } from "../agent/loop";

/**
 * 时钟站在哪一拍。Beats are laid down in `start` order, so finding it is a
 * binary search — which is what lets the rail skip re-rendering on a tick that changed nothing.
 * `Math.max(end, start + 1)` mirrors the segment's own half-open window, so the tail beat of a tape
 * whose end was never closed counts as standing-in it, and a clock past the last window counts as in none.
 */
export function beatAt(beats: Beat[], t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return -1;
  const b = beats[found];
  return t < Math.max(b.end, b.start + 1) ? found : -1;
}

/**
 * 这一场的账（Intelligent UI 的 show your work / progress indicators / cost transparency）：
 * 带子上已经有的东西 —— 拍数、问了几道、答对几道、答错几道、逃了几道 —— 从 `compiled` 纯派生出来，
 * 亮到台上。不带时钟、不带模型、不带档案：同一卷带子，重放与现场同账。
 *
 * 分界的每一刀都照 `settleGate` 同一条线画（App 那张卡上的即时刻度也是这条线）：
 *  - `pause-for` 不算题（那是"继续"的门，不是考题）；
 *  - 逃生句（`ESC_RETRY`/`ESC_SKIP`）单开一本账，不算错 —— 求救不是答错；
 *  - 自由文本不算错（quiz"没选选项直接说了"、probe"没有点台上的图形"、dial"没有拨杆"、
 *    drag"没有搬动台上的图形"、type"这张卡没有定要出现的词"都落进"没判分"，不是"答错"）。
 * 孤儿 answer（`gate` 指不到任何一张卡）自然不在这本账上：账只从 `gates` 读。
 */
export interface Score {
  beats: number;
  /** 问了几道（quiz / probe / dial / type / drag；pause-for 不算题）。 */
  asking: number;
  /** 还开着的卡（`said === null`）。 */
  open: number;
  correct: number;
  wrong: number;
  /** 逃生句（「我不会」/「跳过这道」），单独一本账，不算错。 */
  escaped: number;
}

export function scoreOf(compiled: Compiled): Score {
  let asking = 0;
  let open = 0;
  let correct = 0;
  let wrong = 0;
  let escaped = 0;
  for (const g of compiled.gates) {
    if (g.kind === "pause-for") continue;
    asking++;
    if (g.said === null) {
      open++;
      continue;
    }
    const said = g.said;
    if (said === ESC_RETRY || said === ESC_SKIP) {
      escaped++;
      continue;
    }
    let ok: boolean | null = null;
    if (g.kind === "quiz") {
      const op = g.op as QuizOp;
      const choice = op.options.indexOf(said);
      ok = choice >= 0 ? choice === op.answer : null;
    } else if (g.kind === "probe") {
      const op = g.op as ProbeOp;
      ok = op.targets.includes(said) ? said === op.answer : null;
    } else if (g.kind === "dial") {
      const op = g.op as DialOp;
      const his = Number(said);
      ok = Number.isFinite(his) ? Math.abs(his - op.value) <= op.tol + 1e-9 : null;
    } else if (g.kind === "drag") {
      const op = g.op as DragOp;
      const m = /^\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*$/.exec(said);
      ok = m ? Math.hypot(Number(m[1]) - op.value.x, Number(m[2]) - op.value.y) <= op.tol + 1e-9 : null;
    } else {
      const op = g.op as TypeOp;
      const need = op.accept.map((w) => w.toLowerCase());
      ok = need.length === 0 ? null : need.every((w) => said.toLowerCase().includes(w));
    }
    if (ok === true) correct++;
    else if (ok === false) wrong++;
  }
  return { beats: compiled.beats.length, asking, open, correct, wrong, escaped };
}
