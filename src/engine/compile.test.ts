import { describe, expect, it } from "vitest";
import { compile, unionBox, VIEWPORT } from "./compile";
import type { Box, BuildOp, CameraOp, HighlightOp, MotionOp, NarrateOp, Op, OpEntry, RecallOp, TransitionOp } from "./types";

const tape = (...ops: Op[]): OpEntry[] => ops.map((op, i) => ({ seq: i, track: "main", turn: 0, op }));

const line = (text: string, duration: number): NarrateOp => ({ kind: "narrate", text, duration });
const scene = (to: string, duration: number): TransitionOp => ({ kind: "transition", style: "dissolve", to, duration });
const mark = (target: string, duration: number): HighlightOp => ({ kind: "highlight", target, style: "pulse", duration });
const drift = (id: string, duration: number): MotionOp => ({ kind: "motion", id, mode: "oscillate", axis: "x", amp: 40, period: 1000, radius: 0, steps: 0, decay: 0, duration });
const art = (id: string): Op => ({ kind: "build", id, box: { x: 0, y: 0, w: 200, h: 200 }, label: id, html: `<p>${id}</p>` });
const slide = (dir: "left" | "right" | "up" | "down", screens: number): CameraOp => ({ kind: "camera", mode: "pan", dir, screens, duration: 900, easing: "ease" });
const unnamed = (id: string, at?: string): BuildOp => ({ kind: "build", id, box: { x: 0, y: 0, w: 200, h: 200 }, label: id, html: `<p>${id}</p>`, here: true, ...(at ? { scene: at } : {}) });

const LONG = "一".repeat(52);
const SHORT = "你好";

describe("compile：每一刀的时刻，就是上一句的长短", () => {
  it("念不完的那一拍被拉长之后，紧跟其后的镜头才动", () => {
    const cues = compile(tape(line(LONG, 2000), { kind: "camera", mode: "pan", dir: "right", duration: 900, easing: "ease" })).cues;
    expect(cues[0].t).toBe(0);
    // 2000ms 说不完这句话：窗口自己长到 10300（10000 念 + 300 落定）。
    expect(cues[0].end).toBe(10300);
    expect(cues[1].t).toBe(cues[0].end);
  });

  it("整场时长把落定尾巴和叠层的尾巴都算进去", () => {
    expect(compile(tape(line(LONG, 2000))).duration).toBe(10300);
    const withOverlay = compile(tape(line(SHORT, 2000), mark("a", 900)));
    expect(withOverlay.cues[0].end).toBe(2000);
    expect(withOverlay.duration).toBe(2900);
  });

  it("叠在旁白之上的强调与运动不推时钟", () => {
    const cues = compile(tape(line(SHORT, 2000), mark("a", 900), drift("a", 500), line("第二句", 1000))).cues;
    // 它们都落在上一句说完的那一刻，谁也不把时钟往前挪一格。
    expect(cues.map((c) => c.t)).toEqual([0, 2000, 2000, 2000]);
  });

  it("beat 是刻意的静默，长度按说的算", () => {
    const cues = compile(tape({ kind: "beat", duration: 1500 }, line("下一句", 1000))).cues;
    expect(cues[0].op.kind).toBe("beat");
    expect(cues[1].t).toBe(1500);
  });

  it("零秒的拍子不倒退时钟", () => {
    const cues = compile(tape({ kind: "beat", duration: 0 }, { kind: "beat", duration: 0 }, line("下一句", 1000))).cues;
    expect(cues[1].t).toBe(1);
    expect(cues[2].t).toBe(2);
  });

  it("换场短不过幕布盖住板的那一半，时钟跟着下限走", () => {
    const cues = compile(tape(scene("下一场", 120), line("新场上的一句话", 1000))).cues;
    expect(cues[0].end - cues[0].t).toBe(700);
    expect(cues[1].t).toBe(700);
  });

  it("道具落在这一步的时钟位置上，不是凭空早出现", () => {
    const props = [...compile(tape(line(LONG, 2000), art("a"))).props.values()];
    expect(props[0].revisions[0].t).toBe(10300);
  });
});

/** 一块板在平面上有一个位置，哪怕它还是空的。 */
describe("compile：板是有地皮的", () => {
  const contains = (b: Box, p: Box) =>
    p.x >= b.x - 1 && p.y >= b.y - 1 && p.x + p.w <= b.x + b.w + 1 && p.y + p.h <= b.y + b.h + 1;

  it("切到一块还没摆东西的板，镜头跟着幕布一起走过去", () => {
    const cues = compile(tape(art("a"), line(SHORT, 1000), scene("下一板", 1000))).cues;
    const cut = cues.find((c) => c.op.kind === "transition")!;
    // 老行为：from === to，于是观众看着自己的画被擦掉，换来了一个空框。
    expect(cut.to).not.toEqual(cut.from);
    expect(contains(cut.to, cut.from)).toBe(false);
    // 而且落在词汇承诺的间距上（一块板约一屏，板间隔 2000~3000）。
    expect(cut.to.x - (cut.from.x + cut.from.w)).toBeGreaterThanOrEqual(800);
    expect(cut.to.x - (cut.from.x + cut.from.w)).toBeLessThanOrEqual(1400);
  });

  it("同一块板切两次，还在同一个地方", () => {
    const cues = compile(tape(scene("B", 1000), line(SHORT, 1000), scene("A", 1000), line(SHORT, 1000), scene("B", 1000))).cues;
    const [first, second] = cues.filter((c) => c.op.kind === "transition" && c.op.to === "B");
    expect(second.to).toEqual(first.to);
  });

  it("recall 到新板上说 here，落在这块板此刻的框里", () => {
    const show = compile(tape(art("旧东西"), line(SHORT, 1000), scene("B", 1000), {
      kind: "recall",
      id: "旧东西",
      box: { x: 0, y: 0, w: 200, h: 200 },
      here: true,
    } as RecallOp));
    const rev = show.props.get("旧东西")!.revisions[1];
    const onB = show.cues.find((c) => c.op.kind === "transition")!;
    expect(rev.scene).toBe("B");
    expect(contains(onB.to, rev.box)).toBe(true);
  });

  it("命名了另一块板的 here，落在那块板的地皮上，不是叠在眼前这块板上", () => {
    const show = compile(tape(scene("B", 1000), line(SHORT, 1000), unnamed("别处的东西", "A"), scene("A", 1000)));
    const boxOf = [...show.props.values()][0].revisions[0].box;
    const cut = show.cues.find((c) => c.op.kind === "transition" && c.op.to === "A")!;
    // 它得在 B 的框外面——否则两块板堆在同一块平面上，随后那一刀把堆一起框进来。
    const standingOnB = show.cues.find((c) => c.op.kind === "transition" && c.op.to === "B")!;
    expect(contains(standingOnB.to, boxOf)).toBe(false);
    expect(contains(cut.to, boxOf)).toBe(true);
  });
});

/** 一个节拍里说“往右一屏，把新概念放在那儿”：东西要落在新框里。 */
describe("compile：here 落在这一拍说完时镜头看见的地方", () => {
  it("占位符先上、镜头后走，东西跟着走后的框，而不是走之前的", () => {
    const show = compile(tape(line("开场", 1000), unnamed("新概念"), slide("right", 1), line(SHORT, 1000)));
    const move = show.cues.find((c) => c.op.kind === "camera")!;
    const boxOf = [...show.props.values()][0].revisions[0].box;
    const cx = boxOf.x + boxOf.w / 2;
    const cy = boxOf.y + boxOf.h / 2;
    expect(cx).toBeGreaterThan(move.to.x);
    expect(cx).toBeLessThan(move.to.x + move.to.w);
    expect(cy).toBeGreaterThan(move.to.y);
    expect(cy).toBeLessThan(move.to.y + move.to.h);
  });

  it("同一帧里的第二个 here 让开一点，不正好压在第一个上", () => {
    const show = compile(tape(unnamed("一"), unnamed("二")));
    const [a, b] = [...show.props.values()].map((p) => p.revisions[0].box);
    expect(a.x).not.toBe(b.x);
  });
});

/** 一拍里连着要五格是骨架的正常写法：取模的让位会把第五格折回第一格。 */
describe("compile：同一帧里连着多个 here，一个都不许正好压在另一个上", () => {
  const laid = (n: number): Box[] =>
    [...compile(tape(...Array.from({ length: n }, (_, i) => unnamed(`p${i}`)))).props.values()].map((p) => p.revisions[0].box);

  it("六个落点六个位置（旧版第五、第六个折回第一、第二个）", () => {
    const spots = new Set(laid(6).map((b) => `${Math.round(b.x)},${Math.round(b.y)}`));
    expect(spots.size).toBe(6);
  });

  it("十二个也各不相同 —— 取模的坑不许换成另一个取模的坑", () => {
    const spots = new Set(laid(12).map((b) => `${Math.round(b.x)},${Math.round(b.y)}`));
    expect(spots.size).toBe(12);
  });

  it("落点永远在框里：让位不许让到画外去", () => {
    for (const b of laid(12)) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(VIEWPORT.w);
      expect(b.y + b.h).toBeLessThanOrEqual(VIEWPORT.h);
    }
  });

  it("只有一格时它就是镜头正中那一个：别把唯一的东西摆到偏位上", () => {
    const [only] = laid(1);
    expect(only.x + only.w / 2).toBe(VIEWPORT.w / 2);
    expect(only.y + only.h / 2).toBe(VIEWPORT.h / 2);
  });

  it("道具大到盖满整帧时不许飞出框外：没地方放就是没地方放，不装作有十六格", () => {
    const big = Array.from({ length: 9 }, (_, i) => ({
      kind: "build" as const,
      id: `b${i}`,
      box: { x: 0, y: 0, w: VIEWPORT.w, h: VIEWPORT.h },
      label: `b${i}`,
      here: true,
    }));
    for (const b of [...compile(tape(...big)).props.values()].map((p) => p.revisions[0].box)) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(VIEWPORT.w + 1);
      expect(b.y + b.h).toBeLessThanOrEqual(VIEWPORT.h + 1);
    }
  });

  it("界内的那一刀仍然算数：占位符排在镜头之前，就得跟着镜头走", () => {
    const ops: Op[] = [];
    for (let i = 0; i < 250; i++) ops.push(unnamed(`p${i}`));
    ops.push(slide("right", 1));
    const show = compile(tape(...ops, line("收住这一拍", 1000)));
    const move = show.cues.find((c) => c.op.kind === "camera")!;
    const boxOf = show.props.get("p0")!.revisions[0].box;
    expect(boxOf.x + boxOf.w / 2).toBeGreaterThan(move.to.x);
  });
});

/*
 * 解释器自己也不许是二次的。断的是**比值**不是秒数：机器快慢会飘，四倍输入应该是四倍时间，
 * 二次的话是十六倍 —— 那才是"标签页冻住"的形状，而它和具体哪台机器无关。
 *
 * 三条各守一处旧代码：一板的地皮以前每格道具重测一遍整板；`answer` 以前从头扫一遍卡表；
 * `here` 以前每格道具把身后的带读到底（这条旧版实测 40k 占位符 7.4 秒，而本版 0.2 秒）。
 */
describe("compile：一条长带付一次线性的价钱", () => {
  const entries = (n: number, mk: (i: number) => Op): OpEntry[] =>
    Array.from({ length: n }, (_, i) => ({ seq: i, track: "main" as const, turn: 0, op: mk(i) }));

  /** 取三次的最小值：GC 和别人的标签页只会让一次测量变慢，不会让它变快。带本身在外面建好，量的是解释器。 */
  const best = (list: OpEntry[]): number => {
    let out = Infinity;
    for (let k = 0; k < 3; k++) {
      const started = performance.now();
      compile(list);
      out = Math.min(out, performance.now() - started);
    }
    return out;
  };

  /**
   * 输入翻四倍，时间不许翻到二次的那个量级去。两边都取到几十毫秒以上，否则量的是计时器的
   * 分辨率和 GC 的抖动，不是这条带的形状。
   *
   * 这条下限以前是对着**固定条数**断的（`expect(a).toBeGreaterThan(10)`）。那一次把解释器改成
   * 线性之后，20k 条的 `每题一答` 在快机器上跑进了 10ms 以内 —— 于是守门的那一条自己开始翻：
   * 它红的时候说的不是"带变回二次的了"，而是"这台机器读得比阈值快"。下限是**测量**的要求，
   * 不是这条带的性质，所以让探针自己加长到跨过下限；跨过不了（长到封顶还是太快）就明说没量到，
   * 而不是假装量到了。比值仍然在同一个 `n` 上取，四倍输入对四倍输入。
   */
  const FLOOR_MS = 10;
  const linear = (mk: (i: number) => Op, small: number) => {
    let n = small;
    let a = best(entries(n, mk));
    while (a < FLOOR_MS && n < small * 16) {
      n *= 4;
      a = best(entries(n, mk));
    }
    if (a < FLOOR_MS) throw new Error(`量不到：${n} 条只用 ${a.toFixed(2)}ms，这台机器上读不出带的形状`);
    const b = best(entries(n * 4, mk));
    return b / a;
  };

  it("五万格道具：一板的地皮测一遍就够了，不是每格道具测一遍整板", () => {
    const bare = (i: number): Op => ({ kind: "build", id: `a${i}`, label: "l", box: { x: 0, y: 0, w: 10, h: 10 }, html: "<p>a</p>" });
    expect(linear(bare, 10_000)).toBeLessThan(9);
    // 去重不许改答案：这块板还是那一块板。
    const show = compile(entries(50_000, bare));
    expect(show.scenes.get("default")).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(show.props.size).toBe(50_000);
  });

  it("每题一答：回答按 seq 查卡，不从头扫一遍卡表", () => {
    const cards = (i: number): Op => (i % 2 === 0 ? ({ kind: "quiz", prompt: "几", options: ["1", "2"], answer: 1 } as Op) : ({ kind: "answer", gate: i - 1, text: "1" } as Op));
    expect(linear(cards, 20_000)).toBeLessThan(9);
    const show = compile(entries(8000, cards));
    expect(show.gates.length).toBe(4000);
    // 每一句回答都认到了自己那张卡 —— 这是 `gateBySeq` 的语义，不是它快不快。
    expect(show.gates.every((g) => g.said === "1")).toBe(true);
  });

  it("here 的 look-ahead 有界：不把整条带读一遍", () => {
    expect(linear((i) => unnamed(`p${i}`), 6_000)).toBeLessThan(9);
  });
});

/** 框住一切的那个函数：它是相机算术的入口，所以它自己不许是第二个被骗的。 */
describe("compile：unionBox 兜住没有画面的盒子", () => {
  it("十三万个盒子不许把栈压垮 —— 展开是栈上的参数表", () => {
    const boxes = Array.from({ length: 130_000 }, (_, i) => ({ x: i * 10, y: 0, w: 10, h: 10 }));
    expect(() => unionBox(boxes)).not.toThrow();
    expect(unionBox(boxes)).toEqual({ x: 0, y: 0, w: 1_300_000, h: 10 });
  });

  it("一个 NaN 的盒子被跳过，不是把整帧变成 NaN", () => {
    const good = { x: 100, y: 100, w: 300, h: 200 };
    expect(unionBox([good, { x: NaN, y: 0, w: 10, h: 10 }])).toEqual(good);
    // 全是坏的：回到一屏，因为 NaN 的一帧是观众看不见的板，不是"没有东西可框"。
    for (const junk of [{ x: 0, y: 0, w: NaN, h: 5 }, { x: 0, y: 0, w: Infinity, h: 5 }]) {
      expect(unionBox([junk])).toEqual(VIEWPORT);
    }
    // 没有东西可框仍然是 VIEWPORT，而不是一个 Infinity 的框：调用方直接拿它做除法。
    expect(unionBox([])).toStrictEqual(VIEWPORT);
  });
});
