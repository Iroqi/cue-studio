import { describe, expect, it } from "vitest";
import { cueMs } from "./compile";
import { SETTLE_MS, speechMs } from "./speech";
import type { BeatOp, CameraOp, NarrateOp, TransitionOp } from "./types";

const line = (text: string, duration = 0): NarrateOp => ({ kind: "narrate", text, duration });
const scene = (duration: number): TransitionOp => ({ kind: "transition", style: "dissolve", to: "下一场", duration });
const shot = (duration: number): CameraOp => ({ kind: "camera", mode: "pan", dir: "right", duration, easing: "ease" });
const rest = (duration: number): BeatOp => ({ kind: "beat", duration });

describe("speechMs：一句话按正常语速要念多久", () => {
  it("汉字每秒 5.2 个", () => {
    expect(speechMs("一".repeat(52))).toBe(10000);
  });

  it("拉丁字母和数字按每秒 11 个字符读", () => {
    expect(speechMs("abcdefghij123456")).toBe(1455);
  });

  it("中英混排各按各的速度，再加起来", () => {
    expect(speechMs("一".repeat(26) + "abcd")).toBe(5364);
  });

  it("句末停 250ms，句内停 120ms", () => {
    const bare = speechMs("好");
    expect(speechMs("好。") - bare).toBe(250);
    expect(speechMs("好，") - bare).toBe(120);
  });

  it("空的或者只有标点的句子不占时间", () => {
    expect(speechMs("")).toBe(0);
    expect(speechMs("。。。")).toBe(750);
  });

  it("长一句不会比短一句念得快", () => {
    for (let n = 1; n <= 40; n++) {
      const a = speechMs("一".repeat(n));
      const b = speechMs("一".repeat(n + 1));
      expect(b).toBeGreaterThanOrEqual(a);
      // 每个字至少值 1/5.2 秒：字数换了口径，这一条会先红。
      expect(b - a).toBeGreaterThanOrEqual(150);
    }
  });
});

describe("cueMs：秒数是下限，不是上限", () => {
  it("念不完的一拍会被拉长到念得完，末尾再留一拍落定", () => {
    const spoken = line("一".repeat(52), 2000);
    expect(cueMs(spoken)).toBe(10300);
    expect(cueMs(spoken)).toBe(speechMs(spoken.text) + SETTLE_MS);
  });

  it("已经够长的拍子一秒都不压", () => {
    expect(cueMs(line("你好", 20000))).toBe(20000);
  });

  it("落定尾巴就是那 300ms", () => {
    expect(SETTLE_MS).toBe(300);
  });

  it("换场短不过幕布盖住整块板的那一半", () => {
    expect(cueMs(scene(120))).toBe(700);
    expect(cueMs(scene(1600))).toBe(1600);
  });

  it("叠在旁白之上的镜头与静止拍按自己说的走", () => {
    expect(cueMs(shot(800))).toBe(800);
    expect(cueMs(rest(1200))).toBe(1200);
  });

  it("零秒的叠层也占得住一格，时钟不会倒退", () => {
    expect(cueMs(shot(0))).toBe(1);
    expect(cueMs(rest(0))).toBe(1);
  });
});
