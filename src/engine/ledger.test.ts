// @vitest-environment node
import { describe, expect, it } from "vitest";
import { compile } from "./compile";
import { guardEntry, MAX_LEDGER } from "./guard";
import { MAIN_TRACK, OpLog } from "./log";
import { decodeTape, encodeTape } from "./share";
import type { Op, OpEntry } from "./types";

/*
 * 这一节钉的是**账本上的号**。前面几节把门修到能管一个 op 自己说了什么（`guard.ts`），而没有管它坐在哪儿：
 * `seq`/`turn`/`track`/`group` 这四个字段在 `restore()` 里几乎原样进来，当时整卷只查了一句
 * `typeof e.seq === "number"`。这四个不是几何，是编号 —— 编号是拿去**发下一个号**的（`log.ts` 那三行
 * reduce：`seq + 1`、`(group ?? -1) + 1`、`Math.max`），而 JSON 里的 `1e999` 解析出来是 `Infinity`，
 * `typeof Infinity === "number"` 恰好通过那句检查。
 *
 * 实测（`decodeTape` → `restore` → `append`，也就是学习者真会点的那条 `#s=` 的路）：档案里一个批号被灌成
 * Infinity，批号计数器就永远钉在 Infinity（`Infinity + 1` 还是 Infinity），于是"接着讲"新落的那一批和档案
 * 里那一批**同号**。同号就是同一批 —— 上一节立起来的那道批的边界当场没了：`{旁白, 占位符}` 落笔时锚点
 * x=700，追加一批 `{往右一屏, 旁白}` 之后成了 x=2300。观众已经看过的那一格又被后落的笔改写了，而这次改写
 * 的源头只是陌生人地址栏里的五个字符。
 *
 * 三种"看着是 number"的号，三个不同的洞：
 *  - `1e999` → Infinity：`Infinity + 1 === Infinity`，批号被钉死；
 *  - `1e300` → 有限、`Number.isInteger` 为真、是 number，而 `1e300 + 1 === 1e300`，同一个下场；这一种躲得
 *    过"只要有限就行"那一版的修法；
 *  - `9007199254740991` → 2^53-1，`Number.isSafeInteger` 最大的那一个，而**它加一之后不再安全**：实测连着
 *    两次追加拿到同一个批号 `[…992, …992]`。撞号不是一个坏镜头，是 `entryAt`、`cutFrom`、答话找题卡同时
 *    指向两格。
 * 所以门要的不是"这个号自己好不好"，是"还能不能从它往上数"：`MAX_LEDGER = 2^40`。一堂一万刀的课是 1e4，
 * 重排一千轮是 1e7 —— 这个上界离任何一堂课隔着三个数量级，而它离数坏隔着一万个。
 *
 * `seq` 那一头走的是另一条路。改前它是整卷里唯一被查过的字段，而查的是 `typeof === "number"`，所以 Infinity、
 * 1e300、2.5、-1 全都进门（实测 `lastSeq === Infinity`，此后每次追加都发同一个号）；反过来 `seq:"3"` 这种
 * **真读不出来**的号，改前被 `decodeTape` 的谓词拿来**整卷**拒绝 —— 一节别人排过的课因为一格写坏了号而完全
 * 打不开，而点链接的人没有犯错。门后来立的规矩（"坏字段被默认，不被整卷拒绝"）一直没跟着改到这一头。
 *
 * 撞号（两格同一个 `seq`）改前也原样进门：实测两张 `seq:0` 的题卡加一句"答第一张"的回答，编译出来的 `gates`
 * 是 `[[0,"甲？",null],[0,"乙？","甲的答案"]]` —— 甲的答案被安到乙那张卡头上。
 *
 * 号这一头的政策因此比 op 那一头更**笨**：把 1e300 "修正"成 0 就是把那一格挪进别人的批次，把 Infinity 的
 * `seq` 重新编号就是把别人的回答挪到隔壁那张卡上。认不出来的号只有两种诚实的下场 —— 这一格说不清自己在哪儿
 * （`seq`、撞号）就当没有落过笔；只是少了一个记号（`turn`、`track`、`group`）就退回这个字段的默认（`0`、
 * 一个不会被任何台读到的记号、"没有这个字段"）。`group` 认不出来当作**没写**，是因为"没写"本来就有一种真实的
 * 意思（旧链接整卷是一批，见 `types.ts`），而当作 0 会替陌生人决定他当时是怎么一批一批落笔的。
 *
 * 三层照旧分开钉：坏号的下场（形状）、门不许误伤合法的号（护栏）、逐格对账。断言全部做在**解释器那一头**
 * （锚点、`gates`、计数器），不是做在门返回了什么。
 */

const line = (text: string, duration = 1000): Op => ({ kind: "narrate", text, duration });
const here = (id: string): Op =>
  ({ kind: "build", id, box: { x: 0, y: 0, w: 200, h: 160 }, label: id, html: `<p>${id}</p>`, here: true }) as Op;
const placed = (id: string, x: number): Op => ({ kind: "build", id, box: { x, y: 0, w: 200, h: 160 }, label: id, html: `<p>${id}</p>` });
const slide = (): Op => ({ kind: "camera", mode: "pan", dir: "right", screens: 1, duration: 900, easing: "ease" }) as Op;
const quiz = (prompt: string): Op => ({ kind: "quiz", prompt, options: ["甲", "乙"], answer: 1 });
const said = (gate: number, text: string): Op => ({ kind: "answer", gate, text });

/** 落笔那一刻它在哪儿。这一节比的全是这一问。 */
const anchorX = (entries: OpEntry[], id: string): number => compile(entries).props.get(id)!.revisions[0].box.x;

/**
 * 一卷真的分享链接。不许用 `encodeTape` 造坏号：那是我们自己的 `JSON.stringify`，它把 Infinity 写成 `null`，
 * 等于先把毒洗掉再测门。陌生人自己压字节 —— `1e999` 在 JSON 里是合法字面量，解析出来就是 Infinity。
 */
async function pack(json: string): Promise<string> {
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 地址栏 → `decodeTape` → `restore`：门上过的带子，和那个会拿号往上续的库。 */
async function open(json: string): Promise<{ tape: OpEntry[]; log: OpLog }> {
  const log = new OpLog();
  log.restore(await decodeTape(await pack(json)));
  return { tape: log.all(), log };
}

/** JSON 里写 Infinity 的两种字面量（`1e999` 溢出、`1e300` 不溢出但加一还是它自己）。 */
const HUGE = "1e999";

/** 一批两刀的档案：一句开场、一个占位符。`ledger` 是灌进这两格账本的那一句。 */
const tampered = (ledger: string): string =>
  `[{"seq":0,"track":"main","turn":0,${ledger},"op":${JSON.stringify(line("开场"))}},` +
  `{"seq":1,"track":"main","turn":0,${ledger},"op":${JSON.stringify(here("甲"))}}]`;

/** 过完门之后接着讲：追加 `n` 批，最后一批收在一句旁白上（`landed.test.ts` 用的那个形状）。 */
async function replay(json: string, n = 1): Promise<{ landed: number; after: number; tape: OpEntry[]; log: OpLog }> {
  const { tape, log } = await open(json);
  const landed = anchorX(tape, "甲");
  for (let i = 0; i < n; i++) log.append(i + 1 === n ? [slide(), line("收住这一拍")] : [slide()], MAIN_TRACK);
  return { landed, after: anchorX(log.all(), "甲"), tape: log.all(), log };
}

describe("账本上的号：陌生人的链接不许重新改写已经落下的那一格", () => {
  it("批号灌成 Infinity：计数器被钉死，新落的那一批和档案同号", async () => {
    // 改前实测：带子上 [null, null, Infinity]，落笔 x=700 → 追加一批 x=2300（`Infinity + 1 === Infinity`，
    // 档案那一批和现场这一批同号 —— 批的边界没了，那一格读到身后已经演过的那一刀镜头）。
    const { landed, after, tape } = await replay(tampered('"group":1e999'));
    expect(landed).toBe(700);
    expect(after).toBe(700);
    // 认不出来的批号当作没写：这一卷演成它假装的那件旧东西（整卷一批），而不是被钉成第 0 批。
    expect(tape.slice(0, 2).map((e) => e.group)).toEqual([undefined, undefined]);
    // 现场续上的那一批有自己的号，从 0 开始数。
    expect(tape.slice(2).map((e) => e.group)).toEqual([0, 0]);
  });

  it("1e300：有限、是整数、是 number，而它加一还是它自己", async () => {
    // 这一种是"只要有限就行"那一版的修法会漏掉的：`Number.isFinite(1e300)` 为真。
    // 改前实测：追加的那两批照样全是 1e300（带子上五个 1e300），落笔 x=700 → 两批之后 x=3900。
    const { landed, after, tape } = await replay(tampered('"group":1e300'), 3);
    expect(after).toBe(landed);
    expect(tape.slice(0, 2).every((e) => e.group === undefined)).toBe(true);
    // 三次工具调用就是三个批号，一个都不许撞。
    const live = tape.slice(2).map((e) => e.group);
    expect(new Set(live).size).toBe(3);
    expect(live).toEqual([0, 1, 2, 2]);
  });

  it("2^53-1 是\"安全整数\"最大的号，也是不能往上续的那个号", async () => {
    // 改前实测：连着两次追加拿到 [9007199254740991, 9007199254740992, 9007199254740992] —— 同一个号发给了
    // 两批。这一格不是坏得离谱，是坏得刚好通过所有"看起来对"的检查，所以上界按"还能从它往上数"算。
    const { tape } = await replay(tampered(`"group":${Number.MAX_SAFE_INTEGER}`), 2);
    expect(tape.slice(0, 2).every((e) => e.group === undefined)).toBe(true);
    expect(tape.slice(2).map((e) => e.group)).toEqual([0, 1, 1]);
  });

  it("上界不是惩罚大数：2^40 是合法的号，而它加一仍然是另一个号", async () => {
    // 门要的是"数得下去"，不是"小"。恰好在上界内的号必须原样进门。
    const { tape, log } = await open(tampered(`"group":${MAX_LEDGER}`));
    expect(tape.map((e) => e.group)).toEqual([MAX_LEDGER, MAX_LEDGER]);
    log.append([slide()], MAIN_TRACK);
    expect(log.all()[2].group).toBe(MAX_LEDGER + 1);
    expect(log.all().map((e) => e.group)).toEqual([MAX_LEDGER, MAX_LEDGER, MAX_LEDGER + 1]);
  });

  it("seq 灌成 Infinity：那一格说不清自己在哪儿，就当真没有落过笔", async () => {
    // 改前实测：那一格带着 Infinity 进门，`lastSeq === Infinity`，此后每次追加都发同一个号（库里三格全是
    // Infinity），于是 `entryAt` 查谁都是同几格，而 `cutFrom(0)` 一次删掉整卷（实测"删了 3 格剩 0 格"）——
    // 学习者想剪回重排一段，剪掉的是整节课。
    const json = `[{"seq":1e999,"track":"main","turn":0,"group":0,"op":${JSON.stringify(line("开场"))}},` +
      `{"seq":1,"track":"main","turn":0,"group":0,"op":${JSON.stringify(here("甲"))}}]`;
    const { tape, log } = await open(json);
    expect(tape.map((e) => e.seq)).toEqual([1]);
    // 整卷没有被丢掉：过不去的是那一格，其余照常演。计数器也不再是 Infinity。
    expect(Number.isSafeInteger(log.lastSeq)).toBe(true);
    log.append([line("接着讲")], MAIN_TRACK);
    expect(log.all()[1].seq).toBe(2);
    expect(new Set(log.all().map((e) => e.seq)).size).toBe(2);
    // 号数得下去，`cutFrom` 才有"切到哪儿"这件事可切。
    expect(log.cutFrom(2)).toBe(1);
    expect(log.all().map((e) => e.seq)).toEqual([1]);
  });

  it("seq 是 2.5 或 -1：不是\"松一点的整数\"，是一个查不到的号", async () => {
    // 改前实测：两种都进门（`typeof` 都通过），于是 `entryAt`/`after`/`cutFrom` 拿着它比 `===` 和 `<` ——
    // 一个非整数号连"切回重排"都会切歪（`seq < 2.5` 切掉 2 也切不掉它自己的那一格）。
    for (const lit of ["2.5", "-1"]) {
      const json = `[{"seq":0,"track":"main","turn":0,"group":0,"op":${JSON.stringify(placed("丙", 40))}},` +
        `{"seq":${lit},"track":"main","turn":0,"group":0,"op":${JSON.stringify(line("这一格的号查不到"))}},` +
        `{"seq":3,"track":"main","turn":1,"group":1,"op":${JSON.stringify(line("这一格是好的"))}}]`;
      const { tape } = await open(json);
      expect(tape.map((e) => e.seq)).toEqual([0, 3]);
      // 那一刀的台词没有被丢掉整卷：别的格子照常演。
      expect(compile(tape).props.get("丙")).toBeTruthy();
    }
  });

  it("坏号不再毁掉整卷：以前一个 `seq:\"3\"` 就把别人的一节课关在门外", async () => {
    // 改前 `decodeTape` 的谓词是"有一格的 seq 不是 number 就整卷抛错"。门后来立的规矩是"坏字段被默认，
    // 不被整卷拒绝"（点链接的人没有犯错）—— 这一头一直没跟着改。
    const json = `[{"seq":0,"track":"main","turn":0,"group":0,"op":${JSON.stringify(placed("丙", 40))}},` +
      `{"seq":"3","track":"main","turn":0,"group":1,"op":${JSON.stringify(line("号是字符串"))}},` +
      `{"seq":4,"track":"main","turn":1,"group":1,"op":${JSON.stringify(line("这一格是好的"))}}]`;
    const { tape } = await open(json);
    expect(tape.map((e) => e.seq)).toEqual([0, 4]);
    expect(anchorX(tape, "丙")).toBe(40);
  });

  it("track 不是字符串：那一格记成\"落在某个台上\"，既不搬进 main，也不许丢掉", async () => {
    // 改前实测：`asides()` 是 [null, 42] —— 那几刀停在一个没人演的台上（`runtime.ts` 只演 main 和最后一个
    // aside），学习者永远看不见它们，而带子上写着它们存在。门也不许把它们搬进真正的台面：那是替陌生人决定
    // 他的课在哪儿演。它们落在一个记号上 —— 看得见"有这么一格"，演不到任何一堂课上。
    const json = `[{"seq":0,"track":"main","turn":0,"group":0,"op":${JSON.stringify(line("台上"))}},` +
      `{"seq":1,"track":null,"turn":0,"group":0,"op":${JSON.stringify(line("null"))}},` +
      `{"seq":2,"track":42,"turn":0,"group":0,"op":${JSON.stringify(line("四十二"))}},` +
      `{"seq":3,"track":"","turn":0,"group":0,"op":${JSON.stringify(line("空"))}}]`;
    const { log, tape } = await open(json);
    expect(tape.length).toBe(4);
    expect(log.ofTrack(MAIN_TRACK).map((e) => e.seq)).toEqual([0]);
    expect(log.ofTrack("*").map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log.asides()).toEqual(["*"]);
  });

  it("turn 灌成 Infinity：轮次退回第一轮，不许把号带到下一轮上", async () => {
    // 改前实测：`currentTurn` 变成 Infinity（`Math.max(m, Infinity)`），`nextTurn()` 是 Infinity+1 —— 还是
    // Infinity，于是每一轮同号，而带子上的 turn 本身就是 Infinity。
    const { tape, log } = await open(tampered(`"group":0,"turn":${HUGE}`));
    expect(tape.map((e) => e.turn)).toEqual([0, 0]);
    expect(Number.isSafeInteger(log.currentTurn)).toBe(true);
    log.nextTurn();
    log.append([line("下一轮")], MAIN_TRACK);
    expect(log.all()[2].turn).toBe(1);
  });

  it("两个号撞在同一格：一个答案不许同时答两张卡", async () => {
    // 改前实测：`gates` 是 [[0,"甲？",null],[0,"乙？","甲的答案"]] —— 甲的答案落到了乙那张卡头上。号不许在
    // 这一头重编（那是挪格子），所以数组里在前面的那一句算数，后面那一格当作说不清自己在哪儿。
    const json = `[{"seq":0,"track":"main","turn":0,"group":0,"op":${JSON.stringify(quiz("甲？"))}},` +
      `{"seq":0,"track":"main","turn":0,"group":0,"op":${JSON.stringify(quiz("乙？"))}},` +
      `{"seq":1,"track":"main","turn":0,"group":0,"op":${JSON.stringify(said(0, "甲的答案"))}}]`;
    const { tape } = await open(json);
    expect(compile(tape).gates.map((g) => [g.seq, g.said])).toEqual([[0, "甲的答案"]]);
    expect(new Set(tape.map((e) => e.seq)).size).toBe(tape.length);
    // 剩下的那两格还是它们自己的号：门没有重编任何号。
    expect(tape.map((e) => e.seq)).toEqual([0, 1]);
  });
});

/*
 * 门不许误伤。这一组每一条都在说"这样的号是合法的，门一手都不许动"。它们最容易在修坏号那天被顺手改坏：
 * `isSafeInteger` 写成 `isInteger` 是修少了，把坏号"改成"一个好号是修过头 —— 后者在这一组里当场红，因为
 * 这里钉的是**原样的号**（连"给旧链接补一个 0"这种好意也算修过头）。
 */
describe("门不许误伤：合法的账本长这个样子", () => {
  it("门重做一格的时候，合法的号要跟着搬过去", () => {
    // 这一条钉的是"门只改它认不出来的那一个字段"。同一格里 `turn` 是坏的、`group` 是好的：门必须把
    // turn 退回默认，而把那个批号**原样带着** —— 把它当成没写，就等于替陌生人把他分三次落的东西并成一批。
    const l = new OpLog();
    l.restore([
      { seq: 0, track: MAIN_TRACK, turn: Infinity, group: 5, op: line("甲") },
      { seq: 1, track: MAIN_TRACK, turn: 2, group: 5, op: line("乙") },
    ]);
    expect(l.all().map((e) => [e.turn, e.group])).toEqual([[0, 5], [2, 5]]);
    l.append([line("丙")], MAIN_TRACK);
    expect(l.all()[2].group).toBe(6);
    // 批的边界还在：换批了，所以已经落下的那两格不许被这一批改写。
    const withHere = new OpLog();
    withHere.restore([
      { seq: 0, track: MAIN_TRACK, turn: null, group: 4, op: line("开场") } as unknown as OpEntry,
      { seq: 1, track: MAIN_TRACK, turn: 0, group: 4, op: here("甲") },
    ]);
    expect(withHere.all().map((e) => e.group)).toEqual([4, 4]);
    withHere.append([slide()], MAIN_TRACK);
    expect(anchorX(withHere.all(), "甲")).toBe(anchorX(withHere.all().slice(0, 2), "甲"));
  });

  it("带子可以乱序进来：门按号排，而不按号改", () => {
    // `restore` 一直有这一行 sort（`#s=` 的字节是别人拼的，次序不保证）。门不许把它变成第二套语义：
    // 排的次序用号，号的本身一个都不动。
    const l = new OpLog();
    l.restore([
      { seq: 9, track: MAIN_TRACK, turn: 3, group: 2, op: line("最后落笔") },
      { seq: 1, track: MAIN_TRACK, turn: 0, group: 0, op: line("最先落笔") },
      { seq: 5, track: MAIN_TRACK, turn: 1, group: 1, op: line("中间") },
    ]);
    expect(l.all().map((e) => e.seq)).toEqual([1, 5, 9]);
    expect(l.all().map((e) => e.group)).toEqual([0, 1, 2]);
    expect(l.all().map((e) => e.turn)).toEqual([0, 1, 3]);
    l.append([line("新的")], MAIN_TRACK);
    expect(l.all()[3].seq).toBe(10);
    expect(l.all()[3].group).toBe(3);
  });

  it("号可以比带子长：cut 过的带子本来就是有洞的", () => {    // 重演一段之后剩下的号是不连续的（`cutFrom` 那句"洞本身就是重排过的记录"）。门不许把它们挤齐。
    const l = new OpLog();
    l.restore([
      { seq: 0, track: MAIN_TRACK, turn: 0, group: 0, op: line("甲") },
      { seq: 1, track: MAIN_TRACK, turn: 0, group: 1, op: line("乙") },
      { seq: 900, track: MAIN_TRACK, turn: 5, group: 5, op: line("丙") },
      { seq: 901, track: MAIN_TRACK, turn: 5, group: 5, op: line("丁") },
    ]);
    expect(l.all().map((e) => e.seq)).toEqual([0, 1, 900, 901]);
    expect(l.all().map((e) => e.group)).toEqual([0, 1, 5, 5]);
    // 按最大号续，不是按长度续：新落的那一批不许和档案里某一批同号。
    l.append([line("戊")], MAIN_TRACK);
    expect(l.all()[4].group).toBe(6);
    expect(l.all()[4].seq).toBe(902);
    expect(l.lastSeq).toBe(903);
  });

  it("现场 cut 完再续讲的带子再过一次门，号一个都不许变", () => {
    const l = new OpLog();
    l.append([line("甲"), line("乙"), line("丙"), line("丁")], MAIN_TRACK);
    l.cutFrom(2);
    l.append([line("戊")], MAIN_TRACK);
    expect(l.all().map((e) => [e.seq, e.group])).toEqual([[0, 0], [1, 0], [2, 1]]);
    const back = new OpLog();
    back.restore(l.export());
    expect(back.all().map((e) => [e.seq, e.turn, e.group])).toEqual(l.all().map((e) => [e.seq, e.turn, e.group]));
    back.append([line("己")], MAIN_TRACK);
    expect(back.all()[3].group).toBe(2);
  });

  it("批号允许跳号、允许倒序：那是别人怎么落笔的事实", () => {
    // `group` 是"哪一批落下的"这个记号，不是下标：带子上可以只剩某一批的几格，那个号照样是它当时的号。
    const l = new OpLog();
    l.restore([
      { seq: 0, track: MAIN_TRACK, turn: 0, group: 7, op: line("甲") },
      { seq: 1, track: MAIN_TRACK, turn: 0, group: 3, op: line("乙") },
    ]);
    expect(l.all().map((e) => e.group)).toEqual([7, 3]);
    l.append([line("丙")], MAIN_TRACK);
    expect(l.all()[2].group).toBe(8);
  });

  it("旧链接没有批号：门不许给它编一个", async () => {
    // 缺 `group` 是"整卷一批"（`types.ts`）。门若把它写成 0，别人的课就变成"第 0 批"，而现场续讲的那一批
    // 也是 0 —— 修一个洞挖一个洞。
    const json = `[{"seq":0,"track":"main","turn":0,"op":${JSON.stringify(line("开场"))}},` +
      `{"seq":1,"track":"main","turn":0,"op":${JSON.stringify(here("甲"))}},` +
      `{"seq":2,"track":"main","turn":0,"op":${JSON.stringify(slide())}},` +
      `{"seq":3,"track":"main","turn":0,"op":${JSON.stringify(line("第二句"))}}]`;
    const { tape, log } = await open(json);
    expect(tape.every((e) => !Object.prototype.hasOwnProperty.call(e, "group"))).toBe(true);
    // 整卷一批的行为没变：那一格跟着同批的镜头走（`landed.test.ts` 钉的 x=2300）。
    expect(anchorX(tape, "甲")).toBe(2300);
    log.append([slide()], MAIN_TRACK);
    // 现场这一批从 0 数起，而档案那一卷没有号 —— 换批，于是已经落下的那一格不动。
    expect(log.all()[4].group).toBe(0);
    expect(anchorX(log.all(), "甲")).toBe(2300);
  });

  it("干净的带子过门一格都不重做：identity 是 show 自己在用的", () => {
    const tape: OpEntry[] = [
      { seq: 0, track: MAIN_TRACK, turn: 0, group: 0, op: placed("a", 40) },
      { seq: 1, track: MAIN_TRACK, turn: 0, group: 0, op: line("一") },
      { seq: 2, track: "aside:1", turn: 1, group: 1, op: line("二") },
    ];
    const l = new OpLog();
    l.restore(tape);
    // 整格原样出去：`compile` 拿 op 本身当 `shotAt` 的键，门不许把引用换掉。
    for (const e of tape) expect(l.all().includes(e)).toBe(true);
    // 幂等：门再走一遍不许把它改成另一个对象。
    for (const e of l.all()) expect(guardEntry(e)).toBe(e);
  });

  it("分享一个来回，账本上的号一个都不许变", async () => {
    const l = new OpLog();
    l.append([line("甲"), placed("乙", 100)], MAIN_TRACK);
    l.nextTurn();
    l.append([line("丙")], "aside:1");
    const shape = (e: OpEntry) => [e.seq, e.track, e.turn, e.group ?? "absent"];
    const before = l.export().map(shape);
    const back = new OpLog();
    back.restore(await decodeTape(await encodeTape(l.export())));
    expect(back.export().map(shape)).toEqual(before);
    expect(before).toEqual([[0, "main", 0, 0], [1, "main", 0, 0], [2, "aside:1", 1, 1]]);
  });

  it("一堂正常的课过了门，排出来的台面和没过门时逐字相同", () => {
    const ops = [line("开场"), here("甲"), slide(), line("第二句"), quiz("几？"), said(4, "乙")];
    const direct: OpEntry[] = ops.map((op, seq) => ({ seq, track: MAIN_TRACK, turn: 0, group: 0, op }));
    const l = new OpLog();
    l.restore(direct);
    const through = compile(l.all());
    const before = compile(direct);
    expect(through.cues.map((c) => [c.t, c.to.x, c.to.w])).toEqual(before.cues.map((c) => [c.t, c.to.x, c.to.w]));
    expect(through.gates.map((g) => [g.seq, g.said])).toEqual(before.gates.map((g) => [g.seq, g.said]));
    expect(through.duration).toBe(before.duration);
  });
});

/*
 * 对账那一头：往账本里灌任意一种毒，逐格比"落笔那一刻它在哪"和"现在还在那儿吗"。参照还是上一节那一份 ——
 * 整卷重排。它比上面那些单点强在两头都管：门修少了（某个号还能把计数器带跑）会在"移动"那一格上红，门修过头
 * （把不该丢的一格丢了）会在"少了一格"上红，因为参照里有它。
 */
describe("账本上的号：逐格对账", () => {
  /**
   * 三批落下的骨架：一句开场加一个占位符是一批，第二句话加第二个占位符是一批，最后单独一个占位符是一批
   * —— 它是**带子上最后那一格**，所以它的批号一旦被灌成 Infinity，现场续讲的那一批就正好排在它身后同批，
   * 那一格的视线就会读到追加的那一刀镜头（改前实测：落笔 700 → 2300）。三个 `here` 分在三批里。
   */
  const SPECS: { seq: number; turn: number; group: number; op: Op }[] = [
    { seq: 0, turn: 0, group: 0, op: line("开场") },
    { seq: 1, turn: 0, group: 0, op: here("甲") },
    { seq: 2, turn: 1, group: 1, op: line("第二句") },
    { seq: 3, turn: 1, group: 1, op: here("乙") },
    { seq: 4, turn: 2, group: 2, op: here("丙") },
  ];

  type Field = "seq" | "track" | "turn" | "group";

  /** 把某一格的某个账本字段写成字面量（走 JSON，所以 `1e999` 真的是 Infinity）。`at = -1` 是不毒。 */
  function score(at: number, field: Field, lit: string): string {
    return `[${SPECS.map((s, i) => {
      const v: Record<Field, string> = { seq: String(s.seq), track: '"main"', turn: String(s.turn), group: String(s.group) };
      if (i === at) v[field] = lit;
      return `{"seq":${v.seq},"track":${v.track},"turn":${v.turn},"group":${v.group},"op":${JSON.stringify(s.op)}}`;
    }).join(",")}]`;
  }

  const POISONS: [number, Field, string][] = [
    // 最后一格的批号：动的是那一格的落点。
    [4, "group", "1e999"],
    [4, "group", "1e300"],
    [4, "group", String(Number.MAX_SAFE_INTEGER)],
    [4, "group", "-1"],
    [4, "group", "2.5"],
    [4, "group", "null"],
    [4, "group", '"x"'],
    // 中间一格的批号：动不了落点，但计数器是整卷一起数的，所以照样钉住。
    [1, "group", "1e999"],
    // 号：说不清自己在哪儿的那些格。
    [0, "seq", "1e999"],
    [0, "seq", "1e300"],
    [0, "seq", "-2"],
    [0, "seq", "2.5"],
    [0, "seq", '"2"'],
    [4, "seq", "0"], // 撞第一格的号
    [2, "turn", "1e999"],
    [2, "turn", "-3"],
    [2, "turn", "2.5"],
    [2, "turn", "null"],
    [3, "track", "null"],
    [3, "track", "42"],
    [3, "track", '""'],
  ];

  let compared = 0;
  let dropped = 0;
  for (const [at, field, lit] of POISONS) {
    it(`灌坏第 ${at} 格的 ${field} = ${lit}：已经落下的格子一个都不许动`, async () => {
      const { tape, log } = await open(score(at, field, lit));
      const landed = compile(tape).props;
      log.append([slide(), line("接着讲")], MAIN_TRACK);
      const now = compile(log.all()).props;
      for (const [id, p] of landed) {
        for (let i = 0; i < p.revisions.length; i++) {
          const back = now.get(id)?.revisions[i]?.box;
          if (!back) throw new Error(`${field}=${lit}：${id}#${i} 从道具表里掉了 —— 门把不该丢的一格弄丢了`);
          expect(back).toEqual(p.revisions[i].box);
          compared++;
        }
      }
      const after = log.all();
      // 带子上的号现在都得数得下去。
      expect(new Set(after.map((e) => e.seq)).size).toBe(after.length);
      expect(after.every((e) => Number.isSafeInteger(e.seq) && e.seq >= 0 && e.seq <= MAX_LEDGER)).toBe(true);
      expect(after.every((e) => Number.isSafeInteger(e.turn) && e.turn >= 0)).toBe(true);
      expect(after.every((e) => e.group === undefined || (Number.isSafeInteger(e.group) && e.group >= 0 && e.group <= MAX_LEDGER))).toBe(true);
      expect(after.every((e) => typeof e.track === "string" && e.track.length > 0)).toBe(true);
      // 号被毒掉的那一格：整格不在（说不清自己在哪儿），别的格一格不少。追加的那一批是两刀。
      if (field === "seq") {
        expect(after.length).toBe(SPECS.length + 1);
        dropped++;
      } else {
        expect(after.length).toBe(SPECS.length + 2);
      }
    });
  }

  it("探针不许空转：上面那一串真的比过落点，也真的掉过格子", () => {
    expect(dropped).toBe(6); // seq 那一组：六个坏号（含撞号那格）都该掉
    expect(compared).toBeGreaterThan(50);
  });

  it("反向钉一条：不毒的时候，过门的带子和一批一批现场落的带子逐字同解", async () => {
    // 门不许成为第二套语义：同一卷骨架，`append` 三次落下来和压进链接再开门，台面必须相同。
    const live = new OpLog();
    live.append([SPECS[0].op, SPECS[1].op], MAIN_TRACK);
    live.append([SPECS[2].op, SPECS[3].op], MAIN_TRACK);
    live.append([SPECS[4].op], MAIN_TRACK);
    const { tape } = await open(score(-1, "group", "0"));
    expect(tape.map((e) => [e.seq, e.group])).toEqual(live.all().map((e) => [e.seq, e.group]));
    const a = compile(tape);
    const b = compile(live.all());
    expect(a.cues.map((c) => [c.t, c.to.x])).toEqual(b.cues.map((c) => [c.t, c.to.x]));
    for (const [id, p] of b.props) {
      for (let i = 0; i < p.revisions.length; i++) expect(a.props.get(id)!.revisions[i].box).toEqual(p.revisions[i].box);
    }
  });
});
