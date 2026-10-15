// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { guardOp } from "./guard";
import { directorTools } from "../tools/director";
import { DEFAULT_CONFIG, getModels, setScriptedResponses } from "../llm/llm";
import { Teacher, ESC_RETRY } from "../agent/loop";
import { scoreOf } from "../ui/score";
import App from "../App";
import type { DragOp, Op, OpEntry } from "./types";

/*
 * 第五张卡（Intelligent UI 的 direct manipulation / editable charts）：前四张考"认 / 估 / 说"——
 * 读选项、点现成形状、拨一根杆、打一行字；这一张考**做**。他亲手把台上的一件道具搬到目标位置、
 * 确认，落带的答案是他确认那一刻的那个位置（"x,y" 世界单位，道具中心的坐标），判分按直线距离。
 *
 * 三层照旧分开钉：搬得成不成（形状）、搬动一分钱不加（价钱）、把任何一刀画错都红（护栏）。
 */

const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });
const prop = (over: Partial<{ x: number; y: number; w: number; h: number }> = {}): Op =>
  ({ kind: "build", id: "vec-b", label: "向量 b", box: { x: 100, y: 100, w: 200, h: 100, ...over }, html: "<p>b</p>" }) as Op;
const drag = (over: Partial<DragOp> = {}): Op =>
  ({ kind: "drag", prompt: "把 b 的头搬到 a 的头上", prop: "vec-b", value: { x: 480, y: 300 }, tol: 60, concept: "向量加法是首尾相接", ...over }) as DragOp;

/** The rAF re-arm is not under test; the clock step is driven by hand, as in the dial/probe suites. */
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
const answersOn = (s: Stage): OpEntry[] => s.log.all().filter((e) => e.op.kind === "answer");

describe("drag：让他亲手把台上的道具搬到该在的位置，而不是读选项/点形状/拨杆/打字", () => {
  it("落成一张停表的卡：kind、prop、目标位置、容差都在，后面的旁白仍然要讲", () => {
    const s = performing(drag(), line("好，接着讲", 1000));
    expect(s.compiled.gates).toHaveLength(1);
    const g = s.compiled.gates[0];
    expect(g.kind).toBe("drag");
    expect((g.op as DragOp).prop).toBe("vec-b");
    expect((g.op as DragOp).value).toEqual({ x: 480, y: 300 });
    expect((g.op as DragOp).tol).toBe(60);
    // The card does not own the clock, like a quiz: the line after it still speaks.
    expect(s.compiled.duration).toBeGreaterThan(1000);
  });

  it("时钟停在 drag 上，他确认的那个位置作为 answer 落在带上", () => {
    const s = performing(drag(), line("好", 1000));
    walkUntilStopped(s);
    expect(s.getSnapshot().gate?.kind).toBe("drag");
    // He drags the prop so its centre lands at (380, 240) and confirms: that is the answer, as text.
    s.answerGate("380,240");
    const onTape = answersOn(s);
    expect(onTape).toHaveLength(1);
    expect(onTape[0].op).toMatchObject({ gate: s.compiled.gates[0].seq, text: "380,240" });
    expect(s.compiled.gates[0].said).toBe("380,240");
  });

  it("录像（别人上的带）不再问人：回放时 drag 不是一张开着的卡，台上没有可搬的东西", () => {
    const s = new Stage();
    s.load(
      [prop(), drag(), { kind: "answer" as const, gate: 1, text: "380,240" }, line("好，接着讲", 1000)].map((op, i) => ({
        seq: i,
        track: MAIN_TRACK,
        turn: 0,
        op,
      })),
    );
    // 不 walk：卡的那一拍在带子开头，走到带尾它已经过场（said 只陪它那一拍）。开场那一刻读得到。
    expect(s.getSnapshot().live).toBe(false);
    expect(s.getSnapshot().gate).toBeNull();
    // A recording asks no one: his answer is read from the tape, not re-asked.
    expect(s.getSnapshot().said).toBe("380,240");
  });
});

describe("drag 和另四张卡同一本账", () => {
  it("放对记对、放偏记错、自由文本不判分、逃生句单开一本账", () => {
    const ops: Op[] = [
      prop(),
      drag({ prop: "vec-b", value: { x: 100, y: 200 }, tol: 10 }),
      { kind: "answer" as const, gate: 1, text: "100,200" },
      drag({ prop: "vec-b", value: { x: 100, y: 200 }, tol: 10 }),
      { kind: "answer" as const, gate: 3, text: "400,400" },
      drag({ prop: "vec-b", value: { x: 100, y: 200 }, tol: 10 }),
      { kind: "answer" as const, gate: 5, text: "我没有搬，直接说" },
      drag({ prop: "vec-b", value: { x: 100, y: 200 }, tol: 10 }),
      { kind: "answer" as const, gate: 7, text: ESC_RETRY },
      line("收住", 1000),
    ];
    const s = new Stage();
    s.load(ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op })));
    const sc = scoreOf(s.compiled);
    expect(sc.asking).toBe(4);
    expect(sc.correct).toBe(1);
    expect(sc.wrong).toBe(1);
    expect(sc.escaped).toBe(1);
    // 自由文本既不算对也不算错：asking 之外没进任何一本对错账。
    expect(sc.correct + sc.wrong).toBe(2);
    expect(sc.open).toBe(0);
  });
});

describe("门对 drag 的管", () => {
  it("目标位置越界被夹回世界范围，容差为负归零", () => {
    const notes: string[] = [];
    const out = guardOp({ kind: "drag", prompt: "?", prop: "vec-b", value: { x: 1e12, y: -1e12 }, tol: -3 } as DragOp, (n) => notes.push(n)) as DragOp;
    expect(out.value).toEqual({ x: 200_000, y: -200_000 });
    expect(out.tol).toBe(0);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("吞掉整段的容差被夹到 2000（一屏约 1600 宽，再大就是'放哪都对'）", () => {
    const out = guardOp({ kind: "drag", prompt: "?", prop: "vec-b", value: { x: 1, y: 1 }, tol: 999_999 } as DragOp) as DragOp;
    expect(out.tol).toBe(2000);
  });

  it("坏数字不整卷拒绝：缺字段退回可读默认（目标原点、容差 0）", () => {
    const out = guardOp({ kind: "drag", prompt: "?" } as DragOp) as DragOp;
    expect(out.value).toEqual({ x: 0, y: 0 });
    expect(out.tol).toBe(0);
  });

  it("道具名照 120 字封顶", () => {
    const out = guardOp({ kind: "drag", prompt: "?", prop: "长".repeat(300), value: { x: 1, y: 1 } } as DragOp) as DragOp;
    expect(out.prop.length).toBe(120);
  });
});

describe("导演工具 drag 的回执", () => {
  const run = () => directorTools(performing(prop()), { title: "t", concepts: [], learner: "", beatsDone: 0 }).run;

  it("要搬的道具不在带上，不成题：这一刀不落", () => {
    const r = run()("drag", { prompt: "搬一下", prop: "no-such-prop", value: { x: 0, y: 0 } });
    expect(r.isError).toBe(true);
    expect(r.ops).toHaveLength(0);
  });

  it("道具在带上但不在台上（已 discard），不成题：没有'该在的位置'的东西搬不动", () => {
    const s = new Stage();
    s.goLive();
    s.append([prop(), { kind: "discard", id: "vec-b" }, line("好", 1000)], MAIN_TRACK);
    const r = directorTools(s, { title: "t", concepts: [], learner: "", beatsDone: 0 }).run("drag", { prompt: "搬一下", prop: "vec-b", value: { x: 0, y: 0 } });
    expect(r.isError).toBe(true);
    expect(r.result).toContain("不在台上");
  });

  it("目标位置不是一对可读的数，不成题", () => {
    const r = run()("drag", { prompt: "搬一下", prop: "vec-b", value: { x: "咦", y: 0 } });
    expect(r.isError).toBe(true);
  });

  it("一张好卡回执以 question queued 开头，主循环据此停表等他搬", () => {
    const r = run()("drag", { prompt: "把 b 的头搬到 a 的头上", prop: "vec-b", value: { x: 480, y: 300 }, tol: 60, concept: "向量加法是首尾相接" });
    expect(r.isError).not.toBe(true);
    expect(r.result.startsWith("question queued")).toBe(true);
    expect(r.ops[0]).toMatchObject({ kind: "drag", prop: "vec-b", value: { x: 480, y: 300 }, tol: 60 });
  });
});

describe("drag 回执那头：导演拿到的是他放的位置和离目标多远，不是替他宣布对错", () => {
  const CFG = { ...DEFAULT_CONFIG, scripted: true };

  function scriptedStage(): { stage: Stage; teacher: Teacher } {
    getModels(CFG);
    const stage = new Stage();
    const teacher = new Teacher(stage, CFG, {});
    return { stage, teacher };
  }

  function dragResults(teacher: Teacher): string {
    return teacher.messages
      .filter((m) => m.role === "toolResult" && m.toolName === "drag")
      .map((r) =>
        (Array.isArray(r.content) ? r.content : [])
          .filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && c.type === "text")
          .map((c) => c.text)
          .join("\n"),
      )
      .join("\n");
  }

  async function untilGate(stage: Stage, kind: string, tries = 300) {
    for (let i = 0; i < tries; i++) {
      if (stage.getSnapshot().gate?.kind === kind) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`gate ${kind} never opened`);
  }

  const script = () => [
    fauxAssistantMessage(
      [fauxThinking("这一拍先把 b 摆上台，再让他亲手搬过去。"), fauxToolCall("build", { id: "vec-b", label: "向量 b", x: 100, y: 100, w: 200, h: 100, html: "<p>b</p>" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [fauxThinking("这一拍让他亲手把 b 搬过去。"), fauxToolCall("drag", { prompt: "把 b 的头搬到 a 的头上", prop: "vec-b", value: { x: 480, y: 300 }, tol: 60, concept: "向量加法是首尾相接" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [fauxToolCall("narrate", { text: "好，接着讲。", seconds: 3 })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("（排练剧本到这里演完了。）", { stopReason: "stop" }),
  ];

  it("放对：回执说他放的位置在容差内，附离目标多远", async () => {
    const { stage, teacher } = scriptedStage();
    setScriptedResponses(script());
    const p = teacher.say("讲向量加法");
    await untilGate(stage, "drag");
    stage.answerGate("480,300");
    await p;
    const text = dragResults(teacher);
    expect(text).toContain("放到了 (480, 300)");
    expect(text).toContain("放对了");
  });

  it("放偏：回执报他放的位置和差值，并明确别把正确答案念给他听", async () => {
    const { stage, teacher } = scriptedStage();
    setScriptedResponses(script());
    const p = teacher.say("讲向量加法");
    await untilGate(stage, "drag");
    stage.answerGate("380,240");
    await p;
    const text = dragResults(teacher);
    expect(text).toContain("(380, 240)");
    expect(text).toContain("离目标 (480, 300) 差");
    expect(text).toContain("别直接把正确位置念给他听");
  });

  it("他没搬、直接说了句话：回执说这是他的理解，不是判分句", async () => {
    const { stage, teacher } = scriptedStage();
    setScriptedResponses(script());
    const p = teacher.say("讲向量加法");
    await untilGate(stage, "drag");
    stage.answerGate("我不想搬，你说吧");
    await p;
    const text = dragResults(teacher);
    expect(text).toContain("没有搬动");
    expect(text).toContain("我不想搬，你说吧");
    expect(text).not.toContain("放对了");
    expect(text).not.toContain("差");
  });
});

describe("drag 观众那一头：台上的道具自己变成可搬的，他松手后有确认条，落带的是他确认的位置", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  class NoResize {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = NoResize as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = () => {};
  (globalThis as { speechSynthesis?: unknown }).speechSynthesis = {
    getVoices: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    cancel: () => {},
    speak: () => {},
  };
  Element.prototype.setPointerCapture = () => {};

  const mountApp = (): { host: HTMLDivElement; root: ReturnType<typeof createRoot>; stage: Stage } => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(App)));
    const stage = (globalThis as unknown as { __stage: Stage }).__stage;
    return { host, root, stage };
  };
  const loadLive = (stage: Stage, ops: Op[]) => {
    act(() => stage.load(ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op }))));
    act(() => stage.goLive());
  };
  /** jsdom 没有 PointerEvent；补一个带坐标的冒泡事件，React 的 onPointerDown 就能接到。 */
  const pointer = (type: string, x: number, y: number, target: Element) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clientX", { value: x });
    Object.defineProperty(ev, "clientY", { value: y });
    Object.defineProperty(ev, "pointerId", { value: 1 });
    target.dispatchEvent(ev);
  };
  const tape = (): Op[] => [prop(), drag(), line("好，接着讲", 60_000)];

  it("卡开着：提示横幅在、被点名的道具挂着可搬的记号；答完后道具回到锚点、记号消失", () => {
    const { host, root, stage } = mountApp();
    loadLive(stage, tape());
    const hint = host.querySelector(".probe-hint");
    expect(hint?.textContent).toContain("拖到目标位置");
    // No blocking card: a full-screen card would sit on top of the very prop he must grab.
    expect(host.querySelector(".gate-card")).toBeNull();
    const propEl = host.querySelector('[data-prop="vec-b"]') as HTMLElement;
    expect(propEl.classList.contains("movable")).toBe(true);
    act(() => root.unmount());
    host.remove();
  });

  it("拖、松手、确认：确认条出现，点「就是这里」落带那个位置，道具回到锚点", () => {
    const { host, root, stage } = mountApp();
    loadLive(stage, tape());
    const propEl = host.querySelector('[data-prop="vec-b"]') as HTMLElement;
    const world = host.querySelector(".world") as HTMLElement;
    // 无 ResizeObserver → 默认 1600x900 视口、默认镜头 1600x900 → scale 为 1，屏幕像素即世界单位。
    // 道具中心 (200, 150)，拖到让中心落在 (380, 240)。
    act(() => {
      pointer("pointerdown", 150, 130, propEl);
      pointer("pointermove", 330, 220, world);
      pointer("pointerup", 330, 220, world);
    });
    const chip = host.querySelector(".drag-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("(380, 240)");
    act(() => {
      (chip!.querySelector("button") as HTMLButtonElement).click();
    });
    expect(stage.compiled.gates[0].said).toBe("380,240");
    // 确认后卡合上：道具回到锚点（left/top 是带子上的 box），可搬记号与确认条一起消失。
    expect(host.querySelector('[data-prop="vec-b"]')?.classList.contains("movable")).toBe(false);
    expect(host.querySelector(".drag-chip")).toBeNull();
    expect(host.querySelector(".probe-hint")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  it("拖完点「还原」：道具回到锚点、确认条消失、一个字也不落带", () => {
    const { host, root, stage } = mountApp();
    loadLive(stage, tape());
    const propEl = host.querySelector('[data-prop="vec-b"]') as HTMLElement;
    const world = host.querySelector(".world") as HTMLElement;
    act(() => {
      pointer("pointerdown", 150, 130, propEl);
      pointer("pointermove", 330, 220, world);
      pointer("pointerup", 330, 220, world);
    });
    const chip = host.querySelector(".drag-chip");
    const buttons = chip!.querySelectorAll("button");
    act(() => {
      (buttons[1] as HTMLButtonElement).click();
    });
    expect(host.querySelector(".drag-chip")).toBeNull();
    expect(answersOn(stage)).toHaveLength(0);
    expect(stage.compiled.gates[0].said).toBeNull();
    // 卡还开着：可搬记号还在，他还能再搬。
    expect(host.querySelector('[data-prop="vec-b"]')?.classList.contains("movable")).toBe(true);
    act(() => root.unmount());
    host.remove();
  });

  it("录像（别人上的带）不再问人：回放时没有提示横幅、没有可搬的记号", () => {
    const { host, root, stage } = mountApp();
    const ops: Op[] = [prop(), drag(), { kind: "answer" as const, gate: 1, text: "380,240" }, line("好", 60_000)];
    act(() => stage.load(ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op }))));
    expect(stage.getSnapshot().live).toBe(false);
    expect(host.querySelector(".probe-hint")).toBeNull();
    expect(host.querySelector('[data-prop="vec-b"]')?.classList.contains("movable")).toBe(false);
    expect(host.querySelector(".drag-chip")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
