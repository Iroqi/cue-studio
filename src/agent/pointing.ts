/**
 * 学习者指着台上的一处发问。
 *
 * `point_at` 是导演指名让学习者点；这里反过来 —— 画面在走、没有卡开着的时候，他自己指着
 * 某一件道具上的某一点问。点不落带、不停表、不入档案，它就是一句他说的话，只不过这句话里
 * 带着一个他说不出来的坐标：那一点在道具**自身框**里的比例（0..1），和 `camera.at` 是同一套。
 *
 * 所以回执里只许有"他指着哪里"和"他说了什么"：没有任何"来自界面"的标记 —— 和 offer 的
 * phrase 同一条规矩。按钮不是说话人，他只是指了一下。
 */
export interface PointAt {
  x: number;
  y: number;
}

/** 两点小数、夹在框内：消息里的数与 `camera.at` 的单位一致，导演不用换算。 */
function frac(n: number): string {
  const v = Number.isFinite(n) ? n : 0.5;
  return (Math.round(Math.min(1, Math.max(0, v)) * 100) / 100).toFixed(2);
}

/**
 * 一句话，两句走向：带着问题走，和只剩"这里没懂"走。
 * 空问题不是一次误触 —— 它就是"指一下，换个讲法"那扇最短的门。
 */
export function pointedMessage(label: string, at: PointAt, question = ""): string {
  // 道具标签是导演写的，可能带换行或连排空白 —— 压成单空格再嵌进句子，别让消息格式断行。
  const who = label.trim().replace(/\s+/g, " ") || "那件东西";
  const spot = `台上的「${who}」这一点（x=${frac(at.x)}，y=${frac(at.y)}）`;
  const q = question.trim();
  return q ? `我指着${spot}问：${q}` : `我指着${spot}—— 这里没懂，换个讲法。`;
}
