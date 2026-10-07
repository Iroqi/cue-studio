import { describe, expect, it } from "vitest";
import { guardOp, guardScene3 } from "./guard";
import { compile, cueMs } from "./compile";
import { MAIN_TRACK, OpLog } from "./log";
import { displaced, motionOffset } from "./motion";
import type { BuildOp, Op, OpEntry } from "./types";

/*
 * These are not tests about a model behaving badly — the tool layer already argues with the model.
 * They are tests about a *recording*: a `#s=` link built by hand or mangled in transit, replayed with
 * no model in the loop. The interpreter is the thing being defended, so the assertions are made
 * against what the interpreter does with the op, not against what the guard returns.
 */

const box = { x: 100, y: 100, w: 300, h: 200 };

describe("guard：磁带也是输入", () => {
  it("别人录的 3-D 也过白名单：图元封顶、未知形状丢弃、脏颜色不认", () => {
    const spec = guardScene3({
      prims: [
        { shape: "tesseract" },
        { shape: "sphere", color: "url(#evil)", radius: 2 },
        { shape: "sphere", color: "#c39", radius: 2 },
        ...Array.from({ length: 5000 }, () => ({ shape: "box", size: 1e9 })),
      ],
      background: "#0a0a0a",
    });
    // 五千个图元喂给 WebGL 会把上下文烧掉，整块板跟着死：一个教具用不了这么多。
    expect(spec?.prims.length).toBeLessThanOrEqual(64);
    expect(spec?.prims.some((p) => (p.shape as string) === "tesseract")).toBe(false);
    expect(spec?.prims.filter((p) => p.shape === "sphere" && !p.color).length).toBe(1);
    expect(spec?.prims.find((p) => p.color === "#c39")).toBeTruthy();
    // 一块和板同色的“天空”是从 3-D 窗口偷渡进来的第二块板：丢掉，让舞台透出来。
    expect(spec?.background).toBeUndefined();
  });

  it("盒子里的 NaN 变成可读的默认，而不是让相机算出一个看不见的框", () => {
    const op = guardOp({
      kind: "build",
      id: "nan",
      box: { x: NaN, y: 0, w: 0, h: -5 },
      label: "nan",
      html: "<p>x</p>",
    } as Op) as BuildOp;
    expect(Number.isFinite(op.box.x)).toBe(true);
    expect(op.box.w).toBeGreaterThanOrEqual(1);
    expect(op.box.h).toBeGreaterThanOrEqual(1);
  });

  it("认不出的运动模式回到 oscillate：motionOffset 没有 default 分支，返回 undefined 会让整块板死掉", () => {
    const op = guardOp({
      kind: "motion",
      id: "a",
      mode: "levitate",
      axis: "diagonal",
      amp: 90,
      period: 1600,
      radius: 0,
      steps: 4,
      decay: 700,
      duration: 3000,
    } as unknown as Op) as Extract<Op, { kind: "motion" }>;
    expect(op.mode).toBe("oscillate");
    expect(op.axis).toBe("x");
    // 这条才是重点：解释器拿着这个 op 必须算得出一个位移。
    const off = motionOffset(op, 500);
    expect(Number.isFinite(off.dx)).toBe(true);
    expect(displaced(box, off).x).not.toBe(box.x);
  });

  it("时长不会被录成负数把时钟往回拨", () => {
    const op = guardOp({ kind: "narrate", text: "回来", duration: -1e9 } as Op);
    expect(op.kind === "narrate" && op.duration).toBe(0);
  });

  it("选择题不是一面按钮墙，答案不会指到没有的选项上", () => {
    const op = guardOp({
      kind: "quiz",
      prompt: "几？",
      options: Array.from({ length: 40 }, (_, i) => String(i)),
      answer: 999,
    } as Op) as Extract<Op, { kind: "quiz" }>;
    expect(op.options.length).toBeLessThanOrEqual(12);
    expect(op.answer).toBe(op.options.length - 1);
  });

  it("一个本来就好好的 op 原样出去——identity 是 show 自己在用的（loop.ts 靠 c.op === askedBy 找那一刀）", () => {
    const good: Op = { kind: "build", id: "ok", box, label: "ok", html: "<p>ok</p>", scene: "board" };
    expect(guardOp(good)).toBe(good);
    // 幂等：director 那条路已经过一次，磁带这条路再过一次不该把它改成另一个对象。
    expect(guardOp(guardOp(good))).toBe(good);
    // 省略号也要保住：没写板名的 recall 说的是"现在站的这块"，那是编译时的事，不是空字符串。
    const bare: Op = { kind: "recall", id: "ok", box };
    expect(guardOp(bare)).toBe(bare);
  });

  it("restore 之后磁带仍然能编译：坏字段被默认，好字段一个不丢", () => {
    const fixed = guardOp({ kind: "camera", mode: "pan", dir: "sideways", duration: 900 } as unknown as Op);
    expect(fixed.kind === "camera" && fixed.mode).toBe("pan");
    const stamp = guardOp({ kind: "camera", mode: "zoom", zoom: NaN, duration: 900 } as unknown as Op);
    expect(stamp.kind === "camera" && stamp.zoom).toBeUndefined();
  });
});

/**
 * 白名单真正的门在 log 上，不在 guard 里——两条进门的路都得过。
 */
describe("log：两条路都过同一道门", () => {
  const flooded = { kind: "build", id: "3d", box, label: "3d", scene3d: { prims: Array.from({ length: 5000 }, () => ({ shape: "box", size: 1e9 })) } };

  it("director 那条路（append）过门", () => {
    const log = new OpLog();
    log.append([flooded as unknown as Op], MAIN_TRACK);
    const op = log.ofTrack(MAIN_TRACK)[0].op as BuildOp;
    expect(op.scene3d!.prims.length).toBeLessThanOrEqual(64);
  });

  it("陌生人的链接那条路（restore）也过门——以前只有上一行这条路有门", () => {
    const log = new OpLog();
    // restore 是整卷替换，所以坏字段和半条记录都得一次喂进去。
    log.restore([
      { seq: 0, track: MAIN_TRACK, turn: 0, op: flooded as unknown as Op },
      { seq: 1, track: MAIN_TRACK, turn: 0, op: { kind: "narrate", text: 42 } as unknown as Op },
      { seq: 2 } as unknown as OpEntry,
    ]);
    const kept = log.ofTrack(MAIN_TRACK);
    expect((kept[0].op as BuildOp).scene3d!.prims.length).toBeLessThanOrEqual(64);
    // 门不把坏磁带整条丢掉：那是别人录的一节课，点链接的人没有犯错。
    expect(kept.length).toBe(2);
    // 不是字符串的台词被“当作没有”，不是被 String() 出来：磁带上的 42 不是一句话。
    expect(kept[1].op).toEqual({ kind: "narrate", text: "", duration: 2000 });
  });
});

/*
 * 第二件事：门以前只管"类型对不对"，没管"数量有没有边"。这两组测试都是从复现出来的缺陷写的，
 * 而且都断在解释器那一头 —— 不是断在 guard 返回了什么，是断在它拿去做的事还算不算数。
 */
describe("guard：门也得管数量", () => {
  it("一条旁白不许把时钟停在 317 年上", () => {
    const op = guardOp({ kind: "narrate", text: "短句", duration: 1e18 } as Op) as Extract<Op, { kind: "narrate" }>;
    expect(op.duration).toBeLessThanOrEqual(120_000);
    // 这才是要紧的：整场的长度是时间轴的 max， slider 走不动的课等于没有课。
    const show = compile([{ seq: 0, track: MAIN_TRACK, turn: 0, op }]);
    expect(show.duration).toBeLessThanOrEqual(120_000);
  });

  it("二十万字的台词被削短，因为 cueMs 是按字数往下 floor 的：那是 10.7 小时的舞台时间", () => {
    const op = guardOp({ kind: "narrate", text: "一".repeat(200_000), duration: 1000 } as Op) as Extract<Op, { kind: "narrate" }>;
    expect(op.text.length).toBeLessThanOrEqual(2000);
    expect(cueMs(op)).toBeLessThan(400_000);
  });

  it("一格坐标不许大到相机算不动：1e12 的框以前变成 w:1.2e12 的一刀", () => {
    const op = guardOp({
      kind: "build",
      id: "big",
      label: "big",
      box: { x: 1e12, y: 0, w: 1e12, h: 5 },
      html: "<p>a</p>",
    } as unknown as Op) as BuildOp;
    expect(Math.abs(op.box.x)).toBeLessThanOrEqual(200_000);
    expect(op.box.w).toBeLessThanOrEqual(40_000);
    const show = compile([
      { seq: 0, track: MAIN_TRACK, turn: 0, op },
      { seq: 1, track: MAIN_TRACK, turn: 0, op: { kind: "camera", mode: "fit", target: "big", duration: 900, easing: "ease" } as Op },
    ]);
    const to = show.cues[0].to;
    expect(Math.abs(to.x)).toBeLessThan(1e6);
    expect(to.w).toBeLessThan(1e6);
  });

  it("camera 点的名字要有上限：union 是用展开算的，130k 个名字以前是 RangeError 而不是一个坏镜头", () => {
    const op = guardOp({
      kind: "camera",
      mode: "fit",
      target: Array.from({ length: 130_000 }, (_, i) => `p${i}`),
      duration: 900,
      easing: "ease",
    } as unknown as Op) as Extract<Op, { kind: "camera" }>;
    expect(Array.isArray(op.target)).toBe(true);
    expect((op.target as string[]).length).toBeLessThanOrEqual(64);
    expect(() => compile([{ seq: 0, track: MAIN_TRACK, turn: 0, op }])).not.toThrow();
  });

  it("2.8MB 的 svg 进门就要削：DOMPurify 是先解析整棵子树再丢节点的", () => {
    const op = guardOp({ kind: "build", id: "s", label: "s", box, svg: `<svg>${"<rect/>".repeat(400_000)}</svg>` } as Op) as BuildOp;
    expect((op.svg ?? "").length).toBeLessThanOrEqual(200_000);
  });

  it("3-D 的尺寸是它自己那套单位：1e9 不是看不见，是把 far plane 拖到 6e10 上，之后整个窗口没有深度", () => {
    const spec = guardScene3({ prims: [{ shape: "sphere", radius: 1e9 }, { shape: "box", size: -1e9 }] });
    expect(spec!.prims[0].radius).toBeLessThanOrEqual(1000);
    expect(spec!.prims[1].size).toBeGreaterThanOrEqual(-1000);
  });

  it("pan 的 center 是平面上的坐标，不是 0..1 的比例 —— at 才是比例", () => {
    // 这两个字段长得一样、意思相反：以前 center 也走了 fraction()，于是要去 x=2400 的那一板被夹到 x:1。
    const toBoard = guardOp({ kind: "camera", mode: "pan", center: { x: 2400, y: 0 }, duration: 900, easing: "ease" } as unknown as Op) as Extract<Op, { kind: "camera" }>;
    expect(toBoard.center).toEqual({ x: 2400, y: 0 });
    const absurd = guardOp({ kind: "camera", mode: "pan", center: { x: 1e12, y: 0 }, duration: 900, easing: "ease" } as unknown as Op) as Extract<Op, { kind: "camera" }>;
    expect(Math.abs(absurd.center!.x)).toBeLessThanOrEqual(200_000);
    // 特写的锚点仍是比例：夹在框内才框得到东西。
    const closeup = guardOp({ kind: "camera", mode: "focus", target: "a", at: { x: 7, y: -3 }, duration: 900, easing: "ease" } as unknown as Op) as Extract<Op, { kind: "camera" }>;
    expect(closeup.at).toEqual({ x: 1, y: 0 });
  });

  it("motion 的位移要有边：它是纯函数，值本身没有归处，但 amp 会把道具推出整堂课", () => {
    const op = guardOp({ kind: "motion", id: "a", mode: "oscillate", axis: "both", amp: 1e12, period: 1e18, radius: -5, steps: 1e9, decay: 1, duration: 1e18 } as unknown as Op) as Extract<Op, { kind: "motion" }>;
    expect(Math.abs(op.amp)).toBeLessThanOrEqual(40_000);
    expect(op.period).toBeLessThanOrEqual(120_000);
    expect(op.radius).toBeGreaterThanOrEqual(0);
    expect(op.steps).toBeLessThanOrEqual(64);
    expect(op.duration).toBeLessThanOrEqual(120_000);
    expect(Number.isFinite(motionOffset(op, 1000).dx)).toBe(true);
  });

  it("一个本来就好好的 answer 原样出去（identity），坏的不得不在 gate 上是坏的", () => {
    const good: Op = { kind: "answer", gate: 3, text: "5N" };
    expect(guardOp(good)).toBe(good);
    // gate 是用 === 查的：非数字不是"松一点的数字"，是一句不属于任何题卡的回答。
    const junk = guardOp({ kind: "answer", gate: null, text: { evil: true } } as unknown as Op) as Extract<Op, { kind: "answer" }>;
    expect(typeof junk.gate).toBe("number");
    expect(junk.gate).toBe(-1);
    expect(typeof junk.text).toBe("string");
    // 过完门再编译：said 的契约是"字符串，或者还没答就是 null"，别的东西进来它就不该被填。
    const show = compile([
      { seq: 0, track: MAIN_TRACK, turn: 0, op: { kind: "quiz", prompt: "几？", options: ["3", "5"], answer: 1 } as Op },
      { seq: 1, track: MAIN_TRACK, turn: 0, op: junk },
    ]);
    expect(show.gates[0].said).toBeNull();
  });

  it("他的回答太长也要削短：那是回声里的一句话，不是档案的一页", () => {
    const op = guardOp({ kind: "answer", gate: 0, text: "啊".repeat(50_000) } as Op) as Extract<Op, { kind: "answer" }>;
    expect(op.text.length).toBeLessThanOrEqual(2000);
  });

  it("门不许把一堂正常的课改得面目全非：五分钟的骨架照样过", () => {
    const tape = [
      { kind: "build", id: "a", label: "向量 a", box: { x: 1200, y: -800, w: 900, h: 700 }, svg: `<svg>${"<path/>".repeat(500)}</svg>` } as Op,
      { kind: "narrate", text: "这是一条向量 a。它有长度，也有方向 —— 两样都算它的一部分。", duration: 6000 } as Op,
      { kind: "camera", mode: "pan", dir: "right", screens: 0.8, duration: 900, easing: "ease" } as Op,
      { kind: "transition", style: "dissolve", to: "第二板", duration: 1200 } as Op,
      { kind: "quiz", prompt: "合力是多少？", options: ["3N", "5N"], answer: 1, why: "首尾相接" } as Op,
      { kind: "answer", gate: 4, text: "5N" } as Op,
    ];
    const guarded = tape.map((op) => guardOp(op));
    guarded.forEach((op, i) => expect(op).toBe(tape[i]));
    expect(compile(guarded.map((op, seq) => ({ seq, track: MAIN_TRACK, turn: 0, op }))).duration).toBeGreaterThan(6000);
  });
});
