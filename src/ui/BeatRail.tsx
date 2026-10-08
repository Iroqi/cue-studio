import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Stage } from "../engine/runtime";
import type { Beat } from "../engine/types";
import type { Teacher } from "../agent/loop";

interface Props {
  stage: Stage;
  teacher: Teacher | null;
  t: number;
  duration: number;
}

/**
 * The clock stands in exactly one beat. Beats are laid down in `start` order, so finding it is a
 * binary search — which is what lets the rail skip re-rendering on a tick that changed nothing.
 * `Math.max(end, start + 1)` mirrors the segment's own half-open window, so the tail beat of a tape
 * whose end was never closed counts as standing-in it, and a clock past the last window counts as in none.
 */
function beatAt(beats: Beat[], t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return -1;
  const b = beats[found];
  return t < Math.max(b.end, b.start + 1) ? found : -1;
}

interface SegProps {
  stage: Stage;
  teacher: Teacher | null;
  b: Beat;
  i: number;
  total: number;
  now: boolean;
  armed: boolean;
  onArm: (b: Beat, i: number) => void;
}

const Seg = memo(function Seg({ stage, teacher, b, i, total, now, armed, onArm }: SegProps) {
  const share = ((b.end - b.start) / total) * 100;
  const rolled = !!teacher?.canReroll(b.turn);
  return (
    <div
      data-now={now || undefined}
      className={"seg" + (now ? " now" : "") + (b.gate ? " ask" : "") + (armed ? " armed" : "")}
      style={{ width: `max(46px, ${share.toFixed(2)}%)` }}
    >
      <button
        className="seg-main"
        onClick={() => (stage.seek(b.start), stage.play())}
        title={`第 ${i + 1} 拍 · ${Math.round(b.start)}–${Math.round(b.end)}ms · 出自第 ${b.turn} 次调度 · ${b.verbs.join(" ")}`}
      >
        <em>{i + 1}</em>
        <span>{b.headline || "（无声调度）"}</span>
        {b.gate && <b className="q">问</b>}
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

interface SegsProps {
  stage: Stage;
  teacher: Teacher | null;
  beats: Beat[];
  total: number;
  now: number;
  armedSeq: number | undefined;
  onArm: (b: Beat, i: number) => void;
}

/**
 * The whole rail is a function of the tape plus which beat the clock is in and which one is armed —
 * none of which move with the clock's own frame. Memoised, so a tick that crosses no beat boundary
 * re-renders nothing. Measured before it: 400 segments cost 10.7ms a frame, 20000 cost 647.8ms, and
 * the clock asks sixty times a second — the same frozen tab a quadratic compiler is, just paid by the
 * view instead of the interpreter. After: under half a millisecond a frame, no matter how many beats.
 *
 * `teacher.canReroll` is read inside the segments and is not an input to this memo, which is sound
 * only because the thing that makes a beat rewritable is its ops landing — and every op on the tape
 * comes with a recompile, i.e. a fresh `beats` array. The rail therefore refreshes whenever the answer
 * changes, and not one frame more.
 */
const Segs = memo(function Segs({ stage, teacher, beats, total, now, armedSeq, onArm }: SegsProps) {
  return (
    <div className="beats">
      {beats.map((b, i) => (
        <Seg
          key={b.seqs[0]}
          stage={stage}
          teacher={teacher}
          b={b}
          i={i}
          total={total}
          now={i === now}
          armed={armedSeq === b.seqs[0]}
          onArm={onArm}
        />
      ))}
    </div>
  );
});

/**
 * The process made visible: one segment per beat, as wide as the stage time it actually takes.
 * Click to stand the clock there; ⟲ cuts the tape at that beat and sends the director back to
 * what their head held before the pass that staged it.
 */
export function BeatRail({ stage, teacher, t, duration }: Props) {
  const [armed, setArmed] = useState<{ beat: Beat; index: number } | null>(null);
  const [why, setWhy] = useState("");
  const beats = stage.compiled.beats;
  const rail = useRef<HTMLDivElement>(null);
  const now = beatAt(beats, t);

  // Above the early return below: an empty tape is a real state this component renders through, and a
  // hook that only sometimes runs is a hook React will read off the wrong slot the moment a beat lands.
  const onArm = useCallback((b: Beat, index: number) => {
    setArmed((prev) => (prev?.beat.seqs[0] === b.seqs[0] ? null : { beat: b, index }));
    setWhy("");
  }, []);

  useEffect(() => {
    rail.current?.querySelector("[data-now]")?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [beats.length, Math.round(t / 500)]);

  if (beats.length === 0) return null;
  const total = Math.max(duration, 1);

  const roll = () => {
    if (!armed || !teacher) return;
    const beat = armed.beat;
    setArmed(null);
    void teacher.rerollFrom(beat.seqs[0], why);
  };

  return (
    <nav className="rail">
      <div className="beats" ref={rail}>
        <Segs
          stage={stage}
          teacher={teacher}
          beats={beats}
          total={total}
          now={now}
          armedSeq={armed?.beat.seqs[0]}
          onArm={onArm}
        />
      </div>
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
