import type { ReactElement } from "react";
import type { Stage } from "../engine/runtime";
import type { Beat, Compiled } from "../engine/types";
import type { Teacher } from "../agent/loop";
import { Seg } from "./Seg";

/**
 * 亮哪一拍：一台**只答"此刻是第几拍"的小机器**，段自己订阅它。这是 F 的全部机关。
 *
 * 从前"亮不亮"编在段元素的 props 里，所以 `now` 一跨拍，那一段就得换个新元素、那一份数组就得重新交
 * 一遍（`take()` slice 整条，O(带子)），容器也得进门把那 n 格走一遍（`boxed`）—— 可带子一个字没动，
 * 变的只有"哪一格"。这一件把那一问从父手里搬到段自己手里：段订阅的是 `get() === i` 这一句**派生布尔**，
 * 不是那个每帧换的 `now` 数字（订阅数字 → 全 n 段每帧都醒，比现在还差 n 倍 —— 探针跑完就删，实测就是
 * 这个差别）。`useSyncExternalStore` 比快照用 `Object.is`，所以派生布尔翻没翻面就是醒不醒的依据：跨拍只
 * 翻两段，数组引用不动、容器不进。
 *
 * 它和 `SegIndex` 同生命周期（存在那一本账里），而 `SegIndex` 挂在 `cached` 那条拍表的引用上（WeakMap
 * 的键），所以换卷 → 新拍表 → 新机器 → 整条重排，和 `segsFor` 认引用是同一句话。`set` 只在**值真的换了**
 * 时 notify 一次。
 */
export class NowStore {
  private now = -1;
  private readonly listeners = new Set<() => void>();
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  get = (): number => this.now;
  /** 值没换就一次都不 notify —— 不动的那一帧，一段都不许因为这句话而醒。 */
  set(v: number): void {
    if (v === this.now) return;
    this.now = v;
    for (const l of this.listeners) l();
  }
}

/**
 * 这一层唯一的钱是**做段元素**：一段元素要把一拍折成"第几拍、什么时候、讲了什么、能不能剪回去"，
 * 还要折成"这一段有多宽"。所以价钱层数的就是它 —— `segEl` 门口加一，谁都绕不过去（段元素只能从这
 * 里出来）。
 *
 * `published` 数的是**交出去那一份的长度**。React 认的是那份子数组的引用，所以换了一段就得重新交一份
 * （抄的是指针，不是段）。F 把它从**跨拍那一帧**上摘下来了：亮不亮不再编进 props，跨拍时数组一个字没动、
 * `take()` 交回同一个引用，那一帧一次也不许多抄。`published` 从此只在真的换了一段时付（落一批长尾巴、
 * 点住与放开那一格、回头改那一格）—— 它仍跟着带子长（落一批那一次抄整条，是 C 实测钉过的诚实价），
 * 只是从"每一跨拍都付"缩回"每一批才付"。
 *
 * 和 `rowsMeter` 同一句：不数毫秒。跨拍那一帧的钱有三样，各自有指纹：这里数**做了几段元素**与**重没重交
 * 那一份**（`segs`、`published`），`view.test.ts` 那边数**几段真的重新 render 了**（`teacher.canReroll`
 * 的调用次数）。F 之后跨拍那一帧这三格分别应当是 ≤2、0、≤2。
 *
 * `boxed` 是第三格，钉的是**另一件东西**：那一横滚的容器（`BeatRail` 里的 `Beats`）自己有没有被进去。
 * 容器不 memo 时，段元素一个也不会重做、`canReroll` 一次也不会响，可它仍然把那 n 格**走了一遍** ——
 * 那一笔前两把尺子都量不到，所以容器门口加一个数。F 之前跨拍那一帧容器必进（数组换了引用，memo 驳不回），
 * F 之后跨拍不换数组、容器不进，这一格从"跨拍 + 落笔都进"缩回"只有落笔进"。
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

function segEl(b: Beat, i: number, p: SegPrint, view: SegView, store: NowStore, armed: boolean): ReactElement {
  railMeter.segs += 1;
  return <Seg key={b.seqs[0]} stage={view.stage} teacher={view.teacher} onArm={view.onArm} b={b} i={i} p={p} store={store} armed={armed} />;
}

/**
 * 排好的那批段。
 *
 * 还是那一句：**认的东西换了、认的还是同一句引用**。`Compiled.beats` 是机器手上那条会长大的数组
 * （和 `cues`、`gates`、带子同一批），所以落一笔只吸收新落的那几拍。这一本账挂在**那条拍表**上
 * （`WeakMap` 的键是它本身）：剪带、载入、清空是换带子 → 新的一台机器 → 新的拍表 → 整条重排，那是
 * 诚实的价钱。
 *
 * 这一本账管三样脏，都是常数格：
 *  - **尾巴**：新落的几拍，`grow` 逐格 `absorb`。
 *  - **回头那一格**：上一批最后那一拍会被身后那一批改宽/补台词/挂卡（见 `grow` 头上那段），改的是
 *    **印出来的值**，所以排一个新元素进去。
 *  - **点住那一格**（`armed`）：用户按下 ⟲，重排bar 挂着，那一格换元素。同样是常数格。
 *
 * **亮不亮不在这里。** 从前 `now` 也走上面这条路（换亮就重做两格、重新交数组），F 把它从这一本账里搬走了：
 * 每一段自己订阅那台 `store`（`get() === i`），`now` 一跨拍只唤醒翻面的那两段、数组一个字不动。所以
 * `published` 从此**不因跨拍而换引用** —— 这是这一件要消的那笔 O(带子)（探针：`railPublished` 64000@2000 帧）。
 */
export class SegIndex {
  private readonly beats: readonly Beat[];
  private readonly view: SegView;
  /** 每一段订阅的那台机器：亮哪一格只在它身上，由 `BeatRail` 在 layout effect 里推进（不在 render 里 notify）。 */
  readonly store: NowStore;
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
  /** 被点住的那一格；`-1` 是"没有哪一格"。亮哪一格由 `store` 回答，不在这里。 */
  private armedAt: number;
  private at = 0;
  /** 和 `RowIndex.published` 是同一句话：没脏就不重新交那一份，否则 React 整棵当没变。 */
  private published: ReactElement[] | null = null;

  constructor(beats: readonly Beat[], view: SegView, now: number, armedSeq: number | undefined) {
    this.beats = beats;
    this.view = view;
    // 整条重建时先给那台机器一个当前值：新落的那一段第一次 render 就要印对"此刻亮不亮"。构造这一刻还没有
    // 段订阅它（元素尚未 render），`set` 那一句 notify 是空转 —— 不在 render 里唤醒别人的规矩在这一头天然成立。
    this.store = new NowStore();
    this.store.set(now);
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
    this.els[i] = segEl(b, i, p, this.view, this.store, this.armedAt === i);
    this.atBySeq.set(b.seqs[0], i);
    this.published = null;
  }

  /** 重做**那一格**：它被点住没有，由现在的 `armedAt` 答（亮不亮不在元素里，归 `store`）。 */
  private relay(i: number): void {
    const b = this.beats[i];
    if (!b) return;
    const p = printSeg(b, i);
    this.prints[i] = p;
    this.els[i] = segEl(b, i, p, this.view, this.store, this.armedAt === i);
    this.published = null;
  }

  /**
   * 点住与放开那一格：至多重做两格（旧点、新点），与带子多长无关。
   *
   * `now` 那一半已经搬去 `store`，这里只剩 `armed` —— 它是用户动作（按 ⟲）、罕见，付一次换引用是诚实价。
   * 越界那一格由 `relay` 那句 `if (!b) return` 自己退（`armedSeq` 指向被剪掉那一拍时那一格已不在账上）。
   */
  arm(armedSeq: number | undefined): void {
    // 那一拍在第几格是查这张表，不是把整条走一遍：这一句每一帧都跑，走整条就是把这件要消的价钱请回来。
    const armedAt = armedSeq === undefined ? -1 : (this.atBySeq.get(armedSeq) ?? -1);
    if (armedAt === this.armedAt) return;
    const dirty = new Set<number>();
    if (this.armedAt >= 0) dirty.add(this.armedAt);
    this.armedAt = armedAt;
    if (armedAt >= 0) dirty.add(armedAt);
    for (const i of dirty) this.relay(i);
  }

  /** 对外那一份：没脏就交同一个引用（跨拍那一帧整棵跳过），脏了才重新抄那一份指针。 */
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
 * 门。与 `rowsFor` / `reindex` / `restand` 同形，只是这里不再"换亮"—— `now` 不在这里进元素、也不再让
 * `take()` 换引用；它只用来在**整条重建**那一刻给那台 `store` 一个初值。续排那一头 `now` 一个字不进这本账，
 * 亮哪一格由 `BeatRail` 从 `nowStore` 拿到那台机器、在 `useLayoutEffect` 里 `set`（探针实测：在 render 里
 * notify 会 "Cannot update a component while rendering a different component"，在 effect 里才干净）。
 */
export function segsFor(compiled: Compiled, view: SegView, now: number, armedSeq: number | undefined): readonly ReactElement[] {
  const beats = compiled.beats;
  const held = cached.get(beats);
  if (held && held.holds(view)) {
    held.grow();
    held.arm(armedSeq);
    return held.take();
  }
  const fresh = new SegIndex(beats, view, now, armedSeq);
  cached.set(beats, fresh);
  return fresh.take();
}

/**
 * 那一台 `store`：`BeatRail` 拿它、在 effect 里推 `now`。查的就是 `segsFor` 刚为这张拍表建的那本账 —— 同
 * 引用同一条拍表，所以拿到的机器与元素里嵌的是同一台。
 */
export function nowStore(compiled: Compiled): NowStore {
  const ix = cached.get(compiled.beats);
  // `segsFor` 先跑（`BeatRail` render 里就是这次序），账一定在；退一步给一台空机器，只答"没哪一拍亮"。
  return ix ? ix.store : new NowStore();
}
