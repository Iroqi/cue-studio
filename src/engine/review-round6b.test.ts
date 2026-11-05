import { describe, expect, it } from "vitest";
import { describeOp } from "../ui/rows";
import { MAIN_TRACK } from "./log";
import type { Op } from "./types";

/*
 * 第六轮修复的回归钉：日志行对停表卡的描述完整性。
 * `describeOp` 给 build/patch/recall/discard/camera/narrate/transition/light/highlight/motion/
 * beat/quiz/answer/pause-for/link 都印了内容，但 probe / dial / type / drag / offer 五种没有
 * 专属分支，落进 `default` 只印一个类型名 —— 日志里"指认、拨杆、打字、搬动、按钮"这五张卡
 * 完全看不出问了什么。与第二轮修掉的 camera 裸字符串（"日志里那刀镜头印不出名字"）同属
 * 描述层遗漏：卡上明明有 prompt/label，日志却把它扔了。
 *
 * 修复：rows.tsx 补五个分支，与其它卡同一套措辞（指认/拨杆/打字/搬动/按钮 + 内容）。
 */
const entry = (op: Op) => ({ seq: 1, track: MAIN_TRACK, turn: 1, op });

describe("round6b: describeOp 印出五种卡的内容", () => {
  it("probe 印出问题与可点目标", () => {
    expect(describeOp(entry({ kind: "probe", prompt: "点合力", targets: ["a", "b"], answer: "a" }), new Map())).toBe("指认 点合力（a+b）");
  });

  it("dial 印出问题", () => {
    expect(describeOp(entry({ kind: "dial", prompt: "拨到多少", min: 0, max: 10, value: 5, tol: 1 }), new Map())).toBe("拨杆 拨到多少");
  });

  it("type 印出问题", () => {
    expect(describeOp(entry({ kind: "type", prompt: "一句话说清导数", accept: ["导数"] }), new Map())).toBe("打字 一句话说清导数");
  });

  it("drag 印出问题", () => {
    expect(describeOp(entry({ kind: "drag", prompt: "把石头滚到谷底", prop: "a", value: { x: 1, y: 1 }, tol: 1 }), new Map())).toBe("搬动 把石头滚到谷底");
  });

  it("offer 印出按钮字", () => {
    expect(describeOp(entry({ kind: "offer", label: "继续", phrase: "继续" }), new Map())).toBe("按钮 继续");
  });

  it("未知 kind 仍回退类型名（default 兜底不崩）", () => {
    expect(describeOp(entry({ kind: "future-thing" } as unknown as Op), new Map())).toBe("future-thing");
  });
});
