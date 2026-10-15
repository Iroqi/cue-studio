import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Stage } from "./engine/runtime";
import { Narrator } from "./engine/narrator";
import { decodeTape, encodeTape } from "./engine/share";
import { StageView } from "./engine/StageView";
import { Teacher, ESC_RETRY, ESC_SKIP } from "./agent/loop";
import { asideScore, continuationScore, paintScript, rehearsalScore } from "./agent/rehearsal";
import { ModelConfig } from "./ui/ModelConfig";
import { BeatRail } from "./ui/BeatRail";
import { beatAt, scoreOf } from "./ui/score";
import { LearnerArchive } from "./ui/LearnerArchive";
import { rowsFor } from "./ui/rows";
import { LogRows } from "./ui/LogRows";
import { getModels, loadConfig, saveConfig, setScriptedResponses, type LlmConfig } from "./llm/llm";
import type { DialOp, DragOp, OpEntry, TypeOp } from "./engine/types";

const RATES = [0.5, 1, 2, 4];

type Tab = "log" | "config" | "archive";

const SAMPLES = ["向量加法与力的分解", "梯度下降为什么会往下走", "复数乘法就是旋转", "极限：越靠近不等于已经到了"];

/** 逃生舱口：他不会 / 想跳过时，按钮落带的是约定短语，回执走中性态 —— 不挂答对、也不挂答错的色。 */
const ESC_NOTES: Record<string, string> = {
  [ESC_RETRY]: "好，不硬答 —— 这一拍会换个讲法",
  [ESC_SKIP]: "好，这道先跳过 —— 接着往下讲",
};

function EscapeRow({ onEscape }: { onEscape: (phrase: string) => void }) {
  return (
    <div className="escape-row">
      <button onClick={() => onEscape(ESC_RETRY)} title="把这句话落到带上：导演会换个讲法，不判分">
        我不会 · 换个讲法
      </button>
      <button onClick={() => onEscape(ESC_SKIP)} title="把这句话落到带上：导演尊重这个选择，继续往下讲">
        这道先跳过
      </button>
    </div>
  );
}

/**
 * 第三张卡：一根杆。他拨一个数，按下确认，那个数作为 answer 落带 —— 判分在导演那一头（settleGate），
 * 这一头只算一句即时的对错给个回执，不替带子说话。杆是舞台自己渲染的原生 range，不是模型交的 markup，
 * 所以 DOMPurify 那道信任边界一个字都不用动。状态只活在这张卡上：回放（live=false）根本不挂这张卡，
 * 他拨的那一下本来就不进带子，进带子的只有确认那一刻的那个数。
 */
function DialCard({ op, stage, onDone, onEscape }: { op: DialOp; stage: Stage; onDone: (ok: boolean | null, text: string) => void; onEscape: (phrase: string) => void }) {
  const mid = (op.min + op.max) / 2;
  const [v, setV] = useState(mid);
  const fmt = (x: number) => `${Number.isInteger(x) ? x : x.toFixed(2)}${op.unit ? " " + op.unit : ""}`;
  const confirm = () => {
    const ok = Math.abs(v - op.value) <= op.tol + 1e-9;
    stage.answerGate(String(v));
    onDone(ok, ok ? "拨到了" : `拨在 ${fmt(v)} —— 接下来这一拍会演出为什么`);
  };
  return (
    <>
      <p>{op.prompt}</p>
      <div className="dial">
        {op.label && <span className="dial-label">{op.label}</span>}
        <div className="dial-readout">{fmt(v)}</div>
        <input
          type="range"
          min={op.min}
          max={op.max}
          step={(op.max - op.min) / 200}
          value={v}
          onChange={(e) => setV(Number(e.target.value))}
        />
        <div className="dial-ends">
          <span>{fmt(op.min)}</span>
          <span>{fmt(op.max)}</span>
        </div>
        <button onClick={confirm}>定下这个值</button>
        <EscapeRow onEscape={onEscape} />
      </div>
    </>
  );
}

/**
 * 第四张卡：一个空格。他打出那几个字，提交，那句话原样作为 answer 落带 —— 判分在导演那一头
 * （settleGate 查该出现的词出现了没），这一头只把他写的话送上去。和 DialCard 同形：状态只活在这张卡上，
 * 回放不挂这张卡，他写了什么读的是带上的 answer。
 */
function TypeCard({ op, stage, onDone, onEscape }: { op: TypeOp; stage: Stage; onDone: (ok: boolean | null, text: string) => void; onEscape: (phrase: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    const say = text.trim();
    if (!say) return;
    const low = say.toLowerCase();
    const ok = op.accept.every((w) => low.includes(w.toLowerCase()));
    stage.answerGate(say);
    onDone(ok, ok ? "词都在" : "还缺几个词 —— 接下来这一拍会演出来");
  };
  return (
    <>
      <p>{op.prompt}</p>
      <div className="typecard">
        <input
          type="text"
          className="typecard-input"
          value={text}
          placeholder={op.placeholder ?? "在这里打出你的回答…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button onClick={submit} disabled={!text.trim()}>写下这句话</button>
        <EscapeRow onEscape={onEscape} />
      </div>
    </>
  );
}

export default function App() {
  const stage = useMemo(() => new Stage(), []);
  const snap = useSyncExternalStore(stage.subscribe, stage.getSnapshot);
  /*
   * 指令日志是这卷带子的函数，不是时钟的函数：一秒钟走六十帧，带子只在有人演出的时候动。
   * 以前每一帧都把整卷重排一遍（抽屉关着也照排，"关"只是个 CSS transform），后来改成"每批把整卷重排
   * 一遍、每帧不动"，剩下那一笔就是每一批付一次整卷的元素。现在那一笔也消掉了：`rowsFor` 认的是带子
   * 本身与那张卡表的**引用**，落一笔只排新落的那几行（`ui/rows.tsx`）。
   * 依赖留着 `compiled` 是因为"带子长没长"在引用上问不出来 —— 那份新记录是"该问了"的信号，价钱由
   * 那本账决定。
   */
  const compiled = stage.compiled;
  const tape = stage.log.tape;
  const logRows = useMemo(() => rowsFor(compiled, tape), [compiled, tape]);
  /** 这一场的账：只随带子换（compiled 换引用才重算），时钟走帧不碰它。 */
  const score = useMemo(() => scoreOf(compiled), [compiled]);
  const currentBeat = beatAt(compiled.beats, snap.t);
  const narrator = useMemo(() => new Narrator(stage), [stage]);
  const [voiced, setVoiced] = useState(() => narrator.enabled);
  const [cfg, setCfg] = useState<LlmConfig>(() => loadConfig());
  const [tab, setTab] = useState<Tab>("log");
  const [status, setStatus] = useState("给一个题目，舞台就开始排演。");
  const [verdict, setVerdict] = useState<{ ok: boolean | null; text: string } | null>(null);
  const [usage, setUsage] = useState({ input: 0, output: 0, cost: 0, calls: 0 });
  const [entry, setEntry] = useState("");
  const [topic, setTopic] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [more, setMore] = useState(false);
  const [lines, setLines] = useState<{ beat: number; text: string }[]>([]);
  const teacherRef = useRef<Teacher | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  /** The band the camera has to clear — whatever the dock actually measures, never a guessed constant. */
  const [dockH, setDockH] = useState(150);
  const [railOpen, setRailOpen] = useState(true);

  useLayoutEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDockH(el.offsetHeight));
    ro.observe(el);
    setDockH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  // The observer sees every layout change, but it is delivered on the frame lifecycle: a tab that gets
  // no frames keeps reserving the band from the number measured at mount, and the beat rail grows the
  // dock the moment the first beats land. Re-read when the dock's own content changes — the same number
  // is a no-op, so this costs no re-render, and it never runs on the clock's own frame.
  useEffect(() => {
    const el = dockRef.current;
    if (el) setDockH((h) => (el.offsetHeight === h ? h : el.offsetHeight));
  }, [railOpen, snap.duration]);

  const teacher = () => {
    if (!teacherRef.current) {
      teacherRef.current = new Teacher(stage, cfg, {
        onStatus: setStatus,
        onBusy: setSpeaking,
        onTurnStart: (beat) => setLines((ls) => (ls.length && ls[ls.length - 1].text === "" ? ls : [...ls, { beat, text: "" }])),
        onText: (_role, d) =>
          setLines((ls) => {
            if (ls.length === 0) return [{ beat: 0, text: d }];
            const last = ls[ls.length - 1];
            return [...ls.slice(0, -1), { ...last, text: last.text + d }];
          }),
        onUsage: setUsage,
      });
      (globalThis as unknown as { __teacher: Teacher }).__teacher = teacherRef.current;
    }
    return teacherRef.current;
  };

  useEffect(() => {
    saveConfig(cfg);
    teacherRef.current?.setConfig(cfg);
  }, [cfg]);

  useEffect(() => {
    (globalThis as unknown as { __stage: Stage }).__stage = stage;
  }, [stage]);

  useEffect(() => {
    narrator.attach();
    return () => narrator.detach();
  }, [narrator]);

  useEffect(() => {
    if (!verdict) return;
    const h = setTimeout(() => setVerdict(null), 4500);
    return () => clearTimeout(h);
  }, [verdict]);

  useEffect(() => {
    if (!location.hash.startsWith("#s=")) return;
    decodeTape(location.hash.slice(3)).then(
      (entries) => {
        stage.load(entries);
        // 报的是**进得来**的那几格，不是地址里带着的那几格：门会把说不清自己在哪儿的一格丢掉，
        // 而这一句是给点链接的人看的，他得知道自己眼前演的是多少刀。
        setStatus(`载入别人排过的一场：${stage.log.length} 条指令，重放它一个模型都没叫。`);
        stage.play();
      },
      (e) => setStatus(`地址里的录像读不出来：${(e as Error).message}`),
    );
  }, [stage]);

  /** A dropped teacher must stop talking: its loop still shares this stage, this status line and this beat counter. */
  const dropTeacher = () => {
    teacherRef.current?.stop();
    teacherRef.current = null;
  };

  const start = async () => {
    const topic = entry.trim();
    if (!topic) return;
    setEntry("");
    setTopic(topic);
    history.replaceState(null, "", location.pathname + location.search);
    stage.reset();
    setLines([]);
    dropTeacher();
    if (cfg.scripted) {
      getModels(cfg);
      setScriptedResponses(rehearsalScore(), paintScript());
    }
    stage.goLive();
    stage.play();
    setStatus("排演中…");
    const t = teacher();
    // The archive is keyed on the topic, so it must be the learner's words and not the instruction around it.
    t.teaching.title = topic;
    await t.say(`这一场要讲的内容：${topic}。请开始编排。`);
  };

  /**
   * One utterance from the learner. Which way it goes — on to the same board, or as an aside that
   * cuts into the passage in progress — is the loop's call, so the host only asks it and follows.
   */
  const speak = async () => {
    const q = entry.trim();
    if (!q) return;
    const t = teacher();
    const onto = t.continuesBoard();
    // Words during the cold start are not an interruption — there is nothing to interrupt yet. They are
    // held and become the next continuation, so the rehearsal deck must load the continuation score.
    const hold = !onto && stage.compiled.duration === 0;
    setEntry("");
    if (cfg.scripted) {
      getModels(cfg);
      setScriptedResponses(onto || hold ? continuationScore() : asideScore());
    }
    // A tape someone else played has no live tail: stand at its end, then keep drawing from there.
    if (onto && !stage.live) stage.goLive();
    setStatus(hold ? "这句话记下了 —— 这一排落定就接上你的。" : onto ? "接着这块板往下讲…" : "学习者打断…");
    await t.respond(q);
  };

  const exportLog = () => {
    const blob = new Blob([JSON.stringify(stage.log.export(), null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `stage-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importLog = (file: File) => {
    file.text().then((t) => {
      try {
        stage.load(JSON.parse(t) as OpEntry[]);
        setStatus("载入录像：这是上一场的过程产物，重放它不需要任何模型。");
        stage.play();
      } catch (e) {
        setStatus(`日志无效：${(e as Error).message}`);
      }
    });
  };

  /** The tape is the lesson, so the lesson travels as a URL fragment — no server, no storage. */
  const share = async () => {
    const entries = stage.log.export();
    if (entries.length === 0) return;
    const url = `${location.origin}${location.pathname}#s=${await encodeTape(entries)}`;
    history.replaceState(null, "", url);
    const kb = (url.length / 1024).toFixed(1);
    try {
      await navigator.clipboard.writeText(url);
      setStatus(`这一场的全程已经压进地址栏并复制（${kb}KB）：打开它不需要叫任何模型。`);
    } catch {
      setStatus(`这一场的全程已经压进地址栏（${kb}KB）：手动复制地址即可分享。`);
    }
  };

  const gate = snap.gate;  const isQuiz = gate?.kind === "quiz";
  const isProbe = gate?.kind === "probe";
  const isDial = gate?.kind === "dial";
  const isType = gate?.kind === "type";
  const isDrag = gate?.kind === "drag";
  // The banner names the prop the learner must move — his label, not the id he never sees.
  const dragLabel = isDrag ? (compiled.props.get((gate.op as DragOp).prop)?.revisions.at(-1)?.label ?? (gate.op as DragOp).prop) : "";
  /** 逃生舱口：按钮落带约定短语，回执走中性态（不挂答对/答错的色）—— 判分仍只由 settleGate 那一头说了算。 */
  const escapeGate = (phrase: string) => {
    stage.answerGate(phrase);
    setVerdict({ ok: null, text: ESC_NOTES[phrase] ?? "好，按你说的来。" });
  };
  // A tap on a board part closes the open probe: only the id goes to the stage, the loop grades it.
  const handlePick = (id: string) => {
    const g = snap.gate;
    if (!g || g.kind !== "probe") return;
    const right = id === (g.op as { answer: string }).answer;
    stage.answerGate(id);
    setVerdict({ ok: right, text: right ? "点对了" : "点错了 —— 接下来这一拍会演出为什么" });
  };
  // A confirmed placement on the board closes the open drag card: only the position goes to the stage,
  // the loop grades it by distance. The prop returns to its anchor — the tape holds only his answer.
  const handleDragAnswer = (x: number, y: number) => {
    const g = snap.gate;
    if (!g || g.kind !== "drag") return;
    const op = g.op as DragOp;
    const right = Math.hypot(x - op.value.x, y - op.value.y) <= op.tol + 1e-9;
    stage.answerGate(`${x},${y}`);
    setVerdict({ ok: right, text: right ? "放对了" : "放偏了 —— 接下来这一拍会演出为什么" });
  };
  // The light follows the playhead, not the ownership: looking back at your own lesson dims it, and the lesson is still yours.
  const liveTail = snap.following;
  const onto = !speaking;
  // A question can be queued while the clock is still walking up to its card; the turn is blocked on it
  // either way, so his words are an answer either way.
  const awaiting = snap.askedGate != null;
  // A lesson is underway once the board has anything on it *or* the director is already working. This
  // must not be judged by `duration` alone: during the cold start the board is still empty while a turn
  // is in flight, and opening again there would reset the stage and drop the director mid-sentence.
  const started = snap.duration > 0 || speaking;
  // Which way the next sentence goes, so the button says what pressing it will do: before anything is on
  // the board the first sentence opens the lesson; while a question is on stage his words answer it;
  // while the director is laying the first beats there is no board to cut into yet, so they are held for
  // the end of this turn; once the turn is over they go onto the same board.
  const intent = gate || awaiting ? "answer" : !started ? "open" : onto ? "continue" : snap.duration === 0 ? "queue" : "aside";

  return (
    <div className={"app" + (drawer ? " open" : "")} style={{ "--dock": `${dockH}px` } as CSSProperties}>
      <main>
        <StageView stage={stage} bottomInset={dockH} onPick={handlePick} onDragAnswer={handleDragAnswer} />
        <input
          className="timeline"
          type="range"
          min={0}
          max={Math.max(snap.duration, 1)}
          value={snap.t}
          onChange={(e) => stage.seek(Number(e.target.value))}
          title="这条细线就是这节课的时间：拖动它，回到任何一秒"
        />
        <div className="plate">
          Cue Studio <span className="sub">解释型舞台，不是成品</span>
        </div>

        <div className="transport">
          <button onClick={() => (snap.playing ? stage.hold() : stage.play())}>{snap.playing ? "暂停" : "播放"}</button>
          <button
            title="播放速度：点一下换一档 0.5× → 1× → 2× → 4×"
            onClick={() => stage.setSpeed(RATES[(RATES.indexOf(stage.getRate()) + 1) % RATES.length])}
          >
            {stage.getRate()}×
          </button>
          <span className="sep" />
          <button onClick={() => stage.rewindToBeatStart()} title="回到上一拍的开头重演">
            ⟲ 一拍
          </button>
          <button className={liveTail ? "on" : ""} onClick={() => stage.goLive()} title="别停在旧的一秒，跟到导演刚写下的那一拍">
            ● 实时
          </button>
          <button
            className={voiced ? "on" : ""}
            title={`旁白声音只是贴在时钟上的装饰，拍子长短仍然由导演说的那句决定。当前嗓音：${narrator.voiceName()}`}
            onClick={() => {
              narrator.setEnabled(!voiced);
              setVoiced(!voiced);
            }}
          >
            {voiced ? "有声" : "静音"}
          </button>
          <span className="sep" />
          <button className={more ? "on" : ""} onClick={() => setMore(!more)} title="录像的进与出">
            ⋯
          </button>
        </div>

        {more && (
          <div className="more">
            <button onClick={exportLog}>导出指令日志</button>
            <label className="file">
              导入录像
              <input type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && importLog(e.target.files[0])} />
            </label>
            <button
              disabled={stage.log.length === 0}
              title="把这一场的指令日志压进地址栏：链接就是这节课"
              onClick={() => void share()}
            >
              分享这一场
            </button>
          </div>
        )}

        {snap.duration === 0 && !speaking && (
          <div className="marquee">
            <h1>给这块板一个题目</h1>
            <p>
              知识不是列在幻灯片上的结论，是在一块无界的板上一笔一笔画出来的：道具会跨场复用，镜头会推近拉远，讲到一半会停下来问你一句。
              讲完不清板 —— 你接下来说的话，会在同一块板上继续演。
            </p>
            <div className="samples">
              {SAMPLES.map((s) => (
                <button key={s} onClick={() => setEntry(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {snap.duration === 0 && speaking && snap.gate == null && snap.askedGate == null && (
          <div className="preroll">
            <div className="preroll-lines">
              {topic
                .split(/[，、；]/)
                .map((l) => l.trim())
                .filter(Boolean)
                .slice(0, 4)
                .map((line, i) => (
                  <span key={i}>{line}</span>
                ))}
            </div>
            <p className="preroll-hint">导演在排第一拍</p>
          </div>
        )}

        {gate && !isProbe && !isDrag && (
          <div className="gate">
            <div className="gate-card">
              {isType ? (
                <TypeCard op={gate.op as TypeOp} stage={stage} onDone={(ok, text) => setVerdict({ ok, text })} onEscape={escapeGate} />
              ) : isDial ? (
                <DialCard op={gate.op as DialOp} stage={stage} onDone={(ok, text) => setVerdict({ ok, text })} onEscape={escapeGate} />
              ) : isQuiz ? (
                <>
                  <p>{(gate.op as { prompt: string }).prompt}</p>
                  <div className="opts">
                    {(gate.op as { options: string[] }).options.map((o, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          // Only the choice goes back to the stage: the verdict is the loop's to compute.
                          const right = i === (gate.op as { answer: number }).answer;
                          stage.answerGate(o);
                          setVerdict({
                            ok: right,
                            text: right ? "答对了" : "答错了 —— 接下来这一拍会演出错在哪",
                          });
                        }}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                  <EscapeRow onEscape={escapeGate} />
                </>
              ) : (
                <>
                  <p>{(gate.op as { reason: string }).reason}</p>
                  <button onClick={() => stage.answerGate("继续")}>我准备好了 · 继续</button>
                </>
              )}
            </div>
          </div>
        )}
        {/* A probe asks the learner to tap the part on the board: no blocking card — that would cover the very shapes he has to point at. Just a nudge up high, out of the way. */}
        {isProbe && gate && (
          <div className="probe-hint">
            <p>{(gate.op as { prompt: string }).prompt}</p>
            <span>直接在舞台上点一下你说的那个图形</span>
            <EscapeRow onEscape={escapeGate} />
          </div>
        )}
        {/* A drag card asks the learner to MOVE the part on the board — same no-blocking-card rule: the
            card would sit on top of the very prop he must grab. A nudge up high, and the confirm chip
            (in StageView) appears where he lets go. */}
        {isDrag && gate && (
          <div className="probe-hint">
            <p>{(gate.op as { prompt: string }).prompt}</p>
            <span>在舞台上把「{dragLabel}」直接拖到目标位置，松手后点「就是这里」</span>
            <EscapeRow onEscape={escapeGate} />
          </div>
        )}
        {verdict && <div className={"verdict" + (verdict.ok === true ? " ok" : verdict.ok === false ? " miss" : "")}>{verdict.text}</div>}

        {/* His own words, on the tape: a replayed or shared lesson shows the dialogue, not just the lecture. */}
        {!gate && snap.said && <div className="echo">他当时答的是「{snap.said}」</div>}

        <div className="console" ref={dockRef}>
          <div className="console-inner">
            {/* 这一场的账：Intelligent UI 的 show your work / progress / cost —— 拍数与花销不藏抽屉。
                带子上已有的东西，亮出来就是新功能；判分只照 settleGate 那条线（scoreOf 里那一刀）。 */}
            <div className="score">
              <span className="score-where">
                {score.beats === 0
                  ? "还没开演"
                  : currentBeat < 0
                    ? "演完了"
                    : `第 ${currentBeat + 1}/${score.beats} 拍 · ${(compiled.beats[currentBeat].headline || "无声调度").slice(0, 22)}`}
              </span>
              {score.asking > 0 && (
                <span className="score-account">
                  问 {score.asking} · 对 {score.correct} · 错 {score.wrong} · 跳过 {score.escaped}
                  {score.open > 0 ? ` · 还开着 ${score.open}` : ""}
                </span>
              )}
              {usage.calls > 0 && (
                <span className="score-cost">
                  {usage.calls} 次调用 · {usage.input + usage.output} tokens
                  {usage.cost ? ` · $${usage.cost.toFixed(4)}` : ""}
                </span>
              )}
            </div>
            {railOpen && <BeatRail stage={stage} teacher={teacherRef.current} t={snap.t} />}
            <div className="composer">
              <input
                value={entry}
                onChange={(e) => setEntry(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (started ? void speak() : void start())}
                placeholder={
                  intent === "answer"
                    ? "不选也行 —— 直接说你怎么想的，这就当作对那个问题的回答…"
                    : intent === "open"
                      ? "给一个题目：向量加法 / 梯度下降 / 复数乘法…"
                      : intent === "queue"
                        ? "导演在排第一拍。先说的话不会掉，这一排落定就接上："
                        : intent === "continue"
                          ? "接着这块板说：往下讲、问为什么、说哪儿没懂…"
                          : "打断演出，问它一件事…"
                }
              />
              <button className="go" onClick={() => (started ? void speak() : void start())}>
                {intent === "answer" ? "回答" : intent === "open" ? "开场" : intent === "queue" ? "等一下说" : intent === "continue" ? "接着说" : "打断"}
              </button>
              <button
                onClick={() => {
                  history.replaceState(null, "", location.pathname + location.search);
                  stage.reset();
                  dropTeacher();
                  setEntry("");
                  setStatus("舞台清空。");
                }}
              >
                重来
              </button>
              <button
                className="fold"
                onClick={() => setRailOpen((o) => !o)}
                title={railOpen ? "收起节拍条，把这一条画布还给画面" : "展开节拍条：每一拍都能倒回重演"}
              >
                {railOpen ? "收起" : "节拍"}
              </button>
            </div>
            <div className="status">{status}</div>
          </div>
        </div>
      </main>

      <aside className="drawer">
        <div className="drawer-body">
          <div className="meter">
            {usage.calls} 次调用 · {usage.input + usage.output} tokens{usage.cost ? ` · $${usage.cost.toFixed(4)}` : ""}
            {cfg.scripted ? " · 排练模式" : ""}
          </div>
          {tab === "log" ? <LogRows rows={logRows} lines={lines} /> : tab === "archive" ? (
            <LearnerArchive />
          ) : (
            <ModelConfig cfg={cfg} onChange={setCfg} onEvent={setStatus} />
          )}
        </div>
        <div className="tabs">
          {(
            [
              ["log", "指令日志"],
              ["config", "模型接入"],
              ["archive", "学习者档案"],
            ] as [Tab, string][]
          ).map(([k, name]) => (
            <button
              key={k}
              className={drawer && tab === k ? "on" : ""}
              onClick={() => {
                // The lit tab is the way back out: pressing it again shuts the drawer.
                if (drawer && tab === k) setDrawer(false);
                else {
                  setTab(k);
                  setDrawer(true);
                }
              }}
            >
              {name}
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}
