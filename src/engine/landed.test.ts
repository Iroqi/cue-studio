import { describe, expect, it } from "vitest";
import { compile } from "./compile";
import { MAIN_TRACK, OpLog } from "./log";
import { Stage } from "./runtime";
import type { Box, Compiled, Op, OpEntry } from "./types";

/*
 * 这一节钉的是「落下的那一格不许被后一笔改写」。
 *
 * 带子只增不改是整个仓库的地基：分享、重放、重排都是它的推论。可解释器里有一格一直在破这条规矩 ——
 * `here` 的落点。它算的时候往后看，而它读到的是**整卷带子的后面**，不是"这一批一起排的那一段"的后面。
 * 于是导演后落的那一批把观众已经看过的那一格改了：实测（下面第一条的形状）第一批 `{旁白, 占位符}` 落下
 * 的锚点是 `{x:700,…}`，追加第二批 `{往右一屏, 旁白}` 之后同一个道具的锚点成了 `{x:2300,…}` —— 东西在
 * 观众眼前自己飞走，而带子上没有任何一刀说要挪它。旧写法里挡它的只有"下一句旁白"，而第二批完全可以
 * **先镜头后旁白**：overlay 不占时钟，那一刀正好排在旁白之前，于是它落在占位符的视线里。
 *
 * 修法是把往后的视线停在批的边界（`OpEntry.group`：`OpLog.append()` 每调一次发一批，一次工具调用排完
 * 的那一段就是一批）。批内逐字不变 —— 骨架那句「先上占位符、后走镜头，东西跟着走后的框」靠的正是批内
 * 往后看；批与批之间是已经演过的历史，历史不许重演。
 *
 * 三件事分开钉，因为它们各自会坏（和 `camera-moment.test.ts` 同一个次序）：
 *  1. **答案的形状**：追加的那一批不许动已经落下的格子；同一批里的镜头仍然要带着它走；同一批里的下一句
 *     仍然要挡住上一句；`recall` 的 `here` 同一条路；旧链接（没有分批号）整卷是一批，行为不变。
 *  2. **价钱**：往后看的格子数，数的是**按下标读了几格**（给传进 `compile` 的那个数组套一层 Proxy）。
 *     主循环每格本就要读一次，所以窗口里多出来的那一截才算是 look-ahead 的账。
 *  3. **对账**：随机带子一批一批追加，每追加一批就把整卷重排一遍，逐格比「落笔那一刻说它在哪」和「现在
 *     还说它在那吗」。参照就是"从头把已排过的那一段再读一遍、一个缓存都不许用"那份 —— 正是 `compile`
 *     自己每批在做的事，所以任何一格被后一笔改写都会当场红。镜头轨的 `from`/`to` 一起比。
 */

const line = (text: string, duration = 1000): Op => ({ kind: "narrate", text, duration });
const unnamed = (id: string): Op =>
  ({ kind: "build", id, box: { x: 0, y: 0, w: 200, h: 160 }, label: id, html: `<p>${id}</p>`, here: true }) as Op;
const placed = (id: string, x: number): Op => ({ kind: "build", id, box: { x, y: 0, w: 200, h: 160 }, label: id, html: `<p>${id}</p>` });
const slide = (dir: "left" | "right" | "up" | "down" = "right", screens = 1): Op =>
  ({ kind: "camera", mode: "pan", dir, screens, duration: 900, easing: "ease" }) as Op;
const closer = (zoom = 2): Op => ({ kind: "camera", mode: "zoom", zoom, duration: 900, easing: "ease" }) as Op;
const backHere = (id: string): Op => ({ kind: "recall", id, box: { x: 0, y: 0, w: 200, h: 160 }, here: true }) as Op;

/** 一批一批落下的带子：第 g 批的 `group` 就是 g，序号按整卷连续编。 */
const batches = (...b: Op[][]): OpEntry[] => {
  const out: OpEntry[] = [];
  b.forEach((ops, g) => ops.forEach((op) => out.push({ seq: out.length, track: MAIN_TRACK, turn: g, group: g, op })));
  return out;
};

const anchor = (entries: OpEntry[], id: string, which = 0): Box => {
  const rev = compile(entries).props.get(id)!.revisions[which];
  return rev.box;
};

describe("落下的那一格：追加的那一批不许改写它", () => {
  it("追加一批「先镜头后旁白」，已经站着的那一格一步都不许挪", () => {
    // 改前实测：落笔时 {x:700,…}，追加 {往右一屏, 旁白} 之后同一个对象成了 {x:2300,…}。
    const log = new OpLog();
    log.append([line("开场"), unnamed("新概念")], MAIN_TRACK);
    const landed = compile(log.all()).props.get("新概念")!.revisions[0].box;
    log.append([slide("right"), line("第二句")], MAIN_TRACK);
    const after = compile(log.all()).props.get("新概念")!.revisions[0].box;
    expect(landed.x + landed.w / 2).toBe(800);
    expect(after).toEqual(landed);
  });

  it("同一批里的镜头仍然带着它走：边界是批，不是下一笔", () => {
    const show = compile(batches([line("开场"), unnamed("新概念"), slide("right"), line("第二句")]));
    const box = show.props.get("新概念")!.revisions[0].box;
    const move = show.cues.find((c) => c.op.kind === "camera")!;
    // 落在走后的那一屏里，正是 `stage_script` 那份骨架要的东西。
    expect(box.x + box.w / 2).toBeGreaterThan(move.to.x);
    expect(box.x + box.w / 2).toBeLessThan(move.to.x + move.to.w);
  });

  it("同一批里的下一句仍然挡住上一句：批内「本拍说完时看见的地方」没被换掉", () => {
    // 一批里排两拍是 `stage_script` 的正常写法。上一拍的占位符只许读到本拍的旁白为止。
    const box = anchor(batches([unnamed("上一拍的东西"), line("第一句"), slide("right"), line("第二句")]), "上一拍的东西");
    expect(box.x + box.w / 2).toBe(800);
    expect(box.y + box.h / 2).toBe(450);
  });

  it("同一卷带子，换批排和一批排的答案就是这两个数", () => {
    const ops = [line("开场"), unnamed("新概念"), slide("right"), line("第二句")];
    expect(anchor(batches(ops.slice(0, 2), ops.slice(2)), "新概念").x).toBe(700);
    expect(anchor(batches(ops), "新概念").x).toBe(2300);
  });

  it("`recall` 的 here 是同一条路：后落的一批不许把它挪回眼前这一屏", () => {
    const log = new OpLog();
    log.append([placed("旧东西", 40), line("一"), backHere("旧东西")], MAIN_TRACK);
    const landed = compile(log.all()).props.get("旧东西")!.revisions[1].box;
    log.append([slide("right"), line("二")], MAIN_TRACK);
    expect(compile(log.all()).props.get("旧东西")!.revisions[1].box).toEqual(landed);
  });

  it("旧链接没有分批号：整卷是一批，落点还是跟着镜头走", () => {
    // 分享链接是别人上的一节课，那些字段来自上一版。缺 `group` 两边都是 `undefined`，于是不换批 ——
    // 门不许因为修了一格几何就把别人的课改了。
    const legacy = [
      { seq: 0, track: MAIN_TRACK, turn: 0, op: line("开场") },
      { seq: 1, track: MAIN_TRACK, turn: 0, op: unnamed("新概念") },
      { seq: 2, track: MAIN_TRACK, turn: 0, op: slide("right") },
      { seq: 3, track: MAIN_TRACK, turn: 0, op: line("第二句") },
    ] as OpEntry[];
    expect(compile(legacy).props.get("新概念")!.revisions[0].box.x).toBe(2300);
  });

  it("台上那口钟也跟着改：直播时追加的那一批不会把观众眼前的东西搬走", () => {
    // 上面比的是 `compile`；这一条比的是学习者真的会看见的那一份快照。播放头跟着带尾走，因为导演
    // 落笔的那一头就是带尾（`director.ts` 那句"问的是带子尽头那一刻"说的正是这件事）。
    const s = new Stage();
    s.append([line("开场"), unnamed("新概念")]);
    s.goLive();
    const before = s.getSnapshot().props.find((p) => p.id === "新概念")!.box;
    s.append([slide("right"), line("第二句")]);
    s.goLive();
    expect(s.getSnapshot().props.find((p) => p.id === "新概念")!.box).toEqual(before);
  });

  it("护栏：后落那一批里的另一个 here，仍然要让开已经站着的那一格", () => {
    // 不许修过头：落点各归各的批，可槽位是同一张台面上的让位，跨批照样得让 —— 否则两件东西叠在正中。
    const log = new OpLog();
    log.append([line("开场"), unnamed("一")], MAIN_TRACK);
    log.append([unnamed("二"), line("第二句")], MAIN_TRACK);
    const c = compile(log.all());
    const a = c.props.get("一")!.revisions[0].box;
    const b = c.props.get("二")!.revisions[0].box;
    expect(`${a.x},${a.y}`).not.toBe(`${b.x},${b.y}`);
  });

  it("护栏：已经走完的镜头轨不因分批而改 —— 那一头本来就只读它自己那一刻", () => {
    const ops = [placed("a", 40), line("一"), slide("right"), line("二")];
    const split = compile(batches(ops.slice(0, 2), ops.slice(2))).cues;
    const whole = compile(batches(ops)).cues;
    expect(split.map((c) => [c.t, c.op.kind, c.to.x])).toEqual(whole.map((c) => [c.t, c.op.kind, c.to.x]));
  });
});

/*
 * 价钱那一层：主循环每一刀本就要读一次自己那一格，所以从"这一格的下一格"起，多出来的读才算 look-ahead
 * 付的钱。修后跨批只多读**一格** —— 看一眼发现换了批就停；旧写法在这一头一路读到 `LOOKAHEAD_OPS`。
 */
describe("落下的那一格：往后看的价钱", () => {
  /** 每一格被按下标读了多少次。 */
  const readsOf = (entries: OpEntry[]): number[] => {
    const reads = new Array(entries.length).fill(0);
    const view = new Proxy(entries, {
      get(t, k) {
        if (typeof k === "string" && /^\d+$/.test(k)) reads[Number(k)]++;
        return k === "length" ? t.length : t[k as unknown as number];
      },
    }) as OpEntry[];
    compile(view);
    return reads;
  };

  /** 从 `from` 起，比主循环那一次多出来的格子数。 */
  const beyond = (reads: number[], from: number): number => {
    let cells = 0;
    for (let i = from; i < reads.length; i++) cells += Math.max(0, reads[i] - 1);
    return cells;
  };

  /** 一批很长的 overlay 收尾于一句话。 */
  const tail = (n: number): Op[] => [...Array.from({ length: n }, () => slide("right")), line("收住这一拍")];

  it("换了批就停：身后那一批 300 格只多读一格", () => {
    const TAIL = 300;
    // 索引 0=旁白、1=占位符，2.. 是后面那一批。look-ahead 从索引 2 开始问。
    const reads = readsOf(batches([line("开场"), unnamed("新概念")], tail(TAIL)));
    expect(beyond(reads, 2)).toBe(1);
  });

  it("护栏：批内的封顶还在 —— 一批里排 300 格 overlay 只读到 LOOKAHEAD_OPS", () => {
    // 这条钉的是"别因为有了批这道墙就把封顶摘掉"。旧版实测 40k 占位符 7.4 秒就是因为没有封顶；批的
    // 边界管的是读多少**历史**，一批之内导演照样能排很长一段 overlay，那一头仍然得靠封顶。
    const TAIL = 300;
    const reads = readsOf(batches([line("开场"), unnamed("新概念"), ...tail(TAIL)]));
    // 索引 2 起，视线正好读到 256 格就停 —— 和上面那条"换了批只读 1 格"是两道各自的墙。
    expect(beyond(reads, 2)).toBe(256);
  });

  it("护栏：计数探针数的是这条带子本身 —— 每一格都被读到，且只被主循环读到", () => {
    const entries = batches([line("开场"), placed("有坐标的东西", 10)], tail(20));
    const reads = readsOf(entries);
    expect(reads.length).toBe(entries.length);
    expect(reads.every((r) => r >= 1)).toBe(true);
    // 没有 `here` 的一卷带子，一格都不许多读：`placedBox` 那一头仍然把视线挡在门口。
    expect(reads.every((r) => r === 1)).toBe(true);
  });
});

/*
 * 对账那一头。参照不另写一套解释器 —— 它就是"从头把已经排过的那一段带子再读一遍"，也就是现场每落一
 * 批本来就要做的事。逐批比的是同一卷带子的两个前缀，所以后一笔改写前一笔会当场红在哪一批、哪一格。
 */
describe("落下的那一格：和「落笔那一刻重排一遍」逐格对账", () => {
  /** 确定性随机：同一颗种子每次生成同一卷带子，红了能重放。 */
  const rng = (seed: number) => {
    let s = (seed * 2654435761) >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };
  const BOARDS = ["开场", "第二板", "第三板"];

  /*
   * 生成器得长成生产的样子，不是"每批自己说完一句"的样子。这一头我第一版每条都收尾于一句旁白，于是
   * 对账在改前的代码上**是绿的** —— 批内那句旁白正好挡住了往后的视线，跨批的那一半根本没被读到，钉的
   * 是一条空街。真实的一批常常没有旁白：`paint()` 落的就是单独一刀 `build + here`（`loop.ts` 的
   * `dispatchPaint`），导演随后单独点一刀镜头（`director.ts` 每个动词一次 `append`），下一句常常要到
   * 再下一批才来。所以这里按真的动词分批：骨架（一批里排完一格、一刀、一句话）、单独一帧（派给美工）、
   * 单独一刀镜头、单独一句话。
   */
  const randomBatch = (rnd: () => number, ids: string[]): Op[] => {
    const id = `p${ids.length}`;
    ids.push(id);
    const pick = rnd();
    if (pick < 0.22) return [unnamed(id)]; // 单独一个占位符：派给美工，批里没有别的刀
    if (pick < 0.34) return [placed(id, Math.floor(rnd() * 3000))];
    if (pick < 0.44) return [backHere(ids[Math.floor(rnd() * ids.length)])];
    if (pick < 0.62) return [slide(rnd() < 0.5 ? "right" : "down", 0.5 + rnd())]; // 单独一刀镜头
    if (pick < 0.7) return [closer(0.5 + rnd() * 2)];
    if (pick < 0.8) return [line(`第 ${ids.length} 句`, 600 + Math.floor(rnd() * 1200))];
    if (pick < 0.86)
      return [{ kind: "transition", style: "dissolve", to: BOARDS[Math.floor(rnd() * BOARDS.length)], duration: 1000 } as Op, line("换场后的一句话", 800)];
    // 一份骨架：占位符、那一刀的镜头、这句话，一起排完 —— 批内往后看要的正是这个形状。
    const out: Op[] = [unnamed(id)];
    if (rnd() < 0.6) out.push(slide("right", 0.5 + rnd()));
    out.push(line(`第 ${ids.length} 句`, 600 + Math.floor(rnd() * 1200)));
    return out;
  };

  /** 逐批落下，返回每一批落下之后整卷重排出来的那一份台面。 */
  const perform = (seed: number, nBatches: number): { shots: Compiled[]; tape: OpEntry[] } => {
    const rnd = rng(seed);
    const ids: string[] = [];
    const tape: OpEntry[] = [];
    const shots = [compile([])];
    for (let b = 0; b < nBatches; b++) {
      // 每一批一个自己的号：`group` 全相同就等于"整卷一批"，那一头改前改后同解，对账会空转。
      for (const e of batches(randomBatch(rnd, ids))) tape.push({ ...e, seq: tape.length, turn: b, group: b });
      shots.push(compile(tape.slice()));
    }
    return { shots, tape };
  };

  it("这批带子真的会分批、会有 here、会有跨批的镜头（不然下面的对账在空转）", () => {
    let heres = 0;
    let cams = 0;
    let crossed = 0;
    let appended = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { tape } = perform(seed, 8);
      appended += tape.length;
      for (const e of tape) {
        if ("here" in e.op && e.op.here) heres++;
        if (e.op.kind === "camera") cams++;
        // 这一刀之前已经落过笔，而它是一刀镜头 —— 旧写法正是被这种形状改写落点的。
        if (e.op.kind === "camera" && e.seq > 0) crossed++;
      }
    }
    expect(heres).toBeGreaterThan(60);
    expect(cams).toBeGreaterThan(30);
    expect(crossed).toBeGreaterThan(20);
    expect(appended).toBeGreaterThan(300);
  });

  it("逐批追加：已经落下的每一格，落笔那一刻说它在哪它就在那", () => {
    let boxes = 0;
    let shots = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const steps = perform(seed, 8).shots;
      for (let b = 1; b < steps.length; b++) {
        const prev = steps[b - 1];
        const now = steps[b];
        for (const [id, p] of prev.props) {
          const back = now.props.get(id);
          if (!back) throw new Error(`seed ${seed} 批 ${b}：${id} 从道具表里掉了`);
          for (let i = 0; i < p.revisions.length; i++) {
            const want = p.revisions[i].box;
            const got = back.revisions[i]?.box;
            if (!got || got.x !== want.x || got.y !== want.y || got.w !== want.w || got.h !== want.h)
              throw new Error(
                `seed ${seed} 批 ${b}：${id}#${i} 落笔时 ${JSON.stringify(want)}，追加之后 ${JSON.stringify(got)} —— 观众眼前的东西自己飞走了`,
              );
            boxes++;
          }
        }
        const before = prev.cues.filter((c) => c.op.kind === "camera");
        const after = now.cues.filter((c) => c.op.kind === "camera");
        for (let i = 0; i < before.length; i++) {
          if (after[i].from.x !== before[i].from.x || after[i].to.x !== before[i].to.x || after[i].t !== before[i].t)
            throw new Error(`seed ${seed} 批 ${b}：第 ${i} 刀镜头的轨道被后一批改写了（${before[i].to.x} → ${after[i]?.to.x}）`);
          shots++;
        }
      }
    }
    // 探针不许空转：确实逐格比过落点，也确实逐刀比过镜头轨。
    expect(boxes).toBeGreaterThan(400);
    expect(shots).toBeGreaterThan(150);
  });

  it("反过来钉一条：分批不许改本批 —— 同一卷带子，一批排完和逐批排完逐字相同", () => {
    // 上面那条不许"后一笔改历史"，这一条不许"分批改当批"。缺号（旧链接）那一头也必须同解，否则
    // `group` 就成了第二套语义。
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = rng(seed);
      const ids: string[] = [];
      const entries = batches(randomBatch(rnd, ids), randomBatch(rnd, ids));
      const split = compile(entries);
      const once = compile(entries.map((e) => ({ ...e, group: 0 })));
      const legacy = compile(entries.map((e) => ({ seq: e.seq, track: e.track, turn: e.turn, op: e.op })));
      for (const [id, p] of once.props) {
        for (const other of [legacy, split]) {
          const back = other.props.get(id)!;
          for (let i = 0; i < p.revisions.length; i++) expect(back.revisions[i].box).toEqual(p.revisions[i].box);
        }
      }
      // 每一批落下那一刻的台面，必须等于"整卷只排到那一批"的台面 —— 逐批和一次排完的分岔点就在这。
      let upto = 0;
      for (let g = 0; g < 2; g++) {
        upto += entries.filter((e) => e.group === g).length;
        const at = compile(entries.slice(0, upto));
        for (const [id, p] of at.props) {
          const now = split.props.get(id)!;
          for (let i = 0; i < p.revisions.length; i++) expect(now.revisions[i].box).toEqual(p.revisions[i].box);
        }
      }
    }
  });
});
