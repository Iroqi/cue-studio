import { useEffect, useRef, useState } from "react";
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
 * The process made visible: one segment per beat, as wide as the stage time it actually takes.
 * Click to stand the clock there; ⟲ cuts the tape at that beat and sends the director back to
 * what their head held before the pass that staged it.
 */
export function BeatRail({ stage, teacher, t, duration }: Props) {
  const [armed, setArmed] = useState<{ beat: Beat; index: number } | null>(null);
  const [why, setWhy] = useState("");
  const beats = stage.compiled.beats;
  const now = useRef<HTMLDivElement>(null);

  useEffect(() => {
    now.current?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [beats.length, Math.round(t / 500)]);

  if (beats.length === 0) return null;
  const total = Math.max(duration, 1);

  const ready = (b: Beat) => !!teacher?.canReroll(b.turn);
  const roll = () => {
    if (!armed || !teacher) return;
    const beat = armed.beat;
    setArmed(null);
    void teacher.rerollFrom(beat.seqs[0], why);
  };

  return (
    <nav className="rail">
      <div className="beats">
        {beats.map((b, i) => {
          const current = t >= b.start && t < Math.max(b.end, b.start + 1);
          const share = ((b.end - b.start) / total) * 100;
          return (
            <div
              ref={current ? now : undefined}
              key={b.seqs[0]}
              className={"seg" + (current ? " now" : "") + (b.gate ? " ask" : "") + (armed?.beat.seqs[0] === b.seqs[0] ? " armed" : "")}
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
                disabled={!ready(b)}
                title={ready(b) ? "从这一拍剪断，重排" : "没有可回去的排练现场（录像只能重放，不能改）"}
                onClick={() => {
                  setArmed(armed?.beat.seqs[0] === b.seqs[0] ? null : { beat: b, index: i });
                  setWhy("");
                }}
              >
                ⟲
              </button>
            </div>
          );
        })}
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
