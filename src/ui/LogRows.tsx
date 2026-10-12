import { memo } from "react";
import type { ReactElement } from "react";
import { countLogBoxed } from "./rows";

/**
 * 那一整排日志行的容器。单独一个 memo **组件**，和 `BeatRail` 里那个 `Beats` 是同一句话：
 * `App` 是唯一的 `useSyncExternalStore` 订阅者，时钟每一帧整棵重渲染，那个 div 若裸写在 `App` 里就
 * 每帧是一个新元素，于是 React 每帧都要把里面那 n 行 child 逐格走一遍才知道能不能跳过 —— 哪怕行元素
 * 引用一个没换（`rowsFor` 那份 `published` 引用是稳的）。容器做成 memo 组件，`rows` 与 `lines` 两样
 * prop 逐格相同的那一刻整棵子树都不进了。
 *
 * 住在单独一个文件里是仓库那条 lint 规矩（`react/only-export-components`）要的：`rows.tsx` 是那本
 * 账，账里不许夹组件，否则 fast refresh 在这一头整棵失效 —— 和 `Seg` 拆出 `segs.tsx` 同一句。
 *
 * 为什么连 `lines` 一起进来而不只包 `rows`：`lines`（导演讲的那几句）和那 n 行同是这个 div 的孩子，
 * 裸写在 `App` 里那一头每帧也要走一遍；`lines` 是 App 的 state，只在导演讲话时换引用，所以带子没动、
 * 导演也没讲的那一刻它一样稳，容器一次不进。反过来若只 memo 行、把 `lines` 留在 `App`，那一半仍然
 * 每帧付。
 */
interface Props {
  /** `rowsFor` 交出去的那一份：没脏就还是同一个引用。 */
  rows: readonly ReactElement[];
  /** 导演讲的那几句，跟着 token 流换引用；它换的那一刻容器该进。 */
  lines: { beat: number; text: string }[];
}

export const LogRows = memo(function LogRows({ rows, lines }: Props) {
  countLogBoxed();
  return (
    <div className="panel log">
      {rows}
      {lines
        .filter((l) => l.text.trim().length > 0)
        .map((l, i) => (
          <div className="director-text" key={`${l.beat}:${i}`}>
            <em>第 {l.beat} 拍</em>
            <span>{l.text}</span>
          </div>
        ))}
    </div>
  );
});
