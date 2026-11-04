import { describe, expect, it } from "vitest";
import { speechMs } from "./speech";
import { cueMs } from "./compile";

/*
 * 2026-11 第五轮深度 review 的回归钉。本轮通读剩余全部核心源码（compile / frame / standing /
 * ink / motion / speech / narrator / share / pace / budget / pointing / archive / segs / Seg /
 * BeatRail / types）之后，探针实测命中一个与第三轮 reveal 修复同族的残留：**计时路径上的代理对**。
 *
 * reveal.ts（第三轮）管"字幕亮几个字"：fallback 按 UTF-16 码元给界，把 🚀 劈成半个。speechMs 管
 * "这句话念多久"：CJK 区间只认 BMP 码元（\u4e00-\u9fff + 扩展 A），而扩展 B 区汉字（U+20000+，
 * 人名地名古籍里的 𠮷、𠬠、𬇙…）是代理对 —— 逐码点遍历时，那对高低代理位不在任何区间里，
 * 于是整字不计音节。实测："吉野家" 577ms，"𠮷野家" 只有 385ms —— 同一句话念法相同，带子却少留
 * 192ms；`cueMs` 的地板（speechMs + SETTLE_MS）随之失守，字幕比语音先走完。
 *
 * 修复：CJK 区间补上扩展 B–G（\u{20000}–\u{3134f}），正则加 `/u` 按码点匹配 —— 与 reveal 那句
 * "按码元劈代理对"在计时这一头的同一句话。emoji 不在区间里，仍然不算音节（它不在语音里）。
 */

describe("round5: 旁白时长对代理对汉字的音节计数", () => {
  it("扩展 B 字与同音基本区字时长一致（吉野家 vs 𠮷野家）", () => {
    expect(speechMs("𠮷野家")).toBe(speechMs("吉野家"));
  });

  it("扩展 B 字单独占一个音节", () => {
    expect(speechMs("𠮷")).toBe(speechMs("吉"));
    expect(speechMs("𠮷")).toBeGreaterThan(0);
  });

  it("cueMs 的地板跟着补上：含扩展 B 字的旁白 cue 不再被压缩", () => {
    // 一个𠮷字约 192ms，三个字约 577ms；cueMs 地板 = max(duration, speechMs + 300)。
    // 修复前 speechMs 少算 192ms，duration=600 的带子 cue 被压到 600 —— 字幕先走完。
    const floor = Math.max(600, speechMs("𠮷野家") + 300);
    expect(cueMs({ kind: "narrate", text: "𠮷野家", duration: 600 })).toBe(floor);
    expect(cueMs({ kind: "narrate", text: "吉野家", duration: 600 })).toBe(cueMs({ kind: "narrate", text: "𠮷野家", duration: 600 }));
  });

  it("emoji 仍不算音节（不在语音里），扩展 B 修复不误伤它", () => {
    expect(speechMs("🚀")).toBe(0);
    // 基本区 + 假名的计数不受 /u 影响
    expect(speechMs("あいう")).toBeGreaterThan(0);
    expect(speechMs("abc")).toBeGreaterThan(0);
  });
});
