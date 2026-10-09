import { guardEntry, guardOp } from "./guard";
import type { OpEntry, Op, TrackId } from "./types";

export const MAIN_TRACK: TrackId = "main";

/**
 * `ofTrack` 问一条从没落过笔的轨道时给出去的那一个空数组。共用一个引用是有意的：它是"什么都没有"
 * 这个答案，不是那一卷带子 —— 解释器认带子认的是引用（`compile.ts` 的 `Interpreter.holds`），拿同一块空地当两卷
 * 带子读出来的台面都是空的，而下一刀真落下来时换的是这一轨自己那个数组，引用当场就变了。
 */
const NOTHING: OpEntry[] = [];

/**
 * 带子自己的三本账。
 *
 * 以前 `OpLog` 对着一卷带子只有一句"整卷在这儿"，于是每一问都得把整卷走一遍：`ofTrack` 每批
 * `filter` 出一份新数组、`asides()` 每批把整卷 `map` 一遍再 `Set` 再展开、`entryAt` 每问线性扫一遍。
 * 几百刀的课上看不见，六万刀的课上是每批七毫秒的税，而导演一轮落十几刀。
 *
 * 更要紧的是第二件事：**增量解释器续排的前提是"我能认出还是不是原来那一卷带子"**，而这要求
 *
 *  1. 追加往那一轨**自己的**数组里 push，引用不许换 —— 旧写法每批现造一份新的，"读的还是不是那一卷"
 *     这一问根本没有答案可问；
 *  2. 剪带、载入是**换带子**，那一头必须换数组（于是那一侧付整卷重排的价钱，这是诚实的：它是人手点的
 *     一次"重排"，不是一轮落十几刀）。
 *
 * 两种动作在类型上就该分开，否则下一个读代码的人会把它们混成一次拷贝。
 *
 * 号那一本账（坏 `seq`、撞号）仍然在门口（`guard.ts` 的 `guardEntry`），这里只管索引不管合法性。
 */
export class OpLog {
  private entries: OpEntry[] = [];
  /** 轨道 → 那一轨自己的数组。里面的格子和 `entries` 里的是同一批对象。 */
  private tracks: Map<TrackId, OpEntry[]> = new Map();
  /** 号 → 那一格。答话、剪带、查卡问的都是这一句，它以前是一次线性扫。 */
  private bySeq: Map<number, OpEntry> = new Map();
  private seq = 0;
  private turn = 0;
  private group = 0;

  /** 换带子（载入、剪带）之后重指三本账：新数组、新号表，按当下带子里的次序。 */
  private reindex(entries: OpEntry[]): void {
    this.entries = entries;
    this.tracks = new Map();
    this.bySeq = new Map();
    for (const e of entries) {
      const list = this.tracks.get(e.track);
      if (list) list.push(e);
      else this.tracks.set(e.track, [e]);
      this.bySeq.set(e.seq, e);
    }
  }

  /**
   * The single gate every op passes through, whether it came from a director tool call or from a
   * recording somebody else shared. The interpreter's arithmetic — the clock, the camera, the ink
   * measure — assumes finite numbers and short strings; that assumption is enforced here rather than
   * left to whichever caller happens to have validated its input.
   *
   * 一次调用 = 一批。解释器里唯一要往后看的落点（`here`）只许读到本批为止，见 `compile.ts` 的
   * `placementView`：观众已经看过的那一格，不许被后落的那一批改写。
   *
   * 落笔是**同一卷带子长了一截**：往那一轨自己的数组里 push，引用不变，所以解释器只演新落的那一批
   * （`compile.ts` 的 `perform`）。
   */
  append(ops: Op[], track: TrackId): OpEntry[] {
    const batch = this.group++;
    let list = this.tracks.get(track);
    if (!list) {
      list = [];
      this.tracks.set(track, list);
    }
    const added = ops.map((op) => {
      const entry: OpEntry = { seq: this.seq++, track, turn: this.turn, group: batch, op: guardOp(op) };
      this.entries.push(entry);
      list.push(entry);
      this.bySeq.set(entry.seq, entry);
      return entry;
    });
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

  /**
   * 这一轨的那一卷带子。返回的是**带子本身**，不是它的一份拷贝：解释器每批读的就是这个引用，
   * 拷贝一份等于替它把"还是不是原来那一卷"这一问的答案抹掉，顺带每批付一次整份拷贝。
   * 所以这一头只许读，不许改 —— 类型上是 `readonly`，改带子只有 `append`/`cutFrom`/`restore` 三扇门。
   */
  ofTrack(track: TrackId): readonly OpEntry[] {
    return this.tracks.get(track) ?? NOTHING;
  }

  /** Ops appended after a sequence number, on any track — used to answer gates. */
  after(seq: number): OpEntry[] {
    return this.entries.filter((e) => e.seq > seq);
  }

  /**
   * 整卷的一份**拷贝**：只有 `ofTrack` 需要那一卷带子本身（解释器认引用），这一句的调用方（导出的
   * 快照、测试里"拿整卷再排一遍"那一份参照）拿到的是一份能自己留着改的记录，不是正在长的那一卷。
   */
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
    return this.bySeq.get(seq);
  }

  /**
   * Forget everything from `seq` onward, on every track. The tape is cut, not rewritten:
   * what survives keeps its sequence numbers, so the gap is itself a record of the re-take.
   *
   * 剪的是带子，不是某一格里的那个数字：留下那些格**原样换一个新数组**，所以每一轨的引用都变了 ——
   * 解释器在这一头从零再演一遍。那是诚实的价钱：剪带是人手点的一次"重排"，不是一轮落十几刀。
   */
  cutFrom(seq: number): number {
    const before = this.entries.length;
    const kept = this.entries.filter((e) => e.seq < seq);
    this.reindex(kept);
    this.seq = kept.reduce((m, e) => Math.max(m, e.seq + 1), 0);
    this.turn = kept.reduce((m, e) => Math.max(m, e.turn), 0);
    return before - this.entries.length;
  }

  /** Aside tracks play last-in-first-unwound: the main track never sees them. */
  asides(): TrackId[] {
    const out: TrackId[] = [];
    for (const [track, list] of this.tracks) if (list.length && track !== MAIN_TRACK) out.push(track);
    return out;
  }

  clear() {
    this.reindex([]);
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
   * 现在门也管账本（`guardEntry`）：`seq`/`turn`/`track`/`group` 这四个号不是几何，是**计数器读的东西**，
   * 而下面那三行 reduce 就是拿它们往上续的。改前这里只查 `typeof e.seq === "number"`，而 JSON 的 `1e999`
   * 解析成 `Infinity` 恰好是 number —— 于是 `Math.max(m, Infinity + 1)` 把批号永远钉在 Infinity：这一卷
   * 档案里有一个批号是 Infinity，接着讲时新落的那一批也被发成 Infinity，两边同批 —— `here` 的视线于是越过
   * 了批的边界，观众已经看过的那一格被后落的那一批改写（改前实测，走的是学习者真会点的那条 `#s=` 的路：
   * `{旁白, 占位符}` 落笔时锚点 x=700，追加一批 `{往右一屏, 旁白}` 之后成了 x=2300，`ledger.test.ts` 钉的
   * 就是这两个数）。`NaN` 是另一半：`Math.max(0, NaN)` 是 NaN，于是新落的每一格都同号。所以计数只从过完门
   * 的号开始数。
   *
   * 分批号一起进来：一支分享链接带着它当时是怎么一批一批落下的，重放于是和直播看见同一张台面（`here`
   * 的落点只读到本批为止，见 `compile.ts`）。老链接没有这个字段，整卷就是一批 —— 那正是它当年被排出来
   * 的样子。按最大号续上，因为"接着讲"接上去的现场，新落的那一批不许和档案里某一批同号：同号就是
   * 同一批，那一格的落点就会又读到观众已经看过的那一段身后去。
   *
   * 载入也是换带子：新数组、新的每一轨，所以解释器那一头从零演起 —— 一卷别人的课本来就还没演过。
   */
  restore(entries: OpEntry[]) {
    // 撞号也要在这一头管：两个号都说"我在这一格"，那这两格哪一格都不被承认 —— `entryAt`、`cutFrom`、
    // 答话找题卡全都用 `===` 查号，撞了就是一个答案同时答了两张卡。号是别人编的，不许在这儿重编（那会把
    // 带子上的引用挪到隔壁那一格），所以先落笔的那一句算数，后落的那一句当作说不清自己在哪儿。
    const seen = new Set<number>();
    const kept: OpEntry[] = [];
    for (const e of entries.map((e) => guardEntry(e))) {
      if (e === undefined || seen.has(e.seq)) continue;
      seen.add(e.seq);
      kept.push(e);
    }
    kept.sort((a, b) => a.seq - b.seq);
    this.reindex(kept);
    this.seq = kept.reduce((m, e) => Math.max(m, e.seq + 1), 0);
    this.turn = kept.reduce((m, e) => Math.max(m, e.turn), 0);
    this.group = kept.reduce((m, e) => Math.max(m, (e.group ?? -1) + 1), 0);
  }

  export(): OpEntry[] {
    return this.entries.slice();
  }
}
