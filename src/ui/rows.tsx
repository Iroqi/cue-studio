import { type ReactElement } from "react";
import { MAIN_TRACK } from "../engine/log";
import type { Compiled, Gate, OpEntry } from "../engine/types";

/**
 * 这层唯一的钱是**做元素**：一行 React 元素要把那笔 op 折成一句人话。所以价钱层数的就是它 ——
 * `describeOp` 门口加一，谁都绕不过去（行元素只能从这里出来）。
 *
 * 不数毫秒：共享 CI 的噪声比省下来的那些毫秒大，而"这一层做了几行"就是它付过的指纹。
 * `view.test.ts` 那一件拿 `teacher.canReroll` 的调用次数当"这一段被重画过"的指纹，是同一句话。
 *
 * 第二格 `published` 数的是**交出去的行数**（每抄一份对外那份就加一次带子的长度）。它钉的是这一件
 * 没能消掉的那一笔：React 认的是子数组的引用，所以长过尾巴之后那一份必须重新交 —— 见 `RowIndex`
 * 头上那段。它是**每批一次 O(带子) 的指针抄**，不是每批一次 O(带子) 的折句子，差着整整一个量级，
 * 可它确实是跟着带子长的，所以记在这里、钉在测试里，不许当成免费。
 *
 * 第三格 `boxed` 是 E 补的，钉的是**另一件东西**：那一整排行的容器（`LogRows`）自己有没有被进去。
 * `App` 是唯一的 `useSyncExternalStore` 订阅者，时钟每一帧整棵重渲染；容器不 memo 时那 n 行的元素引用
 * 一个也不会重做（`described` 一次不涨、`published` 一次不动），可 React 仍然把那 n 格**走了一遍**
 * —— 这一笔前两把尺子都量不到，所以容器自己门口加一个数：进了就是走了一遍。与 `railMeter.boxed` 同形。
 */
export const rowsMeter = { described: 0, published: 0, boxed: 0 };

/**
 * 容器门口那一格。单独一个函数而不是让 `LogRows` 自己写 `rowsMeter.boxed += 1`：仓库那条 lint 规矩
 * （`react/immutability`）不许在 render 里改模块外那个对象，而这一问要的恰恰是"render 里进没进"。
 * 与 `segs.tsx` 的 `countBoxed` 是同一句；`described` 与 `published` 加在非组件的函数里没有这个问题。
 */
export function countLogBoxed(): void {
  rowsMeter.boxed += 1;
}

/**
 * 一行文字。它读的只有自己那一笔的 `op` 字段，加上 `gates` 里那张卡的 `op.prompt`。
 *
 * 这一句是整件的前提，所以它得有人钉（`rows.test.ts` 的护栏）：`Gate.said` 是一个正被身后那一笔
 * 回头填的字段（`answer` 落在带子上身后那一刀的位置，把一张早就进过账的卡从 `null` 改成一句话），
 * 而这里一个字也没印它。`op` 落在卡上就不再动（`guard.revise` 那条"改不动就不换对象"），所以
 * 已经排好的那一行不许因为身后那一笔而改口 —— 哪天有人把"他答过了"印进日志，按落下次序记元素
 * 就当场是错的。护栏拿变异钉的就是这一句。
 */
export function describeOp(e: OpEntry, gates: Map<number, Gate>): string {
  rowsMeter.described += 1;
  const o = e.op as unknown as Record<string, unknown> & { kind: string };
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const n = (k: string) => (typeof o[k] === "number" ? Math.round(o[k] as number) : "");
  const box = () => {
    const b = o.box;
    if (typeof b !== "object" || b === null) return "";
    const { x = 0, y = 0, w = 0, h = 0 } = b as Record<string, number>;
    return `@${Math.round(x)},${Math.round(y)} ${Math.round(w)}×${Math.round(h)}`;
  };
  switch (o.kind) {
    case "build":
      return `build ${s("id")} · ${s("label")}${box()} (${s("scene")})`;
    case "patch":
      return `draw ${s("id")}${o.svg ? ` ← ${String(o.svg).length} 字符图形` : ""}`;
    case "recall":
      return `recall ${s("id")} → ${s("scene")}`;
    case "discard":
      return `discard ${s("id")}`;
    case "camera": {
      const where = Array.isArray(o.target) ? (o.target as string[]).join("+") : s("follow");
      const at = o.at as { x?: number; y?: number } | undefined;
      const bits = [
        `camera ${s("mode")}`,
        where,
        o.dir ? `→ ${s("dir")} ${typeof o.screens === "number" ? o.screens : 0.8} 屏` : "",
        at ? `部位 ${at.x ?? 0},${at.y ?? 0}×${typeof o.span === "number" ? o.span : 0.35}` : "",
        o.region ? "rect" : "",
        `${n("duration")}ms`,
      ];
      return bits.filter(Boolean).join(" ");
    }
    case "narrate": {
      const style = o.style === "verse" ? " ·verse" : o.style === "voice" ? " ·只出声" : "";
      return `旁白 ${n("duration")}ms${style} 「${s("text")}」`;
    }
    case "transition":
      return `换场 ${s("style")} → ${s("to")}`;
    case "highlight":
      return `highlight ${s("target")} ${s("style")}`;
    case "motion":
      return `motion ${s("mode")} ${s("id")} ${n("amp")}px/${n("period")}ms ×${n("duration")}ms`;
    case "beat":
      return `静默 ${n("duration")}ms`;
    case "quiz":
      return `提问：${s("prompt")}`;
    case "answer": {
      const settled = typeof o.gate === "number" ? gates.get(o.gate) : undefined;
      const asked = settled?.op.kind === "quiz" ? settled.op.prompt : "";
      return `他答：「${s("text")}」${asked ? ` —— ${asked.slice(0, 24)}` : ""}`;
    }
    case "pause-for":
      return `等待：${s("reason")}`;
    case "link":
      return `link ${s("from")} ${s("relation")} ${s("to")}`;
    default:
      return o.kind;
  }
}

function rowEl(e: OpEntry, gates: Map<number, Gate>): ReactElement {
  return (
    <div className={e.track === MAIN_TRACK ? "row" : "row aside"} key={e.seq}>
      <em>{e.seq}</em>
      <span>{describeOp(e, gates)}</span>
    </div>
  );
}

/**
 * 排好的那批行。
 *
 * 这一本账和 `TapeIndex` 是同一句话：带子只长尾巴，所以"续排"就是"只吸收新落的那一段"。它不重新
 * 解释任何东西 —— 拿的就是 `Compiled` 里那张卡表和带子本身的那些格子，所以"这层排错了"和
 * "解释器排错了"不会混成一处。
 *
 * 交出去的**每一格是同一个元素引用**（React 拿到同一个引用才肯逐棵子树跳过），但长过尾巴之后那一份
 * 必须换成一个新数组。这一条是踩出来的：那些行是那个 div 的多个 child 之一，React 给它一个 fragment
 * 节点，浅比对时问的就是**这个数组本身的引用** —— 引用没换，整串就当没变，往同一份数组里 push 的那
 * 一行永远进不去 DOM，面板冻在最后一次换数组的那一格上。实测：带子 51 格，DOM 里 50 行
 * （`view.test.ts` 钉的就是这个数）。探针第一版拿"数组是唯一的 child"试，那一头两种写法都进得去，
 * 差点让我以为这是免费的 —— 教训还是那句：探针得先证明自己量得到东西。
 * 只记住每行的文字也不够 —— 那样每帧还在重做几千个元素（`view.test.ts` 那一件早就立过这句话）。
 */
export class RowIndex {
  private readonly tape: readonly OpEntry[];
  private readonly gates: Gate[];
  private readonly rows: ReactElement[] = [];
  /** 卡号 → 那张卡。建表与吸收尾巴时都只往这一张里接新落的，从不重扫整张卡表。 */
  private readonly bySeq = new Map<number, Gate>();
  /** 吸收到第几格、卡表读到第几张。两个游标都只往前走。 */
  private at = 0;
  private gateAt = 0;
  /**
   * 等着某张卡进账的那些行：一行 `answer` 指着一张**还没落下来**的卡号。
   *
   * 现场直播里这一张永远是空的（`stage.answerGate` 只会替他眼前那张卡落 `answer`）。它之所以得有，
   * 是因为带子是别人上的一堂课：`restore` 按号排，所以"答在问之前"是一卷合法的带子，而旧写法每一批
   * 拿整张卡表重排整卷，那一行自然会在卡落下那一批里被重做一次、指到那道题。续排不许丢这个答案，
   * 所以由**知道改动的那一方**（卡进账这一刻）回头补那一行 —— 补的是那一格，不是整卷。
   * 这一句和 `StandingIndex` 那条 `touched` 流水是同一个形状，只是这里等的东西少到可以直接记下来。
   */
  private readonly waiting = new Map<number, number[]>();
  /**
   * 交出去的那一份。`null` 意思是"这一本账已经变了，下一问得重新抄一份引用"。
   *
   * 为什么不许直接交 `rows` 本身：见类头上那段 —— 同一个数组引用会让 React 整棵子树当没变，新落的
   * 那一行永远进不去 DOM。为什么不许每批无条件抄：那一头每一批付一次带子的长度，而"这一批没长尾巴、
   * 也没人回头补行"是现场直播里绝大多数帧的常态（时钟一秒钟走六十帧，一帧都不该抄）。
   */
  private published: ReactElement[] | null = null;

  constructor(tape: readonly OpEntry[], gates: Gate[]) {
    this.tape = tape;
    this.gates = gates;
    this.grow();
  }
  /**
   * 认的还是不是**同一张卡表**。带子那一问由调用方的键回答（`rowsFor` 拿那一卷带子本身当 WeakMap 的
   * 键），所以这里只比这一张。
   *
   * 比这一张是有理由的，而且代价不对称：`Compiled` 那份记录每批都是新对象，可里面的 `gates` 是机器
   * 手上那张会长大的数组 —— 插播那一头是**另一台机器**的另一张数组。只认带子的写法会把新落的那些行
   * 接到一本换了卡表的账上，那一头每一行都指不到自己的题卡。
   */
  holds(gates: Gate[]): boolean {
    return this.gates === gates;
  }

  /**
   * 只长尾巴：先把卡表新落的那一截接进查表，再把带子新落的那几格排成行。
   *
   * 次序要紧：旧写法是拿**整张卡表**（含本批那几张）排整卷，所以"同一批里 `answer` 紧跟在它答的那张
   * 卡后面"那一行印得出题面。反过来（先排行再收卡）那一行就印不出了 —— 那是改语义，不是省价钱。
   */
  grow(): void {
    while (this.gateAt < this.gates.length) this.register(this.gates[this.gateAt++]);
    while (this.at < this.tape.length) this.absorb(this.at++);
  }

  private register(g: Gate): void {
    this.bySeq.set(g.seq, g);
    const owed = this.waiting.get(g.seq);
    if (!owed) return;
    this.waiting.delete(g.seq);
    this.published = null;
    for (const i of owed) this.rows[i] = rowEl(this.tape[i], this.bySeq);
  }

  private absorb(i: number): void {
    const e = this.tape[i];
    this.rows.push(rowEl(e, this.bySeq));
    this.published = null;
    const o = e.op as { kind: string; gate?: number };
    if (o.kind === "answer" && typeof o.gate === "number" && !this.bySeq.has(o.gate)) {
      const back = this.waiting.get(o.gate);
      if (back) back.push(i);
      else this.waiting.set(o.gate, [i]);
    }
  }

  /**
   * 对外那一份：这一本账没动过就交同一个引用（时钟那一帧就该整棵子树跳过），动过就重新抄一份。
   *
   * 抄的是**引用**，不是句子：`slice` 一次走的是已经折好的那些元素，一行的句子不会因此重做。
   * `rowsMeter.published` 数的就是这一笔，它跟着带子长 —— 这一件消不掉它，因为那一句"这一卷多了一行"
   * 只能靠换引用告诉 React（`RowIndex` 头上实测那一段），消掉的是每批把整卷折成句子的那一笔。
   */
  view(): readonly ReactElement[] {
    if (!this.published) {
      this.published = this.rows.slice();
      rowsMeter.published += this.published.length;
    }
    return this.published;
  }
}

/**
 * 一本账挂在那卷带子上，不挂在组件里。
 *
 * 为什么：换了带子（剪带、载入、清空）必须整卷重排，而"还是不是那一卷"这一问只有一个诚实的答案可问
 * —— 引用。组件重挂、tab 来回切都不该替学习者把整卷再排一遍（那本来就是同一卷带子），可这些也不该
 * 让已经排好的那些行留着。WeakMap 的键就是那一卷带子本身，换卷当场就找不到旧账 —— 和
 * `cutFrom`/`restore`/`clear` 换数组那三扇门同一句政策，也和解释器认带子那一问（`Interpreter.holds`）
 * 同一个形状。
 */
const cached = new WeakMap<readonly OpEntry[], RowIndex>();

/**
 * 门。与 `reindex(ix, compiled)` / `restand(ix, compiled)` 同形，只是"上一次那本账"由带子的引用
 * 自己找回来，不由调用方握着。
 *
 * 调用方每批都会问到（它那份 `Compiled` 记录每批都是新对象），这一点这一件**不改**，因为"带子长了
 * 几格"在引用上根本没有答案可问：`log.tape` 落一笔不换数组，拿它当依赖就永远不会重排。那份新对象
 * 在这里的意思是"该问了"，而**价钱由这本账决定**：落一批只吸收新落的那几行。
 */
export function rowsFor(compiled: Compiled, tape: readonly OpEntry[]): readonly ReactElement[] {
  const held = cached.get(tape);
  if (held && held.holds(compiled.gates)) {
    held.grow();
    return held.view();
  }
  const fresh = new RowIndex(tape, compiled.gates);
  cached.set(tape, fresh);
  return fresh.view();
}
