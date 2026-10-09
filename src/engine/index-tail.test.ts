// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { compile, perform, type Interpreter } from "./compile";
import { MAIN_TRACK, OpLog } from "./log";
import { TapeIndex, reindex } from "./frame";
import { Stage } from "./runtime";
import type { Compiled, Cue, Gate, Op, OpEntry } from "./types";

/*
 * 这一节钉的是「带子长了一截，索引也只吸收那一截，而且吸收完答的是同一张台」。
 *
 * 上一件把解释器搬进一台活着的机器，剩下的价钱就明确落在两本索引上 —— `runtime.ts` 每一批
 * `new TapeIndex` / `new StandingIndex` 各一次。量过的（同一台机器、同一份探针、一批 12 格）：
 * 逐批落笔 200 / 400 / 800 / 1600 批，合计 48.2 / 132.5 / 559.6 / 2628.5ms —— 批数翻一倍合计翻四倍，
 * 落一笔付的是整卷的钱，和上一件改前的 `compile` 是同一个形状。本件先做 cue 表那一本：同一批带子
 * 同一台机器改成 19.9 / 64.1 / 256.9 / 1344.1ms，落最后一批 0.309 → 0.135ms、3.360 → 1.906ms。
 *
 * 能不能续，问的还是一句引用，可**认的东西换了**：解释器认那一轨的带子数组，索引认 `Compiled` 里
 * 那两张会长大的容器（`cues` / `gates`）。落一笔 → 同一批容器 → 只吸收新格；剪带、载入、清空 →
 * 换的是整台机器 → 两张表都是新数组 → 从零建一本。
 *
 * 四层钉法：
 *  1. **形状**：随机带子逐批追加，每一批落下之后，续排的索引和"拿这一批为止的台面新建一本"在每一问
 *     上一批刻点对账。参照不许复用机器手上的容器。
 *  2. **价钱**：给 cue 表和卡表各套一层 Proxy（套一次用到底），数**按下标读了几格**。续排时回头读过
 *     的格子必须一个都没有 —— 这一问不依赖毫秒。
 *  3. **开卡表**：它是这本索引上唯一会被**中间**改动的账（他的回答是身后的一刀 `answer`，把一张
 *     已经进账的卡原地改成答过了），所以单独钉：表头答掉了要迈过去、没答的仍然指得到、压实不许
 *     把还开着的挤掉、也不许每批把整张卡表重筛一遍。
 *  4. **护栏**：一次建完的答案不许因为换了读法就变；认容器只认引用；换场那一刀的**原地改写**不许
 *     骗过索引；`Stage` 那一头逐批 + 剪带 + 插播来回切仍然对账。
 */

const box = (x: number) => ({ x, y: 0, w: 200, h: 160 });
const line = (text: string, duration = 800): Op => ({ kind: "narrate", text, duration });
const silent = (duration = 400): Op => ({ kind: "beat", duration });
const placed = (id: string, x: number, scene?: string): Op =>
  ({ kind: "build", id, box: box(x), label: id, html: `<p>${id}</p>`, ...(scene ? { scene } : {}) }) as Op;
const slide = (): Op =>
  ({ kind: "camera", mode: "pan", dir: "right", screens: 0.6, duration: 900, easing: "ease" }) as Op;
const gaze = (target: string): Op =>
  ({ kind: "camera", mode: "focus", target, duration: 900, easing: "ease" }) as Op;
const cut = (to: string): Op => ({ kind: "transition", style: "dissolve", to, duration: 1200 });
const card = (prompt: string): Op => ({ kind: "quiz", prompt, options: ["甲", "乙"], answer: 1 });
const said = (gate: number, text = "乙"): Op => ({ kind: "answer", gate, text });
const hold = (reason: string): Op => ({ kind: "pause-for", reason });
const mark = (id: string, duration = 600): Op => ({ kind: "highlight", target: id, style: "pulse", duration });
const drift = (id: string, duration = 900): Op =>
  ({ kind: "motion", id, mode: "orbit", axis: "both", amp: 12, period: 1600, radius: 40, decay: 0.5, steps: 4, duration }) as Op;

/** 乘同余，`Math.imul` 走 int32 —— 见 `incremental.test.ts` 那条"种子丢精度"的教训。 */
function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

/**
 * 一批的形状 = 一次工具调用排完的那一段。**不许每批收尾于旁白**（`incremental.test.ts` 那条教训：
 * 每批都收在旁白上的生成器，跨批那一段根本没被读到，钉的是一条空街）。这里连"答一句"都随机落在
 * 身后某一批里 —— 开卡表那一本要的就是这种中间改动。
 */
function generator(seed: number) {
  const r = rng(seed);
  const ids = ["a", "b", "c", "d"];
  const boards = ["甲", "乙", "丙"];
  let asked = 0;
  return (): Op[] => {
    const batch: Op[] = [];
    const n = 1 + r(5);
    for (let i = 0; i < n; i++) {
      const id = ids[r(ids.length)];
      switch (r(11)) {
        case 0:
          batch.push(placed(id, r(6000) - 2000, r(3) === 0 ? boards[r(boards.length)] : undefined));
          break;
        case 1:
          batch.push(line("第 " + i + " 句，够长才算一拍", 300 + r(1200)));
          break;
        case 2:
          batch.push(slide());
          break;
        case 3:
          batch.push(gaze(r(2) === 0 ? ids[r(ids.length)] : boards[r(boards.length)]));
          break;
        case 4:
          batch.push(cut(boards[r(boards.length)]));
          break;
        case 5:
          batch.push(card("第 " + asked + " 题？"));
          asked++;
          break;
        case 6:
          batch.push(mark(id, 200 + r(3000)));
          break;
        case 7:
          batch.push(drift(id, 300 + r(4000)));
          break;
        case 8:
          batch.push(silent(200 + r(600)));
          break;
        case 9:
          batch.push(hold("等他把话说完"));
          asked++;
          break;
        default:
          // 答一句：号随机指到前面某张卡。答过的那张再答一次也改不动（解释器那句 `said === null`），
          // 而它把开卡表**中间**那一格换了状态 —— 续排最容易错的就是这里。
          batch.push(said(r(Math.max(1, asked)), "甲"));
      }
    }
    return batch;
  };
}

/** 往**同一卷**带子末尾追加一批：序号与批号按整卷续着编，只许碰新落的那几格。 */
function pushBatch(tape: OpEntry[], ops: Op[], batch: number): void {
  ops.forEach((op) => tape.push({ seq: tape.length, track: MAIN_TRACK, turn: batch, group: batch, op }));
}

/* ------------------------------------------------------------------ 对账的尺子 */

/**
 * 一帧会问带子的那几刀，一次问完压成一段字符串。参照与续排各问一遍，逐字符比。
 * 逐字段列出来而不是比几个摘要数字，因为续排最容易错的地方恰恰是"只有一格跟着带子长"的那几本账
 * （换场的 `flip`、强调的前缀最大值、开卡表的表头）。
 */
function answersOf(ix: TapeIndex, t: number): string {
  const cam = ix.cameraFrame(t);
  return [
    `cam:${cam.settled ? [cam.settled.t, cam.settled.end, cam.settled.op.kind, cam.settled.to.x, cam.settled.to.y, cam.settled.to.w, cam.settled.to.h].join(",") : "-"}`,
    `mov:${cam.moving ? [cam.moving.t, cam.moving.end, cam.moving.from.x, cam.moving.to.w].join(",") : "-"}`,
    `veil:${ix.veilAt(t)?.t ?? "-"}`,
    `beat:${ix.beatAt(t)?.t ?? "-"}`,
    `narr:${ix.narrationAt(t)?.t ?? "-"}`,
    `cut:${JSON.stringify(ix.cutAt(t))}`,
    `prev:${ix.prevSpokenStart(t, 4000)}`,
    `hl:${[...ix.highlightsAt(t).entries()].sort().map(([k, v]) => k + v).join("|")}`,
    `mo:${ix.motionFor("a", t)?.t ?? "-"},${ix.motionFor("b", t)?.t ?? "-"}`,
    `card:${ix.cardAt(t)?.seq ?? "-"}`,
    // 三本只随卡表状态变的账：开卡表是这本索引上唯一会被中间改动的账，续排与新建必须答一样。
    `open:${ix.openGateSeqs().join(",")}`,
    `first:${ix.firstOpenGate()?.seq ?? "-"}`,
  ].join(";");
}

/**
 * 刻点：每一格的两端，加上**相邻两端之间**那一处，再加上每一刀换场的 `flip`。只问边缘量不到
 * "还在跑"的那一小截，而换场那半条恰好只在 `flip` 那一刻翻脸（`standing.test.ts` 同一句教训）。
 */
function marks(c: Compiled): number[] {
  const at = new Set<number>([0, c.duration]);
  for (const q of c.cues) {
    at.add(q.t);
    at.add(q.end);
    if (q.op.kind === "transition") at.add(q.t + (q.end - q.t) / 2);
  }
  for (const g of c.gates) {
    at.add(g.t);
    at.add(g.until);
  }
  const sorted = [...at].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    out.push(sorted[i]);
    if (i + 1 < sorted.length) out.push(sorted[i] + (sorted[i + 1] - sorted[i]) / 2);
  }
  return out;
}

/** 两条路必须答一样；先说清差在哪一刻哪一问，否则红起来只是一大坨字符串。 */
function sameIndex(grown: TapeIndex, fresh: TapeIndex, c: Compiled): string | null {
  for (const t of marks(c)) {
    const a = answersOf(grown, t);
    const b = answersOf(fresh, t);
    if (a !== b) return `t=${t}：续排 ${a} ⟂ 新建 ${b}`;
  }
  return null;
}

/* ================================================================== 1 形状 */

describe("索引续排：吸收新落的那一截，和新建一本答的是同一张台", () => {
  const next = generator(20261020);

  /** 逐批追加的索引 vs 每批新建一本。返回对过的刻点数，供"不许空转"那句用。 */
  function reconcile(nTapes: number, nBatches: number): { checked: number; bad: string[] } {
    let checked = 0;
    const bad: string[] = [];
    for (let k = 0; k < nTapes; k++) {
      let it: Interpreter | null = null;
      let ix: TapeIndex | null = null;
      const tape: OpEntry[] = [];
      for (let b = 0; b < nBatches; b++) {
        pushBatch(tape, next(), b);
        const run = perform(it, tape);
        it = run.it;
        ix = reindex(ix, run.compiled);
        // 参照：拿这一批为止的带子从头再排一遍、再新建一本索引。容器不许复用。
        const whole = compile(tape.slice());
        const diff = sameIndex(ix, new TapeIndex(whole), run.compiled);
        if (diff) bad.push(`tape ${k} batch ${b}: ${diff}`);
        checked += marks(run.compiled).length;
      }
    }
    return { checked, bad };
  }

  it("一百卷随机带子、每卷三十批：逐批对账每一问都不许有差异", () => {
    const { checked, bad } = reconcile(100, 30);
    expect(bad.slice(0, 2)).toEqual([]);
    expect(checked).toBeGreaterThan(100_000);
  });

  it("这批带子真的踩到了每一本窄表（不然上面那条在空转）", () => {
    const kinds = new Set<string>();
    let cards = 0;
    let answers = 0;
    for (let i = 0; i < 4000; i++) {
      for (const op of next()) {
        kinds.add(op.kind);
        if (op.kind === "quiz" || op.kind === "pause-for") cards++;
        if (op.kind === "answer") answers++;
      }
    }
    for (const k of ["narrate", "beat", "camera", "transition", "highlight", "motion", "quiz", "answer", "pause-for", "build"]) {
      expect(kinds.has(k), k).toBe(true);
    }
    // 开卡表那一本只在有卡又有答的时候才走得到，两个计数器都得说话。
    expect(cards).toBeGreaterThan(500);
    expect(answers).toBeGreaterThan(300);
  });

  it("换台面那一头从零建：剪带之后仍然对账，接着落笔又改成续排", () => {
    const log = new OpLog();
    let it: Interpreter | null = null;
    let ix = new TapeIndex(compile([]));
    for (let b = 0; b < 14; b++) {
      log.append(next(), MAIN_TRACK);
      const run = perform(it, log.ofTrack(MAIN_TRACK));
      it = run.it;
      ix = reindex(ix, run.compiled);
    }
    const kept = ix;
    log.cutFrom(log.all()[9].seq);
    const cut = perform(it, log.ofTrack(MAIN_TRACK));
    // 剪带换的是整台机器：两张容器都是新数组，索引必须认出来。
    expect(kept.holds(cut.compiled)).toBe(false);
    let rebuilt = reindex(kept, cut.compiled);
    expect(rebuilt).not.toBe(kept);
    let run = cut;
    for (let b = 0; b < 6; b++) {
      log.append(next(), MAIN_TRACK);
      run = perform(run.it, log.ofTrack(MAIN_TRACK));
      const before = rebuilt;
      rebuilt = reindex(rebuilt, run.compiled);
      // 新建那一本之后接着落笔又走续排：认回来的必须是同一本，不是每一批再建一本。
      expect(rebuilt).toBe(before);
      expect(sameIndex(rebuilt, new TapeIndex(compile(log.ofTrack(MAIN_TRACK).slice())), run.compiled)).toBeNull();
    }
    ix = rebuilt;
  });

  it("载入别人的课：先对账，再当着我们的面接下去讲", () => {
    const seed = new OpLog();
    for (let b = 0; b < 9; b++) seed.append(next(), MAIN_TRACK);
    const log = new OpLog();
    log.restore(seed.export());
    let run = perform(null, log.ofTrack(MAIN_TRACK));
    let ix = reindex(null, run.compiled);
    expect(sameIndex(ix, new TapeIndex(compile(log.ofTrack(MAIN_TRACK).slice())), run.compiled)).toBeNull();
    for (let b = 0; b < 5; b++) {
      log.append(next(), MAIN_TRACK);
      run = perform(run.it, log.ofTrack(MAIN_TRACK));
      ix = reindex(ix, run.compiled);
      expect(sameIndex(ix, new TapeIndex(compile(log.ofTrack(MAIN_TRACK).slice())), run.compiled)).toBeNull();
    }
  });

  it("一条轨道一本索引：插播不许借用主轨那本，也不许弄脏它", () => {
    const log = new OpLog();
    let main: TapeIndex | null = null;
    let aside: TapeIndex | null = null;
    let mainIt: Interpreter | null = null;
    let asideIt: Interpreter | null = null;
    for (let b = 0; b < 8; b++) {
      log.append(next(), MAIN_TRACK);
      const m = perform(mainIt, log.ofTrack(MAIN_TRACK));
      mainIt = m.it;
      main = reindex(main, m.compiled);
      expect(sameIndex(main, new TapeIndex(compile(log.ofTrack(MAIN_TRACK).slice())), m.compiled)).toBeNull();

      log.append(next(), "aside:1");
      const a = perform(asideIt, log.ofTrack("aside:1"));
      asideIt = a.it;
      aside = reindex(aside, a.compiled);
      expect(sameIndex(aside, new TapeIndex(compile(log.ofTrack("aside:1").slice())), a.compiled)).toBeNull();
      // 主轨那本不认插播那张台面 —— 认错了就是把一节课的窄表按在另一节课身上。
      expect(main.holds(a.compiled)).toBe(false);
      expect(aside.holds(m.compiled)).toBe(false);
    }
  });
});

/* ================================================================== 2 价钱 */

describe("续排的价钱：新落的那一截之外，一格都不许回头读", () => {
  /*
   * 数的是**按下标路过几格**，不是毫秒 —— 共享 CI 的噪声比省下来的那些毫秒大，这句话仓库写过四次。
   *
   * Proxy 必须**套一次用到底**：索引认容器认的是引用，每批换一个 Proxy 就等于每批换一张台面，
   * 那一头量的全是新建。`cues` / `gates` 都是机器手上那一个会长大的数组，所以一份 Proxy 能跟到底。
   */
  function counter<T>(arr: T[]) {
    const reads = new Map<number, number>();
    const view = new Proxy(arr, {
      get(t, k) {
        if (typeof k === "string" && /^\d+$/.test(k)) {
          const i = Number(k);
          reads.set(i, (reads.get(i) ?? 0) + 1);
        }
        return k === "length" ? t.length : (t as unknown as Record<string, unknown>)[k as string];
      },
    }) as unknown as T[];
    return { view, reset: () => reads.clear(), at: (i: number) => reads.get(i) ?? 0 };
  }

  /** 把一张台面换成"被数着的那两份容器"，内容一个字节都不许变。 */
  function counted(c: Compiled, cues: Cue[], gates: Gate[]): Compiled {
    return { ...c, cues, gates };
  }

  /**
   * 先落 `nBatch` 批，再落**一批固定的**尾巴，数这一笔在两张容器上读了几格。
   * `backwards` = 回头读过的**旧格子**数；`gateBack` 同问卡表（开卡表那一头最容易每批重筛一遍）。
   *
   * 最后一批固定而不是随机：这一问要的是"新落的那一截读几格"随不随带子长，那得先保证两头的
   * 尾巴**落的是同一批东西** —— 随机生成器下带子长四十倍那一头可能一个新卡都不落，量到的 0 是
   * 空转不是价钱。固定的这一批同时踩到旁白、卡、叠层、运动四本窄表。
   */
  function priceOf(nBatch: number, seed: number): {
    backwards: number;
    forward: number;
    gateBack: number;
    gateForward: number;
    newCues: number;
    newGates: number;
  } {
    const gen = generator(seed);
    const tape: OpEntry[] = [];
    for (let b = 0; b < nBatch; b++) pushBatch(tape, gen(), b);
    let run = perform(null, tape);
    const cueCount = run.compiled.cues.length;
    const gateCount = run.compiled.gates.length;
    const cc = counter(run.compiled.cues as Cue[]);
    const gc = counter(run.compiled.gates as Gate[]);
    let ix = new TapeIndex(counted(run.compiled, cc.view, gc.view));
    pushBatch(tape, [line("收尾那一句", 900), card("最后一题？"), mark("a", 500), drift("a", 700), silent(300)], nBatch);
    run = perform(run.it, tape);
    cc.reset();
    gc.reset();
    ix = reindex(ix, counted(run.compiled, cc.view, gc.view));
    expect(ix.holds(counted(run.compiled, cc.view, gc.view))).toBe(true); // 量的确实是续排，不是新建
    // 数的是**读过几格**，不是"按下标读了几回" —— 一格 cue 进各条窄表时只读一次，一格 gate 读
    // `t` 与 `said` 两回，比回数是噪声。
    let backwards = 0;
    for (let i = 0; i < cueCount; i++) if (cc.at(i) > 0) backwards++;
    let forward = 0;
    for (let i = cueCount; i < run.compiled.cues.length; i++) if (cc.at(i) > 0) forward++;
    let gateBack = 0;
    for (let i = 0; i < gateCount; i++) if (gc.at(i) > 0) gateBack++;
    let gateForward = 0;
    for (let i = gateCount; i < run.compiled.gates.length; i++) if (gc.at(i) > 0) gateForward++;
    return {
      backwards,
      forward,
      gateBack,
      gateForward,
      newCues: run.compiled.cues.length - cueCount,
      newGates: run.compiled.gates.length - gateCount,
    };
  }

  it("落一批：两张容器上回头读过的格子 = 0，往前只读新落的那一截", () => {
    const small = priceOf(60, 20261021);
    const big = priceOf(2400, 20261021);
    expect(small.backwards).toBe(0);
    expect(big.backwards).toBe(0);
    expect(small.gateBack).toBe(0);
    expect(big.gateBack).toBe(0);
    // 这一批落了什么格子是带子说了算（叠层可能被撤掉的道具挡掉），但**至多**读新落的那几格 ——
    // 带子长四十倍，多出来的那一格都不许有。
    expect(small.forward).toBeLessThanOrEqual(small.newCues);
    expect(big.forward).toBeLessThanOrEqual(big.newCues);
    expect(small.gateForward).toBeLessThanOrEqual(small.newGates);
    expect(big.gateForward).toBeLessThanOrEqual(big.newGates);
    // 而且两头的尾巴都确实有东西要吸收，否则上面几行是在空转。
    expect(small.newCues).toBeGreaterThan(0);
    expect(big.newCues).toBeGreaterThan(0);
    expect(small.forward).toBeGreaterThan(0);
    expect(big.forward).toBeGreaterThan(0);
    expect(small.gateForward).toBeGreaterThan(0);
    expect(big.gateForward).toBeGreaterThan(0);
    // 新落的那一截随带子长吗？这里是同一批尾巴，所以两头的格子数必须一样。
    expect(big.newCues).toBe(small.newCues);
    expect(big.newGates).toBe(small.newGates);
  });

  /** Proxy 的 `get` 里那句 `t.length` 不算下标读，所以这里只数 `at(i)`。列出**读了哪几格**。 */
  function readCells(c: { at: (i: number) => number }, n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (c.at(i) > 0) out.push(i);
    return out;
  }

  it("答掉表头那两张：吸收那一截一格旧卡都不许碰，问的时候只为作废的那两格付钱", () => {
    /*
     * 一节问了 120 张卡、**一张都没答**的课。改前那一头每批把整张卡表重筛一遍，落一笔付的是
     * "这堂课一共有过几张卡"；全答完的那种带子量不到这一条 —— 那里建表时 `openAt` 本来就一张
     * 都不接，之后每一问都是空表，怎么改都便宜。
     *
     * 答的那两刀落在**表头**：惰性作废迈过去的正是前面那一截，答在中间的话游标停在第一张开着
     * 的卡上，根本走不到被答的那一张，量的还是一条空街。
     */
    const nCard = 120;
    const tape: OpEntry[] = [];
    let run = perform(null, tape);
    for (let i = 0; i < nCard; i++) {
      pushBatch(tape, [card(`第 ${i} 题？`), line(`说一句 ${i}`)], i * 2);
      run = perform(run.it, tape);
    }
    const gates = run.compiled.gates;
    expect(gates).toHaveLength(nCard);
    const gc = counter(gates);
    const cc = counter(run.compiled.cues);
    let ix: TapeIndex = new TapeIndex(counted(run.compiled, cc.view, gc.view));
    expect(ix.openGateSeqs()).toHaveLength(nCard); // 先走一遍，把建表的计数冲掉
    gc.reset();
    cc.reset();

    // 答掉头两张 —— 这一笔在卡表上不新增格子，只改已有两格的状态。
    pushBatch(tape, [said(gates[0].seq), said(gates[1].seq)], nCard * 2);
    run = perform(run.it, tape);
    ix = reindex(ix, counted(run.compiled, cc.view, gc.view));
    // 续排那一趟对旧卡表一次下标读都没有：它只看新落的那几格，而这一批新落的是零格卡。
    expect(readCells(gc, nCard)).toEqual([]);

    const open = ix.openGateSeqs();
    expect(open).toEqual(gates.slice(2).map((g) => g.seq));
    // 问的那一头读过的是"作废的两格 + 全表那一问本来的价钱（还开着的每一格）"。
    // 表头那一截被迈过去的那两格，就是作废的那两格 —— 不是"一共有过几张卡"那一笔税。
    expect(readCells(gc, nCard)).toEqual(gates.map((_, i) => i));
    gc.reset();
    expect(ix.firstOpenGate()?.seq).toBe(gates[2].seq);
    // 迈过去的那些永不回头问第二次：这一问只读了表头那一格。
    expect(readCells(gc, nCard)).toEqual([2]);

    // 再答一张：吸收那一趟仍然零格；问一次只多迈一格。
    gc.reset();
    pushBatch(tape, [said(gates[2].seq)], nCard * 2 + 1);
    run = perform(run.it, tape);
    ix = reindex(ix, counted(run.compiled, cc.view, gc.view));
    expect(readCells(gc, nCard)).toEqual([]);
    expect(ix.firstOpenGate()?.seq).toBe(gates[3].seq);
    expect(readCells(gc, nCard)).toEqual([2, 3]);
  });

  it("从零建一本时答过的不进开卡表：第一问只读还开着的那几格", () => {
    /*
     * 建表那一遍筛的是 `said === null`。续排那一头这一筛看着像多余的（新落的每张当时都没答），
     * 所以它最容易在下一次改写时被顺手删掉 —— 而 `load()` 那一头（一卷已经答过大半的课）当场把
     * 价钱付回来：第一问从表头走到表尾。这一条钉的就是那一筛。
     */
    const n = 200;
    const tape: OpEntry[] = [];
    let run = perform(null, tape);
    for (let i = 0; i < n; i++) {
      pushBatch(tape, [card(`第 ${i} 题？`), line(`说一句 ${i}`)], i * 2);
      run = perform(run.it, tape);
    }
    const gates = run.compiled.gates;
    for (let a = 1; a <= 150; a++) {
      pushBatch(tape, [said(gates[a].seq)], n * 2 + a);
      run = perform(run.it, tape);
    }
    const gc = counter(gates);
    const cc = counter(run.compiled.cues);
    const ix = new TapeIndex(counted(run.compiled, cc.view, gc.view));
    const open = gates.filter((g) => g.said === null).length;
    expect(open).toBe(50); // 0 号那一张一直没人答，151 号往后那 49 张也没人答
    gc.reset();
    expect(ix.openGateSeqs()).toHaveLength(open);
    expect(readCells(gc, n).length, "从零建完之后的第一问").toBe(open);
  });

  it("答在中间的那些不许在开卡表里堆成长尾：一次全表那一问至多走两倍于还开着的", () => {
    /*
     * `head` 只迈得过头那一截，所以**答在中间**的那些会留在表里，每一问都要多走一步。压实那条规矩
     * （筛剩不到一半才换表）治的就是这一截：不换表，一节问了 200 张、每轮答掉中间一张的课，每一问
     * 都要从表头走到表尾，价钱又变回"这堂课一共有过几张卡"。
     *
     * 数的是**一次全表那一问在卡表上路过几格**，表头不答所以它等于当时那张表有多长。规矩是"筛剩
     * 不到一半才换表"，所以这一问的格子数至多两倍于还开着的（那 `+2` 是本批答掉的这一张，加上
     * "答掉之后才问"这一步 —— `open` 数的是这一问之后）。
     */
    const n = 200;
    const tape: OpEntry[] = [];
    let run = perform(null, tape);
    for (let i = 0; i < n; i++) {
      pushBatch(tape, [card(`第 ${i} 题？`), line(`说一句 ${i}`)], i * 2);
      run = perform(run.it, tape);
    }
    const gates = run.compiled.gates;
    const gc = counter(gates);
    const cc = counter(run.compiled.cues);
    let ix: TapeIndex = new TapeIndex(counted(run.compiled, cc.view, gc.view));
    // 表头那一张（0 号）一直不答：`head` 于是永远停在 0，每一问从表头走到底，量的就是表的长度。
    for (let a = 1; a <= 150; a++) {
      pushBatch(tape, [said(gates[a].seq)], n * 2 + a);
      run = perform(run.it, tape);
      ix = reindex(ix, counted(run.compiled, cc.view, gc.view));
      const open = gates.filter((g) => g.said === null).length;
      gc.reset();
      expect(ix.openGateSeqs()).toHaveLength(open);
      const walked = readCells(gc, n).length;
      expect(walked, `答掉 ${a} 张之后还剩 ${open} 张开着，这一问走了 ${walked} 格`).toBeLessThanOrEqual(open * 2 + 2);
    }
    // 上面那一串要在表真的被换过时才说话：这里只剩 50 张开着，表要是没换过它还是 200 格长。
    expect(readCells(gc, n).length).toBeLessThan(n / 2);
  });

  it("答在表尾那一张：不许惊动表头，也不许因此把整张卡表重看一遍", () => {
    const nCard = 60;
    const tape: OpEntry[] = [];
    let run = perform(null, tape);
    for (let i = 0; i < nCard; i++) {
      pushBatch(tape, [card(`第 ${i} 题？`), line(`说一句 ${i}`)], i * 2);
      run = perform(run.it, tape);
    }
    const gates = run.compiled.gates;
    const gc = counter(gates);
    const cc = counter(run.compiled.cues);
    let ix: TapeIndex = new TapeIndex(counted(run.compiled, cc.view, gc.view));
    gc.reset();
    cc.reset();
    pushBatch(tape, [said(gates[nCard - 1].seq), line("收一句", 400)], nCard * 2);
    run = perform(run.it, tape);
    ix = reindex(ix, counted(run.compiled, cc.view, gc.view));
    expect(readCells(gc, nCard)).toEqual([]);
    expect(ix.firstOpenGate()?.seq).toBe(gates[0].seq);
    // 表头那张还开着，所以身后那一张答没答根本不该被问到。
    expect(gc.at(nCard - 1)).toBe(0);
    expect(ix.openGateSeqs()).toHaveLength(nCard - 1);
  });

  it("新建一本仍然付整卷的钱（参照不许被顺手改便宜）", () => {
    const tape: OpEntry[] = [];
    const gen = generator(20261022);
    for (let b = 0; b < 400; b++) pushBatch(tape, gen(), b);
    const run = perform(null, tape);
    const cc = counter(run.compiled.cues as Cue[]);
    const gc = counter(run.compiled.gates as Gate[]);
    new TapeIndex(counted(run.compiled, cc.view, gc.view));
    let untouched = 0;
    for (let i = 0; i < run.compiled.cues.length; i++) if (cc.at(i) === 0) untouched++;
    expect(untouched).toBe(0); // 每一格都被读了 —— 那正是续排替我们省掉的那笔
  });
});

/* ================================================================== 3 开卡表 */

describe("开卡表：唯一会被中间改的那一本", () => {
  /** 逐批落笔的台面 + 续排的索引。 */
  function live(batches: Op[][]): { ix: TapeIndex; c: Compiled } {
    const tape: OpEntry[] = [];
    let run = perform(null, tape);
    let ix: TapeIndex | null = null;
    batches.forEach((batch, b) => {
      pushBatch(tape, batch, b);
      run = perform(run.it, tape);
      ix = reindex(ix, run.compiled);
    });
    return { ix: ix!, c: run.compiled };
  }

  it("答掉表头那两张：下一问指到的必须是第三张，不是它们自己", () => {
    // 三张卡、答掉头两张，答的那两刀都落在身后那一批里 —— 建表那一眼看不见，续排之后它们换了状态。
    // 号按整卷的格子数编（pushBatch），前两批各两格所以卡是 0 与 2，第三批四格里第三张卡在 6。
    const { ix, c } = live([
      [card("第一题？"), line("说一句")],
      [card("第二题？"), line("说二句")],
      [said(0), said(2), card("第三题？"), line("说三句")],
    ]);
    expect(c.gates.map((g) => g.seq)).toEqual([0, 2, 6]);
    expect(ix.openGateSeqs()).toEqual([6]);
    expect(ix.firstOpenGate()?.seq).toBe(6);
    // 站在带子尽头问 `cardAt`：还开着的那张才说话。
    expect(ix.cardAt(c.duration)?.seq).toBe(6);
  });

  it("全答完了就没有答案：表头迈到头不许留下一个鬼", () => {
    const { ix, c } = live([[card("第一题？"), line("说一句")], [said(0)]]);
    expect(ix.openGateSeqs()).toEqual([]);
    expect(ix.firstOpenGate()).toBeNull();
    // 答完之后 `cardAt` 仍可答"那张卡还站着"（它的窗口是问它的那一拍），只是不再算"没答"。
    expect(ix.cardAt(c.gates[0].until - 1)?.seq).toBe(c.gates[0].seq);
    const g = c.gates[0];
    expect(g.said).not.toBeNull();
  });

  it("压实不许把还开着的挤掉：一批一张卡、每张都答，最后再问一次全表", () => {
    const batches: Op[][] = [];
    // 一轮三格（卡、旁白、答），所以第 i 张卡的号是 3i。
    for (let i = 0; i < 40; i++) {
      batches.push([card(`第 ${i} 题？`), line(`说一句 ${i}`)]);
      batches.push([said(3 * i)]);
    }
    const { ix, c } = live(batches);
    expect(c.gates.every((g) => g.said !== null)).toBe(true); // 上面那个号要是数错了，红的是这里
    expect(ix.openGateSeqs()).toEqual([]);
    // 挤掉作废的那些之后再来一张：它必须立刻是表头，而不是"表已经空了所以没有答案"。
    const last = live([...batches, [card("最后一题？"), line("收一句")]]);
    const gates = last.c.gates;
    // 除了刚落的这一张，前面那些必须都答过了 —— 号要是数错了，这一问先红。
    expect(gates.slice(0, -1).every((g) => g.said !== null)).toBe(true);
    expect(last.ix.openGateSeqs()).toEqual([gates[gates.length - 1].seq]);
    expect(last.ix.firstOpenGate()?.kind).toBe("quiz");
  });

  it("和整张卡表重筛一遍同解：随便哪一批落下之后，两本开卡账一模一样", () => {
    const gen = generator(20261023);
    const tape: OpEntry[] = [];
    let run = perform(null, tape);
    let ix: TapeIndex | null = null;
    let compared = 0;
    for (let b = 0; b < 80; b++) {
      pushBatch(tape, gen(), b);
      run = perform(run.it, tape);
      ix = reindex(ix, run.compiled);
      // 参照：把整张卡表重筛一遍 —— 那就是改前每一批付的那笔钱。
      const open = run.compiled.gates.filter((g: Gate) => g.said === null).map((g: Gate) => g.seq);
      expect(ix!.openGateSeqs()).toEqual(open);
      expect(ix!.firstOpenGate()?.seq ?? null).toBe(open.length ? open[0] : null);
      compared += open.length;
    }
    expect(compared).toBeGreaterThan(10);
  });

  it("还没问出来的那一张不许被提前答出来：开卡表的下标是**已经走过的**", () => {
    /*
     * `cardAt` 里那一刀写的是 `openAt[h] < reached`（不是 `<=`）：`openAt` 存的是卡表下标，`reached`
     * 是"这一刻之前走过了几张"，相等的那一张正是**这一刻还没问到**的那一张 —— 把它答出来，时钟就会
     * 在导演还没问的时候替他停下来等回答。续排之后表头可能正是这张新接进去的卡，所以这一条也在续排
     * 最容易错的那一格里。
     */
    const { ix, c } = live([
      [card("第一题？"), line("说一句", 1000)],
      [said(0)],
      [line("中间这一句长", 4000)],
      [card("第二题？"), line("说二句", 1000)],
    ]);
    expect(c.gates.map((g) => g.seq)).toEqual([0, 4]);
    expect(c.gates[1].t).toBeGreaterThan(3000);
    // 站在第二张卡之前：那张题还没被问出来，此刻台上没有卡。
    expect(ix.cardAt(3000)).toBeNull();
    expect(ix.openGateSeqs()).toEqual([c.gates[1].seq]); // 全表那一问可它答的是"下一张"，不是"此刻"
    expect(ix.cardAt(c.gates[1].t)?.seq).toBe(c.gates[1].seq);
  });

  it("表头那张没答、身后的一串答光了：`cardAt` 不许把开着的让给一张答过的", () => {
    // 时钟停在哪张卡上是**拦停**那一问的依据（`currentGate` 拿 `said === null` 兜住，可那一兜是
    // 第二处说法）。这里把表头做成"还开着"，把它身后那一串全答掉，再问一刻站着的卡。
    const { ix, c } = live([
      [card("先问的这张没人答"), line("说一句")],
      [card("第二题？"), line("说二句")],
      [said(2)],
      [card("第三题？"), line("说三句")],
      [said(5)],
    ]);
    expect(c.gates.map((g) => g.seq)).toEqual([0, 2, 5]);
    const open = c.gates.filter((g: Gate) => g.said === null).map((g: Gate) => g.seq);
    expect(open).toEqual([0]);
    expect(ix.cardAt(c.duration)?.seq).toBe(0);
    expect(ix.openGateSeqs()).toEqual(open);
  });
});

/* ================================================================== 4 护栏 */

describe("护栏：这一件不许修过头", () => {
  it("一次建完的答案和逐批续排一模一样（所有旧测试走的那条路）", () => {
    const ops: Op[] = [
      placed("a", 100),
      line("开场", 1000),
      slide(),
      mark("a", 500),
      drift("a", 800),
      cut("乙"),
      gaze("乙"),
      card("几？"),
      line("第二句", 900),
      silent(300),
    ];
    const one = compile(ops.map((op, seq) => ({ seq, track: MAIN_TRACK, turn: 0, op })) as OpEntry[]);
    const fromOne = new TapeIndex(one);
    const tape: OpEntry[] = [];
    let run = perform(null, tape);
    let ix: TapeIndex | null = null;
    ops.forEach((op, i) => {
      pushBatch(tape, [op], i);
      run = perform(run.it, tape);
      ix = reindex(ix, run.compiled);
    });
    const c = run.compiled;
    for (const t of marks(c)) expect(answersOf(ix!, t)).toBe(answersOf(fromOne, t));
  });

  it("认容器只认引用：内容相同、换了数组就从零建", () => {
    const tape: OpEntry[] = [];
    const gen = generator(20261024);
    for (let b = 0; b < 5; b++) pushBatch(tape, gen(), b);
    const run = perform(null, tape);
    const ix = new TapeIndex(run.compiled);
    // 抄一份同内容的台面：引用换了，那一头必须不肯续。
    const copy: Compiled = { ...run.compiled, cues: run.compiled.cues.slice(), gates: run.compiled.gates.slice() };
    expect(ix.holds(copy)).toBe(false);
    const again = reindex(ix, copy);
    expect(again).not.toBe(ix);
    for (const t of marks(copy)) expect(answersOf(again, t)).toBe(answersOf(ix, t));
    // 同一批容器再问一次：认，而且一个新格子都不许多演。
    expect(ix.holds(run.compiled)).toBe(true);
    expect(reindex(ix, run.compiled)).toBe(ix);
    // 只换卡表、不换 cue 表：那一头开卡表与 `gateT` 的下标全作废，必须也从零建。只认 cue 表那一半
    // 的写法在这里红 —— 它会把上一张台面的开卡表按到新的卡表上，而那是"哪张卡还没答"的账。
    const onlyGates: Compiled = { ...run.compiled, gates: run.compiled.gates.slice() };
    expect(ix.holds(onlyGates)).toBe(false);
    expect(reindex(ix, onlyGates)).not.toBe(ix);
    const onlyCues: Compiled = { ...run.compiled, cues: run.compiled.cues.slice() };
    expect(ix.holds(onlyCues)).toBe(false);
  });

  it("换场那一刀的原地改写不许骗过索引：`flip` 与落点跟着真正落地的那一份", () => {
    /*
     * `transition` 先落一条"站着不动"的 cue，再把落点**写进同一条**（`compile.ts` 里那两句
     * `cue.to = to`）。索引读的是 `t`/`end` 与对象引用，所以这一条钉的是"续排读到的一向是改完的
     * 那一份"。这条规矩要是哪天挪到"边走边记"，红的是这里。
     */
    const tape: OpEntry[] = [];
    let run = perform(null, tape);
    let ix: TapeIndex | null = null;
    const batches: Op[][] = [[placed("a", 100), line("说一句", 900)], [cut("甲"), line("说二句", 900)]];
    batches.forEach((batch, b) => {
      pushBatch(tape, batch, b);
      run = perform(run.it, tape);
      ix = reindex(ix, run.compiled);
    });
    const c = run.compiled;
    const fresh = new TapeIndex(compile(tape.slice()));
    const veil = c.cues.find((q: Cue) => q.op.kind === "transition")!;
    const flip = veil.t + (veil.end - veil.t) / 2;
    expect(ix!.cutAt(flip)).toEqual(fresh.cutAt(flip));
    expect(ix!.cutAt(flip)!.board).toBe("甲");
    // 落点不是"站着不动"那一份：`from` 与 `to` 必须不同，否则这一条钉的是空街。
    expect(veil.to).not.toEqual(veil.from);
    // 幕布还盖着的那一刻，画框由"正在滑的这一刀"答，插值的目标就是改写后的那一份 `to`。
    const glide = ix!.cameraFrame(flip + 10);
    expect(glide.moving).toBe(veil);
    expect(glide.moving!.to).toEqual(veil.to);
    expect(ix!.cameraFrame(veil.end + 10).settled!.to).toEqual(veil.to);
    expect(sameIndex(ix!, fresh, c)).toBeNull();
  });

  it("台上那口钟：Stage 手上那本索引和现建一本答的是同一句", () => {
    /*
     * 这一条比的是**索引答的那几问**（开卡表、表头、时钟站着的那一张卡），不是整份快照：快照里
     * "一条镜头都还没走完"的那些刻，画框走的是 `cameraAt` 的 `this.rect` 兜底 —— 那本来就跟着这台
     * 机器上一次渲染停在哪儿（直播逐批落笔的 Stage 与一次 `load()` 的 Stage 渲染次数不同），和
     * "索引续不续排"无关。把两件事钉进一条测试，红起来分不清是谁。`incremental.test.ts` 那条
     * "台上那口钟"钉的是 `Compiled` 的内容对账，本件钉的是索引的读法对账 —— 同一个 Stage、同一卷
     * 带子，两问各归各。
     */
    const gen = generator(20261025);
    for (let k = 0; k < 12; k++) {
      const s = new Stage();
      let compared = 0;
      const against = () => {
        // 参照：拿这一轨当下那卷带子从头排一遍、现建一本。`compile` 自己建新容器，不复用机器手上的。
        const fresh = new TapeIndex(compile(s.log.ofTrack(s.track)));
        expect(s.openGateSeqs(), `openGateSeqs @${s.track}`).toEqual(fresh.openGateSeqs());
        expect(s.nextGate()?.seq ?? null, `nextGate @${s.track}`).toBe(fresh.firstOpenGate()?.seq ?? null);
        // 时钟站着的那一张卡是拦停与 UI 共用的一问：续排之后它不许指着答过的那一张。
        s.live = true;
        const card = fresh.cardAt(s.t);
        expect(s.currentGate()?.seq ?? null, `cardAt(${s.t}) @${s.track}`).toBe(card && card.said === null ? card.seq : null);
        compared++;
      };
      for (let b = 0; b < 10; b++) {
        s.append(gen(), MAIN_TRACK);
        against();
      }
      expect(compared).toBe(10);
      // 剪断重排那一头（换台面）之后仍然同解。
      s.rerollFrom(s.log.all()[Math.floor(s.log.length / 2)].seq);
      against();
      for (let b = 0; b < 4; b++) {
        s.append(gen(), MAIN_TRACK);
        against();
      }
      // 插播那一头：另一本索引、另一卷带子，来回切不许串到主轨那一本上。
      s.beginAside();
      for (let b = 0; b < 3; b++) {
        s.append(gen());
        against();
      }
      s.endAside();
      against();
    }
  });
});
