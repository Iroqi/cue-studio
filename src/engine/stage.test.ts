import { describe, expect, it } from "vitest";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { SETTLE_MS } from "./speech";
import type { Box, Op } from "./types";

const at = (x: number, y: number): Box => ({ x, y, w: 200, h: 160 });
const art = (id: string, scene?: string): Op => ({ kind: "build", id, scene, box: at(0, 0), label: id, html: `<p>${id}</p>` });
const to = (board: string, duration: number): Op => ({ kind: "transition", style: "dissolve", to: board, duration });
const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });
const beat = (duration: number): Op => ({ kind: "beat", duration });

const show = (...ops: Op[]): Stage => {
  const s = new Stage();
  s.append(ops, MAIN_TRACK);
  return s;
};
const onStage = (s: Stage, t: number): string[] => {
  s.seek(t);
  return s.getSnapshot().props.map((p) => p.id);
};
/** 最后一拍说完之后：台上就是观众离场前看见的那一幅。 */
const atEnd = (s: Stage): string[] => onStage(s, s.compiled.duration);

const LONG = "一".repeat(52);

describe("换场扫板：该退的退，复用的留", () => {
  it("第一刀之前，两块板上的道具都还在同一张无限画布上", () => {
    const s = show(art("a", "甲"), art("b", "乙"), line("开一条新思路，不算是换场", 2000));
    expect(onStage(s, 0)).toEqual(["a", "b"]);
    expect(s.boardAt(1999)).toBeNull();
  });

  it("幕布盖住整块板的那一刻才扫，之前旧板仍在眼前", () => {
    const s = show(art("a", "甲"), to("丙", 1200), art("c", "丙"), beat(400));
    // 换场窗口 0..1200，flip 在 600 —— veil 的中点才是观众看不见跳切的那一瞬间。
    expect(onStage(s, 550)).toEqual(["a"]);
    expect(s.boardAt(550)).toBeNull();
    expect(onStage(s, 601)).toEqual([]);
    expect(s.boardAt(601)).toBe("丙");
  });

  it("换场之后落下的道具不属于被扫走的那一批", () => {
    const s = show(art("a", "甲"), art("b", "乙"), to("丙", 1200), art("c", "丙"), beat(400));
    expect(onStage(s, 1250)).toEqual(["c"]);
    expect(s.visibleName("a", 1250)).toBe(false);
    expect(s.visibleName("b", 1250)).toBe(false);
    expect(s.visibleName("丙", 1250)).toBe(true);
    expect(s.visibleName("丙", 550)).toBe(false);
  });

  it("recall 盖上新板名，把被扫走的道具带回眼前", () => {
    const s = show(art("a", "甲"), to("丙", 1200), art("c", "丙"), beat(400));
    expect(atEnd(s)).toEqual(["c"]);
    s.append([{ kind: "recall", id: "a", box: at(600, 0) }], MAIN_TRACK);
    expect(atEnd(s)).toEqual(["a", "c"]);
    expect(s.visibleName("a", s.compiled.duration)).toBe(true);
  });

  it("跨场复用是功能：patch 时写上板名，道具就跟着挪过去", () => {
    const s = show(art("a", "甲"), to("丙", 1200), beat(400));
    expect(atEnd(s)).toEqual([]);
    s.append([{ kind: "patch", id: "a", scene: "丙", html: "<p>a 改过</p>" }], MAIN_TRACK);
    expect(atEnd(s)).toEqual(["a"]);
    s.seek(s.compiled.duration);
    expect(s.getSnapshot().props[0].scene).toBe("丙");
  });

  it("没有换场的整场戏，一次也不会扫板", () => {
    const s = show(art("a", "甲"), art("b", "乙"), line(LONG, 2000), { kind: "camera", mode: "pan", dir: "right", duration: 800, easing: "ease" }, art("d", "丁"), line("又走了一屏", 1000));
    expect(onStage(s, 0)).toEqual(["a", "b"]);
    expect(onStage(s, 10300)).toEqual(["a", "b", "d"]);
    expect(s.boardAt(s.compiled.duration)).toBeNull();
  });
});

describe("旁白与字幕共用同一个窗口", () => {
  const spoken = () => show(line(LONG, 2000));

  it("字幕在切走前 300ms 就说完了", () => {
    const s = spoken();
    s.seek(10300 - SETTLE_MS);
    const n = s.getSnapshot().narration;
    expect(n?.reveal).toBeCloseTo(1, 6);
    expect(n?.progress).toBeLessThan(1);
  });

  it("progress 仍是窗口占比：语音靠它反推这一拍从哪一刻开始", () => {
    const s = spoken();
    s.seek(5150);
    expect(s.getSnapshot().narration?.progress).toBeCloseTo(0.5, 6);
  });

  it("这一拍的窗口就是念完加上落定", () => {
    const s = spoken();
    s.seek(10000);
    const n = s.getSnapshot().narration;
    expect(n?.duration).toBe(10300);
    expect(n?.text).toBe(LONG);
    expect(s.compiled.duration).toBe(10300);
  });
});
