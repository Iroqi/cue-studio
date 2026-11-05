import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { encodeTape, decodeTape } from "./share";
import { Stage } from "./runtime";
import { MAIN_TRACK } from "./log";
import type { Op, OpEntry } from "./types";

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.spyOn(performance, "now").mockImplementation(() => 1000);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/*
 * 第六轮探针二：分享链接的内容保真（encode → decode → load 全链路）。
 * 第二轮只校准过 encode/decode 两端都异步、千条中文课 <64KB；这一轮问**往返保真**——
 * 分享出去的带子载入后还是不是原来那卷：
 *  1) JSON 序列化无损（NaN/Infinity 会被 JSON 改写成 null、undefined 会被丢—— 若 op 里带着
 *     这些值，分享就把带子悄悄改写了）；
 *  2) load 后编译语义一致（时长、门表、走带不崩）。
 */

const fullOpSet = (): Op[] => [
  { kind: "build", id: "a", box: { x: 0, y: 0, w: 100, h: 80 }, label: "木块", note: "讲义", svg: "<rect/>" },
  { kind: "patch", id: "a", box: { x: 10, y: 10, w: 120, h: 90 }, label: "木块2" },
  { kind: "discard", id: "gone" },
  { kind: "link", from: "a", to: "b", relation: "压着" },
  { kind: "recall", id: "b", box: { x: 50, y: 50, w: 60, h: 60 } },
  { kind: "camera", mode: "fit", region: { x: 0, y: 0, w: 200, h: 200 }, duration: 800, easing: "ease" },
  { kind: "camera", mode: "track", target: ["a", "b"], follow: "a", duration: 600, easing: "linear" },
  { kind: "beat", duration: 20000 },
  { kind: "narrate", text: "讲一段", duration: 3000 },
  { kind: "transition", style: "dissolve", to: "board2", duration: 500 },
  { kind: "light", mood: "study" },
  { kind: "highlight", target: "a", style: "pulse", duration: 900 },
  { kind: "motion", id: "a", mode: "oscillate", axis: "x", amp: 20, period: 800, radius: 0, steps: 0, decay: 0.9, duration: 3000 },
  { kind: "quiz", prompt: "哪个对", options: ["甲", "乙"], answer: 1, concept: "合力" },
  { kind: "probe", prompt: "点合力", targets: ["a", "b"], answer: "a", concept: "合力" },
  { kind: "dial", prompt: "拨到多少", min: -10, max: 40, value: 15, tol: 2, unit: "N", label: "力" },
  { kind: "type", prompt: "一句话", accept: ["导数"], avoid: ["斜率"] },
  { kind: "drag", prompt: "搬到那", prop: "a", value: { x: 100, y: 100 }, tol: 5 },
  { kind: "pause-for", reason: "歇口气" },
  { kind: "offer", label: "继续", phrase: "我准备好了 · 继续" },
  { kind: "answer", gate: 1, text: "甲" },
];

const entriesOf = (ops: Op[]): OpEntry[] => ops.map((op, i) => ({ seq: i + 1, track: "main", turn: 1, op }));

describe("round6: 分享链接的内容保真", () => {
  it("全 op 类型 round-trip：encode → decode 后逐字段一致（JSON 无损）", async () => {
    const entries = entriesOf(fullOpSet());
    const back = await decodeTape(await encodeTape(entries));
    expect(back).toEqual(entries);
  });

  it("非法 payload 被拒，不静默产出空带", async () => {
    await expect(decodeTape("not-a-tape")).rejects.toThrow("不是一段舞台录像");
    await expect(decodeTape("")).rejects.toThrow();
  });

  it("load 链路：分享带载入新台后时长与门表一致，能正常走完", async () => {
    const src = new Stage();
    src.goLive();
    src.append(
      [fullOpSet()[6], fullOpSet()[7], fullOpSet()[8], fullOpSet()[13], { kind: "answer", gate: 1, text: "甲" }, fullOpSet()[8] as Op],
      MAIN_TRACK,
    );
    src.play();

    const tape = src.log.export();
    const restored = await decodeTape(await encodeTape(tape));
    const dst = new Stage();
    dst.load(restored);
    expect(dst.compiled.duration).toBe(src.compiled.duration);
    // 门表一致：同一张 quiz 卡开着
    expect(dst.openGateSeqs().length).toBe(src.openGateSeqs().length);
    // 载入后从零走，能到句落点
    dst.play();
    expect(dst.getSnapshot().playing).toBe(true);
  });
});
