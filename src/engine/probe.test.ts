import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { guardOp } from "./guard";
import { directorTools } from "../tools/director";
import type { Box, Op, ProbeOp } from "./types";

const at = (x: number, y: number): Box => ({ x, y, w: 200, h: 160 });
const art = (id: string): Op => ({ kind: "build", id, box: at(0, 0), label: id, html: `<p>${id}</p>` });
const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });
const probe = (targets: string[], answer: string): Op =>
  ({ kind: "probe", prompt: "点一下：哪个是合力？", targets, answer }) as ProbeOp;

/** The rAF re-arm is not under test; the clock step is driven by hand, as in the answer suite. */
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

describe("probe：让他点台上的那个图形，而不是读一张文字卡", () => {
  it("落成一张停表的卡，和 quiz 同本账", () => {
    const s = performing(art("vec-a"), art("vec-b"), probe(["vec-a", "vec-b"], "vec-b"), line("好，接着讲", 1000));
    expect(s.compiled.gates).toHaveLength(1);
    const g = s.compiled.gates[0];
    expect(g.kind).toBe("probe");
    expect((g.op as ProbeOp).targets).toEqual(["vec-a", "vec-b"]);
    expect((g.op as ProbeOp).answer).toBe("vec-b");
    // The card does not own the clock, like a quiz: the line after it still speaks.
    expect(s.compiled.duration).toBeGreaterThan(1000);
  });

  it("时钟停在 probe 上，他点中哪个道具，哪个 id 就作为 answer 落在带上", () => {
    const s = performing(art("vec-a"), art("vec-b"), probe(["vec-a", "vec-b"], "vec-b"), line("好", 1000));
    walkUntilStopped(s);
    expect(s.getSnapshot().gate?.kind).toBe("probe");
    // He taps the wrong one on purpose: the id he tapped is what goes on the tape.
    s.answerGate("vec-a");
    const onTape = s.log.all().filter((e) => e.op.kind === "answer");
    expect(onTape).toHaveLength(1);
    expect(onTape[0].op).toMatchObject({ gate: s.compiled.gates[0].seq, text: "vec-a" });
    expect(s.compiled.gates[0].said).toBe("vec-a");
  });

  it("录像（别人上的带）不再问人：回放时 probe 不是一张开着的卡", () => {
    // `load()` is the path a shared/imported tape takes: it comes in as a recording, live=false.
    const ops: Op[] = [art("a"), art("b"), probe(["a", "b"], "b")];
    const s = new Stage();
    s.load(ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op })));
    walkUntilStopped(s);
    expect(s.getSnapshot().live).toBe(false);
    expect(s.getSnapshot().gate).toBeNull();
  });
});

describe("门对 probe 的两重管", () => {
  it("超长的 targets 与坏 id 被夹回可读，不整卷拒绝", () => {
    const notes: string[] = [];
    const out = guardOp(
      {
        kind: "probe",
        prompt: "x",
        targets: ["ok", "ok", "", Array(300).fill("y").join("")],
        answer: "",
      } as ProbeOp,
      (n) => notes.push(n),
    ) as ProbeOp;
    // Duplicates dropped, the giant name truncated to MAX_NAME, empty ids gone.
    expect(out.targets.every((t) => t.length <= 120)).toBe(true);
    expect(new Set(out.targets).size).toBe(out.targets.length);
    expect(out.targets.length).toBeLessThanOrEqual(64);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("缺 targets/answer 时退成空表，而不是造出一张没有可点目标的卡", () => {
    const out = guardOp({ kind: "probe", prompt: "?" } as ProbeOp) as ProbeOp;
    expect(out.targets).toEqual([]);
    expect(typeof out.answer).toBe("string");
  });
});

describe("导演工具 point_at 的回执", () => {
  const toolsFor = (...ops: Op[]) => {
    const s = performing(...ops);
    return directorTools(s, { title: "t", concepts: [], learner: "", beatsDone: 0 }).run;
  };

  it("台上没有的目标不落笔", () => {
    const run = toolsFor(art("vec-a"), art("vec-b"));
    const r = run("point_at", { prompt: "哪个是合力？", targets: ["vec-a", "ghost"], answer: "vec-a" });
    expect(r.isError).toBe(true);
    expect(r.ops).toHaveLength(0);
  });

  it("正确答案不在可点目标里就是坏题", () => {
    const run = toolsFor(art("vec-a"), art("vec-b"));
    const r = run("point_at", { prompt: "哪个是合力？", targets: ["vec-a", "vec-b"], answer: "vec-z" });
    expect(r.isError).toBe(true);
    expect(r.ops).toHaveLength(0);
  });

  it("少于两个目标不成题", () => {
    const run = toolsFor(art("vec-a"));
    const r = run("point_at", { prompt: "哪个？", targets: ["vec-a"], answer: "vec-a" });
    expect(r.isError).toBe(true);
  });

  it("一张好卡回执以 question queued 开头，主循环据此停表等点选", () => {
    const run = toolsFor(art("vec-a"), art("vec-b"), art("vec-r"));
    const r = run("point_at", { prompt: "点一下：哪个是合力？", targets: ["vec-a", "vec-b", "vec-r"], answer: "vec-r", concept: "合力是对角端点" });
    expect(r.isError).not.toBe(true);
    expect(r.result.startsWith("question queued")).toBe(true);
    expect(r.ops[0]).toMatchObject({ kind: "probe", answer: "vec-r" });
  });
});
