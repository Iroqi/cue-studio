import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Stage } from "../engine/runtime";
import type { Beat } from "../engine/types";
import type { Teacher } from "../agent/loop";
import { beatAt } from "./score";
import { segsFor, nowStore, countBoxed, type SegView } from "./segs";

interface Props {
  stage: Stage;
  teacher: Teacher | null;
  t: number;
}

/**
 * 那一条横滚的容器。单独一个 memo **组件**而不是 `useMemo` 一个元素，是量出来的差别：元素引用不变时
 * React 仍要把那 n 个 child 逐格走一遍才知道可以跳过（实测 4800 段一帧 0.16ms，改前 0.03ms），而
 * memo 组件在 props 逐格相同的那一刻整棵子树都不进了（0.03ms）。它只有两样 prop —— `segs` 就是
 * `segsFor` 交出来的那一份（没脏就还是同一个引用），`rail` 是那根稳定的 ref。所以不跨拍也不落笔的
 * 那一帧一次都不走，这一件才真的把"跨拍那一帧"和"什么都不动那一帧"都做成了常数。
 */
const Beats = memo(function Beats({ segs, rail }: { segs: readonly ReactElement[]; rail: RefObject<HTMLDivElement | null> }) {
  countBoxed();
  return (
    <div className="beats" ref={rail}>
      {segs}
    </div>
  );
});

/**
 * The process made visible: one segment per beat, as wide as the stage time it actually takes.
 * Click to stand the clock there; ⟲ cuts the tape at that beat and sends the director back to
 * what their head held before the pass that staged it.
 *
 * 段元素由 `segsFor` 那本账记住（`ui/segs.tsx`）：这一棵树每帧都会问一次，而"亮着哪一拍"和"整条
 * 有多长"都不该让已经排好的那一段重新做一遍。宽度是 `flexGrow` = 这一拍自己的毫秒数，所以整场
 * 长度这一个数不再进任何一段。
 */
export function BeatRail({ stage, teacher, t }: Props) {
  const [armed, setArmed] = useState<{ beat: Beat; index: number } | null>(null);
  const [why, setWhy] = useState("");
  const beats = stage.compiled.beats;
  const rail = useRef<HTMLDivElement>(null);
  const now = beatAt(beats, t);
  const onArm = useCallback((b: Beat, index: number) => {
    setArmed((prev) => (prev?.beat.seqs[0] === b.seqs[0] ? null : { beat: b, index }));
    setWhy("");
  }, []);

  // Above the early return below: an empty tape is a real state this component renders through, and a
  // hook that only sometimes runs is a hook React will read off the wrong slot the moment a beat lands.
  // Both dep entries are extracted to locals: the lint rule rejects complex expressions in a dep array,
  // and the 500ms tick is the only thing the follow-the-playhead scroll should react to.
  const beatsLen = beats.length;
  const scrollTick = Math.round(t / 500);
  useEffect(() => {
    rail.current?.querySelector("[data-now]")?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [beatsLen, scrollTick]);

  // 这一双手每帧都是新对象，可 `holds` 比的是里面的三样：还是这台机器、这个导演、这个回调。
  const view: SegView = { stage, teacher, onArm };
  const segs = segsFor(stage.compiled, view, now, armed?.beat.seqs[0]);
  // 那台机器与 `segsFor` 建的那本账同一台（同一条拍表 → WeakMap 查到同一个 store）。`now` 只往它身上推，
  // 不进元素、不换数组。推进 `useLayoutEffect`（提交之后）而不是 render 里 —— 探针实测在 render 里 notify
  // 会 "Cannot update a component (`Seg`) while rendering a different component (`BeatRail`)"。
  const store = nowStore(stage.compiled);
  useLayoutEffect(() => {
    store.set(now);
  }, [store, now]);
  if (beats.length === 0) return null;

  const roll = () => {
    if (!armed || !teacher) return;
    const beat = armed.beat;
    setArmed(null);
    void teacher.rerollFrom(beat.seqs[0], why);
  };

  return (
    <nav className="rail">
      <Beats segs={segs} rail={rail} />
      {armed && (
        <div className="roll-bar">
          <span className="who">
            第 {armed.index + 1} 拍 · {Math.round(armed.beat.start)}–{Math.round(armed.beat.end)}ms ·{" "}
            {armed.beat.headline.slice(0, 22) || "（无声调度）"}
          </span>
          <input
            autoFocus
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && roll()}
            placeholder="这一拍哪里不对？留空就换一种排法"
          />
          <button className="go" onClick={roll}>
            重排
          </button>
          <button onClick={() => setArmed(null)}>取消</button>
        </div>
      )}
    </nav>
  );
}
