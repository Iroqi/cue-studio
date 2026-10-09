// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { compile, perform, type Interpreter } from "./compile";
import { MAIN_TRACK, OpLog } from "./log";
import { Stage } from "./runtime";
import type { Compiled, Op, OpEntry } from "./types";

/*
 * 这一节钉的是「一台机器接着上一台机器往下演，和把那卷带子从头再演一遍，是同一张台面」。
 *
 * 上一件（`landed.test.ts`）把**契约**签下来了：`here` 的视线停在批的边界，所以后落的那一批不许改写
 * 观众已经看过的那一格。可契约说的是"追加是安全的"，不是"追加是便宜的" —— 安全那一头仍然每批把整卷
 * 重新演一遍。量过的基线（同一台机器、同一份探针、各取最小值；一批 20 轮、每轮三刀，所以一批 60 格）：
 * 12000 格（200 批）合计 1183ms、落最后一批 12.6ms；48000 格 27.1 秒、最后一批 75.0ms；192000 格
 * **570 秒**、最后一批 336.6ms。导演一轮落的正是十几刀，那笔钱他每一轮都付。这一件改的是价钱：解释器
 * 从函数局部搬进一台活着的机器（`Interpreter`），带子往下长一截就只演那一截 —— 同一台机器同一份探针
 * 改成 112ms / 2218ms / 68.8 秒，落最后一批 0.9ms / 5.9ms / 39.2ms；只看解释器那一头（不经 `Stage`，
 * 所以不含 `TapeIndex`/`StandingIndex` 那两笔仍然每批重建的账），192000 格合计 349ms、最后一批 0.098ms。
 *
 * 能不能续，只问一句引用：`log.ofTrack` 给的是那一轨**自己的**数组，落一笔往里 push（引用不变 → 只演
 * 新落的那一截），剪带（`cutFrom`）、载入（`restore`）、清空换数组（→ 从零再演）。所以"续排对不对"和
 * "什么时候该换机器"是两件事，分开钉：
 *
 *  1. **形状**：随机带子逐批追加，每一批落下之后机器给出的台面，和"拿这一批为止的带子从头再演一遍"
 *     逐字段对账 —— 每格外观（窗口两端、落在哪块板、盒子、有没有画、标签、partial）、镜头轨的每一刀
 *     （`t`/`end`/`from`/`to` 和那一刀的**引用**）、卡（含 `until`）、拍（含 `seqs` 与 headline）、
 *     时长、每板的地皮、`lastSeq`、`shotAt`。参照不许用任何缓存。剪带、载入、插播各自钉一遍。
 *  2. **价钱**：给带子套一层 Proxy，数**按下标读了几格**。续排时回头读过的格子必须**一个都没有**，
 *     往前多读的只许是本批那一段 —— 这一问不依赖机器快慢，也不依赖共享 CI 的毫秒噪声。
 *  3. **收尾三处**：三处 O(带子) 的收尾各自跟着带子走了，它们也正是三处会各自错法的地方，一条一条
 *     和"整张道具表并一遍""逐张问你在哪一拍""cue 表 reduce 一遍"那三份参照对账，包括那些不讲理的
 *     下场（一块板上全是量不出地方的格子、被撤空的一块板、最后一刀是不占时钟的镜头）。
 *  4. **护栏**：不许修过头。一次排完一卷带子（所有旧测试走的那条 `compile` 路）的答案不许因为换了
 *     机器就变；旧链接（没有分批号）仍然对；机器认带子只认引用，内容相同换了数组就得从零再演。
 */

const box = (x: number): { x: number; y: number; w: number; h: number } => ({ x, y: 0, w: 200, h: 160 });
const line = (text: string, duration = 800): Op => ({ kind: "narrate", text, duration });
const silent = (duration = 400): Op => ({ kind: "beat", duration });
const placed = (id: string, x: number, scene?: string): Op =>
  ({ kind: "build", id, box: box(x), label: id, html: `<p>${id}</p>`, ...(scene ? { scene } : {}) }) as Op;
const here = (id: string): Op => ({ kind: "build", id, box: box(0), label: id, html: `<p>${id}</p>`, here: true }) as Op;
const skeleton = (id: string, x: number): Op => ({ kind: "build", id, box: box(x), label: id }) as Op;
const inked = (id: string): Op => ({ kind: "patch", id, svg: `<svg><text>${id}</text></svg>` }) as Op;
const drop = (id: string): Op => ({ kind: "discard", id });
const back = (id: string, x = 600): Op => ({ kind: "recall", id, box: box(x), here: false }) as Op;
const cut = (to: string): Op => ({ kind: "transition", style: "dissolve", to, duration: 1200 });
const slide = (dir: "left" | "right" = "right"): Op =>
  ({ kind: "camera", mode: "pan", dir, screens: 0.6, duration: 900, easing: "ease" }) as Op;
/** 正好一屏的那一刀：`landed.test.ts` 钉的 700 / 2300 那两个数是按它量的。 */
const panOneScreen = (): Op => ({ kind: "camera", mode: "pan", dir: "right", screens: 1, duration: 900, easing: "ease" }) as Op;
const gaze = (target: string): Op =>
  ({ kind: "camera", mode: "focus", target, duration: 900, easing: "ease" }) as Op;
const card = (prompt: string): Op => ({ kind: "quiz", prompt, options: ["甲", "乙"], answer: 1 });
const said = (gate: number, text = "乙"): Op => ({ kind: "answer", gate, text });
const hold = (reason: string): Op => ({ kind: "pause-for", reason });
const mark = (id: string): Op => ({ kind: "highlight", target: id, style: "pulse", duration: 600 });
const push = (id: string): Op => ({
  kind: "motion",
  id,
  mode: "orbit",
  axis: "both",
  amp: 12,
  period: 1600,
  radius: 40,
  decay: 0.5,
  steps: 4,
  duration: 900,
});
const rel = (from: string, to: string): Op => ({ kind: "link", from, to, relation: "推出" });

/** 一批一批落下的带子：第 g 批的 `group` 就是 g，序号按整卷连续编。 */
const batches = (...b: Op[][]): OpEntry[] => {
  const out: OpEntry[] = [];
  b.forEach((ops, g) => ops.forEach((op) => out.push({ seq: out.length, track: MAIN_TRACK, turn: g, group: g, op })));
  return out;
};

/**
 * 往**同一卷**带子末尾追加一批：序号与批号按整卷续着编。
 *
 * 只许碰新落的那几格。以前这里写成"每次落完把整卷重编一遍号"，那等于把已经落下的那些的批号改成
 * 最新那一批 —— 批的边界当场没了，`here` 的视线越过去，对账比的两侧就成了同一个答案（空转的门）。
 */
function pushBatch(tape: OpEntry[], ops: Op[], batch: number): void {
  ops.forEach((op) => tape.push({ seq: tape.length, track: MAIN_TRACK, turn: batch, group: batch, op }));
}

/** 一刀一批的带子：比"跟着带子走"的那几节要用它，两边必须是同一份分批号。 */
const perOp = (ops: Op[]): OpEntry[] => ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: i, group: i, op }));

/* ------------------------------------------------------------------ 对账的尺子 */

/**
 * op 的**身份**：两条路读的是同一批 `OpEntry` 里的同一个 op 对象，所以引用相等既是"同一刀"也是
 * "这一刀没有被重做一份"。给它发一个跨调用稳定的号，`JSON.stringify` 才带得动。
 */
const ids = new WeakMap<object, number>();
let idCount = 0;
function oid(v: unknown): number {
  if (typeof v !== "object" || v === null) return -1;
  const hit = ids.get(v);
  if (hit !== undefined) return hit;
  const n = idCount++;
  ids.set(v, n);
  return n;
}

/**
 * 把台面压成一份可比对的结构。不许偷工：续排最容易错的地方恰恰是"只有一格跟着带子长"的那几本账
 * （卡的 `until`、一板的四条边、`duration` 的尾巴），所以逐字段列出来，而不是比几个摘要数字。
 */
function shapeOf(c: Compiled): string {
  return JSON.stringify({
    props: [...c.props.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([id, p]) => [
        id,
        p.scene,
        p.links.map((l) => [l.at, l.to, l.relation]),
        p.revisions.map((r) => [
          r.t,
          r.off ?? null,
          r.scene,
          [r.box.x, r.box.y, r.box.w, r.box.h],
          r.label,
          r.note ?? null,
          r.partial,
          r.svg ?? null,
          r.html ?? null,
          r.css ?? null,
          r.scene3d ? JSON.stringify(r.scene3d) : null,
        ]),
      ]),
    scenes: [...c.scenes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    cues: c.cues.map((q) => [q.t, q.end, q.op.kind, q.from, q.to]),
    // 每一刀的引用：换了对象就是"同一格被重做了一份"，那一头 `shotAt` 的键也跟着坏。
    cueIds: c.cues.map((q) => oid(q.op)),
    gateIds: c.gates.map((g) => [g.t, g.seq, g.kind, g.said, g.until, oid(g.op)]),
    beats: c.beats.map((b) => [b.turn, b.start, b.end, b.headline, b.verbs, b.seqs, b.gate]),
    duration: c.duration,
    lastSeq: c.lastSeq,
    // `shotAt` 的每一格都得答在"那一刀确实落在这一刻"上，不许漏记也不许多记。
    shots: c.cues.flatMap((q) =>
      q.op.kind === "camera" ? [[oid(q.op), c.shotAt.get(q.op) ?? null, q.t]] : [],
    ),
    shotSize: c.shotAt.size,
  });
}

/** 两条路必须给同一张台面；先说清差在第几个字符，否则红起来只是一大坨 JSON。 */
function sameShow(a: Compiled, b: Compiled): string | null {
  const sa = shapeOf(a);
  const sb = shapeOf(b);
  if (sa === sb) return null;
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    if (sa[i] !== sb[i]) {
      return `第 ${i} 个字符起不同：续排 …${sa.slice(Math.max(0, i - 80), i + 80)}… ⟂ 重排 …${sb.slice(Math.max(0, i - 80), i + 80)}…`;
    }
  }
  return "长度不同";
}

/* -------------------------------------------------------- 带子生成器（真随机） */

/*
 * 乘同余，和 `offstage.test.ts` 同一句教训：`seed * 1103515245` 在 float64 里超过 2^53 就丢精度，
 * 抽出来的序列塌成几个值 —— 那批带子看着"随机"，一种形状都不到，对账就在空转。`Math.imul` 走 int32。
 */
function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

/**
 * 一批的形状 = 一次工具调用排完的那一段。**故意不保证每批以旁白收尾** —— `landed.test.ts` 记过一次
 * 教训：每批都收在旁白上的生成器，批内那句旁白正好挡住往后的视线，跨批那一半根本没被读到，钉的是
 * 一条空街。真实的一批常常没有旁白（`paint()` 落的就是单独一刀 `build + here`）。
 */
function generator(seed: number) {
  const r = rng(seed);
  const ids = ["a", "b", "c", "d"];
  const boards = ["甲", "乙", "丙"];
  return (): Op[] => {
    const batch: Op[] = [];
    const n = 1 + r(5);
    for (let i = 0; i < n; i++) {
      const id = ids[r(ids.length)];
      switch (r(13)) {
        case 0:
          batch.push(here(id));
          break;
        case 1:
          batch.push(placed(id, r(6000) - 2000, r(3) === 0 ? boards[r(boards.length)] : undefined));
          break;
        case 2:
          batch.push(skeleton(id, r(3000)));
          break;
        case 3:
          batch.push(inked(id));
          break;
        case 4:
          batch.push(drop(id));
          break;
        case 5:
          batch.push(back(id, r(4000) - 1000));
          break;
        case 6:
          batch.push(line("第 " + i + " 句，够长才算一拍", 300 + r(1200)));
          break;
        case 7:
          batch.push(slide(r(2) === 0 ? "right" : "left"));
          break;
        case 8:
          batch.push(gaze(r(2) === 0 ? ids[r(ids.length)] : boards[r(boards.length)]));
          break;
        case 9:
          batch.push(cut(boards[r(boards.length)]));
          break;
        case 10:
          batch.push(card("第 " + i + " 题？"));
          break;
        case 11:
          batch.push(mark(id));
          batch.push(push(id));
          break;
        default:
          batch.push(r(2) === 0 ? silent(200 + r(600)) : rel(ids[r(ids.length)], ids[r(ids.length)]));
      }
    }
    // 偶尔挂一张卡要停、一句回答：卡的窗口和拍的收口只有这两类形状才走得到。
    if (r(4) === 0) batch.push(hold("等他把话说完"));
    if (r(3) === 0) batch.push(said(r(12)));
    return batch;
  };
}

/* ================================================================== 1 形状 */

describe("续排：接着演新落的那一截，和从头再演一遍是同一张台面", () => {
  const next = generator(20261009);

  /** 逐批追加的机器 vs 每批从头再演，每一批对一次账。返回对过的格子数，供"不许空转"那句用。 */
  function reconcile(nTapes: number, nBatches: number): { checked: number; bad: string[] } {
    let checked = 0;
    const bad: string[] = [];
    for (let tape = 0; tape < nTapes; tape++) {
      let it: Interpreter | null = null;
      // 带子只有一份数组，往下长 —— 每批换一个新数组就等于每批换机器，那量的全是重排。
      const tapeEntries: OpEntry[] = [];
      for (let b = 0; b < nBatches; b++) {
        pushBatch(tapeEntries, next(), b);
        // 参照：拿这一批为止的带子从头再演一遍，一台机器都不许复用。
        const whole = compile(tapeEntries.slice());
        const run = perform(it, tapeEntries);
        it = run.it;
        const diff = sameShow(run.compiled, whole);
        if (diff) bad.push(`tape ${tape} batch ${b}: ${diff}`);
        checked += whole.cues.length + whole.props.size + whole.beats.length;
      }
    }
    return { checked, bad };
  }

  it("两百卷随机带子、每卷三十批：逐批对账一个差异都不许有", () => {
    const { checked, bad } = reconcile(200, 30);
    expect(bad.slice(0, 2)).toEqual([]);
    // 量不到东西的门不许绿：这一带必须真的演过镜头轨、道具、拍。
    expect(checked).toBeGreaterThan(20_000);
  });

  it("这批带子真的踩到了全部形状（不然上面那条在空转）", () => {
    const kinds = new Set<string>();
    for (let i = 0; i < 5000; i++) for (const op of next()) kinds.add(op.kind);
    for (const k of ["build", "patch", "discard", "recall", "transition", "camera", "narrate", "beat", "quiz", "answer", "pause-for", "highlight", "motion", "link"]) {
      expect(kinds.has(k), k).toBe(true);
    }
  });

  it("换带子那一头从零再演：剪带之后仍然对账，接着落笔又改成续演", () => {
    const log = new OpLog();
    let it: Interpreter | null = null;
    for (let b = 0; b < 12; b++) {
      log.append(next(), MAIN_TRACK);
      it = perform(it, log.ofTrack(MAIN_TRACK)).it;
    }
    const cutAt = log.all()[8].seq;
    log.cutFrom(cutAt);
    // 剪带换的是数组：机器必须认出来（`holds` 说不成立），那一头从零演。
    expect(it!.holds(log.ofTrack(MAIN_TRACK))).toBe(false);
    let run = perform(it, log.ofTrack(MAIN_TRACK));
    expect(run.it).not.toBe(it);
    expect(sameShow(run.compiled, compile(log.ofTrack(MAIN_TRACK)))).toBeNull();
    it = run.it;
    for (let b = 0; b < 6; b++) {
      log.append(next(), MAIN_TRACK);
      run = perform(it, log.ofTrack(MAIN_TRACK));
      it = run.it;
      expect(sameShow(run.compiled, compile(log.ofTrack(MAIN_TRACK)))).toBeNull();
    }
    expect(it!.holds(log.ofTrack(MAIN_TRACK))).toBe(true);
  });

  it("载入别人的课：先对账，再当着我们的面接下去讲", () => {
    const seed = new OpLog();
    for (let b = 0; b < 9; b++) seed.append(next(), MAIN_TRACK);
    const log = new OpLog();
    log.restore(seed.export());
    let run = perform(null, log.ofTrack(MAIN_TRACK));
    expect(sameShow(run.compiled, compile(log.ofTrack(MAIN_TRACK)))).toBeNull();
    for (let b = 0; b < 4; b++) {
      log.append(next(), MAIN_TRACK);
      run = perform(run.it, log.ofTrack(MAIN_TRACK));
      expect(sameShow(run.compiled, compile(log.ofTrack(MAIN_TRACK)))).toBeNull();
    }
  });

  it("一条轨道一台机器：插播不许借用主轨那台，也不许弄脏它", () => {
    const log = new OpLog();
    let main: Interpreter | null = null;
    let aside: Interpreter | null = null;
    const asideTrack = "aside:1";
    for (let b = 0; b < 8; b++) {
      log.append(next(), MAIN_TRACK);
      const m = perform(main, log.ofTrack(MAIN_TRACK));
      main = m.it;
      expect(sameShow(m.compiled, compile(log.ofTrack(MAIN_TRACK)))).toBeNull();

      log.append(next(), asideTrack);
      const a = perform(aside, log.ofTrack(asideTrack));
      aside = a.it;
      expect(sameShow(a.compiled, compile(log.ofTrack(asideTrack)))).toBeNull();
      expect(main).not.toBe(aside);
    }
    // 主轨那台机器不认插播那卷带子 —— 认错了就是把一节课演到另一节课身上。
    expect(main!.holds(log.ofTrack(asideTrack))).toBe(false);
    // 主轨的台面里没有插播落下的名字，反过来也是。
    const mainIds = new Set(main!.result().props.keys());
    for (const id of aside!.result().props.keys()) {
      if (mainIds.has(id)) expect(compile(log.ofTrack(asideTrack)).props.get(id)!.id).toBe(id);
    }
  });

  it("同一卷带子反复问：第二次一个格子都不许多演，机器也不换", () => {
    const tapeEntries = batches([line("开场"), here("新概念"), slide(), line("第二句"), card("几？")]);
    const run = perform(null, tapeEntries);
    const first = shapeOf(run.compiled);
    const again = perform(run.it, tapeEntries);
    expect(again.it).toBe(run.it);
    expect(shapeOf(again.compiled)).toBe(first);
  });
});

/* ================================================================== 2 价钱 */

describe("续排的价钱：新落的那一批之外，一格都不许回头读", () => {
  /*
   * 数的是**按下标路过几格**，不是毫秒 —— 共享 CI 的噪声比省下来的钱还大，这句话仓库已经写过三次。
   * Proxy 必须**套一次用到底**（跟着那个数组一起长）：机器认带子认的是引用，每批换一个 Proxy 就等于
   * 每批换一卷带子，那一头量的全是重排。
   */
  function counter(entries: OpEntry[]) {
    const reads = new Map<number, number>();
    const view = new Proxy(entries, {
      get(t, k) {
        if (typeof k === "string" && /^\d+$/.test(k)) {
          const i = Number(k);
          reads.set(i, (reads.get(i) ?? 0) + 1);
        }
        return k === "length" ? t.length : (t as unknown as Record<string, unknown>)[k as string];
      },
    }) as unknown as OpEntry[];
    return { view, reset: () => reads.clear(), at: (i: number) => reads.get(i) ?? 0 };
  }

  /** 先演 `nBatch` 批，再落**一批**，数这一笔付的价钱。 */
  function priceOf(nBatch: number, seed: number): { backwards: number; extra: number } {
    const gen = generator(seed);
    const tape: OpEntry[] = [];
    const c = counter(tape);
    for (let b = 0; b < nBatch; b++) pushBatch(tape, gen(), b);
    let it = perform(null, c.view).it;
    const grown = tape.length;
    pushBatch(tape, gen(), nBatch);
    c.reset();
    it = perform(it, c.view).it;
    let backwards = 0;
    for (let i = 0; i < grown; i++) if (c.at(i) > 0) backwards++;
    // 每一格本就要被主循环读一次，所以多出来的那一截才是 look-ahead 的账。
    let extra = 0;
    for (let i = grown; i < tape.length; i++) extra += Math.max(0, c.at(i) - 1);
    return { backwards, extra };
  }

  it("落一批：回头读过的格子 = 0，往前只读到本批为止", () => {
    const small = priceOf(60, 20261010);
    const big = priceOf(2400, 20261010);
    expect(small.backwards).toBe(0);
    expect(big.backwards).toBe(0);
    // 带子长四十倍，新落那一批多读的格子一格都不许多（批内 look-ahead 有 `LOOKAHEAD_OPS` 封顶）。
    expect(big.extra).toBeLessThanOrEqual(small.extra + 257);
    expect(small.extra).toBeGreaterThanOrEqual(0);
  });

  it("整卷重排仍然付整卷的钱（参照不许被顺手改便宜）", () => {
    const tape: OpEntry[] = [];
    const gen = generator(20261012);
    for (let b = 0; b < 400; b++) pushBatch(tape, gen(), b);
    const c = counter(tape);
    compile(c.view);
    let untouched = 0;
    for (let i = 0; i < tape.length; i++) if (c.at(i) === 0) untouched++;
    expect(untouched).toBe(0); // 每一格都被读了 —— 那正是续排替我们省掉的那笔
  });
});

/* ================================================================== 3 收尾三处 */

describe("跟着带子走的三处收尾：各自和「整卷重算一遍」同解", () => {
  /** 一刀一刀往同一卷带子上长（引用不变），每落一刀就和"从头再演一遍"对一次账。 */
  function oneByOne(ops: Op[]): Compiled {
    const tape: OpEntry[] = [];
    let it: Interpreter | null = null;
    let last: Compiled = compile(tape);
    for (const op of ops) {
      tape.push({ seq: tape.length, track: MAIN_TRACK, turn: tape.length, group: tape.length, op });
      const run = perform(it, tape);
      it = run.it;
      last = run.compiled;
      expect(sameShow(last, compile(tape.slice()))).toBeNull();
    }
    return last;
  }

  it("一板的地皮：撤空的一块板整块消失，全是量不出地方的格子时回到一屏", () => {
    // 参照 = 改前那份规则逐字抄一遍：`groundsAtEnd`（站的是最后一格、到带子尽头还没收笔、分板按
    // `prop.scene`）加 `unionBox`（跳过 `w`/`h` 非正与 `x`/`y` 非有限的那些；四条边不全有限就回到一屏）。
    const resort = (c: Compiled): string => {
      const byBoard = new Map<string, { x: number; y: number; w: number; h: number }[]>();
      for (const p of c.props.values()) {
        const last = p.revisions[p.revisions.length - 1];
        if (last && last.off === undefined) {
          const list = byBoard.get(p.scene) ?? [];
          list.push(last.box);
          byBoard.set(p.scene, list);
        }
      }
      const out: [string, { x: number; y: number; w: number; h: number }][] = [];
      for (const [name, boxes] of [...byBoard.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        let x1 = Infinity;
        let y1 = Infinity;
        let x2 = -Infinity;
        let y2 = -Infinity;
        for (const b of boxes) {
          if (!(b.w > 0) || !(b.h > 0)) continue;
          if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
          x1 = Math.min(x1, b.x);
          y1 = Math.min(y1, b.y);
          x2 = Math.max(x2, b.x + b.w);
          y2 = Math.max(y2, b.y + b.h);
        }
        out.push([
          name,
          [x1, y1, x2, y2].every(Number.isFinite)
            ? { x: x1, y: y1, w: Math.max(x2 - x1, 1), h: Math.max(y2 - y1, 1) }
            : { x: 0, y: 0, w: 1600, h: 900 },
        ]);
      }
      return JSON.stringify(out);
    };
    const flat = (c: Compiled): string =>
      JSON.stringify([...c.scenes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    const thin = (x: number, y: number, w: number, h: number): Op =>
      ({ kind: "build", id: "z" + x + w, box: { x, y, w, h }, label: "z", html: "<p>z</p>" }) as Op;

    const cases: Op[][] = [
      [placed("a", 100), line("一"), drop("a"), line("二")], // 撤空的那块板不许留名
      [placed("a", 100), placed("b", 900, "乙"), line("一"), drop("a")],
      [thin(5, 5, 0, 40), line("一")], // `w` 非正：量不出地方，可那块板当年仍然有一屏
      [thin(NaN, 5, 40, 40), line("一")], // `x` 非有限：同上
      [placed("a", 100, "丙"), placed("b", 900, "丙"), drop("a"), drop("b"), line("一")],
      [placed("a", 100, "丙"), thin(1, 1, -5, 40), drop("a")], // 撤掉占地方那一格，剩下量不出地方的
      [placed("a", 100, "丙"), placed("b", 900, "丙"), back("a", 5000), line("一"), cut("丁"), line("二")],
      [skeleton("s", 200), line("一"), inked("s"), drop("s")], // 填占位符原地换那一格：四条边得跟着换
    ];
    for (const ops of cases) {
      const whole = compile(batches(ops));
      expect(flat(oneByOne(ops))).toBe(resort(whole));
      // 单批一次排完也仍然同解：这一件不许改答案。
      expect(flat(compile(perOp(ops)))).toBe(resort(whole));
      expect(sameShow(oneByOne(ops), compile(perOp(ops)))).toBeNull();
    }
  });

  it("卡的窗口：同一拍里的两张卡都跟着那一拍的 end 长，收口之后不再随带子动", () => {
    // 旁白和 `beat` 才收拍，所以两张卡之间只隔镜头与换场时它们还在同一拍里。旧写法收尾拿 `seqBeat`
    // 逐张问"你在哪一拍"，两张各拿到自己那一拍的 end；按"只留最后一拍的卡"去省，前一张就永远停在
    // 它落下那一刻 —— 省下了钱，错了答案。换场占时钟又不收拍，正是这个形状。
    const ops: Op[] = [card("第一题？"), slide(), card("第二题？"), cut("乙"), slide(), line("收住这一拍"), card("第三题？")];
    const tape: OpEntry[] = [];
    let it: Interpreter | null = null;
    const seen: number[][] = [];
    for (const op of ops) {
      tape.push({ seq: tape.length, track: MAIN_TRACK, turn: tape.length, group: tape.length, op });
      const run = perform(it, tape);
      it = run.it;
      seen.push(run.compiled.gates.map((g) => g.until));
    }
    const c = it!.result();
    expect(sameShow(c, compile(perOp(ops)))).toBeNull();
    expect(c.gates).toHaveLength(3);
    // 前两张在同一拍里，收口时一起拿到那一拍的 end。
    expect(c.gates[0].until).toBe(c.beats[0].end);
    expect(c.gates[1].until).toBe(c.beats[0].end);
    expect(c.gates[2].until).toBe(c.beats[1].end);
    // 中途就问过：第三刀（第二张卡落下）时，前一张的窗口已经跟着那一拍长，不是钉死在 0。
    expect(seen[3][0]).toBe(seen[3][1]);
    expect(seen[4][0]).toBeGreaterThan(0);
    // 收口之后不许再随带子长。
    expect(seen[5][0]).toBe(seen[6][0]);
  });

  it("收过口的卡不许被后面那一拍的 end 回头改写（openGates 必须真的清空）", () => {
    /*
     * 上面那条钉不住"收口时忘了清空"这一种错法：那卷带子里前后两拍的 end 恰好相等，回头重账一次
     * 看不出差别。这里刻意让第二拍比第一拍长（`duration` 明写），于是"忘了清空"就是把第一张卡的
     * 窗口拉长到第二拍那一拍里去。而这一条**不许**只对账：整卷重排那份参照和机器共用同一个收尾，
     * 收尾本身错法时两边一起错，绿灯什么都没说 —— 所以要按 `beats` 上的绝对值断言。
     *
     * 两拍三刀：`beat` 也收拍，而它的 end 只到自己那一刀，所以这里不需要任何一句旁白 —— 钉的是
     * 收口，不是"有没有人说话"。
     */
    const ops: Op[] = [card("第一题？"), silent(800), card("第二题？"), silent(2400), card("第三题？")];
    const tape: OpEntry[] = [];
    let it: Interpreter | null = null;
    for (const op of ops) {
      tape.push({ seq: tape.length, track: MAIN_TRACK, turn: tape.length, group: tape.length, op });
      it = perform(it, tape).it;
    }
    const c = it!.result();
    expect(c.beats).toHaveLength(3);
    // 三张卡分别落在第一、第二、第三拍里（`beat` 与旁白收拍，卡只开拍）。
    expect(c.gates.map((g) => g.until)).toEqual([c.beats[0].end, c.beats[1].end, c.beats[2].end]);
    // 而且这两拍的 end 不许相等，否则上面那一行是一条空街（上一条教训的同一个形状）。
    expect(c.beats[1].end).toBeGreaterThan(c.beats[0].end);
    expect(c.gates[0].until).toBeLessThan(c.beats[1].end);
  });

  it("时长那截尾巴：最后一刀是不占时钟的镜头时，带子的长度仍然算上它", () => {
    const ops: Op[] = [line("只有一句"), placed("a", 100), slide(), slide(), mark("a")];
    const c = oneByOne(ops);
    expect(sameShow(c, compile(perOp(ops)))).toBeNull();
    // 旁白收拍，后面那四刀开的是第二拍 —— 那一拍不占时钟以外的钱，但它确实存在。
    expect(c.beats).toHaveLength(2);
    expect(c.duration).toBeGreaterThan(c.beats[0].end);
    // 尾巴跟着最长那一刀走，而不是"最后落下的那一刀"：中途那条更长的仍然算数。
    const long = oneByOne([line("一句"), mark("没这个东西"), slide()]);
    expect(long.duration).toBe(compile(perOp([line("一句"), mark("没这个东西"), slide()])).duration);
    /*
     * 上面那一对账钉不住"顺手记最大值记成了记最后一刀"这一种错法：那卷带子里最长的一刀正好落在
     * 尾巴上，两种记法同一个答案。这里刻意把长的那一刀夹在中间（600 的强调，后面跟一刀只有 1 的
     * 镜头），而且**不许**只对账 —— 参照走的是同一个收尾，收尾自己错时两边一起错。
     */
    const tiny = { kind: "camera", mode: "pan", dir: "right", screens: 0.1, duration: 1, easing: "ease" } as Op;
    const middle = oneByOne([line("一句"), placed("甲", 100), mark("甲"), tiny]);
    expect(middle.beats).toHaveLength(2);
    // 长的那一刀夹在中间，最后落下的那一刀只有 1ms —— 带子的长度跟的是前者。
    expect(middle.duration).toBe(middle.beats[0].end + 600);
    // 换算按 `cueMs`：`highlight` 写 600，而 `speechMs` 那句旁白才是第一拍的 end，所以这里
    // 只钉"它不等于最后那一刀的 end"这一件事，具体数字由上一行给。
    expect(middle.beats[1].end).toBeLessThan(middle.duration);
  });
});

/* ================================================================== 4 护栏 */

describe("护栏：这一件不许修过头", () => {
  it("一次排完一卷带子的答案和逐批落笔一模一样（所有旧测试走的那条路）", () => {
    const ops = [line("开场"), here("新概念"), slide(), line("第二句"), card("几？"), said(4), gaze("新概念")];
    const oneBatch = batches(ops);
    expect(sameShow(compile(oneBatch), perform(null, oneBatch).compiled)).toBeNull();
    // 旧链接没有分批号：整卷就是一批，`here` 的视线仍然读到那一带的结尾 —— 这两个数是
    // `landed.test.ts` 钉过的，换了机器它们一格都不许动。
    const legacyOps = [line("开场"), here("新概念"), panOneScreen(), line("第二句")];
    const legacy = legacyOps.map((op, seq) => ({ seq, track: MAIN_TRACK, turn: 0, op })) as OpEntry[];
    expect(sameShow(compile(legacy), perform(null, legacy).compiled)).toBeNull();
    expect(compile(legacy).props.get("新概念")!.revisions[0].box.x).toBe(2300);
    expect(perform(null, legacy).compiled.props.get("新概念")!.revisions[0].box.x).toBe(2300);
    // 分成两批落，同一个数就停在落笔那一刻。
    const split = batches([legacyOps[0], legacyOps[1]], [legacyOps[2], legacyOps[3]]);
    expect(compile(split).props.get("新概念")!.revisions[0].box.x).toBe(700);
  });

  it("缺 `group` 的带子和有 `group` 的整批带子同解", () => {
    const ops = [line("开场"), here("甲"), slide(), line("第二句")];
    const withGroup = batches(ops);
    const without = withGroup.map(({ group: _group, ...rest }) => rest) as OpEntry[];
    expect(sameShow(compile(withGroup), compile(without))).toBeNull();
  });

  it("机器认带子只认引用：内容相同、换了数组就从零再演", () => {
    const tapeEntries = batches([line("一"), here("甲"), slide()]);
    const run = perform(null, tapeEntries);
    const copy = tapeEntries.slice();
    expect(run.it.holds(copy)).toBe(false);
    const again = perform(run.it, copy);
    expect(again.it).not.toBe(run.it);
    expect(sameShow(again.compiled, run.compiled)).toBeNull();
  });

  it("台上那口钟：直播逐批落笔的快照和整卷重排后一样", () => {
    const gen = generator(20261013);
    for (let tape = 0; tape < 24; tape++) {
      const s = new Stage();
      for (let b = 0; b < 8; b++) s.append(gen(), MAIN_TRACK);
      const theirs = compile(s.log.ofTrack(MAIN_TRACK));
      expect(sameShow(s.compiled, theirs)).toBeNull();
      // 剪断重排那一头（换带子）之后仍然同解。
      const cutAt = s.log.all()[Math.floor(s.log.length / 2)].seq;
      s.rerollFrom(cutAt);
      expect(sameShow(s.compiled, compile(s.log.ofTrack(MAIN_TRACK)))).toBeNull();
      for (let b = 0; b < 4; b++) s.append(gen(), MAIN_TRACK);
      expect(sameShow(s.compiled, compile(s.log.ofTrack(MAIN_TRACK)))).toBeNull();
      // 插播那一头：另一台机器、另一卷带子，来回切不许串。
      s.beginAside();
      for (let b = 0; b < 3; b++) s.append(gen());
      expect(sameShow(s.compiled, compile(s.log.ofTrack(s.track)))).toBeNull();
      s.endAside();
      expect(sameShow(s.compiled, compile(s.log.ofTrack(MAIN_TRACK)))).toBeNull();
    }
  });
});
