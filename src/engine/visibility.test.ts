// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import type { Op } from "./types";

/*
 * 时钟读的是墙上的表（performance.now）。可浏览器把隐藏标签页的 rAF  throttled 成一秒一格，
 * 甚至干脆停掉：等这一页重新被看见，那一格的 dt 就是"整个不在场的时间"。学习者切出去两分钟，
 * 回来看到的是一堂已经演完的课，旁白还对着空房间念完了全程。
 *
 * 这里已经把 rAF 换成手拨的，所以浏览器那层节流不在测试范围内 —— 被测的是这个类自己的承诺：
 * 没有观众的时候，时钟不许走。
 */

const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });

let raf = 0;
let clockNow = 1000;
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => ++raf);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.spyOn(performance, "now").mockImplementation(() => clockNow);
  clockNow = 1000;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

const hide = () => Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
const show = () => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  document.dispatchEvent(new Event("visibilitychange"));
};
const step = (s: Stage, dt: number) => {
  clockNow += dt;
  (s as unknown as { last: number }).last = clockNow - dt;
  (s as unknown as { tick: (now: number) => void }).tick(clockNow);
};

const show_ = () => {
  const s = new Stage();
  s.goLive();
  s.append([line("一句很长的话，足够看出时钟有没有在走", 2000)], MAIN_TRACK);
  s.play();
  return s;
};

describe("没有观众的房间：时钟不许自己走", () => {
  it("切出去的那一刻停住，切回来接着走", () => {
    const s = show_();
    step(s, 500);
    expect(s.t).toBe(500);
    hide();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(s.playing).toBe(false);
    // 不在场的那两分钟：一格时钟都不许推进。
    step(s, 120000);
    expect(s.t).toBe(500);
    show();
    expect(s.playing).toBe(true);
    step(s, 300);
    expect(s.t).toBe(800);
  });

  it("学习者自己按的暂停，切回来不会被我们替他续上", () => {
    const s = show_();
    s.hold();
    hide();
    document.dispatchEvent(new Event("visibilitychange"));
    show();
    expect(s.playing).toBe(false);
  });

  it("幕布在空房间里被要求开演：先站着，等人回来", () => {
    const s = new Stage();
    s.goLive();
    s.append([line("回来以后才开演", 2000)], MAIN_TRACK);
    hide();
    s.play();
    expect(s.playing).toBe(false);
    expect(s.t).toBe(0);
    show();
    expect(s.playing).toBe(true);
  });

  it("停在考题上的那一刻切出去：回来的仍然是那道题，不是替学习者答完的下一拍", () => {
    const s = new Stage();
    s.goLive();
    s.append([line("先说一句", 2000), { kind: "quiz", prompt: "几？", options: ["甲", "乙"], answer: 0 }], MAIN_TRACK);
    s.play();
    step(s, 2000);
    expect(s.getSnapshot().gate?.kind).toBe("quiz");
    hide();
    document.dispatchEvent(new Event("visibilitychange"));
    show();
    expect(s.getSnapshot().gate?.kind).toBe("quiz");
  });

  it("重放（live=false）走完最后那一格会自己站住：切出去再回来不该再推它", () => {
    const s = new Stage();
    s.load([{ seq: 0, track: MAIN_TRACK, turn: 0, op: line("就一句", 1000) }]);
    expect(s.playing).toBe(false);
    hide();
    document.dispatchEvent(new Event("visibilitychange"));
    show();
    expect(s.playing).toBe(false);
  });
});
