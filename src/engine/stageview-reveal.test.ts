// @vitest-environment node
import { describe, expect, it } from "vitest";
import { revealCut, verseRows } from "./reveal";

/*
 * 揭晓那一刀从"逐字"改成"按词"：一句话整词整词地亮，而不是打字机一格一格蹦。钉的是这一句的
 * 形状——**一刀必须落在词界上**，快慢仍是时钟的线性话（`reveal` 0→1，带子的时长就是读速）。
 * 词界由 `Intl.Segmenter` 自己说了算（中文没有空格，正是它切的），所以断言不猜边界、只钉契约：
 * 任意进度下的那一刀要么是词界、要么是行头那一个字的座位（光标站的地方）。
 */

const ends = (text: string): number[] =>
  Array.from(new Intl.Segmenter("zh", { granularity: "word" }).segment(text), (s) => s.index + s.segment.length);

describe("旁白揭晓：按词步进，不切半个词", () => {
  it("有空格的语言：全程每一刀都在词界上，到结尾整句亮完", () => {
    const text = "one two three";
    const bs = ends(text);
    for (let p = 0.01; p <= 1; p += 0.01) {
      const cut = revealCut(text, p);
      expect(cut === 1 || bs.includes(cut), `progress ${p.toFixed(2)} 把刀切进了词里`).toBe(true);
    }
    // 逐字那一刀会切出 "one t"（5）这种半个词；这一刀宁可少亮，不亮半个。
    expect(revealCut(text, 0.45)).not.toBe(5);
    expect(revealCut(text, 1)).toBe(text.length);
  });

  it("中文没有空格：Segmenter 切词，行尾那半个词不亮", () => {
    const text = "瞬时变化率是导数";
    const bs = ends(text);
    for (let p = 0.01; p <= 1; p += 0.01) {
      const cut = revealCut(text, p);
      expect(cut === 1 || bs.includes(cut), `progress ${p.toFixed(2)} 把刀切进了词里`).toBe(true);
    }
    expect(revealCut(text, 1)).toBe(text.length);
  });

  it("行头至少亮一个字：光标有地方站", () => {
    expect(revealCut("one two three", 0)).toBeGreaterThanOrEqual(1);
    // 空串没有可亮的字：0 是唯一诚实的答案，slice 越界也不炸。
    expect(revealCut("", 0.5)).toBe(0);
  });

  it("逐行分摊全局那一刀：每行的 unsaid 保持最终形状，行间不互吞", () => {
    const rows = verseRows("第一行\n第二行", 0.5);
    expect(rows.map((r) => r.said + r.unsaid)).toEqual(["第一行", "第二行"]);
    // 全局刀落在第一行行内时，第二行整行仍是 unsaid。
    const half = verseRows("一二三四五六\n七八九", 0.5);
    expect(half[1].said).toBe("");
    expect(half[1].unsaid).toBe("七八九");
  });
});
