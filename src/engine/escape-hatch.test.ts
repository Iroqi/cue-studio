// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { DEFAULT_CONFIG, getModels, setScriptedResponses } from "../llm/llm";
import { Teacher, ESC_RETRY, ESC_SKIP } from "../agent/loop";
import { attempts, forget } from "../agent/archive";
import App from "../App";
import type { DialOp, Op, OpEntry, ProbeOp, QuizOp, TypeOp } from "./types";

/*
 * 逃生舱口（Intelligent UI 的 escape hatches / trust the user）：停在卡上的学习者以前只有"答"一个出口，
 * "我不会"打在 console 里也会被当成一句答错 —— type 卡甚至当场判他缺词。现在四张卡各开两扇门：
 * 「我不会 · 换个讲法」（ESC_RETRY）与「这道先跳过」（ESC_SKIP）。它们不是新 op —— 就是两句话，落带
 * 仍是 `answer`，判分的权力在 `settleGate`：先认这两句再谈判分，不进档案、不算错过，回执只告诉导演
 * 他怎么了。
 */

const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });
const quiz = (over: Partial<QuizOp> = {}): Op =>
  ({ kind: "quiz", prompt: "哪个是合力？", options: ["甲", "乙"], answer: 0, concept: "合力", ...over }) as QuizOp;
const probe = (over: Partial<ProbeOp> = {}): Op =>
  ({ kind: "probe", prompt: "点一下：哪个是合力？", targets: ["vec-a", "vec-b"], answer: "vec-a", concept: "合力", ...over }) as ProbeOp;
const dial = (over: Partial<DialOp> = {}): Op =>
  ({ kind: "dial", prompt: "先凭直觉拨一下：这个频率是多少？", min: 0, max: 100, value: 42, tol: 5, unit: "Hz", ...over }) as DialOp;
const type = (over: Partial<TypeOp> = {}): Op =>
  ({ kind: "type", prompt: "用一句话说清楚：什么是导数？", accept: ["瞬时", "变化率"], ...over }) as TypeOp;

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

describe("逃生舱口：他说「我不会」/「跳过这道」，卡照合、话照落带，判分一个字不碰", () => {
  it("quiz：答「我不会」落带一句 answer，卡合上，said 是那句话", () => {
    const s = performing(quiz(), line("好，接着讲", 1000));
    walkUntilStopped(s);
    expect(s.getSnapshot().gate?.kind).toBe("quiz");
    s.answerGate(ESC_RETRY);
    const onTape = answersOn(s);
    expect(onTape).toHaveLength(1);
    expect(onTape[0].op).toMatchObject({ gate: s.compiled.gates[0].seq, text: ESC_RETRY });
    expect(s.compiled.gates[0].said).toBe(ESC_RETRY);
    expect(s.getSnapshot().gate).toBeNull();
  });

  it("四张卡同门：probe / dial / type 上答「我不会」都是同一句话落带、同一扇门合上", () => {
    for (const card of [probe(), dial(), type()]) {
      const s = performing(card, line("好", 1000));
      walkUntilStopped(s);
      expect(s.getSnapshot().gate?.kind).toBe(card.kind);
      s.answerGate(ESC_RETRY);
      expect(answersOn(s)).toHaveLength(1);
      expect(s.compiled.gates[0].said).toBe(ESC_RETRY);
      expect(s.getSnapshot().gate).toBeNull();
    }
  });

  it("「跳过这道」是同一扇门，不是第二套账", () => {
    const s = performing(quiz(), line("好", 1000));
    walkUntilStopped(s);
    s.answerGate(ESC_SKIP);
    const onTape = answersOn(s);
    expect(onTape).toHaveLength(1);
    expect(onTape[0].op).toMatchObject({ gate: s.compiled.gates[0].seq, text: ESC_SKIP });
    expect(s.compiled.gates[0].said).toBe(ESC_SKIP);
    expect(s.getSnapshot().gate).toBeNull();
  });

  it("录像（别人上的带）不再问人：他当时那句「我不会」从带子上读出来，不开卡", () => {
    const s = new Stage();
    s.load(
      [
        quiz(),
        { kind: "answer" as const, gate: 0, text: ESC_RETRY },
        line("好，换个讲法", 1000),
      ].map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op })),
    );
    // 不 walk：卡的那一拍在带子开头，走到带尾它已经过场（said 只陪它那一拍）。开场那一刻读得到。
    expect(s.getSnapshot().live).toBe(false);
    expect(s.getSnapshot().gate).toBeNull();
    expect(s.getSnapshot().said).toBe(ESC_RETRY);
  });

  it("护栏：卡已经答完，逃生门就关死了 —— 再答「我不会」不许落第二笔", () => {
    const s = performing(quiz(), line("好", 1000));
    walkUntilStopped(s);
    s.answerGate("甲");
    expect(answersOn(s)).toHaveLength(1);
    s.answerGate(ESC_RETRY);
    expect(answersOn(s)).toHaveLength(1);
    expect(s.compiled.gates[0].said).toBe("甲");
  });
});

describe("逃生舱口：回执那头 —— 导演拿到的是求救/选择，不是判分", () => {
  const CFG = { ...DEFAULT_CONFIG, scripted: true };

  function scriptedStage(): { stage: Stage; teacher: Teacher } {
    getModels(CFG);
    const stage = new Stage();
    const teacher = new Teacher(stage, CFG, {});
    return { stage, teacher };
  }

  function gateResults(teacher: Teacher): string {
    return teacher.messages
      .filter((m) => m.role === "toolResult" && m.toolName === "ask_learner")
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

  it("「我不会」：ask_learner 卡住后答这一句，工具结果是信任句，不是判分句，档案一个字不写", async () => {
    const { stage, teacher } = scriptedStage();
    forget();
    setScriptedResponses([
      fauxAssistantMessage(
        [fauxThinking("这一拍问一个选择题。"), fauxToolCall("ask_learner", { prompt: "哪个是合力？", options: ["甲", "乙"], answer: 0, concept: "合力" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("narrate", { text: "好，换个讲法。", seconds: 3 })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("（排练剧本到这里演完了。）", { stopReason: "stop" }),
    ]);
    const p = teacher.say("讲向量加法");
    await untilGate(stage, "quiz");
    stage.answerGate(ESC_RETRY);
    await p;
    const text = gateResults(teacher);
    expect(text).toContain(ESC_RETRY);
    expect(text).toContain("求救");
    expect(text).toContain("合力");
    // 不是判分句：判分句的记号是"正确的是／答错了／缺了／没有选"，一个字都不许有。
    expect(text).not.toContain("正确的是");
    expect(text).not.toContain("答错了");
    expect(text).not.toContain("没有选");
    expect(text).not.toContain("缺了");
    // 逃生不进档案：evidence 只记真答过的题。
    expect(attempts()).toHaveLength(0);
  });

  it("「跳过这道」：ask_learner 卡住后答这一句，工具结果是尊重他的选择", async () => {
    const { stage, teacher } = scriptedStage();
    setScriptedResponses([
      fauxAssistantMessage(
        [fauxThinking("这一拍问一个选择题。"), fauxToolCall("ask_learner", { prompt: "哪个是合力？", options: ["甲", "乙"], answer: 0 })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("narrate", { text: "好，这道先放着。", seconds: 3 })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("（排练剧本到这里演完了。）", { stopReason: "stop" }),
    ]);
    const p = teacher.say("讲向量加法");
    await untilGate(stage, "quiz");
    stage.answerGate(ESC_SKIP);
    await p;
    const text = gateResults(teacher);
    expect(text).toContain(ESC_SKIP);
    expect(text).toContain("他的选择");
    expect(text).not.toContain("正确的是");
    expect(text).not.toContain("答对了");
    expect(text).not.toContain("答错了");
  });
});

describe("逃生舱口：观众那一头 —— 按钮只跟着开着的卡活", () => {
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

  it("卡开着时两扇门在；答「我不会」后卡合上、门随之消失，回执走中性态（不挂对/错的色）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(App)));
    const stage = (globalThis as { __stage?: Stage }).__stage!;
    act(() => stage.load([quiz(), line("好，接着讲", 60_000)].map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op }))));
    // 载入的带 live=false，录像不问人；这一件测的是卡开着时门在 —— 所以推进 live。
    act(() => stage.goLive());
    expect(host.querySelector(".gate-card")).not.toBeNull();
    const doors = host.querySelectorAll(".escape-row button");
    expect(doors.length).toBe(2);
    expect(doors[0].textContent).toContain("我不会");
    expect(doors[1].textContent).toContain("跳过");
    act(() => {
      (doors[0] as HTMLButtonElement).click();
    });
    expect(stage.compiled.gates[0].said).toBe(ESC_RETRY);
    expect(host.querySelector(".gate-card")).toBeNull();
    expect(host.querySelector(".escape-row")).toBeNull();
    const verdict = host.querySelector(".verdict");
    expect(verdict?.textContent).toContain("好，不硬答");
    expect(verdict?.className).toBe("verdict");
    act(() => root.unmount());
    host.remove();
  });
});
