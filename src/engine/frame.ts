import { ownsTime } from "./compile";
import type { Compiled, Cue, Gate, Revision } from "./types";

/*
 * 时钟每一帧问带子的，全是同一类问题：这一刻哪一格还在跑。带子是只增不改的序列，一条 cue 落下去
 * 之后就不再动 —— 所以这些答案可以在带子排好的那一刻算一次，不必每走一格重扫整卷。
 *
 * 上一件把这笔账算给了 React（抽屉的日志、节拍条不许每帧重排整卷），同样的一句话还留在解释器自己
 * 脚下：`cameraAt` / `cutAt` / `visibleProps` / `cardAt` 一帧把整条 cue 表读四遍，其中 `cameraAt`
 * 还每帧 `filter` 出一份新的镜头轨 —— 十二万八千条里挑出三万两千条，拷一份新数组，一秒六十次。探针数的是
 * **渲染一帧在 cue 表上路过的格子数**（共享 CI 的毫秒噪声比省下来的还大）：2 000 / 8 000 / 32 000 /
 * 128 000 条 cue 的表，修前一帧路过 12 000 / 48 000 / 192 000 / 768 000 格 —— 带子长 16 倍，路过也
 * 长 16 倍；同一批规模的 seek 是 0.27 / 1.34 / 2.98 / 11.86ms，而一帧的预算是 16.7ms。
 * 修完那一帧路过 0 格，11.86ms 降到 3.93ms —— 剩下的那几毫秒是"这一刻站着的道具"，与带子多长无关。
 *
 * 靠两件"带子已排序"本该付的价钱：
 *
 *  - 二分找边界。cue 按落下顺序排，`t` 因此单调不减。
 *  - 前缀最大结束时刻。叠层的 cue 会互相盖住（同一拍里两刀 camera 的 `t` 相同、`end` 不同），所以
 *    `end` 本身不单调、不能按它二分；但它的**前缀最大值**单调不减 —— 某处前缀最大 <= t，就说明这一处
 *    及之前全部走完。于是"还在跑的"恰好落在 `[第一条前缀最大 > t, 第一条 t > t)` 这一小段里，一段在
 *    演的戏同时站着的格子屈指可数，与带子多长无关。
 *
 * 窄表按 kind 分好（镜头与幕布、占时钟的、旁白、换场、运动按道具），同一问不再"读完整条带再挑"。
 * 卡片另有一张**开卡表**：`said` 只随带子变（他的回答本身是一条 op，进门就重排），所以它是带子的
 * 函数，可以在这里算一次 —— 旧写法在一张没人答过的旧卡之后，每一帧都把它前面整段已答的卡重扫一遍。
 */

/** 第一条 `a[i] > v` 的下标；全都 `<= v` 就是 `a.length`。`a` 必须单调不减。 */
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

/**
 * 道具在 `t` 这一刻站着的那一次外观：倒着找第一条 `t` 已经到的。和"筛完整列再取最后一格"同解，
 * 只是不每帧复制一份外观表。
 */
export function revisionAt(revisions: Revision[], t: number): Revision | undefined {
  for (let i = revisions.length - 1; i >= 0; i--) {
    if (revisions[i].t <= t) return revisions[i];
  }
  return undefined;
}

/** 一帧的画框：已经站定的那一刀的落点，和正在滑的那一刀。 */
export interface CameraFrame {
  /** 这一刻之前最后一条走完的镜头/幕布；一条都还没走完就是 null（画面还是初始那一屏）。 */
  settled: Cue | null;
  /** 正在滑的那一刀；null 就是画面已经站定。 */
  moving: Cue | null;
}

/**
 * 带子的位置索引：只回答"这一刻哪一格在跑"，不算画面、不碰 DOM，所以它的对错可以单独问。
 * 建一次是 O(带子)，只在带子动的时候建；一帧问的是几次二分加"同时在跑的几格"。
 */
export class TapeIndex {
  private readonly cues: Cue[];
  private readonly cueT: number[];
  /** 前缀最大 `end`：某处 <= t，就说明这一处及之前的 cue 都走完了。 */
  private readonly cueMaxEnd: number[];

  /** 镜头与幕布：一帧的画框只由这条窄表决定。 */
  private readonly camCues: Cue[] = [];
  private readonly camT: number[] = [];
  private readonly camMaxEnd: number[];

  /** 占时钟的 cue：互不重叠（下一拍的 `start` 就是上一拍的 `end`，且 `cueMs` 恒正）。 */
  private readonly timedT: number[] = [];
  private readonly timedCues: Cue[] = [];

  private readonly narrT: number[] = [];
  private readonly narrCues: Cue[] = [];

  /** 幕布单独一条窄表：它占时钟，彼此不重叠。画框那条表里它可能排在一条更短的镜头之后，
   * 所以"这一刻盖没盖着幕布"不能借画框的答案。 */
  private readonly veilT: number[] = [];
  private readonly veilCues: Cue[] = [];

  /** 走过的换场：`flip` 是幕布盖住整块板的那一刻；换场占时钟，所以 `flip` 递增。 */
  private readonly flips: number[] = [];
  private readonly boards: string[] = [];

  private readonly motionById = new Map<string, Cue[]>();

  /** 卡片按 `t` 递增；开卡表按下标升序，表头就是全带最早那张没答的。 */
  private readonly gateT: number[];
  private readonly openAt: number[];

  private readonly compiled: Compiled;

  constructor(compiled: Compiled) {
    this.compiled = compiled;
    this.cues = compiled.cues;
    const n = this.cues.length;
    this.cueT = new Array(n);
    this.cueMaxEnd = new Array(n);
    this.camMaxEnd = [];
    let maxEnd = -Infinity;
    let camMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const c = this.cues[i];
      this.cueT[i] = c.t;
      if (c.end > maxEnd) maxEnd = c.end;
      this.cueMaxEnd[i] = maxEnd;
      const kind = c.op.kind;
      if (kind === "camera" || kind === "transition") {
        this.camCues.push(c);
        this.camT.push(c.t);
        if (c.end > camMax) camMax = c.end;
        this.camMaxEnd.push(camMax);
      }
      if (kind === "transition") {
        this.veilT.push(c.t);
        this.veilCues.push(c);
        this.flips.push(c.t + (c.end - c.t) / 2);
        this.boards.push(c.op.to);
      }
      if (ownsTime(c.op)) {
        this.timedCues.push(c);
        this.timedT.push(c.t);
      }
      if (kind === "narrate") {
        this.narrT.push(c.t);
        this.narrCues.push(c);
      }
      if (kind === "motion") {
        const list = this.motionById.get(c.op.id);
        if (list) list.push(c);
        else this.motionById.set(c.op.id, [c]);
      }
    }

    this.gateT = compiled.gates.map((g) => g.t);
    this.openAt = [];
    for (let i = 0; i < compiled.gates.length; i++) {
      if (compiled.gates[i].said === null) this.openAt.push(i);
    }
  }

  /**
   * 这一刻还在跑的格子区间 `[from, to)`：`from` 之前的前缀最大 `end` 都不超过 `t`（全都走完了），
   * `to` 之后的一条还没落下。带子的长度不进这一帧。
   */
  running(t: number): [number, number] {
    const from = firstAbove(this.cueMaxEnd, t);
    const to = firstAbove(this.cueT, t);
    return to > from ? [from, to] : [0, 0];
  }

  /** 这一刻在跑的强调叠层：同一道具取**最早落下**的那条（旧写法 `filter(...).find(...)` 同解）。 */
  highlightsAt(t: number): Map<string, string> {
    const out = new Map<string, string>();
    const [from, to] = this.running(t);
    for (let i = from; i < to; i++) {
      const c = this.cues[i];
      if (c.op.kind !== "highlight" || c.end <= t) continue;
      if (!out.has(c.op.target)) out.set(c.op.target, c.op.style);
    }
    return out;
  }

  /** 这一刻在跑的、指向这个道具的运动：取**最后落下**的那条（旧写法 `filter(...).pop()` 同解）。 */
  motionFor(id: string, t: number): Cue | undefined {
    const list = this.motionById.get(id);
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (c.t <= t && c.end > t) return c;
    }
    return undefined;
  }

  /**
   * 走到 `t` 这一刻的画面：最后一条走完的镜头/幕布，加上正在滑的那一刀。
   * 前缀最大值第一次超过 `t` 的那一格，本身就是第一条 `end > t` 的（它之前的全都走完了，而那一点
   * 增量只能来自它自己）。旧写法顺序扫到第一条没结束的就停，两条叠着的刀取先落的那条 —— 同解。
   */
  cameraFrame(t: number): CameraFrame {
    const from = firstAbove(this.camMaxEnd, t);
    return {
      settled: from > 0 ? this.camCues[from - 1] : null,
      moving: from < this.camCues.length && this.camCues[from].t <= t ? this.camCues[from] : null,
    };
  }

  /** 这一刻还盖着的幕布：占时钟，所以一帧最多一张。 */
  veilAt(t: number): Cue | null {
    const i = firstAbove(this.veilT, t) - 1;
    if (i < 0) return null;
    const c = this.veilCues[i];
    return c.end > t ? c : null;
  }

  /**
   * 这一刻站着的那一拍（占时钟的 cue）。区间互不重叠，所以最多一条；一条都站不上就是 null，
   * 时钟走到带子外面正是这样。
   */
  beatAt(t: number): Cue | null {
    const i = firstAbove(this.timedT, t) - 1;
    if (i < 0) return null;
    const c = this.timedCues[i];
    return c.end > t ? c : null;
  }

  /** 这一刻在念的那一句。 */
  narrationAt(t: number): Cue | null {
    const i = firstAbove(this.narrT, t) - 1;
    if (i < 0) return null;
    const c = this.narrCues[i];
    return c.end > t ? c : null;
  }

  /**
   * 时钟已经走过幕布的那一刀。旧写法扫到第一条 `flip > t` 就停 —— 拿的正是最后一次不超过的；
   * 换场占时钟、彼此不重叠，`flip` 递增，所以二分同解。
   */
  cutAt(t: number): { flip: number; board: string } | null {
    const i = firstAbove(this.flips, t) - 1;
    return i < 0 ? null : { flip: this.flips[i], board: this.boards[i] };
  }

  /**
   * 这一刻站着的卡：走过的里面先问还开着的那一张，再问"问它的那一拍还没走完"的那一张。
   * 开卡表表头是全带最早那张没答的，所以"它落在走过的那段里吗"是一次比较，不是一趟扫描。
   */
  cardAt(t: number): Gate | null {
    const reached = firstAbove(this.gateT, t);
    if (reached === 0) return null;
    if (this.openAt.length && this.openAt[0] < reached) return this.compiled.gates[this.openAt[0]];
    // 走过的全都答过了。卡的窗口是问它的那一拍，拍随带子递增，所以窗口最长的是最后走过的那张。
    const last = this.compiled.gates[reached - 1];
    return t < last.until ? last : null;
  }

  /** 还没答的卡的 seq，升序。 */
  openGateSeqs(): number[] {
    return this.openAt.map((i) => this.compiled.gates[i].seq);
  }

  /** 第一张还没答的卡，不看时钟站在哪儿。表头就是它。 */
  firstOpenGate(): Gate | null {
    return this.openAt.length ? this.compiled.gates[this.openAt[0]] : null;
  }
}
