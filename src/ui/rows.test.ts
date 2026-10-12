import { describe, expect, it } from "vitest";
import { compile, perform, type Interpreter } from "../engine/compile";
import { MAIN_TRACK, OpLog } from "../engine/log";
import { describeOp, rowsFor, rowsMeter } from "./rows";
import type { Compiled, Op, OpEntry } from "../engine/types";

/*
 * 这一节测的是**观众那一头落一笔的价钱**。前面几件把带子那一头做成"落一笔只付那一截"（解释器、
 * `TapeIndex`、`StandingIndex` 三本账），可日志面板仍然每批把整卷重排一遍：`useMemo` 的依赖是那份
 * `Compiled` 记录，而它每批都是新对象 —— 会长大的那几张容器在**里面**。
 *
 * 量出来的形状（jsdom + React act，同一台机器各取三遍最小值）：30 批 / 660 行合计 922ms，
 * 240 批 / 5280 行合计 48233ms —— 批数翻一倍、合计翻四倍，和 `compile` 改前同一个形状，只是这一头
 * 付在 React 元素上。
 *
 * 价钱那一层不量毫秒，数的是**这一层做了几行**（`describeOp` 门口那个计数器，元素只能从它出来）：
 * 共享 CI 的噪声比省下来的那些毫秒大，而"这一行被重做过"就是它付过的指纹。参照是旧写法那句
 * "拿整张卡表现建一遍映射，把整卷带子重排一遍"，两边走的是同一个 `describeOp` —— 这一件改的是
 * **哪些格子被重排**，不是**一行印什么**，所以共用那一句不是自说自话。
 */

/** 改前那份读法：每批拿整张卡表现建映射，整卷重排一遍。 */
function legacyRows(compiled: Compiled, tape: readonly OpEntry[]) {
  const bySeq = new Map(compiled.gates.map((g) => [g.seq, g]));
  return tape.map((e) => describeOp(e, bySeq));
}

/** 一行元素的三格。`key` 不在 props 里（React 把它拿走了），只能从元素本身问。 */
type RowProps = { className: string; children: [{ props: { children: number } }, { props: { children: string } }] };

/** 元素里那三样对外说事实的东西。 */
function rowOf(el: React.ReactElement): { key: number; cls: string; text: string } {
  const p = el.props as unknown as RowProps;
  return { key: Number(el.key), cls: p.className, text: p.children[1].props.children };
}

function sameRows(rows: readonly React.ReactElement[], ref: { key: number; cls: string; text: string }[]) {
  expect(rows.length).toBe(ref.length);
  for (let i = 0; i < ref.length; i += 1) {
    const got = rowOf(rows[i] as React.ReactElement);
    expect(got.key).toBe(ref[i].key);
    expect(got.cls).toBe(ref[i].cls);
    expect(got.text).toBe(ref[i].text);
  }
}

/** 旧写法在**这一刻**该给出的那些行（参照不许复用任何缓存）。 */
function reference(compiled: Compiled, tape: readonly OpEntry[]) {
  const texts = legacyRows(compiled, tape);
  return tape.map((e, i) => ({ key: e.seq, cls: e.track === MAIN_TRACK ? "row" : "row aside", text: texts[i] }));
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

/**
 * 一卷随机带子，分成 `batches` 批、每批 `per` 格。两条规矩：
 *  - 不许每批收尾于旁白（`landed.test.ts` 立的那条教训在这里同样：批内那一句会挡住身后的视线）
 *  - `answer` 指的题卡可能在**身后某一批**里，也可能**这一批还没有那一刀**（别人上的一卷带子就是这个
 *    形状：`restore` 按号排，答在问之前是合法的）。旧写法每批拿整张卡表排整卷，那一行会在卡落下的
 *    那一批被重做一次、指到那道题 —— 续排不许丢这个答案，所以它单独钉了一条。
 */
function tape(seed: number, batches: number, per: number): Op[][] {
  const r = rnd(seed);
  const out: Op[][] = [];
  /** 已经落了几格，用来把"下一张卡的号"算出来；答在问之前就指这个还没落下来的号。 */
  let landed = 0;
  let quizAt = -1;
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
          batch.push({ kind: "camera", mode: "pan", dir: r() < 0.5 ? "right" : "down", screens: 0.8, duration: 600, easing: "ease" });
          break;
        case "highlight":
          batch.push({ kind: "highlight", target: `vec-${Math.floor(r() * 4)}`, style: "pulse", duration: 500 });
          break;
        case "quiz":
          quizAt = landed;
          batch.push({ kind: "quiz", prompt: `第 ${b}-${i} 题？`, options: ["甲", "乙"], answer: 0 });
          break;
        case "answer": {
          // 一半指已经落下的那张，一半指还没落下的那一张（号能算出来：它就在身后第几张的位置）
          const ahead = r() < 0.5 && quizAt < 0;
          batch.push({ kind: "answer", gate: ahead ? landed + 1 : Math.max(0, landed - 1 - Math.floor(r() * 3)), text: "甲" });
          break;
        }
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
    // 每批不许收尾于旁白：随机里偶尔会，那就换一刀静默收尾
    const last = batch[batch.length - 1];
    if (last && last.kind === "narrate") batch[batch.length - 1] = { kind: "beat", duration: 200 };
    out.push(batch);
  }
  return out;
}

/**
 * 一台机器 + 一本账，跟着同一卷带子活 —— 和 `runtime.ts` 里 `Stage.recompile` 同一句读法。
 * 每批现 `compile(log.all())` 会换一张 `gates`，那一头每一批都是"换了台面"，钉不出这一件。
 */
class Harness {
  log = new OpLog();
  private it: Interpreter | null = null;
  private compiled: Compiled = compile([]);

  lay(batch: Op[], track = MAIN_TRACK) {
    this.log.append(batch, track);
    const next = perform(this.it, this.log.ofTrack(MAIN_TRACK));
    this.it = next.it;
    this.compiled = next.compiled;
    return this.compiled;
  }

  rows() {
    return rowsFor(this.compiled, this.log.tape);
  }

  get state() {
    return this.compiled;
  }
}

describe("rows：已经排好的那一截不许每批再排一遍", () => {
  it("形状：逐批续排与整卷重排逐行同解（一百卷随机带子 × 八批）", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const h = new Harness();
      for (const batch of tape(seed, 8, 6)) {
        const compiled = h.lay(batch);
        sameRows(h.rows(), reference(compiled, h.log.tape));
      }
    }
  });

  it("形状：答在问之前那一行，等那道题进账时仍然指到它", () => {
    const h = new Harness();
    h.lay([{ kind: "answer", gate: 1, text: "甲" }]);
    let rows = h.rows().map(rowOf);
    expect(rows[0].text).toBe("他答：「甲」");
    h.lay([{ kind: "quiz", prompt: "先答后问？", options: ["甲", "乙"], answer: 0 }]);
    rows = h.rows().map(rowOf);
    expect(rows[0].text).toContain("先答后问");
    sameRows(h.rows(), reference(h.state, h.log.tape));
  });

  it("护栏：同一卷带子反复问，第一次之后一个字也不许多做", () => {
    const h = new Harness();
    h.lay([{ kind: "narrate", text: "一句", duration: 1000 }]);
    h.rows();
    const before = rowsMeter.described;
    for (let i = 0; i < 20; i += 1) h.rows();
    expect(rowsMeter.described - before).toBe(0);
  });

  it("价钱：落一批只排新落的那几行", () => {
    const h = new Harness();
    const lay = (ops: Op[]) => {
      h.lay(ops);
      const before = rowsMeter.described;
      h.rows();
      return rowsMeter.described - before;
    };
    expect(lay([{ kind: "narrate", text: "一", duration: 100 }])).toBe(1);
    expect(lay([{ kind: "narrate", text: "二", duration: 100 }, { kind: "beat", duration: 10 }])).toBe(2);
    expect(lay(Array.from({ length: 37 }, (_, i) => ({ kind: "narrate", text: `x${i}`, duration: 100 }) as Op))).toBe(37);
  });

  it("价钱：带子长四十倍，本批那一刀的价钱一格不许多", () => {
    /*
     * 比的是**每一批**做的行数，不是合计 —— 合计当然跟着带子长（那是线性，正是要的形状）。
     * 旧写法那一头第 b 批排的是 `b × per` 行，所以四十倍长的带子会把"最贵的那一批"抬高四十倍；
     * 现在每一批只许吸收自己那一截，加上"答在问之前"那几行回头补的那一次，两者都与带子长度无关。
     */
    const per = 12;
    for (const batches of [60, 2400]) {
      const h = new Harness();
      const work: number[] = [];
      for (const b of tape(7, batches, per)) {
        h.lay(b);
        const before = rowsMeter.described;
        h.rows();
        work.push(rowsMeter.described - before);
      }
      const worst = Math.max(...work);
      const total = work.reduce((a, x) => a + x, 0);
      // 一批最多两个 per：新落的 per 行，加上这一批里落下的那些卡回头补的那几行（每行最多补一次）。
      expect(worst).toBeLessThanOrEqual(2 * per);
      // 合计不许越过线性：四十倍长就四十倍行数，多一个 per 都不许。
      expect(total).toBeLessThanOrEqual(batches * per + per);
    }
  });

  it("价钱：带子换卷那一条付的是整卷的钱（不许偷偷变成常数）", () => {
    const h = new Harness();
    h.lay(Array.from({ length: 50 }, (_, i) => ({ kind: "narrate", text: `x${i}`, duration: 100 }) as Op));
    h.rows();
    const before = rowsMeter.described;
    h.log.cutFrom(25);
    rowsFor(compile(h.log.all()), h.log.tape);
    expect(rowsMeter.described - before).toBe(25);
  });

  it("价钱：带子没动的帧不许重新交那一份，动了的帧交出去的就是带子的长度", () => {
    /*
     * 这一条钉的是这一件**没有消掉**的那一笔：React 认子数组的引用，所以长过尾巴之后那一份必须重新
     * 抄。抄一次是 O(带子) 的指针活，一帧都不许多付 —— 时钟一秒走六十帧，那一头一次都不许抄。
     */
    const h = new Harness();
    h.lay(Array.from({ length: 40 }, (_, i) => ({ kind: "narrate", text: `x${i}`, duration: 100 }) as Op));
    const first = h.rows();
    const at = rowsMeter.published;
    for (let i = 0; i < 30; i += 1) expect(h.rows()).toBe(first);
    expect(rowsMeter.published - at).toBe(0);
    // 落一刀：交出去的必须是一个新引用，长度等于带子。老的引用不许再交出去（React 会整棵当没变）。
    h.lay([{ kind: "beat", duration: 500 }]);
    const next = h.rows();
    expect(next).not.toBe(first);
    expect(next.length).toBe(h.log.tape.length);
    expect(rowsMeter.published - at).toBe(h.log.tape.length);
    // 抄的那一份里每一格仍是同一个元素引用 —— 跳过的仍然是逐棵子树。
    expect(next[0]).toBe(first[0]);
    expect(next[39]).toBe(first[39]);
  });

  it("护栏：一次建完与逐批续排逐行同解", () => {
    const batches = tape(3, 6, 7);
    const once = new Harness();
    const all = once.lay(batches.flat());
    const at = rowsMeter.described;
    const made = once.rows();
    expect(rowsMeter.described - at).toBe(once.log.tape.length);
    const each = new Harness();
    let last: Compiled = all;
    for (const b of batches) last = each.lay(b);
    sameRows(made, reference(all, once.log.tape));
    sameRows(each.rows(), reference(last, each.log.tape));
  });

  it("护栏：内容相同、换了数组必须整卷重排", () => {
    const h = new Harness();
    h.lay([{ kind: "narrate", text: "一句", duration: 100 }]);
    const first = h.rows();
    const copy = [...h.log.tape];
    const before = rowsMeter.described;
    const again = rowsFor(compile(copy), copy);
    expect(rowsMeter.described - before).toBe(copy.length);
    expect(again).not.toBe(first);
  });

  it("护栏：只换卡表也必须整卷重排", () => {
    const h = new Harness();
    h.lay([{ kind: "quiz", prompt: "合力多大？", options: ["5N", "7N"], answer: 0 }]);
    const held = h.state;
    h.rows();
    // 另一台机器（插播那一头是另一张 gates）的另一份记录，内容一样
    const other = compile(h.log.all());
    expect(other.gates).not.toBe(held.gates);
    const before = rowsMeter.described;
    rowsFor(other, h.log.tape);
    expect(rowsMeter.described - before).toBe(h.log.tape.length);
  });

  it("护栏：他答的那一行仍然认得问题是谁问的", () => {
    const h = new Harness();
    h.lay([
      { kind: "quiz", prompt: "合力多大？", options: ["5N", "7N"], answer: 0 },
      { kind: "narrate", text: "等他答完", duration: 1000 },
      { kind: "answer", gate: 0, text: "5N" },
      { kind: "answer", gate: 7, text: "随口一句" },
    ]);
    const rows = h.rows().map(rowOf);
    expect(rows[2].text).toContain("他答：「5N」");
    expect(rows[2].text).toContain("合力多大");
    expect(rows[3].text).toBe("他答：「随口一句」");
  });

  it("护栏：被身后那一笔回填的字段不许改已经排好的那一行", () => {
    const h = new Harness();
    h.lay([
      { kind: "quiz", prompt: "合力多大？", options: ["5N", "7N"], answer: 0 },
      { kind: "narrate", text: "等他答完", duration: 1000 },
    ]);
    const before = h.rows().map(rowOf);
    expect(before[0].text).toBe("提问：合力多大？");
    const first = h.rows()[0];
    h.lay([{ kind: "answer", gate: 0, text: "5N" }]);
    const after = h.rows().map(rowOf);
    // 同一张卡从 null 换成一句话，那一行一个字也不许改，元素还是同一个对象
    expect(h.rows()[0]).toBe(first);
    expect(after[0].text).toBe(before[0].text);
    expect(h.state.gates[0].said).toBe("5N");
  });

  it("护栏：插播的行仍然排在带子上它自己那一格的位置", () => {
    const h = new Harness();
    h.lay([{ kind: "narrate", text: "课上", duration: 1000 }]);
    // 插播落在他轨上：主轨那一卷一个字没动，可观众那一头排的是**跨轨道**的那一卷。
    // `lay` 里那次 `perform` 因此只演零格，交回来的还是同一张卡表 —— 续排必须接得上。
    h.lay([{ kind: "narrate", text: "插一句", duration: 1000 }], "aside:1");
    const rows = h.rows().map(rowOf);
    expect(rows.map((x) => x.cls)).toEqual(["row", "row aside"]);
    expect(rows[1].text).toContain("插一句");
  });
});
