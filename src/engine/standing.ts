import { onstageAt } from "./compile";
import type { Compiled, Prop, Revision } from "./types";

/*
 * 「此刻台上站着什么」的索引。
 *
 * 上一件把一次外观变成一段窗口 `[t, off)`，为的就是这一件：窗口铺满每个道具自己的时间线，所以"这一刻
 * 站着的那一格"不再是每一帧把整张道具表走一遍问出来的事，而是一个**扫过带子的游标**问出来的事。
 *
 * 修前一帧付的是"这卷带子一共有过几个道具"，而且付两遍（`visibleProps` 画名单、`owedAt` 数欠的画），
 * 名单里还包括观众早就看不见的：被换场扫走的、已经撤下的、还站在别的板上的。修后一帧付的是"这一刻真的
 * 越过的事件"（时钟一帧走十几毫秒，通常一个都没有）加"名单本身有多长" —— 台上有几样东西，就报几样。
 *
 * 靠两件窗口本该付的价钱：
 *
 *  - 落下和收走合成**一条**事件流，按时刻排好。游标只答"时刻 <= t 的全 apply 完"：前进是 apply，倒带是
 *    逐条退回去 —— 倒回三分钟前不重扫整卷，只退走过的那些。同一刻先收旧的再落新的（`[t, off)` 左闭右开
 *    就是这个次序），所以一条流够，不需要两份游标互相对账。
 *  - 每块板的外观按 `(t, rank)` 排好。换场之后才落下、却站在**别的**板上的那些仍然算看得见（`swept`
 *    的第二半条），那是每板排好队列里的一段**尾巴**，二分得动；"哪些板可能有尾巴"由这些板最晚一次落下
 *    的时刻排成一条升序表，同样二分。一板上的旧东西再多，落笔停在换场之前就根本进不了这一帧。
 *
 * 名单的次序是**落下次序**（`rank`）：和以前直接走 `Compiled.props` 那张表一样，层叠不许因为换了读法
 * 就改。所以名单只在台上真的变了东西时重排一次，一帧拿的是同一批对象、同一个数组引用。
 *
 * `swept` 那条规则在这里被折成两次二分，而 `runtime.ts` 里还留着那句原话（导演的快照要说"这一格是被
 * 换场扫走的"）。两处说法由 `standing.test.ts` 逐刻对账钉住 —— 不是"看起来一样"。
 */

/** 站着的那一格：一次外观，连着它属于哪个道具、什么时候收、它压在谁上面。 */
export interface Stand {
  prop: Prop;
  rev: Revision;
  /** 落下次序，也是层叠次序。 */
  rank: number;
}

interface Event {
  at: number;
  /** 收走排在同一时刻的落下之前：窗口左闭右开。 */
  leave: boolean;
  s: Stand;
}

/** 一块板排好队的外观：`starts` 按 `(t, rank)` 递增，所以"某刻之后落下的"是一段尾巴。 */
interface BoardLine {
  name: string;
  starts: number[];
  stands: Stand[];
  /** 这块板上最晚一次落下的时刻。 */
  last: number;
}

/** 第一条 `a[i] >= v` 的下标；全都 `< v` 就是 `a.length`。`a` 必须单调不减。 */
function firstAtOrAfter(a: number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] >= v) hi = m;
    else lo = m + 1;
  }
  return lo;
}

/** 第一条 `a[i] > v` 的下标；`a` 必须单调不减。 */
function firstAbove(a: number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] > v) hi = m;
    else lo = m + 1;
  }
  return lo;
}

const byStack = (a: Stand, b: Stand) => a.rank - b.rank;
const byStart = (a: Stand, b: Stand) => a.rev.t - b.rev.t || a.rank - b.rank;
const byEvent = (a: Event, b: Event) => a.at - b.at || (a.leave === b.leave ? 0 : a.leave ? -1 : 1);

export class StandingIndex {
  private readonly events: Event[] = [];
  /**
   * 按落笔时刻排好的那一列，`laidIn` 给的就是它的一段区间。一个道具同时只有一格站着，所以"这一拍落了
   * 几格"就是"这一拍欠几幅画"，与带子上总共有过几个道具无关。
   */
  private readonly arrives: Stand[] = [];
  private readonly arriveT: number[] = [];
  /** 游标：前 `p` 条事件已经 apply 完，所以手上的台就是 `events[p-1].at` 那一刻的台。 */
  private p = 0;

  /** 道具 id → 站着的那一格。一个道具同时只有一格站着：它的窗口不重叠。 */
  private readonly live = new Map<string, Stand>();
  private readonly onBoard = new Map<string, Map<string, Stand>>();
  private all: Stand[] = [];
  private perBoard = new Map<string, Stand[]>();
  private dirty = true;
  /** 上一次算出的可见名单，以及它属于哪块板、哪一刀。 */
  private vis: { board: string | null; flip: number; list: Stand[] } | null = null;

  private readonly lines: BoardLine[] = [];
  private readonly lineLast: number[];

  constructor(compiled: Compiled) {
    const byBoard = new Map<string, Stand[]>();
    let rank = 0;
    for (const prop of compiled.props.values()) {
      for (const rev of prop.revisions) {
        const end = rev.off ?? Infinity;
        // 空窗口（同一拍里落了又撤，或迟到的补画落在撤下之后）站不住任何一刻，不进事件流。
        if (end <= rev.t) continue;
        const s: Stand = { prop, rev, rank };
        // 分板看的是 `rev.scene`（这一次外观落在哪块板），不是 `prop.scene`（道具最后挪去哪了）——
        // `swept` 问的就是前者，借后者会把一板上的旧东西错记到新板头上。
        const line = byBoard.get(rev.scene);
        if (line) line.push(s);
        else byBoard.set(rev.scene, [s]);
        this.events.push({ at: rev.t, leave: false, s });
        if (Number.isFinite(end)) this.events.push({ at: end, leave: true, s });
        this.arrives.push(s);
      }
      rank++;
    }
    this.events.sort(byEvent);
    this.arrives.sort(byStart);
    this.arriveT = this.arrives.map((s) => s.rev.t);
    for (const [name, stands] of byBoard) {
      stands.sort(byStart);
      this.lines.push({ name, starts: stands.map((s) => s.rev.t), stands, last: stands[stands.length - 1].rev.t });
    }
    this.lines.sort((a, b) => a.last - b.last);
    this.lineLast = this.lines.map((l) => l.last);
  }

  /** 落下的那一格进台，收走的那一格出台。 */
  private put(s: Stand) {
    this.live.set(s.prop.id, s);
    const on = this.onBoard.get(s.rev.scene);
    if (on) on.set(s.prop.id, s);
    else this.onBoard.set(s.rev.scene, new Map([[s.prop.id, s]]));
    this.dirty = true;
  }

  private take(s: Stand) {
    // 只有它还代表这个道具时才收：同一刻新的一格可能已经把它顶替了。
    if (this.live.get(s.prop.id) !== s) return;
    this.live.delete(s.prop.id);
    this.onBoard.get(s.rev.scene)?.delete(s.prop.id);
    this.dirty = true;
  }

  private moveTo(t: number) {
    while (this.p < this.events.length && this.events[this.p].at <= t) {
      const e = this.events[this.p++];
      if (e.leave) this.take(e.s);
      else this.put(e.s);
    }
    while (this.p > 0 && this.events[this.p - 1].at > t) {
      const e = this.events[--this.p];
      // 倒着走就是把那一条按原样退回去：落下过的撤掉，收走过的重新站上去。
      if (e.leave) this.put(e.s);
      else this.take(e.s);
    }
  }

  /** 站着的全部，含被换场扫走的：导演的 `<stage>` 要的就是这一份（他要知道得靠 recall 才带得回来）。 */
  standing(t: number): Stand[] {
    this.moveTo(t);
    if (this.dirty) {
      this.all = [...this.live.values()].sort(byStack);
      this.perBoard = new Map();
      for (const [board, set] of this.onBoard) this.perBoard.set(board, [...set.values()].sort(byStack));
      this.dirty = false;
      this.vis = null;
    }
    return this.all;
  }

  /**
   * 观众这一刻看得见的格子，按层叠次序。`cut` 是时钟已经走过幕布的那一刀。
   *
   * 两半：站在这块板上的一切（这一刀扫不到自己板上的东西），加上这一刀之后才落下、却站在别块板上的那些
   * —— 导演点名了别的板但幕布没把他带过去，刚摆上去的东西就该看得见。`swept` 说的正是这一条，这里把它
   * 折成两次二分：板按"最晚一次落下"排，板内的队列按落笔时刻排。
   */
  visible(t: number, cut: { flip: number; board: string } | null): Stand[] {
    const standing = this.standing(t);
    // 一刀还没走过：整张平面就是一块板，站着的就是看得见的。
    if (!cut) return standing;
    const { board, flip } = cut;
    if (this.vis && this.vis.board === board && this.vis.flip === flip) return this.vis.list;
    const list = [...(this.perBoard.get(board) ?? [])];
    for (let i = firstAtOrAfter(this.lineLast, flip); i < this.lines.length; i++) {
      const line = this.lines[i];
      if (line.name === board) continue;
      for (let j = firstAtOrAfter(line.starts, flip); j < line.stands.length; j++) {
        const s = line.stands[j];
        if (s.rev.t > t) break;
        if (this.live.get(s.prop.id) === s) list.push(s);
      }
    }
    list.sort(byStack);
    this.vis = { board, flip, list };
    return list;
  }

  /**
   * 这一拍落的笔：时刻落在 `[from, to)`、而且到 `at` 这一刻还站得住的那些 ——「时钟站的这一拍还欠几幅
   * 画」问的就是这一句。旧写法为了它把整张道具表走一遍，连观众早就看不见的（换场扫走的、已经撤下的、
   * 站在别的板上的）也走。
   *
   * 两段二分定出区间，读的就是这一段本身：一帧的价钱由这一拍落了几格决定，带子的长度只进二分。
   * 落笔之后又被同一拍里的下一笔顶掉、或落了就撤的那一格，窗口盖不住 `at`，二分出来的区间里自然筛掉。
   */
  laidIn(from: number, to: number, at: number): Stand[] {
    const lo = firstAtOrAfter(this.arriveT, from);
    const hi = Math.min(firstAbove(this.arriveT, at), firstAtOrAfter(this.arriveT, to));
    const out: Stand[] = [];
    for (let i = lo; i < hi; i++) if (onstageAt(this.arrives[i].rev, at)) out.push(this.arrives[i]);
    return out;
  }
}
