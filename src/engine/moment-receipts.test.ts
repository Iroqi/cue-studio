import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { directorTools, type TeachingState } from "../tools/director";
import type { Box, Compiled, Op, OpEntry } from "./types";

/*
 * 这一节钉的还是那同一句话：**读那一刻，不许读带子尽头**。上一件把它还给了镜头，这一件量出来还剩
 * 四处没接上，而且四处都不是"难看一点"，是同一卷带子上的两种说法：
 *
 *  1. `patch`（`draw` 和 `move` 走的就是它）指一个带上根本没有的名字，解释器**凭空造出一格外观**：
 *     `ensureProp` 先建条目，然后 `box = op.box ?? prev?.box ?? VIEWPORT`。实测拼错一个名字，那一格
 *     拿到 `{x:0,y:0,w:1600,h:900}` 满幅、`partial:false` —— 那不是空框，是一幅"已经画好的画"，所以
 *     时钟**不等它**（`owedAt` 只数空白框欠的画），观众看得见一整块盖住板的东西，而带子上没有任何
 *     一刀说要它。`link` 只念到名字那一头仓库早就防住了（`fetch_prop` 会说"只被念到名字"），`patch`
 *     这一头没有防。
 *  2. 六个动词的回执替带子说话：`move`/`draw`/`discard`/`recall`/`highlight`/`motion` 指一个不存在、
 *     或此刻不在台上的名字，全部回"成功"（实测 `moved vec-q to (900,400)`、`reused vec-o in 甲`，
 *     而 `props on file` 只有 `vec-r`）。只有 `camera` 有 `blindCamera` 那句对账。后果正是它当初说
 *     的那一句：模型把这份静默读成"动过了"。
 *  3. `link` 是这张表上唯一**没有时刻**的一格（只有 `to`/`relation`），所以倒带回到那一刀之前，导演的
 *     `<stage>` 照样报 `links:resultant-of->b` —— 而 `b` 此刻还没上台。一次外观是一段窗口，一条 cue
 *     是一段窗口，一条关系也该是一个时刻。
 *  4. 时钟那一半：`owedAt` 里"这一拍落的笔"问过 `swept`（上一件钉的「换场扫走的那一格不欠时钟任何东西」），
 *     可**在飞的那两遍**没问 —— 它们只比 `rev.t` 落在不在这一拍的窗口里。于是一块被幕布压住的板上的
 *     空框仍然能让时钟停死，而观众已经不在那块板上。
 *
 * 顺带一处价钱：`audienceHas` 拿 `compiled.cues.find(c => c.op === askedBy)` 找"这一刀落在哪一刻"，
 * 而镜头点名的东西观众看不见时它要**找不到**才说话 —— 找不到就是走完整个 cue 表，每一刀付一次。
 * 实测 128 001 条 cue 的带子，点一次空名字 1.17ms，命中同一个数 —— 那笔钱在 `find` 上，而导演一轮点几十次名。
 * `⟲ 一拍` 那一头同一句话：`rewindToBeatStart` 每帧之外每次按下都把整张 cue 表 `filter` 一遍再
 * `reverse` 再 `find`。带子只增不改，这两问在排好的那一刻就该有答案。
 */

const at = (x: number, y = 0): Box => ({ x, y, w: 200, h: 160 });
const art = (id: string, scene?: string): Op =>
  ({ kind: "build", id, scene, box: at(0), label: id, html: `<p>${id}</p>` }) as Op;
/** 骨架落下、美工还没交的那一格。 */
const blank = (id: string, scene?: string): Op => ({ kind: "build", id, scene, box: at(0), label: id }) as Op;
const line = (text: string, duration = 1000): Op => ({ kind: "narrate", text, duration });
const drop = (id: string): Op => ({ kind: "discard", id });
const inked = (id: string): Op => ({ kind: "patch", id, svg: `<svg viewBox="0 0 200 160"><text>${id}</text></svg>` }) as Op;
const shift = (id: string, x: number): Op => ({ kind: "patch", id, box: at(x) }) as Op;
const back = (id: string, scene?: string): Op => ({ kind: "recall", id, scene, box: at(600) }) as Op;
const cut = (to: string, duration = 1200): Op => ({ kind: "transition", style: "dissolve", to, duration });
const tie = (from: string, to: string, relation = "resultant-of"): Op => ({ kind: "link", from, to, relation }) as Op;

const tape = (...ops: Op[]): OpEntry[] => ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op }));

const tools = (s: Stage) => {
  const teaching: TeachingState = { title: "", concepts: [], learner: "", beatsDone: 0 };
  return directorTools(s, teaching);
};

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

/** 给 cue 表套一层数着的壳：按表走一遍记一次 `sweep`，按下标读记一格 `cell`。 */
function watchCues(c: Compiled) {
  let sweeps = 0;
  let cells = 0;
  const scans = new Set(["find", "filter", "some", "map", "forEach", "reverse", "findIndex", "reduce"]);
  const cues = new Proxy(c.cues, {
    get(t, k) {
      if (typeof k === "string" && scans.has(k)) sweeps++;
      if (typeof k === "string" && /^\d+$/.test(k)) cells++;
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const watched = { ...c, cues } as Compiled;
  return {
    install: () => {
      (s_current as unknown as { compiledMain: Compiled }).compiledMain = watched;
    },
    take: () => {
      const out = { sweeps, cells };
      sweeps = 0;
      cells = 0;
      return out;
    },
  };
}
/** `watchCues` 装的表属于哪一个 stage：一文件一处，装的时候写进去。 */
let s_current: Stage;

describe("一个带上没有的名字，不该凭空站到台上", () => {
  it("draw 到拼错的名字：不带出一格满幅外观，也不报成功", () => {
    const s = new Stage();
    s.append([art("vec-r"), line("说一句", 1000)], MAIN_TRACK);
    const out = tools(s).run("draw", { id: "vec-q", svg: '<svg viewBox="0 0 1600 900"><text x="10" y="10">手滑</text></svg>' });
    expect(out.isError).toBe(true);
    expect(out.ops).toHaveLength(0);
    expect(out.result).toContain("vec-q");
    s.append(out.ops, MAIN_TRACK);
    // 改前：道具表里多出一格 `{x:0,y:0,w:1600,h:900}`、`partial:false` 的"成品"。
    expect(s.compiled.props.get("vec-q")?.revisions ?? []).toHaveLength(0);
    s.seek(s.compiled.duration);
    expect(s.getSnapshot().props.map((p) => p.id)).toEqual(["vec-r"]);
  });

  it("一条 patch 直接进带子（别人的录像）也不许多出一格", () => {
    const s = new Stage();
    s.load(tape(art("a"), line("说一句", 1000), inked("typo")));
    expect(s.compiled.props.has("typo")).toBe(false);
    s.seek(s.compiled.duration);
    expect(s.getSnapshot().props.map((p) => p.id)).toEqual(["a"]);
  });

  it("move 到一个没落过的名字：那一格不存在，地皮也不该被造出来", () => {
    const s = new Stage();
    s.append([art("a"), line("说一句", 1000)], MAIN_TRACK);
    const out = tools(s).run("move", { id: "ghost", x: 900, y: 400, w: 200, h: 160 });
    expect(out.isError).toBe(true);
    s.append(out.ops, MAIN_TRACK);
    // 改前这里造出一格 `partial:true` 的空框，还占一块地皮（`scenes` 被撑到 x=900+200）。
    expect(s.compiled.props.has("ghost")).toBe(false);
    const ground = s.compiled.scenes.get("default")!;
    expect(ground.x + ground.w).toBeLessThanOrEqual(201);
  });

  it("只被 link 念到过名字，draw 仍然落不下去（那是身份，不是画框）", () => {
    const s = new Stage();
    s.append([art("vec-r"), tie("vec-q", "vec-r"), line("说一句", 1000)], MAIN_TRACK);
    const out = tools(s).run("draw", { id: "vec-q", svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' });
    expect(out.isError).toBe(true);
    expect(out.result).toMatch(/link|念到|没上过台/);
    expect(s.compiled.props.get("vec-q")?.revisions ?? []).toHaveLength(0);
  });

  it("迟到的补画落在撤下之后，照旧落进那段收掉的窗口（这一件不许修过头）", () => {
    const s = new Stage();
    s.append([blank("a"), line("一", 1000), drop("a"), line("二", 1000), inked("a")], MAIN_TRACK);
    const rev = s.compiled.props.get("a")!.revisions;
    expect(rev).toHaveLength(1);
    expect(rev[0].svg).toContain("text");
    expect(rev[0].off).toBe(1000);
  });

  it("画错了重画照旧落新格，位置由上一格接过来（同一件的另一半护栏）", () => {
    const s = new Stage();
    s.append([art("a"), line("一", 1000), shift("a", 300), line("二", 1000)], MAIN_TRACK);
    const rev = s.compiled.props.get("a")!.revisions;
    expect(rev).toHaveLength(2);
    expect(rev[1].box.x).toBe(300);
  });

  it("填占位符那一笔照旧原地换掉那一格（护栏：别把骨架读成没落过）", () => {
    const s = new Stage();
    s.append([blank("a"), line("一", 1000), inked("a"), line("二", 1000)], MAIN_TRACK);
    expect(s.compiled.props.get("a")!.revisions).toHaveLength(1);
    expect(s.compiled.props.get("a")!.revisions[0].svg).toContain("text");
  });
});

describe("回执不许替带子说话", () => {
  it("discard 一个此刻不在台上的名字：这一刀不落，回执说清楚", () => {
    const s = new Stage();
    s.append([art("a"), line("一", 1000), drop("a"), line("二", 1000)], MAIN_TRACK);
    const d = tools(s);
    for (const id of ["never", "a"]) {
      const out = d.run("discard", { id });
      expect(out.isError, id).toBe(true);
      expect(out.ops).toHaveLength(0);
      expect(out.result).toContain(id);
    }
    // 护栏：站着的那个名字，`discard` 照样一刀就撤。
    const s2 = new Stage();
    s2.append([art("b"), line("一", 1000)], MAIN_TRACK);
    const ok = tools(s2).run("discard", { id: "b" });
    expect(ok.isError).toBeFalsy();
    expect(ok.ops).toHaveLength(1);
  });

  it("recall 一个带上从没落过的名字，不许报'已经复用'", () => {
    const s = new Stage();
    s.append([art("a"), line("一", 1000)], MAIN_TRACK);
    const out = tools(s).run("recall", { id: "vec-o", scene: "甲", x: 0, y: 0, w: 100, h: 100 });
    expect(out.isError).toBe(true);
    expect(out.ops).toHaveLength(0);
    // 护栏：撤下的东西仍然带得回来（那是 `recall` 存在的全部理由）。
    const s2 = new Stage();
    s2.append([art("a"), line("一", 1000), drop("a"), line("二", 1000)], MAIN_TRACK);
    const ok = tools(s2).run("recall", { id: "a", scene: "甲", x: 0, y: 0, w: 100, h: 100 });
    expect(ok.isError).toBeFalsy();
    expect(ok.ops).toHaveLength(1);
  });

  it("highlight / motion 点了个此刻不在台上的名字，回执说'画面不会有变化'", () => {
    const s = new Stage();
    s.append([art("a"), line("一", 1000), drop("a"), line("二", 1000)], MAIN_TRACK);
    const d = tools(s);
    const out = d.run("highlight", { target: "a", style: "outline", seconds: 1 });
    expect(out.isError).toBe(true);
    expect(out.result).toMatch(/看不见|不在台上|没有变化/);
    const mo = d.run("motion", { id: "a", mode: "orbit", seconds: 2 });
    expect(mo.isError).toBe(true);
    // 护栏：站着的东西照旧点得动。
    const s2 = new Stage();
    s2.append([art("b"), line("一", 1000)], MAIN_TRACK);
    expect(tools(s2).run("highlight", { target: "b", style: "outline", seconds: 1 }).isError).toBeFalsy();
    expect(tools(s2).run("motion", { id: "b", mode: "orbit", seconds: 2 }).isError).toBeFalsy();
  });

  it("镜头点名的对账：不许把整张 cue 表走完（价钱）", () => {
    const s = new Stage();
    const entries: OpEntry[] = [];
    for (let i = 0; i < 6000; i++) {
      entries.push({ seq: entries.length, track: MAIN_TRACK, turn: i, op: line(`第 ${i} 句台词，够看出这一帧在不在读带子`, 3000) });
      entries.push({ seq: entries.length, track: MAIN_TRACK, turn: i, op: art(`p${i}`, `板${i % 4}`) });
    }
    // 这一刀点在带子末尾，点的是个观众看不见的名字 —— 改前正是这一句把整张 cue 表读完（找不到才说话）。
    const shot: Op = { kind: "camera", mode: "fit", target: ["根本不存在的名字"], duration: 900, easing: "ease" } as Op;
    entries.push({ seq: entries.length, track: MAIN_TRACK, turn: 6000, op: shot });
    s.load(entries);
    s_current = s;
    const watched = watchCues(s.compiled);
    watched.install();
    watched.take(); // 装表时建的那几刀不算在这一帧头上
    // 反向验：改前那份读法（按引用找这一刀落在哪一刻）问一次就要走完这张表 —— 上面那个零数的才是真东西。
    s.compiled.cues.find((q) => q.op === shot);
    expect(watched.take().sweeps).toBe(1);
    const blind = s.blindNames([shot]);
    const spent = watched.take();
    expect(blind).toEqual(["根本不存在的名字"]);
    expect(spent.sweeps).toBe(0);
    expect(spent.cells).toBe(0);
  });

  it("⟲ 一拍：倒回上一拍边界不许把整张 cue 表筛一遍（价钱）", () => {
    const s = new Stage();
    const entries: OpEntry[] = [];
    for (let i = 0; i < 6000; i++) {
      entries.push({ seq: entries.length, track: MAIN_TRACK, turn: i, op: line(`第 ${i} 句台词`, 3000) });
      entries.push({ seq: entries.length, track: MAIN_TRACK, turn: i, op: art(`p${i}`, `板${i % 4}`) });
    }
    s.load(entries);
    s_current = s;
    const c = s.compiled;
    const watched = watchCues(c);
    watched.install();
    const target = Math.round(c.duration * 0.7);
    s.seek(target);
    expect(watched.take().sweeps).toBe(0);
    s.rewindToBeatStart();
    expect(watched.take().sweeps).toBe(0);
    // 护栏：倒带仍然落在一句旁白的开头，而不是随便什么时刻。
    expect(s.t).toBeLessThan(target);
    expect(c.cues.some((q) => q.t === s.t && (q.op.kind === "narrate" || q.op.kind === "beat"))).toBe(true);
  });
});

describe("一条关系也是一个时刻", () => {
  it("倒带回到声明之前，快照不许把那条 link 报给导演", () => {
    const s = new Stage();
    // a@0 → 一句(0..1000) → b@1000 → link@1000 → 一句(1000..2000)
    s.load(tape(art("a"), line("第一幕", 1000), art("b"), tie("a", "b"), line("第三幕才声明的关系", 1000)));
    s.seek(500);
    const early = s.agentSnapshot();
    expect(early).toContain("a [default]");
    // 改前：`link` 没有时刻，这一行永远带着 `links:resultant-of->b`。
    expect(early).not.toContain("links:");
    s.seek(1500);
    expect(s.agentSnapshot()).toContain("links:resultant-of->b");
    // 护栏：带子尽头那份仍然报得出来（那是导演下一拍的起点）。
    s.seek(s.compiled.duration);
    expect(s.agentSnapshot()).toContain("links:resultant-of->b");
  });

  it("同一名字被 link 两次：各按各的时刻报", () => {
    const s = new Stage();
    s.load(tape(art("a"), art("b"), tie("a", "b", "points-to"), line("一", 1000), tie("a", "b", "contradicts"), line("二", 1000)));
    s.seek(500);
    const one = s.agentSnapshot();
    expect(one).toContain("links:points-to->b");
    expect(one).not.toContain("contradicts");
    s.seek(1500);
    expect(s.agentSnapshot()).toContain("links:points-to->b,contradicts->b");
  });

  it("随机带子上逐刻对账：快照报的关系，正是那一刻之前落下的那些", () => {
    const ids = ["a", "b", "c"];
    let s0 = 20261009 >>> 0;
    const rnd = (n: number) => {
      s0 = (Math.imul(s0, 1664525) + 1013904223) >>> 0;
      return s0 % n;
    };
    let compared = 0;
    let caught = 0;
    let ties = 0;
    for (let tapeN = 0; tapeN < 24; tapeN++) {
      const ops: Op[] = [];
      for (let i = 0; i < 20; i++) {
        const id = ids[rnd(ids.length)];
        switch (rnd(5)) {
          case 0:
            ops.push(art(id));
            break;
          case 1:
            ops.push(line("一句足够长的话把它撑满一拍", 400 + rnd(900)));
            break;
          case 2:
            ties++;
            ops.push(tie(id, ids[rnd(ids.length)], `r${rnd(3)}`));
            break;
          case 3:
            ops.push(drop(id));
            break;
          default:
            ops.push(blank(id));
        }
      }
      const st = new Stage();
      st.load(tape(...ops));
      const c = st.compiled;
      const edges = new Set<number>([0, c.duration]);
      for (const p of c.props.values()) {
        for (const r of p.revisions) {
          edges.add(r.t);
          if (r.off !== undefined) edges.add(r.off);
        }
        for (const l of p.links) edges.add(l.at);
      }
      for (const q of c.cues) if (q.op.kind === "narrate") edges.add(q.end - 1);
      const marks = [...edges].filter((t) => Number.isFinite(t) && t >= 0).sort((x, y) => x - y);
      for (const t of marks) {
        st.seek(t);
        const snap = st.agentSnapshot();
        for (const p of c.props.values()) {
          // 关系挂在名字上，而那一行只在名字站在台上的时候才存在（`offstage.test.ts` 钉的就是"撤下的
          // 名字不许出现在 <stage> 里"）。所以完整规则是两半：这一刻之前落下的，**并且**此刻站着。
          let holds = false;
          for (const r of p.revisions) if (r.t <= t && !(r.off !== undefined && r.off <= t)) holds = true;
          for (const l of p.links) {
            compared++;
            const said = new RegExp(`^ {2}${p.id} [^\\n]*links:[^\\n]*${l.relation}->${l.to}`, "m").test(snap);
            if (l.at <= t && holds !== said) caught++;
          }
        }
      }
    }
    // 量不到差异的对账是空转的门。
    expect(ties).toBeGreaterThan(20);
    expect(compared).toBeGreaterThan(100);
    expect(caught).toBe(0);
  });
});

describe("观众已经不在那块板上：时钟不许为它停死（在飞的那一半）", () => {
  it("幕布盖过去之后，那块板上的在飞画不欠时钟任何东西", () => {
    const s = new Stage();
    s.goLive();
    // 同一拍里：在 `乙` 落一格空框，然后切回 `甲`（flip = 600，拍窗口 [0,1200)）。
    s.append([blank("a", "乙"), cut("甲", 1200)], MAIN_TRACK);
    s.setTurnOpen(false);
    s.beginArt("a"); // 美工正在给那一格流式吐线
    s.play();
    step(s, 700); // 越过 flip，观众已经不在 `乙` 了
    expect(s.getSnapshot().props.map((p) => p.id)).toEqual([]);
    // 改前：`owedAt` 的在飞那一遍只比 `rev.t` 在不在这一拍里，于是这里还欠着一幅观众看不见的画。
    expect(s.getSnapshot().artOwed).toBe(0);
    expect(s.t).toBeGreaterThan(600);
  });

  it("后台那一遍同样：被扫走的那块板上，在途的画不欠时钟", () => {
    const s = new Stage();
    s.goLive();
    s.append([blank("a", "乙"), cut("甲", 1200)], MAIN_TRACK);
    s.setTurnOpen(false);
    s.beginPaint("a");
    s.play();
    step(s, 700);
    expect(s.getSnapshot().artOwed).toBe(0);
    expect(s.t).toBeGreaterThan(600);
  });

  it("护栏：幕布还没盖过去，同一格确实该停住时钟", () => {
    const s = new Stage();
    s.goLive();
    s.append([blank("a", "乙"), cut("甲", 1200)], MAIN_TRACK);
    s.setTurnOpen(false);
    s.beginArt("a");
    s.play();
    step(s, 300); // flip 之前，那一格观众还看得见
    expect(s.getSnapshot().props.map((p) => p.id)).toEqual(["a"]);
    expect(s.getSnapshot().artOwed).toBeGreaterThan(0);
    expect(s.t).toBe(0);
  });
});

describe("一帧报的板名，是站着那一次的板名", () => {
  it("道具后来挪去别的板，不许改写它此刻所在的板", () => {
    const s = new Stage();
    s.load(tape(art("a", "甲"), line("一", 1000), art("a", "乙"), line("二", 1000)));
    s.seek(500);
    const frame = s.getSnapshot().props.find((p) => p.id === "a")!;
    // 改前这里是 `乙`：快照（上一件改过）与一帧名单（这一件）对同一个名字两种说法。
    expect(frame.scene).toBe("甲");
    s.seek(2500);
    expect(s.getSnapshot().props.find((p) => p.id === "a")!.scene).toBe("乙");
  });

  it("随机带子上逐刻对账：名单里的板名等于站着那一格的板名", () => {
    const boards = ["甲", "乙", "丙"];
    let s0 = 20261009 >>> 0;
    const rnd = (n: number) => {
      s0 = (Math.imul(s0, 1664525) + 1013904223) >>> 0;
      return s0 % n;
    };
    let compared = 0;
    for (let tapeN = 0; tapeN < 24; tapeN++) {
      const ops: Op[] = [];
      for (let i = 0; i < 20; i++) {
        const id = ["a", "b", "c"][rnd(3)];
        switch (rnd(6)) {
          case 0:
            ops.push(art(id, boards[rnd(3)]));
            break;
          case 1:
            ops.push(blank(id, boards[rnd(3)]));
            break;
          case 2:
            ops.push(line("一句足够长的话把它撑满一拍", 400 + rnd(900)));
            break;
          case 3:
            ops.push(drop(id));
            break;
          case 4:
            ops.push(back(id, boards[rnd(3)]));
            break;
          default:
            ops.push(cut(boards[rnd(3)]));
        }
      }
      const s = new Stage();
      s.load(tape(...ops));
      const c = s.compiled;
      const marks = new Set<number>([0, c.duration]);
      for (const p of c.props.values()) {
        for (const r of p.revisions) {
          marks.add(r.t);
          if (r.off !== undefined) marks.add(r.off);
        }
      }
      for (const q of c.cues) if (q.op.kind === "transition") marks.add(q.t + (q.end - q.t) / 2);
      // 边缘之外还要问**相邻边缘之间**的那些刻点：`prop.scene` 是在下一次落笔时才改的，只问边缘
      // 会正好错过"这一格还站着、而道具已经被后来的那一刀挪走了"的那一段内部。
      const edges = [...marks].filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
      for (let i = 1; i < edges.length; i++) {
        const a = edges[i - 1];
        const b = edges[i];
        if (b - a >= 2) marks.add(Math.floor((a + b) / 2));
        marks.add(b - 1);
      }
      for (const t of [...marks].filter((x) => Number.isFinite(x))) {
        s.seek(t);
        const byId = new Map(s.getSnapshot().props.map((p) => [p.id, p.scene]));
        for (const p of c.props.values()) {
          let rev: { scene: string } | undefined;
          for (const r of p.revisions) if (r.t <= t && !(r.off !== undefined && r.off <= t)) rev = r;
          if (!rev || !byId.has(p.id)) continue; // 不在名单上的是另一半规则（被换场扫走）
          compared++;
          expect(byId.get(p.id)).toBe(rev.scene);
        }
      }
    }
    expect(compared).toBeGreaterThan(200);
  });

  it("导演档案那头仍然读带子尽头：`fetch_prop` 报的是最后一次落下的板（不许和上面混成一个）", () => {
    const s = new Stage();
    s.append([art("a", "甲"), line("一", 1000), art("a", "乙"), line("二", 1000)], MAIN_TRACK);
    s.seek(500);
    const read = tools(s).run("fetch_prop", { id: "a" });
    expect(JSON.parse(read.result).scene).toBe("乙");
  });
});
