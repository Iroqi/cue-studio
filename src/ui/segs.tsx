import type { ReactElement } from "react";
import type { Stage } from "../engine/runtime";
import type { Beat, Compiled } from "../engine/types";
import type { Teacher } from "../agent/loop";
import { Seg } from "./Seg";

/**
 * 这一层唯一的钱是**做段元素**：一段元素要把一拍折成"第几拍、什么时候、讲了什么、能不能剪回去"，
 * 还要折成"这一段有多宽"。所以价钱层数的就是它 —— `segEl` 门口加一，谁都绕不过去（段元素只能从这
 * 里出来）。
 *
 * `published` 是这一件**没有消掉**的那一笔，和 `rowsMeter.published` 同一句话：React 认的是那份子
 * 数组的引用，所以脏了一格就得重新交一份（抄的是指针，不是段）。它按交出去的长度计数，于是"没动的
 * 帧一次也不许多抄"和"动了的帧抄的就是拍表的长度"两句都钉得住。
 *
 * 和 `rowsMeter` 同一句：不数毫秒。跨拍那一帧的钱有两半，各自有指纹：这里数**做了几段元素**，
 * `view.test.ts` 那边数**几段真的重新 render 了**（拿 `teacher.canReroll` 的调用次数）。
 *
 * `boxed` 是第三格，钉的是**另一件东西**：那一横滚的容器（`BeatRail` 里的 `Beats`）自己有没有被进去。
 * 容器不 memo 时，段元素一个也不会重做、`canReroll` 一次也不会响（React 拿到同一批元素引用就在每一格
 * 上驳回去），可它仍然把那 n 格**走了一遍** —— 实测 4800 段一帧 0.03ms 对 0.16ms。那一笔前两件尺子都
 * 量不到，所以容器自己门口加一个数：进了就是走了一遍。
 */
export const railMeter = { segs: 0, published: 0, boxed: 0 };

/**
 * 容器门口那一格。单独一个函数而不是让 `Beats` 自己写 `railMeter.boxed += 1`：仓库那条 lint 规矩
 * （`react/immutability`）不许在 render 里改模块外那个对象，而这一问要的恰恰是"render 里进没进"。
 * `segs` 与 `published` 两个数加在非组件的函数里（`segEl` / `take`），没有这个问题。
 */
export function countBoxed(): void {
  railMeter.boxed += 1;
}

/** 每一段都要用的那"一双手"：换任何一样，整条都得重排。 */
export interface SegView {
  stage: Stage;
  teacher: Teacher | null;
  onArm: (b: Beat, i: number) => void;
}

/**
 * 一段**印出来**的那几样：全是排出去那一刻的值，印完就不再动。这是这一件最要紧的一处形状。
 *
 * 为什么不许把 `Beat` 本身当"要印什么"传下去：解释器是**原地**长那一拍的（`play` 里那句
 * `cur.end = Math.max(...)`，`gate` 会从 false 变 true，`headline` 会从空变成那一句），而 `memo` 比的
 * 是 props 的引用 —— 传那个活对象，它就永远是同一个引用，于是段**变了也不许重画**：回头改的那一格
 * 排了个新元素，React 拿旧 props 一比，照样驳回去。改前那条路为什么没露馅？因为它每批都带着一个
 * `total = duration` 在动，每一段都被迫重新 render，**顺手**把变了的那几样带了出去 —— 也就是说它的
 * 正确是靠那笔冤枉钱撑着的。D 消掉那笔钱，就必须把"印出来"换成值；否则消掉的是价钱，留下的是错的
 * 画面（旧宽度的段、没长出来的台词、该挂"问"字却空着的那一格）。
 */
export interface SegPrint {
  /** `第 n 拍 · a–bms · 出自第 k 次调度 · 那一拍的刀`。 */
  title: string;
  /** 那一拍的台词；没有台词的调度是"（无声调度）"。 */
  headline: string;
  /** 这一拍里挂着卡：段上那个"问"字。 */
  ask: boolean;
  /** 这一段有多宽：`max(1, end − start)` 毫秒。 */
  grow: number;
  /** 出自第几次调度：`canReroll` 问的就是它。 */
  turn: number;
}

function printSeg(b: Beat, i: number): SegPrint {
  return {
    title: `第 ${i + 1} 拍 · ${Math.round(b.start)}–${Math.round(b.end)}ms · 出自第 ${b.turn} 次调度 · ${b.verbs.join(" ")}`,
    headline: b.headline || "（无声调度）",
    ask: b.gate,
    grow: Math.max(1, Math.round(b.end - b.start)),
    turn: b.turn,
  };
}

/** 印出来的那几样是不是同一份 —— 回头改的那一格就问这一句。 */
function samePrint(a: SegPrint | undefined, b: SegPrint): boolean {
  return !!a && a.grow === b.grow && a.title === b.title && a.headline === b.headline && a.ask === b.ask && a.turn === b.turn;
}

function segEl(b: Beat, i: number, p: SegPrint, view: SegView, now: boolean, armed: boolean): ReactElement {
  railMeter.segs += 1;
  return <Seg key={b.seqs[0]} stage={view.stage} teacher={view.teacher} onArm={view.onArm} b={b} i={i} p={p} now={now} armed={armed} />;
}

/**
 * 排好的那批段。
 *
 * 还是那一句：**认的东西换了、认的还是同一句引用**。`Compiled.beats` 是机器手上那条会长大的数组
 * （和 `cues`、`gates`、带子同一批），所以落一笔只吸收新落的那几拍。这一本账挂在**那条拍表**上
 * （`WeakMap` 的键是它本身）：剪带、载入、清空是换带子 → 新的一台机器 → 新的拍表 → 整条重排，那是
 * 诚实的价钱。
 *
 * 这里比 `RowIndex` 多一样：脏的不止尾巴，还有**身上那一格** —— 亮着的那一段换人要重做两段，被点
 * 准备重排的那一段换人也要重做两段，上一批最后那一拍还会被身后那一批改宽。所以脏的是一格**集合**
 * 而不是一个游标，它的上限是常数（五格），与带子多长无关。
 */
export class SegIndex {
  private readonly beats: readonly Beat[];
  private readonly view: SegView;
  private readonly els: ReactElement[] = [];
  /** 每一格**排出去时**印的那几样。宽度、卡、台词都会被身后那一批改，见 `grow` 头上那一段。 */
  private readonly prints: SegPrint[] = [];
  /**
   * `seqs[0] → 第几格`：被点住的那一拍在哪一格，由它查，不由整条走一遍。
   *
   * 写账的人就是吸收尾巴的那个人（`absorb`），所以这张表跟着 `els` 一起长，和 `RowIndex.bySeq` 是
   * 同一句。它只在续排那一头补格子；整条重建时构造器那一句 `findIndex` 仍然直白 —— 重建本来就是
   * 整条的价钱，那一趟不算多付。
   */
  private readonly atBySeq = new Map<number, number>();
  /** 亮着的那一格、被点住的那一格；`-1` 是"没有哪一格"。 */
  private nowAt: number;
  private armedAt: number;
  private at = 0;
  /** 和 `RowIndex.published` 是同一句话：没脏就不重新交那一份，否则 React 整棵当没变。 */
  private published: ReactElement[] | null = null;

  constructor(beats: readonly Beat[], view: SegView, now: number, armedSeq: number | undefined) {
    this.beats = beats;
    this.view = view;
    // 先定这两格再排：整条重建时那几段一次就排对，不必先排成"不亮"再回头重做那一段。
    this.nowAt = now;
    this.armedAt = armedSeq === undefined ? -1 : beats.findIndex((b) => b.seqs[0] === armedSeq);
    this.grow();
  }

  /**
   * 认的还是不是**同一双手**。`stage` 换不得（每一段握着它的 `seek`），`teacher` 换得更不得 —— 一段
   * 能不能剪回去问的就是它手上那一个，`null → Teacher`（学习者开场、导演接上）与反向都必须整条重排。
   * `onArm` 是 `useCallback([])`，可它的身份也在这一问里：换了就是换了另一双手。
   */
  holds(view: SegView): boolean {
    return this.view.stage === view.stage && this.view.teacher === view.teacher && this.view.onArm === view.onArm;
  }

  /**
   * 只长尾巴，外加**回头改紧邻的那一格**。
   *
   * 那一格为什么要改：解释器只把 `end` 长在**当前这一拍**身上，所以带子往后走时上一批最后那一拍的
   * `end` 会被它身后那一批改大，而 `end − start` 正是这一段的宽度。同一格里后到的还有那一面卡与那句
   * 台词（`quiz, 镜头, 镜头, 旁白` 里两张卡都开在同一拍上，而那一拍可能是一只先落下的镜头开场）。这是
   * 这一层唯一的"回头"，它改的**正是印在元素里的那些值**，所以不许不印（`RowIndex` 那句"`said` 没印
   * 所以可以不管"在这里反过来成立）。它最多只回改一格：新的一拍一开，前一拍就再也长不动了。所以价钱
   * 是"本批那几拍 + 1"，不是整条。
   */
  grow(): void {
    const last = this.at - 1;
    if (last >= 0) {
      const cur = this.beats[last];
      if (cur && !samePrint(this.prints[last], printSeg(cur, last))) this.relay(last);
    }
    while (this.at < this.beats.length) this.absorb(this.at++);
  }

  private absorb(i: number): void {
    const b = this.beats[i];
    const p = printSeg(b, i);
    this.prints[i] = p;
    this.els[i] = segEl(b, i, p, this.view, this.nowAt === i, this.armedAt === i);
    this.atBySeq.set(b.seqs[0], i);
    this.published = null;
  }

  /** 重做**那一格**：它亮不亮、被点住没有，由现在的 `nowAt`/`armedAt` 答。 */
  private relay(i: number): void {
    const b = this.beats[i];
    if (!b) return;
    const p = printSeg(b, i);
    this.prints[i] = p;
    this.els[i] = segEl(b, i, p, this.view, this.nowAt === i, this.armedAt === i);
    this.published = null;
  }

  /**
   * 亮哪一格、点住哪一格：至多重做四格（旧亮、新亮、旧点、新点），与带子多长无关。
   *
   * 旧写法把 `now` 当 prop 传下去，于是那 n 段每跨一拍全部现做，React 拿到 n 个新引用，每一段都要
   * 重新比对（实测 4800 段一帧 29ms，拖进度条时每拖一下付一次）。
   */
  light(now: number, armedSeq: number | undefined): void {
    // 那一拍在第几格是查这张表，不是把整条走一遍：重排bar 挂着的时候这一句**每一帧**都跑，而格子
    // 在 absorb 那一刻就已经定了 —— 走一遍整条就是把这一件要消掉的那笔价钱请回来。
    const armedAt = armedSeq === undefined ? -1 : (this.atBySeq.get(armedSeq) ?? -1);
    if (now === this.nowAt && armedAt === this.armedAt) return;
    const dirty = new Set<number>();
    if (now !== this.nowAt) {
      if (this.nowAt >= 0) dirty.add(this.nowAt);
      if (now >= 0) dirty.add(now);
      this.nowAt = now;
    }
    if (armedAt !== this.armedAt) {
      // 摘掉旧那一格按**已经记下的格子**问：被点住的那一拍可能已经在这一批里被剪掉了，那一格不再
      // 是这张表上的哪一格，可它上一次排出去的元素里仍然写着 `armed: true`。
      if (this.armedAt >= 0) dirty.add(this.armedAt);
      this.armedAt = armedAt;
      if (armedAt >= 0) dirty.add(armedAt);
    }
    // 越界的那一格由 `relay` 自己退：`now` 是调用方给的答案（`BeatRail` 那头的二分），这一句不许炸。
    for (const i of dirty) this.relay(i);
  }

  /** 对外那一份：没脏就交同一个引用（时钟那一帧整棵跳过），脏了才重新抄那一份指针。 */
  take(): readonly ReactElement[] {
    if (!this.published) {
      this.published = this.els.slice();
      railMeter.published += this.published.length;
    }
    return this.published;
  }
}

const cached = new WeakMap<readonly Beat[], SegIndex>();

/**
 * 门。与 `rowsFor` / `reindex` / `restand` 同形，只是这里还多问两句"亮哪一格、点住哪一格"。
 *
 * 那一双手每帧都是一个新的对象字面量，所以 `holds` 比的是里面那三样而不是它本身 —— 这本账认的是
 * "还是不是这台机器、这个导演、这个点击回调"，不是"还是不是那一帧"。
 */
export function segsFor(compiled: Compiled, view: SegView, now: number, armedSeq: number | undefined): readonly ReactElement[] {
  const beats = compiled.beats;
  const held = cached.get(beats);
  if (held && held.holds(view)) {
    held.grow();
    held.light(now, armedSeq);
    return held.take();
  }
  const fresh = new SegIndex(beats, view, now, armedSeq);
  cached.set(beats, fresh);
  return fresh.take();
}
