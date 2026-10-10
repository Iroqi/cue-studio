// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { compile, perform, type Interpreter } from "./compile";
import { MAIN_TRACK, OpLog } from "./log";
import { TapeIndex } from "./frame";
import { StandingIndex, restand } from "./standing";
import { Stage } from "./runtime";
import type { Compiled, Op, OpEntry, Prop, Revision, Touched } from "./types";

/*
 * 这一节钉的是「带子长了一截，台面那本索引也只吸收那一截，而且吸收完答的是同一张台」。
 *
 * 上一件把 cue 表那本索引接上了续排，剩下的价钱落在这一本上：`runtime.ts` 每批 `new StandingIndex`
 * 一次，38400 格的带子落最后一批 4.565ms 里有 4.02ms 是它。这一件把同一句话搬过去 —— 可它比 A 险，
 * 险在一个 A 没有的地方：**已经进账的那一格，事实会在身后的刀上被改**。落下新格会收起上一格的窗口、
 * `discard` 会给此刻站着的那一格补 `off`、迟到的补画会把最后一格原地换掉。三处都不加长道具表，所以
 * 光读"长出来的那一截"看不见它们；而每批重扫整张道具表去找哪一格被改过，正是要消掉的那笔钱。
 * 于是改动由知道它的那一方记一笔流水（`Compiled.touched`），这一本只吸那一笔。
 *
 * 四层钉法，前三层每一层都在问"回头那一截怎么办"：
 *  1. **形状**：随机带子逐批追加，每一批落下之后，续排的索引和"拿这一批为止的台面新建一本"在每一问上
 *     逐刻对账。参照不许复用机器手上的容器。
 *  2. **价钱**：给道具表与流水各套一层 Proxy（套一次用到底）。续排时整张道具表一次也不许多走，流水
 *     只许读新接的那一截。这条不依赖毫秒。
 *  3. **回头改的那三处**：同刻先收旧再落新、空窗口、原地换掉 —— 一处一处钉，因为它们三种坏法不一样。
 *  4. **护栏**：一次建完的答案不许因为换了读法就变；认台面只认引用；`Stage` 那一头逐批 + 剪带 + 插播
 *     来回切仍然对账。
 */

const box = (x: number) => ({ x, y: 0, w: 200, h: 160 });
const art = (id: string, scene?: string): Op =>
  ({ kind: "build", id, ...(scene ? { scene } : {}), box: box(0), label: id, html: `<p>${id}</p>` }) as Op;
/** 一格空框：导演先报的名字和位置，图还没来 —— 美工迟到的那一笔补的就是它。 */
const skeleton = (id: string, scene?: string): Op =>
  ({ kind: "build", id, ...(scene ? { scene } : {}), box: box(0), label: id }) as Op;
const inked = (id: string, scene?: string): Op =>
  ({ kind: "patch", id, ...(scene ? { scene } : {}), box: box(300), svg: `<svg><text>${id}</text></svg>` }) as Op;
/** 补画但仍未交齐（只有位置没有图）：`partial` 还是真，所以它填的还是同一格。 */
const bare = (id: string, scene?: string): Op =>
  ({ kind: "patch", id, ...(scene ? { scene } : {}), box: box(100) }) as Op;
const line = (text: string, duration = 800): Op => ({ kind: "narrate", text, duration });
const silent = (duration = 400): Op => ({ kind: "beat", duration });
const drop = (id: string): Op => ({ kind: "discard", id });
const back = (id: string, scene?: string): Op => ({ kind: "recall", id, ...(scene ? { scene } : {}), box: box(600) }) as Op;
const cut = (to: string): Op => ({ kind: "transition", style: "dissolve", to, duration: 1200 });
const card = (prompt: string): Op => ({ kind: "quiz", prompt, options: ["甲", "乙"], answer: 1 });

function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

/**
 * 一批的形状 = 一次工具调用排完的那一段。**不许每批收尾于旁白**（`incremental.test.ts` 那条教训：每批
 * 都收在旁白上的生成器，跨批那一段根本没被读到）。这里还要每一批都落至少一次笔，否则"回头改的那一格"
 * 落在批的哪一头就随机了，对账会有一段空转。
 */
function generator(seed: number) {
  const r = rng(seed);
  const ids = ["a", "b", "c", "d"];
  const boards = ["甲", "乙", "丙"];
  const pick = (a: string[]) => a[r(a.length)];
  return (): Op[] => {
    const batch: Op[] = [];
    const n = 2 + r(5);
    for (let i = 0; i < n; i++) {
      const id = pick(ids);
      switch (r(9)) {
        case 0:
          batch.push(art(id, r(3) === 0 ? pick(boards) : undefined));
          break;
        case 1:
          batch.push(skeleton(id, r(4) === 0 ? pick(boards) : undefined));
          break;
        case 2:
          batch.push(inked(id, r(4) === 0 ? pick(boards) : undefined));
          break;
        case 3:
          batch.push(drop(id));
          break;
        case 4:
          batch.push(back(id, r(3) === 0 ? pick(boards) : undefined));
          break;
        case 5:
          batch.push(line("第 " + i + " 句，够长才算一拍", 300 + r(1200)));
          break;
        case 6:
          batch.push(cut(pick(boards)));
          break;
        case 7:
          batch.push(silent(200 + r(600)));
          break;
        default:
          batch.push(card("问 " + r(50) + "？"));
      }
    }
    // 每批至少一次落笔：不然是"回头那一截"没被改到的空转。
    if (!batch.some((o) => o.kind === "build" || o.kind === "patch" || o.kind === "recall" || o.kind === "discard")) {
      batch.push(art(pick(ids), pick(boards)));
    }
    return batch;
  };
}

function pushBatch(tape: OpEntry[], ops: Op[], batch: number): void {
  ops.forEach((op) => tape.push({ seq: tape.length, track: MAIN_TRACK, turn: batch, group: batch, op }));
}

/* ------------------------------------------------------------------ 对账的尺子 */

/** 每一刀换场的 `flip`：换场那半条规则只在它那一刻翻脸，只问落笔时刻问不到。 */
function cutsOf(c: Compiled): { flip: number; board: string }[] {
  const out: { flip: number; board: string }[] = [];
  for (const q of c.cues) {
    if (q.op.kind === "transition") out.push({ flip: q.t + (q.end - q.t) / 2, board: q.op.to });
  }
  return out;
}

/**
 * 该问的刻点：每一格外观点的两端，加**相邻两端的中点**和每一段的最后一毫秒，再加每一刀换场的 `flip`。
 * 上一件在道具表那一头学到的是同一句话 —— 只问边缘是对账的空转。
 */
function marks(c: Compiled): number[] {
  const edges = new Set<number>([0, c.duration]);
  for (const p of c.props.values()) {
    for (const r of p.revisions) {
      edges.add(r.t);
      if (r.off !== undefined) edges.add(r.off);
    }
  }
  for (const q of c.cues) {
    if (q.op.kind === "transition") edges.add(q.t + (q.end - q.t) / 2);
  }
  const sorted = [...edges].filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  const out = new Set<number>(sorted);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (b - a >= 2) out.add(Math.floor((a + b) / 2));
    out.add(b - 1);
  }
  out.add(Infinity);
  return [...out];
}

const idsOf = (list: { prop: Prop }[]): string[] => list.map((s) => s.prop.id);
const cellsOf = (list: { prop: Prop; rev: Revision; rank: number }[]): string[] =>
  list.map((s) => `${s.prop.id}@${s.rev.t}#${s.rank}`);

/**
 * 一帧会问带子的那几问，一次问完压成一段字符串。**格子的身份也进这一串**（`@t#rank`）：光比 id 的话，
 * 同一件东西挂着一格早该搬走的外观也能答对，而那一头观众看见的就是两层。
 *
 * `withLaid` 关掉时不比 `laidIn` —— 那一问按每一拍的时间窗切片，逐批比要让对账本身长成带子的平方。
 * 便宜的几问（名单、层叠、每刀可见、`seen`）逐批比，`laidIn` 在最后一卷上整场比一次。
 */
function answersOf(ix: StandingIndex, t: number, c: Compiled, withLaid: boolean): string {
  const cutList = cutsOf(c);
  const parts = [`standing:${idsOf(ix.standing(t)).join(",")}`];
  for (const cut of cutList) parts.push(`vis:${JSON.stringify(cut)}:${cellsOf(ix.visible(t, cut)).join("|")}`);
  parts.push(`nocut:${cellsOf(ix.visible(t, null)).join("|")}`);
  for (const id of ["a", "b", "c", "d"]) {
    parts.push(`seen:${id}:${cutList.map((cut) => (ix.seen(id, t, cut) ? "1" : "0")).join("")}${ix.seen(id, t, null) ? "N" : "-"}`);
  }
  if (withLaid) {
    for (const q of c.cues) {
      if (q.op.kind !== "narrate" && q.op.kind !== "beat" && q.op.kind !== "transition") continue;
      parts.push(`laid:${q.t}:${q.end}:${cellsOf(ix.laidIn(q.t, q.end, t)).join("|")}`);
    }
  }
  return parts.join(";");
}

/** 两条路必须答一样；先说清差在哪一刻，否则红起来只是一大坨字符串。 */
function sameIndex(grown: StandingIndex, fresh: StandingIndex, c: Compiled, withLaid = true): string | null {
  for (const t of marks(c)) {
    const a = answersOf(grown, t, c, withLaid);
    const b = answersOf(fresh, t, c, withLaid);
    if (a !== b) return `t=${t}：续排比新建少/多在这一格：\n  续排 ${a.slice(0, 400)}\n  新建 ${b.slice(0, 400)}`;
  }
  return null;
}

/* ================================================================== 1 形状 */

describe("台面续排：吸收新落的那一截，和新建一本答的是同一张台", () => {
  const gen = generator(20261010);

  /**
   * 逐批追加的台面 vs 每批新建一本。参照那一本只问便宜的几问（名单、层叠、`seen`），`laidIn` 只在
   * **最后**那一卷上整场比一次 —— 它按时间窗切片，逐批比会让对账本身长成带子的平方，红起来反而慢。
   */
  function reconcile(nTapes: number, nBatches: number): { checked: number; bad: string[] } {
    let checked = 0;
    const bad: string[] = [];
    let last: { grown: StandingIndex; fresh: StandingIndex; c: Compiled } | null = null;
    for (let k = 0; k < nTapes; k++) {
      const tape: OpEntry[] = [];
      let it: Interpreter | null = null;
      let ix: StandingIndex | null = null;
      for (let b = 0; b < nBatches; b++) {
        pushBatch(tape, gen(), b);
        const run = perform(it, tape);
        it = run.it;
        ix = restand(ix, run.compiled);
        // 参照：拿**这一批为止**的台面从零再排一遍、现建一本。不许复用机器手上的容器。
        const fresh = new StandingIndex(compile(tape.slice()));
        const diff = sameIndex(ix, fresh, run.compiled, false);
        if (diff) bad.push(`tape ${k} batch ${b}: ${diff}`);
        checked += marks(run.compiled).length;
        last = { grown: ix, fresh, c: run.compiled };
      }
    }
    if (last) {
      const diff = sameIndex(last.grown, last.fresh, last.c, true);
      if (diff) bad.push(`最后一卷整场：${diff}`);
    }
    return { checked, bad };
  }

  it("一百卷随机带子、每卷三十批：逐批对账每一问都不许有差异", () => {
    const { checked, bad } = reconcile(100, 30);
    expect(bad.slice(0, 2)).toEqual([]);
    expect(checked).toBeGreaterThan(30_000);
  }, 120_000);

  it("这批带子真的会换场、会撤下、会跨板复用、会迟到补画（不然上面的对账在空转）", () => {
    const kinds = new Set<string>();
    let fills = 0;
    let closes = 0;
    let sameInstant = 0;
    for (let reel = 0; reel < 40; reel++) {
      const tape: OpEntry[] = [];
      let it: Interpreter | null = null;
      for (let b = 0; b < 12; b++) {
        pushBatch(tape, gen(), b);
        const run = perform(it, tape);
        it = run.it;
        for (const t of run.compiled.touched) {
          kinds.add(t.kind);
          if (t.kind === "fill") fills++;
          if (t.kind === "close") closes++;
          if (t.kind === "lay" && t.rev.off === t.rev.t) sameInstant++;
        }
      }
    }
    expect([...kinds].sort()).toEqual(["close", "fill", "lay", "prop"]);
    expect(fills).toBeGreaterThan(20);
    expect(closes).toBeGreaterThan(100);
    // 同刻落了又撤的那一格：计划里说的那个坑。它必须真的出现过，否则第 3 节在钉一条空街。
    expect(sameInstant).toBeGreaterThan(0);
  });

  it("换台面那一头从零建：剪带之后仍然对账，接着落笔又改成续排", () => {
    const log = new OpLog();
    let it: Interpreter | null = null;
    let ix: StandingIndex | null = null;
    for (let b = 0; b < 12; b++) {
      log.append(gen(), MAIN_TRACK);
      const run = perform(it, log.ofTrack(MAIN_TRACK));
      it = run.it;
      ix = restand(ix, run.compiled);
    }
    const before = ix!;
    expect(log.cutFrom(6)).toBeGreaterThan(0);
    const run = perform(it, log.ofTrack(MAIN_TRACK));
    const rebuilt = restand(before, run.compiled);
    // 剪带换的是带子，机器与台面都换了容器 —— 这一问答"不许续"。
    expect(rebuilt).not.toBe(before);
    expect(sameIndex(rebuilt, new StandingIndex(compile(log.ofTrack(MAIN_TRACK).slice())), run.compiled)).toBeNull();
    let again = rebuilt;
    for (let b = 0; b < 6; b++) {
      log.append(gen(), MAIN_TRACK);
      const next = perform(run.it, log.ofTrack(MAIN_TRACK));
      const grown = restand(again, next.compiled);
      expect(grown).toBe(again); // 新建那一本之后接着落笔又走续排：认回来的必须是同一本
      again = grown;
      expect(sameIndex(grown, new StandingIndex(compile(log.ofTrack(MAIN_TRACK).slice())), next.compiled)).toBeNull();
    }
  });

  it("载入别人的课：先对账，再当着我们的面接下去讲", () => {
    const seed = new OpLog();
    for (let b = 0; b < 9; b++) seed.append(gen(), MAIN_TRACK);
    const log = new OpLog();
    log.restore(seed.export());
    let run = perform(null, log.ofTrack(MAIN_TRACK));
    let ix = restand(null, run.compiled);
    expect(sameIndex(ix, new StandingIndex(compile(log.ofTrack(MAIN_TRACK).slice())), run.compiled)).toBeNull();
    for (let b = 0; b < 6; b++) {
      log.append(gen(), MAIN_TRACK);
      run = perform(run.it, log.ofTrack(MAIN_TRACK));
      ix = restand(ix, run.compiled);
      expect(sameIndex(ix, new StandingIndex(compile(log.ofTrack(MAIN_TRACK).slice())), run.compiled)).toBeNull();
    }
  });

  it("一条轨道一本索引：插播不许借用主轨那本，也不许弄脏它", () => {
    const log = new OpLog();
    let main: StandingIndex | null = null;
    let aside: StandingIndex | null = null;
    let mainIt: Interpreter | null = null;
    let asideIt: Interpreter | null = null;
    for (let b = 0; b < 8; b++) {
      log.append(gen(), MAIN_TRACK);
      const m = perform(mainIt, log.ofTrack(MAIN_TRACK));
      mainIt = m.it;
      main = restand(main, m.compiled);
      expect(sameIndex(main, new StandingIndex(compile(log.ofTrack(MAIN_TRACK).slice())), m.compiled)).toBeNull();

      log.append(gen(), "aside:1");
      const a = perform(asideIt, log.ofTrack("aside:1"));
      asideIt = a.it;
      aside = restand(aside, a.compiled);
      expect(sameIndex(aside, new StandingIndex(compile(log.ofTrack("aside:1").slice())), a.compiled)).toBeNull();
      // 主轨那本不认插播那张台面 —— 认错了就是把一节课的台上摆上另一节课的东西。
      expect(main.holds(a.compiled)).toBe(false);
      expect(aside.holds(m.compiled)).toBe(false);
    }
  });
});

/* ================================================================== 2 价钱 */

describe("续排的价钱：道具表一次也不许多走，流水只读新接的那一截", () => {
  /*
   * 两本容器各套一层 Proxy，**套一次用到底**：索引认的是引用，每批换一个壳就等于每批换一张台面，那一头
   * 量的全是新建。道具表数的是"整张表走一遍"（`values`/`forEach`/迭代）和"按下标路过一格外观"；流水数
   * 的是"按下标路过一笔"。
   */
  function watchProps(c: Compiled) {
    let cells = 0;
    let sweeps = 0;
    let read = 0;
    const scans = new Set<string | symbol>(["values", "forEach", "entries", "keys", Symbol.iterator]);
    const inner = new Map<string, Prop>();
    for (const [id, p] of c.props) {
      inner.set(
        id,
        new Proxy(p, {
          get(t, k) {
            if (k === "revisions") {
              return new Proxy(t.revisions, {
                get(a, i) {
                  if (typeof i === "string" && /^\d+$/.test(i)) cells++;
                  return (a as never)[i as never];
                },
              });
            }
            return (t as never)[k as never];
          },
        }),
      );
    }
    const props = new Proxy(inner, {
      get(t, k) {
        if (scans.has(k)) sweeps++;
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const touched = new Proxy(c.touched, {
      get(t, k) {
        if (typeof k === "string" && /^\d+$/.test(k)) read++;
        return k === "length" ? t.length : (t as unknown as Record<string | symbol, unknown>)[k];
      },
    }) as unknown as Compiled["touched"];
    const counted: Compiled = { ...c, props, touched };
    return {
      compiled: counted,
      reset: () => {
        cells = 0;
        sweeps = 0;
        read = 0;
      },
      take: () => ({ propCells: cells, propSweeps: sweeps, read }),
    };
  }

  /**
   * 先落 `nBatch` 批，再落**一批固定的**尾巴，数这一笔读了什么。固定的那一批同时踩到四种笔：落空格、
   * 迟到补画（`fill`）、撤下（`close`）、换场 —— 随机尾巴会让"带子长四十倍多读的格子"这一问在空转。
   */
  function priceOf(nBatch: number, seed: number): {
    propCells: number;
    propSweeps: number;
    ledgerRead: number;
    newLedger: number;
    held: boolean;
  } {
    const gen = generator(seed);
    const tape: OpEntry[] = [];
    for (let b = 0; b < nBatch; b++) pushBatch(tape, gen(), b);
    let run = perform(null, tape);
    const watched = watchProps(run.compiled);
    const ix = new StandingIndex(watched.compiled);
    const before = watched.compiled.touched.length;
    pushBatch(tape, [skeleton("尾巴", "丙"), line("收尾那一句", 900), inked("尾巴"), drop("a"), cut("甲"), silent(300)], nBatch);
    // 机器接着走：道具表与流水还是那一对数组，只是各自长了尾巴。
    run = perform(run.it, tape);
    watched.reset();
    const grown = restand(ix, watched.compiled);
    const spent = watched.take();
    // `restand` 认下了就返回**同一本**；换了本说明这些读数全是重建付的，那前面几条量的就不是续排。
    return {
      propCells: spent.propCells,
      propSweeps: spent.propSweeps,
      ledgerRead: spent.read,
      newLedger: watched.compiled.touched.length - before,
      held: grown === ix,
    };
  }

  it("落一批：道具表一次也不走，流水只读新接的那一截", () => {
    const small = priceOf(60, 20261011);
    const big = priceOf(2400, 20261011);
    expect(small.held).toBe(true);
    expect(big.held).toBe(true);
    // 改前每批重建付的是"整张道具表走一遍 + 每一格外观点问一次"。
    expect(small.propSweeps).toBe(0);
    expect(big.propSweeps).toBe(0);
    expect(small.propCells).toBe(0);
    expect(big.propCells).toBe(0);
    // 尾巴那一批只有六笔，落进流水的笔数必须和带子长无关。唯一的例外是 `drop("a")` 那一笔到底收不收
    // 得到东西 —— 那看的是前缀把 `a` 留在什么状态，是**内容**差异不是价钱差异，价钱那一问由下面
    // `ledgerRead` 那一条钉死。
    expect(small.newLedger).toBeGreaterThan(0);
    expect(small.newLedger).toBeLessThanOrEqual(8);
    expect(big.newLedger).toBeLessThanOrEqual(8);
    expect(Math.abs(big.newLedger - small.newLedger)).toBeLessThanOrEqual(1);
    expect(big.ledgerRead).toBeLessThanOrEqual(small.ledgerRead + 6);
    // 读的数量本身就等于新接的那一截：多读一笔都是回头。
    expect(big.ledgerRead).toBe(big.newLedger);
    expect(small.ledgerRead).toBe(small.newLedger);
  });

  it("新建一本付整卷的钱（参照不许被顺手改便宜）", () => {
    const gen = generator(20261012);
    const tape: OpEntry[] = [];
    for (let b = 0; b < 400; b++) pushBatch(tape, gen(), b);
    const run = perform(null, tape);
    const watched = watchProps(run.compiled);
    new StandingIndex(watched.compiled);
    const spent = watched.take();
    // 线性的那一笔仍然要付，只是付在流水上：一笔读两遍（落成与收笔），道具表一次也不走。
    expect(spent.propSweeps).toBe(0);
    expect(spent.propCells).toBe(0);
    expect(spent.read).toBeGreaterThanOrEqual(run.compiled.touched.length);
  });

  it("回头补上的那一笔收笔不许逼着索引回头看整张道具表", () => {
    // 这一条是第 2 节里最容易被"顺手实现"绕过的地方：若 `close` 那一笔靠重扫道具表找被改的格子，
    // 上面那两条仍然可以是绿的（那一带子的尾巴短），但一批 `discard` 就得走一遍整张表。
    // 这里数的是"落一笔 `discard` 之后，流水读了几笔"：它必须只读新接的那一截（那一笔 `close`
    // 和它自己），而不是把整条流水或整张道具表重看一遍。
    const gen = generator(20261013);
    const tape: OpEntry[] = [];
    for (let b = 0; b < 800; b++) pushBatch(tape, gen(), b);
    let run = perform(null, tape);
    const watched = watchProps(run.compiled);
    let ix = new StandingIndex(watched.compiled);
    for (let b = 800; b < 820; b++) {
      pushBatch(tape, [drop("a"), line(`第 ${b} 句`, 500)], b);
      run = perform(run.it, tape);
      const shell = watched.compiled;
      watched.reset();
      ix = restand(ix, shell);
      const spent = watched.take();
      expect(spent.propSweeps).toBe(0);
      expect(spent.propCells).toBe(0);
      // 一批两笔：一笔撤下、一笔旁白。流水上读的不该超过这一批接下的那几笔。
      expect(spent.read).toBeLessThanOrEqual(6);
    }
  });
});

/* ================================================================== 3 回头改的那三处 */

describe("已经进账的那一格换了事实：三处单独钉", () => {
  it("流水里每一笔的时刻不许倒着走（这是游标前提的全部）", () => {
    // `Compiled.touched` 是本件唯一的"回头那一截"的通道，它的全部道理是：**一笔落下的时刻就是解释器
    // 走到那一刻的时钟值**，而那个时钟只往前走。这一句一旦破了（比如以后有人让 `close` 记下格子的
    // `t` 而不是收笔的那一刻），事件流就不再是排好的，续排和新建会给出不同的台 —— 而那种差异只在
    // 某一刻露一次头，形状那一节的对账会抓到它，但这条把它钉在源头。
    const gen = generator(20261014);
    const tape: OpEntry[] = [];
    for (let b = 0; b < 60; b++) pushBatch(tape, gen(), b);
    const c = compile(tape);
    let last = -Infinity;
    let prevT = -Infinity;
    let broken: string | null = null;
    for (const t of c.touched) {
      if (t.kind === "prop") continue;
      if (t.kind === "lay") {
        // 落笔的时刻不许比上一笔落笔早；同刻是允许的（一批里好几笔落在同一拍）。
        if (t.rev.t < prevT) broken = `lay 的时刻倒着走：${t.rev.t} < ${prevT}（${t.prop.id}）`;
        prevT = t.rev.t;
        last = Math.max(last, t.rev.t);
      }
      if (t.kind === "close") {
        // 回头补上的 `off` 是**这一笔落下的那一刻**，所以它不许早于迄今任何一个事件时刻。
        const at = t.rev.off!;
        if (at < last) broken = `close 的时刻 ${at} 落在已吸收的 ${last} 之前（${t.prop.id}）`;
        last = Math.max(last, at);
      }
      if (t.kind === "fill") {
        // 换掉的那一格没有新时刻：它的窗口两端与 `lay` 那一刻同。
        if (t.rev.t !== t.old.t) broken = `fill 换了落笔时刻：${t.old.t} → ${t.rev.t}（${t.prop.id}）`;
      }
    }
    expect(broken).toBeNull();
    expect(c.touched.length).toBeGreaterThan(60);
  });

  it("落了就撤的那一格：同一刻那一对，游标两头都答台上没有它", () => {
    // 建表那一遍按 `end <= t` 整格筛掉；续排时这一格已经进过账、筛不掉了。它不需要撤销 —— 落下与
    // 收走落在同一刻，游标把这一对当成一步走完。这一条钉的是"不许为它加撤销的账"。
    const s = new Stage();
    s.append([art("a"), drop("a"), line("一", 1000)], MAIN_TRACK);
    const ix = restand(null, s.compiled);
    expect(idsOf(ix.visible(0, null))).toEqual([]);
    expect(idsOf(ix.visible(500, null))).toEqual([]);
    expect(idsOf(ix.visible(Infinity, null))).toEqual([]);
    expect(ix.laidIn(0, 1000, 0)).toEqual([]);
    // 倒带回它落下之前，仍然没有它 —— 两头都净零。
    expect(idsOf(ix.visible(Infinity, null))).toEqual([]);
    expect(idsOf(ix.visible(0, null))).toEqual([]);
  });

  it("同刻换板重画：旧板那份名单里不许留下影子（续排也要过这一关）", () => {
    // `standing.test.ts` 钉的是新建一本时的这一条；同一批东西**逐批**落下来也必须同解，因为流水里
    // 上一格的 `close` 排在新格 `lay` 之前。若有人把这两笔倒过来，倒带时 `take` 那句"只有它还代表
    // 这个道具时才收"当场退出，旧板头上留着已经搬走的那一格 —— 切回那块板它就成第二层。
    const batches: Op[][] = [
      [art("a", "甲"), line("一", 1000)],
      [art("a", "乙"), line("二", 1000)],
      [cut("甲"), art("b", "甲"), line("三", 1000)],
    ];
    let it: Interpreter | null = null;
    let ix: StandingIndex | null = null;
    const tape: OpEntry[] = [];
    const seen: Compiled[] = [];
    for (let b = 0; b < batches.length; b++) {
      pushBatch(tape, batches[b], b);
      const run = perform(it, tape);
      it = run.it;
      ix = restand(ix, run.compiled);
      seen.push(run.compiled);
    }
    const last = seen[seen.length - 1];
    const veil = last.cues.find((q) => q.op.kind === "transition")!;
    const at = { flip: veil.t + (veil.end - veil.t) / 2, board: "甲" };
    expect(idsOf(ix!.visible(last.duration, at))).toEqual(["b"]);
    expect(idsOf(ix!.visible(last.duration, at))).toEqual(idsOf(new StandingIndex(compile(tape.slice())).visible(last.duration, at)));
    // 倒带回第一格还在甲板上的那一刻：那一格必须还挂在甲板上。
    expect(idsOf(ix!.visible(500, null))).toEqual(["a"]);
    expect(idsOf(ix!.visible(last.duration, at))).toEqual(["b"]);
  });

  it("迟到的补画落在撤下之后：图没丢，也不许让它复活（逐批落也一样）", () => {
    let it: Interpreter | null = null;
    let ix: StandingIndex | null = null;
    const tape: OpEntry[] = [];
    const batches: Op[][] = [[skeleton("a"), line("一", 1000)], [drop("a"), line("二", 1000)], [inked("a")]];
    let last: Compiled | null = null;
    for (let b = 0; b < batches.length; b++) {
      pushBatch(tape, batches[b], b);
      const run = perform(it, tape);
      it = run.it;
      last = run.compiled;
      ix = restand(ix, last);
    }
    expect(idsOf(ix!.visible(500, null))).toEqual(["a"]);
    for (const t of marks(last!)) {
      if (t < 1000 || !Number.isFinite(t)) continue;
      expect(idsOf(ix!.visible(t, null))).toEqual([]);
    }
    const rev = last!.props.get("a")!.revisions[0];
    expect(rev.svg).toContain("text");
    // 新建一本与续排在这一条上必须一字不差。
    expect(sameIndex(ix!, new StandingIndex(compile(tape.slice())), last!)).toBeNull();
  });

  it("补画顺带换了板：那一格得从旧板的队列里挪走，倒带也不许留下影子", () => {
    // `patch` 写 `scene` 会挪道具，而填占位符是**原地换掉** —— 索引手上的那一格 `rev` 换了对象，
    // 换上去的那一格可能站在另一块板上，而它的落笔时刻在**身后**（还是当初落笔那一刻）。
    // 于是这一处是本件唯一一处要往已经排好的列里**中间插入**的改动。
    let it: Interpreter | null = null;
    let ix: StandingIndex | null = null;
    const tape: OpEntry[] = [];
    const batches: Op[][] = [
      [art("旧甲", "甲"), line("一", 1000)],
      [skeleton("a", "甲"), line("二", 1000)],
      [cut("乙"), art("b", "乙"), line("三", 1000)],
      [inked("a", "乙")], // 迟到的图，而且把它挪去了乙：落笔时刻还是第二批那一刻
    ];
    let last: Compiled | null = null;
    for (let b = 0; b < batches.length; b++) {
      pushBatch(tape, batches[b], b);
      const run = perform(it, tape);
      it = run.it;
      last = run.compiled;
      ix = restand(ix, last);
    }
    const fresh = new StandingIndex(compile(tape.slice()));
    expect(sameIndex(ix!, fresh, last!)).toBeNull();
    const veil = last!.cues.find((q) => q.op.kind === "transition")!;
    const at = { flip: veil.t + (veil.end - veil.t) / 2, board: "乙" };
    // 补画之前的名单和之后的名单都得和现建一本一样 —— 这一句在 `sameIndex` 里已经逐刻比过，这里再
    // 点一次名：换板那一格如果没挪窝，甲板的队列里就留着它，切回甲就看得见一个影子。
    expect(idsOf(ix!.visible(last!.duration, at))).toEqual(idsOf(fresh.visible(last!.duration, at)));
    expect(idsOf(ix!.visible(last!.duration, at))).toContain("a");
    // 而且它站在乙的队列里，不在甲的：把这一刀换到甲去看，`a` 在 `flip` 之前落笔，该被扫走。
    const back = { flip: veil.t + (veil.end - veil.t) / 2, board: "甲" };
    expect(idsOf(ix!.visible(last!.duration, back))).not.toContain("a");
    expect(idsOf(ix!.visible(last!.duration, back))).toEqual(idsOf(fresh.visible(last!.duration, back)));
  });

  it("换板那一格落在刀之后时，旧板的队列必须真的把它交出去（不清旧账就多出一格影子）", () => {
    // `sameIndex` 与上一条钉的是"落笔在刀之前"那一格：那一格留在旧板队列里时，内层那一问的二分会
    // 跳过它（它排在 `flip` 之前），而看旧板那一头又整条跳过旧板的队列 —— 于是"只往新板里接、不从
    // 旧板的队列里摘"这种半吊子改法在它身上是绿的。这里把落笔挪到刀**之后**：旧板队列里那一格的时刻
    // ≥ `flip`，切到新板去看时它会被那条队列扫到，而它握的正是同一个 Stand（`refill` 换的是它手上的
    // 引用，不是换掉这个 Stand），于是那一格在名单里出现两遍。
    const tape: OpEntry[] = [];
    let it: Interpreter | null = null;
    let ix: StandingIndex | null = null;
    const batches: Op[][] = [
      [line("一", 1000)],
      [cut("乙")], // 刀翻脸之后站着的是乙
      [art("后甲", "甲"), skeleton("a", "甲"), line("二", 1000)], // 两格都落在刀之后
      [inked("a", "乙")], // 迟到的图把它挪去乙：落笔时刻还是第二批那一刻
    ];
    let last: Compiled | null = null;
    for (let b = 0; b < batches.length; b++) {
      pushBatch(tape, batches[b], b);
      const run = perform(it, tape);
      it = run.it;
      last = run.compiled;
      ix = restand(ix, last);
    }
    const fresh = new StandingIndex(compile(tape.slice()));
    expect(sameIndex(ix!, fresh, last!)).toBeNull();
    const veil = last!.cues.find((q) => q.op.kind === "transition")!;
    const cut2 = { flip: veil.t + (veil.end - veil.t) / 2, board: "乙" };
    const onB = idsOf(ix!.visible(last!.duration, cut2));
    // 影子那一问只按绝对值说话，不问参照：这一格在名单里只许出现一次。
    expect(onB.filter((x) => x === "a")).toEqual(["a"]);
    expect(onB).toEqual(idsOf(fresh.visible(last!.duration, cut2)));
    const onA = idsOf(ix!.visible(last!.duration, { flip: cut2.flip, board: "甲" }));
    expect(onA.filter((x) => x === "后甲")).toEqual(["后甲"]);
    expect(onA).toEqual(idsOf(fresh.visible(last!.duration, { flip: cut2.flip, board: "甲" })));
  });

  it("同一格里改两回不许把索引绕进去（流水给的是上一笔换上去的那一格）", () => {
    // 连着三笔都在填同一格：第一笔落的是空格（`partial`），第二、第三笔都是"交一样东西但还没交齐"
    // 的补画 —— `partial` 仍然为真，所以两笔都是**原地换掉**，道具表从头到尾只有一格。流水里第二笔的
    // `old` 正是第一笔换上去的那一格：索引手上那一格必须跟着换两回，一次也不许被旧账顶掉。
    // 这里换了两回板（default → 丙 → 甲），中间插入那一头也就踩了两次。
    const tape: OpEntry[] = [];
    let it: Interpreter | null = null;
    let ix: StandingIndex | null = null;
    const batches: Op[][] = [
      [skeleton("a"), line("一", 1000)],
      [line("二", 1000), cut("乙")], // 先有一刀，才量得出"落笔时刻在刀之前"的那些影子
      [bare("a", "丙"), line("三", 1000)], // 只挪了板，图还没来：填同一格
      [inked("a", "甲")], // 图来了，板又换了：还是同一格，第二次原地换掉
    ];
    let last: Compiled | null = null;
    for (let b = 0; b < batches.length; b++) {
      pushBatch(tape, batches[b], b);
      const run = perform(it, tape);
      it = run.it;
      last = run.compiled;
      ix = restand(ix, last);
    }
    expect(sameIndex(ix!, new StandingIndex(compile(tape.slice())), last!)).toBeNull();
    const revs = last!.props.get("a")!.revisions;
    expect(revs).toHaveLength(1); // 两笔都是填同一格，不是新落笔
    const fills = last!.touched.filter((t) => t.kind === "fill");
    expect(fills).toHaveLength(2);
    // 流水里第二笔的 `old` 就是第一笔的 `rev` —— 索引认的是这一串引用，不是下标。
    expect((fills[1] as Extract<Touched, { kind: "fill" }>).old).toBe(
      (fills[0] as Extract<Touched, { kind: "fill" }>).rev,
    );
    expect(idsOf(ix!.visible(last!.duration, null))).toEqual(["a"]);
    // 最后站在甲板上。换场那一刀在 `a` 挪去丙、再挪去甲之前，所以甲板那一头看得到它；丙那一头看
    // 不到 —— 若 `refill` 只换了 `s.rev` 没挪板的队列，甲板就少了它，丙板上就留着一个影子。
    const flip = last!.cues.find((q) => q.op.kind === "transition")!.t;
    expect(idsOf(ix!.visible(last!.duration, { flip, board: "甲" }))).toEqual(["a"]);
    expect(idsOf(ix!.visible(last!.duration, { flip, board: "丙" }))).toEqual([]);
    expect(idsOf(ix!.visible(last!.duration, { flip, board: "乙" }))).toEqual([]);
  });
});

/* ================================================================== 4 护栏 */

describe("护栏：不许改语义，也不许认错了台面", () => {
  it("一次建完和逐批续排，答案一字不差", () => {
    const gen = generator(20261020);
    for (let reel = 0; reel < 20; reel++) {
      const tape: OpEntry[] = [];
      let it: Interpreter | null = null;
      let ix: StandingIndex | null = null;
      let last: Compiled | null = null;
      for (let b = 0; b < 25; b++) {
        pushBatch(tape, gen(), b);
        const run = perform(it, tape);
        it = run.it;
        last = run.compiled;
        ix = restand(ix, last);
      }
      const oneShot = new StandingIndex(compile(tape.slice()));
      expect(sameIndex(ix!, oneShot, last!)).toBeNull();
    }
  });

  it("拷贝一份同样内容不许被认成同一张台面", () => {
    const gen = generator(20261021);
    const tape: OpEntry[] = [];
    for (let b = 0; b < 20; b++) pushBatch(tape, gen(), b);
    const run = perform(null, tape);
    const ix = restand(null, run.compiled);
    const copyProps = new Map(run.compiled.props);
    expect(ix.holds({ ...run.compiled, props: copyProps })).toBe(false);
    const onlyLedger: Compiled = { ...run.compiled, touched: run.compiled.touched.slice() };
    expect(ix.holds(onlyLedger)).toBe(false);
    // 两张都换（真换了一台机器）才算另一张台面。
    const both: Compiled = { ...onlyLedger, props: copyProps };
    expect(ix.holds(both)).toBe(false);
    // 原样仍认 —— 续排读的就是这两张会长大的容器。
    expect(ix.holds(run.compiled)).toBe(true);
  });

  it("流水少记一笔就当场对不上（这条规矩不许靠自觉）", () => {
    // `Touched` 那句"会动台面事实的每一笔都得记"是本件唯一的软肋：机器不记，索引就看不见。
    // 这里不测解释器（它记全了，第 1 节一万次对账钉的就是这个），测的是**这一问有没有牙**：
    // 把一次 `close` 从流水里抹掉，续排的那一本必须答错 —— 抹掉的是真的事实，观众此刻看得见的那一格
    // 本来已经收掉了。对账抓得到它，说明"记全"这件事钉得住。
    const gen = generator(20261022);
    const tape: OpEntry[] = [];
    for (let b = 0; b < 10; b++) pushBatch(tape, gen(), b);
    const run = perform(null, tape);
    const c = run.compiled;
    const idx = c.touched.findIndex((t) => t.kind === "close" && t.rev.off !== undefined && t.rev.off > t.rev.t);
    expect(idx).toBeGreaterThan(-1);
    // 抹掉这一笔：现建一本时它是**读道具表**的（`end <= rev.t` 那一遍），所以两头的差异会露出来。
    const tampered: Touched[] = [...c.touched.slice(0, idx), ...c.touched.slice(idx + 1)];
    const tamperedCompiled: Compiled = { ...c, props: new Map(c.props), touched: tampered };
    const fresh = new StandingIndex(c);
    const grown = new StandingIndex(tamperedCompiled);
    let diff: string | null = null;
    for (const t of marks(c)) {
      const a = answersOf(grown, t, c, true);
      const b = answersOf(fresh, t, c, true);
      if (a !== b) {
        diff = `t=${t}`;
        break;
      }
    }
    expect(diff, "抹掉一记收笔，续排的那一本必须给出不同的台").not.toBeNull();
  });

  /**
   * `Stage` 那一头只能问它**公开**的那几问 —— 这也是这一条该钉的东西：续排的那一本索引给出的台，
   * 必须是导演与画面拿到的那一张台。`getSnapshot().props` 走的是 `standing.visible(t, cutAt(t))`
   * （名单、层叠次序、站着那一格的板名都从它来），`visibleName` 走的是同一句，`boardAt` 走的是那一刀。
   *
   * 签名里带上 `draft`（那一格画没画出来）：只比 id 与板名的话，索引握着旧的那一格也答得对。画面那一头
   * 读的是**机器手上**那一格（`getSnapshot().props` 从索引的 `visible` 拿 `rev`，再按它算 `draft`），
   * 参照那一头读的是现建一本给的 `rev` —— 所以流水少记一笔补画时，索引还握着没图的那一格，两边当场分开。
   */
  function stageMatches(s: Stage, track: string): string | null {
    // `runtime.ts` 里那句 `painted` 是私有的，而这里要问的是同一个问题（那一格画出来没有）。
    // `Stage` 这一头的预览笔触只在有人真的在画时才有，本条不碰它，所以两边都只读带子上那一格。
    const inked = (r: { svg?: string; html?: string; scene3d?: unknown }) =>
      !!(r.svg || r.html || r.scene3d);
    const c = s.compiled;
    const fresh = new StandingIndex(compile(s.log.ofTrack(track).slice()));
    const ix = new TapeIndex(c);
    // `Infinity` 那一问留给索引自己：播放头站在哪一刻会被 `seek` 夹到带子尽头，那不是这一条要问的。
    for (const t of marks(c).filter((x) => Number.isFinite(x))) {
      s.seek(t);
      const cut = ix.cutAt(t);
      const painted = s
        .getSnapshot()
        .props.map((p) => `${p.id}:${p.scene}:${p.draft ? "blank" : "inked"}`)
        .join("|");
      const ref = fresh
        .visible(t, cut)
        .map((x) => `${x.prop.id}:${x.rev.scene}:${inked(x.rev) ? "inked" : "blank"}`)
        .join("|");
      if (painted !== ref) return `t=${t}：画面上的台与现建一本不一样：\n  画面 ${painted}\n  参照 ${ref}`;
      if (s.boardAt(t) !== (cut?.board ?? null)) return `t=${t}：这一刀报的板名和索引不一样`;
      for (const id of new Set([...c.props.keys(), ...["甲", "乙", "丙"]])) {
        const want = fresh.visible(t, cut).some((x) => x.prop.id === id || x.rev.scene === id);
        if (s.visibleName(id, t) !== want) return `t=${t}：「${id}」这一问两边不同答案`;
      }
    }
    return null;
  }

  it("Stage 那一头：逐批落笔 + 剪带 + 插播来回切，仍然对账", () => {
    const gen = generator(20261023);
    const s = new Stage();
    for (let b = 0; b < 14; b++) s.append(gen(), MAIN_TRACK);
    expect(stageMatches(s, MAIN_TRACK)).toBeNull();
    const aside = s.beginAside();
    for (let b = 0; b < 5; b++) s.append(gen(), aside);
    expect(stageMatches(s, aside)).toBeNull();
    s.endAside();
    for (let b = 0; b < 5; b++) s.append(gen(), MAIN_TRACK);
    expect(stageMatches(s, MAIN_TRACK)).toBeNull();
    // 剪断重排：换的是带子，机器与台面都换容器，那一头从零建 —— 建完还得是同一张台。
    s.rerollFrom(s.log.all()[Math.floor(s.log.length / 2)].seq);
    expect(stageMatches(s, MAIN_TRACK)).toBeNull();
    s.append(gen(), MAIN_TRACK);
    expect(stageMatches(s, MAIN_TRACK)).toBeNull();
  });

  it("倒带那一头：续排过的索引倒回三分钟前，和从头走过来同一个答案", () => {
    // A 那一件有游标，B 这一件也有 —— 而且这一本的游标更容易被"回头改的那一格"弄脏：倒带是逐条把
    // 事件退回去，退的就是那一批被补过 `off` 的格子。
    const gen = generator(20261024);
    const tape: OpEntry[] = [];
    let it: Interpreter | null = null;
    let ix: StandingIndex | null = null;
    let last: Compiled | null = null;
    for (let b = 0; b < 24; b++) {
      pushBatch(tape, gen(), b);
      const run = perform(it, tape);
      it = run.it;
      last = run.compiled;
      ix = restand(ix, last);
    }
    const fresh = new StandingIndex(compile(tape.slice()));
    const points = marks(last!);
    const cutList = cutsOf(last!);
    const seen: string[][] = [];
    for (const t of points) seen.push(idsOf(ix!.visible(t, cutList[0] ?? null)));
    for (let i = points.length - 1; i >= 0; i--) {
      expect(idsOf(ix!.visible(points[i], cutList[0] ?? null))).toEqual(seen[i]);
    }
    for (const t of points) expect(idsOf(ix!.visible(t, cutList[0] ?? null))).toEqual(idsOf(fresh.visible(t, cutList[0] ?? null)));
  });
});
