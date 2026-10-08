import { describe, expect, it } from "vitest";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import type { Box, Op } from "./types";

/*
 * `agentSnapshot()` 是导演每一轮都要读的那段 `<stage>`：它进 transcript 当 tool result，所以它
 * 的长度就是模型的上下文。`budget.ts` 从外头关上"一轮不许塞太多"，这里关的是里头那一头 ——
 * 一堂讲了两万拍的课，台上有两百格、说过两万句，快照要是照着台账一行行抄，它自己就把导演压到
 * 天花板底下，然后被 deflate 成一个指针。被 deflate 的 `<stage>` 比短的更糟：导演看不见自己说过
 * 什么，于是把已经念过的台词再念一遍、把观众已经看见的那格再画一遍。
 *
 * 所以这一份的断言只有一件事：**价钱跟"这一屏装得下多少"走，不跟"这堂课讲过多长"走**。
 * 折掉的那些必须留下数目，并且点名把它读回来的那把工具 —— 不许静悄悄地少。
 */

const at = (x: number, y: number): Box => ({ x, y, w: 200, h: 160 });

/** 一长串"讲一句、落一格"，格数与拍数都随 n 涨。 */
const lesson = (n: number): Op[] => {
  const ops: Op[] = [{ kind: "camera", mode: "fit", target: [], duration: 200, easing: "ease" }];
  for (let i = 0; i < n; i++) {
    ops.push({ kind: "narrate", text: `第 ${i} 句：这里要说的是这一个概念`, duration: 300 });
    ops.push({
      kind: "build",
      id: `p${i}`,
      label: `格 ${i}`,
      html: `<p>${i}</p>`,
      // 绝大多数落在镜头框外：真课也是这样，能同时看见的就那么几格。
      box: at(i % 4 === 0 ? 100 : 90_000, i % 4 === 0 ? 100 : 90_000),
    });
  }
  return ops;
};

const stageOf = (ops: Op[]) => {
  const s = new Stage();
  s.append(ops, MAIN_TRACK);
  s.setTurnOpen(true);
  s.seek(s.compiled.duration);
  return s;
};

/** 被列出来的那几行：以两个空格开头、带 `[板]` 的那些。 */
const listedRows = (snap: string) => snap.split("\n").filter((l) => /^ {2}\S+ \[/.test(l));
const foldRow = (snap: string, head: string) => snap.split("\n").find((l) => l.trimStart().startsWith(head));

describe("snapshot：导演的窗口不许随课长", () => {
  it("两万拍不许产出两万行", () => {
    const small = stageOf(lesson(200)).agentSnapshot();
    const big = stageOf(lesson(20_000)).agentSnapshot();
    // 行数：一屏能列的就那么些，多出来的折成一句。
    expect(listedRows(big).length).toBeLessThanOrEqual(40);
    // 拍：只引尾巴，前面说过的折成一句带数目。
    const beats = big.split("beats already on the tape")[1] ?? "";
    expect(beats.split("\n").filter((l) => /^\s+\d+\./.test(l)).length).toBeLessThanOrEqual(12);
    // 价钱：整段的长度不许随课长成倍涨。留 4 倍余量是因为"格 19999"这类名字本身变长了，
    // 不是因为多列了几千行。
    expect(big.length).toBeLessThan(small.length * 4);
    expect(big.length).toBeLessThan(16_000);
  });

  it("折掉的每一格都留下数目，并点名读回来的工具", () => {
    const snap = stageOf(lesson(400)).agentSnapshot();
    const fold = foldRow(snap, "…台上还有");
    expect(fold).toBeDefined();
    // 这一屏里绝大多数格子落在镜头框外，那一类必须说"pan/fit 才看得见"。
    expect(fold).toContain("格在镜头框外");
    expect(fold).toContain("fetch_prop");
    // 数目不许是假的：列出的 + 折掉的 = 台上真有外观的格数。
    const staged = stageOf(lesson(400)).compiled.frame.staged.props.length;
    const n = Number(/台上还有 (\d+) 格/.exec(fold!)![1]);
    expect(listedRows(snap).length + n).toBe(staged);
  });

  it("框内多到装不下时，折掉的那一类说的是'这一屏只列这么多'，不是'在镜头框外'", () => {
    // 四十多格全落在镜头框里 —— 这是真会发生的形状（一堂板上画满了一屏）。
    const ops: Op[] = [];
    for (let i = 0; i < 60; i++) ops.push({ kind: "build", id: `p${i}`, label: `格 ${i}`, html: "<p>x</p>", box: at(20 + i * 24, 20) });
    const snap = stageOf(ops).agentSnapshot();
    const fold = foldRow(snap, "…台上还有");
    expect(fold).toContain("这一屏只列 40 格");
    expect(fold).not.toContain("格在镜头框外");
    expect(fold).not.toContain("换场扫走");
    expect(listedRows(snap)).toHaveLength(40);
  });

  it("台词只引尾巴，并且给出从哪儿开始折", () => {
    const snap = stageOf(lesson(300)).agentSnapshot();
    const fold = foldRow(snap, "…前面还有");
    expect(fold).toBeDefined();
    expect(/前面还有 (\d+) 拍说过了/.exec(fold!)![1]).toBe("288");
    // 尾巴那十二拍必须真是最后十二拍：编号连着，最后一号是列出来的行数。
    const rows = (snap.split("beats already on the tape")[1] ?? "").split("\n").filter((l) => /^\s+\d+\./.test(l));
    expect(rows[rows.length - 1]).toContain(" 300.");
    expect(rows[0]).toContain(" 289.");
  });

  it("只被 link 念过、还没有样子的名字不许占一行，也不许占一个数目", () => {
    const ops: Op[] = [
      { kind: "build", id: "vec-r", label: "r", html: "<p>r</p>", box: at(100, 100) },
      { kind: "link", from: "ghost", to: "vec-r", relation: "points-to" },
    ];
    const s = stageOf(ops);
    expect(s.compiled.props.has("ghost")).toBe(true);
    const snap = s.agentSnapshot();
    expect(snap).not.toMatch(/^\s*ghost/m);
    // 它连"折掉了 N 格"里那个 N 都不该算进去。
    expect(snap).not.toContain("台上还有");
  });

  it("还没换过场时，板那一行说的是无限画布，不许凭空点名一块板", () => {
    const snap = stageOf([{ kind: "build", id: "a", label: "a", html: "<p>a</p>", box: at(100, 100) } as Op]).agentSnapshot();
    expect(snap).toContain("还没换过场");
    expect(snap).not.toContain("standing on board");
  });

  it("板多到看不见时，只点名脚下与框内的那几块，其余折成数目", () => {
    const ops: Op[] = [];
    for (let i = 0; i < 80; i++) ops.push({ kind: "build", id: `p${i}`, scene: `board-${i}`, label: `格 ${i}`, html: "<p>x</p>", box: at(90_000 + i * 500, 90_000) });
    ops.push({ kind: "transition", style: "dissolve", to: "board-3", duration: 700 });
    const snap = stageOf(ops).agentSnapshot();
    const scenes = /scenes: (.+)/.exec(snap)![1];
    expect(scenes).toContain("board-3");
    expect(scenes).toContain("块板不在视野里");
    expect(scenes.split(" ").length).toBeLessThan(20);
  });
});
