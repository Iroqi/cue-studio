/** A teacher gets about five Mandarin syllables a second. */
const SYL_PER_SEC = 5.2;
/** Latin script is read by the word, not by the stroke: about eleven letters a second aloud. */
const LATIN_PER_SEC = 11;
/** What the voice actually does at punctuation: a comma is a breath, a full stop is a period nobody speaks. */
const CLAUSE_MS = 120;
const STOP_MS = 250;

/**
 * The breath after a line: the voice has said it, the caption is finished, and the picture holds for
 * this long before the next cut is allowed to move. Without it every cut lands on the last syllable.
 */
export const SETTLE_MS = 300;

// CJK 基本区、扩展 A 区、假名、谚文之外，还要把**扩展 B 区及以后**（U+20000+，代理对）算进来：
// 人名、地名、古籍里那些字（𠮷、𠬠、𬇙…）和基本区汉字一样要一个字一个字念出来。`for…of` 按码点
// 遍历，而旧正则只认 BMP 码元，一个扩展 B 字落进 `SYLLABLE.test(ch)` 时是那对高低代理位 —— 不在
// 任何区间里，于是这句旁白的语音时长少算一个音节（"吉野家" 577ms，"𠮷野家" 只有 385ms —— 同一句
// 话，念法相同，带子却给它少留 192ms）。`/u` 让 `\u{…}` 按码点匹配，正是 reveal.ts 那句
// "按码元劈代理对"在计时这一头的同一句话。
const SYLLABLE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134f}]/u;
const LETTER = /[0-9A-Za-z\u00c0-\u024f]/;
const CLAUSE = /[，、；：,;:]/g;
const STOP = /[。！？…!?]|\.(?=\s|$)/g;

/**
 * How long a line of narration takes to say out loud. Not a courtesy estimate: the show's clock is
 * built out of narration, so this is the floor under a beat and every cut is timed off it. Guess it
 * low and the picture runs away from its own voice — which is what a too-fast scene change is.
 */
export function speechMs(text: string): number {
  let syllables = 0;
  let letters = 0;
  for (const ch of text) {
    if (SYLLABLE.test(ch)) syllables++;
    else if (LETTER.test(ch)) letters++;
  }
  const pauses =
    (text.match(CLAUSE) ?? []).length * CLAUSE_MS +
    (text.match(STOP) ?? []).length * STOP_MS;
  return Math.round((syllables / SYL_PER_SEC + letters / LATIN_PER_SEC) * 1000 + pauses);
}
