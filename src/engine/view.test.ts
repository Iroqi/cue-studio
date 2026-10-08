// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { BeatRail } from "../ui/BeatRail";
import App from "../App";
import type { Op, OpEntry } from "./types";

/*
 * 这一节测的是**观众那一头**的价钱。上一节把门口和解释器改成线性的，量完还剩两处二次的活儿在
 * React 里：抽屉的日志面板每一帧把整卷重排一遍（抽屉关着也重排——"关"只是个 CSS transform），
 * 节拍条每一帧把每一拍重排一遍。同一套探针量出来：节拍条 400 段一帧 10.7ms、20000 段 647.8ms，
 * 日志两千行一帧 81.9ms、两万行 689ms —— 而时钟一秒钟走六十帧。
 *
 * 修完不许拿毫秒当证据（共享 CI 的噪声比这大），所以数的是**重画次数**：一段在 render 里读了什么，
 * 就是它重画过的指纹。断言的是"没跨拍的那一帧一段都不许重画"，不是"应该很快"。
 */

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

const line = (i: number, ms = 3000): OpEntry => ({
  seq: i,
  track: MAIN_TRACK,
  turn: i,
  op: { kind: "narrate", text: `第 ${i} 句台词`, duration: ms },
});

/** 一句旁白一拍：beats.length 就是条数，一拍的时间窗就是那句的时长。 */
function show(n: number): Stage {
  const stage = new Stage();
  stage.load(Array.from({ length: n }, (_, i) => line(i)));
  return stage;
}

type RailProps = Parameters<typeof BeatRail>[0];

/** 测试要的只是"这一拍能不能剪回去"这个答案，所以拿一个只会数调用次数的假老师。 */
const fakeTeacher = (canReroll: (turn: number) => boolean): RailProps["teacher"] =>
  ({ canReroll, rerollFrom: async () => {} }) as unknown as RailProps["teacher"];

const mount = (root: Root, props: RailProps) => act(() => root.render(createElement(BeatRail, props)));

function rail(props: RailProps) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mount(root, props);
  return { host, rerender: (next: RailProps) => mount(root, next), done: () => act(() => root.unmount()) };
}

describe("view：时钟的每一帧不许重排整卷", () => {
  it("节拍条：没有跨过一拍的那一帧，一段都不许重画", () => {
    const stage = show(400);
    // 每一段在 render 里都要问一次"这一拍能剪回去吗"，所以调用次数就是重画的段数。
    const canReroll = vi.fn(() => false);
    const teacher = fakeTeacher(canReroll);
    const dur = stage.compiled.duration;
    const beat = stage.compiled.beats[10];
    const { host, rerender, done } = rail({ stage, teacher, t: beat.start + 10, duration: dur });
    expect(host.querySelectorAll(".seg").length).toBe(400);
    expect(canReroll).toHaveBeenCalled();

    canReroll.mockClear();
    rerender({ stage, teacher, t: beat.start + 10, duration: dur });
    rerender({ stage, teacher, t: beat.start + 40, duration: dur });
    expect(canReroll).not.toHaveBeenCalled();
    expect(host.querySelectorAll(".seg.now").length).toBe(1);
    done();
    host.remove();
  });

  it("节拍条：跨进下一拍的那一帧，只重画变了的那两段", () => {
    const stage = show(400);
    const canReroll = vi.fn(() => false);
    const teacher = fakeTeacher(canReroll);
    const dur = stage.compiled.duration;
    const b0 = stage.compiled.beats[9];
    const b1 = stage.compiled.beats[10];
    const { host, rerender, done } = rail({ stage, teacher, t: b0.start + 10, duration: dur });
    canReroll.mockClear();
    rerender({ stage, teacher, t: b1.start + 10, duration: dur });
    // 亮的段换了一个：丢 now 的那段加拿 now 的那段。
    expect(canReroll.mock.calls.length).toBeLessThanOrEqual(2);
    expect(host.querySelectorAll(".seg.now").length).toBe(1);
    done();
    host.remove();
  });

  it("节拍条：now 落在时钟真正站着的那一段上", () => {
    const stage = show(3);
    const dur = stage.compiled.duration;
    const beats = stage.compiled.beats;
    const { host, rerender, done } = rail({ stage, teacher: null, t: beats[0].start + 1, duration: dur });
    const lit = () => host.querySelector(".seg.now em")?.textContent;
    expect(lit()).toBe("1");
    rerender({ stage, teacher: null, t: beats[1].start + 1, duration: dur });
    expect(lit()).toBe("2");
    rerender({ stage, teacher: null, t: beats[2].start + 1, duration: dur });
    expect(lit()).toBe("3");
    // 时钟走到带子外面：没有哪一段该亮着。
    rerender({ stage, teacher: null, t: dur + 5000, duration: dur });
    expect(host.querySelectorAll(".seg.now").length).toBe(0);
    done();
    host.remove();
  });

  it("日志面板：时钟走一帧不许再把整卷抄一遍", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    // App 把 stage 挂到 globalThis 上，正好用它推时钟；抄卷子的证据就是 all() 的调用次数。
    act(() => root.render(createElement(App)));
    const stage = (globalThis as { __stage?: Stage }).__stage!;
    // 推时钟和推动带子都得在 act 里：这一节的证据就是"React 到底重排了几次"，
    // 一次没被 act 收住的更新会在断言之后才落地，那就什么都测不到了。
    act(() => stage.load(Array.from({ length: 2000 }, (_, i) => line(i, 60_000))));
    expect(host.querySelectorAll(".log .row").length).toBe(2000);

    const all = vi.spyOn(stage.log, "all");
    const dur = stage.compiled.duration;
    for (const t of [dur * 0.2, dur * 0.4, dur * 0.6]) act(() => stage.seek(t));
    expect(all).not.toHaveBeenCalled();
    // 带子真动了就必须重排：这一行保证上面那一刀不是把面板冻住了。
    act(() => stage.append([{ kind: "beat", duration: 500 }], MAIN_TRACK));
    expect(all).toHaveBeenCalled();
    all.mockRestore();
    act(() => root.unmount());
    host.remove();
  });

  it("日志面板：他答的那一行仍然认得问题是谁问的", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(App)));
    const stage = (globalThis as { __stage?: Stage }).__stage!;
    const quiz = { kind: "quiz", prompt: "合力多大？", options: ["5N", "7N"], answer: 0 } as Op;
    const waited = { kind: "narrate", text: "等他答完", duration: 1000 } as Op;
    const answered = { kind: "answer", gate: 0, text: "5N" } as Op;
    // 没对上门的那条：gate 指不到任何一张卡，行里就不许带问题。
    const orphan = { kind: "answer", gate: 7, text: "随口一句" } as Op;
    act(() => stage.append([quiz, waited, answered, orphan], MAIN_TRACK));
    const text = [...host.querySelectorAll(".log .row span")].map((s) => s.textContent ?? "");
    expect(text.some((t) => t.includes("他答：「5N」") && t.includes("合力多大"))).toBe(true);
    expect(text.some((t) => t === "他答：「随口一句」")).toBe(true);
    act(() => root.unmount());
    host.remove();
  });
});
