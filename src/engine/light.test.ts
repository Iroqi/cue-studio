// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { guardOp } from "./guard";
import { compile } from "./compile";
import { TapeIndex } from "./frame";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { StageView } from "./StageView";
import { describeOp } from "../ui/rows";
import type { Op } from "./types";

/*
 * `light` 是舞台上唯一不占时钟的"环境"一刀：不定板、不动道具、不花时间，只把台下的灯换掉。
 * 所以它和 transition 是两件事——幕布是换板的缝，灯是这一拍的光。这里钉的是三处：
 * 门不认的气氛要回退、换灯的账（moodAt）要按时刻翻、观众真的看见的差别（atmo 类名）。
 */

const say = (text: string, duration = 1000): Op => ({ kind: "narrate", text, duration });
const relight = (mood: "study" | "space" | "lab"): Op => ({ kind: "light", mood });
const tape = (...ops: Op[]) => ops.map((op, seq) => ({ seq, track: MAIN_TRACK, turn: 0, op }));

describe("guard：light 的气氛是枚枚举，不认的回退黑板本相", () => {
  it("认得的 mood 原样过门，连对象都不换", () => {
    const op = relight("study");
    expect(guardOp(op)).toBe(op);
  });

  it("不认的 mood 记一笔并回退 board，分享链接不会带着脏灯走", () => {
    const notes: string[] = [];
    const out = guardOp({ kind: "light", mood: "sunset" } as unknown as Op, (n) => notes.push(n));
    expect(out).toMatchObject({ kind: "light", mood: "board" });
    expect(notes.join(" ")).toContain("light.mood=sunset 不认");
  });
});

describe("compile：换灯不定板、不占时钟，账按时刻翻", () => {
  it("一场不换灯，永远是黑板本相", () => {
    const c = compile(tape(say("先讲一句", 600), say("再讲一句", 600)));
    const ix = new TapeIndex(c);
    expect(ix.moodAt(0)).toBe("board");
    expect(ix.moodAt(c.duration)).toBe("board");
  });

  it("light 不落 cue、不推时钟：两刀换灯之间没有多出一拍", () => {
    const c = compile(tape(relight("study"), say("书房里讲这句", 1200), relight("space")));
    const ix = new TapeIndex(c);
    // 两刀 light 都是零时长 —— 带子上只有那一句旁白在占时钟。
    expect(c.cues.map((q) => q.op.kind)).toEqual(["narrate"]);
    expect(c.duration).toBe(c.cues[0].end);
    // 开场就换上的灯一直亮到旁白收笔；收笔那一刻换进深空（下一拍从这盏灯开始）。
    const end = c.cues[0].end;
    expect(ix.moodAt(0)).toBe("study");
    expect(ix.moodAt(end - 1)).toBe("study");
    expect(ix.moodAt(end)).toBe("space");
  });

  it("同一刻换两次灯，最后那一刀说了算", () => {
    const c = compile(tape(say("先讲", 600), relight("study"), relight("lab")));
    const ix = new TapeIndex(c);
    // 两刀都落在旁白收笔的那一刻：这一拍是实验室，不是书房。
    const end = c.cues[0].end;
    expect(ix.moodAt(end - 1)).toBe("board");
    expect(ix.moodAt(end)).toBe("lab");
  });

  it("倒带回到换灯之前，就回到上一副灯", () => {
    const c = compile(tape(relight("study"), say("书房", 600), relight("space"), say("深空", 600)));
    const ix = new TapeIndex(c);
    const first = c.cues[0].end;
    const second = c.cues[1].end;
    expect(ix.moodAt(0)).toBe("study");
    expect(ix.moodAt(first - 1)).toBe("study");
    expect(ix.moodAt(first)).toBe("space");
    expect(ix.moodAt(second)).toBe("space");
  });
});

describe("rows：换灯在账本上留下一个字", () => {
  it("describeOp 把 light 报成布景", () => {
    expect(describeOp({ seq: 0, track: MAIN_TRACK, turn: 0, op: relight("space") }, new Map())).toBe("布景 space");
  });
});

// 舞台用 ResizeObserver 量自己的窗（dock 占多高就少画多高），jsdom 没有这个。
class NoResize {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoResize as unknown as typeof ResizeObserver;
// React 19 的 act() 要求宿主自己声明它在测试环境里，不然每次 render 都叫一声。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StageView：观众看见的是灯，不是后台", () => {
  it("atmo 层跟着 snapshot 的 mood 走，telemetry 已经拆走", () => {
    const stage = new Stage();
    stage.append([relight("study"), say("书房里讲这句", 1200)], MAIN_TRACK);
    stage.seek(600);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(StageView, { stage })));
    try {
      const atmo = host.querySelector(".atmo");
      expect(atmo?.className).toBe("atmo atmo-study");
      // 后台读数（props 数、t、等美工）不进观众的视野。
      expect(host.querySelector(".telemetry")).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("没换过灯，atmo 层是黑板本相", () => {
    const stage = new Stage();
    stage.append([say("黑板", 600)], MAIN_TRACK);
    stage.seek(300);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(StageView, { stage })));
    try {
      expect(host.querySelector(".atmo")?.className).toBe("atmo atmo-board");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
