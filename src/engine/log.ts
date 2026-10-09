import { guardOp } from "./guard";
import type { OpEntry, Op, TrackId } from "./types";

export const MAIN_TRACK: TrackId = "main";

export class OpLog {
  private entries: OpEntry[] = [];
  private seq = 0;
  private turn = 0;
  private group = 0;

  /**
   * The single gate every op passes through, whether it came from a director tool call or from a
   * recording somebody else shared. The interpreter's arithmetic — the clock, the camera, the ink
   * measure — assumes finite numbers and short strings; that assumption is enforced here rather than
   * left to whichever caller happens to have validated its input.
   *
   * 一次调用 = 一批。解释器里唯一要往后看的落点（`here`）只许读到本批为止，见 `compile.ts` 的
   * `placementView`：观众已经看过的那一格，不许被后落的那一批改写。
   */
  append(ops: Op[], track: TrackId): OpEntry[] {
    const batch = this.group++;
    const added = ops.map((op) => ({
      seq: this.seq++,
      track,
      turn: this.turn,
      group: batch,
      op: guardOp(op),
    }));
    this.entries.push(...added);
    return added;
  }

  nextTurn(): number {
    this.turn += 1;
    return this.turn;
  }

  get currentTurn(): number {
    return this.turn;
  }

  get lastSeq(): number {
    return this.seq;
  }

  ofTrack(track: TrackId): OpEntry[] {
    return this.entries.filter((e) => e.track === track);
  }

  /** Ops appended after a sequence number, on any track — used to answer gates. */
  after(seq: number): OpEntry[] {
    return this.entries.filter((e) => e.seq > seq);
  }

  all(): OpEntry[] {
    return this.entries.slice();
  }

  /**
   * How many ops are on the tape, without making a copy of it. `all()` is the right thing for exporting
   * and the wrong thing for a render path: the clock re-renders sixty times a second, and a view that
   * only wants to know "is there a show yet?" should not pay for the whole tape to find out.
   */
  get length(): number {
    return this.entries.length;
  }

  entryAt(seq: number): OpEntry | undefined {
    return this.entries.find((e) => e.seq === seq);
  }

  /**
   * Forget everything from `seq` onward, on every track. The tape is cut, not rewritten:
   * what survives keeps its sequence numbers, so the gap is itself a record of the re-take.
   */
  cutFrom(seq: number): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.seq < seq);
    this.seq = this.entries.reduce((m, e) => Math.max(m, e.seq + 1), 0);
    this.turn = this.entries.reduce((m, e) => Math.max(m, e.turn), 0);
    return before - this.entries.length;
  }

  /** Aside tracks play last-in-first-unwound: the main track never sees them. */
  asides(): TrackId[] {
    return [...new Set(this.entries.map((e) => e.track))].filter((t) => t !== MAIN_TRACK);
  }

  clear() {
    this.entries = [];
    this.seq = 0;
    this.turn = 0;
    this.group = 0;
  }

  /**
   * A saved log is a recording: restoring it replays the lesson with no model involved. Which also
   * makes it the one path where the input is entirely somebody else's bytes — a `#s=` fragment from
   * a stranger — so the same gate applies here. Nothing is rejected: an unreadable field is defaulted
   * and the rest of the show plays.
   *
   * 分批号一起进来：一支分享链接带着它当时是怎么一批一批落下的，重放于是和直播看见同一张台面（`here`
   * 的落点只读到本批为止，见 `compile.ts`）。老链接没有这个字段，整卷就是一批 —— 那正是它当年被排出来
   * 的样子。按最大号续上，因为按"接着讲"接上去的现场，新落的那一批不许和档案里某一批同号：同号就是
   * 同一批，那一格的落点就会又读到观众已经看过的那一段身后去。
   */
  restore(entries: OpEntry[]) {
    this.entries = entries
      .filter((e) => e && typeof e.seq === "number" && !!e.op)
      .map((e) => ({ ...e, op: guardOp(e.op) }))
      .sort((a, b) => a.seq - b.seq);
    this.seq = this.entries.reduce((m, e) => Math.max(m, e.seq + 1), 0);
    this.turn = this.entries.reduce((m, e) => Math.max(m, e.turn), 0);
    this.group = this.entries.reduce((m, e) => Math.max(m, (e.group ?? -1) + 1), 0);
  }

  export(): OpEntry[] {
    return this.all();
  }
}
