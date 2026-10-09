import { describe, expect, it } from "vitest";
import { cueMs, onstageAt, ownsTime, standingAt } from "./compile";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import type { Box, Compiled, Op, OpEntry, Revision } from "./types";

/*
 * 这一节钉的是"**撤下是一次时刻，不是一个状态**"。
 *
 * 道具以前身上挂一个 `discardedAt` 数：`discard` 写下它，一次重画或 `recall` 又把它清空。三条都读错
 * 的账留在同一个字段上 ——
 *  - `撤下 → 重新落下`：清空之后倒带回到撤下与重画之间，观众看见一件已经被他撤掉的东西还在台上；
 *  - `撤下 → 重新落下 → 再撤下`：只剩最后那一刀，中间"已经撤了、还没重画"那一段没有记录；
 *  - `visibleName` 干脆不看这个字段，于是它和 `visibleProps` 对同一个名字两种说法 —— 上一轮明确记下
 *    "那是下一件"，这一轮就是那件。
 *
 * 现在一次外观是一段窗口 `[t, off)`，和 `Cue` 的 `t`/`end` 同一件东西。测试不放"新写法看起来对"：
 * 下面按**改前那条规则**把带子重放一份当参照（`legacyOf` / `legacyStanding`），在随机带上逐刻对账，
 * 两边读同一批外观。差异只许有一个方向（旧写法多算一个站在台上的人），而且必须真的量到 —— 量不到
 * 就是这条对账在空转。
 */

const at = (x: number, y = 0): Box => ({ x, y, w: 200, h: 160 });
const art = (id: string, extra: Record<string, unknown> = {}): Op =>
  ({ kind: "build", id, box: at(0), label: id, html: `<p>${id}</p>`, ...extra }) as Op;
/** 一格空框：导演先报的名字和位置，图还没来 —— `patch` 填的正是它。 */
const skeleton = (id: string): Op => ({ kind: "build", id, box: at(0), label: id }) as Op;
const line = (text: string, duration = 1000): Op => ({ kind: "narrate", text, duration });
const drop = (id: string): Op => ({ kind: "discard", id });
const inked = (id: string): Op => ({ kind: "patch", id, svg: `<svg><text>${id}</text></svg>` }) as Op;
const back = (id: string, x = 600): Op => ({ kind: "recall", id, box: at(x) }) as Op;
const cut = (to: string, duration = 1200): Op => ({ kind: "transition", style: "dissolve", to, duration });

/** 改前那个字段会长成的样子：一个数，会被落笔清空。 */
interface LegacyProp {
  discardedAt?: number;
  revisions: Revision[];
}

/**
 * 参照必须是**改前的规则**，不是从新结构反推：旧写法里 `build`/`patch`/`recall` 把 `discardedAt`
 * 清空，所以"撤下 → 重画"之后那个数是"没有"而不是"某个时刻"。外观表两边本来就一样（`t` 没动），
 * 差的只有这一格；时钟只由占时钟的 op 推进，和解释器同一条规则。
 */
function legacyOf(entries: readonly OpEntry[], c: Compiled): Map<string, LegacyProp> {
  const shape = new Map<string, LegacyProp>();
  let clock = 0;
  for (const e of entries) {
    const op = e.op;
    if (op.kind === "build" || op.kind === "patch" || op.kind === "recall") {
      const cur = shape.get(op.id) ?? { revisions: c.props.get(op.id)?.revisions ?? [] };
      cur.discardedAt = undefined;
      shape.set(op.id, cur);
    } else if (op.kind === "discard") {
      const cur = shape.get(op.id);
      if (cur) cur.discardedAt = clock;
    }
    if (ownsTime(op)) clock += cueMs(op);
  }
  return shape;
}

/** 参照里"站着什么"：旧 `revisionAt`（只看落没落下）加旧的那一个数。 */
function legacyStanding(p: LegacyProp | undefined, t: number): Revision | undefined {
  if (!p) return undefined;
  let rev: Revision | undefined;
  for (const r of p.revisions) if (r.t <= t) rev = r;
  if (!rev) return undefined;
  if (p.discardedAt !== undefined && p.discardedAt <= t) return undefined;
  return rev;
}

const onStageIds = (s: Stage, t: number): string[] => {
  s.seek(t);
  return s.getSnapshot().props.map((p) => p.id);
};

/**
 * 该问的刻点：每一段的窗口边界，加上**边界之间那些刻点**。
 *
 * 只问边界是一条会空转的对账 —— 旧写法撒谎的那一段正是"已经撤下、还没重画"的**内部**（那里没有
 * 任何一个时刻是某段窗口的边缘）。所以排好所有边缘，再取相邻边缘的中点。
 */
function marksAcross(c: Compiled, extra: number[] = []): number[] {
  const edges = new Set<number>([0, c.duration, ...extra]);
  for (const p of c.props.values()) {
    for (const r of p.revisions) {
      edges.add(r.t);
      if (r.off !== undefined) edges.add(r.off);
    }
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

describe("撤下是一次时刻：倒带读得出原样", () => {
  it("撤下之后重新落下，中间那一段台上没有它", () => {
    const s = new Stage();
    // build@0 → 一句(0..1000) → discard@1000 → 一句(1000..2000) → build@2000
    s.append([art("a"), line("说一句", 1000), drop("a"), line("再说一句", 1000), art("a"), line("第三句", 1000)], MAIN_TRACK);
    expect(onStageIds(s, 500)).toEqual(["a"]);
    // 旧写法在这里把 `discardedAt` 读成"没有"（第二次落笔清空了它），于是 1000..2000 这段台上还站着它。
    expect(onStageIds(s, 1500)).toEqual([]);
    expect(onStageIds(s, 2500)).toEqual(["a"]);
  });

  it("撤下 → 重画 → 再撤下：四段时间各是各的", () => {
    const s = new Stage();
    s.append([art("a"), line("一", 1000), drop("a"), line("二", 1000), art("a"), line("三", 1000), drop("a"), line("四", 1000)], MAIN_TRACK);
    expect(onStageIds(s, 500)).toEqual(["a"]);
    expect(onStageIds(s, 1500)).toEqual([]);
    expect(onStageIds(s, 2500)).toEqual(["a"]);
    expect(onStageIds(s, 3500)).toEqual([]);
    // 同一批刻点上当场点名旧写法在撒谎：它只记得最后那一刀。
    const legacy = legacyOf(s.log.ofTrack(MAIN_TRACK), s.compiled).get("a");
    expect(legacyStanding(legacy, 1500)).toBeDefined();
    expect(standingAt(s.compiled.props.get("a")!.revisions, 1500)).toBeUndefined();
  });

  it("同一拍里连下两刀 discard，只算一次撤下", () => {
    const s = new Stage();
    s.append([art("a"), drop("a"), drop("a"), line("说一句", 1000)], MAIN_TRACK);
    expect(onStageIds(s, 0)).toEqual([]);
    const revs = s.compiled.props.get("a")!.revisions;
    expect(revs).toHaveLength(1);
    expect(revs[0].off).toBe(0);
  });

  it("recall 带回台上的东西，不许一落地就已经是撤着的", () => {
    const s = new Stage();
    s.append([art("a"), line("一", 1000), drop("a"), line("二", 1000), cut("丙"), back("a")], MAIN_TRACK);
    expect(onStageIds(s, 1500)).toEqual([]);
    expect(onStageIds(s, s.compiled.duration)).toContain("a");
  });

  it("迟到的补画不许把已经撤下的东西偷偷带回台上", () => {
    const s = new Stage();
    // 美工交图走的是 `patch`：它给的是已经站在台上的那一格的样子，带回台上是 `recall`。
    s.append([skeleton("a"), line("一", 1000), drop("a"), line("二", 1000), inked("a")], MAIN_TRACK);
    expect(onStageIds(s, 1500)).toEqual([]);
    expect(onStageIds(s, s.compiled.duration)).toEqual([]);
    // 迟到的那笔没有丢：它就在那段收掉的窗口里，`recall` 带的正是它。
    const rev = s.compiled.props.get("a")!.revisions[0];
    expect(rev.svg).toContain("text");
    expect(rev.off).toBe(1000);
    s.append([back("a")], MAIN_TRACK);
    expect(onStageIds(s, s.compiled.duration)).toContain("a");
  });

  it("填占位符仍然只有一段窗口：外观不许互相盖住", () => {
    const s = new Stage();
    s.append([skeleton("a"), line("说一句", 1000), inked("a"), line("再说一句", 1000)], MAIN_TRACK);
    const revs = s.compiled.props.get("a")!.revisions;
    expect(revs).toHaveLength(1);
    expect(revs[0].t).toBe(0);
    expect(revs[0].svg).toContain("text");
    for (let t = 0; t <= s.compiled.duration; t += 250) {
      expect(revs.filter((r) => onstageAt(r, t)).length).toBeLessThanOrEqual(1);
    }
  });

  it("画错了重画：两段窗口相接，中间不许有缝也不许互相盖住", () => {
    const s = new Stage();
    s.append([art("a", { html: "<p>一版</p>" }), line("一", 1000), art("a", { html: "<p>二版</p>" }), line("二", 1000)], MAIN_TRACK);
    const revs = s.compiled.props.get("a")!.revisions;
    expect(revs).toHaveLength(2);
    expect(revs[0].off).toBe(revs[1].t);
    for (let t = 0; t <= s.compiled.duration; t += 100) {
      expect(revs.filter((r) => onstageAt(r, t)).length).toBe(1);
    }
  });
});

describe("一帧、一轮、一条命令读的是同一个答案", () => {
  const show = (...ops: Op[]) => {
    const s = new Stage();
    s.append(ops, MAIN_TRACK);
    return s;
  };

  it("visibleName 和 visibleProps 对同一格说法一致", () => {
    const s = show(art("a"), line("一", 1000), drop("a"), line("二", 1000), art("a"), line("三", 1000));
    for (const t of [0, 500, 1000, 1500, 2000, 2500, 3000, s.compiled.duration]) {
      expect(s.visibleName("a", t)).toBe(onStageIds(s, t).includes("a"));
    }
  });

  it("撤下的名字镜头指过去，观众那一头就是没有它", () => {
    const s = show(art("a"), line("一", 1000), drop("a"), line("二", 1000));
    // 改前这里说"有"：`blindCamera` 于是闭嘴，导演发的那一刀不动也不解释，把静默当成动过了。
    expect(s.visibleName("a", s.compiled.duration)).toBe(false);
    // 板名那条路不变：一块站着东西的板仍然算看得见。
    const s2 = show(art("c", { scene: "丙" }), cut("丙"));
    expect(s2.visibleName("丙", s2.compiled.duration)).toBe(true);
  });

  it("导演的 <stage> 读播放头那一刻，不读带子尽头", () => {
    const s = show(art("a"), line("一", 1000), drop("a"), line("二", 1000), art("b"), line("三", 1000));
    s.seek(500);
    const early = s.agentSnapshot();
    expect(early).toMatch(/^ {2}a \[/m);
    expect(early).not.toMatch(/^ {2}b \[/m); // 还没落下的 b 不许报给导演
    s.seek(1500);
    const between = s.agentSnapshot();
    expect(between).toContain("  (empty)");
    expect(between).not.toMatch(/^ {2}a \[/m);
    s.seek(s.compiled.duration);
    expect(s.agentSnapshot()).toMatch(/^ {2}b \[/m);
  });

  it("快照报的是站着的那一次外观的板名，不是道具最后一次挪去哪了", () => {
    const s = show(art("a", { scene: "甲" }), line("一", 1000), art("a", { scene: "乙" }), line("二", 1000));
    s.seek(500);
    expect(s.agentSnapshot()).toMatch(/^ {2}a \[甲\]/m);
    s.seek(s.compiled.duration);
    expect(s.agentSnapshot()).toMatch(/^ {2}a \[乙\]/m);
  });

  it("被换场扫走的那一批仍然点名（那是另一半，不是撤下）", () => {
    const s = show(art("a", { scene: "甲" }), cut("丙"), art("c", { scene: "丙" }));
    s.seek(s.compiled.duration);
    const snap = s.agentSnapshot();
    expect(snap).toContain("a [甲·已被换场扫走");
    expect(snap).toContain("c [丙]");
  });
});

describe("对账：新读法和按改前规则重放的参照，在同一批带上逐刻比", () => {
  /**
   * 一批会踩到全部形状的带子：落笔、撤下、重画、recall、换场、迟到的补画。
   *
   * 随机数必须是**真的随机**：这一带是乘同余，而 `seed * 1103515245` 在 float64 里超过 2^53 就丢精度，
   * `& 0x7fffffff` 于是拿到的是同一个数 —— 实测抽出来的序列全是 narrate 和 transition，一整批带子
   * 一条 `discard` 都没有，对账在空转。`Math.imul` 走的是 int32 那条乘法。门就是下面那句
   * 「量不到差异的对账是空转的门」：它红过一次，才说明这批带子真的能改前改后不一样。
   */
  const generator = (seed: number) => {
    const ids = ["a", "b", "c"];
    const boards = ["甲", "乙"];
    let s = seed >>> 0;
    const rnd = (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s % n;
    };
    return (count: number, withCuts: boolean): Op[][] => {
      const out: Op[][] = [];
      for (let tapeN = 0; tapeN < count; tapeN++) {
        const ops: Op[] = [];
        for (let i = 0; i < 16; i++) {
          const id = ids[rnd(ids.length)];
          switch (rnd(withCuts ? 6 : 5)) {
            case 0:
              // 两种都要有：只有骨架的带子上"站着什么"永远是空表，那种对账是空转的门。
              ops.push(rnd(2) === 0 ? skeleton(id) : art(id));
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
            default:
              ops.push(withCuts && rnd(4) === 0 ? cut(boards[rnd(boards.length)]) : back(id, rnd(800)));
          }
        }
        out.push(ops);
      }
      return out;
    };
  };
  const randomTapes = generator(20261008);
  /** 不放换场的带子：那条路比的是"此刻站着什么"，掺进 `swept` 就不是同一件事了。 */
  const tapesWithoutCuts = () => randomTapes(24, false);

  it("这批带子真的会撤下东西（不然下面两条都在空转）", () => {
    const withCuts = randomTapes(40, true);
    expect(withCuts.flat().filter((o) => o.kind === "discard").length).toBeGreaterThan(0);
    expect(tapesWithoutCuts().flat().some((o) => o.kind === "transition")).toBe(false);
  });

  it("每一刻的『站着什么』：差异只许是旧写法多算一个人", () => {
    const lies: string[] = [];
    const other: string[] = [];
    for (const ops of randomTapes(40, true)) {
      const s = new Stage();
      s.append(ops, MAIN_TRACK);
      const c = s.compiled;
      const legacy = legacyOf(s.log.ofTrack(MAIN_TRACK), c);
      for (const t of marksAcross(c)) {
        for (const [id, p] of c.props) {
          const mine = onstageAt(standingAt(p.revisions, t), t);
          const theirs = legacyStanding(legacy.get(id), t) !== undefined;
          if (mine === theirs) continue;
          (theirs ? lies : other).push(`${id}@${t}`);
        }
      }
    }
    // 量不到差异的对账是空转的门。
    expect(lies.length).toBeGreaterThan(0);
    expect(other).toEqual([]);
  });

  it("一帧的名单：换场之外，两边逐刻一模一样", () => {
    // 这一条比上面那条狠：它比的是观众真正看见的那份名单。带子里不放换场，所以 `swept` 那一半
    // 不参与 —— 两边唯一的差别就是撤下。名单必须**双向**相等：新读法不许少一个人，也不许多一个。
    let caught = 0;
    for (const ops of tapesWithoutCuts()) {
      const s = new Stage();
      s.append(ops, MAIN_TRACK);
      const c = s.compiled;
      const legacy = legacyOf(s.log.ofTrack(MAIN_TRACK), c);
      for (const t of marksAcross(c)) {
        const mine = new Set(onStageIds(s, t));
        const theirs = new Set<string>();
        for (const [id, p] of legacy) if (legacyStanding(p, t)) theirs.add(id);
        const onlyLegacy = [...theirs].filter((id) => !mine.has(id));
        // 反过来不许有：新读法不会凭空站上一个带子没落笔的名字，也不会少一个。
        expect([...mine].filter((id) => !theirs.has(id))).toEqual([]);
        for (const id of onlyLegacy) {
          caught++;
          // 多出来的那一个必须正是"已经撤下、还没重画"：它的窗口收在这一刻之前。
          const p = c.props.get(id)!;
          expect(p.revisions.some((r) => r.off !== undefined && r.off <= t && r.t <= t)).toBe(true);
        }
      }
    }
    expect(caught).toBeGreaterThan(0);
  });

  it("量一板的地皮：撤走的东西不许再把画面撑大（这一条改前改后同解）", () => {
    const s = new Stage();
    s.append([art("far", { box: at(6000) }), line("一", 1000), drop("far"), art("near"), line("二", 1000)], MAIN_TRACK);
    const box = s.compiled.scenes.get("default")!;
    expect(box.x + box.w).toBeLessThanOrEqual(201);
  });
});
