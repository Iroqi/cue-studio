// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Stage } from "../engine/runtime";
import { DEFAULT_CONFIG, getModels, setScriptedResponses } from "../llm/llm";
import { Teacher } from "./loop";

/*
 * 绘制流水线的槽位账。槽位只发给真正要画的任务：一个在队列里被撤场取消的任务从没占过槽位，
 * 释放一个它从未持有的槽位会让 `paintBusy` 一路跌穿 0 —— 下一批绘制就能越过 PAINT_CONCURRENCY
 * 同时跑，免费档的 429 风暴正是这道闸要拦的。脚本化装置（faux provider）不给真实并发数，
 * 这一件钉的是那条被修过的路不挂、不吞画：一口气派 6 张（3 张排队）→ 撤场全部取消 →
 * 再派 4 张 → 全部落地。老账本在那条路上留下的恰恰是"取消之后还欠着假槽位"，而这条路
 * 不许因此死锁或丢画。
 *
 * 道具 id 避开前缀关系：faux 美工按 `道具：<id>` 子串匹配剧本，`道具：p10` 会先命中
 * `道具：p1`（配额已被第一批耗尽），那不是流水线的账，是测试自己的陷阱。
 */
const CFG = { ...DEFAULT_CONFIG, scripted: true };

const art = (id: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#fff"/><text x="150" y="170" font-size="70">${id}</text></svg>`;

const paints = (ids: string[]) =>
  fauxAssistantMessage(
    ids.map((id) => fauxToolCall("paint", { id, brief: `${id} 的画面` })),
    { stopReason: "toolUse" },
  );

const artScript = (ids: string[]) =>
  Object.fromEntries(ids.map((id) => [id, [fauxAssistantMessage(art(id), { stopReason: "stop" })]]));

const CLOSE = fauxAssistantMessage("（排练剧本到这里演完了。）", { stopReason: "stop" });

function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      if (cond()) resolve();
      else if (Date.now() - t0 > ms) reject(new Error("等待超时"));
      else setTimeout(poll, 25);
    };
    poll();
  });
}

describe("绘制流水线的槽位账", () => {
  it("排队绘制被撤场取消后，后续绘制仍全部落地，流水线不挂", async () => {
    getModels(CFG);
    const stage = new Stage();
    const teacher = new Teacher(stage, CFG, {});
    const first = ["a", "b", "c", "d", "e", "f"];
    const second = ["g", "h", "i", "j"];
    // 第一回合：一口气派 6 张画 —— 3 张立刻占位，3 张排队。
    setScriptedResponses([paints(first), CLOSE], artScript(first));
    await teacher.say("讲向量加法");
    // 第一回合还在画的时候撤场：取消全部后台绘制，把这一拍从带上剪掉重排。
    await teacher.rerollFrom(0, "第一版调度太密，换一种排法");
    // 第二回合：再派 4 张。账本要是还欠着假槽位，这里就该顶破并发上限；无论如何它们都得落地。
    setScriptedResponses([paints(second), CLOSE], artScript(second));
    await teacher.say("接着讲，把构图改宽松些");
    // 四张画都要真正落到带上（patch），不许被取消的账本吞掉。
    await waitFor(() => {
      const patched = new Set(stage.log.tape.filter((e) => e.op.kind === "patch").map((e) => (e.op as { id: string }).id));
      return second.every((id) => patched.has(id));
    });
    const patched = new Set(stage.log.tape.filter((e) => e.op.kind === "patch").map((e) => (e.op as { id: string }).id));
    for (const id of second) expect(patched.has(id)).toBe(true);
    // 被撤掉的那批（a-f）的画不许在剪掉之后的带上出现。
    for (const id of first) expect(patched.has(id)).toBe(false);
  });
});
