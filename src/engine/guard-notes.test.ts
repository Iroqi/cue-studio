import { describe, expect, it } from "vitest";
import { guardOp } from "./guard";
import { MAIN_TRACK, OpLog } from "./log";
import { Stage } from "./runtime";
import type { Op } from "./types";

/*
 * 门拦下来的东西，导演得知道：Intelligent UI 的编译器把非法属性记成 diagnostics，可模型看不到，
 * 于是同样的错后面继续犯 —— 这一仓库的门（`guardOp`）以前是同一个形状：改得静悄悄，回执说
 * "built X"。这一件给门挂一个听筒：只报真修正（给了却被截断/夹回/回退/丢弃），缺省不算
 * （`mode` 缺省 fit 是导演没给，不是门改了它）；带子一个字都不进；restore 门外没有人。
 */

const hear = () => {
  const out: string[] = [];
  const fn = (n: string) => out.push(n);
  return { out, fn };
};

const long = (n: number) => "长".repeat(n);

describe("形状：门改了什么，就报什么", () => {
  it("脏的 narrate：两处修正，两条笔记，措辞钉死", () => {
    const { out, fn } = hear();
    const op = guardOp({ kind: "narrate", text: long(2100), duration: 1e18 } as Op, fn);
    expect((op as { text: string }).text.length).toBe(2000);
    expect((op as { duration: number }).duration).toBe(120000);
    expect(out).toEqual(["narrate.text 超过 2000 字，截到 2000 字", "narrate.duration 越界，夹回 120000ms"]);
  });

  it("motion 不认的模式与轴、quiz 越界的答案都报", () => {
    const { out, fn } = hear();
    guardOp({ kind: "motion", id: "a", mode: "levitate", axis: "diagonal", amp: 90, period: 1600, radius: 0, steps: 4, decay: 700, duration: 3000 } as unknown as Op, fn);
    expect(out).toEqual(["motion.mode=levitate 不认，回退 oscillate", "motion.axis=diagonal 不认，回退 x"]);
    const { out: o2, fn: f2 } = hear();
    guardOp({ kind: "quiz", prompt: "p", options: ["a", "b"], answer: 7 } as Op, f2);
    expect(o2).toEqual(["quiz.answer 越界，夹回 1"]);
  });

  it("干净的一刀原样出去（同一引用），一个字也不说", () => {
    const { out, fn } = hear();
    const clean: Op = { kind: "narrate", text: "说话", duration: 2000 };
    const op = guardOp(clean, fn);
    expect(op).toBe(clean);
    expect(out).toEqual([]);
  });

  it("修过的 op 再进门，没有第二句话（幂等）", () => {
    const { fn: f1 } = hear();
    const fixed = guardOp({ kind: "narrate", text: long(2100), duration: 1e18 } as Op, f1);
    const { out, fn } = hear();
    const again = guardOp(fixed, fn);
    expect(again).toBe(fixed);
    expect(out).toEqual([]);
  });

  it("带 notes 与不带 notes，门吐出来的东西一模一样", () => {
    const dirty = { kind: "camera", mode: "levitate", at: { x: 2, y: -1 }, duration: 1e9 } as unknown as Op;
    const { fn } = hear();
    expect(guardOp(dirty, fn)).toEqual(guardOp(dirty));
  });

  it("scene3d 的修正也上报：图元封顶、与板同色背景被丢", () => {
    const { out, fn } = hear();
    guardOp(
      {
        kind: "build",
        id: "a",
        box: { x: 0, y: 0, w: 100, h: 100 },
        label: "a",
        scene3d: { prims: Array.from({ length: 5000 }, () => ({ shape: "box", size: 1e9 })), background: "#0a0a0a" },
      } as unknown as Op,
      fn,
    );
    expect(out.join("；")).toContain("build.scene3d 图元 5000 → 64");
    expect(out.join("；")).toContain("build.scene3d background 与板同色");
  });

  it("answer 的 gate 不是整数，作答不属于任何卡，要说", () => {
    const { out, fn } = hear();
    guardOp({ kind: "answer", gate: 1.5, text: "我觉得是 A" } as Op, fn);
    expect(out).toEqual(["answer.gate 不是整数，作答不属于任何卡"]);
  });
});

describe("价钱：诊断是修正的副产品，不是批量的税", () => {
  it("一百格干净的带子，一次也报不了一句", () => {
    const log = new OpLog();
    const { out, fn } = hear();
    log.append(
      Array.from({ length: 100 }, (_, i) => ({ kind: "build", id: `p${i}`, box: { x: i, y: 0, w: 100, h: 80 }, label: `p${i}`, svg: "<svg/>" })),
      MAIN_TRACK,
      fn,
    );
    expect(out).toEqual([]);
  });

  it("一百格里只有三格脏，就只报那三格的账，与批量大小无关", () => {
    const log = new OpLog();
    const { out, fn } = hear();
    const ops: Op[] = [];
    for (let i = 0; i < 100; i++) {
      if (i === 10) ops.push({ kind: "narrate", text: long(2100), duration: 2000 });
      else if (i === 50) ops.push({ kind: "motion", id: "a", mode: "levitate", axis: "x", amp: 90, period: 1600, radius: 0, steps: 4, decay: 700, duration: 3000 } as unknown as Op);
      else if (i === 90) ops.push({ kind: "quiz", prompt: "p", options: ["a", "b"], answer: 7 });
      else ops.push({ kind: "beat", duration: 600 });
    }
    log.append(ops, MAIN_TRACK, fn);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("narrate.text");
    expect(out[1]).toContain("motion.mode");
    expect(out[2]).toContain("quiz.answer");
  });

  it("别人录的带子进门（restore），门外没有人：诊断一个字也不离开门", () => {
    const log = new OpLog();
    const { out, fn } = hear();
    log.restore([{ seq: 0, track: MAIN_TRACK, turn: 0, op: { kind: "narrate", text: long(2100), duration: 1e18 } } as never]);
    // restore 没有听筒参数；之后落一笔干净 op，听筒只听见这一笔的账（一句也没有）。
    log.append([{ kind: "beat", duration: 600 }], MAIN_TRACK, fn);
    expect(out).toEqual([]);
  });
});

describe("护栏：诊断永远不进带子，听筒只长在 append 那扇门", () => {
  it("同一批 op，带不带听筒，落下的带子逐格相等，序列化后一个诊断字都不含", () => {
    const a = new OpLog();
    const b = new OpLog();
    const { out, fn } = hear();
    const ops: Op[] = [{ kind: "narrate", text: long(2100), duration: 1e18 } as Op, { kind: "beat", duration: 600 }];
    a.append(ops, MAIN_TRACK);
    b.append(ops, MAIN_TRACK, fn);
    expect(out.length).toBeGreaterThan(0);
    expect(a.tape).toEqual(b.tape);
    expect(a.tape.length).toBe(2);
    const serialized = JSON.stringify(a.tape);
    expect(serialized).not.toContain("门拦下");
    expect(serialized).not.toContain("截到");
  });

  it("Stage.append 那条整路：脏 op 落下，修正照旧，诊断从听筒出来", () => {
    const s = new Stage();
    const { out, fn } = hear();
    s.append([{ kind: "narrate", text: long(2100), duration: 1e18 } as Op], MAIN_TRACK, fn);
    const entry = s.log.tape[0];
    expect((entry.op as { text: string }).text.length).toBe(2000);
    expect(out).toEqual(["narrate.text 超过 2000 字，截到 2000 字", "narrate.duration 越界，夹回 120000ms"]);
  });
});
