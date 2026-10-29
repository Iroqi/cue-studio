import { describe, expect, it } from "vitest";
import { prune } from "../agent/budget";
import type { Message } from "@earendil-works/pi-ai";
import { guardOp } from "./guard";
import { verseRows } from "./reveal";
import { speechMs } from "./speech";
import { beatAt } from "../ui/score";
import type { Beat } from "./types";

/*
 * 2026-10 深度 review 的一组回归钉：每一条都是这次 review 实测量出来的行为，钉在这里不许退回。
 *
 *  - guard 的 dial 等值对：min === max === ±BIG 时，等值对加宽会越过门自己承诺的 ±1e6 —— 修复是
 *    加宽后夹回界内。
 *  - guard 的 camera 长名 target：单个超长字符串被改写成单元素数组，同一卷带子上短名是字符串、
 *    长名是数组，两副形状 —— 修复是保持字符串形状（类型本就允许 string | string[]）。
 *  - budget.prune 的最近窗口：最后 KEEP_RECENT 组的内容（thinking 签名、新鲜的画、活着的工具配对）
 *    整组不许碰，所以"最近几组本身就超窗"时转录会短暂站在窗口上方 —— 这是有意的线规（Anthropic
 *    的 thinking 签名必须随工具同行），旧组一老化就回落，不是缺陷。钉的是"它确实只碰旧组"。
 *  - beatAt 的尾巴拍：`Math.max(end, start + 1)` 是半开窗 —— end 没合上的尾巴拍只算站 start+1ms，
 *    时钟越过窗口就算不在任何一拍。钉的是这两句。
 */

const sys = { role: "system", content: "S", timestamp: 0 } as Message;
const user = (t: string) => ({ role: "user", content: t, timestamp: 0 }) as Message;
const asst = (c: Message["content"]) => ({ role: "assistant", content: c, stopReason: "toolUse", timestamp: 0 }) as Message;
const tool = (text: string) => ({ role: "toolResult", toolCallId: "c", toolName: "x", content: [{ type: "text", text }], timestamp: 0 }) as Message;

describe("guard：dial 等值对的加宽不得越过 ±1e6 的界", () => {
  it("min === max === +BIG 时，加宽后的杆仍在该界内", () => {
    const op = guardOp({ kind: "dial", prompt: "p", min: 1_000_000, max: 1_000_000, value: 1_000_000, tol: 0 } as never) as {
      min: number;
      max: number;
      value: number;
    };
    expect(op.min).toBeGreaterThanOrEqual(-1_000_000);
    expect(op.max).toBeLessThanOrEqual(1_000_000);
    expect(op.min).toBeLessThan(op.max);
    expect(op.value).toBeGreaterThanOrEqual(op.min);
    expect(op.value).toBeLessThanOrEqual(op.max);
  });

  it("min === max === -BIG 时同理", () => {
    const op = guardOp({ kind: "dial", prompt: "p", min: -1_000_000, max: -1_000_000, value: -1_000_000, tol: 0 } as never) as {
      min: number;
      max: number;
      value: number;
    };
    expect(op.min).toBeGreaterThanOrEqual(-1_000_000);
    expect(op.max).toBeLessThanOrEqual(1_000_000);
    expect(op.min).toBeLessThan(op.max);
    expect(op.value).toBeGreaterThanOrEqual(op.min);
    expect(op.value).toBeLessThanOrEqual(op.max);
  });
});

describe("guard：camera 单个长 target 保持字符串形状", () => {
  it("超长的字符串 target 被截断，但形状不变（不进数组）", () => {
    const long = "t".repeat(200);
    const op = guardOp({ kind: "camera", mode: "fit", target: long, duration: 900 } as never) as { target?: string | string[] };
    expect(typeof op.target).toBe("string");
    expect((op.target as string).length).toBe(120);
  });

  it("短字符串 target 原样不动", () => {
    const op = guardOp({ kind: "camera", mode: "fit", target: "vec-a", duration: 900 } as never) as { target?: string | string[] };
    expect(op.target).toBe("vec-a");
  });
});

describe("budget.prune：只碰旧组，最近窗口整组不动", () => {
  it("旧的重组会被折回指针", () => {
    const big = "a".repeat(1000);
    const messages = [sys, user("q"), asst([{ type: "toolCall", id: "1", name: "build", arguments: { id: "x", svg: big } }]), tool("built x"), user("q2")];
    const out = prune(messages, 500, 0);
    expect(out.collapsed).toBeGreaterThan(0);
    expect(out.chars).toBeLessThanOrEqual(500);
  });

  it("最近几组本身超窗时，prune 站在窗口上方也不碰它们（Anthropic thinking 签名必须随工具同行）", () => {
    const big = "b".repeat(1000);
    const messages: Message[] = [sys, user("q")];
    for (let i = 0; i < 3; i++) {
      messages.push(asst([{ type: "toolCall", id: `${i}`, name: "build", arguments: { id: `x${i}`, svg: big } }]), tool("built"));
      messages.push(user(`继续 ${i}`));
    }
    const out = prune(messages, 2000, 3);
    expect(out.collapsed).toBe(0); // 整条都在最近窗口里，一个字都不许折
    expect(out.chars).toBeGreaterThan(2000); // 转录暂时站在窗口上方，旧组老化后自行回落
  });
});

describe("verseRows：逐行分摊，空行与尾换行不吞字", () => {
  it("尾换行不产生空行", () => {
    const rows = verseRows("一行\n", 1);
    expect(rows).toEqual([{ said: "一行", unsaid: "" }]);
  });

  it("中间空行跳过，不占一行", () => {
    const rows = verseRows("a\n\nb", 1);
    expect(rows).toHaveLength(2);
  });
});

describe("speechMs：标点按拍算", () => {
  it("省略号按停顿计，不为零", () => {
    expect(speechMs("嗯……")).toBeGreaterThan(0);
  });
});

describe("beatAt：半开窗的边界", () => {
  it("第一拍之前是 -1", () => {
    const beats: Beat[] = [{ start: 1000, end: 2000, seqs: [0], turn: 1, verbs: [], headline: "", gate: false } as Beat];
    expect(beatAt(beats, 0)).toBe(-1);
  });

  it("站在拍内算这一拍", () => {
    const beats: Beat[] = [{ start: 1000, end: 2000, seqs: [0], turn: 1, verbs: [], headline: "", gate: false } as Beat];
    expect(beatAt(beats, 1500)).toBe(0);
  });

  it("end 未合上的尾巴拍只站 max(end, start+1)：时钟越过窗口就不算在任何一拍", () => {
    const beats: Beat[] = [{ start: 1000, end: 1000, seqs: [0], turn: 1, verbs: [], headline: "", gate: false } as Beat];
    expect(beatAt(beats, 1000)).toBe(0); // start 本身算站在这拍
    expect(beatAt(beats, 1500)).toBe(-1); // 越过窗口
  });
});
