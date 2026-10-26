// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { RESTRAINT, restraintNote, rhythm, rhythmLine } from "./pace";
import { directorTools } from "../tools/director";
import { DEFAULT_CONFIG, getModels, setScriptedResponses } from "../llm/llm";
import { Teacher } from "../agent/loop";
import type { Compiled, Op } from "./types";

/*
 * 第九件（Intelligent UI 的"忍住不加"）：两问之间没有一句旁白，带子知道，回执得说给导演听。
 *
 * 三层照旧分开钉：
 * - 形状：哪几种带子该说、哪几种不该说；`asked/lastAskAt/lastLineEnd` 与"整条带子扫一遍"逐刻对账。
 * - 价钱：这一问只读三个数，不扫卡表 / cue 表 / 拍表 —— 给那三张表套 Proxy 数读了几格。
 * - 护栏：那句话不进带子、不改回执前缀、不动判分；`pause_for` 不是题；第一问永远不算连问。
 *
 * 一句必须写在最前面的语义：`restraintNote` 问的是**这一刀落下之前**的带子（导演加卡的那一刻）。
 * 卡一落，`lastAskAt` 就是它自己，于是"上一问之后没有旁白"当然成立 —— 那不是这条规则在变，是它
 * 只回答一个问题："现在再开一张卡，是不是连着他考。"
 */

const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });
const quiz = (prompt = "哪个是合力？"): Op => ({ kind: "quiz", prompt, options: ["甲", "乙"], answer: 0 });
const probe = (): Op => ({ kind: "probe", prompt: "点一下合力", targets: ["a", "b"], answer: "a" });
const dial = (): Op => ({ kind: "dial", prompt: "估一下", min: 0, max: 10, value: 5, tol: 1 });
const type = (): Op => ({ kind: "type", prompt: "说说导数", accept: ["瞬时"] });
const dragOp = (): Op => ({ kind: "drag", prompt: "搬一下", prop: "a", value: { x: 0, y: 0 }, tol: 10 });
const silence = (duration = 1000): Op => ({ kind: "beat", duration });
const pause = (): Op => ({ kind: "pause-for", reason: "想一想" });

const tape = (...ops: Op[]): Stage => {
  const s = new Stage();
  s.append(ops, MAIN_TRACK);
  return s;
};

const teaching = () => ({ title: "t", concepts: [], learner: "", beatsDone: 0 });

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("忍住的形状：两问之间有没有一句旁白，带子说了算", () => {
  it("第一问永远不算连问：他还没被问过", () => {
    expect(restraintNote(tape().compiled)).toBeNull();
    expect(restraintNote(tape(line("先看这张图", 3000)).compiled)).toBeNull();
  });

  it("问完就再问：中间一句旁白也没有，回执点名", () => {
    expect(restraintNote(tape(quiz()).compiled)).toBe(RESTRAINT);
    // 两张卡落在同一刻（卡不占时钟），中间仍然没有一个字落在他耳朵里。
    expect(restraintNote(tape(quiz(), quiz()).compiled)).toBe(RESTRAINT);
  });

  it("问完先讲一句再问：不点名（那句话就是这两问之间的东西）", () => {
    expect(restraintNote(tape(quiz(), line("看着这两个箭头", 4000)).compiled)).toBeNull();
  });

  it("问完只留静默：静默不是讲课，点名", () => {
    expect(restraintNote(tape(quiz(), silence(3000)).compiled)).toBe(RESTRAINT);
    // 静默之后再讲一句：讲过了，就不是连问。
    expect(restraintNote(tape(quiz(), silence(), line("好", 1000)).compiled)).toBeNull();
  });

  it("`pause_for` 不是题：它不替他挡第二问，自己也不算问过", () => {
    // 问 → 他按了继续 → 立刻再问：仍然是连问。
    expect(restraintNote(tape(quiz(), pause()).compiled)).toBe(RESTRAINT);
    // 从没问过题，只有一次 pause：下一问是第一问，不算连问。
    expect(restraintNote(tape(line("看这里", 2000), pause()).compiled)).toBeNull();
  });

  it("读的是带子尽头：他倒回三分钟前，节奏不变", () => {
    const s = tape(line("开场", 1000), quiz(), line("讲一段", 5000));
    const before = rhythm(s.compiled);
    s.seek(0);
    expect(rhythm(s.compiled)).toEqual(before);
    expect(restraintNote(s.compiled)).toBeNull();
  });

  it("同一个数说两遍：已问几题、上一问之后讲了多久", () => {
    const s = tape(line("开场", 1000), quiz(), line("讲一段", 5000));
    expect(rhythm(s.compiled)).toEqual({ asked: 1, lastAskAt: 1000, sinceMs: 5000 });
    expect(rhythmLine(s.compiled)).toContain("已问 1 题");
    expect(rhythmLine(s.compiled)).toContain("5.0s");
    expect(rhythmLine(tape().compiled)).toContain("还没问过题");
    expect(rhythmLine(tape(quiz()).compiled)).toContain("再问就是连着他考");
  });
});

describe("忍住的价钱：三个数，不扫表", () => {
  /** 给一张表套一层 Proxy：按下标读一次算一格（仓库里数价钱的旧手艺）。 */
  const counted = <T,>(arr: T[]): { list: T[]; reads: () => number } => {
    let n = 0;
    const list = new Proxy(arr, {
      get(t, k, r) {
        if (typeof k === "string" && /^\d+$/.test(k)) n++;
        return Reflect.get(t, k, r);
      },
    });
    return { list, reads: () => n };
  };

  it("问一句不读卡表 / cue 表 / 拍表一格 —— 带子长四十倍也一样", () => {
    for (const n of [4, 160]) {
      const ops: Op[] = [];
      for (let i = 0; i < n; i++) ops.push(line(`第 ${i} 句`, 500), quiz());
      const c = tape(...ops).compiled;
      const gates = counted(c.gates);
      const cues = counted(c.cues);
      const beats = counted(c.beats);
      const watched = { ...c, gates: gates.list, cues: cues.list, beats: beats.list } as Compiled;
      expect(restraintNote(watched)).toBe(RESTRAINT);
      expect(gates.reads()).toBe(0);
      expect(cues.reads()).toBe(0);
      expect(beats.reads()).toBe(0);
    }
  });

  it("反向验：同一批带子上，'扫一遍'那种读法真的读得到东西", () => {
    // The probe has to prove it can see a sweep, otherwise the zero above means nothing.
    const c = tape(line("开场", 1000), quiz(), line("讲", 2000)).compiled;
    const gates = counted(c.gates);
    const cues = counted(c.cues);
    let lastAsk = -1;
    let asked = 0;
    for (const g of gates.list as Compiled["gates"]) {
      if (g.kind !== "pause-for") {
        lastAsk = g.t;
        asked++;
      }
    }
    let lastLine = 0;
    for (const cu of cues.list as Compiled["cues"]) if (cu.op.kind === "narrate" && cu.end > lastLine) lastLine = cu.end;
    expect(asked).toBe(1);
    expect(lastAsk).toBe(1000);
    expect(lastLine).toBe(3000);
    expect(gates.reads()).toBeGreaterThan(0);
    expect(cues.reads()).toBeGreaterThan(0);
  });

  it("对账：随机带子逐格追加，三个游标与'整条带子扫一遍'同解", () => {
    let seed = 20261026;
    const rnd = () => {
      seed = Math.imul(seed, 1103515245) + 12345;
      return (seed >>> 0) / 0x100000000;
    };
    const kinds: (() => Op)[] = [() => line(`句${Math.floor(rnd() * 9)}`, 400 + Math.floor(rnd() * 3000)), silence, quiz, probe, dial, type, dragOp, pause];
    for (let round = 0; round < 40; round++) {
      const s = new Stage();
      for (let i = 0; i < 24; i++) {
        s.append([kinds[Math.floor(rnd() * kinds.length)]()], MAIN_TRACK);
        const c = s.compiled;
        // Reference: walk the whole tape, no cursors.
        let asked = 0;
        let lastAsk = -1;
        for (const g of c.gates) {
          if (g.kind !== "pause-for") {
            asked++;
            lastAsk = g.t;
          }
        }
        let lastLine = 0;
        for (const cu of c.cues) if (cu.op.kind === "narrate" && cu.end > lastLine) lastLine = cu.end;
        expect({ asked: c.asked, lastAskAt: c.lastAskAt, lastLineEnd: c.lastLineEnd }).toEqual({
          asked,
          lastAskAt: lastAsk,
          lastLineEnd: lastLine,
        });
        // And the sentence itself agrees with the reference.
        const expected = asked === 0 || lastLine > lastAsk ? null : RESTRAINT;
        expect(restraintNote(c)).toBe(expected);
      }
    }
  });
});

describe("忍住的护栏：它是一句回执，不是一笔带子", () => {
  it("五张卡都带这句话；干净的一问一个字也不多", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["ask_learner", { prompt: "再问", options: ["甲", "乙"], answer: 0 }],
      ["point_at", { prompt: "再指", targets: ["a", "b"], answer: "a" }],
      ["tune", { prompt: "再估", min: 0, max: 10, value: 5 }],
      ["type", { prompt: "再说", accept: ["瞬时"] }],
      ["drag", { prompt: "再搬", prop: "a", value: { x: 0, y: 0 } }],
    ];
    for (const [verb, args] of cases) {
      // `point_at` / `drag` 要先有站着的道具（两张：一正一惑），否则出门就被前置条件拦下，回执里没有那张卡。
      const props: Op[] = [
        { kind: "build", id: "a", label: "a", box: { x: 0, y: 0, w: 100, h: 100 } },
        { kind: "build", id: "b", label: "b", box: { x: 200, y: 0, w: 100, h: 100 } },
      ];
      const chained = tape(...props, quiz());
      const r = directorTools(chained, teaching()).run(verb, args);
      expect(r.note).toBe(RESTRAINT);
      expect(r.ops.length).toBeGreaterThan(0);
      const clean = tape(...props, quiz(), line("先讲一段", 3000));
      expect(directorTools(clean, teaching()).run(verb, args).note).toBeUndefined();
    }
  });

  it("回执的前缀不变（主循环靠它认停表的卡），节奏只挂在后面", () => {
    const s = tape(quiz());
    const r = directorTools(s, teaching()).run("ask_learner", { prompt: "再问", options: ["甲", "乙"], answer: 0 });
    expect(r.result.startsWith("question queued")).toBe(true);
    expect(r.result).not.toContain("节奏");
    // 落带的是那一刀 op，一个字都没有多。
    s.append(r.ops, MAIN_TRACK);
    expect(JSON.stringify(s.log.tape)).not.toContain("节奏");
  });

  it("导演快照里同一句话在（还没落笔的那一问看得见）", () => {
    const s = tape(line("开场", 1000), quiz());
    const r = directorTools(s, teaching()).run("stage_state", {});
    expect(r.result).toContain("tape rhythm:");
    expect(r.result).toContain("上一问之后还没有一句旁白");
    const after = tape(line("开场", 1000), quiz(), line("讲一段", 2000));
    expect(directorTools(after, teaching()).run("stage_state", {}).result).toContain("讲了 2.0s 的旁白");
  });

  it("真的到了导演手里：第二张卡的回执带着它，第一张没有", async () => {
    getModels({ ...DEFAULT_CONFIG, scripted: true });
    const stage = new Stage();
    const teacher = new Teacher(stage, { ...DEFAULT_CONFIG, scripted: true }, {});
    setScriptedResponses([
      fauxAssistantMessage([fauxToolCall("ask_learner", { prompt: "先猜：哪个是合力？", options: ["甲", "乙"], answer: 0 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("ask_learner", { prompt: "再指：哪个是合力？", options: ["甲", "乙"], answer: 0 })], { stopReason: "toolUse" }),
      fauxAssistantMessage("（排练剧本到这里演完了。）", { stopReason: "stop" }),
    ]);
    const run = teacher.say("讲向量加法");
    const until = async (what: () => boolean, label: string) => {
      for (let i = 0; i < 400; i++) {
        if (what()) return;
        await new Promise((r) => setTimeout(r, 0));
      }
      throw new Error(`等不到：${label}`);
    };
    await until(() => stage.compiled.gates.length === 1, "第一张卡");
    stage.answerGate("甲", stage.compiled.gates[0].seq);
    await until(() => stage.compiled.gates.length === 2, "第二张卡");
    stage.answerGate("甲", stage.compiled.gates[1].seq);
    await run;
    const receipts = teacher.messages
      .filter((m) => m.role === "toolResult" && m.toolName === "ask_learner")
      .map((m) =>
        (Array.isArray(m.content) ? m.content : [])
          .filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && c.type === "text")
          .map((c) => c.text)
          .join("\n"),
      );
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).not.toContain("节奏：");
    expect(receipts[1]).toContain(RESTRAINT);
    // 这句话只活在回执里：带子上一个字也没有，判分、档案、卡片一个字没动。
    expect(JSON.stringify(stage.log.tape)).not.toContain("节奏");
  });
});
