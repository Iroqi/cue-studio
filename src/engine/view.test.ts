// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { BeatRail } from "../ui/BeatRail";
import { rowsMeter } from "../ui/rows";
import { LogRows } from "../ui/LogRows";
import type { ReactElement } from "react";
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
  // 这一条排第一，是刻意的：`console.error` 那条 "Cannot update a component while rendering a different
  // component" React 按**组件名去重**、模块级只警一次。若前面已经挂了别的 `BeatRail`，去重旗子早被拨下，
  // 到这一条就什么都抓不到。所以这一条必须是本文件里**第一个**挂 `BeatRail` 的，spy 也得从挂载那一次就架上。
  it("节拍条：亮哪一格必须在提交之后推，不许在 render 里唤醒别的组件（F）", () => {
    /*
     * F 把 `now` 从段元素搬到那台 `store`，于是"亮灭"这件事由段自己订阅、由 `BeatRail` 推开。推开必须落在
     * **提交之后**的 layout effect：探针实测把 `store.set(now)` 搬回 render 里，React 就喷
     * "Cannot update a component (`Seg`) while rendering a different component (`BeatRail`)" —— 一个改了
     * 行为（唤醒时机）却没有一把尺子的错法，和 D 的 `M19`、E 的 `N2b` 同一句话，所以钉这一条。断言的是从挂载
     * 到跨拍这几趟 render 里 console.error 一次都不许带那句（真 F 代码恒不警；变异把推送搬回 render 当场红）。
     */
    const stage = show(4);
    const beats = stage.compiled.beats;
    const errs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.map(String).join(" "));
    });
    // 挂载 + 两次跨拍：spy 从第一趟就在，覆盖"本文件第一次挂 BeatRail"那一刻
    const { host, rerender, done } = rail({ stage, teacher: null, t: beats[0].start + 1 });
    rerender({ stage, teacher: null, t: beats[2].start + 1 });
    rerender({ stage, teacher: null, t: beats[3].start + 1 });
    const warned = errs.some((e) => e.includes("Cannot update a component"));
    spy.mockRestore();
    expect(warned).toBe(false);
    done();
    host.remove();
  });

  it("节拍条：没有跨过一拍的那一帧，一段都不许重画", () => {
    const stage = show(400);
    // 每一段在 render 里都要问一次"这一拍能剪回去吗"，所以调用次数就是重画的段数。
    const canReroll = vi.fn(() => false);
    const teacher = fakeTeacher(canReroll);
    const beat = stage.compiled.beats[10];
    const { host, rerender, done } = rail({ stage, teacher, t: beat.start + 10 });
    expect(host.querySelectorAll(".seg").length).toBe(400);
    expect(canReroll).toHaveBeenCalled();

    canReroll.mockClear();
    rerender({ stage, teacher, t: beat.start + 10 });
    rerender({ stage, teacher, t: beat.start + 40 });
    expect(canReroll).not.toHaveBeenCalled();
    expect(host.querySelectorAll(".seg.now").length).toBe(1);
    done();
    host.remove();
  });

  it("节拍条：跨进下一拍的那一帧，只重画变了的那两段", () => {
    const stage = show(400);
    const canReroll = vi.fn(() => false);
    const teacher = fakeTeacher(canReroll);
    const b0 = stage.compiled.beats[9];
    const b1 = stage.compiled.beats[10];
    const { host, rerender, done } = rail({ stage, teacher, t: b0.start + 10 });
    canReroll.mockClear();
    rerender({ stage, teacher, t: b1.start + 10 });
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
    const { host, rerender, done } = rail({ stage, teacher: null, t: beats[0].start + 1 });
    const lit = () => host.querySelector(".seg.now em")?.textContent;
    expect(lit()).toBe("1");
    rerender({ stage, teacher: null, t: beats[1].start + 1 });
    expect(lit()).toBe("2");
    rerender({ stage, teacher: null, t: beats[2].start + 1 });
    expect(lit()).toBe("3");
    // 时钟走到带子外面：没有哪一段该亮着。
    rerender({ stage, teacher: null, t: dur + 5000 });
    expect(host.querySelectorAll(".seg.now").length).toBe(0);
    done();
    host.remove();
  });

  it("日志面板：时钟走一帧不许再把整卷排一遍", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    // App 把 stage 挂到 globalThis 上，正好用它推时钟。
    act(() => root.render(createElement(App)));
    const stage = (globalThis as { __stage?: Stage }).__stage!;
    // 推时钟和推动带子都得在 act 里：这一节的证据就是"React 到底重排了几次"，
    // 一次没被 act 收住的更新会在断言之后才落地，那就什么都测不到了。
    act(() => stage.load(Array.from({ length: 2000 }, (_, i) => line(i, 60_000))));
    expect(host.querySelectorAll(".log .row").length).toBe(2000);
    const dur = stage.compiled.duration;

    /*
     * 这一条原来钉的是 `log.all()` 的调用次数 —— 那一头每一批抄一遍整卷，抄卷子就是它的指纹。
     * 这一件消掉的正是那一笔：渲染路径从此不再调用 `all()`，所以那条断言钉的**就是这一件去掉的东西**，
     * 按仓库的规矩改它并记下这句话。新的指纹是"这一层做了几行"（`ui/rows.tsx` 的门口计数器），
     * 它比旧的更强：旧的那一头只要不抄卷子就绿，哪怕把已排好的那两千行重排一遍也看不见。
     */
    for (const t of [dur * 0.2, dur * 0.4, dur * 0.6]) {
      const before = rowsMeter.described;
      act(() => stage.seek(t));
      expect(rowsMeter.described - before).toBe(0);
    }
    // 带子真动了就必须排新落的那一行：这一行保证上面那一刀不是把面板冻住了。
    const grew = rowsMeter.described;
    act(() => stage.append([{ kind: "beat", duration: 500 }], MAIN_TRACK));
    expect(rowsMeter.described - grew).toBe(1);
    expect(host.querySelectorAll(".log .row").length).toBe(2001);
    act(() => root.unmount());
    host.remove();
  });

  /*
   * E 那一笔：`rowsMeter.described`/`published` 两把尺子都量不到"不动的那一帧走了几行"。裸容器每帧
   * 是一个新元素，React 要把那 n 行 child 逐格走一遍才知道能不能跳过 —— 行元素引用一个也没换、一行也
   * 没重做、那一份也没重抄，可这一帧仍然按 n 付费。这一笔节拍条那头已经用 memo 容器消掉（`Beats` +
   * `railMeter.boxed`），日志这一头补上同一把尺子。这里挂的是整棵 App（那个每帧重渲染的订阅者），
   * 不是门 —— 门那一头由 `rows.test.ts` 钉引用稳不稳，看不见 React 走了几格。
   */
  it("日志那一头：什么都不动的一帧，容器一次都不许进", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(App)));
    const stage = (globalThis as { __stage?: Stage }).__stage!;
    act(() => stage.load(Array.from({ length: 2000 }, (_, i) => line(i, 1000))));
    expect(host.querySelectorAll(".log .row").length).toBe(2000);
    // 站定在第 3 拍里，前后各 seek 一下：带子没长、拍没跨、lines 没动 —— 每一刀都是"什么都不动的那一帧"。
    const box = rowsMeter.boxed;
    const described = rowsMeter.described;
    const published = rowsMeter.published;
    for (let k = 0; k < 20; k += 1) act(() => stage.seek(3010 + (k % 2)));
    // 容器一次都不许进（进了就是逐格走了 2000 行一遍）
    expect(rowsMeter.boxed - box).toBe(0);
    // 前两把尺子本来就看不见这一笔，留着断言钉住"不是靠它们免费"
    expect(rowsMeter.described - described).toBe(0);
    expect(rowsMeter.published - published).toBe(0);
    act(() => root.unmount());
    host.remove();
  });

  it("日志那一头：短带与长带，不动那一帧进容器的次数一样（都是零）", () => {
    // 参照那一头量得到东西：下面"落一批进一次"在两种长度下都得是同一个数，可那一头是脏帧不是空帧。
    const walk = (n: number) => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      act(() => root.render(createElement(App)));
      const stage = (globalThis as { __stage?: Stage }).__stage!;
      act(() => stage.load(Array.from({ length: n }, (_, i) => line(i, 1000))));
      const box = rowsMeter.boxed;
      for (let k = 0; k < 30; k += 1) act(() => stage.seek(1010 + (k % 2)));
      const clean = rowsMeter.boxed - box;
      act(() => root.unmount());
      host.remove();
      return clean;
    };
    // 一百倍的带子，那一帧进容器一次都不许有：这一句才是"那一帧走几行不再跟着带子长"。
    expect(walk(30)).toBe(0);
    expect(walk(3000)).toBe(0);
  });

  it("日志那一头：容器 memo 过以后，新落的那一行仍然要进得了画面（不许冻住）", () => {
    /*
     * 这是 E 的护栏，也是最要紧的一句：把容器做成 memo 组件，若哪一天有人图省事把 `rows` 直接当那个
     * div 的唯一 child（引用不换），memo 会把整棵子树浅比对掉，新落那一行永远进不去 DOM —— 正是 C 踩
     * 过的那一次坑。所以这里在挂着的整棵 App 上核对 DOM 行数，而不是只问 `rowsFor` 交没交新引用。
     */
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(App)));
    const stage = (globalThis as { __stage?: Stage }).__stage!;
    act(() => stage.load(Array.from({ length: 200 }, (_, i) => line(i, 1000))));
    expect(host.querySelectorAll(".log .row").length).toBe(200);

    // 落一批：容器进一次（那一份换了引用），那一行也必须落到画面上。
    let box = rowsMeter.boxed;
    act(() => stage.append([{ kind: "narrate", text: "又一句", duration: 1000 }], MAIN_TRACK));
    expect(rowsMeter.boxed - box).toBe(1);
    expect(host.querySelectorAll(".log .row").length).toBe(201);

    // 带子换卷（剪带）：整卷重排，容器仍只进一次，画面对得上剪完的那一卷。
    box = rowsMeter.boxed;
    act(() => stage.rerollFrom(10));
    expect(rowsMeter.boxed - box).toBe(1);
    expect(host.querySelectorAll(".log .row").length).toBe(10);
    act(() => root.unmount());
    host.remove();
  });

  it("日志那一头：导演开口（lines 换引用）容器要进，讲完再不动就不进", () => {
    /*
     * App 那头把 `lines` 挂上了，可它只在导演讲话时换引用，而这一份探针没有活导演 —— 那一半没有尺子量：
     * 若 memo 的比对器只比 `rows` 忽略了 `lines`，App 那一头三问全绿（和 D 那一件 `M19` 同一句话：
     * 一个改了行为、却没有一把尺子的错法会静过去）。所以这一问直接挂 `LogRows` 这一棵，逼着它换 `lines`。
     */
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const rows = [] as ReactElement[];
    const render = (lines: { beat: number; text: string }[]) => act(() => root.render(createElement(LogRows, { rows, lines })));
    render([{ beat: 0, text: "第一句" }]);
    expect(host.querySelectorAll(".director-text").length).toBe(1);

    // 换一句新的（引用变了）：容器该进一次，画面跟上。
    let box = rowsMeter.boxed;
    render([{ beat: 0, text: "第一句" }, { beat: 1, text: "第二句" }]);
    expect(rowsMeter.boxed - box).toBe(1);
    expect(host.querySelectorAll(".director-text").length).toBe(2);

    // 同一份 lines 再 render 一次：一个字没动，容器一次都不许进。
    const same = [{ beat: 0, text: "第一句" }, { beat: 1, text: "第二句" }];
    render(same);
    box = rowsMeter.boxed;
    render(same);
    render(same);
    expect(rowsMeter.boxed - box).toBe(0);
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
