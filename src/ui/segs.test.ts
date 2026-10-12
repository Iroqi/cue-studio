// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MAIN_TRACK } from "../engine/log";
import { Stage } from "../engine/runtime";
import { BeatRail } from "./BeatRail";
import { railMeter, segsFor, nowStore, type SegView } from "./segs";
import type { Compiled, Op } from "../engine/types";

/*
 * 这一节测的是**观众那一头的第二笔 O(带子)**。C 消掉日志面板那一笔之后，同一台机器上剩下的最大一笔
 * 就在节拍条（`docs/iteration-plan.md` 里那张表，4800 行那一档：engine 0.04ms / log 12ms / rail 240ms
 * / app 260ms 每批）。它有两半：
 *
 *  - **落一笔**那半：段的宽度以前是 `max(46px, share%)`，`share` 的分母是 `duration` —— 落一笔就把
 *    每一段的宽度改了，n 段每一段都得重新 render。实测 4800 段一批 240ms。
 *  - **走一帧**那半：`now` 是当 prop 传下去的，跨一拍就拿到 n 个新元素引用。实测 4800 段一帧 29ms
 *    （拖进度条时每拖一下付一次；`view.test.ts` 那一件只让**不跨拍**的那一帧免费）。
 *
 * 价钱那一层照 C 的规矩不数毫秒，数**指纹**：这里数做了几段元素（`segEl` 门口那个计数器，段元素只能
 * 从这里出来），`view.test.ts` 那头数几段真的重新 render 了（`teacher.canReroll` 的调用次数）。
 *
 * 对账的参照是**改前那句写法**："拿整场时长当分母，把整条拍表从头 `map` 一遍"。C 那一头可以共用
 * `describeOp`（那件改的不是"一行印什么"），这一件改的恰恰是"一段印什么、由谁决定它要不要重印"，
 * 所以参照必须把"印什么"自己再算一遍，不许复用任何缓存。
 */

/** 改前那份读法：每批拿整场时长当分母，整条拍表 `map` 一遍。 */
function legacySegs(compiled: Compiled): string[] {
  const total = Math.max(compiled.duration, 1);
  return compiled.beats.map((b) => `max(46px, ${(((b.end - b.start) / total) * 100).toFixed(2)}%)`);
}

/**
 * 一段该印什么，参照自己算一遍（不复用 `segs.tsx` 里那一句）。
 *
 * F 之后 `now` **不进元素**，所以参照里也不比它：`now` 参数留着只因为调用方仍按"此刻亮第几格"喂给它，
 * 而这一件要钉的是"亮那一格"这件事**换了 store、不换数组**，由那条 store 测试单独钉。这里 `cls` 不带
 * ` now` —— 元素本来就再也不会带它。
 */
function reference(compiled: Compiled, _now = -1, armedSeq?: number) {
  return compiled.beats.map((b, i) => ({
    key: String(b.seqs[0]),
    no: String(i + 1),
    cls: "seg" + (b.gate ? " ask" : "") + (armedSeq === b.seqs[0] ? " armed" : ""),
    grow: Math.max(1, Math.round(b.end - b.start)),
    headline: b.headline || "（无声调度）",
    title: `第 ${i + 1} 拍 · ${Math.round(b.start)}–${Math.round(b.end)}ms · 出自第 ${b.turn} 次调度 · ${b.verbs.join(" ")}`,
  }));
}

/**
 * 一段元素的"要印什么"。
 *
 * `Seg` 是 `memo` 过的**组件**，所以元素里没有 `children` 可读 —— 印出来的那几样就在 `props.p` 里，
 * 而 `props` 恰好是 React 逐格浅比对的东西。F 之后 `now` **不在元素里**（它归那台 `store`，每段自己订阅
 * `store.get() === i`），所以这里只比"印出来的那几样"与"点住没有"，不比亮不亮 —— 亮不亮由 `store` 单独
 * 钉（见那条"只换亮不许重新交那一份"），DOM 那一头另有一段（`护栏：真在 DOM 上`）拿真画面复核对不对。
 */
type SegProps = {
  i: number;
  armed: boolean;
  p: { title: string; headline: string; ask: boolean; grow: number; turn: number };
};

function segOf(el: React.ReactElement) {
  const q = el.props as unknown as SegProps;
  return {
    key: String(el.key),
    no: String(q.i + 1),
    cls: "seg" + (q.p.ask ? " ask" : "") + (q.armed ? " armed" : ""),
    grow: q.p.grow,
    headline: q.p.headline,
    title: q.p.title,
  };
}

/** 逐格比"印出来的那几样"。`turn` 写在 title 里，比 title 就比到了。 */
function sameSegs(rows: readonly React.ReactElement[], ref: ReturnType<typeof reference>) {
  expect(rows.length).toBe(ref.length);
  for (let i = 0; i < ref.length; i += 1) {
    const got = segOf(rows[i] as React.ReactElement);
    expect(got.key).toBe(ref[i].key);
    expect(got.no).toBe(ref[i].no);
    expect(got.cls).toBe(ref[i].cls);
    expect(got.grow).toBe(ref[i].grow);
    expect(got.headline).toBe(ref[i].headline);
    expect(got.title).toBe(ref[i].title);
  }
}

/** 乘同余（`Math.imul`，不是 `seed * 大素数` —— 后者在 float64 里丢精度，见 offstage 那一件的教训）。 */
function rnd(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s, 1103515245) + 12345;
    return ((s >>> 0) % 100000) / 100000;
  };
}

type Kind = "narrate" | "beat" | "camera" | "highlight" | "quiz" | "answer" | "transition" | "discard" | "pause-for" | "link" | "build" | "patch";
const KINDS: Kind[] = ["narrate", "beat", "camera", "highlight", "quiz", "answer", "transition", "discard", "pause-for", "link", "build", "patch"];

const shot = (duration = 400): Op => ({ kind: "camera", mode: "pan", dir: "right", screens: 0.5, duration, easing: "ease" });

/**
 * 一卷随机带子，分成 `batches` 批、每批 `per` 刀。节拍条要的形状和日志面板不一样：
 *  - **一批里得有占时钟的那一刀**（`narrate`/`beat`/`transition`），否则整批只长零拍或一拍，钉不出
 *    "本批那几拍"
 *  - **批尾收在不占时钟的那一刀上**：下一批的第一刀就落在**同一拍**里 —— 那正是"上一批排出去的那一格
 *    被身后那一批改了宽度/台词/问字"的形状，也是唯一能让回头那一格真出现的写法
 *  - `quiz`/`pause-for` 常常落进**已经开了的那一拍**：那一格的"问"字与台词是后到的
 */
function tape(seed: number, batches: number, per: number): Op[][] {
  const r = rnd(seed);
  const out: Op[][] = [];
  let landed = 0;
  for (let b = 0; b < batches; b += 1) {
    const batch: Op[] = [];
    for (let i = 0; i < per; i += 1) {
      const kind = KINDS[Math.floor(r() * KINDS.length)];
      switch (kind) {
        case "narrate":
          batch.push({ kind: "narrate", text: `第 ${b}-${i} 句`, duration: 1200 + Math.floor(r() * 900) });
          break;
        case "beat":
          batch.push({ kind: "beat", duration: 300 + Math.floor(r() * 400) });
          break;
        case "camera":
          batch.push(shot(600));
          break;
        case "highlight":
          batch.push({ kind: "highlight", target: `vec-${Math.floor(r() * 4)}`, style: "pulse", duration: 500 });
          break;
        case "quiz":
          batch.push({ kind: "quiz", prompt: `第 ${b}-${i} 题？`, options: ["甲", "乙"], answer: 0 });
          break;
        case "answer":
          batch.push({ kind: "answer", gate: Math.max(0, landed - 1 - Math.floor(r() * 3)), text: "甲" });
          break;
        case "transition":
          batch.push({ kind: "transition", style: "dissolve", to: `板${Math.floor(r() * 3)}`, duration: 700 });
          break;
        case "discard":
          batch.push({ kind: "discard", id: `vec-${Math.floor(r() * 4)}` });
          break;
        case "pause-for":
          batch.push({ kind: "pause-for", reason: `停一下 ${b}-${i}` });
          break;
        case "link":
          batch.push({ kind: "link", from: "vec-0", relation: "sum-of", to: "vec-1" });
          break;
        case "build":
          batch.push({ kind: "build", id: `vec-${Math.floor(r() * 4)}`, label: "向量", scene: "甲", box: { x: 100, y: 100, w: 200, h: 120 } });
          break;
        case "patch":
          batch.push({ kind: "patch", id: `vec-${Math.floor(r() * 4)}`, svg: `<svg><text>${b}</text></svg>` });
          break;
      }
      landed += 1;
    }
    // 批尾换成不占时钟的那一刀（`pause-for` 挂着时钟、`narrate`/`beat` 收拍，都会把下一批推到新一拍去）
    const last = batch[batch.length - 1];
    if (!last || last.kind === "narrate" || last.kind === "beat" || last.kind === "pause-for") batch.push(shot());
    out.push(batch);
  }
  return out;
}

const NOOP = () => {};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// 节拍条的 effect 会把亮着的那一段滚进视野，jsdom 没这一句
Element.prototype.scrollIntoView = () => {};

/**
 * 一台活的机器 + 那一双手，跟着同一卷带子走 —— 和 `App.tsx` 里 `BeatRail` 那一头同一句读法。用 `Stage`
 * 而不是自己摆一台解释器，是因为这一件的账挂在 `Compiled.beats` 那条**会长大的数组**上：那条数组到底
 * 换不换引用，只有走 `Stage.recompile` 才算钉住。`nextTurn()` 是导演开一轮时喊的那一句，这里也喊 ——
 * `turn` 是段上 title 里的东西，也是 `canReroll` 问的东西。
 */
class Harness {
  stage = new Stage();
  view: SegView = { stage: this.stage, teacher: null, onArm: NOOP };

  /** 落一批并问一次段，夹出**这一批**做了几段元素。 */
  lay(batch: Op[], track = MAIN_TRACK) {
    this.stage.log.nextTurn();
    const before = this.stage.compiled.beats.length;
    this.stage.append(batch, track);
    const at = railMeter.segs;
    this.segs();
    return { made: railMeter.segs - at, grew: this.stage.compiled.beats.length - before };
  }

  segs(now = -1, armedSeq?: number) {
    const rows = segsFor(this.stage.compiled, this.view, now, armedSeq);
    // 与 `BeatRail` 同一句读法：`segsFor` 只在整条重建时用 `now` 播种那台机器，续排那一头 `now` 由组件在
    // layout effect 里推。测试挂的是门、不是真组件，所以这里手动补那一推，门这一头才拿得到"此刻亮第几格"。
    nowStore(this.stage.compiled).set(now);
    return rows;
  }

  /** 此刻那台机器答的是第几格（F 之后亮不亮只在它身上，不在元素里）。 */
  litNow() {
    return nowStore(this.stage.compiled).get();
  }

  /** 同一台机器、同一张拍表，只问一次"换了吗"，夹出这次要的段数。 */
  cost(body: () => void) {
    const at = railMeter.segs;
    body();
    return railMeter.segs - at;
  }

  get compiled() {
    return this.stage.compiled;
  }
}

describe("segs：已经排好的那一段不许跨一帧再排一遍", () => {
  it("形状：逐批续排与整条重排逐格同解（一百卷随机带子 × 八批）", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const h = new Harness();
      for (const batch of tape(seed, 8, 6)) {
        h.lay(batch);
        sameSegs(h.segs(), reference(h.compiled));
      }
    }
  });

  it("形状：亮着的那一格与被点住的那一格，跟整条重排同一个答案", () => {
    const h = new Harness();
    for (const b of tape(11, 4, 6)) h.lay(b);
    const beats = h.compiled.beats;
    const mid = Math.floor(beats.length / 2);
    sameSegs(h.segs(mid), reference(h.compiled, mid));
    // F 之后亮不亮只在 store 上：门喂进来的那个 `now` 必须能在机器上问回来，元素里再没有 ` now`。
    expect(h.litNow()).toBe(mid);
    sameSegs(h.segs(mid, beats[mid + 1].seqs[0]), reference(h.compiled, mid, beats[mid + 1].seqs[0]));
    sameSegs(h.segs(-1, beats[0].seqs[0]), reference(h.compiled, -1, beats[0].seqs[0]));
    expect(h.litNow()).toBe(-1);
    // 时钟落到最后一拍之外：没有哪一格该亮，可整条一段不许少
    sameSegs(h.segs(beats.length), reference(h.compiled, beats.length));
    expect(h.litNow()).toBe(beats.length);
  });

  it("价钱：只换亮那一格，那一份一个字都不许多交（F 消掉的那一笔）", () => {
    /*
     * 这是 F 的价钱层，钉的是它真正消掉的东西：从前跨一拍 `take()` 见 `published=null` 就把整条拍表
     * 重新 slice 一遍（`railPublished` 加整条长度）+ `light` relay 那两格（`railSegs` 加 2）。F 把
     * `now` 从元素里搬到 store 之后，续排那一头 `now` 一个字不进这本账：亮不亮换了、带子没换、段没换、
     * 那一份引用也不换。探针实测这一格从 64000@2000 帧缩到 0。
     */
    const h = new Harness();
    for (const b of tape(11, 5, 5)) h.lay(b);
    const beats = h.compiled.beats;
    const before = h.segs(0); // 先亮第 0 格，把那一份交出去
    const at = railMeter.published;
    const segsAt = railMeter.segs;
    // 一路把亮往后面挪，带子一个字不动：每一问都不许重新交那一份、不许多做一段
    for (let i = 1; i < Math.min(beats.length, 50); i += 1) {
      expect(h.segs(i)).toBe(before); // 还是同一个引用
      expect(h.litNow()).toBe(i); // 机器答得上此刻亮哪一格
    }
    expect(railMeter.published - at).toBe(0);
    expect(railMeter.segs - segsAt).toBe(0);
  });

  it("护栏：回头改那一格、点住那一格仍要换引用（诚实价，不许冻在旧画面）", () => {
    // F 只把"亮"这一格搬走；段本身印的东西变了（回头改宽度/台词/问字）或被点住，仍得重新交那一份。
    const h = new Harness();
    h.lay([{ kind: "narrate", text: "第一句", duration: 1000 }]);
    const first = h.segs();
    const at = railMeter.published;
    // 点住一格（armed 进元素）：那一份必须重新交，否则 React 整棵当没变、重排bar 那一格永远点不住
    const armedSeq = h.compiled.beats[0].seqs[0];
    expect(h.segs(0, armedSeq)).not.toBe(first);
    expect(railMeter.published - at).toBeGreaterThan(0);
    // 放开点住：那一份也重新交回
    expect(h.segs(0)).not.toBe(first);
  });

  it("护栏：回头改的那一格，改的是**印出来的那些值**，不是只排了个新元素", () => {
    /*
     * 这一条钉的是这一件**唯一会出错的地方**：解释器是原地长那一拍的（`end`、`gate`、`headline`），
     * 而 `memo` 比的是 props 的引用 —— 若把那个活 `Beat` 当"要印什么"传下去，回头改的那一格排出去的
     * 新元素会被 React 拿旧 props 一比驳回去，DOM 就停在旧宽度与空台词上，而**计数器照常加一格**：
     * 形状层与价钱层全绿，观众看见的是旧画面。所以这里既比元素里的值，也比"这一格付了几段"。
     */
    const h = new Harness();
    // 一句旁白的窗口是 `cueMs` 说了算（朗读时长比写下来的 `duration` 长），所以这一段的数全部从台面
    // 上取：测试不许抄一遍那个算法，它要问的是"此刻那一拍多长"与"段里印的是不是此刻那一拍"。
    const live = (i: number) => {
      const b = h.compiled.beats[i];
      return { grow: Math.max(1, Math.round(b.end - b.start)), title: `第 ${i + 1} 拍 · ${Math.round(b.start)}–${Math.round(b.end)}ms` };
    };
    // 第一批收在一只镜头上：那一拍开了口、没有台词、不挂卡，窗口是 1ms 那道下限（镜头不占时钟）
    expect(h.lay([shot(600)]).grew).toBe(1);
    let one = segOf(h.segs()[0]);
    expect(one.headline).toBe("（无声调度）");
    expect(one.cls).not.toContain("ask");
    expect(one.grow).toBe(live(0).grow);
    expect(one.grow).toBe(1);
    // 第二批：一张卡与一句台词落在**同一拍**里 —— 那一格必须改口，而拍表一段没长
    const second = h.lay([
      { kind: "quiz", prompt: "合力多大？", options: ["5N", "7N"], answer: 0 },
      { kind: "narrate", text: "等他答完", duration: 1000 },
    ]);
    expect(second.grew).toBe(0);
    expect(second.made).toBe(1); // 回头那一格：不是整条
    one = segOf(h.segs()[0]);
    expect(one.headline).toBe("合力多大？");
    expect(one.cls).toContain("ask");
    expect(one.title).toContain("camera quiz narrate");
    expect(one.grow).toBe(live(0).grow);
    expect(one.title).toContain(live(0).title);
    expect(one.grow).toBeGreaterThan(1);
    // 身后那一批开新一拍：前一拍的 end 从此冻住，本批只许做那一拍
    const frozen = live(0).grow;
    const third = h.lay([{ kind: "beat", duration: 400 }]);
    expect(third.grew).toBe(1);
    expect(third.made).toBe(1);
    expect(segOf(h.segs()[0]).grow).toBe(frozen);
    expect(segOf(h.segs()[1]).grow).toBe(live(1).grow);
    sameSegs(h.segs(), reference(h.compiled));
  });

  it("护栏：同一卷带子反复问，一段都不许重做，那一份也不许重新交", () => {
    const h = new Harness();
    for (const b of tape(2, 6, 5)) h.lay(b);
    const first = h.segs(3);
    const at = railMeter.published;
    for (let i = 0; i < 30; i += 1) {
      expect(h.cost(() => h.segs(3))).toBe(0);
      expect(h.segs(3)).toBe(first);
    }
    expect(railMeter.published - at).toBe(0);
  });

  it("价钱：落一批只做新落的那几拍，外加回头那一格", () => {
    const h = new Harness();
    let back = 0;
    for (const batch of tape(7, 40, 8)) {
      const { made, grew } = h.lay(batch);
      expect(made).toBeGreaterThanOrEqual(grew);
      expect(made).toBeLessThanOrEqual(grew + 1);
      if (made > grew) back += 1;
    }
    // 回头那一格必须真的出现过：一次也没有的话上面那些断言就只是"没测到"
    expect(back).toBeGreaterThan(0);
  });

  it("价钱：跨进下一拍那一帧至多两段，走完一整条也只按段数走", () => {
    const h = new Harness();
    for (const b of tape(5, 8, 6)) h.lay(b);
    const beats = h.compiled.beats;
    h.segs(0);
    let worst = 0;
    for (let i = 1; i < beats.length; i += 1) worst = Math.max(worst, h.cost(() => h.segs(i)));
    expect(worst).toBeLessThanOrEqual(2);
    // 亮着的那一格换成"没有哪一格"：只许旧的熄灭
    expect(h.cost(() => h.segs(-1))).toBeLessThanOrEqual(2);
  });

  it("价钱：点住与放开那一格，那几段的价钱里没有带子的长度", () => {
    const costs: number[] = [];
    for (const batches of [40, 400]) {
      const h = new Harness();
      for (const b of tape(9, batches, 6)) h.lay(b);
      const beats = h.compiled.beats;
      h.segs(0);
      const armed = beats[Math.floor(beats.length / 2)].seqs[0];
      const a = h.cost(() => h.segs(0, armed)); // 点住：那一格
      const b2 = h.cost(() => h.segs(1, armed)); // 点住着又跨一拍：两格 + 那一格
      const c = h.cost(() => h.segs(1)); // 放开：摘掉那一格
      expect(a).toBeLessThanOrEqual(2);
      expect(b2).toBeLessThanOrEqual(3);
      expect(c).toBeLessThanOrEqual(2);
      costs.push(a + b2 + c);
    }
    // 四十倍的带子，这三问的段数一模一样
    expect(costs[0]).toBe(costs[1]);
  });

  it("价钱：带子长四十倍，同一批那一刀的价钱一格不许多", () => {
    /*
     * 比的不是合计（合计当然跟着带子长，那是线性，正是要的形状），是**同一批在两种长度下的价钱**。
     * `tape(7, …)` 同种子、同次序，所以 2400 批那一卷的**前 60 批就是短的那一卷**：逐批的段数必须
     * 一字不差 —— 这一句才是"价钱里没有带子的长度"。改前那一头第 b 批重画的是"截至这一批的全部段"，
     * 四十倍长的带子把最贵的一批抬高四十倍。
     */
    const per = 8;
    const run = (batches: number) => {
      const h = new Harness();
      const work: number[] = [];
      const grew: number[] = [];
      for (const batch of tape(7, batches, per)) {
        const one = h.lay(batch);
        work.push(one.made);
        grew.push(one.grew);
      }
      // 每一批多出来的那一格 = 回头改的那一格
      return { h, work, grew, excess: work.map((x, i) => x - grew[i]), batches };
    };
    const short = run(60);
    const long = run(2400);
    expect(long.work.slice(0, 60)).toEqual(short.work);
    // 每一批只许是本批那几拍 + 回头那一格，而且那一格与带子长度无关
    expect(Math.max(...short.excess)).toBe(Math.max(...long.excess));
    expect(Math.max(...long.excess)).toBeLessThanOrEqual(1);
    expect(Math.max(...long.work)).toBeLessThanOrEqual(per + 1);
    for (const r of [short, long]) {
      // 合计：每一拍做一次，外加每批至多一次回头
      expect(r.work.reduce((a, x) => a + x, 0)).toBeLessThanOrEqual(r.h.compiled.beats.length + r.batches);
    }
    // 参照那一头量得到东西：四十倍长的带子，拍表也确实长了十倍不止
    expect(long.h.compiled.beats.length).toBeGreaterThan(short.h.compiled.beats.length * 10);
  });

  it("价钱：带子换卷那一条付的是整条的钱（不许偷偷变成常数）", () => {
    const h = new Harness();
    for (const b of tape(3, 6, 5)) h.lay(b);
    // 剪在最后一拍那一刀之前：只丢最后一拍，但**换了带子** → 新的拍表 → 整条重排
    const whole = h.compiled.beats.length;
    const cut = h.compiled.beats[whole - 1].seqs[0];
    h.stage.log.cutFrom(cut);
    h.stage.recompile();
    expect(whole).toBeGreaterThan(2);
    expect(h.compiled.beats.length).toBe(whole - 1);
    expect(h.cost(() => h.segs())).toBe(h.compiled.beats.length);
  });

  it("护栏：内容相同、换了拍表必须整条重排", () => {
    const h = new Harness();
    for (const b of tape(4, 4, 5)) h.lay(b);
    const first = h.segs();
    const other: Compiled = { ...h.compiled, beats: [...h.compiled.beats] };
    expect(h.cost(() => segsFor(other, h.view, -1, undefined))).toBe(other.beats.length);
    const again = segsFor(other, h.view, -1, undefined);
    // 同一张新拍表再问一次就不许再付整条（否则上面那一句只是在测"每次都重建"）
    expect(h.cost(() => segsFor(other, h.view, -1, undefined))).toBe(0);
    expect(again).not.toBe(first);
    sameSegs(again, reference(h.compiled));
  });

  it("护栏：换导演、换机器、换那个点击回调，都必须整条重排", () => {
    const h = new Harness();
    for (const b of tape(6, 4, 5)) h.lay(b);
    const beats = h.compiled.beats;
    h.segs();
    // 同一张拍表（`cached` 的键没换），只换那三样里的一样：重建必须归因到 `holds`
    const otherHand = () => {};
    const views: SegView[] = [
      { stage: h.stage, teacher: { canReroll: () => true, rerollFrom: async () => {} } as never, onArm: h.view.onArm },
      { stage: new Stage(), teacher: null, onArm: h.view.onArm },
      { stage: h.stage, teacher: null, onArm: otherHand },
    ];
    for (const view of views) {
      expect(h.cost(() => segsFor(h.compiled, view, -1, undefined))).toBe(beats.length);
      // 同一双手再问一次就免费：`holds` 不许永远答"不是"
      expect(h.cost(() => segsFor(h.compiled, view, -1, undefined))).toBe(0);
    }
    // 回到原来那双手：那也是另一双手，整条重来（少问一样就是漏）
    expect(h.cost(() => segsFor(h.compiled, h.view, -1, undefined))).toBe(beats.length);
  });

  it("护栏：那一份必须重新交出去，否则 React 整棵当没变（新落的那一段进不了 DOM）", () => {
    /*
     * C 那一件踩过的那一次坑在这里同样致命：`.beats` 里那份段数组是 `nav` 的**几个子元素之一**，
     * 引用不换 React 就把整棵子树浅比对掉，新落的那一拍一段也不会出现在 DOM 上，而计数器照常加。
     */
    const h = new Harness();
    for (const b of tape(8, 3, 4)) h.lay(b);
    const first = h.segs();
    const at = railMeter.published;
    // 两句旁白：第二句必定开新一拍（第一句把上一拍收了口）
    h.lay([
      { kind: "narrate", text: "又一句", duration: 800 },
      { kind: "narrate", text: "再一句", duration: 800 },
    ]);
    const next = h.segs();
    expect(next).not.toBe(first);
    expect(next.length).toBe(h.compiled.beats.length);
    expect(railMeter.published - at).toBe(next.length);
    expect(next[0]).toBe(first[0]);
  });

  it("护栏：段上写的是这一拍自己的毫秒数，整场多长那一个数进不到任何一段", () => {
    /*
     * 一句旁白的窗口不是它自己写的那个 `duration`：`cueMs` 下面还有朗读时长那道底（见 `speech.ts`），
     * 所以这一段不许在测试里抄一遍那个数 —— 只问"此刻那一拍多长"，那是台面给的。
     */
    const h = new Harness();
    const spans = () => h.compiled.beats.map((b) => Math.max(1, Math.round(b.end - b.start)));
    h.lay([
      { kind: "narrate", text: "一句长的", duration: 30_000 },
      { kind: "narrate", text: "一句短的", duration: 30_000 },
    ]);
    expect(h.segs().map(segOf).map((s) => s.grow)).toEqual(spans());
    const before = legacySegs(h.compiled);
    const widths = h.segs().map(segOf).map((s) => s.grow);
    // 身后长一截：改前那一句里**每一段**的宽度都跟着变（这就是那笔冤枉钱），现在一格都不许动
    h.lay([{ kind: "narrate", text: "又一句", duration: 40_000 }]);
    const after = h.segs().map(segOf).map((s) => s.grow);
    expect(legacySegs(h.compiled)).not.toEqual(before);
    expect(after.slice(0, 2)).toEqual(widths);
    expect(after.length).toBe(3);
  });

  it("护栏：真在 DOM 上 —— 点住一段、带子往后长、回头那一格也改到画面", () => {
    /*
     * 这一段是这一件的**护栏**，也是它最要紧的一段：元素计数器加了一格不等于画面上换了那一格 ——
     * 若"要印什么"传的是那个活的 `Beat` 对象（解释器原地长它），`memo` 会拿旧 props 把新元素驳回去，
     * 于是形状层与价钱层全绿、DOM 停在旧宽度与空台词上。所以这里断言的是 DOM 上的 `flex-grow` 与那句
     * 台词，而 `canReroll` 的调用次数就是"几段真的重新 render 了"（`view.test.ts` 早就在用）。
     */
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root: Root = createRoot(host);
    const stage = new Stage();
    const turn = (ops: Op[]) => act(() => stage.append(ops, MAIN_TRACK));
    turn([{ kind: "narrate", text: "第一句", duration: 30_000 }]);
    turn([{ kind: "narrate", text: "第二句", duration: 30_000 }]);
    // 一只镜头自己不开新一拍，所以第三段是"前一拍已经被第二句收口"的那一格：窗口 1ms（`cueMs` 的下限）
    turn([shot(700)]);
    const spans = () => stage.compiled.beats.map((b) => Math.max(1, Math.round(b.end - b.start)));
    const canReroll = vi.fn(() => true);
    const teacher = { canReroll, rerollFrom: async () => {} } as never;
    const t = stage.compiled.beats[1].start + 10;
    const rerender = () => act(() => root.render(createElement(BeatRail, { stage, teacher, t })));
    rerender();

    const rows = () => [...host.querySelectorAll<HTMLElement>(".seg")];
    const cls = (i: number) => rows()[i].className;
    const say = (i: number) => rows()[i].querySelector(".seg-main span")?.textContent ?? "";
    const armed = () => rows().filter((s) => s.classList.contains("armed")).length;
    /*
     * 每一帧都问这一句：画面上每一段的宽度必须等于**此刻**那一拍的窗口。旧画面留在 DOM 上正是这一件
     * 最坏的错法 —— 回头只改那一格，可谁也不知道解释器以后还会不会改别的格，所以这一句是整个护栏。
     */
    const widths = () => {
      expect(rows().map((s) => s.style.getPropertyValue("flex-grow"))).toEqual(spans().map(String));
    };
    expect(rows().length).toBe(3);
    expect(cls(1)).toContain("now");
    expect(cls(0)).not.toContain("now");
    expect(say(1)).toBe("第二句");
    expect(spans()[2]).toBe(1);
    // 下限与 `flex-basis` 是画面那一头的两样，只能从 DOM 问：一拍都不站得住时每段占自己的 46px，
    // 宽度之比由 `flex-grow` 分，而容器出横向滚动条 —— 和当年 `max(46px, share%)` 同一件事。
    expect(rows()[0].style.minWidth).toBe("46px");
    expect(rows()[0].style.flexBasis).toBe("0px");
    widths();
    // 挂载那一次整条都得 render，清掉它才好数后面几帧
    canReroll.mockClear();

    // 点住第三段的 ⟲：只该重画那一格
    act(() => rows()[2].querySelector<HTMLButtonElement>(".seg-roll")?.click());
    expect(cls(2)).toContain("armed");
    expect(armed()).toBe(1);
    expect(host.querySelector(".roll-bar .who")?.textContent).toContain("第 3 拍");
    expect(canReroll.mock.calls.length).toBeLessThanOrEqual(2);
    canReroll.mockClear();

    // 再 render 一次：带子没动、亮着那格也没换 —— 那本账必须原地不动，一段都不许重画
    rerender();
    expect(canReroll).not.toHaveBeenCalled();

    // 身后那一刀落在**同一拍**里（旁白身后没有 `openNext`）：那一格必须改口，宽度跟着那一拍的 end 走
    turn([{ kind: "narrate", text: "第三句", duration: 800 }]);
    rerender();
    expect(say(2)).toBe("第三句");
    expect(spans()[2]).toBeGreaterThan(1);
    // 回头的那一格就是被点住的那一格：它上一次已经带着 armed，新元素必须仍然带着
    expect(cls(2)).toContain("armed");
    expect(rows().length).toBe(3);
    expect(canReroll.mock.calls.length).toBeLessThanOrEqual(1);
    widths();
    canReroll.mockClear();

    // 落一刀开新一拍（上一句旁白已经把那一拍收了口）：只有新落的那一段该重画，armed 不许跑
    turn([{ kind: "beat", duration: 500 }]);
    rerender();
    expect(rows().length).toBe(4);
    expect(armed()).toBe(1);
    expect(cls(2)).toContain("armed");
    expect(spans()[3]).toBe(500);
    expect(canReroll.mock.calls.length).toBeLessThanOrEqual(1);
    widths();

    // 再点一次是放开
    act(() => rows()[2].querySelector<HTMLButtonElement>(".seg-roll")?.click());
    expect(armed()).toBe(0);
    expect(host.querySelector(".roll-bar")).toBe(null);
    act(() => root.unmount());
    host.remove();
  });

  it("价钱：那一条横滚的容器自己 —— 不动的一帧不许进去，跨拍那一帧也不进（F）", () => {
    /*
     * `segs` 与 `canReroll` 两把尺子都量不到"容器进门走了一遍"这一笔。容器不 memo 时：段元素一个也不会
     * 重做、`canReroll` 一次也不会响，可它仍然把那 n 格**走了一遍**（`railMeter.boxed`）。
     *
     * 这条测试**改过**，按仓库的规矩记下为什么：D 那一头它钉的是"不动帧不进、跨拍进一次"（那时跨拍
     * `take()` 见 `published=null` 把整条重新 slice，容器拿到新引用必进门）。F 把 `now` 从元素里搬到
     * store，跨拍那一份引用一个字不换、容器 memo 直接驳回 —— 于是"跨拍进一次"这一半钉的**正是 F 消掉的
     * 那一笔**，把它改成"跨拍也不进"。落一笔那一半是真脏（带子长了、那一份重新交），仍然进一次，不动。
     * 这里是**挂着的整棵树**，不是门：门那一头"跨拍不换引用"由上面那条"只换亮那一格、那一份一个字都不许
     * 多交"钉着，那一头看不见 React 走了几格；两把头各自有钉子，缺一个就会有一种错法静过去。
     */
    const h = new Harness();
    for (const b of tape(11, 5, 5)) h.lay(b);
    const beats = h.compiled.beats;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root: Root = createRoot(host);
    const canReroll = vi.fn(() => false);
    const teacher = { canReroll, rerollFrom: async () => {} } as never;
    const t = beats[1].start + 10;
    const render = () => act(() => root.render(createElement(BeatRail, { stage: h.stage, teacher, t })));
    render();
    expect(host.querySelectorAll(".seg").length).toBe(beats.length);
    canReroll.mockClear();

    // 什么都不动：容器一次都不许进（进了就是逐格走了 n 遍）
    const box = railMeter.boxed;
    const seg = railMeter.segs;
    const pub = railMeter.published;
    for (let i = 0; i < 20; i += 1) render();
    expect(railMeter.boxed - box).toBe(0);
    expect(railMeter.segs - seg).toBe(0);
    expect(railMeter.published - pub).toBe(0);
    expect(canReroll).not.toHaveBeenCalled();

    // 跨一拍：F 之后那一份引用不换、容器一次不进，段也一段不做 —— 亮只在 store 上翻，DOM 跟得上
    const box2 = railMeter.boxed;
    const seg2 = railMeter.segs;
    const pub2 = railMeter.published;
    act(() => root.render(createElement(BeatRail, { stage: h.stage, teacher, t: beats[2].start + 10 })));
    expect(railMeter.boxed - box2).toBe(0);
    expect(railMeter.segs - seg2).toBe(0);
    expect(railMeter.published - pub2).toBe(0);
    expect(host.querySelectorAll(".seg.now").length).toBe(1);
    // 落一笔：容器进一次（那一份真的换了引用），段只做新落的那几拍加回头那一格
    const box3 = railMeter.boxed;
    const seg3 = railMeter.segs;
    const before = h.compiled.beats.length;
    h.stage.log.nextTurn();
    // 两句旁白：第二句必定开新一拍（第一句把上一拍收了口）
    act(() => h.stage.append([{ kind: "narrate", text: "又一句", duration: 800 }, { kind: "narrate", text: "再一句", duration: 800 }], MAIN_TRACK));
    const grew = h.compiled.beats.length - before;
    act(() => root.render(createElement(BeatRail, { stage: h.stage, teacher, t: beats[2].start + 10 })));
    expect(grew).toBeGreaterThan(0);
    expect(railMeter.boxed - box3).toBe(1);
    expect(railMeter.segs - seg3).toBeLessThanOrEqual(grew + 1);
    act(() => root.unmount());
    host.remove();
  });

  it("价钱：被点住那一格在哪一格，是查那张表而不是走整条", () => {
    /*
     * `railMeter.segs` 与 `canReroll` 两把尺子都量不到这一笔：把那一问写成 `beats.findIndex(...)`
     * 不改任何印出来的值，一段也不会多做、一次也不会重画 —— 可它在**每一帧**都跑（重排bar 挂着时
     * 也是），走的就是整条拍表。这一件要消掉的正是"每一帧付一次整条"，所以这一问按仓库的旧规矩办
     * （`standing-tail.test.ts` 给道具表与流水各套过一层 Proxy）：给那条拍表套一层，只数**读了几格**。
     */
    const walk = (batches: number) => {
      const h = new Harness();
      for (const b of tape(9, batches, 6)) h.lay(b);
      const beats = h.compiled.beats;
      const armedSeq = beats[Math.floor(beats.length / 2)].seqs[0];
      let reads = 0;
      const spy = new Proxy(beats, {
        get(target, key, receiver) {
          // 只数**格子**：`length` 那些问的是这条数组有多长，不是走了哪一格
          if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      // 这本账挂在拍表本身（`cached` 的键），所以要问的只能是**一张新拍表**
      const compiled: Compiled = { ...h.compiled, beats: spy };
      const ask = (now: number, armed: number | undefined) => {
        reads = 0;
        segsFor(compiled, h.view, now, armed);
        return reads;
      };
      const cost = (now: number) => ask(now, armedSeq);
      const built = cost(0);
      // 每一问都从"上一问落地的状态"走：这一句不许在中间重建那本账
      const crossed = cost(1);
      const still = cost(1);
      const again = cost(2);
      const released = ask(2, undefined);
      const lit = cost(3);
      return { length: beats.length, built, crossed, still, again, released, lit };
    };
    const short = walk(30);
    const long = walk(1_200);
    /*
     * 实测（同一份探针，`tape(9, n, 6)`，格子被读的次数）：
     *
     * | 带子 | 拍表 | 建那一本（点住中格） | 跨一拍 | 不动的一帧 | 再跨一拍 | 放开 | 再点住别一格 |
     * | --- | --- | --- | --- | --- | --- | --- | --- |
     * | 10 批 | 16 格 | 25 | 3 | 1 | 3 | 2 | 4 |
     * | 30 批 | 34 格 | 52 | 3 | 1 | 3 | 2 | 4 |
     * | 300 批 | 303 格 | 455 | 3 | 1 | 3 | 2 | 4 |
     * | 1200 批 | 1200 格 | 1801 | 3 | 1 | 3 | 2 | 4 |
     *
     * 建那一本 = 拍表长度 + 被点住那一格的格子号 + 一两格（构造器里 `findIndex` 找那一格、`absorb` 逐格
     * 读一遍），跟着带子长，那是诚实的价钱。续排那五问恒定 3 / 1 / 3 / 2 / 4 而与长度无关：跨一拍读旧亮与
     * 新亮两格，外加 `grow` 问回头那一格那一读；什么都不动的一帧只剩那一读。改前那一头这几问全是整条
     * （`beats.map`），四十倍的带子就把这五问抬高四十倍。
     */
    // 参照那一头量得到东西：带子确实长了四十倍，而短的那一卷也不是一两格
    expect(short.length).toBeGreaterThan(20);
    expect(long.length).toBeGreaterThan(short.length * 10);
    // 整本重建付的是整条的钱（外加找被点住那一格），不许偷偷变成常数
    expect(short.built).toBeGreaterThanOrEqual(short.length);
    expect(long.built).toBeGreaterThanOrEqual(long.length);
    expect(long.built).toBeLessThanOrEqual(long.length * 2 + 2);
    // 四十倍的带子，续排那五问读的格子一格不多 —— 这一句才是"那一问不按长度走"
    for (const k of ["crossed", "still", "again", "released", "lit"] as const) {
      expect(long[k]).toBe(short[k]);
      expect(short[k]).toBeLessThanOrEqual(4);
    }
  });
});
