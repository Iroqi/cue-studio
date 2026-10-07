import { describe, expect, it } from "vitest";
import { compile } from "./compile";
import type { HighlightOp, MotionOp, NarrateOp, Op, OpEntry, TransitionOp } from "./types";

const tape = (...ops: Op[]): OpEntry[] => ops.map((op, i) => ({ seq: i, track: "main", turn: 0, op }));

const line = (text: string, duration: number): NarrateOp => ({ kind: "narrate", text, duration });
const scene = (to: string, duration: number): TransitionOp => ({ kind: "transition", style: "dissolve", to, duration });
const mark = (target: string, duration: number): HighlightOp => ({ kind: "highlight", target, style: "pulse", duration });
const drift = (id: string, duration: number): MotionOp => ({ kind: "motion", id, mode: "oscillate", axis: "x", amp: 40, period: 1000, radius: 0, steps: 0, decay: 0, duration });
const art = (id: string): Op => ({ kind: "build", id, box: { x: 0, y: 0, w: 200, h: 200 }, label: id, html: `<p>${id}</p>` });

const LONG = "一".repeat(52);
const SHORT = "你好";

describe("compile：每一刀的时刻，就是上一句的长短", () => {
  it("念不完的那一拍被拉长之后，紧跟其后的镜头才动", () => {
    const cues = compile(tape(line(LONG, 2000), { kind: "camera", mode: "pan", dir: "right", duration: 900, easing: "ease" })).cues;
    expect(cues[0].t).toBe(0);
    // 2000ms 说不完这句话：窗口自己长到 10300（10000 念 + 300 落定）。
    expect(cues[0].end).toBe(10300);
    expect(cues[1].t).toBe(cues[0].end);
  });

  it("整场时长把落定尾巴和叠层的尾巴都算进去", () => {
    expect(compile(tape(line(LONG, 2000))).duration).toBe(10300);
    const withOverlay = compile(tape(line(SHORT, 2000), mark("a", 900)));
    expect(withOverlay.cues[0].end).toBe(2000);
    expect(withOverlay.duration).toBe(2900);
  });

  it("叠在旁白之上的强调与运动不推时钟", () => {
    const cues = compile(tape(line(SHORT, 2000), mark("a", 900), drift("a", 500), line("第二句", 1000))).cues;
    // 它们都落在上一句说完的那一刻，谁也不把时钟往前挪一格。
    expect(cues.map((c) => c.t)).toEqual([0, 2000, 2000, 2000]);
  });

  it("beat 是刻意的静默，长度按说的算", () => {
    const cues = compile(tape({ kind: "beat", duration: 1500 }, line("下一句", 1000))).cues;
    expect(cues[0].op.kind).toBe("beat");
    expect(cues[1].t).toBe(1500);
  });

  it("零秒的拍子不倒退时钟", () => {
    const cues = compile(tape({ kind: "beat", duration: 0 }, { kind: "beat", duration: 0 }, line("下一句", 1000))).cues;
    expect(cues[1].t).toBe(1);
    expect(cues[2].t).toBe(2);
  });

  it("换场短不过幕布盖住板的那一半，时钟跟着下限走", () => {
    const cues = compile(tape(scene("下一场", 120), line("新场上的一句话", 1000))).cues;
    expect(cues[0].end - cues[0].t).toBe(700);
    expect(cues[1].t).toBe(700);
  });

  it("道具落在这一步的时钟位置上，不是凭空早出现", () => {
    const props = [...compile(tape(line(LONG, 2000), art("a"))).props.values()];
    expect(props[0].revisions[0].t).toBe(10300);
  });
});
