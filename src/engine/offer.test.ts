// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { compile } from "./compile";
import { guardOp } from "./guard";
import { directorTools } from "../tools/director";
import { DEFAULT_CONFIG, getModels, setScriptedResponses } from "../llm/llm";
import { Teacher } from "../agent/loop";
import App from "../App";
import type { OfferOp, Op, OpEntry } from "./types";

/*
 * 第六种交互（Intelligent UI 的 Actions / issueNewTurn）：导演在台上开一扇门 —— 一个按钮。
 * 按下它，phrase 以和"他亲手打字"一模一样的方式送进对话：没有任何标记说明它来自按钮。
 * 它永远不是考题：不停表、不开卡、不判分。
 *
 * 三层照旧分开钉：门开得成、话进得去（形状）；点击就是打字那一条路（导演工具回执 + 观众头）；
 * 把任何一刀画错都红（护栏）。
 */

const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });
const offer = (over: Partial<OfferOp> = {}): Op =>
  ({ kind: "offer", label: "我想自己试一下", phrase: "我想自己试一下，你先别提示", ...over }) as OfferOp;
const entries = (ops: Op[]): OpEntry[] => ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op }));
const performing = (...ops: Op[]): Stage => {
  const s = new Stage();
  s.goLive();
  s.append(ops, MAIN_TRACK);
  return s;
};

describe("offer 的形状：一扇门，不是一张卡", () => {
  it("offer 落带进 compiled.offers：带时刻、seq、label、phrase，不开卡", () => {
    const c = compile(entries([offer()]));
    expect(c.offers).toHaveLength(1);
    expect(c.offers[0]).toMatchObject({ label: "我想自己试一下", phrase: "我想自己试一下，你先别提示" });
    expect(c.offers[0].t).toBe(0);
    expect(c.offers[0].seq).toBe(0);
    expect(c.gates).toHaveLength(0);
  });

  it("offer 不占时钟、不开新问：旁白照旧定时长，拍表只按旁白收口", () => {
    const c = compile(entries([line("第一句", 5000), offer(), line("第二句", 3000)]));
    expect(c.duration).toBe(8000);
    expect(c.gates).toHaveLength(0);
    expect(c.offers).toHaveLength(1);
    // 门开在那一刻：旁白走到头的时刻，不是把这一刻往后拖。
    expect(c.offers[0].t).toBe(5000);
    expect(c.beats.length).toBe(2);
    expect(c.beats[1].headline).toBe("第二句");
    expect(c.beats[1].verbs).toContain("offer");
  });

  it("干净的 offer 原样出门：门改不动就不换引用", () => {
    const op: OfferOp = { kind: "offer", label: "试一下", phrase: "我想自己试一下" };
    expect(guardOp(op)).toBe(op);
  });

  it("按钮字照 120 字封顶、短语照 2000 字封顶；听筒报修正", () => {
    const notes: string[] = [];
    const out = guardOp({ kind: "offer", label: "长".repeat(300), phrase: "话".repeat(2500) } as OfferOp, (n) => notes.push(n)) as OfferOp;
    expect(out.label.length).toBe(120);
    expect(out.phrase.length).toBe(2000);
    expect(notes.join("\n")).toContain("offer.label");
    expect(notes.join("\n")).toContain("offer.phrase");
  });

  it("label 空退回用 phrase 当按钮字；phrase 空退回用 label：门至少还有一句人话", () => {
    const a = guardOp({ kind: "offer", label: "", phrase: "我自己来" } as OfferOp) as OfferOp;
    expect(a.label).toBe("我自己来");
    expect(a.phrase).toBe("我自己来");
    const b = guardOp({ kind: "offer", label: "我自己来", phrase: "" } as OfferOp) as OfferOp;
    expect(b.label).toBe("我自己来");
    expect(b.phrase).toBe("我自己来");
  });
});

describe("导演工具 offer 的回执", () => {
  const run = () => directorTools(performing(line("好", 1000)), { title: "t", concepts: [], learner: "", beatsDone: 0 }).run;

  it("一扇好门：回执以 offer queued 开头，点明 phrase 和打字一模一样", () => {
    const r = run()("offer", { label: "我想自己试一下", phrase: "我想自己试一下，你先别提示" });
    expect(r.isError).not.toBe(true);
    expect(r.result.startsWith("offer queued")).toBe(true);
    expect(r.result).toContain("我想自己试一下");
    expect(r.result).toContain("nothing marks it as coming from the button");
    expect(r.ops[0]).toMatchObject({ kind: "offer", label: "我想自己试一下", phrase: "我想自己试一下，你先别提示" });
  });

  it("按钮上没字，不成门：这一扇不落", () => {
    const r = run()("offer", { label: "", phrase: "我想自己试一下" });
    expect(r.isError).toBe(true);
    expect(r.ops).toHaveLength(0);
  });

  it("按钮字太长不成门（按钮不是海报）", () => {
    const r = run()("offer", { label: "长".repeat(45), phrase: "我想自己试一下" });
    expect(r.isError).toBe(true);
    expect(r.ops).toHaveLength(0);
  });

  it("按下后没话可说，不成门", () => {
    const r = run()("offer", { label: "我想自己试一下", phrase: "" });
    expect(r.isError).toBe(true);
    expect(r.ops).toHaveLength(0);
  });
});

describe("offer 那一头：按下送进去的话，和打字一模一样（Intelligent UI 的 issueNewTurn）", () => {
  const CFG = { ...DEFAULT_CONFIG, scripted: true };
  const PHRASE = "我想自己试一下，你先别提示";

  function scriptedStage(): { stage: Stage; teacher: Teacher } {
    getModels(CFG);
    const stage = new Stage();
    const teacher = new Teacher(stage, CFG, {});
    return { stage, teacher };
  }

  const offerReceipt = (teacher: Teacher): string =>
    teacher.messages
      .filter((m) => m.role === "toolResult" && m.toolName === "offer")
      .map((r) =>
        (Array.isArray(r.content) ? r.content : [])
          .filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && c.type === "text")
          .map((c) => c.text)
          .join("\n"),
      )
      .join("\n");

  const script = () => [
    fauxAssistantMessage(
      [fauxThinking("这一拍在台上开一扇门，让他可以自己按一个按钮说话。"), fauxToolCall("offer", { label: "我想自己试一下", phrase: PHRASE })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("（排练剧本到这里演完了。）", { stopReason: "stop" }),
  ];

  it("点击送出的 phrase 以 user 消息进对话，回执说的是'和打字一样'，没有别的标记", async () => {
    const { stage, teacher } = scriptedStage();
    setScriptedResponses(script());
    await teacher.say("讲向量加法");
    expect(stage.compiled.offers).toHaveLength(1);
    expect(offerReceipt(teacher)).toContain("offer queued");
    expect(offerReceipt(teacher)).toContain("stored like the learner typed it");
    // 剧本本身已经给导演发过一次 user 消息（"这一场要讲的内容：讲向量加法。请开始编排。"），
    // 所以现在计数是 1；按下之后必须多出一条、且内容逐字节等于 phrase。
    const usersBefore = teacher.messages.filter((m) => m.role === "user").map((m) => m.content);
    await teacher.respond(PHRASE);
    const usersAfter = teacher.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(usersAfter).toHaveLength(usersBefore.length + 1);
    expect(usersAfter).toContain(PHRASE);
    // 没有任何一个角色说"这来自按钮"：消息表里只有 user/toolResult/assistant 那些既有角色。
    expect(teacher.messages.every((m) => ["user", "assistant", "toolResult", "system", "toolCall"].includes(m.role))).toBe(true);
  });
});

describe("offer 观众那一头：时钟走到门的那一刻按钮出现，按下走 typing 同一条路，录像只给静态门", () => {
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
  let clockNow = 1000;
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

  const mountApp = (): { host: HTMLDivElement; root: ReturnType<typeof createRoot>; stage: Stage } => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(App)));
    const stage = (globalThis as unknown as { __stage: Stage }).__stage;
    return { host, root, stage };
  };
  const loadLive = (stage: Stage, ops: Op[]) => {
    act(() => stage.load(entries(ops)));
    act(() => stage.goLive());
  };

  it("门开在旁白走完的那一刻：时钟没到没有按钮，到了按钮在；按下去 phrase 走 respond 那条路、门关上（一次只送一句）", async () => {
    const spy = vi.spyOn(Teacher.prototype, "respond").mockResolvedValue(undefined);
    const { host, root, stage } = mountApp();
    loadLive(stage, [line("第一句", 5000), offer(), line("好，接着讲", 60_000)]);
    // goLive 把钟推到实时边（带子尽头），门已经全开了；先把钟拨回 0，站在门开之前。
    act(() => stage.seek(0));
    expect(host.querySelector(".offer-row")).toBeNull();
    act(() => stage.seek(5000));
    const btn = host.querySelector(".offer-row .offer") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain("我想自己试一下");
    act(() => {
      btn.click();
    });
    expect(spy).toHaveBeenCalledWith("我想自己试一下，你先别提示");
    expect(host.querySelector(".offer-row")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  it("录像（别人上的带）不再问人：门是静态的，不是按钮；点了也不会往对话里送", async () => {
    const spy = vi.spyOn(Teacher.prototype, "respond").mockResolvedValue(undefined);
    const { host, root, stage } = mountApp();
    act(() => stage.load(entries([line("第一句", 5000), offer(), line("好", 60_000)])));
    expect(stage.getSnapshot().live).toBe(false);
    act(() => stage.seek(5000));
    const chip = host.querySelector(".offer-row .offer.static") as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("我想自己试一下");
    expect(host.querySelector(".offer-row button")).toBeNull();
    act(() => {
      chip.click();
    });
    expect(spy).not.toHaveBeenCalled();
    act(() => root.unmount());
    host.remove();
  });
});
