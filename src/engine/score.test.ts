// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { compile } from "./compile";
import { beatAt, scoreOf } from "../ui/score";
import { ESC_RETRY, ESC_SKIP } from "../agent/loop";
import App from "../App";
import type { Op, OpEntry } from "./types";

/*
 * 这一节钉的是**这一场的账**（Intelligent UI 的 show your work / progress / cost）：带子上已有的东西
 * —— 拍数、问了几道、答对几道、答错几道、逃了几道 —— 亮到台上。纯派生，不带时钟、不带模型、不带档案：
 * 同一卷带子，重放与现场同账。分界的每一刀都照 `settleGate` 同一条线画：pause-for 不算题、逃生句不算错、
 * 自由文本不算错（那是"没判分"，不是"答错"）。孤儿 answer 自然不在这本账上（账只从 `gates` 读）。
 *
 * 三层照旧分开钉：账数得对不对（形状）、账目条的元素不跟着带子长（价钱）、把任何一刀画错都红（护栏）。
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

const line = (text: string, duration = 1000): Op => ({ kind: "narrate", text, duration });
const quiz = (prompt: string, options: string[], answer: number): Op => ({ kind: "quiz", prompt, options, answer });
const probe = (answer: string): Op => ({ kind: "probe", prompt: "点一下：哪个是合力？", targets: ["vec-a", "vec-b"], answer });
const dial = (value: number, tol = 5): Op => ({ kind: "dial", prompt: "先凭直觉拨一下：这个频率是多少？", min: 0, max: 100, value, tol, unit: "Hz" });
const type = (accept: string[]): Op => ({ kind: "type", prompt: "用一句话说清楚：什么是导数？", accept });
const pause = (): Op => ({ kind: "pause-for", reason: "我准备好了" });
const said = (gate: number, text: string): Op => ({ kind: "answer", gate, text });

/** 一拍 = 一句台词 + 为这句搭的东西：旁白/beat 之后下一 op 才开新拍（compile 的 openNext 规则）。
 * 测试里要的拍数不靠猜 —— 每个用例都按这条规则数好写死。 */
const tape = (ops: Op[]): OpEntry[] => ops.map((op, seq) => ({ seq, track: MAIN_TRACK, turn: seq, op }));
const score = (ops: Op[]) => scoreOf(compile(tape(ops)));

describe("形状：这一场的账数得对", () => {
  it("空带：一本全零的账", () => {
    expect(score([])).toEqual({ beats: 0, asking: 0, open: 0, correct: 0, wrong: 0, escaped: 0 });
  });

  it("有对有错有逃有没判分的：各自进各自那一格", () => {
    const ops = [
      line("开场"),
      quiz("合力多大？", ["5N", "7N"], 0),
      said(1, "5N"), // 对
      dial(42), // 对
      said(3, "42"),
      quiz("谁在往右？", ["甲", "乙"], 1),
      said(5, "甲"), // 错
      type(["瞬时", "变化率"]),
      said(7, ESC_RETRY), // 逃：不算错
      probe("vec-a"),
      said(9, "不太确定"), // 自由文本：没判分，不算错
      pause(),
      said(11, "继续"),
      quiz("最后一问？", ["是", "否"], 0), // 开着的卡
    ];
    expect(score(ops)).toEqual({ beats: 2, asking: 6, open: 1, correct: 2, wrong: 1, escaped: 1 });
  });

  it("「跳过这道」也进逃生那一格，不进错的那格", () => {
    const ops = [quiz("合力多大？", ["5N", "7N"], 0), said(0, ESC_SKIP), quiz("再问？", ["是", "否"], 1), said(2, "否")];
    expect(score(ops)).toEqual({ beats: 1, asking: 2, open: 0, correct: 1, wrong: 0, escaped: 1 });
  });

  it("自由文本的各路都不算错：quiz 没选选项、probe 没点图形、dial 没拨杆、type 没定词", () => {
    const ops = [
      quiz("合力多大？", ["5N", "7N"], 0),
      said(0, "我觉得是中间吧"),
      probe("vec-a"),
      said(2, "vec-b"), // 点 id：判分，错
      dial(42),
      said(4, "不知道"),
      type([]), // accept 空表：guard 退成开放式，没词可查
      said(6, "瞬时变化率"),
    ];
    expect(score(ops)).toEqual({ beats: 1, asking: 4, open: 0, correct: 0, wrong: 1, escaped: 0 });
  });

  it("孤儿 answer（gate 指不到卡）不在这本账上", () => {
    const ops = [line("开场"), said(9, "随口一句"), quiz("合力多大？", ["5N", "7N"], 0)];
    expect(score(ops)).toEqual({ beats: 2, asking: 1, open: 1, correct: 0, wrong: 0, escaped: 0 });
  });

  it("同账的两种落法：append 出来的带子与直接排的带子，账一字不差", () => {
    const ops = [quiz("合力多大？", ["5N", "7N"], 0), said(0, "5N"), quiz("再问？", ["是", "否"], 1), said(2, ESC_SKIP)];
    const stage = new Stage();
    stage.append(ops, MAIN_TRACK);
    expect(scoreOf(stage.compiled)).toEqual(score(ops));
  });

  it("beatAt：时钟站在哪一拍，出去之后站在外面", () => {
    const beats = compile(tape([line("甲", 1000), line("乙", 1000), line("丙", 1000)])).beats;
    expect(beatAt(beats, 100)).toBe(0);
    expect(beatAt(beats, 1500)).toBe(1);
    expect(beatAt(beats, 2999)).toBe(2);
    expect(beatAt(beats, 0)).toBe(0);
    expect(beatAt(beats, -5)).toBe(-1);
    expect(beatAt(beats, 5000)).toBe(-1);
  });
});

/*
 * 价钱那一头：账目条是一个常驻的细条，数的是"拍数/问数/对错/跳过/tokens"，不是一个一个的格子。
 * 所以它的元素数不许跟着带子长 —— 短带长带，账目条同格数。数元素，不数毫秒。
 * （usage 那格只有真叫了模型才出现，这一份探针没有活导演，所以比的是"拍到哪 + 账"两格。）
 */
describe("价钱：账目条的元素数不跟着带子长", () => {
  const env = () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(App)));
    const stage = (globalThis as { __stage?: Stage }).__stage!;
    return { host, root, stage };
  };

  /** n 道题带 n 句答：带子越长，问得越多 —— 账目条不许多出一个格子。 */
  const quizzed = (n: number) =>
    Array.from({ length: n }, (_, i) => [quiz(`Q${i}？`, ["a", "b"], 0), said(i * 2, "a")] as Op[]).flat();

  it("三十问与三千问：账目条同格数（拍到哪 + 账，两格）", () => {
    const walk = (n: number) => {
      const { host, root, stage } = env();
      act(() => stage.load(tape(quizzed(n))));
      const cells = host.querySelectorAll(".score > *").length;
      act(() => root.unmount());
      host.remove();
      return cells;
    };
    // 三千道题的带子，账目条不该多出任何一个格子。
    expect(walk(30)).toBe(2);
    expect(walk(3000)).toBe(2);
  });

  it("带子一换卷（剪带），账跟着新卷走，而不是冻在旧账上", () => {
    const { host, root, stage } = env();
    act(() => stage.load(tape([quiz("合力多大？", ["5N", "7N"], 0), said(0, "5N"), line("接着讲")])));
    const after = () => host.querySelector(".score-account")?.textContent ?? "";
    expect(after()).toContain("问 1");
    expect(after()).toContain("对 1");
    // 剪到零：账目条把旧账整个摘掉，不许留下"问 1 · 对 1"。
    act(() => stage.rerollFrom(0));
    expect(host.querySelector(".score-account")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});

/*
 * 护栏那一头（变异清单）：把账上任何一刀画错，都必须在整棵 App 上红出来。
 */
describe("护栏：账目条在整棵 App 上照实记账", () => {
  it("一场有对有错有逃有开着卡的课：账目条把它数出来", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(App)));
    const stage = (globalThis as { __stage?: Stage }).__stage!;
    act(() =>
      stage.append(
        [
          quiz("合力多大？", ["5N", "7N"], 0),
          said(0, "5N"), // 对
          quiz("谁在往右？", ["甲", "乙"], 1),
          said(2, "甲"), // 错
          type(["瞬时", "变化率"]),
          said(4, ESC_RETRY), // 逃
          probe("vec-a"),
          said(6, "不太确定"), // 自由文本：不算错
          pause(),
          said(8, "继续"), // 不算题
          quiz("最后一问？", ["是", "否"], 0), // 开着的卡
        ],
        MAIN_TRACK,
      ),
    );
    const account = host.querySelector(".score-account")?.textContent ?? "";
    // 五道题：三道 quiz + type + probe；pause-for 不算题。
    expect(account).toContain("问 5");
    expect(account).toContain("对 1");
    expect(account).toContain("错 1");
    expect(account).toContain("跳过 1");
    expect(account).toContain("还开着 1");
    // 拍数是这一场的：账目条在，而且它说的是"第 1/1 拍"（一批就是这一场）。
    expect(host.querySelector(".score-where")?.textContent).toContain("第 1/1 拍");
    act(() => root.unmount());
    host.remove();
  });
});
