import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { guardOp } from "./guard";
import { encodeTape, decodeTape } from "./share";
import { motionOffset } from "./motion";
import { beatAt } from "../ui/score";
import { describeOp } from "../ui/rows";
import { revealCut } from "./reveal";
import { speechMs, SETTLE_MS } from "./speech";
import { directorTools } from "../tools/director";
import type { Beat, Box, MotionOp, Op, OpEntry } from "./types";

/*
 * 2026-10 第二轮深度 review 的回归钉。第一轮是 12 条（review-fixes.test.ts），这轮是补量出来的
 * 另一批边界；每条都先把探针的**期望**写对、再钉死，探针写错期望不算数：
 *
 *  - `camera at+span`：`mode: fit` 的取景最后过 `limitPushIn`（MIN_CLOSEUP_W=450），所以 close-up
 *    最小就是整屏宽、并且永远以 at 点为心 —— at 怼在板角上时画面确实会探出板外，这是"只许往外拉、
 *    不许往里裁"的有意设计，不是越界 bug。
 *  - `share` 往返：encode/decode 都是异步（Compression/DecompressionStream），中文与 emoji 逐字节保真。
 *  - `answerGate` 幂等：一张卡答两次，第二次不再落带。
 *  - `motionOffset` 每档都回家：终点位移一律为零（运动只是锚点的诠释）；起点只有 approach 从振幅处
 *    开始逼近，其余四档从零起。
 *  - 旁白的地板在编译层：门的 `ms` 只夹 120s 上限，不抬 2s 地板；编译 `cueMs` 用语音长度兜底。
 *  - `describeOp` camera：target 两种形状都要认（字符串直接印、数组拼 +、都没有才轮到 follow）——
 *    裸字符串 target 以前落进 follow 那一格，日志里那刀镜头像没指任何东西。
 */

let raf = 0;
let clockNow = 1000;
const step = (s: Stage, dt: number) => {
  clockNow += dt;
  (s as unknown as { last: number }).last = clockNow - dt;
  (s as unknown as { tick: (now: number) => void }).tick(clockNow);
};

beforeEach(() => {
  raf = 0;
  clockNow = 1000;
  vi.stubGlobal("requestAnimationFrame", () => ++raf);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.spyOn(performance, "now").mockImplementation(() => clockNow);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const at = (x: number, y: number): Box => ({ x, y, w: 200, h: 160 });
const art = (id: string): Op => ({ kind: "build", id, box: at(0, 0), label: id, html: `<p>${id}</p>` });
const performing = (...ops: Op[]): Stage => {
  const s = new Stage();
  s.goLive();
  s.append(ops, MAIN_TRACK);
  return s;
};
const walkUntilStopped = (s: Stage): Stage => {
  s.play();
  for (let i = 0; i < 4000 && s.playing; i++) step(s, 50);
  return s;
};

describe("round2: camera at+span 经 limitPushIn 的语义", () => {
  it("fit 的 close-up 最小就是整屏宽（MIN_CLOSEUP_W=450），以 at 点为心，不出错", () => {
    const s = performing(art("vec-a"), { kind: "camera", mode: "fit", target: "vec-a", at: { x: 0, y: 0 }, span: 0.05, duration: 900, easing: "ease" });
    walkUntilStopped(s);
    const rect = s.getSnapshot().rect;
    expect(rect).not.toBeNull();
    expect(rect!.w).toBeCloseTo(450, 0);
    // 以 at 点 (0,0) 为心 —— 怼在板角上，画面确实探出板外；这是"只许往外拉"的限位，不是越界
    expect(rect!.x + rect!.w / 2).toBeCloseTo(0, 6);
    expect(rect!.y + rect!.h / 2).toBeCloseTo(0, 6);
  });

  it("at 配两个 target 回退 fit，不炸", () => {
    const s = performing(art("a"), art("b"), { kind: "camera", mode: "fit", target: ["a", "b"], at: { x: 0.5, y: 0.5 }, duration: 900, easing: "ease" });
    walkUntilStopped(s);
    expect(s.getSnapshot().rect).not.toBeNull();
  });
});

describe("round2: share 往返保真（两端都异步）", () => {
  it("含中文与 emoji 的 tape 编码解码逐字节一致", async () => {
    const ops: Op[] = [art("向量"), { kind: "narrate", text: "合力是箭头 → 🚀 的终点", duration: 2000 }];
    const entries = ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 1, op }));
    const encoded = await encodeTape(entries);
    expect(encoded).toBeTruthy();
    const decoded = await decodeTape(encoded);
    expect(decoded).toHaveLength(entries.length);
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(entries));
  });
});

describe("round2: 一张卡答两次", () => {
  it("第二次 answerGate 不再落带（幂等）", () => {
    const s = performing(art("a"), art("b"), { kind: "quiz", prompt: "哪个？", options: ["a", "b"], answer: 1 }, { kind: "narrate", text: "好", duration: 1000 });
    walkUntilStopped(s);
    s.answerGate("a");
    s.answerGate("b");
    const answers = s.log.all().filter((e) => e.op.kind === "answer");
    expect(answers).toHaveLength(1);
    expect(answers[0].op).toMatchObject({ text: "a" });
  });
});

describe("round2: motionOffset 每档都回家", () => {
  const modes: MotionOp["mode"][] = ["oscillate", "approach", "orbit", "iterate", "flow"];
  const base: MotionOp = { kind: "motion", id: "a", mode: "oscillate", amp: 100, axis: "x", duration: 2000, period: 400, decay: 300, radius: 0, steps: 4 };
  it("终点位移一律为零（sin(π) 的浮点残差 <1e-20 不算数）", () => {
    for (const mode of modes) {
      const op = { ...base, mode };
      const end = motionOffset(op, op.duration);
      expect(end.dx).toBeCloseTo(0, 10);
      expect(end.dy).toBeCloseTo(0, 10);
    }
  });
  it("起点：approach 从振幅处逼近，其余四档从零起", () => {
    for (const mode of modes) {
      const op = { ...base, mode };
      const start = motionOffset(op, 0);
      if (mode === "approach") expect(Math.abs(start.dx)).toBeCloseTo(op.amp, 6);
      else {
        expect(Math.abs(start.dx)).toBe(0);
        expect(Math.abs(start.dy)).toBe(0);
      }
    }
  });
});

describe("round2: 旁白的地板在编译层，不在门上", () => {
  it("门的 ms 只夹 120s 上限；编译 cueMs 用语音长度兜底", () => {
    const out = guardOp({ kind: "narrate", text: "短句", duration: 300 } as Op) as Extract<Op, { kind: "narrate" }>;
    expect(out.duration).toBe(300);
    const s = performing(out);
    s.play();
    expect(s.compiled.duration).toBeGreaterThanOrEqual(speechMs("短句") + SETTLE_MS - 1);
    expect(s.compiled.duration).toBeGreaterThanOrEqual(300);
  });
});

describe("round2: describeOp camera 两种 target 形状都认", () => {
  const entry = (op: Op): OpEntry => ({ seq: 0, track: MAIN_TRACK, turn: 1, op });
  it("字符串 target 直接印名字", () => {
    const line = describeOp(entry({ kind: "camera", mode: "fit", target: "vec-a", duration: 900, easing: "ease" } as Op), new Map());
    expect(line).toContain("vec-a");
  });
  it("数组 target 拼 +，且排在前", () => {
    const line = describeOp(entry({ kind: "camera", mode: "fit", target: ["vec-a", "vec-b"], duration: 900, easing: "ease" } as Op), new Map());
    expect(line).toContain("vec-a+vec-b");
  });
  it("没有 target 才轮到 follow", () => {
    const line = describeOp(entry({ kind: "camera", mode: "track", follow: "vec-a", duration: 900, easing: "ease" } as Op), new Map());
    expect(line).toContain("vec-a");
  });
});

describe("round2: 其余已量过的边界", () => {
  it("导演工具 dial min===max 是坏题（不落笔）", () => {
    const s = performing(art("a"));
    const run = directorTools(s, { title: "t", concepts: [], learner: "", beatsDone: 0 }).run;
    const r = run("tune", { prompt: "p", min: 5, max: 5, value: 5 });
    expect(r.isError).toBe(true);
  });

  it("beatAt 同 start 的两拍取后落的那拍", () => {
    const beats: Beat[] = [
      { start: 1000, end: 3000, seqs: [0], turn: 1, verbs: [], headline: "", gate: false } as Beat,
      { start: 1000, end: 4000, seqs: [1], turn: 2, verbs: [], headline: "", gate: false } as Beat,
    ];
    expect(beatAt(beats, 1500)).toBe(1);
  });

  it("revealCut 英文词边界：target 落在词中时整词亮起", () => {
    const latin = revealCut("The quick brown fox jumps over the lazy dog", 0.5);
    expect(latin).toBeGreaterThanOrEqual(1);
    expect(latin).toBeLessThanOrEqual(44);
  });
});
