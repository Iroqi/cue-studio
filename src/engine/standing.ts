import { onstageAt } from "./compile";
import type { Compiled, Prop, Revision, Touched } from "./types";

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
 *
 * ---------------------------------------------------------------- 已经排好的那一截不许每批再排一遍
 *
 * 带子只长一截，这本索引过去每批整本重建（`runtime.ts` 落一笔就把整张道具表重扫一遍）。改成"只吸收新落
 * 的那一截"之前，先得回答一句：**已经进过账的那一格，事实会在身后的刀上被改**。三处：
 *
 *  - `layRevision` 落下新格时把上一格的窗口收在这一刻（补 `off`）；
 *  - `markOff` 的 `discard` 给此刻站着的那一格补 `off`；
 *  - 迟到的补画把最后一格**原地换掉**（占位符填上：窗口不变，换的是那一格的对象，还可能换板）。
 *
 * 三处都不加长道具表，光读"道具表长出来的那一截"看不见它们；而"每批重扫整张道具表去找哪一格被改过"恰恰
 * 是这一件要消掉的价钱。所以由**知道改动的那一方**记一笔流水（`Compiled.touched`），这里只吸收新接的那
 * 一截。回头改的那一格总在那一列的**尾巴**上（除了最后一格，每一格的 `off` 早在它身后那一格落笔时定下
 * 了），所以按 `Revision` 引用记那一格站着的是谁就够，不许回看整列。
 *
 * 这么一来事件流**天生就是排好的**，连排序都省了：流水里每一笔的时刻都是它落下那一刻的时钟值（`close`
 * 的 `off` 是 `discard` 那一刻、或新格落笔那一刻），而带子的时钟只往前走。于是"从零建一本"和"续排"走的
 * 是同一句 `absorb` —— 上一件钉 cue 表用的是同一句话。
 *
 * 三处看着像坑、其实由**同一批里的次序**挡掉的地方（都是"回头补上的收笔"）：
 *
 *  - **同一毫秒落了又撤**（`build` 紧跟 `discard`，中间没有占时钟的那一刀）：建表那一遍按 `end <= t`
 *    整格筛掉，续排时这一格已经进过账、筛不掉了。它不需要撤销 —— 落下和收走落在**同一刻**，游标把这一对
 *    当成一步走完（前进 put 再 take，倒带 take 再 put），两头都答"这一刻台上没有它"。所以流水里同道具的
 *    `lay` 必须排在它的 `close` **之前**，而这是落笔的先后，本来就是那个次序。
 *  - **落笔就带着 `off` 的那一格**（`patch` 从上一格继承来的收笔，迟到的那一笔落在撤下之后）：
 *    `onstageAt(rev, rev.t)` 当场答否，所以它不进事件流 —— 和建表那一遍同一个谓词、同一句筛。
 *  - **同一刻换板重画**：这里流水的次序反过来 —— 上一格的 `close` 排在新格 `lay` 之前（先收旧的再落
 *    新的）。倒带时 `take` 按 `s.rev.scene` 摘，若先落新的再收旧的，`take` 那句"只有它还代表这个道具时
 *    才收"当场退出，旧板头上就留下已经搬走的那一格 —— 再切回那块板，同一件东西在同一帧被点两次，它就是
 *    两层。`standing.test.ts` 钉这一条用的是真带子。
 *
 * 剩下那一处真的要动已经进账的格子：`fill` 原地换掉最后一格。Stand 握的是对象引用，所以那一格的 `rev`
 * 跟着换；换了板就得在板的分队列里挪窝，而**换上去那一格的落笔时刻在身后**（迟到补画的那一格 `t` 还是
 * 当初落笔那一刻），所以插入是一次有序插入，不是接尾巴 —— 接尾巴会把那一列排出 `(t, rank)` 的次序，
 * 二分从此给错区间。
 */

/** 站着的那一格：一次外观，连着它属于哪个道具、什么时候收、它压在谁上面。 */
export interface Stand {
  prop: Prop;
  /** `fill` 那一笔会换掉它（同一格、同一窗口，换的是内容与所在的板）。 */
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

/** 一块板的外观队列：`starts` 单调不减，所以"某刻之后落下的"是一段尾巴。 */
interface BoardLine {
  name: string;
  starts: number[];
  stands: Stand[];
  /** 这块板上最晚一次落下的时刻。 */
  last: number;
  /** 在 `lines` / `lineLast` 里的位置，交换时跟着走。 */
  pos: number;
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

/**
 * 把一格接进按落笔时刻排好的那一列。落笔那条路上这一句就是**接尾巴**（流水的时刻不降，见上面），
 * 只有 `fill` 换板那一条会插到中间去 —— 那一格的时刻是它**当初**落笔的那一刻，可能早就在身后了。
 *
 * 同一刻里的先后不许不管：`starts` 只许单调不减，同刻那一截接在哪一头都由 `firstAbove` 定下来（同道具
 * 的两格在同一刻里必有一格是空窗口，被同一个谓词筛掉；不同道具的两格在同一刻里次序不进任何一笔账，
 * 名单最后由 `byStack` 按层叠号重排）。
 */
function insertStand(t: number[], list: Stand[], s: Stand): void {
  const i = firstAbove(t, s.rev.t);
  t.splice(i, 0, s.rev.t);
  list.splice(i, 0, s);
}

export class StandingIndex {
  private events: Event[] = [];
  /**
   * 按落笔时刻排好的那一列，`laidIn` 给的就是它的一段区间。一个道具同时只有一格站着，所以"这一拍落了
   * 几格"就是"这一拍欠几幅画"，与带子上总共有过几个道具无关。
   */
  private arrives: Stand[] = [];
  private arriveT: number[] = [];
  /** 游标：前 `p` 条事件已经 apply 完，所以手上的台就是 `events[p-1].at` 那一刻的台。 */
  private p = 0;

  /** 道具 id → 站着的那一格。一个道具同时只有一格站着：它的窗口不重叠。 */
  private live = new Map<string, Stand>();
  private onBoard = new Map<string, Map<string, Stand>>();
  private all: Stand[] = [];
  private perBoard = new Map<string, Stand[]>();
  private dirty = true;
  /** 上一次算出的可见名单，以及它属于哪块板、哪一刀。 */
  private vis: { board: string | null; flip: number; list: Stand[] } | null = null;

  private lines: BoardLine[] = [];
  /** 和 `lines` 同步的那一列 `last`，只为二分。 */
  private lineLast: number[] = [];
  private byName = new Map<string, BoardLine>();
  /**
   * 一次外观 → 站着它的那一格。回头改的那一笔（`close`、`fill`）说的是**引用**，所以按引用找；
   * 不靠"它一定是那一列的最后一格"这类位置假设 —— 那种假设一旦破了，答的是"台上一格早就搬走的东西"。
   */
  private stands = new Map<Revision, Stand>();
  /** 道具 id → 它的层叠号。号在道具**进表**那一刻发，和 `Compiled.props` 的迭代次序同一句。 */
  private ranks = new Map<string, number>();
  private rank = 0;
  /** 流水吸收到第几笔。 */
  private absorbed = 0;
  private compiled: Compiled;

  constructor(compiled: Compiled) {
    this.compiled = compiled;
    this.absorb();
  }

  /**
   * 这本索引读的是不是**同一张台面** —— 认的是容器引用，和 `TapeIndex` 同一句话。
   *
   * 问两张：`props` 是解释器手上那张只增的道具表，`touched` 是它记的那条流水。两者都跟着同一台机器
   * 长大，换了机器（剪带、载入、清空）就是换了数组，那一头整本重建 —— 和解释器那三扇门同一个政策。
   */
  holds(compiled: Compiled): boolean {
    return this.compiled.props === compiled.props && this.compiled.touched === compiled.touched;
  }

  /** 台面长了一截：只吸收流水上新接的那一截。 */
  grow(compiled: Compiled): void {
    this.compiled = compiled;
    if (this.absorb()) this.vis = null;
  }

  /**
   * 把流水新长的那一截吸进来。一次建完和续排走的是**同一句**，所以续排不可能和"从头建一本"给出不同的
   * 事件流 —— 差异只可能来自分的规矩。答"有没有吸进新东西"：吸进来了，那份可见名单就不许再给。
   */
  private absorb(): boolean {
    const list = this.compiled.touched;
    for (let i = this.absorbed; i < list.length; i++) this.absorbOne(list[i]);
    const grew = list.length > this.absorbed;
    this.absorbed = list.length;
    return grew;
  }

  private absorbOne(t: Touched): void {
    if (t.kind === "prop") {
      // 号在进表那一刻发：`link` 只点了名的那一格也占一个号。否则道具表里插进一格，它身后所有道具的
      // 层叠次序挪一位，而那一头观众看见的名单当场换个次序 —— 次序就是层叠，不许因为换了读法就动。
      this.ranks.set(t.prop.id, this.rank++);
      return;
    }
    if (t.kind === "lay") {
      // 落笔那一刻就收着的花（`patch` 从上一格继承来的 `off`，迟到的那一笔落在撤下之后）站不住任何
      // 一刻，不进事件流 —— 和建表那一遍同一个谓词。
      if (!onstageAt(t.rev, t.rev.t)) return;
      const s: Stand = { prop: t.prop, rev: t.rev, rank: this.ranks.get(t.prop.id) ?? 0 };
      this.stands.set(t.rev, s);
      this.events.push({ at: t.rev.t, leave: false, s });
      insertStand(this.arriveT, this.arrives, s);
      this.putInLine(s);
      return;
    }
    if (t.kind === "close") {
      const s = this.stands.get(t.rev);
      // 没有这一格 = 它落笔那一刻就是空的（上面筛掉的那一类），它压根没进过账，收走也无事可做。
      if (!s || t.rev.off === undefined) return;
      this.events.push({ at: t.rev.off, leave: true, s });
      return;
    }
    this.refill(t);
  }

  /**
   * `fill`：占位符被原地换掉。窗口两端与落笔时刻都不变，所以事件流一个字不动；要动的是**已经进账的那
   * 一格**握的引用，和它所在的板。
   */
  private refill(t: Extract<Touched, { kind: "fill" }>): void {
    const s = this.stands.get(t.old);
    if (!s) return; // 那一格压根没进账（空窗口），换掉它不必动这本账
    if (s.rev === t.rev) return; // 已经是新的那一格：同一格里被改了两回，第二次没什么可换
    const from = s.rev.scene;
    s.rev = t.rev;
    this.stands.delete(t.old);
    this.stands.set(t.rev, s);
    if (from !== t.rev.scene) {
      this.removeFromLine(s, from);
      this.putInLine(s);
      // 游标已经把它 apply 在台上时，`onBoard` 那张表里那一格也得跟着挪：`take` 是按 `s.rev.scene` 摘
      // 的，留在旧板头上就摘不掉，切回那块板就看见一个已经不站在那儿的影子。
      if (this.live.get(s.prop.id) === s) {
        this.onBoard.get(from)?.delete(s.prop.id);
        const on = this.onBoard.get(t.rev.scene);
        if (on) on.set(s.prop.id, s);
        else this.onBoard.set(t.rev.scene, new Map([[s.prop.id, s]]));
      }
      this.dirty = true;
      this.vis = null;
    }
    // 没换板时台面上还是同一格，只是内容补上了 —— 名单、层叠、游标都不必动，画不画得出来是 `owedAt`
    // 那一头按 `painted(rev)` 问当下的那一格，读的正是换过之后的引用。
  }

  /** 这块板的队列里没有就新建一条；有就把这一格按落笔时刻接进去，`last` 跟着往前挪。 */
  private putInLine(s: Stand): void {
    const name = s.rev.scene;
    let line = this.byName.get(name);
    if (!line) {
      // 新建的这一块板的 `last` 可能比表里已有的那些**早**（`fill` 换板：那一格的落笔时刻是当初的），
      // 所以先接到表尾再两头挪。落笔那条路上这一句几乎总是原地不动 —— 一块板落笔只会更晚。
      line = { name, starts: [], stands: [], last: -Infinity, pos: this.lines.length };
      this.lines.push(line);
      this.lineLast.push(-Infinity);
      this.byName.set(name, line);
    }
    insertStand(line.starts, line.stands, s);
    if (s.rev.t > line.last) line.last = s.rev.t;
    this.settle(line);
  }

  /** 换板那一笔：从旧板的队列里摘掉；旧板空了就把那条从头等表里撤走。 */
  private removeFromLine(s: Stand, from: string): void {
    const old = this.byName.get(from);
    if (!old) return;
    const i = old.stands.indexOf(s);
    if (i < 0) return;
    old.stands.splice(i, 1);
    old.starts.splice(i, 1);
    if (old.stands.length) {
      if (old.stands[old.stands.length - 1].rev.t !== old.last) {
        old.last = old.stands[old.stands.length - 1].rev.t;
        this.settle(old);
      }
      return;
    }
    this.lines.splice(old.pos, 1);
    this.lineLast.splice(old.pos, 1);
    this.byName.delete(from);
    for (let j = old.pos; j < this.lines.length; j++) this.lines[j].pos = j;
  }

  /**
   * 把 `last` 挪回它该站在的位置：两头都可能要挪 —— 落笔只会更晚（往后），换板与摘格子会让一块板的
   * `last` 变早（往前），新建的那条可能比表里所有的都早。挪的次数最多是板的条数，和带子长无关。
   */
  private settle(line: BoardLine): void {
    this.lineLast[line.pos] = line.last;
    while (line.pos + 1 < this.lines.length && this.lines[line.pos + 1].last < line.last) this.swap(line.pos, line.pos + 1);
    while (line.pos > 0 && this.lines[line.pos - 1].last > line.last) this.swap(line.pos, line.pos - 1);
  }

  private swap(a: number, b: number): void {
    const la = this.lines[a];
    const lb = this.lines[b];
    this.lines[a] = lb;
    this.lines[b] = la;
    this.lineLast[a] = lb.last;
    this.lineLast[b] = la.last;
    la.pos = b;
    lb.pos = a;
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
   * 这个名字此刻还站着、而且没有被最近那一刀扫走 —— 也就是观众看得见它。
   *
   * 跟读的镜头问这一句：`discard` 可以落在 `track` 那一刀滑动的中途（overlay 不占时钟），于是画面正在
   * 往一件刚消失的东西滑过去，而 `motion` 还在把它往外推。落点是历史，推不许跟着追 —— 那一头观众已经
   * 没有这件东西了。`swept` 那半条在这里折成一次比较，和 `runtime.ts` 里那句原话同解；带子的价钱只进
   * 游标那两步二分，名单本身不必走一遍。
   */
  seen(id: string, t: number, cut: { flip: number; board: string } | null): boolean {
    this.moveTo(t);
    const s = this.live.get(id);
    if (!s) return false;
    return !cut || s.rev.scene === cut.board || s.rev.t >= cut.flip;
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

/**
 * 续着排台面：能续就续、不能续就从零建一本。与 `reindex` 同形，也同一个判据 —— 认的是台面里那两张
 * 会长大的容器的引用，不是那条带子。
 */
export function restand(ix: StandingIndex | null, compiled: Compiled): StandingIndex {
  if (ix && ix.holds(compiled)) ix.grow(compiled);
  else ix = new StandingIndex(compiled);
  return ix;
}
