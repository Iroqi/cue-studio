// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import type { Box, Op } from "./types";

/*
 * `live` 曾经是两个字。一个是"这堂课是我在上的，不是别人录的"，另一个是"观众此刻把放映头拨走了"。
 * 它们管的不是同一件事：前者决定题卡该不该拦住时钟、时钟该不等不等没落地的画面（录像里画面早就在
 * 带上）；后者只决定"● 实时"那颗按钮该不该亮。
 *
 * 合成一个开关之后，任何一次"只想回去看一眼"都悄悄把整堂课变成了录像 —— 而一轮插播的结尾、`⟲ 一拍`
 * 走的都是这条路。于是从那之后：
 *   - `ask_learner` 排到带上却永远不会拦停时钟，导演的轮次挂在 `waitForAnswer` 上，屏幕上没有题卡；
 *   - "时钟不许跑在画面前面"这条头牌规则同时失效，旁白从还没落地的空白框上走过去。
 * 这里钉的是拆完之后各自的那半。
 */

const at = (x: number, y: number): Box => ({ x, y, w: 200, h: 160 });
const art = (id: string): Op => ({ kind: "build", id, box: at(0, 0), label: id, html: `<p>${id}</p>` });
/** 骨架落下、美工还没交的那一格：时钟必须停在它的拍边。 */
const blank = (id: string): Op => ({ kind: "build", id, box: at(0, 0), label: id });
const line = (text: string, duration = 1000): Op => ({ kind: "narrate", text, duration });
const ask = (prompt: string): Op => ({ kind: "quiz", prompt, options: ["甲", "乙"], answer: 0, concept: "c" });
const LONG = "一".repeat(52);

let raf = 0;
let clockNow = 1000;
const step = (s: Stage, dt: number) => {
  clockNow += dt;
  (s as unknown as { last: number }).last = clockNow - dt;
  (s as unknown as { tick: (now: number) => void }).tick(clockNow);
};

beforeEach(() => {
  raf = 0;
  clockNow = 1000;
  vi.stubGlobal("requestAnimationFrame", () => ++raf);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.spyOn(performance, "now").mockImplementation(() => clockNow);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 走表，直到它自己站住 —— 停在题上，或者走到带子的头。 */
const walk = (s: Stage, limit = 4000) => {
  s.play();
  for (let i = 0; i < limit && s.playing; i++) step(s, 50);
  return s;
};

/** 一轮插播：打断、答完、回到主线。 */
const oneAside = (s: Stage) => {
  const track = s.beginAside();
  s.append([line("插播里的一句话", 500)], track);
  s.endAside();
};

describe("插播不是转行：一轮插播之后这堂课还是我上的那堂", () => {
  it("插播结束后，没答过的题照样拦住时钟", () => {
    const s = new Stage();
    s.goLive();
    s.append([art("a"), line("第一拍", 1000)], MAIN_TRACK);
    oneAside(s);
    s.append([ask("合力是多少？"), line("答完再往下", 1000)], MAIN_TRACK);
    walk(s);
    expect(s.getSnapshot().gate?.seq).toBe(s.compiled.gates[0].seq);
  });

  it("插播结束后，画面没落地时时钟照样短停", () => {
    const s = new Stage();
    s.goLive();
    s.append([art("a"), line(LONG, 2000)], MAIN_TRACK);
    oneAside(s);
    // 回到主线，导演排了一格欠画的框；这一轮收口，画还在后台。
    s.append([blank("b"), line("第二句也在同一拍说完", 2000)], MAIN_TRACK);
    s.setTurnOpen(true);
    s.beginPaint("b");
    s.setTurnOpen(false);
    s.play();
    step(s, 10000 - s.t);
    expect(s.t).toBe(10000); // 正好停在欠画那一拍的边上，不从它上面走过去
    step(s, 500);
    expect(s.t).toBe(10000);
    expect(s.getSnapshot().artOwed).toBeGreaterThan(0);
  });

  it("导演停在题上等回答，中间插一轮播，那句话仍然是答案", () => {
    const s = new Stage();
    s.goLive();
    s.append([art("a"), ask("这一题还没人答"), line("后面", 1000)], MAIN_TRACK);
    walk(s);
    const card = s.getSnapshot().gate!.seq;
    oneAside(s);
    expect(s.getSnapshot().gate?.seq).toBe(card);
    s.answerGate("甲");
    expect(s.compiled.gates.find((g) => g.seq === card)?.said).toBe("甲");
  });
});

describe("⟲ 一拍：回卷重演，课还是活的", () => {
  it("答过的题回卷重演时不再拦人 —— 那是 answer 上带买到的东西", () => {
    const s = new Stage();
    s.goLive();
    s.append([art("a"), line("第一拍", 1000), ask("已经答过了"), line("第二拍", 1000)], MAIN_TRACK);
    walk(s);
    s.answerGate("甲");
    walk(s);
    s.rewindToBeatStart(4000);
    walk(s);
    expect(s.getSnapshot().gate).toBeNull();
    expect(s.t).toBe(s.compiled.duration);
  });

  it("回卷之后导演新排的题，照样拦停时钟", () => {
    const s = new Stage();
    s.goLive();
    s.append([art("a"), line("第一拍", 1000), line("第二拍", 1000)], MAIN_TRACK);
    walk(s);
    s.rewindToBeatStart(3000);
    s.append([ask("重演之后这一题还在吗"), line("收尾", 1000)], MAIN_TRACK);
    walk(s);
    expect(s.getSnapshot().gate?.seq).toBe(s.compiled.gates[0].seq);
  });
});

describe("放映头的位置只管按钮，不管这堂课是谁的", () => {
  it("自己的课拨回旧的一秒：实时该灭，但这堂课还是我的", () => {
    const s = new Stage();
    s.goLive();
    s.append([art("a"), line("第一拍", 1000)], MAIN_TRACK);
    expect(s.getSnapshot().following).toBe(true);
    s.seek(400);
    expect(s.getSnapshot().following).toBe(false);
    expect(s.live).toBe(true);
    s.append([ask("拨回去也还是问我"), line("第二拍", 1000)], MAIN_TRACK);
    walk(s);
    expect(s.getSnapshot().gate?.seq).toBe(s.compiled.gates[0].seq);
  });

  it("拨回去再摁实时，放映头重新跟到导演刚写下的那一拍", () => {
    const s = new Stage();
    s.goLive();
    s.append([art("a"), line("第一拍", 1000)], MAIN_TRACK);
    s.seek(400);
    s.goLive();
    expect(s.getSnapshot().following).toBe(true);
    expect(s.t).toBe(s.compiled.duration);
  });

  it("欠画那一拍的短停，跟拨没拨过无关", () => {
    const s = new Stage();
    s.goLive();
    s.append([art("a"), line(LONG, 2000)], MAIN_TRACK);
    s.seek(300);
    s.append([blank("b"), line("第二句", 2000)], MAIN_TRACK);
    s.setTurnOpen(true);
    s.beginPaint("b");
    s.setTurnOpen(false);
    walk(s);
    expect(s.getSnapshot().artOwed).toBeGreaterThan(0);
  });

  it("回看到旧的一秒，走到带子的头仍然自己站住（这一条从前是 live 管的）", () => {
    const s = new Stage();
    s.goLive();
    s.append([art("a"), line("第一拍", 1000), line("第二拍", 1000)], MAIN_TRACK);
    s.seek(500);
    walk(s);
    expect(s.t).toBe(s.compiled.duration);
    expect(s.playing).toBe(false);
  });

  it("跟着实时头的课走到带子的头时，不站住 —— 导演下一拍落下它自己接上走", () => {
    const s = new Stage();
    s.goLive();
    s.append([art("a"), line("第一拍", 1000)], MAIN_TRACK);
    walk(s);
    expect(s.t).toBe(s.compiled.duration);
    expect(s.playing).toBe(true);
    s.append([line("导演后来才排的第二拍", 1000)], MAIN_TRACK);
    step(s, 500);
    expect(s.t).toBeGreaterThan(1000);
  });
});

describe("别人录的一场：看的人不该被打扰，也不该等画面", () => {
  const recorded = (): OpEntryish[] => {
    const s = new Stage();
    s.goLive();
    s.append([art("a"), ask("上一场没人答过"), line("收尾", 1000)], MAIN_TRACK);
    return s.log.export() as unknown as OpEntryish[];
  };
  type OpEntryish = { seq: number; track: string; turn: number; op: Op };

  it("重放一路走到底，一次都不停在题上，到了头自己站住", () => {
    const s = new Stage();
    s.load(recorded());
    walk(s);
    expect(s.t).toBe(s.compiled.duration);
    expect(s.getSnapshot().gate).toBeNull();
    expect(s.playing).toBe(false);
    expect(s.live).toBe(false);
  });

  it("录像不等美工：画面早就在带上", () => {
    const s = new Stage();
    s.load(recorded());
    s.beginPaint("a");
    walk(s);
    expect(s.getSnapshot().artOwed).toBe(0);
  });

  it("真想上这门课时，板子从这一刻起接住他", () => {
    const s = new Stage();
    s.load(recorded());
    s.goLive();
    walk(s);
    expect(s.getSnapshot().gate?.seq).toBe(s.compiled.gates[0].seq);
  });
});
