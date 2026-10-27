import { describe, expect, it } from "vitest";
import { pointedMessage } from "./pointing";

/*
 * 指着问那句话的接缝：学习者指了哪儿、说了什么，被压成一句导演读得懂、又没有"来自界面"标记的
 * 普通用户消息。坐标是道具自身框里的 0..1 —— 和 `camera.at` 同一套，导演拿到不用换算。
 */

describe("指着问的那一句话", () => {
  it("带问题时：指名、坐标、他的问题，三者都在一句话里", () => {
    expect(pointedMessage("向量 b", { x: 0.5, y: 0.25 }, "这里怎么来的？")).toBe(
      "我指着台上的「向量 b」这一点（x=0.50，y=0.25）问：这里怎么来的？",
    );
  });

  it("空问题不是误触：它就是「这里没懂，换个讲法」那扇最短的门", () => {
    expect(pointedMessage("向量 b", { x: 0.5, y: 0.25 })).toBe(
      "我指着台上的「向量 b」这一点（x=0.50，y=0.25）—— 这里没懂，换个讲法。",
    );
  });

  it("label 空白退回「那件东西」：句子仍然指得出来", () => {
    expect(pointedMessage("   ", { x: 0.5, y: 0.5 }, "这是什么")).toContain("「那件东西」");
    expect(pointedMessage("向量 b", { x: 0.5, y: 0.5 }, "  这是什么  ")).toContain("问：这是什么");
  });

  it("label 里的换行和连排空白压成单空格：导演收到的不许是断成两行的句子", () => {
    expect(pointedMessage("向量 b\n（就是那条蓝的）", { x: 0.5, y: 0.5 }, "为什么？")).toContain(
      "「向量 b （就是那条蓝的）」",
    );
    expect(pointedMessage("a    b\tc", { x: 0.5, y: 0.5 })).toContain("「a b c」");
    expect(pointedMessage("a\n", { x: 0.5, y: 0.5 })).not.toMatch(/\n/);
  });

  it("坐标夹在 0..1、两位小数：他点在框外也不会把导演送到板外", () => {
    expect(pointedMessage("a", { x: -1, y: 2 })).toContain("x=0.00，y=1.00");
    expect(pointedMessage("a", { x: 0.123, y: 0.987 })).toContain("x=0.12，y=0.99");
  });

  it("坏数字不把句子变成 NaN：退回正中，仍是一句能发的话", () => {
    const msg = pointedMessage("a", { x: Number.NaN, y: Number.POSITIVE_INFINITY });
    expect(msg).toContain("x=0.50，y=0.50");
    expect(msg).not.toContain("NaN");
    expect(msg).not.toContain("Infinity");
  });

  it("没有任何“来自界面”的标记：按钮不是说话人，他只是指了一下", () => {
    const msg = pointedMessage("向量 b", { x: 0.5, y: 0.5 }, "为什么");
    expect(msg).not.toMatch(/界面|按钮|点击|point|Point|UI/);
  });
});
