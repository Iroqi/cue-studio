import { describe, expect, it } from "vitest";
import { compile } from "./compile";
import { MAIN_TRACK } from "./log";
import { TapeIndex } from "./frame";
import { Stage } from "./runtime";
import type { Compiled, Cue, Op, OpEntry } from "./types";

/*
 * 这一节管两件事，都是**数出来的**，不是"感觉快了"：
 *
 *  1. 一帧问带子的那几刀，答案是什么。动索引之前先把形状抄下来 —— 改完同一批断言必须原样绿，
 *     否则"快了"只是另一种坏掉。下面第三节再把索引和"整条带子扫一遍"逐刻对齐。
 *  2. 渲染一帧在 cue 表上路过多少格（第四节）。同一支探针对着修前修后各跑一遍（2 000 / 8 000 /
 *     32 000 / 128 000 条 cue 的表）：修前一帧按 12 000 / 48 000 / 192 000 / 768 000 格 —— 带子长
 *     16 倍，路过也长 16 倍；同一批规模的 seek 是 0.27 / 1.34 / 2.98 / 11.86ms，而一帧的预算是
 *     16.7ms。修完那一帧路过 0 格，11.86ms 降到 3.93ms。
 *
 * 证据用格子数不用毫秒：共享 CI 的噪声比省下来的那些毫秒大。
 */

const art = (id: string, at = 0): Op => ({ kind: "build", id, box: { x: at, y: 0, w: 200, h: 160 }, label: id, html: `<p>${id}</p>` });
const onBoard = (id: string, scene: string): Op => ({ kind: "build", id, scene, box: { x: 0, y: 0, w: 200, h: 160 }, label: id, html: `<p>${id}</p>` });
const line = (text: string, duration: number): Op => ({ kind: "narrate", text, duration });
const beat = (duration: number): Op => ({ kind: "beat", duration });
const shot = (mode: "pan" | "zoom" | "track" | "focus" | "fit", extra: Record<string, unknown>, duration: number): Op => ({
  kind: "camera",
  mode,
  duration,
  easing: "linear",
  ...extra,
} as Op);
const cut = (to: string, duration: number): Op => ({ kind: "transition", style: "dissolve", to, duration });
const mark = (target: string, duration: number): Op => ({ kind: "highlight", target, style: "pulse", duration });
const drift = (id: string, amp: number, duration: number): Op => ({
  kind: "motion",
  id,
  mode: "oscillate",
  axis: "x",
  amp,
  period: 1000,
  radius: 0,
  steps: 0,
  decay: 0,
  duration,
});
/** 一句念不完 1000ms 的话：用它撑开每一拍，叠层才不会互相盖住窗口。 */
const LONG = "一".repeat(52);

const tape = (...ops: Op[]): OpEntry[] => ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op }));

const frameOf = (s: Stage, t: number) => {
  s.seek(t);
  return s.getSnapshot();
};

describe("一帧问带子的那几刀：答案的形状", () => {
  it("镜头滑动的中间一刻：在 from 和 to 之间按 easing 插值", () => {
    const s = new Stage();
    s.load(tape(art("a"), line("说一句", 1000), shot("pan", { dir: "right", screens: 1 }, 800), line("再说一句", 1000)));
    const shotCue = s.compiled.cues.find((c) => c.op.kind === "camera")!;
    // 走了一半：画面正好在 from 和 to 的中点（linear）。
    const at = frameOf(s, shotCue.t + (shotCue.end - shotCue.t) / 2).rect;
    const want = (a: number, b: number) => (a + b) / 2;
    expect(at.x).toBeCloseTo(want(shotCue.from.x, shotCue.to.x), 6);
    expect(at.w).toBeCloseTo(want(shotCue.from.w, shotCue.to.w), 6);
  });

  it("已经站定的那一刀：画面落在它的 to 上，不再动", () => {
    const s = new Stage();
    s.load(tape(art("a"), line("说一句", 1000), shot("pan", { dir: "right", screens: 1 }, 800), line("再说一句", 1000)));
    const cam = s.compiled.cues.find((c) => c.op.kind === "camera")!;
    expect(frameOf(s, cam.end + 10).rect).toEqual(cam.to);
  });

  it("同一拍里两刀叠着来：先那一刀还在滑，后一刀就不算已经站定", () => {
    const s = new Stage();
    s.load(
      tape(
        art("a"),
        // 两句之间没有旁白推进时钟，所以两刀 camera 的 t 相同、end 不同 —— 叠在一起。
        shot("pan", { dir: "right", screens: 0.4 }, 4000),
        shot("pan", { dir: "down", screens: 0.4 }, 500),
        line("收这一拍", 1000),
      ),
    );
    const cams = s.compiled.cues.filter((c) => c.op.kind === "camera");
    expect(cams.length).toBe(2);
    expect(cams[0].t).toBe(cams[1].t);
    // t=1000：第一刀（end 4000+）仍在跑，所以画面是它的插值，不是第二刀的落点。
    const rect = frameOf(s, cams[0].t + 1000).rect;
    const p = 1000 / (cams[0].end - cams[0].t);
    expect(rect.x).toBeCloseTo(cams[0].from.x + (cams[0].to.x - cams[0].from.x) * p, 6);
  });

  it("track 那一刀站定之后仍然跟着走：道具被 motion 推走，画面跟着推", () => {
    const s = new Stage();
    s.load(tape(art("a"), line("说一句", 1000), shot("track", { follow: "a" }, 800), drift("a", 60, 4000), line("再说一句", 1000)));
    const cam = s.compiled.cues.find((c) => c.op.kind === "camera")!;
    const still = frameOf(s, cam.end - 1).rect;
    const glided = frameOf(s, cam.end + 200).rect;
    // 同一个站定落点，但运动把它整体推开了 —— 推的方向和 motion 的位移一致。
    expect(glided.w).toBeCloseTo(still.w, 6);
    expect(Math.abs(glided.x - still.x)).toBeGreaterThan(1);
  });

  it("幕布：换场的中点才扫板，前后各按 veil 的进度", () => {
    const s = new Stage();
    s.load(tape(onBoard("旧", "甲"), cut("乙", 1200), onBoard("新", "乙"), beat(400)));
    expect(frameOf(s, 599).props.map((p) => p.id)).toEqual(["旧"]);
    expect(frameOf(s, 599).veil).not.toBeNull();
    expect(frameOf(s, 601).props.map((p) => p.id)).toEqual([]);
    expect(frameOf(s, 1199).veil?.style).toBe("dissolve");
    expect(frameOf(s, 1250).veil).toBeNull();
  });

  it("旁白：窗口里才有字幕，落定那份比进度先走完", () => {
    const s = new Stage();
    s.load(tape(line("一二三", 10)));
    const cue = s.compiled.cues[0];
    // 窗口念不完也要留够落定的时间：`end - t` 里扣掉 SETTLE_MS，所以同一刻 reveal 走在 progress 前面。
    const at = frameOf(s, cue.t + 10).narration;
    expect(at?.text).toBe("一二三");
    expect(at!.reveal).toBeGreaterThan(at!.progress);
    // 到切走前 300ms，字已经说完（reveal 落定），进度还没到顶 —— 这两条是不同的曲线。
    const settle = frameOf(s, cue.end - 100).narration;
    expect(settle?.reveal).toBe(1);
    expect(settle!.progress).toBeLessThan(1);
    expect(frameOf(s, cue.end + 1).narration).toBeNull();
  });

  it("叠层：强调只在这条的窗口里生效，两条各管各的窗口", () => {
    const s = new Stage();
    // 长句子撑开每一拍，两条强调才落在互不相交的窗口里 —— 否则后一条会盖住前一条的尾巴。
    s.load(tape(art("a"), line(LONG, 1000), mark("a", 1200), line(LONG, 1000), mark("a", 900), line(LONG, 1000)));
    const marks = s.compiled.cues.filter((c) => c.op.kind === "highlight");
    expect(marks[1].t).toBeGreaterThan(marks[0].end);
    expect(frameOf(s, marks[0].t + 10).props[0].highlight).toBe("pulse");
    expect(frameOf(s, marks[0].end - 1).props[0].highlight).toBe("pulse");
    expect(frameOf(s, marks[0].end + 1).props[0].highlight).toBeUndefined();
    expect(frameOf(s, marks[1].t + 10).props[0].highlight).toBe("pulse");
    expect(frameOf(s, marks[1].end + 1).props[0].highlight).toBeUndefined();
  });

  it("叠层：同一格里两条强调指同一个道具，起先那条算", () => {
    const s = new Stage();
    s.load(
      tape(
        art("a"),
        { kind: "highlight", target: "a", style: "shake", duration: 3000 } as Op,
        { kind: "highlight", target: "a", style: "outline", duration: 500 } as Op,
        line("说一句", 1000),
      ),
    );
    const first = s.compiled.cues.find((c) => c.op.kind === "highlight")!;
    expect(frameOf(s, first.t + 10).props[0].highlight).toBe("shake");
  });

  it("一格里两段运动指同一道具，后落那条算", () => {
    const s = new Stage();
    s.load(tape(art("a"), drift("a", 30, 3000), drift("a", 90, 3000), line("说一句", 1000)));
    const heavy = frameOf(s, 0).props[0].box;
    s.load(tape(art("a"), drift("a", 90, 3000), drift("a", 30, 3000), line("说一句", 1000)));
    expect(frameOf(s, 0).props[0].box).toEqual(heavy);
  });

  it("卡片：没人答的那一张一直站到带子结束", () => {
    const s = new Stage();
    s.load(tape(line("先说一句", 1000), { kind: "quiz", prompt: "几？", options: ["甲", "乙"], answer: 0 } as Op, line("再说一句", 1000), line("后面还有", 4000)));
    const gate = s.compiled.gates[0];
    // load 是录像：live=false 时 currentGate() 不问，但快照里的位置仍然按带子算。
    expect(s.currentGate()).toBeNull();
    s.live = true;
    expect(frameOf(s, gate.t - 1).gate).toBeNull();
    expect(frameOf(s, gate.t).gate?.seq).toBe(gate.seq);
    // 窗口（问它的那一拍）走完也不收走：还欠他一个回答，这张卡就一直站在台上。
    expect(frameOf(s, gate.until + 1).gate?.seq).toBe(gate.seq);
    expect(frameOf(s, s.compiled.duration).gate?.seq).toBe(gate.seq);
  });

  it("答案落在卡上：那一拍里显示他答的，之后收走", () => {
    const s = new Stage();
    s.load(
      tape(
        { kind: "quiz", prompt: "几？", options: ["甲", "乙"], answer: 0 } as Op,
        line("等他说完", 1000),
        { kind: "answer", gate: 0, text: "甲" } as Op,
        line("接下去", 1000),
      ),
    );
    const gate = s.compiled.gates[0];
    expect(frameOf(s, gate.t + 1).said).toBe("甲");
    expect(frameOf(s, gate.until + 1).said).toBeNull();
  });
});

/*
 * 这一节数的是**渲染这一帧**在 cue 表上路过多少格：给那份 `Compiled.cues` 套一层 Proxy，数下标读取
 * 和数组方法调用。修前后各跑一遍同一支探针（同一刻、同一卷带子）：
 *
 *   500 / 2000 / 8000 / 32000 格课 →  cue 表 2000 / 8000 / 32000 / 128000 条
 *   修前：一帧路过 12 000 / 48 000 / 192 000 / 768 000 格（带子长 16 倍，路过也长 16 倍）
 *   修后：一帧路过 0 格 —— 渲染不再按下标读整张 cue 表，问的全是索引的窄表。
 *
 * 断的是格子数，不是毫秒：共享 CI 的噪声比省下来的那些毫秒大。
 */
describe("渲染一帧在 cue 表上路过多少格", () => {
  /** 一"格"课：一句旁白 + 一刀运镜 + 一格道具 + 一个强调 + 一段运动。 */
  const turnOf = (i: number): Op[] => [
    line(`第 ${i} 句台词，够看出时钟有没有在走`, 3000),
    shot("pan", { dir: "right", screens: 0.3 }, 800),
    { kind: "build", id: `p${i}`, box: { x: (i % 12) * 120, y: 0, w: 200, h: 160 }, label: `p${i}`, html: `<p>${i}</p>` },
    mark(`p${i}`, 1200),
    drift(`p${i}`, 40, 2000),
  ];
  const long = (turns: number): OpEntry[] => {
    const out: OpEntry[] = [];
    for (let i = 0; i < turns; i++) for (const op of turnOf(i)) out.push({ seq: out.length, track: MAIN_TRACK, turn: i, op });
    return out;
  };

  /** 让渲染读一份被数着的 cue 表：按格读、`filter`、`find`、`map` 全在指纹里。 */
  function renderOneFrame(turns: number): { cells: number; sweeps: number; cues: number } {
    const s = new Stage();
    s.load(long(turns));
    const c = s.compiled;
    let cells = 0;
    let sweeps = 0;
    const counted: Cue[] = new Proxy(c.cues, {
      get(t, k) {
        if (typeof k === "string") {
          if (/^\d+$/.test(k)) cells++;
          if (k === "filter" || k === "find" || k === "findIndex" || k === "some" || k === "map") sweeps++;
        }
        return (t as never)[k as never];
      },
    });
    (s as unknown as { compiledMain: Compiled }).compiledMain = { ...c, cues: counted };
    s.seek(Math.round(c.duration / 2));
    return { cells, sweeps, cues: c.cues.length };
  }

  it("带子长 16 倍，一帧在 cue 表上多走的路一格都不许多", () => {
    const small = renderOneFrame(500);
    const big = renderOneFrame(8000);
    expect(big.cues).toBe(small.cues * 16);
    // 旧写法：`cameraAt` 把整张表 filter 一遍再顺序扫，`cutAt` / `visibleProps` 各再扫几遍。
    expect(small.cells).toBe(0);
    expect(big.cells).toBe(small.cells);
    expect(big.sweeps).toBe(small.sweeps);
  });

  it("渲染这一帧不再对整张 cue 表用任何数组方法", () => {
    // 修前这里是 5 次：`render` 筛旁白和幕布各一遍、`visibleProps` 筛强调和运动各一遍、
    // `cameraAt` 挑镜头轨一遍。`cutAt` 那一遍走的是 `for..of`，所以它只进上面的格子数。
    expect(renderOneFrame(2000).sweeps).toBe(0);
  });
});

/*
 * 索引不许改答案。这里把它和**旧写法**（整条带子扫一遍）在同一个 t 上比一遍 ——
 * 上面那些形状钉的是几个代表性的瞬间，这一条钉的是"随便挑一刻，两边的答案一模一样"。
 */
describe("索引与整条带子的扫描同解", () => {
  const entries = (n: number): OpEntry[] => {
    const out: OpEntry[] = [];
    const push = (op: Op) => out.push({ seq: out.length, track: MAIN_TRACK, turn: 0, op });
    push(art("a"));
    push(art("b", 400));
    for (let i = 0; i < n; i++) {
      push(line(`第 ${i} 句`, 700));
      push(shot("pan", { dir: i % 2 ? "down" : "right", screens: 0.3 }, 900));
      push(mark(i % 2 ? "a" : "b", 1500));
      push(drift(i % 3 ? "a" : "b", 30, 1200));
      push(cut(`板${i % 3}`, 800));
      if (i % 5 === 0) push({ kind: "quiz", prompt: `第 ${i} 问`, options: ["甲", "乙"], answer: 0 } as Op);
      if (i % 7 === 0) push(beat(300));
    }
    return out;
  };

  /** 旧写法：一帧把整条 cue 表扫四遍。它就是定义，拿来对照，不是拿来跑的。 */
  const naive = {
    running(cues: Cue[], t: number) {
      return cues.filter((c) => c.t <= t && c.end > t);
    },
    camera(cues: Cue[], t: number) {
      const cam = cues.filter((c) => c.op.kind === "camera" || c.op.kind === "transition");
      let settled: Cue | null = null;
      let moving: Cue | null = null;
      for (const c of cam) {
        if (c.end <= t) settled = c;
        else {
          if (c.t <= t) moving = c;
          break;
        }
      }
      return { settled, moving };
    },
    veil(cues: Cue[], t: number) {
      return cues.find((c) => c.op.kind === "transition" && c.t <= t && c.end > t) ?? null;
    },
    cut(cues: Cue[], t: number) {
      let out: { flip: number; board: string } | null = null;
      for (const c of cues) {
        if (c.op.kind !== "transition") continue;
        const flip = c.t + (c.end - c.t) / 2;
        if (flip > t) break;
        out = { flip, board: c.op.to };
      }
      return out;
    },
  };

  it("每一刻：还在跑的格子、画框那两刀、幕布、走过的换场，答案全等", () => {
    const c = compile(entries(240));
    const ix = new TapeIndex(c);
    const step = Math.max(1, Math.floor(c.duration / 400));
    let checks = 0;
    for (let t = 0; t <= c.duration; t += step) {
      const mine = ix.cameraFrame(t);
      const theirs = naive.camera(c.cues, t);
      expect(mine.settled).toBe(theirs.settled);
      expect(mine.moving).toBe(theirs.moving);
      expect(ix.veilAt(t)).toBe(naive.veil(c.cues, t));
      expect(ix.cutAt(t)).toEqual(naive.cut(c.cues, t));
      // 强调：窗口里、指同一个道具的取最早那条。
      const running = naive.running(c.cues, t).filter((x) => x.op.kind === "highlight");
      const want = new Map<string, string>();
      for (const h of running) if (!want.has((h.op as { target: string }).target)) want.set((h.op as { target: string }).target, (h.op as { style: string }).style);
      expect(ix.highlightsAt(t)).toEqual(want);
      // 幕布盖住整块板的那一刻之前，旧板不算被扫走。
      checks++;
    }
    expect(checks).toBeGreaterThan(100);
  });

  it("卡片：开着的先站出来，全答过了才问窗口", () => {
    const c = compile(entries(120));
    const ix = new TapeIndex(c);
    const step = Math.max(1, Math.floor(c.duration / 300));
    for (let t = 0; t <= c.duration; t += step) {
      const reached = c.gates.filter((g) => g.t <= t);
      const want = reached.find((g) => g.said === null) ?? [...reached].reverse().find((g) => g.said !== null && t < g.until) ?? null;
      expect(ix.cardAt(t)).toBe(want);
    }
  });
});
