// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Stage } from "../engine/runtime";
import { DEFAULT_CONFIG, getModels, setScriptedResponses } from "../llm/llm";
import { Teacher } from "./loop";

/*
 * 回执那头的接线：`execute()` 只给导演自己那批动词输出挂听筒，把门拦下的账拼在工具结果后面。
 * 走 scripted 排练装置（faux provider），不用真实模型 —— 这一件钉的是"诊断真的到了导演手里"，
 * 不是"门会修正"（那在 `guard-notes.test.ts` 里）。faux provider 要先用 `getModels` 注册，
 * `setScriptedResponses` 才有地方接谱子（`llm.ts` 的 `faux` 表是模块级状态）。
 */

const LONG = "长".repeat(2100);
const CFG = { ...DEFAULT_CONFIG, scripted: true };

function scriptedStage(): { stage: Stage; teacher: Teacher } {
  getModels(CFG);
  const stage = new Stage();
  const teacher = new Teacher(stage, CFG, {});
  return { stage, teacher };
}

function narrateResults(teacher: Teacher): string {
  return teacher.messages
    .filter((m) => m.role === "toolResult" && m.toolName === "narrate")
    .map((r) =>
      (Array.isArray(r.content) ? r.content : [])
        .filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    )
    .join("\n");
}

describe("回执带上门拦下的账", () => {
  it("导演落一笔脏 narrate，工具结果里有诊断、有修正后的事实", async () => {
    const { stage, teacher } = scriptedStage();
    setScriptedResponses([
      fauxAssistantMessage(
        [fauxThinking("这一拍要让字幕说满一句长话。"), fauxToolCall("narrate", { text: LONG, seconds: 1e18 })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("（排练剧本到这里演完了。）", { stopReason: "stop" }),
    ]);
    await teacher.say("讲向量加法");
    const text = narrateResults(teacher);
    expect(text).toContain("门拦下的：narrate.text 超过 2000 字");
    expect(text).toContain("narrate.duration 越界，夹回 120000ms");
    // 落进带子的是修正后的 op：截到 2000 字、封顶 120 秒 —— 诊断本身一个字也没进带子。
    // 带子末尾还有 sayProse 落的收尾旁白，所以按"存在修正后的那一条"找，不是按最后一条。
    const corrected = stage.log.tape.filter((e) => e.op.kind === "narrate" && (e.op as { text: string }).text.length === 2000);
    expect(corrected.length).toBeGreaterThan(0);
    expect(stage.log.tape.some((e) => e.op.kind === "narrate" && (e.op as { text: string }).text.length === 2100)).toBe(false);
    expect(JSON.stringify(stage.log.tape)).not.toContain("门拦下");
  });

  it("干净的一刀：回执还是原来的样子，一个字的诊断也没有", async () => {
    const { teacher } = scriptedStage();
    setScriptedResponses([
      fauxAssistantMessage(
        [fauxThinking("这一拍只说一句短话。"), fauxToolCall("narrate", { text: "向量的加法，首尾相接。", seconds: 3 })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("（排练剧本到这里演完了。）", { stopReason: "stop" }),
    ]);
    await teacher.say("讲向量加法");
    const text = narrateResults(teacher);
    expect(text).not.toContain("门拦下");
    expect(text).toContain("narrated");
  });
});
