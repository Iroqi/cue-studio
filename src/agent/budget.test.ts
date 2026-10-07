import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { DEFLATED, ceilingChars, deflate, prune, transcriptChars } from "./budget";

const BIG = `<svg viewBox="0 0 400 300">${"<path d='M0 0 L1 1'/>".repeat(40)}</svg>`;

const sys = (): Message => ({ role: "system", content: "GRAMMAR", sections: { "<stage>": "props on file" }, timestamp: 1 }) as Message;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const art = (turn: number): Message[] => [
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: `第 ${turn} 拍想了很久`.repeat(30), thinkingSignature: `sig-${turn}` },
      { type: "text", text: `这一拍画第 ${turn} 个东西` },
      { type: "toolCall", id: `call_${turn}`, name: "build", arguments: { id: `p${turn}`, label: `道具 ${turn}`, x: 100 * turn, y: 0, w: 400, h: 300, svg: BIG } },
    ],
    api: "openai-completions",
    provider: "mock",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 1,
  } as Message,
  {
    role: "toolResult",
    toolCallId: `call_${turn}`,
    toolName: "build",
    content: [{ type: "text", text: `built p${turn}` }],
    isError: false,
    timestamp: 1,
  } as Message,
];

/** The director's head across a long lesson: system, a learner line, then N build turns. */
const lesson = (turns: number): Message[] => {
  const out: Message[] = [sys(), user("讲向量加法")];
  for (let i = 1; i <= turns; i++) out.push(...art(i));
  return out;
};

describe("上下文预算：折回指针，不是丢拍", () => {
  it("窗口之内一动不动 —— 返回同一个数组", () => {
    const m = lesson(2);
    const cut = prune(m, ceilingChars(200_000));
    expect(cut.collapsed).toBe(0);
    expect(cut.messages).toBe(m);
  });

  it("超了就把图形源码折回指针，时钟上的事实一个不少", () => {
    const m = lesson(14);
    const before = transcriptChars(m);
    const cut = prune(m, Math.floor(before * 0.5));
    // prune 的语义是"尽量够到天花板"，不是"必须够到"：最近 KEEP_RECENT 组不许动，
    // 折尽可折的 8 组仍可能高于预算 —— 那就带着超出的部分继续，拍一律不丢。
    expect(cut.collapsed).toBe(14 - 6);
    expect(cut.chars).toBeLessThan(before);
    // 折过的那一拍仍然说得出它是谁、落在哪、是个 build —— 丢的是画，不是这件事。
    const first = cut.messages[2];
    expect(first.role).toBe("assistant");
    const call = (first as { content: { type: string; name?: string; arguments?: Record<string, unknown> }[] }).content.find(
      (c) => c.type === "toolCall",
    )!;
    expect(call.name).toBe("build");
    expect(call.arguments?.id).toBe("p1");
    expect(call.arguments?.x).toBe(100);
    expect(String(call.arguments?.svg).length).toBeLessThan(BIG.length);
  });

  it("窗口不许劈开拍：一个 toolCall 永远和它自己的结果待在同一组", () => {
    const m = lesson(14);
    const cut = prune(m, Math.floor(transcriptChars(m) * 0.2));
    const seq = cut.messages.map((x) => x.role).join(",");
    expect(seq).toBe("system,user," + Array.from({ length: 14 }, () => "assistant,toolResult").join(","));
  });

  it("折到不能再折为止：除最近 KEEP_RECENT 组，其余全部折回指针", () => {
    const m = lesson(14);
    const cut = prune(m, 1);
    expect(cut.collapsed).toBe(14 - 6);
    const stillArt = cut.messages.filter(
      (x) => x.role === "assistant" && (x as { content: { type: string; arguments?: Record<string, unknown> }[] }).content.some(
        (c) => c.type === "toolCall" && c.arguments?.svg === BIG,
      ),
    );
    expect(stillArt).toHaveLength(6);
  });

  it("最近几拍一个字节都不动：那是正在用的思考、正在画的图、正在配对的调用", () => {
    const m = lesson(12);
    const cut = prune(m, Math.floor(transcriptChars(m) * 0.3));
    const untouched = m.slice(m.length - 12);
    expect(cut.messages.slice(cut.messages.length - 12)).toEqual(untouched);
  });

  it("旧的思考整块拿掉，而不是留下签名配一个假正文", () => {
    const m = lesson(12);
    const cut = prune(m, Math.floor(transcriptChars(m) * 0.3));
    const old = cut.messages[2] as { content: { type: string }[] };
    expect(old.content.some((c) => c.type === "thinking")).toBe(false);
    // 最近那组仍然带着它自己的思考与签名。
    const recent = cut.messages[cut.messages.length - 12] as { content: { type: string }[] };
    expect(recent.content.some((c) => c.type === "thinking")).toBe(true);
  });

  it("折回来的是幂等的：再折一次不多不少，前缀缓存才守得住", () => {
    const m = lesson(12);
    const once = prune(m, Math.floor(transcriptChars(m) * 0.3));
    expect(once.collapsed).toBeGreaterThan(0);
    const twice = prune(once.messages, Math.floor(transcriptChars(m) * 0.3));
    expect(twice.collapsed).toBe(0);
    expect(twice.messages).toBe(once.messages);
  });
});

describe("deflate：结构留下，payload 走", () => {
  it("短字符串与坐标是结构，原样保留", () => {
    const d = deflate({ id: "vec-a", label: "向量 a", x: 150, w: 520, mode: "fit" }) as Record<string, unknown>;
    expect(d).toEqual({ id: "vec-a", label: "向量 a", x: 150, w: 520, mode: "fit" });
  });

  it("长字符串只留一个够认的开头和它的原长度", () => {
    const d = deflate({ svg: BIG }) as { svg: string };
    expect(d.svg.startsWith(BIG.slice(0, 60))).toBe(true);
    expect(d.svg).toContain(`${BIG.length} 字符`);
  });

  it("数组与嵌套对象都走一遍", () => {
    const d = deflate({ beats: [{ say: "短句", svg: BIG }, { props: [BIG] }] }) as { beats: { say: string; svg: string; props: string[] }[] };
    expect(d.beats[0].say).toBe("短句");
    expect(d.beats[0].svg).toContain("已裁剪");
    expect(d.beats[1].props[0]).toContain("已裁剪");
  });

  it("指针说得出回读的路", () => {
    expect(DEFLATED).toContain("fetch_prop");
  });
});

describe("窗口换字符", () => {
  it("128k 的窗口给导演留六成的空间", () => {
    expect(ceilingChars(128_000)).toBe(Math.floor(128_000 * 0.6 * 2));
  });

  it("窗口再小也不低于一个能说话的下限", () => {
    expect(ceilingChars(1_000)).toBe(8_000);
  });
});
