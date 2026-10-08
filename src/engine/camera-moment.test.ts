import { describe, expect, it } from "vitest";
import { compile, cueMs, onstageAt, ownsTime, standingAt } from "./compile";
import { inkBox } from "./ink";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import type { Box, Compiled, Cue, Op, OpEntry, Revision } from "./types";

/*
 * 这一节钉的是「镜头也终于读它自己那一刻」。
 *
 * 上一件把一次外观变成一段窗口 `[t, off)`，给了每帧四个读者，可它没有管镜头：解释器算落点时读的是
 * `revisions[length - 1]` 那一格 —— 带子尽头那一格，连收没收笔都不看，板还按 `prop.scene`（道具最后
 * 被挪去了哪）分组。同一卷带子上因此有两种说法：`visibleName` 说观众已经看不见这件东西，镜头却还按它
 * 的地皮走，于是 `blindCamera` 那句"画面这一拍不会动"是谎话；而倒带回到撤下之前的人看见一个比台上那
 * 点东西大得多的画面。这里把镜头接到它自己的那一刻上，同时把代价从"这堂课一共有过几样"降到"此刻站在
 * 这块板上有几样"。
 *
 * 三件事分开钉，因为它们各自会坏（和 `standing.test.ts` 同一个次序）。这一节整节在改前的代码上跑过
 * 一遍（`main` 那一格），10 条红：形状 6 条、价钱 3 条、对账 1 条；其余 8 条改前就是绿的，它们是
 * **护栏** —— 存在的意义是这一件不许修过头（东西还在的时候镜头照样得走过去，回到一块板照样得把它上面
 * 压着的那些一起框住）。数字抄在旁边，都是同一台机器上量出来的。
 *  1. **答案的形状**：几条具体的错法 —— `focus`/`track` 站到一个已经撤下的名字上、点一块被幕布压住的
 *     板、`discard` 落在 `track` 中途以后还在推它、后一刀把前一刀的落点改写、缓存慢一拍。
 *  2. **价钱**：点名一块板的镜头以前每点一次把整张道具表走一遍 —— 而"板名可以当镜头目标"是写在
 *     `camera` 的说明里的用法，所以那是生产路径，不是边角。这一头的账在解释器自己造的表上，Proxy 套
 *     不到，所以钉的是**对照**：同一卷带子加不加那一刀点名，同一台机器各量一次。
 *  3. **对账**：随机带子上，镜头的落点和"从头把带子再读一遍、一个缓存都不许用"那份朴素读法逐条相等。
 */

const at = (x: number, y = 0): Box => ({ x, y, w: 200, h: 160 });
const art = (id: string, extra: Partial<Op> = {}): Op =>
  ({ kind: "build", id, box: at(0), label: id, html: `<p>${id}</p>`, ...extra } as Op);
const line = (text: string, duration = 1000): Op => ({ kind: "narrate", text, duration });
const drop = (id: string): Op => ({ kind: "discard", id });
const back = (id: string, scene?: string): Op => ({ kind: "recall", id, scene, box: at(600) }) as Op;
const cut = (to: string, duration = 1200): Op => ({ kind: "transition", style: "dissolve", to, duration });
const shot = (mode: string, extra: Partial<Op> = {}, duration = 800): Op =>
  ({ kind: "camera", mode, duration, easing: "linear", ...extra } as Op);
const inked = (id: string): Op =>
  ({ kind: "patch", id, svg: '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>' }) as Op;

const tape = (...ops: Op[]): OpEntry[] => ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op }));
const show = (...ops: Op[]): Stage => {
  const s = new Stage();
  s.load(tape(...ops));
  return s;
};
const cams = (c: Compiled): Cue[] => c.cues.filter((x) => x.op.kind === "camera");
const rectAt = (s: Stage, t: number): Box => {
  s.seek(t);
  return s.getSnapshot().rect;
};

describe("镜头读自己那一刻：答案的形状", () => {
  it("点一个已经撤下的道具名，那一刀不许动", () => {
    // 改前实测 {x:5875, y:-46.5625, w:450, h:253.125} —— 镜头整帧站到一件观众早就看不见的东西上（它在
    // x=6000），而同一轮里 `blindCamera` 说的恰恰是"观众看不见它，画面这一拍不会动"（`visibleName`
    // 当场就是 `false`）。修后：没有目标，镜头留在自己脚下。
    const s = show(art("远", { box: at(6000) }), line("一"), drop("远"), line("二"), shot("focus", { target: "远" }));
    const cam = cams(s.compiled)[0];
    expect(s.visibleName("远", cam.t)).toBe(false);
    expect(cam.to).toEqual(cam.from);
  });

  it("撤走的东西不许再把一板的地皮撑大（镜头点板名的那条路）", () => {
    // 板上一个名字都不站着了，镜头于是留在原地，只是把没框到的那一圈放大一点。
    // 这一条改前也是绿的（`sceneBox` 会跳过"到带子尽头还站着"那一问）：它钉的是新写法不许把自己脚下
    // 那块空板量出一格地皮 —— 上一件给的是窗口，这一件得让镜头也按窗口答"这块板空了"。
    const s = show(art("远", { box: at(6000) }), line("一"), drop("远"), line("二"), shot("fit", { target: "default" }));
    const cam = cams(s.compiled)[0];
    expect(s.visibleName("远", cam.t)).toBe(false);
    expect(cam.to).toEqual({ x: -160, y: -90, w: 1920, h: 1080 });
    expect(cam.to.x + cam.to.w).toBeLessThan(6000);
  });

  it("还站着的时候，板名那一条不许变：量到的就是那块板上的东西", () => {
    // 上面那条省了钱、也省了画面，所以这一条钉住它不许过头：东西还在，镜头就该站到它那里去。
    // 改前改后同一个数 —— 这条是护栏。
    const s = show(art("远", { box: at(6000) }), line("一"), shot("fit", { target: "default" }));
    expect(cams(s.compiled)[0].to).toEqual({ x: 5875, y: -46.5625, w: 450, h: 253.125 });
  });

  it("道具被挪到别的板以后，换板之前那一刻的旧板仍然量得到它", () => {
    // 改前改后都是 {x:-125,...}：那一拍旧板上确实还站着东西。这条钉的是新写法**不许**把"按那一刻落在
    // 哪块板分"修成"按道具最后被挪去了哪分"的反面 —— 旧写法在这里靠 `prop.scene` 恰好答对，而它下一刀
    // 就答错（见下面那条被幕布压住的板），同一条规则不能时对时错。
    const s = show(art("a", { scene: "甲" }), line("一"), shot("fit", { target: "甲" }), line("一点五"), art("a", { scene: "乙", box: at(9000) }), line("二"));
    const cam = cams(s.compiled)[0];
    expect(s.visibleName("甲", cam.t)).toBe(true);
    expect(cam.to).toEqual({ x: -125, y: -46.5625, w: 450, h: 253.125 });
  });

  it("跟读一个观众看不见的名字，那一刀不许把画面滑走", () => {
    // 改前实测 to = {x:4300, y:-370, w:1600, h:900}（from 是 {x:0,...}）：名字还认得出盒子，于是画面
    // 朝一件不在台上的东西滑过去 3.5 屏。
    const s = show(art("p", { box: at(5000) }), line("一"), drop("p"), line("二"), shot("track", { follow: "p" }));
    const cam = cams(s.compiled)[0];
    expect(s.visibleName("p", cam.t)).toBe(false);
    expect(cam.to).toEqual(cam.from);
  });

  it("幕布压住的那块板，镜头点它的名就是不动（观众看不见它）", () => {
    // 换场之后 `甲` 上的东西被扫走了：观众眼前没有这块板。改前实测 to = {x:-125, y:-46.5625, w:450,
    // h:253.125} —— 镜头从 {x:2400,...} 飞到那块被压住的板上去捡，而 `visibleName("甲")` 当场就是
    // `false`。那正是导演最容易写错的一刀（他记得自己摆过东西），也是 `blindCamera` 要说清楚的那一句。
    const s = show(art("a", { scene: "甲", box: at(0) }), cut("乙"), line("在乙"), shot("fit", { target: "甲" }), line("二"));
    const cam = cams(s.compiled)[0];
    expect(s.visibleName("甲", cam.t)).toBe(false);
    // 站着的那块板上没有东西可量，于是落点留在镜头自己脚下的那一片。
    expect(cam.to.x).toBeGreaterThan(2000);
    expect(cam.to).toEqual({ x: 2240, y: -90, w: 1920, h: 1080 });
  });

  it("一块板上有几样被压住，也不许漏成「只并第一格」", () => {
    // 改前实测 to = {x:-110, y:-291.25, w:1320, h:742.5}：那一刀整帧框在被压住的 `甲` 上（它并了甲上
    // 两格，x=0..1100）。新写法对那块板一个都不量 —— 上面那条只有 1 格，这一条 2 格，"漏掉第 2 格"和
    // "漏掉整块板"是两种坏法。
    const s = show(art("x", { scene: "甲", box: at(0) }), art("y", { scene: "甲", box: at(900) }), cut("乙"), line("在乙"), shot("fit", { target: "甲" }), line("二"));
    const cam = cams(s.compiled)[0];
    expect(s.visibleName("甲", cam.t)).toBe(false);
    expect(cam.to).toEqual({ x: 2240, y: -90, w: 1920, h: 1080 });
  });

  it("回到一块板：落点要把幕布压着的那些一起框住", () => {
    // 这是另一半，不许顺手"修一致"：`swept` 说的是观众此刻看不见它，而换场的**落点**是将要给观众看
    // 这块板 —— 幕布一抬那些东西就又回到眼前，站着不动才是要命的那件事。改前改后同一个数。
    const s = show(art("a", { scene: "甲", box: at(0) }), cut("乙"), art("b", { scene: "乙", box: at(400) }), cut("甲"), line("回来"));
    const c = s.compiled;
    s.seek(c.duration - 1000);
    expect(s.visibleName("a", c.duration - 1000)).toBe(true);
    const back2 = c.cues.filter((x) => x.op.kind === "transition")[1];
    expect(back2.to.x + back2.to.w / 2).toBeCloseTo(100, 6);
    expect(back2.to.x + back2.to.w).toBeLessThan(400);
  });

  it("后面那一刀 discard 不许改写前面那一刀的落点", () => {
    // 落点是带子上的**历史**：这一拍镜头站着的时候东西还在，那一刀是下一拍的事 —— 而导演是一拍一拍
    // 追加带子的，所以这一条必须在"重解整卷"之后仍然成立。
    const s = show(art("旧", { box: at(6000, -3000) }), line("一"), shot("fit", { target: "旧" }));
    const before = cams(s.compiled)[0].to;
    s.append([line("一点五"), drop("旧"), line("二")], MAIN_TRACK);
    const cam = cams(s.compiled)[0];
    expect(cam.to).toEqual(before);
    expect(cam.to).toEqual({ x: 5875, y: -3046.5625, w: 450, h: 253.125 });
    const off = s.compiled.props.get("旧")!.revisions[0].off!;
    expect(s.visibleName("旧", cam.t)).toBe(true);
    // 左闭右开：收笔那一刻起观众两头一起改口，而镜头那一刀早已是历史。
    expect(s.visibleName("旧", off - 1)).toBe(true);
    expect(s.visibleName("旧", off)).toBe(false);
  });

  it("跟读的镜头不许在道具撤下之后继续推它", () => {
    // 带子里 `discard` 落在 `track` 滑动的中途是常事：overlay 不占时钟，下一句可以紧跟着一刀落。
    // 落点是历史（那一拍确实看见过它，所以不许改），但**推**不许跟着追 —— 往一件刚消失的东西的方向
    // 一直滑，看上去就是镜头还在找它，而名单里早就没有它了。
    const s = show(
      art("p", { box: at(5000) }),
      line("一"),
      shot("track", { follow: "p" }, 6000),
      { kind: "motion", id: "p", mode: "oscillate", axis: "x", amp: 300, period: 1000, duration: 9000 } as Op,
      line("二"),
      drop("p"),
      line("三"),
    );
    const cam = cams(s.compiled)[0];
    expect(s.visibleName("p", cam.end + 200)).toBe(false);
    expect(rectAt(s, cam.end + 200)).toEqual(cam.to);
    expect(rectAt(s, cam.end + 3000)).toEqual(cam.to);
    // 探针不是空转：撤下之前那一帧确实还在跟着推，画面停在落点之外。
    expect(s.visibleName("p", cam.t + 500)).toBe(true);
    expect(rectAt(s, cam.t + 500)).not.toEqual(cam.to);
  });

  it("窗口边缘那一毫秒：落点是历史，后一刀读的是现在，缓存不许慢一拍", () => {
    // 同一条带子上两刀镜头，中间隔着一刀 `discard`。第一刀的落点不许被第二刀改写（那是历史），
    // 第二刀不许还站在撤走的那一格上（那是缓存慢一拍）。`off` 那一刻就是两边一起改口的地方。
    const s = show(art("a", { box: at(3000) }), line("一"), shot("fit", { target: "a" }), line("二"), drop("a"), shot("fit", { target: "a" }), line("三"));
    const c = s.compiled;
    const rev = c.props.get("a")!.revisions[0];
    const off = rev.off!;
    expect(onstageAt(rev, off - 1)).toBe(true);
    expect(onstageAt(rev, off)).toBe(false);
    const [first, second] = cams(c);
    expect(first.to).toEqual({ x: 2875, y: -46.5625, w: 450, h: 253.125 });
    expect(s.visibleName("a", off)).toBe(false);
    // 第二刀点的是同一个已经不在眼前的名字：中心一步不许走，只是把没框到的那圈放大一点。
    expect(second.to.w).toBeGreaterThan(first.to.w);
    expect(second.to.x + second.to.w / 2).toBeCloseTo(first.to.x + first.to.w / 2, 6);
    expect(second.to.y + second.to.h / 2).toBeCloseTo(first.to.y + first.to.h / 2, 6);
    // 第一刀站着的那一拍画面确实到了那里（滑完之后）。
    s.seek(first.end);
    expect(s.getSnapshot().rect).toEqual(first.to);
  });

  it("迟到的补画落在撤下之后，不许让那块板又多出一格地皮", () => {
    // `patch` 是给已经站在台上的东西交图，不是把它带回台上。迟到的那一笔落在一段**已经收掉**的窗口
    // 里：图没有丢（它就在这段窗口里，`recall` 带的正是它），可观众眼前没有多出一格 —— 镜头脚下也
    // 不许多算一格，否则美工迟到的那一笔会把导演已经撤走的东西又请回画面里。
    const s = show(art("a", { scene: "甲", box: at(4000) }), line("一"), drop("a"), line("二"), inked("a"), shot("fit", { target: "甲" }));
    const c = s.compiled;
    const revs = c.props.get("a")!.revisions;
    expect(revs[0].off).toBeDefined();
    expect(revs[1].t).toBe(2000);
    expect(revs[1].off).toBe(revs[0].off);
    expect(standingAt(revs, c.duration)).toBeUndefined();
    const cam = cams(c)[0];
    expect(s.visibleName("甲", cam.t)).toBe(false);
    // 没有目标就不许动到那一格上去：落点只是脚下这一片放大一点。
    expect(cam.to.x + cam.to.w).toBeLessThan(4000);
  });
});

describe("镜头的价钱：一次点名不许走整张道具表", () => {
  const entries = (n: number, mk: (i: number) => Op[]): OpEntry[] => {
    const ops: Op[] = [];
    for (let i = 0; i < n; i++) ops.push(...mk(i));
    return ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op }));
  };

  /** 取三次的最小值：GC 和别人的标签页只会让一次测量变慢，不会让它变快。 */
  const best = (list: OpEntry[]): number => {
    let out = Infinity;
    for (let k = 0; k < 3; k++) {
      const started = performance.now();
      compile(list);
      out = Math.min(out, performance.now() - started);
    }
    return out;
  };

  /**
   * 每一拍：落一格道具、点一次它所在那块板的名 —— `camera` 的说明里写着的用法。`plain` 是同一条带子
   * 把那一刀点名去掉：两边落笔、旁白、道具数完全一样，差的只有点名。
   */
  const named = (i: number): Op[] => [art(`p${i}`, { scene: `板${i % 8}`, box: at((i % 8) * 600) }), shot("fit", { target: `板${i % 8}` }), line(`第 ${i} 句`, 400)];
  const plain = (i: number): Op[] => [art(`p${i}`, { scene: `板${i % 8}`, box: at((i % 8) * 600) }), line(`第 ${i} 句`, 400)];

  it("点名那一刀的钱，不许比整卷带子的其余部分还贵", () => {
    // 同一卷 12000 拍的带子，加不加那一刀点名。改前实测（同一台机器两次独立跑，各取三次最小值）
    // 1073ms / 1089ms 对 23.2ms / 21.2ms —— 点名这件工具贵过带子其余部分约 49 倍（每一刀把整张道具表
    // 走一遍，于是"一次点名"乘上"一共有过几样"）。改后同一批带子 33.2ms 对 20.3ms：点名那一刀和一句
    // 旁白一个量级。这条不看倍率，看的是同一台机器同一卷带子的对照，所以噪声不会替它说话。
    const list12 = entries(12000, named);
    const listPlain = entries(12000, plain);
    const withNames = best(list12);
    const without = best(listPlain);
    expect(without).toBeGreaterThan(1);
    expect(withNames / without).toBeLessThan(3);
    // 答案不许因为省钱而变：点名仍然认得到那块板，也确实把画面挪了过去。
    const cam = cams(compile(entries(200, named)))[0];
    expect(cam.to).not.toEqual(cam.from);
  });

  it("带子长 4 倍，价钱不许翻到 16 倍：摊在 8 块板上和堆在 1 块板上都要过", () => {
    // 二次的那笔账有两种付法，所以两条都量。改前实测（同一台机器两次独立跑）：每拍点到一块板的那条
    // 50.4ms → 1073ms（倍率 21.3，第二次 61.3 → 1089 = 17.8），全部堆在同一块板上的那条 23.5ms →
    // 460.8ms（倍率 19.6 —— 那一头上"这块板上有几样"也在价钱里）。改后同一批带子分别 20.3ms → 33.2ms
    // （1.6）与 1.9ms → 6.1ms（3.3）：摊在 8 块板上时点名那一头几乎不再随带子长，堆在一块板上时长的
    // 是"这块板上有几样"那一项。给 12 倍天花板 —— 二次的那两条各自实测 17 倍以上。
    const pile = (i: number): Op[] => [art(`p${i}`, { scene: "板1", box: at((i % 64) * 120) }), shot("fit", { target: "板1" }), line(`句 ${i}`, 400)];
    const a = best(entries(3000, named));
    const b = best(entries(12000, named));
    expect(b / a).toBeLessThan(12);
    const c = best(entries(1000, pile));
    const d = best(entries(4000, pile));
    expect(c).toBeGreaterThan(0.5);
    expect(d / c).toBeLessThan(12);
  });

  it("导演逐拍追加付的那一笔：点名那条不许比不点名那条贵过 3 倍", () => {
    // 导演是一笔一笔往带子上加的，而 `log.append` 每来一笔把整条带重解一遍 —— 这才是他在台上付的钱。
    // 改前实测（同一台机器两次独立跑）：3000 拍的带子上追加 20 拍，带点名的那条 1017ms / 1079ms，不带
    // 点名的 113ms / 117ms（约 9 倍 —— 每拍重解都在按点名次数 × 道具总数付钱）。改后同一批带子分别
    // 155ms 与 117ms，比值 1.3。
    const appendCost = (mk: (i: number) => Op[]): number => {
      let out = Infinity;
      for (let k = 0; k < 3; k++) {
        const s = new Stage();
        s.load(entries(3000, mk));
        const started = performance.now();
        for (let i = 3000; i < 3020; i++) s.append(mk(i), MAIN_TRACK);
        out = Math.min(out, performance.now() - started);
      }
      return out;
    };
    const withNames = appendCost(named);
    const without = appendCost(plain);
    expect(without).toBeGreaterThan(1);
    expect(withNames / without).toBeLessThan(3);
    // 追加完的那卷带子，最后一刀点名仍然站到它那块板上 —— 省下来的钱不许是答案。
    const s = new Stage();
    s.load(entries(50, named));
    s.append(named(50), MAIN_TRACK);
    const last = cams(s.compiled).pop()!;
    expect(last.to).not.toEqual(last.from);
    expect(s.visibleName(`板${50 % 8}`, last.t)).toBe(true);
  });
});

/**
 * 对账那份朴素读法：从头把带子再走一遍，一格一格记下"这块板上站着什么"，一个缓存都不许用。
 *
 * 它问的是**带子上的位置**而不是时刻 —— 同一毫秒里可以既有落笔又有一刀镜头（overlay 不占时钟），
 * 谁先谁后由带子的次序定，而那正是解释器手上的东西。按时刻读的那一份在这种带子上会慢半拍，那种慢是
 * 参照自己的错，不是这一件要钉的事。所以参照走到"这一格带子"就停，落笔、撤下、换板全按位置记。
 */
describe("镜头那一刻的答案和朴素读法逐条对账", () => {
  /** 一条会动的 `Math.imul` 线性同余：CI 上每跑必须同一批带子，坏掉的落点要能复现。 */
  const rng = (seed: number) => {
    let x = seed | 0;
    return () => {
      x = Math.imul(x ^ (x >>> 15), 2246822507) ^ Math.imul(x ^ (x >>> 13), 3266489909);
      return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
    };
  };

  const BOARDS = ["甲", "乙", "丙"];

  /** 一批会踩到全部形状的带子：落笔、撤下、recall、换板、换场、镜头（道具名和板名都点）、迟到补画。 */
  const randomTape = (seed: number): Op[] => {
    const r = rng(seed);
    const ops: Op[] = [];
    const n = 14 + Math.floor(r() * 40);
    for (let i = 0; i < n; i++) {
      const id = `p${Math.floor(r() * 5)}`;
      const board = BOARDS[Math.floor(r() * BOARDS.length)];
      const pick = r();
      // 不带 `here`：那一格的盒子由镜头自己摆出来的，不是带子上的数 —— 参照要么抄编译结果（就成了
      // 自证），要么算错。`here` 落在哪由 `stage.test.ts` 钉，这一头只管"谁站着、站在哪块板"。
      if (pick < 0.3) ops.push(art(id, { scene: r() < 0.5 ? board : undefined, box: at(Math.floor(r() * 8) * 300, Math.floor(r() * 5) * 200 - 400) }));
      else if (pick < 0.36) ops.push(inked(id));
      else if (pick < 0.46) ops.push(drop(id));
      else if (pick < 0.54) ops.push(back(id, r() < 0.5 ? board : undefined));
      else if (pick < 0.74) {
        const mode = r();
        const cam =
          mode < 0.3
            ? shot("fit", { target: r() < 0.5 ? id : board })
            : mode < 0.55
              ? shot("focus", { target: r() < 0.5 ? id : board })
              : mode < 0.75
                ? shot("pan", { dir: "right", screens: 0.5 })
                : shot("track", { follow: id });
        ops.push(cam, line(`镜头之后 ${i}`, 300));
      } else if (pick < 0.85) ops.push(cut(board, 400 + Math.floor(r() * 1200)));
      else ops.push(line(`句 ${i}`, 300 + Math.floor(r() * 900)));
    }
    return ops;
  };

  /** 参照手上的台：id → 此刻站着的那一格，外加走到哪一块板、最近那一刀。 */
  interface Ref {
    byId: Map<string, Revision>;
    scene: string;
    cut: { flip: number; board: string } | null;
  }

  const mk = (): Ref => ({ byId: new Map(), scene: "", cut: null });
  const VIEWPORT: Box = { x: 0, y: 0, w: 1600, h: 900 };

  /** 把带子从头读到第 `stop` 格（含）。这就是"没有任何账"的那份读法要付的价钱。 */
  const readTape = (entries: OpEntry[], stop: number): Ref => {
    const ref = mk();
    const propScene = new Map<string, string>();
    const revs = new Map<string, Revision[]>();
    let t = 0;
    for (let i = 0; i <= stop; i++) {
      const op = entries[i].op;
      const start = t;
      switch (op.kind) {
        case "build":
        case "patch": {
          // 没点板的道具落在"它上一次被点到的那块板"上，没有历史才落在脚下那块 —— 参照抄的是
          // `ensureProp` 那一问，不是自己发明的第二条规则。
          const scene = op.scene ?? propScene.get(op.id) ?? (ref.scene || "default");
          propScene.set(op.id, scene);
          const list = revs.get(op.id) ?? [];
          const prev = list[list.length - 1];
          const filling = op.kind === "patch" && prev?.partial;
          const revision: Revision = {
            t: filling ? prev!.t : start,
            off: op.kind === "patch" ? prev?.off : undefined,
            scene,
            box: op.kind === "build" ? op.box : op.box ?? prev?.box ?? { ...VIEWPORT },
            svg: op.svg,
            label: op.label ?? prev?.label ?? op.id,
            partial: !(op.svg || op.html || op.scene3d),
          };
          if (filling) {
            // 填占位符是同一段窗口里换了张图，不是新的一格 —— 所以观众眼前站不站，仍由那段窗口答。
            list[list.length - 1] = revision;
          } else {
            if (prev && prev.off === undefined && prev.t <= revision.t) prev.off = revision.t;
            list.push(revision);
          }
          revs.set(op.id, list);
          if (onstageAt(revision, start)) ref.byId.set(op.id, revision);
          break;
        }
        case "recall": {
          const list = revs.get(op.id);
          if (!list || !list.length) break;
          const prev = list[list.length - 1];
          const scene = op.scene || ref.scene || "default";
          propScene.set(op.id, scene);
          const revived: Revision = { ...prev, t: start, off: undefined, scene, box: op.box ?? prev.box };
          if (prev.off === undefined && prev.t <= revived.t) prev.off = revived.t;
          list.push(revived);
          ref.byId.set(op.id, revived);
          break;
        }
        case "discard": {
          const list = revs.get(op.id);
          if (!list) break;
          const standing = standingAt(list, start);
          if (standing && standing.off === undefined) standing.off = start;
          ref.byId.delete(op.id);
          break;
        }
        case "transition":
          ref.scene = op.to;
          ref.cut = { flip: start + cueMs(op) / 2, board: op.to };
          break;
        default:
          break;
      }
      if (ownsTime(op)) t = start + cueMs(op);
    }
    return ref;
  };

  /** 观众此刻看得见的那些：站着，而且没有被最近那一刀扫走 —— `swept` 那半条，一格一格问。 */
  const visible = (ref: Ref): Revision[] =>
    [...ref.byId.values()].filter((r) => !ref.cut || r.scene === ref.cut.board || r.t >= ref.cut.flip);

  /**
   * 参照也按画出来的墨取景 —— 这一条由 `ink.test.ts` 自己钉着，这里抄它不是为了重新验证它，而是为了
   * 让下面那场对账比的确实是"谁站着、站在哪块板、这一刻扫没扫走"这一半，而不是墨的算法。
   */
  const cell = (r: Revision): Box => inkBox(r.svg, r.box) ?? r.box;

  const naiveUnion = (boxes: Box[]): Box => {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const b of boxes) {
      if (b.x < x1) x1 = b.x;
      if (b.y < y1) y1 = b.y;
      if (b.x + b.w > x2) x2 = b.x + b.w;
      if (b.y + b.h > y2) y2 = b.y + b.h;
    }
    return { x: x1, y: y1, w: Math.max(x2 - x1, 1), h: Math.max(y2 - y1, 1) };
  };
  const naivePad = (b: Box, f: number): Box => ({ x: b.x + b.w / 2 - (b.w * f) / 2, y: b.y + b.h / 2 - (b.h * f) / 2, w: b.w * f, h: b.h * f });
  const naiveFit = (rect: Box, aspect: number): Box => {
    const ra = rect.w / rect.h;
    if (ra > aspect) return { x: rect.x, y: rect.y - (rect.w / aspect - rect.h) / 2, w: rect.w, h: rect.w / aspect };
    return { x: rect.x - (rect.h * aspect - rect.w) / 2, y: rect.y, w: rect.h * aspect, h: rect.h };
  };
  const naivePushIn = (rect: Box, aspect: number): Box => {
    if (rect.w >= 450) return rect;
    const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const h = 450 / aspect;
    return { x: c.x - 225, y: c.y - h / 2, w: 450, h };
  };

  /** 同一份算术，落在参照那份台面上 —— 逐条对账比的就是这个 `to`。 */
  const naiveTo = (ref: Ref, cue: Cue): Box => {
    const op = cue.op as Extract<Op, { kind: "camera" }>;
    const seen = visible(ref);
    const targets: Box[] = [];
    const ids = Array.isArray(op.target) ? op.target : op.target ? [op.target] : [];
    for (const id of ids) {
      const hit = seen.find((r) => r.label === id);
      if (hit) {
        targets.push(cell(hit));
        continue;
      }
      const on = seen.filter((r) => r.scene === id).map(cell);
      if (on.length) targets.push(naiveUnion(on));
    }
    const from = cue.from;
    const aspect = from.w / from.h;
    let rect = targets.length ? naiveUnion(targets) : from;
    if (op.mode === "focus" && targets.length === 1) rect = naivePad(targets[0], 1.5);
    if (op.mode === "pan" && op.dir) {
      const f = Math.min(4, Math.max(0.1, op.screens ?? 0.8));
      const dx = op.dir === "right" ? f : op.dir === "left" ? -f : 0;
      const dy = op.dir === "down" ? f : op.dir === "up" ? -f : 0;
      rect = { x: from.x + dx * from.w, y: from.y + dy * from.h, w: from.w, h: from.h };
    }
    if (op.mode === "track" && op.follow) {
      const hit = seen.find((r) => r.label === op.follow);
      if (hit) {
        const c = { x: cell(hit).x + cell(hit).w / 2, y: cell(hit).y + cell(hit).h / 2 };
        rect = { ...from, x: c.x - from.w / 2, y: c.y - from.h / 2 };
      }
    }
    if (op.mode === "fit") rect = naivePad(rect, 1.2);
    return naivePushIn(naiveFit(rect, aspect), aspect);
  };

  /** 每一刀镜头对应带子上的哪一格：cues 与 entries 同序，所以按 op 引用找。 */
  const indexOf = (entries: OpEntry[], cue: Cue, from: number): number => {
    let i = from;
    while (i < entries.length && entries[i].op !== cue.op) i++;
    return i;
  };

  it("这批带子真的会换场、会撤下、会跨板复用、会点板名（不然下面的对账在空转）", () => {
    const flat = Array.from({ length: 40 }, (_, i) => randomTape(i + 1)).flat();
    expect(flat.filter((o) => o.kind === "discard").length).toBeGreaterThan(0);
    expect(flat.filter((o) => o.kind === "transition").length).toBeGreaterThan(0);
    expect(flat.filter((o) => o.kind === "recall").length).toBeGreaterThan(0);
    expect(flat.filter((o) => o.kind === "patch").length).toBeGreaterThan(0);
  });

  it("随机带子：每一刀镜头的落点和朴素读法逐条相等", () => {
    let checked = 0;
    let named = 0;
    let moved = 0;
    let boardNamed = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const entries = tape(...randomTape(seed));
      const c = compile(entries);
      let cursor = 0;
      for (const cue of c.cues) {
        if (cue.op.kind !== "camera") continue;
        cursor = indexOf(entries, cue, cursor);
        expect(cursor).toBeLessThan(entries.length);
        const ref = readTape(entries, cursor);
        const want = naiveTo(ref, cue);
        checked++;
        const op = cue.op;
        if (op.target || op.follow) named++;
        if (BOARDS.includes(String(op.target))) boardNamed++;
        if (Math.abs(want.x - cue.from.x) > 1e-9 || Math.abs(want.w - cue.from.w) > 1e-9) moved++;
        // 逐条：差一毫米就是镜头站到了一块观众没有的东西上，或者漏框了一个它该看见的名字。
        for (const k of ["x", "y", "w", "h"] as const) {
          if (Math.abs(cue.to[k] - want[k]) > 1e-6) {
            throw new Error(
              `seed ${seed} seq ${entries[cursor].seq} t=${cue.t} ${k}: got ${cue.to[k]} want ${want[k]} op=${JSON.stringify(op)} 参照=${JSON.stringify(visible(ref).map((r) => `${r.label}@${r.scene}:${r.t}`))}`,
            );
          }
        }
      }
    }
    // 探针不许空转：这一批里确实点过名、点过板名，也确实有落点可差。
    expect(checked).toBeGreaterThan(400);
    expect(named).toBeGreaterThan(300);
    expect(boardNamed).toBeGreaterThan(40);
    expect(moved).toBeGreaterThan(150);
  });

  it("反过来钉一条：被点名的那一格，落点的中心就是它的中心", () => {
    // 上面那条比的是"两边同一个数"，这一条比的是"那个数确实站在参照说站着的那一格上" —— 参照不是
    // 一个自说自话的常量。只问单个目标、不带 `at`/`region` 的那几刀：`focus`/`fit` 的全部意义就是
    // 把那一格站到画面正中。
    let hits = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const entries = tape(...randomTape(seed));
      const c = compile(entries);
      let cursor = 0;
      for (const cue of c.cues) {
        if (cue.op.kind !== "camera") continue;
        cursor = indexOf(entries, cue, cursor);
        const op = cue.op;
        if (op.at || op.region || Array.isArray(op.target) || !op.target || BOARDS.includes(op.target)) continue;
        const ref = readTape(entries, cursor);
        const seen = visible(ref);
        const hit = seen.find((r) => r.label === op.target);
        if (!hit) continue;
        hits++;
        const cx = cell(hit).x + cell(hit).w / 2;
        expect(cue.to.x + cue.to.w / 2).toBeCloseTo(cx, 6);
      }
    }
    expect(hits).toBeGreaterThan(20);
  });
});
