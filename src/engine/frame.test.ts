import { describe, expect, it } from "vitest";
import { compile } from "./compile";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { framingAt, runningLast } from "./reads";
import { upperBound } from "./search";
import { displaced, motionOffset } from "./motion";
import type { Box, Compiled, Cue, Gate, MotionOp, Op, OpEntry, Revision } from "./types";

/*
 * 读侧换成了二分与窗口，唯一不许动的东西是**答案**。
 *
 * 所以这里不放"新读法看起来对"的断言，而是把旧实现原样抄一份当参照，在随机生成的带上、在很多个
 * `t` 上、逐帧对账：镜头停在哪儿、哪一刀已经扫过、台上站着哪几格、欠几张画、此刻念的是哪句、挑中的
 * 是哪张卡。旧代码留在测试里是故意的 —— 它是那份行为的定义，不是待删的草稿：下一次有人把窗口算错
 * 一格，红的就是这一条，而不是某个人的眼睛。
 *
 * 两边都读**同一份** `stage.compiled`。这行很重要：`compile` 自己不过门（`guard` 在 `log` 那一头），
 * 参照实现要是拿另一次 `compile` 的结果，对账就成了"两条不同的带比一比"，什么也钉不住。
 */

/* ---------------- 旧实现：从 efc338e 的 runtime.ts 逐行抄下来 ---------------- */

type Cut = { flip: number; board: string };

const ownsTime = (op: Op) => op.kind === "narrate" || op.kind === "beat" || op.kind === "transition";
const sweptBy = (rev: Revision, cut: Cut | null) => !!cut && rev.t < cut.flip && rev.scene !== cut.board;
const tracked = (c: Cue): string | null => (c.op.kind === "camera" && c.op.mode === "track" && c.op.follow ? c.op.follow : null);

/** 旧 `cutAt`：走完整个 cue 表，只在 flip 越界时提前 break。 */
function oldCutAt(c: Compiled, t: number): Cut | null {
  let cut: Cut | null = null;
  for (const q of c.cues) {
    if (q.op.kind !== "transition") continue;
    const flip = q.t + (q.end - q.t) / 2;
    if (flip > t) break;
    cut = { flip, board: q.op.to };
  }
  return cut;
}

/** 旧 `cardAt`：每帧筛一遍卡表，再倒着找还站在台上的那张答过的。 */
function oldCardAt(c: Compiled, t: number): Gate | null {
  const reached = c.gates.filter((g) => g.t <= t);
  return reached.find((g) => g.said === null) ?? [...reached].reverse().find((g) => g.said !== null && t < g.until) ?? null;
}

/** 旧 `cameraAt` 的那个循环：筛一张镜头表，然后从头走，`end <= t` 就记账，`t > now` 就 break，撞上还在跑的就 return。 */
function oldCamera(c: Compiled, t: number, standing: Box, camFrom: { box: Box | null; at: number }, live: boolean): Box {
  const cues = c.cues.filter((q) => q.op.kind === "camera" || q.op.kind === "transition");
  let rect = standing;
  let follow: string | null = null;
  for (const q of cues) {
    if (q.end <= t) {
      rect = q.to;
      follow = tracked(q);
      continue;
    }
    if (q.t > t) break;
    const op = q.op as { easing: string };
    const p = Math.min(1, Math.max(0, (t - q.t) / Math.max(q.end - q.t, 1)));
    const from = live && camFrom.box && camFrom.at <= q.t ? camFrom.box : q.from;
    if (!camFrom.box || camFrom.at !== q.t) {
      camFrom.box = from;
      camFrom.at = q.t;
    }
    follow = tracked(q) ?? follow;
    const glide = lerp(from, q.to, EASE(op.easing, p));
    return ride(c, glide, follow, t);
  }
  return ride(c, rect, follow, t);
}

/** 旧 `ride` + 旧 `followOffset`：整条 cue 表筛一边才拿到那一条 motion。 */
function ride(c: Compiled, rect: Box, follow: string | null, t: number): Box {
  if (!follow) return rect;
  const mo = oldMotion(c, follow, t);
  const { dx, dy } = mo ? motionOffset(mo.op as MotionOp, t - mo.t) : { dx: 0, dy: 0 };
  return dx === 0 && dy === 0 ? rect : { ...rect, x: rect.x + dx, y: rect.y + dy };
}

function oldMotion(c: Compiled, id: string, t: number): Cue | null {
  return c.cues.filter((q) => q.op.kind === "motion" && (q.op as MotionOp).id === id && q.t <= t && q.end > t).pop() ?? null;
}

/** 旧 `visibleProps` 的台上集合与它的盒子、强调、草图标记。 */
function oldVisible(c: Compiled, t: number): { id: string; box: Box; label: string; draft: boolean; highlight?: string }[] {
  const cut = oldCutAt(c, t);
  const highlights = c.cues.filter((q) => q.op.kind === "highlight" && q.t <= t && q.end > t);
  const out: { id: string; box: Box; label: string; draft: boolean; highlight?: string }[] = [];
  for (const p of c.props.values()) {
    const revs = p.revisions.filter((r) => r.t <= t);
    if (revs.length === 0) continue;
    if (p.discardedAt !== undefined && p.discardedAt <= t) continue;
    const rev = revs[revs.length - 1];
    if (sweptBy(rev, cut)) continue;
    const mo = oldMotion(c, p.id, t);
    const hl = highlights.find((h) => (h.op as { target: string }).target === p.id);
    out.push({
      id: p.id,
      box: displaced(rev.box, mo ? motionOffset(mo.op as MotionOp, t - mo.t) : { dx: 0, dy: 0 }),
      label: rev.label,
      draft: !(rev.svg || rev.html || rev.scene3d),
      highlight: hl ? (hl.op as { style: string }).style : undefined,
    });
  }
  return out;
}

/** 旧 `owedAt`：脚下这一拍（走完整条 cue 表）加上这一拍里欠的那几张画。 */
function oldBeatWindow(c: Compiled, t: number): { start: number; end: number } {
  let start = t;
  let end = t;
  for (const q of c.cues) {
    if (q.t > t) break;
    if (!ownsTime(q.op) || q.end <= t) continue;
    start = q.t;
    end = q.end;
  }
  return { start, end };
}
function oldOwed(c: Compiled, t: number): number {
  const { start, end } = oldBeatWindow(c, t);
  const inThisBeat = (at: number) => at >= start && at < end;
  const cut = oldCutAt(c, t);
  let n = 0;
  for (const p of c.props.values()) {
    if (p.discardedAt !== undefined && p.discardedAt <= t) continue;
    const onStage = p.revisions.filter((r) => r.t <= t);
    if (onStage.length === 0) continue;
    const rev = onStage[onStage.length - 1];
    if (sweptBy(rev, cut)) continue;
    if (!(rev.svg || rev.html || rev.scene3d) && inThisBeat(rev.t)) n++;
  }
  return n;
}

const EASE_NAMES = ["linear", "ease", "ease-in", "ease-out", "spring"];
function EASE(name: string, p: number): number {
  if (name === "linear") return p;
  if (name === "ease-in") return p * p;
  if (name === "ease-out") return 1 - (1 - p) * (1 - p);
  if (name === "spring") return 1 - Math.pow(1 - p, 3) * Math.cos(p * Math.PI * 1.2);
  // `EASES[op.easing] ?? EASES.ease` —— 认不得的名字回落到 ease，旧代码就是这么写的。
  if (!EASE_NAMES.includes(name)) return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}
function lerp(a: Box, b: Box, p: number): Box {
  return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, w: a.w + (b.w - a.w) * p, h: a.h + (b.h - a.h) * p };
}

/* ---------------- 随机带 ---------------- */

const rnd = (seed: number) => {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
};

/**
 * 一堂"故意难看"的课：三种板、来回换场、patch 与 recall 挪板名、discard、叠着的 highlight 与
 * motion、镜头五种模式都有、卡片与回答也都有。对账要钉的是**边界**，所以每一样都得在同一帧里
 * 同时出现几次：重叠的覆盖层（窗口）、被长覆盖层吞掉的短 cue（`open` 前缀水位）、只有名字的道具
 * （`link`）、还没上台的道具（`reach` 前缀）。
 */
function randomTape(seed: number, n: number): Op[] {
  const r = rnd(seed);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(r() * list.length)];
  const boards = ["甲", "乙", "丙"] as const;
  const ops: Op[] = [];
  let props = 0;
  const someId = () => `p${1 + Math.floor(r() * Math.max(props, 1))}`;
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.26) {
      props++;
      ops.push({
        kind: "build",
        id: `p${props}`,
        scene: r() < 0.8 ? pick(boards) : undefined,
        label: `p${props}`,
        html: r() < 0.7 ? "<p>x</p>" : undefined,
        box: { x: Math.floor(r() * 8) * 520, y: Math.floor(r() * 4) * 320, w: 200, h: 160 },
        here: r() < 0.2,
      });
    } else if (roll < 0.32 && props) {
      // 只被念到名字、还没有样子的那个形状：`link` 会把名字插进道具表。
      ops.push({ kind: "link", from: `ghost${i}`, to: someId(), relation: "points-to" });
    } else if (roll < 0.42 && props) {
      ops.push({ kind: "patch", id: someId(), html: r() < 0.5 ? "<p>y</p>" : undefined, scene: r() < 0.3 ? pick(boards) : undefined });
    } else if (roll < 0.5 && props) {
      ops.push({ kind: "recall", id: someId(), box: { x: Math.floor(r() * 6) * 400, y: Math.floor(r() * 3) * 300, w: 240, h: 180 }, scene: r() < 0.4 ? pick(boards) : undefined });
    } else if (roll < 0.54 && props) {
      ops.push({ kind: "discard", id: someId() });
    } else if (roll < 0.66) {
      ops.push({ kind: "narrate", text: `第 ${i} 句旁白`, duration: 200 + Math.floor(r() * 800) });
    } else if (roll < 0.7) {
      ops.push({ kind: "beat", duration: Math.floor(r() * 500) });
    } else if (roll < 0.8) {
      const mode = pick(["fit", "focus", "pan", "zoom", "track"] as const);
      ops.push({
        kind: "camera",
        mode,
        target: mode === "pan" || mode === "zoom" ? undefined : props && r() < 0.6 ? someId() : pick(boards),
        dir: mode === "pan" ? pick(["left", "right", "up", "down"] as const) : undefined,
        center: mode === "pan" && r() < 0.4 ? { x: Math.floor(r() * 3000), y: Math.floor(r() * 900) } : undefined,
        zoom: mode === "zoom" ? 0.5 + r() * 3 : undefined,
        follow: mode === "track" && props ? someId() : undefined,
        duration: 150 + Math.floor(r() * 900),
        easing: pick(["linear", "ease", "ease-in", "ease-out", "spring"] as const),
      });
    } else if (roll < 0.86) {
      ops.push({ kind: "transition", style: pick(["dissolve", "wipe", "match-cut", "split"] as const), to: pick(boards), duration: 600 + Math.floor(r() * 900) });
    } else if (roll < 0.93 && props) {
      // 同一格叠两条：窗口的意义就在这里。
      ops.push({ kind: "highlight", target: someId(), style: pick(["pulse", "outline", "dim-rest", "shake"] as const), duration: 200 + Math.floor(r() * 1600) });
    } else if (roll < 0.98 && props) {
      ops.push({
        kind: "motion",
        id: someId(),
        mode: pick(["oscillate", "approach", "orbit", "iterate", "flow"] as const),
        axis: pick(["x", "y", "both"] as const),
        amp: 40 + r() * 200,
        period: 400 + r() * 1200,
        radius: 30 + r() * 120,
        steps: 2 + Math.floor(r() * 6),
        decay: 300 + r() * 900,
        duration: 200 + Math.floor(r() * 2200),
      });
    } else {
      ops.push({ kind: "narrate", text: "空台上说一句", duration: 400 });
    }
    // 卡片与回答：`cardAt` 那一刀靠"答过的卡的窗口不许回填"，随机带里必须真的出现问答。
    if (r() < 0.06) {
      ops.push({ kind: "quiz", prompt: `第 ${i} 题`, options: ["1", "2", "3"], answer: 1, concept: "c" });
      if (r() < 0.7) ops.push({ kind: "answer", gate: 0, text: "1" });
    } else if (r() < 0.03) {
      ops.push({ kind: "pause-for", reason: "想一想" });
      ops.push({ kind: "answer", gate: 0, text: "想好了" });
    }
  }
  return ops;
}

/**
 * `answer` 的 `gate` 得指向真存在的那张卡。seq 是 `log.append` 按顺序发的，而这里给的正是顺序表，
 * 所以"这张卡在数组里的下标"就是它上了带子之后的 seq。
 */
function wireAnswers(ops: Op[]): Op[] {
  const cardSeq = new Map<Op, number>();
  ops.forEach((op, i) => {
    if (op.kind === "quiz" || op.kind === "pause-for") cardSeq.set(op, i);
  });
  const cards = [...cardSeq.values()];
  let next = 0;
  return ops.map((op) => {
    if (op.kind !== "answer") return op;
    const seq = cards[next];
    if (seq === undefined) return op;
    next++;
    return { ...op, gate: seq };
  });
}

/** 一台舞台，两边共读同一份 `compiled`。 */
const both = (seed: number, n: number) => {
  const s = new Stage();
  // 走 `append` 而不是 `load`：门会把每条 op 削到合法范围，而 `live` 默认就是 true —— 参照实现要
  // 读到的是同一份被削过的带，且 `owedAt` 在 recordings 上恒为 0，那样对账等于没对。
  s.append(wireAnswers(randomTape(seed, n)), MAIN_TRACK);
  return { s, c: s.compiled };
};

const times = (c: Compiled, k: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i <= k; i++) out.push((c.duration * i) / k);
  // 边界自己：每一刀的 flip、每一条 cue 的头与尾，都正是旧循环的 break/return 落点。
  for (const q of c.cues) {
    out.push(q.t, q.end, q.t + 1, q.end - 1);
    if (q.op.kind === "transition") out.push(q.t + (q.end - q.t) / 2);
  }
  return out.map((t) => Math.max(0, Math.min(t, c.duration)));
};

const SEEDS = [1, 7, 42, 123, 99991];
const N = 320;

describe("frame：读侧换了算法，答案一个不许变", () => {
  it("framingAt 的两个下标，就是旧循环撞上的那两条 cue", () => {
    for (const seed of SEEDS) {
      const { c } = both(seed, N);
      const line = c.frame.framing;
      // 旧循环的样子：从头走，`end <= t` 就记下这条，撞上第一条还在跑的就在那条 return，撞上第一条
      // 还没开始的就 break —— break 时手里那条就是答案。
      const reference = (t: number) => {
        let settled = -1;
        for (let i = 0; i < line.cues.length; i++) {
          const q = line.cues[i];
          if (q.end <= t) {
            settled = i;
            continue;
          }
          if (q.t > t) break;
          return { settled, running: i };
        }
        return { settled, running: -1 };
      };
      for (const t of times(c, 40)) {
        const got = framingAt(line, t);
        const want = reference(t);
        expect(got.running).toBe(want.running);
        expect(got.settled).toBe(want.settled);
        if (want.running >= 0) expect(line.cues[got.running]).toBe(line.cues[want.running]);
        if (want.settled >= 0) expect(line.cues[got.settled].end).toBeLessThanOrEqual(t);
      }
    }
  });

  it("cameraAt：整幅画面逐帧相等，包括活演出的 camFrom 那一半", () => {
    for (const seed of SEEDS) {
      const { s, c } = both(seed, N);
      /*
       * `cameraAt` 的起点是 `this.rect` —— 也就是**上一帧**的画面，而不是 VIEWPORT：`seek` 清掉的只有
       * `camFrom`。参照实现要是每帧都从一屏开始，比的就不是同一件事。这一格旧代码本身有个 wart：没有
       * 一条 cue 走完时它读的是上一次的画面，所以这里必须把上一帧真的传给它。
       */
      let prev: Box = { x: 0, y: 0, w: 1600, h: 900 };
      for (const t of times(c, 60)) {
        s.seek(t);
        const camFrom = { box: null as Box | null, at: -1 }; // `seek` 会把 camFrom 清掉
        const want = oldCamera(c, t, prev, camFrom, s.live);
        const got = s.getSnapshot().rect;
        expect(got).toEqual(want);
        prev = got;
      }
    }
  });

  it("cameraAt：时钟一帧帧往前走（不清 camFrom）也不许差", () => {
    for (const seed of SEEDS) {
      const { s, c } = both(seed, N);
      const camFrom = { box: null as Box | null, at: -1 };
      // `tick` 挪表针时不清 camFrom，而且 `cameraAt` 的起点是**上一帧**的画面 —— 那才是活演出真正
      // 走过的路。`setSpeed` 会 emit，走的正是 `render()` 那一条。
      let prev: Box = { x: 0, y: 0, w: 1600, h: 900 };
      let frames = 0;
      for (let t = 0; t <= c.duration; t += 83) {
        s.t = Math.min(t, c.duration);
        const want = oldCamera(c, s.t, prev, camFrom, s.live);
        s.setSpeed(1);
        const got = s.getSnapshot().rect;
        expect(got).toEqual(want);
        prev = got;
        frames++;
      }
      // 走过 200 帧还没到终点的话，`camFrom` 那半才算真被穿过；不然这条测试是空的。
      expect(frames).toBeGreaterThan(20);
    }
  });

  it("cutAt：二分出的那一刀，和旧循环扫出来的同一刀", () => {
    for (const seed of SEEDS) {
      const { s, c } = both(seed, N);
      const { cuts, flips } = c.frame;
      expect(flips.length).toBe(c.cues.filter((q) => q.op.kind === "transition").length);
      for (let i = 1; i < flips.length; i++) expect(flips[i]).toBeGreaterThanOrEqual(flips[i - 1]);
      for (const t of times(c, 50)) {
        const i = upperBound(flips, t) - 1;
        const got = i < 0 ? null : { flip: flips[i], board: (cuts.cues[i].op as { to: string }).to };
        expect(got).toEqual(oldCutAt(c, t));
        s.seek(t);
        expect(s.boardAt(t)).toEqual(oldCutAt(c, t)?.board ?? null);
      }
    }
  });

  it("visibleProps：台上集合、顺序、盒子、强调、草图标记，一格都不许差", () => {
    for (const seed of SEEDS) {
      const { s, c } = both(seed, N);
      for (const t of times(c, 50)) {
        s.seek(t);
        const snap = s.getSnapshot();
        expect(snap.props.map((p) => p.id)).toEqual(oldVisible(c, t).map((p) => p.id));
        expect(
          snap.props.map((p) => ({ id: p.id, box: p.box, label: p.label, draft: p.draft, highlight: p.highlight })),
        ).toEqual(oldVisible(c, t));
      }
    }
  });

  it("owedAt：脚下这一拍的窗口与欠的画数，逐帧一致", () => {
    for (const seed of SEEDS) {
      const { s, c } = both(seed, N);
      // 导演的回合开着：旧代码那句 `(turnOpen || !painting.has(id))` 才走得到前一半，`artFor`/`painting`
      // 都留空，于是两边都只剩"这一拍里的空格子"那一本账。
      s.setTurnOpen(true);
      for (const t of times(c, 50)) {
        s.seek(t);
        s.setTurnOpen(true);
        const beat = runningLast(c.frame.owning, t);
        expect([beat ? beat.t : t, beat ? beat.end : t]).toEqual([oldBeatWindow(c, t).start, oldBeatWindow(c, t).end]);
        expect(s.getSnapshot().artOwed).toBe(oldOwed(c, t));
      }
    }
  });

  it("narration 与 veil：还在念的最后一条，和旧 filter().pop() 同一条", () => {
    for (const seed of SEEDS) {
      const { s, c } = both(seed, N);
      for (const t of times(c, 50)) {
        s.seek(t);
        const narr = c.cues.filter((q) => q.op.kind === "narrate" && q.t <= t && q.end > t).pop();
        const veil = c.cues.filter((q) => q.op.kind === "transition" && q.t <= t && q.end > t).pop();
        const snap = s.getSnapshot();
        expect(snap.narration !== null).toBe(!!narr);
        expect(snap.narration?.text).toBe(narr ? (narr.op as { text: string }).text : undefined);
        expect(snap.veil !== null).toBe(!!veil);
        expect(snap.veil?.style).toBe(veil ? (veil.op as { style: string }).style : undefined);
      }
    }
  });

  it("cardAt：筛表变成两次二分，挑中的卡不许换一张", () => {
    for (const seed of SEEDS) {
      const { s, c } = both(seed, N);
      let asked = 0;
      for (const t of times(c, 50)) {
        s.seek(t);
        const card = oldCardAt(c, t);
        const snap = s.getSnapshot();
        expect(snap.said).toBe(card?.said ?? null);
        // 活着的演出才会把时钟停在那张未答的卡上。
        expect(snap.gate?.seq ?? null).toBe(card && card.said === null ? card.seq : null);
        if (card) asked++;
      }
      // 随机带里必须真的出现过卡，否则这一条是空的。
      expect(c.gates.length).toBeGreaterThan(0);
      expect(asked).toBeGreaterThan(0);
    }
  });

  it("visibleName：一块板的名字，不许因为换了索引就读成别的东西", () => {
    for (const seed of SEEDS) {
      const { s, c } = both(seed, N);
      const names = ["甲", "乙", "丙", "p1", "p2", "p30", "ghost1", "vec-never"];
      for (const id of names) {
        for (const t of times(c, 20)) {
          const cut = oldCutAt(c, t);
          // 旧 `visibleName` 里的 `standing`：只看这一版在不在台上、有没有被扫走 —— 它**不看**
          // `discardedAt`。照抄，不加"顺手修好"：这一格旧代码和 `visibleProps` 不一致（被 discard 掉的
          // 道具在这里还算看得见），那条差异是这一卷量出来的新证据，写在 `docs/iteration-frame-read.md`，
          // 归下一件 —— 索引那一刀只许改价钱，不许改答案。
          const standing = (revisions: Revision[]): Revision | undefined => {
            const onStage = revisions.filter((r) => r.t <= t);
            return onStage.length ? onStage[onStage.length - 1] : undefined;
          };
          const visible = (p: { id: string; revisions: Revision[] }) => {
            const rev = standing(p.revisions);
            return rev && !sweptBy(rev, cut) ? rev : undefined;
          };
          const named = c.props.get(id);
          const want = !!((named && visible(named)) || [...c.props.values()].some((p) => p.id !== id && visible(p)?.scene === id));
          expect(s.visibleName(id, t)).toBe(want);
        }
      }
    }
  });

  it("分出来的线不许换 cue 的对象：导演认自己那一刀靠的是引用", () => {
    for (const seed of SEEDS) {
      const { c } = both(seed, N);
      const pool = new Set(c.cues);
      for (const line of [c.frame.framing, c.frame.cuts, c.frame.owning, c.frame.narrate, c.frame.highlights, c.frame.motions]) {
        for (const q of line.cues) expect(pool.has(q)).toBe(true);
      }
      for (const line of c.frame.motionByProp.values()) for (const q of line.cues) expect(pool.has(q)).toBe(true);
      // 每一条线的 `t` 必须是前缀可二分的 —— 这不是"大概有序"，是二分的定义域。
      for (const line of [c.frame.framing, c.frame.cuts, c.frame.owning, c.frame.narrate, c.frame.highlights, c.frame.motions]) {
        for (let i = 1; i < line.cues.length; i++) expect(line.cues[i].t).toBeGreaterThanOrEqual(line.cues[i - 1].t);
        for (let i = 1; i < line.open.length; i++) expect(line.open[i]).toBeGreaterThanOrEqual(line.open[i - 1]);
      }
      // `staged.reach` 不许回头，且它的下标必须和 `props` 一一对应。
      const { props, reach } = c.frame.staged;
      expect(props.length).toBe(reach.length);
      for (let i = 1; i < reach.length; i++) expect(reach[i]).toBeGreaterThanOrEqual(reach[i - 1]);
      for (let i = 0; i < props.length; i++) expect(props[i].revisions[0].t).toBeGreaterThanOrEqual(reach[i]);
    }
  });
});

/*
 * 最后一条不是对账，是这一件迭代存在的理由：**一帧的价钱不许跟着整卷长**。
 *
 * 断的是比值不是毫秒（共享 CI 的噪声比省下来的那些毫秒大，这条纪律是 `compile.test.ts` 立的）。
 * 带的形状是"台上只有两格，cue 表很长" —— 那是一堂真课的样子：画面上能看见的东西就那么些，而带子
 * 越讲越长，旧读法每帧走的是整条 cue 表。
 *
 * 但这一条要是只断"新的那边比值小"，它就成了一个可以永远红的门：一台快机器上量不到价钱，比值就是
 * 噪声。所以它自己校准 —— 先在**同一批带上量一遍旧读法**，量出来必须真的接近带长的倍数（那件坏确实
 * 还在，只是搬到了参照实现里），否则这条测试当场说"量不到"。守门的不许是抖的，也不许是空的。
 */
describe("frame：一帧不许按整卷付钱", () => {
  const tape = (n: number): Op[] => {
    const ops: Op[] = [
      { kind: "build", id: "a", label: "a", html: "<p>a</p>", box: { x: 100, y: 100, w: 200, h: 160 } },
      { kind: "build", id: "b", label: "b", box: { x: 400, y: 100, w: 200, h: 160 } }, // 空格子：欠的那本账也要有活干
    ];
    let card = -1;
    for (let i = 0; i < n; i++) {
      if (i % 7 === 0) ops.push({ kind: "narrate", text: `第 ${i} 句`, duration: 260 });
      else if (i % 7 === 1) ops.push({ kind: "camera", mode: "pan", dir: "right", duration: 240, easing: "ease" });
      else if (i % 7 === 2) ops.push({ kind: "highlight", target: "a", style: "pulse", duration: 900 });
      else if (i % 7 === 3) ops.push({ kind: "motion", id: "b", mode: "oscillate", axis: "x", amp: 30, period: 600, radius: 20, steps: 3, decay: 400, duration: 900 });
      else if (i % 7 === 4) ops.push({ kind: "beat", duration: 200 });
      else if (i % 7 === 5) {
        card = ops.length;
        ops.push({ kind: "quiz", prompt: `第 ${i} 题`, options: ["1", "2"], answer: 0 });
      } // `append` 按下标发 seq，所以卡的位置就是它的 seq。
      else if (card >= 0) ops.push({ kind: "answer", gate: card, text: "1" });
      else ops.push({ kind: "narrate", text: "还没题目", duration: 200 });
    }
    return ops;
  };

  const entries = (ops: Op[]): OpEntry[] => ops.map((op, seq) => ({ seq, track: MAIN_TRACK, turn: 0, op }));

  /** 一批里每帧的价钱：`seek` 走的就是 `render()` 那条路。 */
  const frameCost = (s: Stage, t: number, reps: number): number => {
    const started = performance.now();
    for (let r = 0; r < reps; r++) s.seek(t + (r % 3));
    return (performance.now() - started) / reps;
  };

  /** 旧读法的一帧：被换掉的那件事，原样量一遍当尺子。 */
  const oldCost = (c: Compiled, t: number, reps: number): number => {
    const standing: Box = { x: 0, y: 0, w: 1600, h: 900 };
    const started = performance.now();
    for (let r = 0; r < reps; r++) {
      const at = t + (r % 3);
      oldCamera(c, at, standing, { box: null, at: -1 }, false);
      oldVisible(c, at);
      oldOwed(c, at);
      oldCardAt(c, at);
    }
    return (performance.now() - started) / reps;
  };

  /**
   * 自己加长到跨过下限。下限是对**测量**的要求，不是这条带的性质：一台读不出 2µs 的机器上，比值
   * 是噪声，跨不过去就明说量不到，而不是假装量到了。
   */
  const FLOOR_MS = 5;
  const CAP = 64 * 64;
  const measure = (mk: (reps: number) => number): number => {
    let reps = 64;
    let per = mk(reps);
    while (per * reps < FLOOR_MS && reps < CAP) {
      reps *= 4;
      per = mk(reps);
    }
    // 下限先验，再比 ——"跨不过下限"和"比值不对"是两件事，混在一条断言里红的时候读不出是哪种。
    if (per * reps < FLOOR_MS) throw new Error(`量不到：${reps} 帧只用 ${(per * reps).toFixed(2)}ms，这台机器上读不出带的形状`);
    return per;
  };

  it("尺子先要有刻度：旧读法一帧的价钱随带长成倍涨", () => {
    // 带子在外面建好、编译一次：量的是读，不是写。
    const small = compile(entries(tape(4_000)));
    const big = compile(entries(tape(40_000)));
    const a = measure((reps) => oldCost(small, 0, reps));
    const b = measure((reps) => oldCost(big, 0, reps));
    // 十倍带长。旧读法每帧 filter + 走完整条 cue 表，所以比值必须看得见那十倍 —— 看不见就说明这台
    // 机器量不到这个形状，下面那条"新读法不许随带长"也就没有意义。
    expect(b / a).toBeGreaterThan(6);
  });

  it("换掉之后：带长翻十倍，一帧的价钱不许跟着翻", () => {
    const build = (n: number) => {
      const s = new Stage();
      s.append(tape(n), MAIN_TRACK);
      s.setTurnOpen(true);
      return s;
    };
    const small = build(4_000);
    const big = build(40_000);
    const a = measure((reps) => frameCost(small, Math.floor(small.compiled.duration / 2), reps));
    const b = measure((reps) => frameCost(big, Math.floor(big.compiled.duration / 2), reps));
    // 读侧现在是"两次二分 + 一个窗口"：窗口的大小是"此刻叠着几条覆盖层"，不是整卷有多长。
    // 3 倍是留给 GC 与建带本身的余量 —— 剩下的那一截是 O(台上格数)，不是 O(带长)。
    expect(b / a).toBeLessThan(3);
  });
});
