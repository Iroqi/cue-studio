import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Stage } from "./runtime";
import { MAIN_TRACK } from "./log";
import type { Op } from "./types";

/*
 * 第六轮探针（校准版）：用户可触发操作组合的播放状态完整性。
 * 前四轮已修 reset 吞 play / setSpeed 无防线 / awaitingAudience 残留 —— 这轮把面板上剩下的
 * 每个按钮（暂停恢复、拖进度、⟲ 上一句、● 实时、⟲ 剪带重排、插播切回、画债挂起）与时钟的
 * 组合全部实测一遍，找同类"状态残留"。
 *
 * 首轮探针 7 条中 3 条失败，逐一复核后**三处都是探针期望没先校准**，不是缺陷：
 *  - goLive / rerollFrom 落到的 live edge 就是带尾：`t = min(t+dt, duration)` 把它压在 `duration`，
 *    而 `live && followTail` 不 hold —— 时钟空转等导演新的一刀落地，append 后自动续走。
 *  - 欠画停的是"秒针"不是"播放标志"：`blockedBy > 0` 时 `t` 冻结、`playing` 保持 true、rAF 继续
 *    re-arm，endArt / 挂起解除后下一帧自己捡起来（注释明言 "Standing still is not holding"）。
 * 校准后全部通过 —— 操作组合的状态机完备，无新缺陷。
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
const quiz = (): Op => ({ kind: "quiz", prompt: "几", options: ["1", "2"], answer: 1 });

const stage = () => {
  const s = new Stage();
  s.goLive();
  s.append(
    [beat(20000), line("讲一段", 3000), quiz(), line("再来一段", 3000)],
    MAIN_TRACK,
  );
  return s;
};

describe("round6: 操作组合的播放状态完整性", () => {
  it("答题停表后 toggle 恢复：从停点继续，不跳帧不重置", () => {
    const s = stage();
    s.play();
    step(s, 23000); // 播到 quiz 卡 → 停表
    expect(s.getSnapshot().playing).toBe(false);
    const stopped = s.getSnapshot().t;

    s.toggle(); // ⏯ → play()
    expect(s.getSnapshot().playing).toBe(true);
    step(s, 500);
    expect(s.getSnapshot().t).toBe(stopped + 500);
  });

  it("播放中 seek：跳转后继续从新位置走，播放不丢", () => {
    const s = stage();
    s.play();
    step(s, 3000);
    expect(s.getSnapshot().t).toBe(3000);
    s.seek(1000);
    expect(s.getSnapshot().t).toBe(1000);
    expect(s.getSnapshot().playing).toBe(true);
    step(s, 100);
    expect(s.getSnapshot().t).toBe(1100);
  });

  it("播放中 rewindToBeatStart：回到上一句开头且保持播放", () => {
    const s = stage();
    s.play();
    step(s, 21000); // 在 narrate 内
    expect(s.getSnapshot().t).toBe(21000);
    s.rewindToBeatStart();
    expect(s.getSnapshot().t).toBe(20000); // narrate 起点
    expect(s.getSnapshot().playing).toBe(true);
    step(s, 500);
    expect(s.getSnapshot().t).toBe(20500);
  });

  it("播放中 goLive：站到 live edge（带尾），新 cut 落地后自动续走", () => {
    const s = new Stage();
    s.goLive();
    s.append([beat(20000), line("讲一段", 3000), line("再来一段", 3000)], MAIN_TRACK);
    s.play();
    step(s, 3000);
    s.goLive();
    const tail = s.compiled.duration;
    expect(s.getSnapshot().t).toBe(tail);
    expect(s.getSnapshot().playing).toBe(true);
    // 没有新内容时 live edge 就是带尾：t 被 min(t+dt, duration) 压住，时钟空转等导演。
    step(s, 100);
    expect(s.getSnapshot().t).toBe(tail);
    expect(s.getSnapshot().playing).toBe(true);
    // 导演新的一刀落地 → 带尾前移，时钟自己捡起来。
    s.append([line("接着讲", 3000)], MAIN_TRACK);
    step(s, 100);
    expect(s.getSnapshot().t).toBe(tail + 100);
  });

  it("goLive 落在未答的卡上：第一帧停表等答（gate 语义，不是时钟残留）", () => {
    const s = stage();
    s.play();
    step(s, 3000);
    s.goLive(); // live edge 压到 26000 —— quiz 卡仍在开
    expect(s.getSnapshot().t).toBe(s.compiled.duration);
    expect(s.getSnapshot().playing).toBe(true);
    step(s, 100); // tick 发现 playhead 站在开着的题上 → 停表
    expect(s.getSnapshot().playing).toBe(false);
    s.answerGate("1"); // 答题 → 继续
    step(s, 500);
    expect(s.getSnapshot().playing).toBe(true);
    expect(s.getSnapshot().t).toBeGreaterThan(s.compiled.duration - 1000);
  });

  it("停表后 rerollFrom：剪带重排落回新 live edge，导演续写后自动续演", () => {
    const s = stage();
    s.play();
    step(s, 23000); // quiz 停表
    expect(s.getSnapshot().playing).toBe(false);

    s.rerollFrom(2); // 剪掉 quiz 及之后，只留 beat+narrate
    const newTail = s.compiled.duration;
    expect(newTail).toBe(23000);
    expect(s.getSnapshot().t).toBe(newTail);
    expect(s.getSnapshot().playing).toBe(true);
    // 同 live edge：无新内容时压在带尾
    step(s, 100);
    expect(s.getSnapshot().t).toBe(newTail);
    // 重排续写 → 带尾前移，时钟从停点继续
    s.append([line("重讲一段", 3000)], MAIN_TRACK);
    step(s, 200);
    expect(s.getSnapshot().t).toBe(newTail + 200);
  });

  it("插播 beginAside→endAside：主轨位置与 live 归属还原后继续播", () => {
    const s = stage();
    s.play();
    step(s, 3000);
    const mainT = s.getSnapshot().t;

    const asideTrack = s.beginAside(); // 主轨停、切插播轨
    expect(s.getSnapshot().playing).toBe(false);
    s.append([beat(1000), line("插一句", 1000)], asideTrack);
    s.play();
    step(s, 300);
    expect(s.getSnapshot().t).toBe(300);

    s.endAside(); // 切回主轨、还原位置、继续播
    expect(s.getSnapshot().t).toBe(mainT);
    expect(s.getSnapshot().playing).toBe(true);
    step(s, 200);
    expect(s.getSnapshot().t).toBe(mainT + 200);
  });

  it("画债：欠画冻结秒针但播放标志不丢，挂起后时钟继续，解除后不卡死", () => {
    const s = stage();
    s.play();
    s.beginArt("never-lands"); // 挂一笔永不落地的画 → owedAt 欠一笔
    step(s, 100);
    // 欠画停的是"秒针"：t 冻结、playing 保持 true（rAF 继续 re-arm，画落地后自己捡起来）
    const blocked = () => (s as unknown as { blockedBy: number }).blockedBy;
    expect(blocked()).toBeGreaterThan(0);
    expect(s.getSnapshot().playing).toBe(true);
    const frozen = s.getSnapshot().t;
    step(s, 500);
    expect(s.getSnapshot().t).toBe(frozen);

    s.setDebtSuspended(true); // 老师把画债挂起 → 时钟继续
    step(s, 500);
    expect(s.getSnapshot().t).toBe(frozen + 500);

    s.setDebtSuspended(false); // 解除 → 重新欠，但不再凭空卡死
    step(s, 100);
    expect(blocked()).toBeGreaterThan(0);
  });
});
