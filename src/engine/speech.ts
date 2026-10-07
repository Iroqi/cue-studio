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

const SYLLABLE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
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
