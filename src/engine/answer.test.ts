import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import type { Box, Op } from "./types";

const at = (x: number, y: number): Box => ({ x, y, w: 200, h: 160 });
const art = (id: string): Op => ({ kind: "build", id, box: at(0, 0), label: id, html: `<p>${id}</p>` });
const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });
const ask = (prompt: string, options: string[] = ["甲", "乙"]): Op => ({ kind: "quiz", prompt, options, answer: 0 });

/** The rAF re-arm is not under test; the clock step is driven by hand, as in the paint-debt suite. */
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

/** A live show, with the clock already walking: this is a rehearsal, not a loaded recording. */
const performing = (...ops: Op[]): Stage => {
  const s = new Stage();
  s.goLive();
  s.append(ops, MAIN_TRACK);
  return s;
};

/** Walk the clock the way the rAF does, until it stops by itself — on a card, or at the end of the tape. */
const walkUntilStopped = (s: Stage): Stage => {
  s.play();
  for (let i = 0; i < 4000 && s.playing; i++) step(s, 50);
  return s;
};

describe("他的回答是磁带上的一个 op", () => {
  it("时钟自己停在题上 —— 然后他答的那句话落在带上", () => {
    const s = performing(art("a"), ask("合力是多少？"), line("答对了，接着往下走", 1000));
    walkUntilStopped(s);
    expect(s.getSnapshot().gate?.seq).toBe(s.compiled.gates[0].seq);
    s.answerGate("5N");
    const onTape = s.log.all().filter((e) => e.op.kind === "answer");
    expect(onTape).toHaveLength(1);
    expect(onTape[0].op).toMatchObject({ gate: s.compiled.gates[0].seq, text: "5N" });
  });

  it("他的长短不动时钟：回答不给这一拍加一秒", () => {
    const before = performing(art("a"), ask("甲？"), line("乙", 1000)).compiled.duration;
    const s = performing(art("a"), ask("甲？"), line("乙", 1000));
    walkUntilStopped(s);
    s.answerGate("答了很久的一段话，这段话再长也不该把这一拍拖长");
    expect(s.compiled.duration).toBe(before);
  });

  it("剪断到那一拍之后，他的回答跟着回去，题重新是题", () => {
    const s = performing(art("a"), ask("甲？"), line("乙", 1000));
    walkUntilStopped(s);
    const card = s.compiled.gates[0];
    s.answerGate("甲");
    expect(s.log.all().some((e) => e.op.kind === "answer")).toBe(true);
    // 从题卡后面那一拍剪断：题留在带上，他答的那句话跟着被剪走。
    const afterCard = s.log.all().find((e) => e.op.kind === "narrate")!.seq;
    s.rerollFrom(afterCard);
    expect(s.log.all().some((e) => e.op.kind === "answer")).toBe(false);
    expect(s.compiled.gates[0].seq).toBe(card.seq);
    // 排练回到那一拍，要重新问他一次 —— 那是这一拍唯一还没定的东西。
    expect(s.getSnapshot().gate?.seq).toBe(card.seq);
  });
});

describe("录像不再向看的人重新提问", () => {
  const recorded = () => {
    const live = performing(art("a"), ask("合力是多少？"), line("回到斜边上", 1000));
    walkUntilStopped(live);
    live.answerGate("5N，两条直角边合成斜边");
    return live.log.export();
  };

  it("答过的卡在他那一拍的窗口里显一次，之后就退场", () => {
    const s = new Stage();
    s.load(recorded());
    const card = s.compiled.gates[0];
    s.seek(card.t + 1);
    expect(s.getSnapshot().said).toBe("5N，两条直角边合成斜边");
    s.seek(card.until + 1);
    expect(s.getSnapshot().said).toBeNull();
  });

  it("重放一路走到底，一次都不停在题上", () => {
    const s = new Stage();
    s.load(recorded());
    s.play();
    for (let i = 0; i < 4000 && s.playing; i++) step(s, 50);
    expect(s.t).toBe(s.compiled.duration);
    expect(s.getSnapshot().gate).toBeNull();
  });

  it("没答过的卡也不拦重放：点开链接的人是来看的", () => {
    const s = new Stage();
    s.load(performing(art("a"), ask("没人答过这一题"), line("继续", 1000)).log.export());
    s.play();
    for (let i = 0; i < 4000 && s.playing; i++) step(s, 50);
    expect(s.t).toBe(s.compiled.duration);
  });

  it("他真想上这门课时，板子从这一刻起接住他", () => {
    const s = new Stage();
    s.load(performing(art("a"), ask("没人答过这一题"), line("继续", 1000)).log.export());
    s.goLive();
    walkUntilStopped(s);
    expect(s.getSnapshot().gate?.seq).toBe(s.compiled.gates[0].seq);
  });
});

describe("一轮问两题：回答记在哪张卡上", () => {
  const two = () => performing(art("a"), ask("第一题"), line("过渡", 1000), ask("第二题"), line("收尾", 1000));

  it("时钟停在它先撞见的那一张", () => {
    const s = two();
    walkUntilStopped(s);
    expect(s.getSnapshot().gate?.seq).toBe(s.compiled.gates[0].seq);
  });

  it("导演 park 在哪张卡，就把话记在哪张卡上", () => {
    const s = two();
    walkUntilStopped(s);
    const [first, second] = s.compiled.gates;
    s.answerGate("给第二题的话", second.seq);
    expect(s.compiled.gates.find((g) => g.seq === second.seq)?.said).toBe("给第二题的话");
    expect(s.compiled.gates.find((g) => g.seq === first.seq)?.said).toBeNull();
  });

  it("两张卡各归各的答：答完第一题，题卡才轮到第二张", () => {
    const s = two();
    walkUntilStopped(s);
    const second = s.compiled.gates[1];
    s.answerGate("第一题的话");
    s.play();
    for (let i = 0; i < 4000 && s.playing; i++) step(s, 50);
    expect(s.getSnapshot().gate?.seq).toBe(second.seq);
    s.answerGate("第二题的话");
    expect(s.getSnapshot().gate).toBeNull();
  });
});
