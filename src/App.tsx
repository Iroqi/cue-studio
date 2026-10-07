import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Stage } from "./engine/runtime";
import { Narrator } from "./engine/narrator";
import { decodeTape, encodeTape } from "./engine/share";
import { StageView } from "./engine/StageView";
import { Teacher } from "./agent/loop";
import { asideScore, continuationScore, paintScript, rehearsalScore } from "./agent/rehearsal";
import { ModelConfig } from "./ui/ModelConfig";
import { BeatRail } from "./ui/BeatRail";
import { LearnerArchive } from "./ui/LearnerArchive";
import { getModels, loadConfig, saveConfig, setScriptedResponses, type LlmConfig } from "./llm/llm";
import type { OpEntry } from "./engine/types";

function describe(e: OpEntry, stage: Stage): string {
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
      const settled = o.gate !== undefined ? stage.compiled.gates.find((g) => g.seq === o.gate) : undefined;
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

const RATES = [0.5, 1, 2, 4];

type Tab = "log" | "config" | "archive";

const SAMPLES = ["向量加法与力的分解", "梯度下降为什么会往下走", "复数乘法就是旋转", "极限：越靠近不等于已经到了"];

export default function App() {
  const stage = useMemo(() => new Stage(), []);
  const snap = useSyncExternalStore(stage.subscribe, stage.getSnapshot);
  const narrator = useMemo(() => new Narrator(stage), [stage]);
  const [voiced, setVoiced] = useState(() => narrator.enabled);
  const [cfg, setCfg] = useState<LlmConfig>(() => loadConfig());
  const [tab, setTab] = useState<Tab>("log");
  const [status, setStatus] = useState("给一个题目，舞台就开始排演。");
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
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
        setStatus(`载入别人排过的一场：${entries.length} 条指令，重放它一个模型都没叫。`);
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
  const liveTail = snap.live && snap.playing;
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
        <StageView stage={stage} bottomInset={dockH} />
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
              disabled={stage.log.all().length === 0}
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

        {gate && (
          <div className="gate">
            <div className="gate-card">
              {isQuiz ? (
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
        {verdict && <div className={"verdict" + (verdict.ok ? " ok" : " miss")}>{verdict.text}</div>}

        {/* His own words, on the tape: a replayed or shared lesson shows the dialogue, not just the lecture. */}
        {!gate && snap.said && <div className="echo">他当时答的是「{snap.said}」</div>}

        <div className="console" ref={dockRef}>
          <div className="console-inner">
            {railOpen && <BeatRail stage={stage} teacher={teacherRef.current} t={snap.t} duration={snap.duration} />}
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
          {tab === "log" ? (
            <div className="panel log">
              {stage.log.all().map((e) => (
                <div className={e.track === "main" ? "row" : "row aside"} key={e.seq}>
                  <em>{e.seq}</em>
                  <span>{describe(e, stage)}</span>
                </div>
              ))}
              {lines
                .filter((l) => l.text.trim().length > 0)
                .map((l, i) => (
                  <div className="director-text" key={`${l.beat}:${i}`}>
                    <em>第 {l.beat} 拍</em>
                    <span>{l.text}</span>
                  </div>
                ))}
            </div>
          ) : tab === "archive" ? (
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
