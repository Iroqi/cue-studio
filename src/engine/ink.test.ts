// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { compile } from "./compile";
import type { Box, Op, OpEntry } from "./types";
import { inkBox } from "./ink";

const tape = (...ops: Op[]): OpEntry[] => ops.map((op, i) => ({ seq: i, track: "main", turn: 0, op }));
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${body}</svg>`;
const WORLD: Box = { x: 1000, y: 400, w: 400, h: 300 };
const mid = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

describe("inkBox：道具真正画到的地方", () => {
  it("作者画布一角上的墨，换算成世界坐标", () => {
    const box = inkBox(svg('<rect x="10" y="10" width="40" height="40" fill="#fff"/>'), WORLD);
    expect(box?.x).toBeCloseTo(1065, 6);
    expect(box?.y).toBeCloseTo(415, 6);
    expect(box?.w).toBeCloseTo(60, 6);
    expect(box?.h).toBeCloseTo(60, 6);
  });

  it("塞满画布的墨，就等于声明的框", () => {
    const full = inkBox('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#fff"/></svg>', { x: 0, y: 0, w: 400, h: 200 });
    expect(full?.x).toBeCloseTo(0, 6);
    expect(full?.y).toBeCloseTo(0, 6);
    expect(full?.w).toBeCloseTo(400, 6);
    expect(full?.h).toBeCloseTo(200, 6);
  });

  it("viewBox 四个数按位读，错一位整幅画就偏移", () => {
    const off = inkBox('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect x="50" y="25" width="100" height="50" fill="#fff"/></svg>', { x: 0, y: 0, w: 400, h: 200 });
    expect(off).toEqual({ x: 100, y: 50, w: 200, h: 100 });
  });

  it("translate 之后的图形按落点算", () => {
    const moved = inkBox(svg('<g transform="translate(120,120)"><rect width="40" height="40" fill="#fff"/></g>'), WORLD);
    expect(moved?.x).toBeCloseTo(1230, 6);
    expect(moved?.y).toBeCloseTo(580, 6);
  });

  it("读不懂的变换与 <use> 退回声明的框，而不是给一个自信的错误", () => {
    expect(inkBox(svg('<g transform="rotate(30)"><rect width="40" height="40" fill="#fff"/></g>'), WORLD)).toBeUndefined();
    expect(inkBox(svg('<use href="#nothing"/>'), WORLD)).toBeUndefined();
    expect(inkBox(undefined, WORLD)).toBeUndefined();
  });

  it("fill=none 的空框不算墨", () => {
    expect(inkBox(svg('<rect width="200" height="200" fill="none" stroke="none"/>'), WORLD)).toBeUndefined();
  });
});

describe("镜头瞄准的是墨，不是道具被允许填满的那只框", () => {
  const corner = svg('<rect x="10" y="10" width="40" height="40" fill="#fff"/>');

  const focusOn = (markup: string | undefined) => {
    // build 只上板，不占时钟：这一条 tape 上唯一的 cue 就是那一刀 focus。
    const cues = compile(
      tape(
        { kind: "build", id: "a", box: WORLD, label: "a", svg: markup },
        { kind: "camera", mode: "focus", target: "a", duration: 800, easing: "ease" },
      ),
    ).cues;
    expect(cues).toHaveLength(1);
    return cues[0].to;
  };

  it("框的中心落在墨上", () => {
    const to = focusOn(corner);
    expect(Math.hypot(mid(to).x - 1095, mid(to).y - 445)).toBeLessThan(2);
  });

  it("这正是要修的那个错位：它离声明框的中心有一百多个单位", () => {
    const to = focusOn(corner);
    expect(Math.hypot(mid(to).x - 1200, mid(to).y - 550)).toBeGreaterThan(100);
  });

  it("量不到墨时，退回声明框的中心 —— 画面不能没有落点", () => {
    const to = focusOn(svg('<use href="#nothing"/>'));
    expect(mid(to).x).toBeCloseTo(1200, 6);
    expect(mid(to).y).toBeCloseTo(550, 6);
  });

  it("无论瞄哪里，取景框始终是屏幕的比例", () => {
    const filled = focusOn(svg('<rect width="200" height="200" fill="#fff"/>'));
    expect(focusOn(corner).w / focusOn(corner).h).toBeCloseTo(16 / 9, 6);
    expect(filled.w / filled.h).toBeCloseTo(16 / 9, 6);
  });

  it("特写不往人脸上怼：再小的墨也留着一个可读的框宽", () => {
    const dot = inkBox(svg('<circle cx="20" cy="30" r="4" fill="#fff"/>'), WORLD)!;
    expect(Math.max(dot.w, dot.h)).toBeLessThan(40);
    // 上面的下限是 450 世界单位，特写再近也不会超过它。
    expect(focusOn(corner).w).toBeGreaterThanOrEqual(450);
  });
});
