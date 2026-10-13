import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { guardOp } from "./guard";
import { directorTools } from "../tools/director";
import type { Op, TypeOp } from "./types";

const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });
const type = (over: Partial<TypeOp> = {}): Op =>
  ({ kind: "type", prompt: "用一句话说清楚：什么是导数？", accept: ["瞬时", "变化率"], ...over }) as TypeOp;

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

describe("type：让他自己打出那个术语，而不是在选项里认出来", () => {
  it("落成一张停表的卡，和 quiz / probe / dial 同本账", () => {
    const s = performing(type(), line("好，接着讲", 1000));
    expect(s.compiled.gates).toHaveLength(1);
    const g = s.compiled.gates[0];
    expect(g.kind).toBe("type");
    expect((g.op as TypeOp).accept).toEqual(["瞬时", "变化率"]);
    expect(s.compiled.duration).toBeGreaterThan(1000);
  });

  it("时钟停在 type 上，他提交的那句话原样作为 answer 落在带上", () => {
    const s = performing(type(), line("好", 1000));
    walkUntilStopped(s);
    expect(s.getSnapshot().gate?.kind).toBe("type");
    s.answerGate("导数是那一瞬间的变化率");
    const onTape = s.log.all().filter((e) => e.op.kind === "answer");
    expect(onTape).toHaveLength(1);
    expect(onTape[0].op).toMatchObject({ gate: s.compiled.gates[0].seq, text: "导数是那一瞬间的变化率" });
    expect(s.compiled.gates[0].said).toBe("导数是那一瞬间的变化率");
  });

  it("录像（别人上的带）不再问人：回放时 type 不是一张开着的卡", () => {
    const s = new Stage();
    s.load([type()].map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op })));
    walkUntilStopped(s);
    expect(s.getSnapshot().live).toBe(false);
    expect(s.getSnapshot().gate).toBeNull();
  });
});

describe("门对 type 的管", () => {
  it("accept 去空、去重义、封顶，不整卷拒绝", () => {
    const notes: string[] = [];
    const out = guardOp(
      { kind: "type", prompt: "?", accept: ["", "瞬时", "瞬时", "平均", ...Array(40).fill("x")] } as TypeOp,
      (n) => notes.push(n),
    ) as TypeOp;
    expect(out.accept.length).toBeLessThanOrEqual(8);
    expect(out.accept.every((w) => w.length > 0)).toBe(true);
  });

  it("accept 一个可读的词都没有，退成空表而不是造出一张没有对的可能的卡", () => {
    const out = guardOp({ kind: "type", prompt: "?" } as TypeOp) as TypeOp;
    expect(out.accept).toEqual([]);
  });
});

describe("导演工具 type 的回执", () => {
  const run = () => directorTools(performing(), { title: "t", concepts: [], learner: "", beatsDone: 0 }).run;

  it("accept 空表不成题", () => {
    const r = run()("type", { prompt: "说一下什么是导数", accept: [] });
    expect(r.isError).toBe(true);
    expect(r.ops).toHaveLength(0);
  });

  it("accept 超过 8 个不成题", () => {
    const r = run()("type", { prompt: "说一下", accept: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] });
    expect(r.isError).toBe(true);
  });

  it("一张好卡回执以 question queued 开头", () => {
    const r = run()("type", { prompt: "用一句话说清楚：什么是导数？", accept: ["瞬时", "变化率"], avoid: ["平均"], concept: "导数是瞬时变化率" });
    expect(r.isError).not.toBe(true);
    expect(r.result.startsWith("question queued")).toBe(true);
    expect(r.ops[0]).toMatchObject({ kind: "type", accept: ["瞬时", "变化率"] });
  });
});
