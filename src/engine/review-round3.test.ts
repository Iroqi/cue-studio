import { describe, expect, it } from "vitest";
import { verseRows, revealCut } from "./reveal";
import { encodeTape } from "./share";
import { MAIN_TRACK } from "./log";
import type { Op, OpEntry } from "./types";

/*
 * 2026-11 第三轮深度 review 的回归钉。这轮先全仓静态精读（App / StageView / Scene3D /
 * prompt / rehearsal / log / score / guard 全部卡片分支 / director 全部工具分支），
 * 未发现硬缺陷；随后探针实测深水不变量，命中一个真缺陷：
 *
 *  - `revealCut` 的"至少亮一个字"用 `Math.max(1, …)` 按 UTF-16 **码元**硬抬，fallback 词界
 *    也逐码元给界 —— 代理对（emoji / 生僻字）占两个码元，字幕刚亮的第一瞬就把 "🚀" 劈成
 *    "\ud83d"（显示 �）。主路径在以代理对开头的旁白 + 小 reveal 时触发；无 `Intl.Segmenter`
 *    的环境随时触发。修复：词界与出口都对齐到**码点**边界（至少亮一个完整字符）。
 *
 * 其余探针量出的是"不是缺陷"的边界，一并钉住：
 *  - `share` 的 hash 压缩率：一场 1000 条中文旁白的课压到 ~8KB，链接在浏览器 URL 限制内
 *    可粘贴 —— 分享链接可用性成立；
 *  - `revealCut` 全局词界（Segmenter 路径）天然是码点边界，单行 emoji 整词亮。
 */

const entry = (op: Op, seq: number): OpEntry => ({ seq, track: MAIN_TRACK, turn: 1, op });

describe("round3: revealCut 的代理对（码点）边界", () => {
  it("主路径：以代理对开头的旁白 + 小 reveal，亮的是整个字符，不是半个", () => {
    // "🚀abc" 词界 ends=[2,3,4,5]，reveal=0.2 → target=1 → 首个词界 2 > 1 → said=0
    // 旧代码 Math.max(1, 0)=1 → "🚀abc".slice(0,1)=半个 🚀；修复后亮第一个码点（2 码元）
    const cut = revealCut("🚀abc", 0.2);
    expect(cut).toBe(2);
    expect("🚀abc".slice(0, cut)).toBe("🚀");
  });

  it("fallback 路径（无 Intl.Segmenter）：词界按码点给，半途 reveal 不劈代理对", () => {
    const real = (globalThis as { Intl: typeof Intl }).Intl;
    (globalThis as { Intl: unknown }).Intl = new Proxy(real, {
      get(t, k) {
        if (k === "Segmenter") return undefined;
        return Reflect.get(t, k as PropertyKey);
      },
    });
    try {
      const cut = revealCut("🚀", 0.5);
      expect(cut).toBe(2);
      expect("🚀".slice(0, cut)).toBe("🚀");
    } finally {
      (globalThis as { Intl: unknown }).Intl = real;
    }
  });

  it("全局词界（Segmenter 路径）单行 emoji 整词亮，不劈", () => {
    const text = "合力 🚀 终点";
    const cut = revealCut(text, 1);
    expect(text.slice(0, cut) + text.slice(cut)).toBe(text);
    expect([...text.slice(cut)].join("")).toBe([...text.slice(cut)].join(""));
  });

  it("verseRows 跨行分摊：行首代理对不劈成两半", () => {
    // 任意 reveal 下，每行的 said+unsaid 拼回原行且无悬空代理项
    for (const reveal of [0.1, 0.4, 0.6, 0.9, 1]) {
      const rows = verseRows("甲乙丙丁\n🚀x\n合", reveal);
      for (const r of rows) {
        const broken = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(r.said + r.unsaid);
        expect(broken, `reveal=${reveal} 劈了代理对: said=${JSON.stringify(r.said)}`).toBe(false);
      }
    }
  });
});

describe("round3: share hash 的可用性（实测钉住，不钉具体长度）", () => {
  it("1000 条中文旁白压进 hash 后仍在链接可用的量级（< 64KB）", async () => {
    const ops: Op[] = Array.from({ length: 1000 }, (_, i) => ({ kind: "narrate" as const, text: `第 ${i} 拍：这一段讲的是向量加法的三角形法则，首尾相接，终点决定一切。`, duration: 6000 }));
    const entries = ops.map((op, i) => entry(op, i));
    const hash = await encodeTape(entries);
    expect(hash.length).toBeGreaterThan(0);
    expect(hash.length).toBeLessThan(64 * 1024);
  });
});
