import { describe, expect, it } from "vitest";
import { OpLog, MAIN_TRACK } from "./log";
import type { Op } from "./types";

/*
 * 第七轮修复的回归钉：门的视觉枚举兜底。
 *
 * `guard.ts` 的 oneOf 原先只为四种"解释器 switch 无 default"的枚举兜底（camera.mode /
 * light.mood / motion.mode / motion.axis），注释里说"Everything else (easing, veil style)
 * already has a fallback where it is read"。easing 确有（`EASES[op.easing] ?? EASES.ease`），
 * 但视觉枚举是拼 CSS class 名读的：`hl-${style}` / `veil-${style}`。一个没规则的 class 不是
 * "有兜底"，是**没有效果**——分享链接里一个不认识的 highlight.style 让强调静默消失，一个
 * 不认识的 transition.style 让换场只剩基础遮罩。与 light/motion 同类坏值被门纠正并记账不一致。
 *
 * 修复：HIGHLIGHT_STYLES / TRANSITION_STYLES 两个集合并接入 oneOf，坏值回退 pulse/dissolve
 * 并记 notes —— 与 light.mood 同一套账。
 */
describe("round7: 门的枚举兜底覆盖视觉枚举", () => {
  const one = (op: Op) => {
    const log = new OpLog();
    const notes: string[] = [];
    log.append([op], MAIN_TRACK, (n) => notes.push(n));
    return { op: log.all()[0].op, notes };
  };

  it("highlight.style 的坏值回退 pulse 并记账", () => {
    const { op, notes } = one({ kind: "highlight", target: "a", style: "glow", duration: 1000 } as unknown as Op);
    expect((op as { style: string }).style).toBe("pulse");
    expect(notes.some((n) => n.includes("highlight.style"))).toBe(true);
  });

  it("transition.style 的坏值回退 dissolve 并记账", () => {
    const { op, notes } = one({ kind: "transition", style: "fade", to: "b", duration: 800 } as unknown as Op);
    expect((op as { style: string }).style).toBe("dissolve");
    expect(notes.some((n) => n.includes("transition.style"))).toBe(true);
  });

  it("合法的 highlight.style 一个都不许动", () => {
    for (const style of ["pulse", "outline", "dim-rest", "shake"] as const) {
      const { op, notes } = one({ kind: "highlight", target: "a", style, duration: 1000 } as unknown as Op);
      expect((op as { style: string }).style).toBe(style);
      expect(notes.some((n) => n.includes("highlight.style"))).toBe(false);
    }
  });

  it("合法的 transition.style 一个都不许动", () => {
    for (const style of ["dissolve", "wipe", "match-cut", "split"] as const) {
      const { op, notes } = one({ kind: "transition", style, to: "b", duration: 800 } as unknown as Op);
      expect((op as { style: string }).style).toBe(style);
      expect(notes.some((n) => n.includes("transition.style"))).toBe(false);
    }
  });

  it("旧链接缺 style 字段：默认值照旧（pulse / dissolve），不记账", () => {
    const h = one({ kind: "highlight", target: "a", duration: 1000 } as unknown as Op);
    expect((h.op as { style: string }).style).toBe("pulse");
    const t = one({ kind: "transition", to: "b", duration: 800 } as unknown as Op);
    expect((t.op as { style: string }).style).toBe("dissolve");
  });
});
