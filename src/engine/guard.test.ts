import { describe, expect, it } from "vitest";
import { guardOp, guardScene3 } from "./guard";
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
