import type {
  Beat,
  Box,
  BeatOp,
  CameraOp,
  Compiled,
  Cue,
  Gate,
  NarrateOp,
  Op,
  OpEntry,
  Prop,
  Revision,
  Touched,
  TransitionOp,
} from "./types";
import { inkBox } from "./ink";
import { speechMs, SETTLE_MS } from "./speech";

export const VIEWPORT: Box = { x: 0, y: 0, w: 1600, h: 900 };

/**
 * How close a close-up may get, in world units of frame width. A painter's smallest text is 28 units
 * tall; at 450 units of frame the board pushes in 3.5x, so that text lands around 90-100 px — a big
 * word, still a word. The old floor of 260 meant 6x and ~155 px: a label stopped being a word and a
 * stroke became a wall, which is what made close-ups look blown up.
 */
const MIN_CLOSEUP_W = 450;

/**
 * How far apart two boards sit on the plane, when nothing on the tape says otherwise. The vocabulary
 * promises a scene of about one viewport with boards 2000~3000 apart; 2400 is the middle of that, so
 * the ground a named-but-empty board is given sits where a director would have put it by hand.
 */
const BOARD_SPACING = 2400;

/**
 * The frame that holds every box given. A spread (`Math.min(...boxes.map(...))`) is a *stack* argument
 * list, so this looked fine until a tape named a lot of things at once: 130k of them and the compiler
 * threw RangeError before it produced a single cue — which is not an ugly shot but a board that never
 * loads. A stranger's `#s=` link is allowed to say "frame everything".
 *
 * A box with nothing finite in it is skipped rather than averaged in: the old spread produced NaN, and
 * NaN in a camera frame is a board nobody can see. Bounding is the tape door's job (`guard.geometry`);
 * this is the interpreter refusing to be the second one to be fooled by it.
 */
export function unionBox(boxes: Box[]): Box {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    if (!(b.w > 0) || !(b.h > 0)) continue;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
    if (b.x < x1) x1 = b.x;
    if (b.y < y1) y1 = b.y;
    // Corners too, or one far-enough box silently drops out of the frame that is supposed to hold it.
    if (b.x + b.w > x2) x2 = b.x + b.w;
    if (b.y + b.h > y2) y2 = b.y + b.h;
  }
  if (![x1, y1, x2, y2].every(Number.isFinite)) return { ...VIEWPORT };
  return { x: x1, y: y1, w: Math.max(x2 - x1, 1), h: Math.max(y2 - y1, 1) };
}

export function centerOf(b: Box): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/**
 * 这一刻这一格站不站着：它的窗口 `[t, off)` 盖住这一刻。
 *
 * 撤下以前是道具身上的**一个数**（`discardedAt`）：会被后一刀覆盖，也会被重画顺手清空。所以一条
 * "撤下 → 重新落下 → 再撤下"的带子只留下最后那一刀，倒带回到第一刀之前的人于是看见一件早就被他撤
 * 掉的东西又站回台上，而旁白还指着它讲。磁带是只增不改的，"此刻有什么"必须由时刻算出来：一次外观是
 * 一段窗口，和 `Cue` 的 `t`/`end` 是同一件东西 —— 词汇里没有第二套名字。
 *
 * 换场（`swept`）是另一半，问的是"这块板还在不在眼前"，由读它的人一帧问一次，不进这一条。
 *
 * `t = Infinity` 就是"到带子尽头"：编译期量一板的地皮用它 —— 那正是旧写法 `discardedAt === undefined`
 * 在问的事，只是它当时按"现在"答，答不了"回到十分钟前"。
 */
export function onstageAt(rev: Revision | undefined, t: number): boolean {
  return !!rev && rev.t <= t && !(rev.off !== undefined && rev.off <= t);
}

/**
 * 道具在 `t` 这一刻站着的那一次外观：倒着找第一条窗口还盖得住这一刻的。
 *
 * 和"筛完整列再取最后一格"同解，只是不每帧复制一份外观表。
 */
export function standingAt(revisions: Revision[], t: number): Revision | undefined {
  for (let i = revisions.length - 1; i >= 0; i--) {
    if (onstageAt(revisions[i], t)) return revisions[i];
  }
  return undefined;
}

/**
 * 落下新的一次外观，顺手把上一次那段窗口收在这一刻，并把**被收起的那一格**交回调用方。
 *
 * 同一个道具的窗口因此**铺满**时间线：不重叠、按 `t` 递增，下一件才二分得动。填占位符那一笔不走这里
 * —— 它把最后一格原地换掉（"描述它的那句已经念完了，图才补上"是同一段窗口，不是新的一格），否则两条
 * 同样 `t` 的窗口并排站着，二分出来的区间会退化到表头，一帧把整板重走一遍。
 *
 * 交回 `prev` 是为了 `Compiled.touched` 那一笔：窗口的右端是**回头**补上的，光读道具表长出来的那一截
 * 看不见它（`types.ts` 的 `Touched`）。
 */
export function layRevision(p: Prop, rev: Revision): Revision | undefined {
  const prev = p.revisions.length ? p.revisions[p.revisions.length - 1] : undefined;
  if (prev && prev.off === undefined && prev.t <= rev.t) {
    prev.off = rev.t;
    p.revisions.push(rev);
    return prev;
  }
  p.revisions.push(rev);
  return undefined;
}

/**
 * `discard` 落在道具身上：给**此刻站着的那一次外观**盖上结束时刻，并把**盖上那一格**交回调用方。
 *
 * 已经收过就不动 —— 一个名字不会因为在带子上被多念了一刀就更消失一次；而重画（`build`/`patch`）
 * 落下的是新的一次外观，它自带一个新窗口。所以 `recall` 那份 `{...prev}` 必须抹掉 `off`：原样抄
 * 过来就是"带回来的东西一上台就已经是撤着的"。
 *
 * 交回那一格是为了 `Compiled.touched`：收笔是回头改已经躺在表里的一格，光读道具表的尾巴看不见它。
 */
export function markOff(revisions: Revision[], at: number): Revision | undefined {
  const standing = standingAt(revisions, at);
  if (standing && standing.off === undefined) {
    standing.off = at;
    return standing;
  }
  return undefined;
}

function padded(b: Box, f = 1.25): Box {
  const c = centerOf(b);
  return { x: c.x - (b.w * f) / 2, y: c.y - (b.h * f) / 2, w: b.w * f, h: b.h * f };
}

function frac(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function fitRect(rect: Box, aspect: number): Box {
  const ra = rect.w / rect.h;
  if (ra > aspect) return { x: rect.x, y: rect.y - (rect.w / aspect - rect.h) / 2, w: rect.w, h: rect.w / aspect };
  return { x: rect.x - (rect.h * aspect - rect.w) / 2, y: rect.y, w: rect.h * aspect, h: rect.h };
}

/**
 * One ceiling on how far the eye may push in, applied to every camera mode after it resolves. `focus`
 * and a single-prop `fit` used to have none, so a small prop could be blown up arbitrarily while the
 * two modes that did clamp stopped at 6x. Widening only ever pulls the frame back, never crops.
 */
function limitPushIn(rect: Box, aspect: number): Box {
  if (rect.w >= MIN_CLOSEUP_W) return rect;
  const c = centerOf(rect);
  return { x: c.x - MIN_CLOSEUP_W / 2, y: c.y - MIN_CLOSEUP_W / aspect / 2, w: MIN_CLOSEUP_W, h: MIN_CLOSEUP_W / aspect };
}

/** 一格的取景盒：画出来的墨比声明的盒子准，空白边上不该留出画面。 */
function revBox(rev: Revision): Box {
  return inkBox(rev.svg, rev.box) ?? rev.box;
}

/**
 * 镜头脚下那块地：观众这一刻看得见、还没被换场扫走的格子，按板并起来的盒子。
 *
 * 上一件把"什么站在台上"变成一段窗口，给了每帧四个读者，可它没有管镜头。镜头那一头读的是
 * `revisions[length - 1]` 那一格 —— 带子尽头那一格，问的也是"到带子尽头还站着吗"，不是"镜头站着的那
 * 一刻还站着吗"；分板按 `prop.scene`（道具最后被挪去了哪），不是按那一次外观落在哪块板。于是一卷带子
 * 上有两种说法：`visibleName` 说观众已经看不见这件东西，落点却还按它的地皮算。后果不是难看，是
 * `blindCamera` 那句"画面这一拍不会动"成了谎话：它按观众那一头判断，镜头按另一头走。实测的错法（改前
 * 每条都跑过，数字见 `camera-moment.test.ts`）：`focus` 一个刚撤下的名字，整帧站到 x=6000 那件早就
 * 不在台上的东西上；`track` 跟同一个名字，画面从 `{x:0}` 滑到 `{x:4300}`；换场之后点旧板的名，镜头从
 * `{x:2400}` 飞到那块被幕布压住的板上；`discard` 落在 `track` 中途以后还在推它；同一拍里后一刀把前一刀
 * 已经看见的落点改写。
 *
 * 这里说的是**观众那一头**那一句，两半都要：`rev.scene`（这一次外观落在哪块板，不是道具最后被挪去了哪
 * —— `standing.ts` 同一句话）站着，并且没有被最近那一刀扫走。读法和"从头把带子再读一遍、一个缓存都不
 * 许用"那份朴素参照逐条对账，由 `camera-moment.test.ts` 钉住，不是"看起来一样"。
 *
 * 代价不许落在带子长度上。旧写法每点一次名把整张道具表走一遍，所以"板名当镜头目标"这条导演常用的路
 * （`camera` 的说明里就写着板名可以当目标）是二次的。同一卷 12000 拍的带子，把那一刀点名去掉是
 * 23.2 / 21.2ms（两次独立跑，各取三次最小值），点上名是 1073 / 1089ms —— 点名这件工具本身贵过带子其余
 * 部分约 49 倍；导演一笔一笔追加时付的是同一笔钱的一小段：3000 拍的带子上追加 20 拍，点名那条
 * 1017 / 1079ms，不点名 113 / 117ms（约 9 倍）。改成边走边记：落一笔、收一笔只动它自己那一格；并好的
 * 盒子只在有人问过这块板时才算，算一次记一次，直到这块板又变了东西或幕布走过一刀。于是每一拍付的是
 * "这一刻台上有几样"，不是"这堂课一共有过几样"（同一台机器同一批带子改后：1089ms → 33.2ms，与不点名
 * 那条只差 1.6 倍；追加那一条 1079ms → 155ms，比值 1.3 —— 点名那一刀从此和一句旁白一个量级）。
 */
class CameraGround {
  /** 道具 id → 此刻站着的那一格。一个道具同时只有一格站着：它的窗口不重叠。 */
  private readonly byId = new Map<string, Revision>();
  /** 板名 → 此刻站在这块板上的格子。被换场扫走的仍留在里面：回到那块板正是它们重新可见的时候。 */
  private readonly onBoard = new Map<string, Map<string, Revision>>();
  /** 一块板上所有站着格子的并。缺键是"过期了，下一次问再量一遍"；`null` 是"量过，这块板空着"。 */
  private readonly all = new Map<string, Box | null>();
  /** 只并最近那一刀之后落下的格子。走过一刀整份作废 —— 从那一刻起"看得见"换了半条规则。 */
  private readonly since = new Map<string, Box | null>();
  /** 带子已经走到的那一刀：`flip` 是幕布盖住整块板的瞬间，`board` 是落下的那块板。 */
  private cut: { flip: number; board: string } | null = null;

  /** 这一格此刻在不在观众眼前：`swept` 的另一半，折成一次比较。 */
  private sees(rev: Revision): boolean {
    return !this.cut || rev.scene === this.cut.board || rev.t >= this.cut.flip;
  }

  /** 这块板又变了东西：两份量过的账都不许再拿。 */
  private stale(name: string): void {
    this.all.delete(name);
    this.since.delete(name);
  }

  /** 缓存还握着答案就把这一格并进去；缺键就别凭空写一份 —— 下一次问会整板量。 */
  private widen(cache: Map<string, Box | null>, name: string, box: Box): void {
    if (!cache.has(name)) return;
    const prev = cache.get(name);
    cache.set(name, prev ? unionBox([prev, box]) : box);
  }

  /** 把一块板上站着的格子量一遍；`from` 给了就只量那一刀之后落下的。 */
  private measure(name: string, from: number | null): Box | null {
    const out: Box[] = [];
    for (const rev of this.onBoard.get(name)?.values() ?? []) {
      if (from === null || rev.t >= from) out.push(revBox(rev));
    }
    return out.length ? unionBox(out) : null;
  }

  put(id: string, rev: Revision): void {
    const prev = this.byId.get(id);
    if (prev && prev !== rev) {
      // 换了板：旧板上那一笔得摘掉，否则旧板的地皮还按它量，镜头会飞到一个观众空着的板上。
      // 同一块板上换了一格（重画、填占位符）：并里还压着旧那一笔，而新格可能更小 —— 两种都不许拿
      // 旧账，重量一次比留一个偏大的框诚实。
      if (prev.scene !== rev.scene) this.onBoard.get(prev.scene)?.delete(id);
      this.stale(prev.scene);
      if (prev.scene !== rev.scene) this.stale(rev.scene);
    }
    this.byId.set(id, rev);
    const on = this.onBoard.get(rev.scene);
    if (on) on.set(id, rev);
    else this.onBoard.set(rev.scene, new Map([[id, rev]]));
    const box = revBox(rev);
    this.widen(this.all, rev.scene, box);
    // 看不见的格子不许进"观众眼前那份地皮"：填一块早被幕布压住的板的占位符，落笔时刻在 `flip` 之前，
    // 补上画面并不让它重新可见 —— 并进那份缓存就等于把它算进镜头该框住的地方。
    if (this.sees(rev)) this.widen(this.since, rev.scene, box);
  }

  off(id: string): void {
    const rev = this.byId.get(id);
    if (!rev) return;
    this.byId.delete(id);
    this.onBoard.get(rev.scene)?.delete(id);
    // 摘掉一格只能整板重量：并集没有逆运算，留一个偏大的框就是"撤走的东西还在把画面撑大"。
    this.stale(rev.scene);
  }

  /**
   * 幕布走过一刀。带子是单调走的，所以"处理这一刀"就是"这一刻之后的镜头要按它算"：换场占时钟，排在它
   * 身后的镜头此刻已过 `flip`，排在它前面的还在换场之前 —— 那一头观众确实还没被扫走。
   */
  cutTo(board: string, flip: number): void {
    this.cut = { board, flip };
    this.since.clear();
  }

  /** 这一格此刻看得见；看不见就没有目标 —— 镜头不许为一个观众看不见的名字动。 */
  revOf(id: string): Revision | undefined {
    const rev = this.byId.get(id);
    return rev && this.sees(rev) ? rev : undefined;
  }

  /**
   * 这块板此刻在观众眼前的地皮；一格都不站着就没有答案 —— 镜头不许为一块空板动。
   *
   * 站在脚下的板（`cut.board`）量全部：幕布一抬，上一次访问留下的那些就又回到眼前，这一刀之前落下的
   * 东西属于这块板所以不算被扫走。点别的板的名只量"这一刀之后落下的"—— 一块被压住的板观众看不见，
   * 镜头就该像点一个不存在的名那样不动，这正是 `blindCamera` 说的那句话。
   */
  box(name: string): Box | undefined {
    const other = this.cut && this.cut.board !== name;
    const cache = other ? this.since : this.all;
    if (!cache.has(name)) cache.set(name, this.measure(name, other ? this.cut!.flip : null));
    return cache.get(name) ?? undefined;
  }

  /** 落上一块板时该站的位置：这块板上站着的一切，含此刻还被幕布压着的那些。 */
  landing(name: string): Box | undefined {
    if (!this.all.has(name)) this.all.set(name, this.measure(name, null));
    return this.all.get(name) ?? undefined;
  }
}

/**
 * 一板到带子尽头为止的地皮，**跟着带子走**的那一份。
 *
 * `Compiled.scenes` 要说的是"这堂课最后走到哪"，不是这一刻 —— 导演的快照读它，而且它得把被换场扫走的
 * 那些也算进来（那些东西还在档案里，`recall` 带得回来）。镜头自己那一刻的地皮是上面那个 `CameraGround`，
 * 两处不许混成一个。
 *
 * 旧写法每次排完整卷带子，再"每一块板把整张道具表走一遍"（后来改成单趟按板并窗口）。第二版把一趟省成
 * 了 O(道具)，可它仍然在**每一批**落下时把整卷重算一遍 —— 五万格道具、每批四十格落笔，就是五百次五万
 * 格的并。并集没有逆运算，摘掉一笔只能整板重量，所以这一格换成了**四条边各自一条堆**：
 *
 *  - 落一笔往这块板的四条边各压一个数，带上这一笔的记号；
 *  - 收一笔只把那个记号作废（堆里那一格留着，等它浮到堆顶时再扔）—— 这就是"惰性删除"，
 *    代价是 log，不是整板重量；
 *  - 问的时候四条边各看一眼堆顶。
 *
 * 于是"这块板的地皮"按**板**记，一块板一次落笔只动它自己那四条边。读法和 `unionBox` 逐条同解，包括它
 * 那些不讲理的下场：一个非有限的 x/y 让这一笔整格不算（`unionBox` 跳过它）、`w`/`h` 非正同样跳过、
 * `x+w` 溢出成 Infinity 让**整块板**回到一屏（unionBox 最后那句 `every(isFinite)`），而 NaN 那一头它
 * 连堆顶都当不上 —— 四条边全空和"没有一笔站得住"是同一个答案。由 `incremental.test.ts` 逐板对账钉住。
 */
class BoardGround {
  private readonly xs = new Heap(false);
  private readonly ys = new Heap(false);
  private readonly x2s = new Heap(true);
  private readonly y2s = new Heap(true);
  /** 还活着的记号。摘掉一笔就是从这里删一个数，堆里那一格等浮到顶再扔。 */
  private readonly live = new Set<number>();
  /**
   * 这块板上此刻站着几格，**占不了地方的那些也算**。旧写法分板的时候不看盒子（`groundsAtEnd` 只管
   * "最后那一格还站着"），占不了地方是在 `unionBox` 里被跳过的 —— 一块板上全是这种格子，它当年给出的
   * 答案是"这块板有一屏那么大"，不是"这块板没有地皮"。这两个说法差的是导演快照上的一行，所以照搬。
   */
  private held = 0;
  private mark = 0;

  /** 这一笔在这块板上占不占地方：和 `unionBox` 的筛法一个字都不许差。 */
  static counts(b: Box): boolean {
    return b.w > 0 && b.h > 0 && Number.isFinite(b.x) && Number.isFinite(b.y);
  }

  /** 落一笔：记号无论如何都要发（收笔那头按它对称地摘），四条边只在占地方的时候压。 */
  add(b: Box): number {
    const id = this.mark++;
    this.held++;
    if (!BoardGround.counts(b)) return id;
    this.live.add(id);
    this.xs.push(b.x, id);
    this.ys.push(b.y, id);
    this.x2s.push(b.x + b.w, id);
    this.y2s.push(b.y + b.h, id);
    return id;
  }

  /**
   * 收一笔：两笔账都要摘。`live` 那一头是堆里的惰性删除（不摘就等于"撤走的东西还在把板的地皮撑大"），
   * `held` 那一头是"这块板上还剩几格站着" —— 一块板被撤空了就该整个从 `scenes` 里消失，旧写法那一头
   * `groundsAtEnd` 根本不会给它留名。
   */
  drop(id: number): void {
    this.held--;
    this.live.delete(id);
  }

  /** 堆顶那个还活着的数；全空就是 `undefined`。 */
  private top(h: Heap): number | undefined {
    for (;;) {
      const v = h.peek();
      if (v === undefined) return undefined;
      if (this.live.has(v.id)) return v.value;
      h.pop();
    }
  }

  /** 这块板上一格都不站着 —— 调用方据此把板名整块摘掉。 */
  get empty(): boolean {
    return this.held === 0;
  }

  /** 四条边。站着的全是占不了地方的格子，就回到一屏（`unionBox` 最后那两句说的正是这件事）。 */
  box(): Box {
    const x1 = this.top(this.xs);
    const y1 = this.top(this.ys);
    const x2 = this.top(this.x2s);
    const y2 = this.top(this.y2s);
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return { ...VIEWPORT };
    // 一条边非有限（一笔 `x+w` 溢出成 Infinity）就不是"难看一点"，是一帧没人看得见的板：同一屏。
    if (![x1, y1, x2, y2].every(Number.isFinite)) return { ...VIEWPORT };
    return { x: x1, y: y1, w: Math.max(x2 - x1, 1), h: Math.max(y2 - y1, 1) };
  }

  /**
   * 摘掉一笔之后这块板还剩不站着东西，还剩就量四条边。`null` 是"这块板此刻一笔都不站着"，
   * 旧写法那一头 `groundsAtEnd` 根本不会给这块板留名，所以这里也不许留。
   */
  view(): Box | null {
    return this.empty ? null : this.box();
  }
}

/**
 * 一条**只增**的最小/最大堆，带惰性删除（删除在 `BoardGround` 那一头，靠记号作废）。
 * 这里不需要 `decreaseKey`，也不需要稳定次序：四条边各问一个极值，极值是谁不重要。
 */
class Heap {
  private readonly v: number[] = [];
  private readonly id: number[] = [];
  /** `true` 是最大堆，`false` 是最小堆。四条边里左边/上边取极小，右边/下边取极大。 */
  private readonly max: boolean;
  constructor(max: boolean) {
    this.max = max;
  }

  private better(a: number, b: number): boolean {
    return this.max ? a > b : a < b;
  }

  push(value: number, id: number): void {
    this.v.push(value);
    this.id.push(id);
    let i = this.v.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.better(this.v[i], this.v[p])) break;
      this.swap(i, p);
      i = p;
    }
  }

  peek(): { value: number; id: number } | undefined {
    return this.v.length ? { value: this.v[0], id: this.id[0] } : undefined;
  }

  pop(): void {
    const n = this.v.length;
    if (!n) return;
    if (n === 1) {
      this.v.pop();
      this.id.pop();
      return;
    }
    this.swap(0, n - 1);
    this.v.pop();
    this.id.pop();
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let best = i;
      if (l < this.v.length && this.better(this.v[l], this.v[best])) best = l;
      if (r < this.v.length && this.better(this.v[r], this.v[best])) best = r;
      if (best === i) break;
      this.swap(i, best);
      i = best;
    }
  }

  private swap(a: number, b: number): void {
    const v = this.v[a];
    this.v[a] = this.v[b];
    this.v[b] = v;
    const i = this.id[a];
    this.id[a] = this.id[b];
    this.id[b] = i;
  }
}

/** Narration, transitions and beats own the clock; camera moves, highlights and motion run on top of them. */
export type TimeOwning = NarrateOp | TransitionOp | BeatOp;

export function ownsTime(op: Op): op is TimeOwning {
  return op.kind === "narrate" || op.kind === "beat" || op.kind === "transition";
}

/**
 * How long an op holds the frame. Every cut in the show is timed off this window, so the two floors
 * here are what keep the picture from running ahead of its own narration: a line cannot be squeezed
 * under the time it takes to say out loud, and a scene change cannot be shorter than the half of it
 * the veil needs to cover the board — below that, the sweep of the old scene is an invisible jump cut.
 */
export function cueMs(op: Op): number {
  if (op.kind === "narrate") return Math.max(op.duration, speechMs(op.text) + SETTLE_MS);
  if (op.kind === "transition") return Math.max(op.duration, 700);
  return Math.max("duration" in op ? op.duration : 0, 1);
}

/**
 * 解释器：把带子演成台面。
 *
 * 它以前是一个函数 —— `compile(entries)` 从第 0 格排到最后一格，局部的十几样东西（道具表、时钟、
 * 镜头脚下那一刻的台、每一批的落点槽位、拍的游标）就是"走到这一刻手上有的东西"。带子只增不改，所以
 * 那些东西本来就该活在一台**机器**里，而不该每批被重新发明一遍：这一件把它们从函数局部搬到类的字段上，
 * 于是 `run(带子, 从第几格起)` 可以接着上一次往下演。
 *
 * 契约没有换。`here` 的视线只读到本批为止（`placementView`），所以"续着排"和"整卷重排"给出**同一张台
 * 面** —— 那纸契约由 `landed.test.ts` 钉着，它的对账参照正是"逐批重排整卷"，所以这一件一改，那节测试
 * 当场就成了增量解释器的语义证明：它比的两个答案现在由两条不同的路算出来。
 *
 * 换的只有价钱：落一笔付的是这一笔，不是整堂课。三处 O(带子) 的收尾各自跟着带子走了 ——
 * 一板的地皮（`BoardGround` 的四条边）、每张卡的窗口（只有还开着的那一拍的 end 会长，见 `openGates`）、
 * 时长那截尾巴（落一条 cue 顺手记一次最大值）。
 */
export class Interpreter {
  private readonly props = new Map<string, Prop>();
  /**
   * 「哪一个道具的台面动过」的流水，只长尾巴。见 `types.ts` 的 `Touched`。
   *
   * 记它的理由不是"这样读的人省事"，而是**读的人根本没有别的办法**：一次外观的窗口右端会被身后那一刀
   * 补上、占位符会被原地换掉，那些格子早就躺在表里了 —— 光看"道具表长出来的那一截"看不见它们，而每批
   * 把整张道具表重扫一遍去找哪一格动过，恰恰是这一件要消掉的价钱。所以由知道改动的那一方（这台机器）
   * 记一笔，`StandingIndex` 只吸收新接的那一截。
   */
  private readonly touched: Touched[] = [];
  private readonly cues: Cue[] = [];
  private readonly gates: Gate[] = [];
  private readonly beats: Beat[] = [];
  /**
   * 每一刀镜头落在哪一刻，按 op 引用记。带子只增不改，所以"这一刀问的是哪一刻"在排好的那一刻就该
   * 有答案 —— 那一问以前写成 `cues.find((c) => c.op === askedBy)`，而它的用法恰恰是**找不到才说话**，
   * 于是每一刀点一次名把整张 cue 表走完一遍。见 `Compiled.shotAt`。
   */
  private readonly shotAt = new Map<CameraOp, number>();
  // A card is looked up by `seq` twice: once when the learner's answer arrives, once when the beats are
  // closed off to find the window it was asked in. Both are keyed here rather than scanned, because a
  // scan makes a tape with many cards cost one pass over all of them *per card* — which is the same
  // frozen tab a bad number is, just slower to notice.
  private readonly gateBySeq = new Map<number, Gate>();
  /**
   * 还没收口的那几张卡 —— 也就是**当前这一拍**里的，因为一拍收口（下一拍翻开）时 `closeBeat` 把它们
   * 交出去并清空。旧写法这一问在整卷排完的收尾里做，拿 `seqBeat` 逐张问"你在哪一拍"：一张表上的每一张
   * 卡都被重新记一次 `until`，其中绝大多数早就定下来了。续排不许每一批都付那一次全表扫 —— 一节课几百张
   * 卡、导演一轮落十几刀，那笔钱就是带子的长度又请回来一遍。
   */
  private openGates: Gate[] = [];
  /** 每一块板到带子尽头为止的地皮，见 `BoardGround`。 */
  private readonly grounds = new Map<string, BoardGround>();
  /** 道具 id → 它在上面那块板的地皮里占的那一笔（记号），换板/收笔时按它摘掉。 */
  private readonly recorded = new Map<string, { board: string; id: number; rev: Revision }>();
  /*
   * A named board has a place on the plane. It used to have only whatever its props happened to
   * cover, so a board named before anything was laid on it had no bounds at all: `transition` fell
   * back to the frame it was already in, and the veil then swept the old lesson off a board the
   * camera never left — the audience watched their picture get erased and got nothing in its place.
   *
   * So boards are given out in the order the show walks onto them, at the spacing the vocabulary
   * already promises (a scene is about one viewport, boards 2000~3000 apart). Explicit coordinates
   * still widen the frame, so a director who places things by hand is not caged by this ground; it
   * only says where the board is when nothing on it says so yet.
   */
  private readonly boards = new Map<string, Box>();
  /**
   * 镜头脚下那块地，跟着带子一边走一边记。见 `CameraGround`：解释器走到这一刻时手上的台，就是镜头
   * 该框住的台 —— 不是带子尽头那一格。
   */
  private readonly ground = new CameraGround();
  private t = 0;
  private cursor: Box = { ...VIEWPORT };
  // Which board the show is standing in, named by the last `transition`. A prop the director gives no
  // scene for lands on this one, because "the board I am looking at" is what they meant by leaving it
  // out — and a prop on some other board is not on it, which is what keeps a new scene clean.
  private standing = "";
  private lastSeq = 0;
  private slotKey = "";
  private slotN = 0;
  private cur: Beat | null = null;
  private openNext = false;
  /** 最长的那条 cue 的 `end`：时长那一截尾巴，落一条记一次，收尾不再全表 reduce。 */
  private tails = 0;
  /** 已经演到带子的第几格。续排从这一格起，`advance` 拿它问"新落的是哪一截"。 */
  private played = 0;
  /**
   * 演的是**哪一卷**带子 —— 认的是引用，不是内容。`log.ofTrack` 现在返回那一轨自己的数组：
   * 落一笔往里 push（引用不变，于是这一格答"还是那一卷"，只演新落的那一截），剪带与载入换数组
   * （引用变了，于是从零再演一遍）。
   */
  private tape: readonly OpEntry[] | null = null;

  private boardOf(name: string): Box {
    const known = this.boards.get(name);
    if (known) return known;
    const placed: Box = { x: (this.boards.size + 1) * BOARD_SPACING, y: 0, w: VIEWPORT.w, h: VIEWPORT.h };
    this.boards.set(name, placed);
    return placed;
  }

  /**
   * 落上一块板时镜头该站的位置。如果这块板上有站着的东西（含上一次访问留下的、此刻还被幕布压着的），
   * frame 它们（padded，一直如此）—— 导演手工摆过的东西 owns 那个位置。如果什么都没有，板也自有一个
   * 地方，把镜头移过去正是这一刀的全部意义：站着不动、让幕布把上一块板的画扫走，学习者就只能盯着一帧
   * 自己从没被展示过的空画面。
   *
   * 这里不问"扫没扫走"：回到一块板正是那些东西重新在眼前的一刻，落点得把它们一起框住。镜头点一块板的
   * 名是另一回事，那一头走 `ground.box`。
   */
  private boardView(name: string, aspect: number): Box {
    const laid = this.ground.landing(name);
    return fitRect(laid ? padded(laid, 1.2) : this.boardOf(name), aspect);
  }

  /*
   * `here` is what happens when the director asks for an object but names no coordinates: it lands
   * inside the frame the camera is on, and a second one does not sit exactly on the first.
   * Placing things by world numbers is the part of an unbounded plane a model reliably gets wrong,
   * and a prop outside the frame is a lesson the learner never sees.
   *
   * The first slot is the centre of the frame — one object asked for one object, and the audience
   * should not have to look off-axis at it. After that the slots spiral outward over the region the
   * *centre* may occupy without the box leaving the frame (so a ring cannot push art out of shot),
   * which is what a skeleton with more than four ideas in a beat needs: the old four-quadrant
   * remainder folded the fifth prop back onto the first, and the learner saw one object and was
   * shown two. The rings hold 16 off-centre spots before the pattern repeats, each at its own angle.
   */
  private framed(box: Box, here: boolean | undefined, view: Box): Box {
    if (!here) return box;
    const key = `${Math.round(view.x)},${Math.round(view.y)},${Math.round(view.w)},${Math.round(view.h)}`;
    if (key !== this.slotKey) {
      this.slotKey = key;
      this.slotN = 0;
    }
    const i = this.slotN++;
    // The rectangle a box's centre may occupy while the box stays inside the frame.
    const rx = Math.max(view.w - box.w, 0) / 2;
    const ry = Math.max(view.h - box.h, 0) / 2;
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    if (i === 0 || (rx === 0 && ry === 0)) {
      // One slot, or a box as big as the frame: there is nowhere honest to put a second one, so it
      // centres. Overlap here is geometry, not a bug in the layout.
      return { x: cx - box.w / 2, y: cy - box.h / 2, w: box.w, h: box.h };
    }
    const ring = 1 + (i - 1) % 4;
    const cycle = Math.floor((i - 1) / 4);
    const per = 8; // eight positions per ring: the diagonal corners and the four edge midpoints, both ways
    const step = (2 * Math.PI) / per;
    // Start off-axis so the first ring slot never shares an x or a y with the centre; each overflow
    // cycle rotates by half a step, which is not a multiple of the step until the pattern is exhausted.
    const a = step * (((i - 1) % per) + 0.5) + cycle * (step / 2);
    const f = ring / 4;
    return { x: cx + Math.cos(a) * rx * f - box.w / 2, y: cy + Math.sin(a) * ry * f - box.h / 2, w: box.w, h: box.h };
  }

  /**
   * Where a camera op lands, given the frame it starts from. `from` is a parameter rather than the
   * live cursor because a `here` placement has to ask this question about a move that has not been
   * compiled yet — and a chain of two moves in one beat only looks right if the second is resolved
   * from where the first lands.
   */
  private resolve(op: CameraOp, from: Box = this.cursor): Box {
    const targets: Box[] = [];
    if (op.target) {
      const ids = Array.isArray(op.target) ? op.target : [op.target];
      for (const id of ids) {
        // 先当道具名，再当板名 —— 和以前一样，但两个都问镜头脚下这一刻：观众已经看不见的那一格
        // 不是目标，那一头 `blindCamera` 说的"画面这一拍不会动"才跟着成立。
        const rev = this.ground.revOf(id);
        const b = rev ? revBox(rev) : this.ground.box(id);
        if (b) targets.push(b);
      }
    }
    if (op.region) targets.push(op.region);
    let rect = targets.length ? unionBox(targets) : from;
    if (op.at && targets.length === 1) {
      // A close-up frames a part, not a bigger version of the whole: the point is given as a
      // fraction of the prop's own box because the director never knows where the artwork ends.
      const b = targets[0];
      const side = Math.max(b.w, b.h) * Math.min(1, Math.max(0.05, op.span ?? 0.45));
      rect = { x: b.x + b.w * frac(op.at.x) - side / 2, y: b.y + b.h * frac(op.at.y) - side / 2, w: side, h: side };
    } else if (op.mode === "focus" && targets.length === 1) rect = padded(targets[0], 1.5);
    if (op.mode === "pan" && op.dir) {
      const f = Math.min(4, Math.max(0.1, op.screens ?? 0.8));
      const dx = op.dir === "right" ? f : op.dir === "left" ? -f : 0;
      const dy = op.dir === "down" ? f : op.dir === "up" ? -f : 0;
      rect = { x: from.x + dx * from.w, y: from.y + dy * from.h, w: from.w, h: from.h };
    }
    if (op.mode === "pan" && op.center) {
      const c = op.center;
      rect = { x: c.x - from.w / 2, y: c.y - from.h / 2, w: from.w, h: from.h };
    }
    if (op.mode === "zoom" && op.zoom) {
      const c = centerOf(from);
      const w = VIEWPORT.w / Math.max(op.zoom, 0.01);
      rect = { x: c.x - w / 2, y: c.y - (w / (from.w / from.h)) / 2, w, h: w / (from.w / from.h) };
    }
    if (op.mode === "track" && op.follow) {
      // 跟读一个观众已经看不见的名字，画面就滑到那块空地上去。这一刀不许动 —— 名单里也没有它，
      // 而 `visibleName` 那一头说的正是"观众看不见它"。
      const rev = this.ground.revOf(op.follow);
      if (rev) {
        const c = centerOf(revBox(rev));
        rect = { ...from, x: c.x - from.w / 2, y: c.y - from.h / 2 };
      }
    }
    if (op.mode === "fit") rect = padded(rect, 1.2);
    return limitPushIn(fitRect(rect, from.w / from.h), from.w / from.h);
  }

  /**
   * The frame a `here` prop should be placed in: whatever the camera will be looking at by the time
   * this beat is spoken, not wherever it stood when the beat's props were laid down.
   *
   * A skeleton says "pan one screen into the empty space, and put the new idea there" as one beat:
   * `stage_script` emits the placeholder first and the move after it, because the prop has to be on
   * the tape before the line that points at it. Placing by the *current* cursor then anchors the new
   * object in the space the cut is walking away from, and the audience watches a camera glide to an
   * empty frame. Only `pan`/`zoom` are looked ahead: they resolve purely from the frame, and a
   * `fit`/`focus` that names this very prop is resolved after it lands, which already frames it.
   *
   * The scan is bounded. Reading the tail is per placement, so an unbounded walk makes a beat cost
   * O(props²): 40k briefed placeholders with no line between them measured 7.4 seconds inside the
   * compiler — a frozen tab, not a slow show. A beat's camera tail is a move or two, so cutting the
   * look-ahead after `LOOKAHEAD_OPS` entries is exact for anything a director actually performs and
   * constant-cost for a tape that does not.
   *
   * 第二条边界是**这一批**（`OpEntry.group`），比"下一句旁白"更近的那一道墙。这一头以前只认时钟，所以
   * 一格的落点会越过批的边界，读到身后任何一批里的 overlay；而 `compile` 是整卷重排的，于是导演后落的
   * 那一批把观众已经看过的那一格改写了。实测（`landed.test.ts` 钉的同一卷）：第一批 `{旁白, 占位符}` 落下
   * 的锚点是 `{x:700,…}`，追加第二批 `{往右一屏, 旁白}` 之后同一个道具的锚点成了 `{x:2300,…}` —— 东西
   * 在观众眼前自己飞走，而带子上没有任何一刀说要挪它。这不是难看，是"磁带只增不改"那句契约破了：落笔
   * 那一刻算好的几何，不该被后来的笔改。旁白挡不住它，因为 overlay 不占时钟 —— 第二批完全可以是一刀
   * 镜头加一句话，而那句话之前的那一刀正在被第一批里的占位符读着。
   *
   * 所以这一问只在同一批里往后看：一批是"一次工具调用排完的那一段"（`stage_script` 一整份骨架就是一
   * 批，占位符、那一刀的 pan、那句话都在里面）。批内的语义和以前逐字相同 —— `compile.test.ts` 钉的
   * "占位符先上、镜头后走"仍然跟着镜头走，那一卷整卷是一批。批与批之间是**已经演过**的历史，历史不许
   * 重演。缺 `group` 的带子（旧分享链接、测试里一次排完的 tape）两边都是 `undefined`，于是不换批 ——
   * 那正是它们当时被排出来的样子。
   */
  private readonly LOOKAHEAD_OPS = 256;

  private placementView(entries: readonly OpEntry[], at: number): Box {
    let view = this.cursor;
    const group = entries[at].group;
    const stop = Math.min(entries.length, at + this.LOOKAHEAD_OPS + 1);
    for (let n = at + 1; n < stop; n++) {
      const next = entries[n];
      // 换了批就是已经演过的历史：往后读到它，等于让后一笔改写前一笔已经落定的几何。
      if (next.group !== group) break;
      const op = next.op;
      if (ownsTime(op)) break;
      if (op.kind === "camera" && (op.mode === "pan" || op.mode === "zoom")) view = this.resolve(op, view);
    }
    return view;
  }

  /**
   * Where a `here` placement lands for a prop the director says belongs on a board the show is not
   * standing on. The frame it is placed into is that board's ground, not the view under the camera
   * right now: naming a board and then anchoring the object in another board's coordinates stacks two
   * scenes on the same patch of plane, and the cut that follows then frames the pile.
   */
  private hereView(entries: readonly OpEntry[], at: number, scene: string | undefined): Box {
    if (scene && this.standing && scene !== this.standing) return this.boardView(scene, this.cursor.w / this.cursor.h);
    return this.placementView(entries, at);
  }

  /**
   * The box a `build`/`recall` lands on. Computing the placement frame is the expensive half of this,
   * and it is only ever meaningful for an op that asked for it — so the view is behind a thunk rather
   * than an argument. Naming it eagerly looked harmless and was not: `placementView` scans forward to
   * the next line, so a tape of 130k coordinate-carrying props spent 49 seconds re-deriving frames it
   * never used, which is a frozen tab before a single cue exists.
   */
  private placedBox(entries: readonly OpEntry[], raw: Box, here: boolean | undefined, at: number, scene: string): Box {
    return here ? this.framed(raw, true, this.hereView(entries, at, scene)) : raw;
  }

  private ensureProp(id: string, scene: string): Prop {
    let p = this.props.get(id);
    if (!p) {
      p = { id, scene, revisions: [], links: [] };
      this.props.set(id, p);
      // 道具进表 = 层叠次序里多了一个号。`link` 只点了名的那一格也走这里，所以号在**进表**那一刻发，
      // 不在第一次落笔那一刻发 —— 续排的索引按这条流水发号，才能和"扫一遍道具表"发出同一套号。
      this.touched.push({ kind: "prop", prop: p });
    }
    return p;
  }

  /**
   * 这一笔落定之后，这个道具**到带子尽头**还站着的那一次外观，在不在它该占的那块板上占地方。
   *
   * 旧写法的 `groundsAtEnd` 把整张道具表走一遍答这一问；续排不许每批再走一遍，所以它改成正落笔时就
   * 把这一格记进那块板的四条边、收笔时就摘掉。判据和 `groundsAtEnd` 逐字同：站的是最后一格、
   * `onstageAt(last, Infinity)`（还没收笔），占的地方按 `prop.scene`（道具最后被挪去了哪 —— 这是
   * 导演快照要的那一句，和镜头那一刻的 `rev.scene` 是两件事，见 `CameraGround`）。
   */
  private syncEnd(p: Prop): void {
    const last = p.revisions.length ? p.revisions[p.revisions.length - 1] : undefined;
    const standing = onstageAt(last, Infinity) ? last : undefined;
    const was = this.recorded.get(p.id);
    if (was && was.rev === standing && was.board === p.scene) return;
    if (was) {
      this.grounds.get(was.board)?.drop(was.id);
      this.recorded.delete(p.id);
    }
    if (!standing) return;
    let g = this.grounds.get(p.scene);
    if (!g) {
      g = new BoardGround();
      this.grounds.set(p.scene, g);
    }
    const id = g.add(revBox(standing));
    this.recorded.set(p.id, { board: p.scene, id, rev: standing });
  }

  /**
   * 带子往下长了一截：只演 `[played, entries.length)` 那一段。
   *
   * 这里**不**判断"还是不是那一卷带子" —— 那是调用方（`perform`）问的事，它答错的话这一格会把两卷
   * 带子的东西演进同一台机器里。`play` 只认一条：带子只许往下长。
   */
  play(entries: readonly OpEntry[]): void {
    this.tape = entries;
    for (let i = this.played; i < entries.length; i++) {
      const entry = entries[i];
      const op = entry.op;
      this.lastSeq = entry.seq;
      const start = this.t;

      // A beat is a line plus whatever was staged to make it: props and camera land *before* the
      // line, so once a line is spoken the next op opens the following beat.
      const speaks = op.kind === "narrate" || op.kind === "beat";
      if (!this.cur || this.openNext) {
        // 上一拍在这一刻收口：`closeBeat` 把它里面那几张卡的窗口定下来并清空，然后才开新一拍。
        // 顺序不许倒过来 —— 清空的必须是**收口掉的那一拍**的卡。也不许在"开新一拍"这里顺手抹一次：
        // 一张卡收不收口问的是"它那一拍的 end 还长不长"，而 end 只在它是 `this.cur` 时长。
        // 旁白和 `beat` 才收拍，所以 `quiz, 镜头, 镜头, quiz, 镜头, 镜头, 旁白` 一整段里两张卡都还开着，
        // 各按自己那一拍的 end 收 —— 旧写法收尾拿 `seqBeat` 逐张问"你在哪一拍"说的就是同一句话。
        if (this.cur) this.closeBeat();
        this.cur = { turn: entry.turn, start, end: start, headline: "", verbs: [], seqs: [], gate: false };
        this.beats.push(this.cur);
      }
      const cur = this.cur;
      cur.seqs.push(entry.seq);
      if (!cur.verbs.includes(op.kind)) cur.verbs.push(op.kind);
      if (!cur.headline) {
        if (op.kind === "narrate") cur.headline = op.text;
        else if (op.kind === "quiz") cur.headline = op.prompt;
        else if (op.kind === "pause-for") cur.headline = op.reason;
      }
      if (op.kind === "quiz" || op.kind === "pause-for") cur.gate = true;

      switch (op.kind) {
        case "build":
        case "patch": {
          // `patch` 是给已经站在台上的东西交图，不是把它造出来。一个带上还没有的名字（拼错了一个 id，
          // 或者只被 `link` 念到过）落到这里，以前会凭空长出一格 `{0,0,1600,900}` 的"成品"：满幅、
          // `partial:false`，于是时钟不等它（`owedAt` 只数空白框欠的画），观众看见一整块盖住板的东西，
          // 而带子上没有任何一刀说要它。`link` 那一头的仓库早就防住了（`fetch_prop` 会说"只被念到名字"），
          // 这一头没有防 —— 现在两头的说法是同一句。
          if (op.kind === "patch" && !this.props.get(op.id)?.revisions.length) break;
          const p = this.ensureProp(op.id, op.scene ?? (this.props.get(op.id)?.scene ?? (this.standing || "default")));
          // Naming a board moves an established prop onto it, exactly as `recall` does: the name is the
          // director saying where this object belongs now, and a prop left on the old board is invisible.
          if (op.scene) p.scene = op.scene;
          const prev = p.revisions[p.revisions.length - 1];
          const fillingPlaceholder = op.kind === "patch" && prev?.partial;
          const box = op.kind === "build" ? this.placedBox(entries, op.box, op.here, i, p.scene) : op.box ?? prev?.box ?? { ...VIEWPORT };
          const revision: Revision = {
            t: fillingPlaceholder ? prev.t : start,
            // `patch` 是给已经站在台上的东西交图，不是把它带回台上 —— 带回台上是 `recall`。所以已经收掉的
            // 那段窗口该由它自己带着：美工迟到的那一笔落在撤下之后，不许让一件导演已经撤掉的东西复活。
            // 迟到的图没有丢，它就在这段收掉的窗口里，`recall` 带的正是它。
            off: op.kind === "patch" ? prev?.off : undefined,
            scene: p.scene,
            box,
            svg: op.svg ?? (op.kind === "patch" ? prev?.svg : undefined),
            html: op.html ?? (op.kind === "patch" ? prev?.html : undefined),
            css: op.css ?? (op.kind === "patch" ? prev?.css : undefined),
            scene3d: op.scene3d ?? (op.kind === "patch" ? prev?.scene3d : undefined),
            label: op.label ?? prev?.label ?? op.id,
            note: op.kind === "build" ? op.note : prev?.note,
            partial: !(op.svg || op.html || op.scene3d),
          };
          if (fillingPlaceholder) {
            p.revisions[p.revisions.length - 1] = revision;
            this.touched.push({ kind: "fill", prop: p, old: prev, rev: revision });
          } else {
            // 先记"上一格的窗口收上了"，再记"新格落下了"：同一刻里收走总排在落下之前（窗口的左闭右开），
            // 流水的次序就是事件流的次序 —— 反过来会让读台面那一头先 put 再 take，在同一道具同一刻
            // 留下一格挂在旧板头上。
            const closed = layRevision(p, revision);
            if (closed) this.touched.push({ kind: "close", prop: p, rev: closed });
            this.touched.push({ kind: "lay", prop: p, rev: revision });
          }
          // 迟到的那一笔落在一段已经收掉的窗口里：观众眼前没有多出一格，镜头脚下也不许多算一格。
          if (onstageAt(revision, start)) this.ground.put(op.id, revision);
          this.syncEnd(p);
          break;
        }
        case "recall": {
          const src = this.props.get(op.id);
          if (!src || src.revisions.length === 0) break;
          const prev = src.revisions[src.revisions.length - 1];
          src.scene = op.scene || this.standing || "default";
          // `off: undefined` 不是装饰：`{...prev}` 会把上一次站着的外观那"已经收掉"的时刻一起抄过来，
          // 于是 recall 带回台上的东西一落地就是撤着的 —— 道具闪一下然后消失，而带子上没有第二刀
          // discard。一次 recall 就是一次新的落笔，它自带一个新窗口。
          const back: Revision = { ...prev, t: start, off: undefined, scene: src.scene, box: this.placedBox(entries, op.box, op.here, i, src.scene) };
          const closed = layRevision(src, back);
          if (closed) this.touched.push({ kind: "close", prop: src, rev: closed });
          this.touched.push({ kind: "lay", prop: src, rev: back });
          this.ground.put(op.id, back);
          this.syncEnd(src);
          break;
        }
        case "discard": {
          const p = this.props.get(op.id);
          if (!p) break;
          const closed = markOff(p.revisions, start);
          if (closed) this.touched.push({ kind: "close", prop: p, rev: closed });
          this.ground.off(op.id);
          this.syncEnd(p);
          break;
        }
        case "link": {
          // 关系留在道具表里，名字先于画面存在 —— 那是身份，不是画框（`identity.test.ts` 钉的就是这一条）。
          // `at` 是这一刀落下的那一刻：以前这一格只存 `to` 和 `relation`，于是它是这张表上唯一**没有时刻**
          // 的账，倒带回到那一刀之前，导演的快照照样报出那条关系，而它指着的那个名字此刻还没上台。
          this.ensureProp(op.from, this.props.get(op.from)?.scene ?? "default").links.push({
            at: start,
            to: op.to,
            relation: op.relation,
          });
          break;
        }
        case "camera": {
          const to = this.resolve(op);
          this.pushCue({ t: start, end: start + cueMs(op), op, from: this.cursor, to });
          // 同一刀落在带子上只有一个位置；一次重演可以反复问同一个引用，这一格不许多付钱。
          if (!this.shotAt.has(op)) this.shotAt.set(op, start);
          this.cursor = to;
          break;
        }
        case "transition":
        case "narrate":
        case "highlight":
        case "motion": {
          this.pushCue({ t: start, end: start + cueMs(op), op, from: this.cursor, to: this.cursor });
          if (op.kind === "transition") {
            // Reserve the ground before anything is looked for on it, so a board cut to twice keeps the
            // same place and `recall`ing onto it is not relative to where the camera last stood.
            this.standing = op.to;
            // 幕布盖住整块板的那一刻是 `flip`，和 `frame.ts` 里那一刀同一个算法：换场占时钟，`flip` 是
            // 它的中点。先按换场之前那一刻量落点（这一块板上的旧东西在这一刀之后仍然看得见），再让
            // 排在它身后的镜头按这一刀算。
            const cue = this.cues[this.cues.length - 1];
            const to = this.boardView(op.to, this.cursor.w / this.cursor.h);
            cue.to = to;
            this.cursor = to;
            // 落点改了，尾巴那一笔也得改：`pushCue` 记下的是"站着不动"那个 end 之前先到的 max，
            // 而这里只改 `to`，`end` 没动，所以那一笔仍然对。
            this.ground.cutTo(op.to, cue.t + (cue.end - cue.t) / 2);
          }
          break;
        }
        case "quiz":
        case "pause-for": {
          const gate: Gate = { t: start, seq: entry.seq, kind: op.kind, op, said: null, until: start };
          this.gates.push(gate);
          this.gateBySeq.set(entry.seq, gate);
          this.openGates.push(gate);
          break;
        }
        case "answer": {
          // A record, not a move: his words hold no clock, and the cut-tape rule still applies —
          // rewinding past a card takes his answer back with it, because this is the only place they exist.
          const asked = this.gateBySeq.get(op.gate);
          if (asked && asked.said === null) asked.said = op.text;
          break;
        }
        case "beat": {
          this.pushCue({ t: start, end: start + cueMs(op), op, from: this.cursor, to: this.cursor });
          break;
        }
      }
      if (ownsTime(op)) this.t = start + cueMs(op);
      cur.end = Math.max(cur.end, this.t);
      this.openNext = speaks;
    }
    this.played = entries.length;

    // A card's window is the beat that asked it. Closed beats already handed their `end` over below
    // (`closeBeat`); the only one still growing is the beat the playhead has not walked out of, so
    // only *its* cards are re-billed here. That is the incremental reading of the same sentence the
    // old tail wrote with `for (const g of gates)` over the whole card table — which used to make
    // every batch pay a pass over every question the lesson ever asked.
    for (const g of this.openGates) {
      const asked = this.cur;
      if (asked) g.until = asked.end;
    }
  }

  /** 一条 cue 落下来，顺手记一记时长那截尾巴。 */
  private pushCue(cue: Cue): void {
    this.cues.push(cue);
    if (cue.end > this.tails) this.tails = cue.end;
  }

  /**
   * 收口当前这一拍：把它的 `end` 交给里面那几张卡，从此这张卡的窗口不再随带子长。
   * 旧写法这一笔在整卷排完的收尾里做，全表一次；续排只在**拍收口的那一刻**做它自己那几张。
   */
  private closeBeat(): void {
    if (!this.cur) return;
    for (const g of this.openGates) g.until = this.cur.end;
    this.openGates = [];
  }

  /**
   * 这台机器演的是不是**这一卷**带子 —— 认的是引用（`Interpreter.tape`）。
   * `log.ofTrack` 给的是那一轨自己的数组：落一笔往里 push，引用不变，这一问答"是"。
   */
  holds(entries: readonly OpEntry[]): boolean {
    return this.tape === entries;
  }

  /**
   * 演到这一刻的台面。
   *
   * 每次调用返回一个新的 `Compiled` 记录（读它的人靠引用换没换判断"带子动过了"），可里面的道具表、
   * cue 表、卡表、拍表是**同一批会长大的容器** —— 带子只增不改，那些东西也正是只增不改的：
   * 一次外观落下来就不再挪，一条 cue 落下来就不再动。剪带与载入换的是带子本身，那一头整台机器扔掉
   * 从零再演（`runtime.ts`）。
   */
  result(): Compiled {
    const scenes = new Map<string, Box>();
    for (const [name, g] of this.grounds) {
      const b = g.view();
      if (b) scenes.set(name, b);
    }
    return {
      props: this.props,
      scenes,
      cues: this.cues,
      gates: this.gates,
      beats: this.beats,
      duration: Math.max(this.t, this.tails),
      lastSeq: this.lastSeq,
      touched: this.touched,
      shotAt: this.shotAt,
    };
  }
}

/**
 * 整卷排一遍：一台新机器，从第 0 格演到带子尽头。
 *
 * 语义与逐批续排同解 —— 那不是"应该一样"，是 `landed.test.ts` 逐格比过两样东西（落点、镜头轨），
 * 而 `incremental.test.ts` 把"续排的台面"和"重排整卷的台面"逐字段对账钉住。`compile` 仍然是所有
 * 旧测试和"换带子"那一头走的路。
 */
export function compile(entries: readonly OpEntry[]): Compiled {
  const it = new Interpreter();
  it.play(entries);
  return it.result();
}

/**
 * 排这一卷带子，能续就续、不能续就从零演 —— 一台机器跟着一条轨道活。
 *
 * `it` 是这条轨道上上一次那台机器（没有就传 `null`）。判据只有一条引用相等：`it.holds(entries)`
 * 说是同一卷，就只演新落的那一截；说不是（剪带、载入、清空都换数组），就扔掉这台机器从零演。
 * 返回的机器要留着下次用 —— 调用方一轨一台，见 `runtime.ts` 的 `Stage.machines`。
 *
 * 为什么把"认带子"这件事放在这里而不是让调用方自己管游标：游标（演到第几格）是机器内部的账，
 * 调用方隔着一条带子的长度去猜它，猜错一次就是"新落的没演"或"演过的重演一遍"，而两种都只在下一次
 * 读数时露馅。带子引用是调用方唯一真正拥有的东西，所以它就是这一问的全部。
 */
export function perform(it: Interpreter | null, entries: readonly OpEntry[]): { it: Interpreter; compiled: Compiled } {
  const machine = it && it.holds(entries) ? it : new Interpreter();
  machine.play(entries);
  return { it: machine, compiled: machine.result() };
}
