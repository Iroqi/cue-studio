import { useState } from "react";
import { attempts, forget } from "../agent/archive";

/**
 * The unmodifiable half of the learner model: what he actually clicked. Everything the director
 * *believes* about this person lives in the prompt sections and can be wrong; this is the record.
 */
export function LearnerArchive() {
  const [, setTick] = useState(0);
  const all = attempts().slice().reverse();
  const wrong = all.filter((a) => !a.correct).length;

  return (
    <div className="panel archive">
      <p className="hint">
        只存他真答过的题。导演对这个人的一切判断都在上下文里，是可以出错的；这里是他答对答错的事实本体，
        下一场演出时与本课题相关的部分会被读进 &lt;learner-history&gt;。存在本机 localStorage，不上传。
      </p>
      <div className="arch-head">
        <span className="count">
          {all.length} 次作答 · {wrong} 次答错 · {new Set(all.map((a) => a.topic || "（未记课题）")).size} 个课题
        </span>
        <button
          disabled={all.length === 0}
          title="忘掉这个人答过的所有题：下一次演出把他当陌生人"
          onClick={() => {
            forget();
            setTick((t) => t + 1);
          }}
        >
          忘记我
        </button>
      </div>
      {all.length === 0 && <p className="hint">还没有作答记录。他答过的每一道题都会出现在这里。</p>}
      {all.map((a, i) => (
        <div className={"arch" + (a.correct ? " right" : " miss")} key={`${a.at}-${i}`}>
          <div className="arch-topic">
            {a.topic || "（未记课题）"}
            <em>{new Date(a.at).toLocaleString()}</em>
          </div>
          <div className="arch-q">{a.prompt}</div>
          {a.concept && <div className="arch-c">探的是「{a.concept}」</div>}
          <div className="arch-a">
            他选了「{a.options[a.choice] ?? "？"}」
            {a.correct ? "" : ` —— 正确项「${a.options[a.answer] ?? "？"}」`}
          </div>
        </div>
      ))}
    </div>
  );
}
