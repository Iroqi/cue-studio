import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

/**
 * What a reasoning model does when the output ceiling is lower than its train of thought: it stops
 * with `length` having produced no verb and no line. Observed on a real provider (21k characters of
 * thinking, nothing on stage, and the loop reported "这一段讲完了"). Rehearsed first so the recovery
 * path is exercised without a key.
 */
function truncatedThinkingOnly() {
  return fauxAssistantMessage(
    fauxThinking("先把整场的思路在脑子里过一遍：向量、三角形法则、分量、镜头、旁白……".repeat(3)),
    { stopReason: "length" },
  );
}

function arrow(x1: number, y1: number, x2: number, y2: number, vbW: number, vbH: number, color: string, label: string, lw = 9) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const h = 28;
  const p1 = `${x2 - h * Math.cos(ang - 0.42)},${y2 - h * Math.sin(ang - 0.42)}`;
  const p2 = `${x2 - h * Math.cos(ang + 0.42)},${y2 - h * Math.sin(ang + 0.42)}`;
  const mx = (x1 + x2) / 2 + 34 * Math.sin(ang);
  const my = (y1 + y2) / 2 - 34 * Math.cos(ang);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW} ${vbH}">
<g stroke-linecap="round">
<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${lw}"/>
<polygon points="${x2},${y2} ${p1} ${p2}" fill="${color}" stroke="none"/>
<circle cx="${x1}" cy="${y1}" r="8" fill="${color}" stroke="none"/>
<text x="${mx}" y="${my}" fill="#e8e6f0" font-family="system-ui" font-size="46" font-weight="600">${label}</text>
</g></svg>`;
}

const ART_A = arrow(30, 270, 480, 40, 520, 310, "#7dd3fc", "a");
const ART_B = arrow(30, 310, 480, 40, 520, 330, "#f0abfc", "b");
const ART_R = arrow(30, 540, 930, 40, 960, 580, "#fde68a", "a + b", 12);
const ART_X = arrow(30, 90, 930, 90, 960, 180, "#94a3b8", "rₓ");
const ART_Y = arrow(30, 540, 30, 40, 180, 580, "#94a3b8", "rᵧ");

export function asideScore() {
  return [
    fauxAssistantMessage(
      [
        fauxText("插播：把已经站住的那条合成向量拉过来就地回答，不重新展开整场。"),
        fauxToolCall("fetch_prop", { id: "vec-r" }),
        fauxToolCall("highlight", { target: "vec-r", style: "outline", seconds: 2 }),
        fauxToolCall("narrate", { text: "你问的是这条线为什么会这么长 —— 因为它不走路径，它只记终点。", seconds: 6 }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("回答完了，回到主线。", { stopReason: "stop" }),
  ];
}

/**
 * What the director does when the learner speaks after the lesson already ran out: it keeps the
 * same board. Nothing is cleared, the old props are recalled rather than redrawn, and the new
 * line of thought is opened by panning into empty space instead of by a new scene.
 */
export function continuationScore() {
  const diff = arrow(30, 430, 700, 60, 760, 460, "#86efac", "a − b");
  return [
    fauxAssistantMessage(
      [
        fauxText("黑板不清，接着这块板往下讲。先走开一屏，把新的想法落在空的地方。"),
        fauxToolCall("camera", { mode: "pan", dir: "right", screens: 0.8, duration: 1400, easing: "ease-in-out" }),
        fauxToolCall("narrate", { text: "减法不用新画一块板 —— 它就是加法，只不过其中一条换了方向。", seconds: 6 }),
        fauxToolCall("recall", { id: "vec-r", scene: "反向", w: 960, h: 580 }),
        fauxToolCall("build", { id: "vec-m", scene: "反向", label: "向量 a − b", w: 760, h: 460, note: "与 vec-r 共用起点的那条差向量", svg: diff }),
        fauxToolCall("link", { from: "vec-m", to: "vec-r", relation: "shares-tail" }),
        fauxToolCall("camera", { mode: "focus", target: ["vec-m"], at: { x: 1, y: 0.13 }, span: 0.26, duration: 1100 }),
        fauxToolCall("highlight", { target: "vec-m", style: "outline", seconds: 2 }),
        fauxToolCall("narrate", { text: "看这条线的尖：a − b 的终点，正好是从 b 的终点走到 a 终点的那一步。", seconds: 7 }),
        fauxToolCall("camera", { mode: "fit", target: ["vec-r", "vec-m"], duration: 1300, easing: "ease-out" }),
        fauxToolCall("note_progress", { concepts_covered: ["减法=加上反向向量"], learner_state: "能接受不换板继续推" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("这就接在刚才那条 a + b 后面了。要不要我把 b 翻转过来画在板上，让你看着它变成 −b？", { stopReason: "stop" }),
  ];
}

export function rehearsalScore() {
  return [
    // 0 — a cut-off turn that leaves nothing on stage; the loop must retry it, not close the section.
    truncatedThinkingOnly(),
    // 1 — director lays the skeleton: the clock starts before any artwork exists.
    fauxAssistantMessage(
      [
        fauxText("先把这一场的骨架排出来：两条向量、一句开场旁白，镜头先框住整个场面。骨架先落地，时钟就跑起来，画面随后填进去。"),
        fauxToolCall("stage_script", {
          title: "向量加法：三角形法则",
          beats: [
            {
              scene: "合成",
              say: "这是一条向量 a。它有长度，也有方向 —— 两样都算它的一部分。",
              seconds: 7,
              props: [{ id: "vec-a", label: "向量 a", scene: "合成", x: 150, y: 520, w: 520, h: 310, note: "第一条向量，学生已经认识" }],
              camera: { mode: "fit", target: ["vec-a"], duration: 1200 },
            },
            {
              scene: "合成",
              say: "现在把第二条向量 b 的起点，放在 a 的终点上。注意：不是平移到别处，是接上。",
              seconds: 8,
              style: "verse",
              hold: 700,
              props: [{ id: "vec-b", label: "向量 b", scene: "合成", x: 600, y: 250, w: 520, h: 330 }],
              camera: { mode: "fit", target: ["vec-a", "vec-b"], duration: 900 },
            },
          ],
        }),
        fauxToolCall("paint", { id: "vec-a", brief: "一条向右上方的向量 a，起点在左下，标注 a", scene: "合成" }),
        fauxToolCall("paint", { id: "vec-b", brief: "一条向右上方的向量 b，比 a 短陡，标注 b", scene: "合成" }),
      ],
      { stopReason: "toolUse" },
    ),
    // 2/3 — painter fills the placeholders.
    fauxAssistantMessage(ART_A, { stopReason: "stop" }),
    fauxAssistantMessage(ART_B, { stopReason: "stop" }),
    // 4 — director asks for the resultant and moves in.
    fauxAssistantMessage(
      [
        fauxText("两条已经站住了，现在合它们。"),
        fauxToolCall("paint", { id: "vec-r", brief: "从 a 的起点直接指向 b 的终点的那条向量，标注 a + b。它要明显比 a、b 都长，颜色最亮。", scene: "合成", x: 150, y: 250, w: 960, h: 580 }),
        fauxToolCall("camera", { mode: "fit", target: ["vec-a", "vec-b", "vec-r"], duration: 1600, easing: "ease-out" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(ART_R, { stopReason: "stop" }),
    // 5 — highlight the闭合关系, then hand off the narration
    fauxAssistantMessage(
      [
        fauxToolCall("highlight", { target: "vec-r", style: "pulse", seconds: 2.4 }),
        fauxToolCall("motion", { id: "vec-r", mode: "flow", axis: "x", amp: 160, period: 4600, seconds: 9 }),
        fauxToolCall("narrate", { text: "从 a 的起点走到 b 的终点 —— 这条路就是 a + b。你刚才看见的是路径，现在看见的是结果。", seconds: 9 }),
        fauxToolCall("link", { from: "vec-r", to: "vec-b", relation: "ends-at" }),
        fauxToolCall("beat", { seconds: 1.2 }),
      ],
      { stopReason: "toolUse" },
    ),
    // 6 — change of scene carrying the SAME prop across it
    fauxAssistantMessage(
      [
        fauxText("换场。合成这一场的结论要作为道具带进分解那一幕，而不是重画一条很像的。"),
        fauxToolCall("recall", { id: "vec-r", scene: "分解", x: 2560, y: 250, w: 960, h: 580 }),
        fauxToolCall("transition", { style: "wipe", to: "分解", seconds: 1.6 }),
        fauxToolCall("narrate", { text: "同一条 a + b，换个问法：它能不能只由水平与竖直两段的运动合成出来？", seconds: 8, style: "voice" }),
      ],
      { stopReason: "toolUse" },
    ),
    // 7 — components
    fauxAssistantMessage(
      [
        fauxToolCall("paint", { id: "comp-x", brief: "一条水平向量，从合成向量的起点向右延伸到它的终点正下方，颜色灰一些，标注 rₓ", scene: "分解", x: 2560, y: 700, w: 960, h: 180 }),
        fauxToolCall("paint", { id: "comp-y", brief: "一条竖直向量，从水平向量的终点向上到合成向量的终点，标注 rᵧ", scene: "分解", x: 3460, y: 250, w: 180, h: 580 }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(ART_X, { stopReason: "stop" }),
    fauxAssistantMessage(ART_Y, { stopReason: "stop" }),
    // 8 — the genuinely hard part, asked of the learner
    fauxAssistantMessage(
      [
        fauxToolCall("camera", { mode: "fit", target: ["vec-r", "comp-x", "comp-y"], duration: 1400 }),
        fauxToolCall("motion", { id: "comp-x", mode: "iterate", axis: "x", amp: 420, period: 750, steps: 4, seconds: 3 }),
        fauxToolCall("narrate", { text: "现在问你一件事，别急着答。", seconds: 3 }),
        fauxToolCall("ask_learner", {
          prompt: "如果 a + b 完全等于「先走 comp-x 再走 comp-y」，那这两条路径的差别在哪里？",
          options: ["终点不同，所以不相等", "路径不同，但终点相同 —— 相加只看终点", "竖直分量画错了"],
          answer: 1,
          why: "向量加法不管你怎么走，只管你最后到了哪儿。",
          concept: "相加只看终点",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    // 9 — close, and record what was actually understood
    fauxAssistantMessage(
      [
        fauxToolCall("highlight", { target: "vec-r", style: "outline", seconds: 2 }),
        fauxToolCall("narrate", { text: "分解不是把一条向量拆碎，\n是换一组你能算的方向，重新走同一条路。", seconds: 8, style: "verse" }),
        fauxToolCall("note_progress", { concepts_covered: ["向量加法的三角形法则", "分量只依赖终点"], beats_advanced: 6 }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("这一场到此。你已经有一条 a + b，和它在水平/竖直方向上的替身；下一场可以把它们接到力的分解上。", { stopReason: "stop" }),
  ];
}
