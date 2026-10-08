import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import type { Box, Op } from "./types";

const at = (x: number, y: number): Box => ({ x, y, w: 200, h: 160 });
/** A frame the skeleton laid but nobody has drawn into yet. */
const blank = (id: string): Op => ({ kind: "build", id, box: at(0, 0), label: id });
const art = (id: string): Op => ({ kind: "build", id, box: at(0, 0), label: id, html: `<p>${id}</p>` });
const fill = (id: string): Op => ({ kind: "patch", id, svg: "<svg></svg>" });
const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });

/** The rAF re-arm is not under test; the clock step is driven by hand. */
let raf = 0;
const step = (s: Stage, dt: number) => {
  clockNow += dt;
  (s as unknown as { last: number }).last = clockNow - dt;
  (s as unknown as { tick: (now: number) => void }).tick(clockNow);
};

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => ++raf);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.spyOn(performance, "now").mockImplementation(() => clockNow);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The wall clock the stage reads its last frame from; `step` advances it by exactly dt. */
let clockNow = 1000;

const LONG = "一".repeat(52);

describe("后台美工欠的每一格：拍边短停，画到时钟自己走", () => {
  it("轮已收、画在途：那一拍的旁白一个字都不许开念", () => {
    const s = new Stage();
    s.goLive();
    s.append([blank("a"), line(LONG, 2000)], MAIN_TRACK);
    s.setTurnOpen(true);
    s.beginPaint("a");
    s.setTurnOpen(false); // 导演这一轮已经收口，画还在后台跑
    s.play();
    step(s, 400);
    expect(s.t).toBe(0);
    expect(s.getSnapshot().artOwed).toBeGreaterThan(0);
  });

  it("画一落地，时钟下一帧自己续走 —— 不用任何人再碰开关", () => {
    const s = new Stage();
    s.goLive();
    s.append([blank("a"), line(LONG, 2000)], MAIN_TRACK);
    s.setTurnOpen(true);
    s.beginPaint("a");
    s.setTurnOpen(false);
    s.play();
    step(s, 400);
    expect(s.t).toBe(0);
    s.append([fill("a")], MAIN_TRACK);
    s.endPaint("a");
    step(s, 400);
    expect(s.t).toBeGreaterThan(0);
    expect(s.getSnapshot().artOwed).toBe(0);
  });

  it("在途的画只欠自己那一拍：第一拍说它的，时钟不停", () => {
    const s = new Stage();
    s.goLive();
    // 第一拍的框自带画面；第二拍 10300 起的空框由后台绘制。
    s.append([art("a"), line(LONG, 2000), blank("b"), line("第二句也在同一拍说完", 2000)], MAIN_TRACK);
    s.beginPaint("b");
    s.play();
    step(s, 500);
    expect(s.t).toBe(500);
    step(s, 10000 - s.t);
    expect(s.t).toBe(10000); // 正好停在欠画那一拍的边上
    step(s, 500);
    expect(s.t).toBe(10000);
  });

  it("没人派过画的空框是弃画：时钟从它上面走过去，不永远站着", () => {
    const s = new Stage();
    s.goLive();
    s.append([blank("a"), line(LONG, 2000)], MAIN_TRACK);
    s.play();
    step(s, 400);
    expect(s.t).toBe(400);
  });

  it("导演停在考题上的那一刻：后台欠的画也不许挡住题卡", () => {
    const s = new Stage();
    s.goLive();
    s.append([blank("a"), line(LONG, 2000), { kind: "quiz", prompt: "先验", options: ["甲", "乙"], answer: 0 }], MAIN_TRACK);
    s.beginPaint("a");
    s.setDebtSuspended(true); // 等回答的正是派了这一笔的那个轮
    s.play();
    step(s, 20000);
    expect(s.getSnapshot().gate?.kind).toBe("quiz");
  });
});

describe("换场扫走的那一格不欠时钟任何东西", () => {
  /**
   * `owedAt` 里那句 `swept` 是索引最容易漏的一半：那一格不在观众名单上（幕布已经盖过去了），改前却是
   * 顺带对的 —— 那一遍走整张道具表，逐格问的是同一条规则。换成二分之后它成了一句独立的话，所以它可以
   * 整句删掉而全套仍然绿：实测删掉那句 `continue`，改前那 182 条一条都不红。
   *
   * 补的两条钉在**时钟**上而不是名单上，因为这半条错法只有时钟表演得出来：观众已经不在那块板上了，
   * 时钟却为一块他们再也看不见的空框把车停死在这一拍里，字幕栏上写"时钟等美工"，等的是永远不会看到的画。
   */
  const draft = (id: string, scene: string): Op => ({ kind: "build", id, scene, box: at(0, 0), label: id });
  const cut = (to: string): Op => ({ kind: "transition", style: "dissolve", to, duration: 1200 });
  // 草稿落在 0，紧接一刀切去乙：幕布 0..1200，`flip` 在 600，那一格欠的是换场这一拍的画。
  function show(s: Stage) {
    s.goLive();
    s.append([draft("草稿", "甲"), cut("乙"), line("第二句在新板上说", 4000)], MAIN_TRACK);
    s.setTurnOpen(true); // 轮还开着：没图的框就是一幅欠着的画
  }

  it("幕布还没盖过去：那块空框确实欠一幅画，时钟停在它前面", () => {
    const s = new Stage();
    show(s);
    s.seek(300);
    expect(s.getSnapshot().artOwed).toBeGreaterThan(0);
    s.play();
    step(s, 200);
    // 这一条是下面那条的门：同一格、同一拍，只因为没到 `flip` 就该停车。
    expect(s.t).toBe(300);
  });

  it("幕布盖过去之后：被这一刀扫走的那一格不再欠时钟", () => {
    const s = new Stage();
    show(s);
    s.seek(700); // 已走过 `flip`：观众在乙板上，甲板上那块空框再也见不着了
    expect(s.getSnapshot().artOwed).toBe(0);
    s.play();
    step(s, 200);
    expect(s.t).toBe(900);
  });
});
