import { describe, expect, it } from "vitest";
import { compile, onstageAt, standingAt } from "./compile";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { StandingIndex, type Stand } from "./standing";
import type { Box, Compiled, Op, OpEntry, Prop } from "./types";

/*
 * 这一节钉的是「一帧的价钱从『一共有过几个道具』降到『此刻台上有几个』」。
 *
 * 上一件把一次外观变成一段窗口 `[t, off)`，这一件用那条窗口把"此刻站着什么"变成一次游标：落下和收走
 * 合成一条排好的事件流，一帧只付真的越过的那些，倒带回三分钟前只退回走过的那些。换场那半条规则
 * （`swept`）在这里折成两次二分 —— 板按"最晚一次落笔"排，板内的队列按落笔时刻排。
 *
 * 三件事分开钉，因为它们会各自坏：
 *  1. **答案不许变**：索引和"整张道具表走一遍"（上一件那份 `standingAt` 加 `swept`，就是观众此刻实际
 *     看见的规则）在每一刻逐条相等，**连次序**都要相等 —— 名单就是层叠次序，画错的次序比漏一格更难查。
 *  2. **价钱**：渲染一帧在道具表上走过的格子与带子长无关（改前正是"一共有过几个道具"，而且付两遍：
 *     画名单一遍、数欠的画一遍）。
 *  3. **游标会倒退**：倒带不是重扫整卷，是把走过的事件逐条退回去。所以升着问一刻、倒着问同一刻必须
 *     同一个答案 —— 只测正向的游标是个会漏的探针。
 */

const at = (x: number, y = 0): Box => ({ x, y, w: 200, h: 160 });
const art = (id: string, scene?: string): Op =>
  ({ kind: "build", id, scene, box: at(0), label: id, html: `<p>${id}</p>` }) as Op;
/** 一格空框：导演先报的名字和位置，图还没来 —— 美工迟到的那一笔补的就是它。 */
const skeleton = (id: string): Op => ({ kind: "build", id, box: at(0), label: id }) as Op;
const line = (text: string, duration = 1000): Op => ({ kind: "narrate", text, duration });
const drop = (id: string): Op => ({ kind: "discard", id });
const back = (id: string, scene?: string): Op => ({ kind: "recall", id, scene, box: at(600) }) as Op;
const cut = (to: string, duration = 1200): Op => ({ kind: "transition", style: "dissolve", to, duration });
const inked = (id: string): Op => ({ kind: "patch", id, box: at(300), svg: `<svg><text>${id}</text></svg>` }) as Op;

const tape = (...ops: Op[]): OpEntry[] => ops.map((op, i) => ({ seq: i, track: MAIN_TRACK, turn: 0, op }));

/** 改前那份读法，也是这一件的对账参照：整张道具表走一遍，逐格问"此刻站着吗、被扫走了吗"。 */
function legacyVisible(c: Compiled, t: number, cut: { flip: number; board: string } | null): string[] {
  const out: string[] = [];
  for (const p of c.props.values()) {
    const rev = standingAt(p.revisions, t);
    if (!rev) continue;
    if (!!cut && rev.t < cut.flip && rev.scene !== cut.board) continue;
    out.push(p.id);
  }
  return out;
}

/** 站着的全部，不带换场那一半 —— 导演的快照读的就是这一份。 */
function legacyStandingAll(c: Compiled, t: number): string[] {
  const out: string[] = [];
  for (const p of c.props.values()) if (standingAt(p.revisions, t)) out.push(p.id);
  return out;
}

/**
 * 该问的刻点：落笔、收笔、每一刀的幕布中点（`flip` 是换场那半条规则翻脸的那一刻，只问落笔时刻就问不到
 * "这一格刚被扫走"），加**相邻边缘的中点**和每一段的最后一毫秒 —— 上一件学到的是只问边缘是一条空转的
 * 对账，这一件同样的话在 `flip` 上成立。
 */
function marks(c: Compiled): number[] {
  const edges = new Set<number>([0, c.duration]);
  for (const p of c.props.values()) {
    for (const r of p.revisions) {
      edges.add(r.t);
      if (r.off !== undefined) edges.add(r.off);
    }
  }
  for (const q of c.cues) {
    if (q.op.kind === "transition") edges.add(q.t + (q.end - q.t) / 2);
  }
  const sorted = [...edges].filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  const out = new Set<number>(sorted);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (b - a >= 2) out.add(Math.floor((a + b) / 2));
    out.add(b - 1);
  }
  out.add(Infinity);
  return [...out];
}

/** 一批会踩到全部形状的带子：落笔、撤下、重画、recall、换场、换场之后再往别的板上落笔。 */
const generator = (seed: number) => {
  const ids = ["a", "b", "c", "d"];
  const boards = ["甲", "乙", "丙"];
  let s = seed >>> 0;
  // 必须是 int32 那条乘法：`seed * 1103515245` 在 float64 里超过 2^53 丢精度，一整批带子会抽到同一个数。
  const rnd = (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
  return (count: number): Op[][] => {
    const out: Op[][] = [];
    for (let tapeN = 0; tapeN < count; tapeN++) {
      const ops: Op[] = [];
      for (let i = 0; i < 20; i++) {
        const id = ids[rnd(ids.length)];
        switch (rnd(7)) {
          case 0:
            ops.push(art(id, boards[rnd(boards.length)]));
            break;
          case 1:
            ops.push(drop(id));
            break;
          case 2:
            ops.push(line("一句足够长的话把它撑满一拍", 400 + rnd(900)));
            break;
          case 3:
            ops.push(inked(id));
            break;
          case 4:
            ops.push(back(id, rnd(3) === 0 ? boards[rnd(boards.length)] : undefined));
            break;
          case 5:
            ops.push(cut(boards[rnd(boards.length)]));
            break;
          default:
            ops.push(art(id));
        }
      }
      out.push(ops);
    }
    return out;
  };
};
const randomTapes = generator(20261008);

const idsOf = (list: Stand[]): string[] => list.map((s) => s.prop.id);

describe("站着的那一格：索引和整张道具表逐刻同解", () => {
  it("这批带子真的会换场、会撤下、会跨板复用（不然下面的对账在空转）", () => {
    const flat = randomTapes(40).flat();
    expect(flat.filter((o) => o.kind === "discard").length).toBeGreaterThan(0);
    expect(flat.filter((o) => o.kind === "transition").length).toBeGreaterThan(0);
    expect(flat.filter((o) => o.kind === "recall").length).toBeGreaterThan(0);
    expect(flat.filter((o) => o.kind === "patch").length).toBeGreaterThan(0);
  });

  it("观众此刻看见的名单：内容一模一样，层叠次序也一模一样", () => {
    let compared = 0;
    for (const ops of randomTapes(40)) {
      const c = compile(tape(...ops));
      const ix = new StandingIndex(c);
      for (const t of marks(c)) {
        const flip = ix.visible(t, null);
        void flip;
        // 每一刀都问一次：换场那半条规则是这个索引最容易被抄错的一半。
        for (const q of c.cues) {
          if (q.op.kind !== "transition") continue;
          const at = { flip: q.t + (q.end - q.t) / 2, board: q.op.to };
          const mine = idsOf(ix.visible(t, at));
          const theirs = legacyVisible(c, t, at);
          expect(mine).toEqual(theirs);
          compared++;
        }
        const nocut = idsOf(ix.visible(t, null));
        expect(nocut).toEqual(legacyVisible(c, t, null));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(2000);
  });

  it("导演的快照那份（含被换场扫走的）也逐刻相等", () => {
    for (const ops of randomTapes(24)) {
      const c = compile(tape(...ops));
      const ix = new StandingIndex(c);
      for (const t of marks(c)) {
        expect(idsOf(ix.standing(t))).toEqual(legacyStandingAll(c, t));
      }
    }
  });

  it("换场扫不走自己板上的东西，也扫不走这一刀之后落笔的东西", () => {
    const s = new Stage();
    // 甲板上两格旧东西，切到乙，再在丙上落一笔（幕布没把他带到丙 —— 那一笔该看得见）。
    s.append([art("旧甲", "甲"), line("一", 1000), cut("乙"), art("新乙", "乙"), art("旁丙", "丙"), line("二", 1000)], MAIN_TRACK);
    const veil = s.compiled.cues.find((q) => q.op.kind === "transition")!;
    const flip = veil.t + (veil.end - veil.t) / 2;
    const at = { flip, board: "乙" };
    const ix = new StandingIndex(s.compiled);
    const t = s.compiled.duration;
    expect(idsOf(ix.visible(t, at))).toEqual(["新乙", "旁丙"]);
    // 同一批格子，换个问法：整张表走一遍的参照给的是同一份名单、同一个次序。
    expect(idsOf(ix.visible(t, at))).toEqual(legacyVisible(s.compiled, t, at));
    // 站着的全部仍然点名被扫走的那两格 —— 导演得知道它们要靠 recall 才带得回来。
    expect(idsOf(ix.standing(t))).toEqual(expect.arrayContaining(["旧甲"]));
  });

  it("「这一拍落的笔」和整张表走一遍同解（欠画那一遍数的就是它）", () => {
    // 旧写法为了问"时钟站的这一拍还欠几幅画"，把整张道具表走一遍，每格倒着找自己站着的那一次外观。
    // 新写法二分出这一拍落的那几格。两边必须点到同一批格子 —— 差一格就是时钟多停一拍或少停一拍。
    //
    // 这里比的是**排好序的两份**，不是原样：一帧的价钱是"这一拍欠几幅"，次序不进这笔账。两边的原样
    // 也恰好一致 —— 同一拍里落下的笔共用同一个 `t`（只有旁白、`beat`、换场推进时钟），所以新那份按
    // `(t, rank)` 排就是道具落下次序；下面那条名单对账比的是原样，因为那一头次序就是层叠。
    for (const ops of randomTapes(24)) {
      const c = compile(tape(...ops));
      const ix = new StandingIndex(c);
      for (const q of c.cues) {
        if (q.op.kind !== "narrate" && q.op.kind !== "beat" && q.op.kind !== "transition") continue;
        for (const t of [q.t + 1, q.end - 1, q.end]) {
          const mine = ix.laidIn(q.t, q.end, t).map((s) => `${s.prop.id}@${s.rev.t}`).sort();
          const theirs: string[] = [];
          for (const p of c.props.values()) {
            const rev = standingAt(p.revisions, t);
            if (rev && rev.t >= q.t && rev.t < q.end) theirs.push(`${p.id}@${rev.t}`);
          }
          theirs.sort();
          expect(mine).toEqual(theirs);
        }
      }
    }
  });

  it("游标会倒退：倒带回三分钟前，和从头走过来同一个答案", () => {
    const ops = [art("a", "甲"), line("一", 1000), drop("a"), line("二", 1000), art("b", "乙"), cut("乙"), art("c", "乙"), line("三", 1000)];
    const c = compile(tape(...ops));
    const cutCue = c.cues.find((q) => q.op.kind === "transition")!;
    const at = { flip: cutCue.t + (cutCue.end - cutCue.t) / 2, board: "乙" };
    const points = marks(c);
    const forward = new StandingIndex(c);
    const back = new StandingIndex(c);
    const seen: string[][] = [];
    for (const t of points) seen.push(idsOf(back.visible(t, at)));
    back.visible(Infinity, at);
    for (let i = points.length - 1; i >= 0; i--) {
      expect(idsOf(back.visible(points[i], at))).toEqual(seen[i]);
    }
    for (const t of points) expect(idsOf(back.visible(t, at))).toEqual(idsOf(forward.visible(t, at)));
  });

  it("同一刻先收旧的再落新的：窗口左闭右开在游标上也是这个次序", () => {
    const s = new Stage();
    // 同一拍里画错重画：第一格的窗口收在这一刻，第二格从这一刻站起来。
    s.append([art("a", "甲"), art("a", "甲"), line("一", 1000)], MAIN_TRACK);
    const revs = s.compiled.props.get("a")!.revisions;
    expect(revs).toHaveLength(2);
    expect(revs[0].off).toBe(revs[1].t);
    const ix = new StandingIndex(s.compiled);
    const list = ix.visible(revs[1].t, null);
    expect(idsOf(list)).toEqual(["a"]);
    expect(list[0].rev).toBe(revs[1]);
  });

  it("同一刻换板重画：旧板那份名单里不许留下影子", () => {
    // 落下和收走在同一刻，谁先谁后就在这里定：先收旧的，旧板那份名单才不留下已经搬走的格子。
    // 反过来（先落新的）会让新格把 `live` 里那条顶掉、`take` 于是提前退出，旧板头上还挂着早就不站着的
    // 那一格 —— 再切回那块板，观众就看见同一道具在同一帧被点两次，它就是两层。
    const s = new Stage();
    s.append(
      [
        art("a", "甲"),
        line("一", 1000),
        // 同一刻整格搬去乙：甲板上那一格收在 1000，乙板上那一格从 1000 站起来。
        art("a", "乙"),
        line("二", 1000),
        cut("甲"),
        art("b", "甲"),
        line("三", 1000),
      ],
      MAIN_TRACK,
    );
    const revs = s.compiled.props.get("a")!.revisions;
    expect(revs.map((r) => r.scene)).toEqual(["甲", "乙"]);
    const veil = s.compiled.cues.find((q) => q.op.kind === "transition")!;
    const at = { flip: veil.t + (veil.end - veil.t) / 2, board: "甲" };
    const ix = new StandingIndex(s.compiled);
    // 切回甲之后：站在甲板上的只有 `b`；`a` 早就搬走了，切回来不等于带回来。
    expect(idsOf(ix.visible(s.compiled.duration, at))).toEqual(["b"]);
    expect(idsOf(ix.visible(s.compiled.duration, at))).toEqual(legacyVisible(s.compiled, s.compiled.duration, at));
  });

  it("落了就撤的那一格站不住任何一刻，也不欠一幅画", () => {
    const s = new Stage();
    s.append([art("a"), drop("a"), line("一", 1000)], MAIN_TRACK);
    const ix = new StandingIndex(s.compiled);
    expect(idsOf(ix.visible(0, null))).toEqual([]);
    expect(ix.laidIn(0, 1000, 0)).toEqual([]);
  });

  it("迟到的补画落在撤下之后：图没丢，但它不许让已经撤下的东西复活", () => {
    const s = new Stage();
    s.append([skeleton("a"), line("一", 1000), drop("a"), line("二", 1000), inked("a")], MAIN_TRACK);
    const ix = new StandingIndex(s.compiled);
    // 撤下之前它站着一格空框；撤下之后那一格自己收掉了，迟到的图就在这一段收掉的窗口里。
    expect(idsOf(ix.visible(500, null))).toEqual(["a"]);
    for (const t of marks(s.compiled)) {
      if (t < 1000 || !Number.isFinite(t)) continue;
      expect(idsOf(ix.visible(t, null))).toEqual([]);
    }
    const rev = s.compiled.props.get("a")!.revisions[0];
    expect(rev.svg).toContain("text");
    expect(onstageAt(rev, Infinity)).toBe(false);
  });
});

describe("一帧的价钱：道具表一次也不许走", () => {
  /** 一"格"课：一句旁白 + 一格道具，道具按 4 块板轮着落，好让换场那一半也有东西可扫。 */
  const turnOf = (i: number): Op[] => [
    line(`第 ${i} 句台词，够看出时钟有没有在走`, 3000),
    { kind: "build", id: `p${i}`, scene: `板${i % 4}`, box: at((i % 12) * 120), label: `p${i}`, html: `<p>${i}</p>` } as Op,
  ];
  const long = (turns: number): OpEntry[] => {
    const out: OpEntry[] = [];
    for (let i = 0; i < turns; i++) for (const op of turnOf(i)) out.push({ seq: out.length, track: MAIN_TRACK, turn: i, op });
    return out;
  };

  /**
   * 一帧路过多少格：给道具表和每格道具的外观表各套一层数着的壳（上一件数 cue 表用的是同一个手艺）。
   * `values()` 这类按表走一遍的问法记一次 `sweep`，按下标读外观记一格 `cell`；Map 的方法必须绑回真实
   * 那张表，不然拿到的是 incompatible receiver。索引是带子动的时候建的，拿的是**原来那两份数据**，
   * 所以换上去之后一帧还能读到格子，就一定是渲染自己在按表走 —— 那一笔正是这一件要消掉的。
   */
  function watchProps(c: Compiled) {
    let cells = 0;
    let sweeps = 0;
    const scans = new Set<string | symbol>(["values", "forEach", "entries", "keys", Symbol.iterator]);
    const inner = new Map<string, Prop>();
    for (const [id, p] of c.props) {
      inner.set(
        id,
        new Proxy(p, {
          get(t, k) {
            if (k === "revisions") {
              return new Proxy(t.revisions, {
                get(a, i) {
                  if (typeof i === "string" && /^\d+$/.test(i)) cells++;
                  return (a as never)[i as never];
                },
              });
            }
            return (t as never)[k as never];
          },
        }),
      );
    }
    const props = new Proxy(inner, {
      get(t, k) {
        if (scans.has(k)) sweeps++;
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    return {
      compiled: { ...c, props } as unknown as Compiled,
      take: () => {
        const out = { cells, sweeps };
        cells = 0;
        sweeps = 0;
        return out;
      },
    };
  }

  function renderOneFrame(turns: number): { cells: number; sweeps: number; props: number; visible: number } {
    const s = new Stage();
    s.load(long(turns));
    const c = s.compiled;
    const watched = watchProps(c);
    (s as unknown as { compiledMain: Compiled }).compiledMain = watched.compiled;
    // 欠画那一遍只在直播时付：录像没有观众，也没有等待中的画。
    s.live = true;
    s.setTurnOpen(true);
    watched.take();
    s.seek(Math.round(c.duration / 2));
    const spent = watched.take();
    return { cells: spent.cells, sweeps: spent.sweeps, props: c.props.size, visible: s.getSnapshot().props.length };
  }

  it("带子长 16 倍，一帧在道具表和外观表上多走的路一格都不许多", () => {
    const small = renderOneFrame(500);
    const big = renderOneFrame(8000);
    expect(big.props).toBe(small.props * 16);
    // 改前这里就是"一共有过几个道具"：画名单走一遍整张表，`owedAt` 在直播时再一遍，每一格还要倒着
    // 找自己站着的那一次外观。修后一帧按的名字是"此刻台上有几个"，那张表一次也不走。
    expect(small.cells).toBe(0);
    expect(big.cells).toBe(small.cells);
    expect(small.sweeps).toBe(0);
    expect(big.sweeps).toBe(small.sweeps);
    // 探针不是空转：这一刻观众确实看得见东西，零格子是"没人按表走"，不是"台上一片空"。
    expect(small.visible).toBeGreaterThan(0);
    expect(big.visible).toBeGreaterThan(small.visible);
  });

  it("同一套数着的表，按改前那份读法问一次就要路过一整张表（说明上面那个零数的是真东西）", () => {
    const count = (turns: number) => {
      const s = new Stage();
      s.load(long(turns));
      const watched = watchProps(s.compiled);
      legacyVisible(watched.compiled, Math.round(s.compiled.duration / 2), null);
      return watched.take();
    };
    const small = count(500);
    const big = count(8000);
    // 参照那份读法的价钱跟着带子长：16 倍长就是十几倍格子，而且整张表走一遍。上一件钉 cue 表用的是
    // 同一句话 —— 这条存在的意义就是让上面那个 `toBe(0)` 不是一句空话。
    expect(small.sweeps).toBe(1);
    expect(big.cells).toBeGreaterThanOrEqual(small.cells * 15);
    expect(big.sweeps).toBe(small.sweeps);
  });

  it("导演的快照和一条镜头命令读的是同一份，也不按表走", () => {
    const s = new Stage();
    s.load(long(4000));
    const c = s.compiled;
    const watched = watchProps(c);
    (s as unknown as { compiledMain: Compiled }).compiledMain = watched.compiled;
    s.seek(Math.round(c.duration * 0.8));
    watched.take();
    s.agentSnapshot();
    s.visibleName("p1", s.t);
    s.visibleName("板3", s.t);
    s.visibleName("不存在", s.t);
    // 改前：快照走一遍整张表、`visibleName` 再走一遍，每一格倒着找自己的外观。
    const spent = watched.take();
    expect(spent.cells).toBe(0);
    expect(spent.sweeps).toBe(0);
  });

  it("建索引付一次线性的价钱，之后随便问多少刻都不再按表走", () => {
    const c = compile(long(1500));
    const watched = watchProps(c);
    const ix = new StandingIndex(watched.compiled);
    const built = watched.take();
    // 建一次是 O(带子)：每个道具走一次、每格外观点一次，这是它该付的。
    expect(built.sweeps).toBe(1);
    expect(built.cells).toBeGreaterThanOrEqual(c.props.size);
    for (let t = 0; t <= c.duration; t += Math.max(1, Math.floor(c.duration / 300))) {
      ix.visible(t, null);
      ix.laidIn(0, 1000, t);
    }
    // 一帧的价钱里不许有带子的长度：问过 300 个时刻之后，格子数仍然是零。
    const spent = watched.take();
    expect(spent.cells).toBe(0);
    expect(spent.sweeps).toBe(0);
  });
});
