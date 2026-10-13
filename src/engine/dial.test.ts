import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { guardOp } from "./guard";
import { directorTools } from "../tools/director";
import type { DialOp, Op } from "./types";

const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });
const dial = (over: Partial<DialOp> = {}): Op =>
  ({ kind: "dial", prompt: "先凭直觉拨一下：这个频率是多少？", min: 0, max: 100, value: 42, tol: 5, unit: "Hz", ...over }) as DialOp;

/** The rAF re-arm is not under test; the clock step is driven by hand, as in the probe suite. */
let clockNow = 1000;
const step = (s: Stage, dt: number) => {
  clockNow += dt;
  (s as unknown as { last: number }).last = clockNow - dt;
  (s as unknown as { tick: (now: number) => void }).tick(clockNow);
};

beforeEach(() => {
  clockNow = 1000;
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.spyOn(performance, "now").mockImplementation(() => clockNow);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

describe("dial：让他自己拨一个数，而不是读一串选项或点一个现成形状", () => {
  it("落成一张停表的卡，和 quiz / probe 同本账", () => {
    const s = performing(dial(), line("好，接着讲", 1000));
    expect(s.compiled.gates).toHaveLength(1);
    const g = s.compiled.gates[0];
    expect(g.kind).toBe("dial");
    expect((g.op as DialOp).min).toBe(0);
    expect((g.op as DialOp).max).toBe(100);
    expect((g.op as DialOp).value).toBe(42);
    // The card does not own the clock, like a quiz: the line after it still speaks.
    expect(s.compiled.duration).toBeGreaterThan(1000);
  });

  it("时钟停在 dial 上，他确认的那个数作为 answer 落在带上", () => {
    const s = performing(dial(), line("好", 1000));
    walkUntilStopped(s);
    expect(s.getSnapshot().gate?.kind).toBe("dial");
    // He drags to 38 and confirms: the number he confirmed is what goes on the tape, as text.
    s.answerGate("38");
    const onTape = s.log.all().filter((e) => e.op.kind === "answer");
    expect(onTape).toHaveLength(1);
    expect(onTape[0].op).toMatchObject({ gate: s.compiled.gates[0].seq, text: "38" });
    expect(s.compiled.gates[0].said).toBe("38");
  });

  it("录像（别人上的带）不再问人：回放时 dial 不是一张开着的卡", () => {
    const s = new Stage();
    s.load([dial()].map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op })));
    walkUntilStopped(s);
    expect(s.getSnapshot().live).toBe(false);
    expect(s.getSnapshot().gate).toBeNull();
  });
});

describe("门对 dial 的管", () => {
  it("上下颠倒的区间被交换，空区间被撑开，而不是打出一根拨不动的杆", () => {
    const notes: string[] = [];
    const out = guardOp({ kind: "dial", prompt: "?", min: 100, max: 0, value: 50, tol: 10 } as DialOp, (n) => notes.push(n)) as DialOp;
    expect(out.min).toBe(0);
    expect(out.max).toBe(100);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("正确值落在区间外被夹回区间内，容差为负被归零", () => {
    const out = guardOp({ kind: "dial", prompt: "?", min: 0, max: 10, value: 999, tol: -3 } as DialOp) as DialOp;
    expect(out.value).toBe(10);
    expect(out.tol).toBe(0);
  });

  it("吞掉整段的容差被夹到半段", () => {
    const out = guardOp({ kind: "dial", prompt: "?", min: 0, max: 100, value: 50, tol: 999 } as DialOp) as DialOp;
    expect(out.tol).toBe(50);
  });

  it("坏数字不整卷拒绝：缺字段退回可读默认", () => {
    const out = guardOp({ kind: "dial", prompt: "?" } as DialOp) as DialOp;
    expect(Number.isFinite(out.min)).toBe(true);
    expect(Number.isFinite(out.max)).toBe(true);
    expect(out.min < out.max).toBe(true);
  });
});

describe("导演工具 tune 的回执", () => {
  const run = () => directorTools(performing(), { title: "t", concepts: [], learner: "", beatsDone: 0 }).run;

  it("区间不倒挂、正确值落得进，才成题", () => {
    const r = run()("tune", { prompt: "估一下频率", min: 100, max: 0, value: 50 });
    expect(r.isError).toBe(true);
    expect(r.ops).toHaveLength(0);
  });

  it("正确值落在区间外就是坏题", () => {
    const r = run()("tune", { prompt: "估一下频率", min: 0, max: 100, value: 150 });
    expect(r.isError).toBe(true);
  });

  it("非数字不成题", () => {
    const r = run()("tune", { prompt: "估", min: "x", max: 100, value: 50 });
    expect(r.isError).toBe(true);
  });

  it("一张好卡回执以 question queued 开头，主循环据此停表等拨杆", () => {
    const r = run()("tune", { prompt: "先凭直觉拨一下：劲度系数大概多少？", min: 0, max: 200, value: 80, tol: 10, unit: "N/m", concept: "弹簧越硬 k 越大" });
    expect(r.isError).not.toBe(true);
    expect(r.result.startsWith("question queued")).toBe(true);
    expect(r.ops[0]).toMatchObject({ kind: "dial", value: 80, tol: 10 });
  });
});
