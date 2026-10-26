import type { Compiled } from "./types";

/**
 * 「忍住不加」——Intelligent UI 唯一一条这一仓库还没有 import 的设计判断。
 *
 * 2026-10 随 GPT-6 上线的那份拆解里有一句被反复引用的话：模型学会了**什么时候不加交互**，简单的问题
 * 就给简单的回答；"加东西容易，忍住不加难"。它被写成了一个训练目标（清晰度 / 实用性 / 完整性三问），
 * 而不是一段界面分支代码。
 *
 * 这个仓库的对应物不是"少画一块板"，是**少停一次表**：五张卡（quiz / probe / dial / type / drag）每一张
 * 都把时钟停住。加一张卡容易 —— 回执一律说 "question queued" —— 可"两问之间没有一句旁白"是一堂课的
 * 形状问题：他从上一张卡到现在没听你讲一个字，第二问就不是在考，是在连着考。带子上已经记着这件事
 * （`Compiled.asked/lastAskAt/lastLineEnd`），所以这一件不新增任何 op、不改判分、不动门：**让带子把
 * 自己的节奏说给导演听**。
 *
 * 和 `scoreOf`（学习者那一头的账）同一句分工：那里数的是"问了几道、对了几道"，这里数的是"问之前
 * 讲过没有"。两处都从同一卷带子纯派生，都不带时钟、不带模型、不带档案。
 */

/** 两问之间一句旁白也没有时，回执上多出来的那一句。措辞钉在测试里。 */
export const RESTRAINT =
  "（节奏：上一问和这一问之间没有一句旁白 —— 他从上一张卡到现在没听你讲一个字。能演就别问：先用一拍把这两问之间的东西演出来，或者把这一问并进上一张卡。）";

export interface Rhythm {
  /** 已经问过几道题（`pause_for` 不算题）。 */
  asked: number;
  /** 上一道题落在哪一刻；-1 = 还没问过。 */
  lastAskAt: number;
  /** 上一问之后讲了多久的旁白（ms）。0 = 一个字也没讲。 */
  sinceMs: number;
}

/**
 * 带子尽头的节奏。三个数各读一次，不扫任何表 —— 这一问以前写成"从带子尽头往回走，走过多少张卡就
 * 付多少格"，而它正是导演每问一句都要问一次的那一问（见 `Compiled.asked` 那条注）。
 */
export function rhythm(compiled: Compiled): Rhythm {
  const asked = compiled.asked;
  if (asked <= 0) return { asked: 0, lastAskAt: -1, sinceMs: 0 };
  return {
    asked,
    lastAskAt: compiled.lastAskAt,
    // 上一问落下的那一刻之后讲了多久：最后一句旁白讲到哪儿减去上一问落在哪儿。一句话讲在上一问之前，
    // 这个数就是 0（它的末尾正好是上一问起点，或者更早）。
    sinceMs: Math.max(0, compiled.lastLineEnd - compiled.lastAskAt),
  };
}

/**
 * 这一刀是不是"连着他考"。只有一件事说得出口：上一问之后一句旁白也没有。
 *
 * 不是品味判断，是带子上的一句话：没有旁白 = 这两问之间没有任何东西落在他耳朵里。所以它只在**问句**
 * 落笔时作为回执的后缀出现，不改 op、不进带子、不挡这一刀 —— 连着问两问可以是两种考法并置，那是导演
 * 的决定；他只要知道自己在连着问。
 */
export function restraintNote(compiled: Compiled): string | null {
  const r = rhythm(compiled);
  return r.asked > 0 && r.sinceMs === 0 ? RESTRAINT : null;
}

/** 导演快照里那一行：同一件事的正面说法，给还没落笔的那一问看。 */
export function rhythmLine(compiled: Compiled): string {
  const r = rhythm(compiled);
  if (r.asked === 0) return "tape rhythm: 还没问过题（开场那张前测不算连问）。";
  if (r.sinceMs === 0)
    return `tape rhythm: 已问 ${r.asked} 题；上一问之后还没有一句旁白 —— 再问就是连着他考，能演就别问。`;
  return `tape rhythm: 已问 ${r.asked} 题；上一问之后你讲了 ${(r.sinceMs / 1000).toFixed(1)}s 的旁白。`;
}
