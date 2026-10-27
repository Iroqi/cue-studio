// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { StageView } from "./StageView";
import { Teacher } from "../agent/loop";
import App from "../App";
import type { DragOp, Op, OpEntry } from "./types";

/*
 * 第七种交互（Intelligent UI 的 direct manipulation 的另一半）：不是导演开一张卡让他点，
 * 是**他自己举手** —— 画面在走、没有卡开着，他指着台上一件东西的具体一处发问。
 *
 * 指认本身不落带、不判分、不停表：它就是学习者此刻的注意力，和 3D 窗的拖动角度同一本账。
 * 只有他按发送时那句话会到导演手里，坐标写成道具自身框里的 0..1（`camera.at` 同一套单位）。
 *
 * 三层照旧分开钉：点得成、坐标对（形状）；点与问都不加一笔带子上的账（价钱）；录像与卡片前先让路（护栏）。
 */

const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });
const prop = (): Op => ({ kind: "build", id: "vec-b", label: "向量 b", box: { x: 100, y: 100, w: 200, h: 100 }, html: "<p>b</p>" }) as Op;
const drag = (): Op =>
  ({ kind: "drag", prompt: "把 b 搬到目标位置", prop: "vec-b", value: { x: 480, y: 300 }, tol: 60 }) as DragOp;
const entries = (ops: Op[]): OpEntry[] => ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let clockNow = 1000;

beforeEach(() => {
  clockNow = 1000;
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.spyOn(performance, "now").mockImplementation(() => clockNow);
  // jsdom 没有布局：给它一块 1600x900 的台面，屏幕像素才和世界单位一比一。
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1600);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(900);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StageView 的指认接缝：屏幕点 → 世界点 → 道具自身框里的比例", () => {
  class NoResize {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = NoResize as unknown as typeof ResizeObserver;

  const mountStage = (ops: Op[], pointing: boolean, onPoint = vi.fn()) => {
    const stage = new Stage();
    act(() => stage.load(entries(ops)));
    act(() => stage.goLive());
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(StageView, { stage, pointing, onPoint })));
    return { stage, host, root, onPoint };
  };
  /** jsdom 没有布局：默认 1600x900、镜头 (0,0,1600x900)、scale=1，屏幕像素即世界单位。 */
  const click = (el: Element, x: number, y: number) => {
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    });
  };

  it("指着问模式里点道具框的正中：回的是道具 id 和 (0.5, 0.5)", () => {
    const { host, root, onPoint } = mountStage([prop(), line("好", 1000)], true);
    const el = host.querySelector('[data-prop="vec-b"]') as HTMLElement;
    expect(el.classList.contains("pointable")).toBe(true);
    expect(el.getAttribute("title")).toBe("指着这一处问");
    click(el, 200, 150);
    expect(onPoint).toHaveBeenCalledWith("vec-b", { x: 0.5, y: 0.5 });
    act(() => root.unmount());
    host.remove();
  });

  it("点在框外也只给 0..1：导演不会被送到板外", () => {
    const { host, root, onPoint } = mountStage([prop(), line("好", 1000)], true);
    const el = host.querySelector('[data-prop="vec-b"]') as HTMLElement;
    click(el, 0, 0);
    expect(onPoint).toHaveBeenLastCalledWith("vec-b", { x: 0, y: 0 });
    click(el, 2000, 2000);
    expect(onPoint).toHaveBeenLastCalledWith("vec-b", { x: 1, y: 1 });
    act(() => root.unmount());
    host.remove();
  });

  it("没进指着问模式时，板不接点：同一块道具点了也不报", () => {
    const { host, root, onPoint } = mountStage([prop(), line("好", 1000)], false);
    const el = host.querySelector('[data-prop="vec-b"]') as HTMLElement;
    expect(el.classList.contains("pointable")).toBe(false);
    click(el, 200, 150);
    expect(onPoint).not.toHaveBeenCalled();
    act(() => root.unmount());
    host.remove();
  });

  it("卡开着时不抢拾取：指着问让位给 drag，道具上不挂可指的记号", () => {
    const { stage, host, root, onPoint } = mountStage([prop(), drag(), line("好", 1000)], true);
    act(() => stage.seek(0));
    expect(stage.getSnapshot().gate?.kind).toBe("drag");
    const el = host.querySelector('[data-prop="vec-b"]') as HTMLElement;
    expect(el.classList.contains("pointable")).toBe(false);
    expect(el.classList.contains("movable")).toBe(true);
    click(el, 200, 150);
    expect(onPoint).not.toHaveBeenCalled();
    act(() => root.unmount());
    host.remove();
  });
});

describe("App 那一头：指着问是 Learner 自己的动作，送出去的只有那句话", () => {
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
  const clickAt = (el: Element, x: number, y: number) => {
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    });
  };
  const byText = (host: Element, text: string) =>
    Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;
  const type = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const tape = (): Op[] => [prop(), line("这是一条向量。", 60_000)];

  it("按「指着问」→ 点道具 → 写问题 → 发送：只有带坐标的那句话进对话，带子一笔不加、表不停", async () => {
    const spy = vi.spyOn(Teacher.prototype, "respond").mockResolvedValue(undefined);
    const { host, root, stage } = mountApp();
    loadLive(stage, tape());
    act(() => stage.play());
    const before = stage.log.all().length;

    act(() => byText(host, "指着问")!.click());
    expect(host.querySelector(".point-hint")?.textContent).toContain("指着具体的一处问");
    const el = host.querySelector('[data-prop="vec-b"]') as HTMLElement;
    expect(el.classList.contains("pointable")).toBe(true);
    clickAt(el, 200, 150);

    expect(host.querySelector(".point-hint")).toBeNull();
    expect(host.querySelector(".point-chip")?.textContent).toContain("指着「向量 b」");
    expect(host.querySelector(".point-mark")).not.toBeNull();
    expect(el.classList.contains("pointed")).toBe(true);

    type(host.querySelector(".composer input") as HTMLInputElement, "这里怎么来的？");
    await act(async () => {
      byText(host, "问这一处")!.click();
    });

    expect(spy).toHaveBeenCalledWith("我指着台上的「向量 b」这一点（x=0.50，y=0.50）问：这里怎么来的？");
    expect(host.querySelector(".point-chip")).toBeNull();
    expect(host.querySelector(".point-mark")).toBeNull();
    expect((host.querySelector(".composer input") as HTMLInputElement).value).toBe("");
    // 指认和提问都不落带：带子还是原来那两条，没有 answer / 没有坐标 op。
    expect(stage.log.all()).toHaveLength(before);
    // 表也没被按住：指着问不是一张卡。
    expect(stage.getSnapshot().gate).toBeNull();
    expect(stage.getSnapshot().playing).toBe(true);
    act(() => root.unmount());
    host.remove();
  });

  it("「这里没懂」一键就是全部：空问题也发，句子落在最短那扇门上", async () => {
    const spy = vi.spyOn(Teacher.prototype, "respond").mockResolvedValue(undefined);
    const { host, root, stage } = mountApp();
    loadLive(stage, tape());
    act(() => stage.play());
    const before = stage.log.all().length;

    act(() => byText(host, "指着问")!.click());
    clickAt(host.querySelector('[data-prop="vec-b"]') as HTMLElement, 200, 150);
    await act(async () => {
      (host.querySelector(".point-chip button") as HTMLButtonElement).click();
    });

    expect(spy).toHaveBeenCalledWith(
      "我指着台上的「向量 b」这一点（x=0.50，y=0.50）—— 这里没懂，换个讲法。",
    );
    expect(stage.log.all()).toHaveLength(before);
    expect(stage.getSnapshot().playing).toBe(true);
    act(() => root.unmount());
    host.remove();
  });

  it("✕ 收手：句子退回普通输入，一个字也不送出去", async () => {
    const spy = vi.spyOn(Teacher.prototype, "respond").mockResolvedValue(undefined);
    const { host, root, stage } = mountApp();
    loadLive(stage, tape());
    act(() => byText(host, "指着问")!.click());
    clickAt(host.querySelector('[data-prop="vec-b"]') as HTMLElement, 200, 150);
    act(() => (host.querySelector(".point-chip button.x") as HTMLButtonElement).click());
    expect(host.querySelector(".point-chip")).toBeNull();
    expect(host.querySelector(".point-mark")).toBeNull();
    expect((host.querySelector(".composer input") as HTMLInputElement).placeholder).toContain("接着这块板说");
    expect(spy).not.toHaveBeenCalled();
    act(() => root.unmount());
    host.remove();
  });

  it("指着的那件东西离开台上（discard）：指认自己失效，不留一个指空处的句子", () => {
    const { host, root, stage } = mountApp();
    loadLive(stage, tape());
    act(() => byText(host, "指着问")!.click());
    clickAt(host.querySelector('[data-prop="vec-b"]') as HTMLElement, 200, 150);
    expect(host.querySelector(".point-chip")).not.toBeNull();
    act(() => stage.append([{ kind: "discard", id: "vec-b" } as Op], MAIN_TRACK));
    expect(host.querySelector('[data-prop="vec-b"]')).toBeNull();
    expect(host.querySelector(".point-chip")).toBeNull();
    expect(host.querySelector(".point-mark")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  it("录像（别人上的带）不再问人：没有「指着问」，点道具也不抬指认条", () => {
    const { host, root, stage } = mountApp();
    act(() => stage.load(entries(tape())));
    expect(stage.getSnapshot().live).toBe(false);
    expect(byText(host, "指着问")).toBeUndefined();
    clickAt(host.querySelector('[data-prop="vec-b"]') as HTMLElement, 200, 150);
    expect(host.querySelector(".point-chip")).toBeNull();
    expect(host.querySelector(".point-mark")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
