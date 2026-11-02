/**
 * 旁白揭晓那一刀：从"逐字"改成"按词"。一句话整词整词地亮，而不是打字机一格一格蹦——快慢仍是带子
 * 说了算（`reveal` 是时钟的线性话，0→1，一句旁白的时长就是它的读速），这一刀只把"第几格"从字换成词。
 *
 * 独立成模块（`StageView` 是组件文件，快刷规矩不许它再导出纯函数）：
 * 词界由 `Intl.Segmenter` 自己说了算（中文没有空格，正是它切的）；没有这个 API 的环境退回逐字。
 * 缓存按整句文字键：一句旁白在整段 cue 里不换字，切一次够全片用，不许每帧重切。
 */
const wordEndsCache = new Map<string, number[]>();
let segmenter: Intl.Segmenter | null = null;
function wordEnds(text: string): number[] {
  const hit = wordEndsCache.get(text);
  if (hit) return hit;
  let ends: number[];
  try {
    segmenter ??= new Intl.Segmenter("zh", { granularity: "word" });
    ends = [];
    for (const s of segmenter.segment(text)) ends.push(s.index + s.segment.length);
  } catch {
    // 逐**码点**给界，不是逐 UTF-16 码元：代理对（emoji / 生僻字）要整词亮，逐码元会把
    // "🚀" 的 0..1 当作一个界，字幕刚亮就劈出半个字符。
    ends = [];
    let acc = 0;
    for (const ch of text) {
      acc += ch.length;
      ends.push(acc);
    }
  }
  if (wordEndsCache.size > 16) wordEndsCache.clear();
  wordEndsCache.set(text, ends);
  return ends;
}

/** 至少亮一个**完整字符**（码点）：行头那一格不亮，说话的暗示（光标）就没地方站；而代理对
 *  占两个码元，`Math.max(1, …)` 那种按码元的硬抬会把 emoji 劈成半个（�），所以出口对齐到
 *  码点边界 —— 首字符是代理对时亮整个字符。 */
export function revealCut(text: string, reveal: number): number {
  if (!text) return 0;
  const target = text.length * Math.min(1, Math.max(0, reveal));
  let said = 0;
  for (const end of wordEnds(text)) {
    if (end > target) break;
    said = end;
  }
  if (said === 0) return [...text][0].length;
  return Math.min(said, text.length);
}

/**
 * The rows the stage shows, already laid out at their final size. The clock only uncovers them: a
 * line that grows glyph by glyph inside a centred box drags every glyph before it sideways, and the
 * reader's eye has to chase it. So the tail is present and invisible — nothing reflows mid-verse.
 * 逐行分摊全局那一刀。
 */
export function verseRows(text: string, progress: number): { said: string; unsaid: string }[] {
  const shown = revealCut(text, progress);
  const rows: { said: string; unsaid: string }[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const cut = Math.max(0, Math.min(line.length, shown - at));
    if (line.trim()) rows.push({ said: line.slice(0, cut), unsaid: line.slice(cut) });
    at += line.length + 1;
  }
  return rows;
}
