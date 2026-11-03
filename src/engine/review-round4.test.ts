import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Stage } from "./runtime";
import { MAIN_TRACK } from "./log";
import type { Op } from "./types";

/*
 * 2026-11 第四轮深度 review 的回归钉。本轮先精读 runtime / llm / loop 与 reset 的调用路径
 * （App 的 start 与清空重来都走 `stage.reset()`），探针实测命中两个播放状态完整性缺陷：
 *
 *  - `reset()` 不清播放状态：正在播放时重开场/清空重来，`playing` 残留 true、rAF 还挂着，
 *    下一场开场的 `play()` 被 `if (this.playing) return` 一口吞掉，时钟从此卡死（或顶着陈旧
 *    `last` 时间戳以巨大 dt 直接跳完）。修复：reset 归零 playing/awaitingAudience 并取消 rAF。
 *  - `setSpeed` 无防线：负速让 `dt` 为负、时钟倒走出带子的 0 点（渲染问负时刻），零速让 rAF
 *    空转着"播放中"却一帧不走。修复：只收正有限数，其余回退 1×。
 */

let clockNow = 1000;
let raf = 0;
const step = (s: Stage, dt: number) => {
  clockNow += dt;
  (s as unknown as { last: number }).last = clockNow - dt;
  (s as unknown as { tick: (now: number) => void }).tick(clockNow);
};

beforeEach(() => {
  clockNow = 1000;
  raf = 0;
  vi.stubGlobal("requestAnimationFrame", () => ++raf);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.spyOn(performance, "now").mockImplementation(() => clockNow);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const beat = (duration: number): Op => ({ kind: "beat", duration });
const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });

describe("round4: 播放状态完整性", () => {
  it("播放中 reset 之后 play() 必须把新场次带起来（不再被残留 playing 吞掉）", () => {
    const s = new Stage();
    s.goLive();
    s.append([beat(20000), line("讲一段", 3000)], MAIN_TRACK);
    s.play();
    step(s, 1000);
    expect(s.getSnapshot().playing).toBe(true);
    expect(s.getSnapshot().t).toBe(1000);

    // 模拟"正在播放时重新开场"：reset 归零播放状态，旧 rAF 取消，新带从零排
    s.reset();
    expect(s.getSnapshot().playing).toBe(false);
    s.append([beat(20000), line("讲一段", 3000)], MAIN_TRACK);
    s.play();
    expect(s.getSnapshot().playing).toBe(true);
    step(s, 1000);
    expect(s.getSnapshot().t).toBe(1000);
  });

  it("reset 不把「等待观众」的挂起状态带进新场次", () => {
    const s = new Stage();
    // 隐藏房间里请求播放 → awaitingAudience=true
    vi.stubGlobal("document", { hidden: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    s.play();
    expect((s as unknown as { awaitingAudience: boolean }).awaitingAudience).toBe(true);
    s.reset();
    expect((s as unknown as { awaitingAudience: boolean }).awaitingAudience).toBe(false);
    expect(s.getSnapshot().playing).toBe(false);
    // 房间可见后再 play 是普通播放，不再欠一个观众
    vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    s.play();
    expect(s.getSnapshot().playing).toBe(true);
  });

  it("setSpeed 只收正有限数，负速/零速回退 1×，时钟不倒走", () => {
    const s = new Stage();
    s.goLive();
    s.append([beat(20000), line("讲一段", 3000)], MAIN_TRACK);
    s.play();
    s.setSpeed(-2);
    expect(s.getRate()).toBe(1);
    step(s, 1000);
    expect(s.getSnapshot().t).toBe(1000);
    s.setSpeed(0);
    expect(s.getRate()).toBe(1);
    s.setSpeed(2);
    expect(s.getRate()).toBe(2);
    step(s, 500);
    expect(s.getSnapshot().t).toBe(2000); // 1s 旧步 + 0.5s×2 倍速
  });
});
