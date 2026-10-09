import { ownsTime } from "./compile";
import type { Compiled, Cue, Gate } from "./types";
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

/** 第一条 `a[i] >= v` 的下标；`a` 必须单调不减。 */
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

/** 一帧的画框：已经站定的那一刀的落点，和正在滑的那一刀。 */
export interface CameraFrame {
  /** 这一刻之前最后一条走完的镜头/幕布；一条都还没走完就是 null（画面还是初始那一屏）。 */
  settled: Cue | null;
  /** 正在滑的那一刀；null 就是画面已经站定。 */
  moving: Cue | null;
}

/**
 * 带子的位置索引：只回答"这一刻哪一格在跑"，不算画面、不碰 DOM，所以它的对错可以单独问。
 * 建一次是 O(带子)，**只在带子换卷的时候建**；落一笔只吸收新落的那一截，一帧问的是几次二分加
 * "同时在跑的几格"。
 *
 * 一类的问句一条窄表，窄表带自己的前缀最大值。这里没有"什么都能问"的通用区间：那一版留过一份
 * `[第一条前缀最大 > t, 第一条 t > t)`，它的前缀最大是**整张表**的，所以一条合法长寿的叠层就能把
 * 左边界顶回表头 —— 于是每一帧把整张 cue 表走一遍，"带子的长度不进这一帧"当场失效。
 *
 * 续排能成立，靠的是 `Compiled` 里那两张表本来就是会长大的同一批容器（`compile.ts` 的 `result()`）：
 * 窄表全是 cue 表按落下次序的子序列，所以它们也只长尾巴；两条前缀最大值的游标跟着搬成字段。
 * 唯一一处会被**中间**改动的账是开卡表 —— 他的回答是身后的一刀 `answer`，把一张还开着的卡原地改成
 * 答过了。那一头见 `openAt`。
 */
export class TapeIndex {
  /** 镜头与幕布：一帧的画框只由这条窄表决定。 */
  private readonly camCues: Cue[] = [];
  private readonly camT: number[] = [];
  private readonly camMaxEnd: number[];
  /** 前缀最大值的游标：续排从上一次那个数接着记，不回头重算。 */
  private camMax = -Infinity;

  /** 占时钟的 cue：互不重叠（下一拍的 `start` 就是上一拍的 `end`，且 `cueMs` 恒正）。 */
  private readonly timedT: number[] = [];
  private readonly timedCues: Cue[] = [];

  private readonly narrT: number[] = [];
  private readonly narrCues: Cue[] = [];

  /** 会被 ⟲ 一拍倒回去的那些拍（旁白与沉默）。占时钟，所以互不重叠、`t` 递增。 */
  private readonly spokenT: number[] = [];
  private readonly spokenCues: Cue[] = [];

  /** 幕布单独一条窄表：它占时钟，彼此不重叠。画框那条表里它可能排在一条更短的镜头之后，
   * 所以"这一刻盖没盖着幕布"不能借画框的答案。 */
  private readonly veilT: number[] = [];
  private readonly veilCues: Cue[] = [];

  /*
   * 强调叠层也各有一条窄表，不借通用那张 `running` 的区间。借过一版，而它把一帧的价钱写成了"带子有
   * 多长"：通用区间靠**前缀最大 `end`** 定左边界，那一份把整表所有 cue 都算进去了，所以只要有一刀叠层
   * 比播放头所在的那一节带子更长寿（`duration` 的门封在 120000ms，一堂短课整个盖在里面），左边界就
   * 退回表头，一帧把整张 cue 表走一遍。探针量的正是这一条：一条 120 秒的 `highlight` 排在 2 000 /
   * 20 000 / 120 000 条的带子头上，站在带子中段那一帧按 4 002 / 40 002 / 180 003 格 —— 修前那一条
   * 「带子长 16 倍，一帧多走的路一格都不许多」根本没有覆盖它（同一拍里落的叠层，`end` 超不出这一拍，
   * 通用区间本来就窄），所以这一件给它补一条窄表：按**自己的**前缀最大值二分。
   */
  private readonly hlT: number[] = [];
  private readonly hlCues: Cue[] = [];
  private readonly hlMaxEnd: number[] = [];
  /** 前缀最大值的游标，同 `camMax`：续排从上一次那个数接着记。 */
  private hlMax = -Infinity;

  /** 走过的换场：`flip` 是幕布盖住整块板的那一刻；换场占时钟，所以 `flip` 递增。 */
  private readonly flips: number[] = [];
  private readonly boards: string[] = [];

  private readonly motionById = new Map<string, Cue[]>();

  /** 卡片按 `t` 递增；开卡表按下标升序，表头就是全带最早那张没答的。 */
  private gateT: number[] = [];
  /*
   * 开卡表 —— 这张索引上唯一一处会被**中间**改动的账。他的回答是身后的一刀 `answer`，它把一张早就
   * 进过账的卡原地从"没答"改成"答过了"，所以这一本不许"只长尾巴"。
   *
   * 旧写法每批把整张卡表重筛一遍，于是落一笔付的是"这堂课一共有过几张卡"。换成惰性作废：
   *  - 新落的卡往表尾接（还没答的才接），这是本批的钱；
   *  - 表头那一截答掉的，问的时候逐条迈过去（`head`），迈过去的那一格永不回头问第二次；
   *  - 全表那一问（`openGateSeqs`）筛掉作废的，**筛剩不到一半就把表换掉**。
   * `head` 是游标不是账，所以压实之后归零。
   *
   * 第三条那条规矩管的是**答在中间的那些**：`head` 只迈得过头那一截，中间作废的一格永远要每次问一遍
   * 时多走一步。不压实，一节问了 10000 张、每轮答掉中间一张的课就把这一截堆到带子那么长，每一问
   * 从头走到尾 —— 那正是被消掉的那笔税换了个名字回来。规矩不能写成"一发现有作废就整张换表"：那样
   * 每轮抄一次表，抄的还是整张表的长度。
   */
  private openAt: number[] = [];
  private head = 0;

  /** cue 表已经进账到第几格。带子是在手上会长大的那个数组，所以长度不能当场问它。 */
  private absorbedCues = 0;
  /** 卡表同理：已经进账到第几张。 */
  private absorbedGates = 0;

  private compiled: Compiled;

  constructor(compiled: Compiled) {
    this.compiled = compiled;
    this.camMaxEnd = [];
    this.absorbCues();
    this.absorbGates();
  }

  /** 把 cue 表新长的那一截分进各条窄表。 */
  private absorbCues(): void {
    const cues = this.compiled.cues;
    for (let i = this.absorbedCues; i < cues.length; i++) this.absorb(cues[i]);
    this.absorbedCues = cues.length;
  }

  /**
   * 把一格 cue 分进各条窄表。一次建完整卷和续排新落的那一截走的是**同一句**，所以续排不可能和
   * "从头建一本"给出不同的窄表 —— 差异只可能来自分表的规矩，而那是一处说法。
   */
  private absorb(c: Cue): void {
    const kind = c.op.kind;
    if (kind === "camera" || kind === "transition") {
      this.camCues.push(c);
      this.camT.push(c.t);
      if (c.end > this.camMax) this.camMax = c.end;
      this.camMaxEnd.push(this.camMax);
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
    if (kind === "narrate" || kind === "beat") {
      // ⟲ 一拍问的是"上一句说到哪儿"。占时钟，所以这条窄表互不重叠、`t` 递增 —— 二分就够，
      // 以前那一句每按一次把整张 cue 表 `filter` 一遍再 `reverse` 再 `find`。
      this.spokenT.push(c.t);
      this.spokenCues.push(c);
    }
    if (kind === "highlight") {
      // 窄表自带前缀最大值：并集那一份把整表都算进去，所以一条长寿的叠层能把通用区间的左边界
      // 顶回表头。这一条只数强调自己。
      this.hlT.push(c.t);
      this.hlCues.push(c);
      if (c.end > this.hlMax) this.hlMax = c.end;
      this.hlMaxEnd.push(this.hlMax);
    }
    if (kind === "motion") {
      const list = this.motionById.get(c.op.id);
      if (list) list.push(c);
      else this.motionById.set(c.op.id, [c]);
    }
  }

  /**
   * 把卡表新长的那一截接上。已经答过的不进开卡表。
   *
   * 这一筛**不是正确性**，只是省掉表头那一截的迈步：就算把答过的也接进去，`freshHead` 与
   * `openGateSeqs` 那两句仍然答对（它们读的是当下的 `said`）。新落的每一张当时都还没答，所以续排
   * 那一头筛不筛没有分别；差别只在"从零建一本、带子上已经有一截答过的"那种台面。正因为它是价钱
   * 不是对错，它就不许长成"每批把整张卡表重筛一遍"—— 那笔税是 `index-tail.test.ts` 第 2 节钉的。
   */
  private absorbGates(): void {
    const gates = this.compiled.gates;
    for (let i = this.absorbedGates; i < gates.length; i++) {
      this.gateT.push(gates[i].t);
      if (gates[i].said === null) this.openAt.push(i);
    }
    this.absorbedGates = gates.length;
  }

  /**
   * 这台索引吃的是不是**这一张** cue 表与卡表 —— 认的是引用，和解释器认带子（`Interpreter.holds`）同一句。
   *
   * `Interpreter.result()` 每次返回一个新的 `Compiled` 记录，可里面的 `cues` / `gates` 是同一批会长大的
   * 容器，所以落一笔引用不变（续排）；剪带、载入、清空换的是整台机器，那一头两张表都是新数组，
   * 这一问答"不是"，调用方重建一本（`runtime.ts`）。认错了就是把一节课的索引按在另一节课身上，
   * 而那一头只在下一次读数时露馅。
   */
  holds(compiled: Compiled): boolean {
    return this.compiled.cues === compiled.cues && this.compiled.gates === compiled.gates;
  }

  /**
   * 带子往下长了一截：只吸收新落的那些格子。
   *
   * 不许回头读已经进账的格子，所以按**游标**走下标，不对 cue 表用任何数组方法。卡表那一头唯一的
   * 变化是一格从"没答"换成"答过了"，那是问的时候迈过去的事（`head`），不是重排的事。
   */
  grow(compiled: Compiled): void {
    this.compiled = compiled;
    this.absorbCues();
    this.absorbGates();
  }

  /**
   * 开卡表表头那一截答掉的了，逐条迈过去：迈过去的那一格永不回头问第二次，所以这一问摊还下来
   * 每格一次，不是一帧一次。
   */
  private freshHead(): number {
    const gates = this.compiled.gates;
    while (this.head < this.openAt.length && gates[this.openAt[this.head]].said !== null) this.head++;
    return this.head;
  }


  /**
   * 这一刻在跑的强调叠层：同一道具取**最早落下**的那条（旧写法 `filter(...).find(...)` 同解）。
   *
   * 走自己那条窄表，不借 `running` 的区间。借过一版，那一版把一帧的价钱写回成"带子有多长"：通用区间
   * 的左边界由**整表**的前缀最大 `end` 二分出来，所以只要带子上有一刀叠层比播放头站着的那一段还
   * 长寿，左边界就退回表头 —— 一条 120 秒的 `highlight`（`guard` 封在 `MAX_MS`，合法输入）盖住一堂
   * 短课，站在带子中段那一帧就按 4 002 / 40 002 / 180 003 格（带子 2 001 / 20 001 / 120 001 条）。
   * 旧那条「带子长 16 倍，一帧多走的路一格都不许多」量不到它：那里的叠层落在同一拍里，`end` 超不出
   * 这一拍，通用区间本来就窄。所以这一件改的是**问法**：按强调自己的前缀最大值二分，一帧只付"这一刻
   * 在跑的强调有几条"。
   */
  highlightsAt(t: number): Map<string, string> {
    const out = new Map<string, string>();
    const from = firstAbove(this.hlMaxEnd, t);
    const to = firstAbove(this.hlT, t);
    for (let i = from; i < to; i++) {
      const c = this.hlCues[i];
      if (c.end <= t) continue;
      const id = (c.op as { target: string }).target;
      if (!out.has(id)) out.set(id, (c.op as { style: string }).style);
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
   * ⟲ 一拍该倒回去的那个时刻：`t` 之前至少 200ms、最近的那一句（或那一段沉默）的开头，`within`
   * 之内找不到就是 null。
   *
   * 旧写法每次按下把整张 cue 表 `filter` 出一份新数组、`reverse`、再 `find`。占时钟的窄表按 `t`
   * 递增，"最近的一条不超过的"是一次二分；`t - c.t <= within` 只对最大那一格问一次就够了 ——
   * 比它更早的那些离得更远，那条筛选本来也筛不住它们。
   */
  prevSpokenStart(t: number, within: number): number | null {
    const i = firstAtOrAfter(this.spokenT, t - 200) - 1;
    if (i < 0) return null;
    const c = this.spokenCues[i];
    return t - c.t <= within ? c.t : null;
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
   *
   * 表头那一截答掉的了要靠 `freshHead` 迈过去 —— 旧写法表头是建表时筛出来的，续排之后它可能指着
   * 一张已经答过的卡，于是时钟停在一个没人问的问题上（`currentGate` 拿 `said === null` 兜住了，
   * 但那一兜是第二处说法，这里不许依赖它）。
   */
  cardAt(t: number): Gate | null {
    const reached = firstAbove(this.gateT, t);
    if (reached === 0) return null;
    const h = this.freshHead();
    if (h < this.openAt.length && this.openAt[h] < reached) return this.compiled.gates[this.openAt[h]];
    // 走过的全都答过了。卡的窗口是问它的那一拍，拍随带子递增，所以窗口最长的是最后走过的那张。
    const last = this.compiled.gates[reached - 1];
    return t < last.until ? last : null;
  }

  /**
   * 还没答的卡的 seq，升序。
   *
   * 这一问的答案本来就是"所有还开着的卡"，所以 O(还开着的) 是诚实的价钱，不是要省的那一笔。要省的是
   * **作废的那些**，而它不能一发现有就整张换：一节问了 10000 张卡、每轮答掉一张的课，那样每轮都抄
   * 一万格 —— 抄的正是"这堂课一共有过几张卡"那笔被消掉的税。所以换表的规矩是"筛剩不到一半"，
   * 于是每次换表至少把长度减半，而两表之间只往里接新落的卡：摊还下来每格进账一次、出账一次。
   */
  openGateSeqs(): number[] {
    const gates = this.compiled.gates;
    const list = this.openAt;
    const from = this.freshHead();
    const kept: number[] = [];
    const out: number[] = [];
    for (let i = from; i < list.length; i++) {
      const g = gates[list[i]];
      if (g.said !== null) continue;
      kept.push(list[i]);
      out.push(g.seq);
    }
    if (kept.length * 2 < list.length) {
      this.openAt = kept;
      this.head = 0;
    }
    return out;
  }

  /** 第一张还没答的卡，不看时钟站在哪儿。表头就是它。 */
  firstOpenGate(): Gate | null {
    const h = this.freshHead();
    return h < this.openAt.length ? this.compiled.gates[this.openAt[h]] : null;
  }
}

/**
 * 给这一头的台面配一本索引，能续就续、不能续就从零建 —— 一台机器一本，跟 `perform` 同一个形状。
 *
 * `ix` 是上一次那本（没有就传 `null`）。判据只有一句引用相等（`holds`）：说是同一批容器，就只吸收
 * 新落的那一截；说不是（剪带、载入、清空换的是整台机器），就扔掉这本从零建。返回的那本要留着下次用。
 *
 * 为什么不在调用方自己比长度：长度相同而换了数组，正是剪带之后又落回同一个数那种下场（`rerollFrom`
 * 剪掉十刀、下一轮落十一刀），那一头读的是上一节课的窄表。容器引用是调用方唯一真正拥有的东西。
 */
export function reindex(ix: TapeIndex | null, compiled: Compiled): TapeIndex {
  if (ix && ix.holds(compiled)) ix.grow(compiled);
  else ix = new TapeIndex(compiled);
  return ix;
}
