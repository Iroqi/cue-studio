export interface Attempt {
  at: number;
  topic: string;
  prompt: string;
  options: string[];
  choice: number;
  answer: number;
  correct: boolean;
  /** The idea the question probed, in the teacher's own wording — what makes two misses the same miss. */
  concept?: string;
}

const KEY = "canvas-teacher.learner";
const KEEP = 60;

/**
 * The evidence rule: only what the learner actually selected is stored here. A teacher model's
 * opinion about the learner lives in `<progress>` and is a claim; this file is the part that
 * happened. Silence, skipped beats and a model's confidence record nothing at all.
 */
export function attempts(): Attempt[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Attempt[];
    return Array.isArray(raw) ? raw.filter((a) => typeof a.choice === "number" && Array.isArray(a.options)) : [];
  } catch {
    return [];
  }
}

export function record(a: Attempt) {
  localStorage.setItem(KEY, JSON.stringify(attempts().concat(a).slice(-KEEP)));
}

export function forget() {
  localStorage.removeItem(KEY);
}

/**
 * Matched loosely on purpose: 「向量加法」 and 「向量加法：三角形法则」 are the same course to the
 * person who took both, and a strict key would silently drop the evidence between lessons.
 */
export function forTopic(topic: string): Attempt[] {
  const t = topic.trim();
  if (!t) return [];
  return attempts().filter((a) => {
    const u = (a.topic ?? "").trim();
    return u !== "" && (u === t || u.includes(t) || t.includes(u));
  });
}

/**
 * How often this learner has already fallen on this exact idea. One wrong option is a slip; the
 * same idea missed twice under two different wordings is a shape in his head that has to be
 * replaced, not corrected.
 */
export function missesOn(topic: string, concept: string | undefined): number {
  if (!concept) return 0;
  return forTopic(topic).filter((a) => a.concept === concept && !a.correct).length;
}

/** Fed to the director as a prompt section: where this person has already fallen, in their words. */
export function summary(topic: string): string {
  const mine = forTopic(topic).slice(-8);
  if (mine.length === 0) return "";
  const lines = mine.map((a) => {
    const picked = a.options[a.choice] ?? "（没作答）";
    const verdict = a.correct ? "答对" : `答错 —— 正确项是「${a.options[a.answer] ?? "?"}」`;
    return `- 「${(a.concept ?? a.prompt).slice(0, 34)}」他选过「${picked}」，${verdict}（${new Date(a.at).toLocaleDateString()}）`;
  });
  const stuck = new Map<string, number>();
  for (const a of mine) if (!a.correct && a.concept) stuck.set(a.concept, (stuck.get(a.concept) ?? 0) + 1);
  const repeated = [...stuck.entries()].filter(([, n]) => n >= 2).map(([c, n]) => `${c} ×${n}`);
  return (
    `这个人在这个课题上真的答过的题（答过的才是证据；没答过的不要替他假设）：\n${lines.join("\n")}` +
    (repeated.length ? `\n反复错过的同一处：${repeated.join("、")}。同一个载体他已经吃过两次亏 —— 换一种载体讲，不要再画一遍同样的图。` : "")
  );
}
