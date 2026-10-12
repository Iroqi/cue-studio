import { memo } from "react";
import type { Beat } from "../engine/types";
import type { SegPrint, SegView } from "./segs";

export interface SegProps extends SegView {
  /** 只许被**点下去的那一刻**读（`seek(b.start)`、`onArm(b, i)`），不许印 —— 印的是 `p`。 */
  b: Beat;
  i: number;
  p: SegPrint;
  now: boolean;
  armed: boolean;
}

/**
 * 这一段有多宽：`flex-basis: 0` + `flex-grow` = **这一拍自己的毫秒数** + `min-width: 46px` 那道下限。
 * 于是分完容器宽度之后段与段之比正是时长之比，而"整场一共多长"这一个数根本进不到这一层 —— 旧写法是
 * `width: max(46px, share%)`，`share` 的分母是 `duration`，所以**落一笔就把每一段的宽度都改了**：
 * n 段每一段都得重新 render（实测 4800 段一批 240ms，带子越长越贵，而一笔本来只该付它自己那一截）。
 *
 * 下限仍然要有人守：一拍都不站得住的时候各段占自己的 46px，容器（`.beats` 那句 `overflow-x: auto`）
 * 出横向滚动条 —— 和当年 `max(46px, …)` 是同一件事，只是不再需要有人先把整场量一遍。
 *
 * 住在单独一个文件里是仓库那条 lint 规矩（`react/only-export-components`）要的：`segs.tsx` 是那本
 * 账，账里不许夹组件，否则 fast refresh 在这一头整棵失效。
 */
export const Seg = memo(function Seg({ stage, teacher, onArm, b, i, p, now, armed }: SegProps) {
  const rolled = !!teacher?.canReroll(p.turn);
  return (
    <div
      data-now={now || undefined}
      className={"seg" + (now ? " now" : "") + (p.ask ? " ask" : "") + (armed ? " armed" : "")}
      style={{ flexGrow: p.grow, flexBasis: 0, minWidth: 46 }}
    >
      <button className="seg-main" onClick={() => (stage.seek(b.start), stage.play())} title={p.title}>
        <em>{i + 1}</em>
        <span>{p.headline}</span>
        {p.ask && <b className="q">问</b>}
      </button>
      <button
        className="seg-roll"
        disabled={!rolled}
        title={rolled ? "从这一拍剪断，重排" : "没有可回去的排练现场（录像只能重放，不能改）"}
        onClick={() => onArm(b, i)}
      >
        ⟲
      </button>
    </div>
  );
});
