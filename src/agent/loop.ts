import { Type, validateToolCall, type AssistantMessage, type Context, type Message, type SystemMessage, type TextContent, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { MAIN_TRACK } from "../engine/log";
import type { Stage } from "../engine/runtime";
import type { Box, Op } from "../engine/types";
import { directorTools, type DirectorResult, type TeachingState } from "../tools/director";
import { GRAMMAR, PAINTER, stateSections } from "./prompt";
import { missesOn, record as archiveAttempt, summary as learnerHistory } from "./archive";
import { streamTurn, type LlmConfig, type Role, type TurnEvents, type TurnResult } from "../llm/llm";

const PAINT_TOOL: Tool = {
  name: "paint",
  description:
    "Delegate one prop's artwork to the stage painter (a separate, faster model) and return at once — the drawing lands on its frame in the background while the clock keeps performing. Give it a brief: what the object is, what relation it must make visible, and what the learner should notice. The clock parks at the edge of a beat whose frame is still empty, so a beat about to be narrated has to be launched early: put the brief in stage_script instead, which dispatches these for you at skeleton time.",
  parameters: Type.Object({
    id: Type.String({ description: "prop id already placed by stage_script, or a new one" }),
    brief: Type.String({ description: "what to draw and why — the idea, not the coordinates" }),
    scene: Type.Optional(Type.String({ description: "scene for a brand new prop" })),
    x: Type.Optional(Type.Number({ description: "new prop only: world x" })),
    y: Type.Optional(Type.Number({ description: "new prop only: world y" })),
    w: Type.Optional(Type.Number({ description: "new prop only: width" })),
    h: Type.Optional(Type.Number({ description: "new prop only: height" })),
  }),
};

/** A free tier throttles by tokens per minute, so a 429 is a window to wait out, not a failure. */
const RATE_LIMIT = /429|rate.?limit|too many requests|速率限制|限流/i;
const RETRIES = 3;
const WAIT_MS = 12000;
/** Painters run in parallel, but a free tier counts tokens per minute — a burst of six is a burst of 429s. */
const PAINT_CONCURRENCY = 3;

/** A reasoning model can spend its whole output budget on thinking and stop mid-thought. Twice it gets told to commit to verbs. */
const TRUNCATED_MAX = 2;

/** Anything the stage can act on: a verb to run, or a line to put on the clock. */
function hasStageable(m: AssistantMessage): boolean {
  return m.content.some((c) => c.type === "toolCall" || (c.type === "text" && c.text.trim().length > 0));
}

/** A paint running in the background: how to stop it, and where its frame sits on the tape. */
interface InPaint {
  cancel: () => void;
  /** The seq of the op that put this paint's frame on the tape — a reroll cuts dispatches by it. */
  frameSeq: number;
  /** True if the dispatch itself laid the frame: only such a frame comes back off when the take is cut. */
  built: boolean;
  /** Whether the paint got hold of a pipeline slot (a queued cancel must not disturb the board). */
  slot: boolean;
}

function extractSvg(acc: string): string | undefined {
  const cleaned = acc.replace(/^[\s\S]*?(?=<svg)/i, "").replace(/```/g, "");
  const m = cleaned.match(/<svg[\s\S]*<\/svg>/i);
  if (m) return m[0];
  if (!/<svg/i.test(cleaned)) return undefined;
  // Still streaming: drop the half-written tag at the tail so the DOM never sees `viewBox="v`.
  const open = cleaned.lastIndexOf("<");
  const closed = cleaned.lastIndexOf(">");
  return (open > closed ? cleaned.slice(0, open) : cleaned) + "</svg>";
}

export interface TeacherEvents {
  onStatus?: (s: string) => void;
  onText?: (role: string, delta: string) => void;
  /** A new director turn begins: the host starts a fresh line instead of appending to the last. */
  onTurnStart?: (beatNo: number) => void;
  /** The director is working (true) / the stage is handed back to the learner (false). */
  onBusy?: (busy: boolean) => void;
  onUsage?: (u: { input: number; output: number; cost: number; calls: number }) => void;
}

export class Teacher {
  messages: Message[] = [];
  teaching: TeachingState = { title: "", concepts: [], learner: "", beatsDone: 0 };
  busy = false;
  /** The seq of the question the main turn is parked on, waiting for a real answer. */
  private parkedGate: number | null = null;
  /** Paints running (or queued) in the background, by prop id. */
  private paints = new Map<string, InPaint>();
  /** Background paints outlive their turn, so the turn's abort controller cannot speak for them. */
  private paintAbort = new AbortController();
  /** A free tier counts tokens per minute across both roles: the pipeline dispatches at once but runs a few at a time. */
  private paintBusy = 0;
  private paintWaiters: (() => void)[] = [];
  private usage = { input: 0, output: 0, cost: 0, calls: 0 };
  private abort = new AbortController();
  private idleWaiters: (() => void)[] = [];
  /** What the director's head held just before each turn — the only way back into a re-take. */
  private turnSnap = new Map<number, { messages: Message[]; teaching: TeachingState }>();
  private tools: Tool[];
  private runVerb: (name: string, args: Record<string, unknown>) => DirectorResult;

  private stage: Stage;
  private cfg: LlmConfig;
  private ev: TeacherEvents;

  constructor(stage: Stage, cfg: LlmConfig, ev: TeacherEvents = {}) {
    this.stage = stage;
    this.cfg = cfg;
    this.ev = ev;
    const d = directorTools(stage, this.teaching);
    this.runVerb = d.run;
    this.tools = [...d.tools, PAINT_TOOL];
  }

  setConfig(cfg: LlmConfig) {
    this.cfg = cfg;
  }

  stop() {
    this.abort.abort();
    this.cancelPaints();
  }

  /**
   * Take every background paint off the clock. The frames stay empty — which the abandoned-turn rule
   * already reads as nothing owed — so the show never parks on art whose director walked away.
   */
  private cancelPaints() {
    this.paintAbort.abort();
    this.paintAbort = new AbortController();
    for (const [, p] of this.paints) p.cancel();
    this.paints.clear();
    for (const wake of this.paintWaiters.splice(0)) wake();
  }

  /** System sections, with this learner's proven misses attached when there are any. */
  private sections() {
    return stateSections(this.teaching, this.stage.agentSnapshot(), learnerHistory(this.teaching.title));
  }

  private syncSections() {
    const head = this.messages[0];
    if (head?.role === "system") {
      head.sections = this.sections();
    }
  }

  private ensureLead() {
    if (this.messages.length === 0) {
      this.messages.push({
        role: "system",
        content: GRAMMAR,
        sections: this.sections(),
        timestamp: Date.now(),
      });
    }
  }

  /** One learner utterance in the main line. */
  async say(text: string) {
    this.ensureLead();
    if (this.teaching.title === "" && text.trim().length < 120) this.teaching.title = text.trim();
    this.messages.push({ role: "user", content: text, timestamp: Date.now() });
    await this.spin("main");
  }

  /**
   * Whether the next words go onto this board or cut into it as an aside. Only what the director is
   * producing *right now* can be interrupted: once a turn is over the stage belongs to the learner's
   * next sentence, even if the tape is still rolling. The host asks here because it has to put the
   * same answer on the button the learner presses.
   */
  continuesBoard() {
    return !this.busy;
  }

  /**
   * The next thing the learner says. Most of the time it continues the same performance on the main
   * line — the board is a workspace the lesson keeps, so nothing is rewound and nothing is cleared.
   * Only a remark thrown in while the director is still working is an aside: that one steps back
   * and re-performs the cut.
   */
  async respond(text: string) {
    // The director is stopped on a question it has not heard the answer to: what the learner says next
    // IS that answer, whether the clock has reached the card yet or is still running toward it.
    // Handing it to the parked turn is also the only way to avoid a second director working on one
    // transcript while the first is still waiting.
    if (this.parkedGate !== null) {
      this.ev.onStatus?.("把你的话当作对那个问题的回答。");
      this.stage.answerGate(text, this.parkedGate);
      return;
    }
    if (this.continuesBoard()) {
      await this.say(text);
      if (this.stage.live && !this.stage.playing) this.stage.play();
      return;
    }
    // Nothing has landed on the board yet — the cold start. An aside here would perform on an empty
    // plane and compete with the turn still laying that plane down, so the words are held and said as
    // soon as this turn lands. The board continues; it does not fork.
    if (this.stage.compiled.duration === 0) {
      this.queued.push(text);
      this.ev.onStatus?.("记下了，这一拍排完就接着说你的。");
      void this.drainQueue();
      return;
    }
    await this.interrupt(text);
  }

  /** Words thrown in before the board existed, in the order they came. */
  private queued: string[] = [];
  private draining = false;

  /** One drain at a time, and it waits for the current turn rather than talking over it. */
  private async drainQueue() {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.whenIdle();
      while (this.queued.length && !this.abort.signal.aborted) await this.say(this.queued.shift()!);
    } finally {
      this.draining = false;
    }
  }

  /**
   * An interruption plays on its own track. When it is over, the main clock is rewound to
   * the beat it was cut off at, so the interrupted passage is re-performed rather than lost.
   */
  async interrupt(text: string) {
    const resumeAt = this.stage.t;
    const track = this.stage.beginAside();
    this.ev.onStatus?.(`插播：${track}`);
    const aside: Message[] = [
      {
        role: "system",
        content: GRAMMAR + "\n\n# 现在的状况\n学习者打断了演出提问。先用舞台回答他（可以复用已有的道具），说完就停。不要重新展开整个论证。",
        sections: this.sections(),
        timestamp: Date.now(),
      },
      { role: "user", content: text, timestamp: Date.now() },
    ];
    await this.spin("aside", aside, track);
    this.stage.endAside();
    this.stage.seek(resumeAt);
    this.messages.push({
      role: "user",
      content: `（学习者刚才打断问：${text}。你已经用插播回答过了。现在回到被打断的那一拍，从那里继续原来的演出。）`,
      timestamp: Date.now(),
    });
    this.ev.onStatus?.("回到主线，重演被打断的那一拍");
    await this.spin("main");
  }

  /** The output ceiling the director is actually running under — the number to name when it starves. */
  private ceiling(): number {
    const p = this.cfg.providers.find((x) => x.id === this.cfg.director.provider);
    return p?.models.find((m) => m.id === this.cfg.director.model)?.maxTokens ?? 0;
  }

  /**
   * One model call, waited out when the provider throttles. Both roles draw on the same
   * tokens-per-minute budget, so a painter that fails on the first 429 hands the director an error he
   * can only answer by asking for the same artwork again — burning the window a second time.
   */
  private async ask(role: Role, context: Context, events: TurnEvents, signal?: AbortSignal): Promise<TurnResult> {
    for (let retry = 0; ; retry++) {
      try {
        return await streamTurn(this.cfg, role, context, events, signal ?? this.abort.signal);
      } catch (e) {
        if (this.abort.signal.aborted) throw e;
        if (!RATE_LIMIT.test((e as Error).message) || retry >= RETRIES) throw e;
        const hold = WAIT_MS * (retry + 1);
        this.ev.onStatus?.(`${role === "painter" ? "美工" : "导演"}被服务商限流，等 ${Math.round(hold / 1000)} 秒后自己重试（第 ${retry + 1}/${RETRIES} 次）…`);
        await this.sleep(hold, signal);
      }
    }
  }

  private async spin(where: string, transcript: Message[] = this.messages, track = "main") {
    this.ensureLead();
    this.busy = true;
    // The turn owns the art debt: while it runs, an empty frame on the tape is a frame still coming,
    // and the clock parks at the edge of the beat that was promised it. When the turn ends the debt
    // is called in — a frame the director walked away from shows nothing rather than freezing the show.
    this.stage.setTurnOpen(true);
    this.ev.onBusy?.(true);
    let truncated = 0;
    try {
      for (let turn = 0; turn < 24; turn++) {
        if (this.abort.signal.aborted) return;
        const isAside = transcript !== this.messages;
        const beatNo = this.stage.log.nextTurn();
        if (isAside) {
          (transcript[0] as SystemMessage).sections = this.sections();
        } else {
          this.syncSections();
          this.turnSnap.set(beatNo, { messages: transcript.slice(), teaching: structuredClone(this.teaching) });
        }
        this.ev.onTurnStart?.(beatNo);
        this.ev.onStatus?.(`导演思考中（第 ${beatNo} 拍）…`);
        let message: AssistantMessage;
        try {
          message = (
            await this.ask(
              "director",
              { messages: transcript, tools: this.tools },
              {
                onText: (d) => this.ev.onText?.("director", d),
                onToolArgs: (name, args) => this.previewArgs(name, args, track),
              },
            )
          ).message;
        } catch (e) {
          // An abort is our own doing (重来 / 重排), not something to report as a failure.
          if (this.abort.signal.aborted) return;
          this.ev.onStatus?.(`出错：${(e as Error).message}`);
          return;
        }
        this.tally(message);
        // A turn cut off by the output ceiling is not a finished turn. Reasoning models can spend the
        // whole budget on thinking, stop with no verb and no line, and leave the board empty — while a
        // 20k-char lump of abandoned thinking would ride in the transcript and be billed every turn
        // after. So: count the waste, keep it out of his head, and make him commit to verbs instead.
        if (message.stopReason === "length" && !hasStageable(message)) {
          if (++truncated > TRUNCATED_MAX) {
            this.ev.onStatus?.(`这一拍被输出上限拦腰截断（当前上限 ${this.ceiling()} tokens）：只想不写，台上一个东西都没落下。把推理强度调低一档，或在模型配置里把该模型的 max tokens 调大，再开场。`);
            return;
          }
          this.ev.onStatus?.(`模型把这一拍的输出全花在思考上，没留下任何上台的东西 —— 让它改用动词重来（第 ${truncated}/${TRUNCATED_MAX} 次）。`);
          transcript.push({
            role: "user",
            content:
              "上一回合只有思考，被输出上限截断，台上什么都没有。这一回合不要再展开推理：想清楚要演的第一件事，直接把它做成工具调用（stage_script / build / narrate / camera / ask_learner），思考只留一句。",
            timestamp: Date.now(),
          } as Message);
          continue;
        }
        transcript.push(message);
        truncated = 0;
        if (message.stopReason !== "toolUse") {
          this.sayProse(message, track);
          this.ev.onStatus?.(where === "main" ? "这一段讲完了，黑板不清 —— 接着说。" : "插播结束");
          return;
        }
        const calls = message.content.filter((c): c is ToolCall => c.type === "toolCall");
        const report = async (call: ToolCall) => {
          const out = await this.execute(call, track);
          transcript.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text" as const, text: out.result }],
            isError: !!out.isError,
            timestamp: Date.now(),
          } as Message);
        };
        for (const call of calls) {
          if (this.abort.signal.aborted) return;
          // Every verb keeps its place in line — a paint included, but a paint only queues its
          // drawing: the call returns the moment the frame is on the tape, so the pipeline's
          // concurrency is the painter's own cap, not this loop waiting on it.
          await report(call);
        }
      }
      this.ev.onStatus?.("这一节先到这里（一拍讲不了更多）—— 接着说就往下演。");
    } finally {
      this.busy = false;
      this.stage.setTurnOpen(false);
      this.ev.onBusy?.(false);
      for (const wake of this.idleWaiters.splice(0)) wake();
    }
  }

  whenIdle(): Promise<void> {
    return this.busy ? new Promise<void>((r) => this.idleWaiters.push(r)) : Promise.resolve();
  }

  /**
   * A turn that ends in prose instead of verbs still said something. Left out of the log, an
   * interruption becomes a scene where the learner asked, the teacher answered, and nothing on
   * stage changed — so put the line on the clock like any other narration.
   */
  private sayProse(message: AssistantMessage, track: string) {
    const text = message.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .replace(/[*_`#]/g, "")
      .trim();
    if (!text) return;
    this.stage.append([{ kind: "narrate", text, duration: Math.min(24000, Math.max(2000, text.length * 200)) }], track);
  }

  canReroll(turn: number): boolean {
    return this.turnSnap.has(turn);
  }

  /**
   * Cut the performance at one of its beats and re-stage it: the log loses everything from
   * that op onward, the director's head is put back to what it held before that turn, and the
   * critic's line is what sends it off again. A loaded recording has no head to go back to.
   */
  async rerollFrom(seq: number, critique: string) {
    this.abort.abort();
    await this.whenIdle();
    this.abort = new AbortController();
    const entry = this.stage.log.entryAt(seq);
    const snap = entry ? this.turnSnap.get(entry.turn) : undefined;
    if (!entry || !snap) {
      this.ev.onStatus?.("这一拍没有可回去的排练现场（只有正在排的这场有；录像只能重放，不能改）。");
      return;
    }
    for (const t of [...this.turnSnap.keys()]) if (t >= entry.turn) this.turnSnap.delete(t);
    Object.assign(this.teaching, snap.teaching);
    this.messages.splice(0, this.messages.length, ...snap.messages);
    // A background paint outlives the turn that dispatched it, so cutting the tape has to cut its
    // hand too — and a frame its dispatch laid on the cut passage goes back off with it. A frame
    // older than the cut survives the reroll, and its delivery survives with it: the re-take is
    // staged around a picture that is already on its way.
    const doomed = [...this.paints.entries()].filter(([, p]) => p.frameSeq >= seq);
    this.cancelPaints();
    this.stage.rerollFrom(seq);
    for (const [id] of doomed) if (this.stage.compiled.props.has(id)) this.stage.append([{ kind: "discard", id }], MAIN_TRACK);
    const at = this.stage.compiled.duration;
    this.messages.push({
      role: "user",
      content:
        `（${at > 0 ? `第 ${entry.turn} 拍从 ${Math.round(at)}ms 开始的部分撤下来重排。` : `第 ${entry.turn} 拍撤下来重排。`}` +
        `${critique.trim() ? `问题在于：${critique.trim()}。` : "换个排法。"}不要重复上一版的说法和调度。）`,
      timestamp: Date.now(),
    });
    this.ev.onStatus?.(`重排第 ${entry.turn} 拍…`);
    await this.spin("main");
  }

  /** One paint call from the director: put the frame on the tape, hand the brief to the pipeline, return at once. */
  private async runPaint(args: Record<string, unknown>, track: string): Promise<{ result: string; isError?: boolean }> {
    const id = String(args.id);
    const brief = String(args.brief ?? "");
    if (this.paints.has(id)) return { result: `${id} 的画面正在后台绘制，空框已占住那一格，不必再派`, isError: true };
    const scene = typeof args.scene === "string" && args.scene ? args.scene : undefined;
    return this.dispatchPaint(id, brief, { scene, x: args.x, y: args.y, w: args.w, h: args.h }, track);
  }

  /**
   * Launch a paint: the frame lands on the tape now, the drawing lands in the background whenever
   * the pipeline gets to it. The receipt is an appointment, not a delivery — the clock keeps
   * performing and parks at the edge of the beat whose frame is still empty, so the show reads the
   * pipeline's pace instead of the turn's.
   */
  private async dispatchPaint(
    id: string,
    brief: string,
    at: { scene?: string; x?: unknown; y?: unknown; w?: unknown; h?: unknown },
    track: string,
  ): Promise<{ result: string; isError?: boolean }> {
    // An established prop keeps its board; a new one with no board named goes where the director says,
    // and if the director didn't say, onto the board the show is standing on (compile decides).
    const scene = at.scene ?? this.stage.compiled.props.get(id)?.scene ?? undefined;
    const rev = this.stage.compiled.props.get(id)?.revisions.slice(-1)[0];
    // Only a prop with no frame on the tape gets one laid here. The skeleton's build is already the
    // frame a brief points at — re-laying it would double-book the outline on the tape — and a frame
    // carrying a picture keeps it while the redraw runs, because the board must not go blank just
    // because the director asked for a better drawing.
    const laysFrame = !rev;
    let frameSeq = this.stage.log.lastSeq;
    if (laysFrame) {
      // A frame with no coordinates is a request for something the audience can see, not at
      // the origin of an infinite plane.
      const here = !rev && at.x === undefined && at.y === undefined;
      const added = this.stage.append(
        [
          {
            kind: "build",
            id,
            scene,
            label: (brief || id).slice(0, 60),
            here: here || undefined,
            box: { x: Number(at.x ?? 0), y: Number(at.y ?? 0), w: Number(at.w ?? 400), h: Number(at.h ?? 300) },
          },
        ],
        track,
      );
      frameSeq = added[added.length - 1].seq;
    }
    const framedBox = this.stage.compiled.props.get(id)!.revisions.slice(-1)[0].box;
    const ctrl = new AbortController();
    const watch = () => ctrl.abort();
    this.paintAbort.signal.addEventListener("abort", watch, { once: true });
    const job: InPaint = { cancel: () => { this.paintAbort.signal.removeEventListener("abort", watch); ctrl.abort(); }, frameSeq, built: laysFrame, slot: false };
    this.paints.set(id, job);
    this.stage.beginPaint(id);
    void this.paintBackground(id, brief, framedBox, scene, track, job, ctrl);
    return { result: `已把 ${id} 交给美工后台绘制（画框 ${Math.round(framedBox.w)}x${Math.round(framedBox.h)} 已上台）；时钟不会等这一笔` };
  }

  /** Wait for a free slot in the painter pipeline — dispatch is at once, concurrency is capped. */
  private takePaintSlot(job: InPaint, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    if (this.paintBusy < PAINT_CONCURRENCY) {
      this.paintBusy++;
      job.slot = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const wake = () => {
        signal.removeEventListener("abort", wake);
        const i = this.paintWaiters.indexOf(wake);
        if (i >= 0) {
          // Woken by a freed slot, not by cancellation: this waiter is next in line, take its ticket.
          this.paintWaiters.splice(i, 1);
          job.slot = true;
        }
        resolve();
      };
      this.paintWaiters.push(wake);
      signal.addEventListener("abort", wake, { once: true });
    });
  }

  private freePaintSlot() {
    const next = this.paintWaiters.shift();
    if (next) next();
    else this.paintBusy--;
  }

  /**
   * The painter's turn, out of the director's way. Every path out has to settle the stage's books
   * (`endPaint`) and its own (`freePaintSlot`), and a failure takes its frame off the board: an
   * empty outline the learner can see is worse than the caption having nothing to point at — unless
   * the skeleton laid that frame on purpose, in which case it stays and the clock simply moves on.
   */
  private async paintBackground(id: string, brief: string, box: Box, scene: string | undefined, track: string, job: InPaint, ctrl: AbortController) {
    const signal = this.paintAbort.signal.aborted ? this.paintAbort.signal : ctrl.signal;
    try {
      await this.takePaintSlot(job, signal);
      if (signal.aborted) {
        if (job.built && job.slot) this.stage.append([{ kind: "discard", id }], track);
        return;
      }
      this.ev.onStatus?.(`美工绘制 ${id} …`);
      let acc = "";
      let res: TurnResult;
      try {
        res = await this.ask(
          "painter",
          {
            systemPrompt: PAINTER,
            messages: [
              {
                role: "user",
                content: `道具：${id}\n舞台位置：${Math.round(box.w)}x${Math.round(box.h)}，在场景 ${scene ?? "当前这块板"}\n编导的要求：${brief}`,
                timestamp: Date.now(),
              },
            ],
          },
          {
            onText: (d) => {
              acc += d;
              const svg = extractSvg(acc);
              if (svg) this.stage.setPreview(id, { svg, box, scene, label: brief.slice(0, 60) || id });
            },
          },
          ctrl.signal,
        );
      } catch (e) {
        if (!this.paints.has(id)) return; // cancelled: the reroll already dealt with the frame
        if (job.built) this.stage.append([{ kind: "discard", id }], track);
        this.ev.onStatus?.(`美工失败 ${id}：${(e as Error).message}`);
        return;
      }
      this.tally(res.message);
      if (!this.paints.has(id)) return; // cancelled mid-flight: deliver nothing into a cut passage
      const svg = extractSvg(acc);
      if (!svg) {
        if (job.built) this.stage.append([{ kind: "discard", id }], track);
        this.ev.onStatus?.(`美工没有产出可用的 svg（${id}，收到 ${acc.length} 字符）`);
        return;
      }
      this.stage.append([{ kind: "patch", id, svg }], track);
      this.ev.onStatus?.(`画好 ${id}`);
    } finally {
      this.stage.clearPreview(id);
      this.stage.endPaint(id);
      this.paints.delete(id);
      this.freePaintSlot();
    }
  }

  /** Partial arguments while still streaming: the tape head, not the tape. */
  private previewArgs(name: string, args: Record<string, unknown>, track: string) {
    if (name !== "build" && name !== "draw") return;
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) return;
    const svg = typeof args.svg === "string" ? args.svg : undefined;
    if (!svg) return;
    this.stage.setPreview(id, {
      svg: extractSvg(svg),
      box: {
        x: Number(args.x ?? 0),
        y: Number(args.y ?? 0),
        w: Number(args.w ?? 400),
        h: Number(args.h ?? 300),
      },
      scene: typeof args.scene === "string" ? args.scene : "scene-1",
      label: typeof args.label === "string" ? args.label : id,
    });
    void track;
  }

  private async execute(call: ToolCall, track: string): Promise<{ result: string; isError?: boolean }> {
    let args: Record<string, unknown> = { ...(call.arguments ?? {}) };
    try {
      args = (validateToolCall(this.tools, call) as Record<string, unknown>) ?? args;
    } catch (e) {
      return { result: `参数不合法：${(e as Error).message}。请重新给出 ${call.name}。`, isError: true };
    }

    if (call.name === "paint") return this.runPaint(args, track);

    const out = this.runVerb(call.name, args);
    if (out.ops.length) this.stage.append(out.ops, track);
    for (const op of out.ops) {
      if (op.kind === "build" || op.kind === "patch") this.stage.clearPreview(op.id);
    }
    // A skeleton that named its art is an order to the painter, not just to the clock: the brief
    // dispatches from the frame it belongs to, so the pipeline starts at skeleton time and the
    // director never spends a beat standing between a placeholder and its picture.
    if (call.name === "stage_script" && out.paintBriefs?.length) {
      for (const b of out.paintBriefs) {
        if (this.paints.has(b.id)) continue;
        await this.dispatchPaint(b.id, b.brief, { scene: b.scene }, track);
      }
    }
    if (out.result.startsWith("question queued") || out.result.startsWith("stage clock will stop")) {
      const gates = this.stage.openGateSeqs();
      const seq = gates[gates.length - 1];
      this.stage.play();
      this.ev.onStatus?.("等学习者回答…");
      this.parkedGate = seq;
      // The clock may be parked on pictures the pipeline still owes — this turn's skeletons and
      // background paints alike. A parked director cannot pay that debt; it is waiting on the
      // learner — so the debt would hold the clock short of the very question it is waiting for, and
      // the show would freeze with the turn frozen inside it. Calling the debt in lets the clock
      // reach the card; re-billing it afterwards keeps the rest of the passage under the same rule.
      this.stage.setDebtSuspended(true);
      const answer = await this.waitForAnswer(seq);
      this.stage.setDebtSuspended(false);
      this.parkedGate = null;
      if (answer === null) return { result: "（这一拍撤了下来，学习者没有作答）", isError: true };
      return { result: this.settleGate(seq, answer) };
    }
    const note = this.blindCamera(out.ops);
    return note ? { ...out, result: `${out.result}\n${note}` } : out;
  }

  /**
   * A camera that names what the audience cannot see simply does not move, and a silent no-op reads to
   * the model as a cut that happened. Say which name it could not find — and that a prop left on the
   * board the show walked away from is exactly as invisible as one never painted.
   */
  private blindCamera(ops: Op[]): string | null {
    const wanted = new Map<string, Op>();
    for (const op of ops) {
      if (op.kind !== "camera") continue;
      for (const id of Array.isArray(op.target) ? op.target : op.target ? [op.target] : []) wanted.set(id, op);
      if (op.follow) wanted.set(op.follow, op);
    }
    const blind = [...wanted].filter(([id, op]) => !this.audienceHas(id, op));
    return blind.length
      ? `镜头点名的东西观众看不见：${blind.map(([id]) => id).join("、")} —— 要么还没画，要么还留在上一块板上（只有 recall 带得过来）。画面这一拍不会动。`
      : null;
  }

  /** Was this name in front of the audience when the camera asked: painted by then and not swept off by a cut. */
  private audienceHas(id: string, askedBy: Op): boolean {
    const cue = this.stage.compiled.cues.find((c) => c.op === askedBy);
    return this.stage.visibleName(id, cue ? cue.t : this.stage.compiled.duration);
  }

  /**
   * The verdict is computed here rather than handed up by the button that was clicked: the model
   * is told which option was correct and is shown its own reason, so it can't be flattered by the
   * interface. Only a quiz choice is evidence — a pause the learner clicked through records nothing.
   */
  private settleGate(seq: number, answer: string): string {
    const quiz = this.stage.compiled.gates.find((g) => g.seq === seq)?.op;
    if (!quiz || quiz.kind !== "quiz") return `学习者回答：${answer}`;
    const choice = quiz.options.indexOf(answer);
    // Free text is not a graded choice: it is evidence of how he put it, and nothing more.
    if (choice < 0) return `学习者没有选选项，直接说了：「${answer}」。这就是他现在的理解，从它出发继续演；不要替他宣布对错，也别把这句话当成答对了。`;
    const correct = choice === quiz.answer;
    // Counted before recording, so "how many times has he fallen here" is the history, not this answer.
    const prior = missesOn(this.teaching.title, quiz.concept);
    archiveAttempt({
      at: Date.now(),
      topic: this.teaching.title,
      prompt: quiz.prompt,
      options: quiz.options,
      choice,
      answer: quiz.answer,
      correct,
      concept: quiz.concept,
    });
    const right = quiz.options[quiz.answer] ?? "？";
    const here = quiz.concept ? `「${quiz.concept}」这一处` : "这一处";
    return [
      `学习者选了「${answer}」。${correct ? "答对了。" : `答错了 —— 正确的是「${right}」。`}`,
      quiz.why ? `你当初给这道题的理由：${quiz.why}` : "",
      correct
        ? prior > 0
          ? `${here}他以前错过 ${prior} 次，这次答对了：可以往前走，但别当成他天生会了。`
          : "这一题是证据，可以往前走。别把它当成整个概念已经讲通。"
        : prior > 0
          ? `${here}他已经是第 ${prior + 1} 次错过，换过问法也没用。再画一遍同样的形状没有意义：换个载体重演 —— 一组能对上的数字、motion 让它自己走一遍、或者把他错的那个形状就留在台上和正确的并置 —— 演完用同样的 concept 再问一次。`
          : `他挑的是「${answer}」，说明在那个位置他的形状和正确的形状不一样。不要重复正确选项：把这两个形状摆到同一个舞台上比一次。`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** A blocked turn must be liftable: re-performing a passage starts by letting go of it. */
  private waitForAnswer(seq: number): Promise<string | null> {
    const aborted = new Promise<null>((resolve) => {
      if (this.abort.signal.aborted) return resolve(null);
      this.abort.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    return Promise.race([this.stage.waitForGate(seq), aborted]);
  }

  /** A wait that 重来 — or the cancelling of one background paint — can cut through immediately. */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const cut = signal ?? this.abort.signal;
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      cut.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          r();
        },
        { once: true },
      );
    });
  }

  private tally(m: { usage?: { input: number; output: number; cost?: { total?: number } } }) {
    if (!m.usage) return;
    this.usage.input += m.usage.input;
    this.usage.output += m.usage.output;
    this.usage.cost += m.usage.cost?.total ?? 0;
    this.usage.calls += 1;
    this.ev.onUsage?.(this.usage);
  }
}
