import { compile, perform, type Interpreter } from "./compile";
import { MAIN_TRACK, OpLog } from "./log";
import { TapeIndex, reindex } from "./frame";
import { StandingIndex, restand } from "./standing";
import { displaced, motionOffset } from "./motion";
import { SETTLE_MS } from "./speech";
import type { Box, Compiled, Cue, Gate, MotionOp, Op, OpEntry, Revision, Scene3DSpec, TrackId } from "./types";

/** A cut the clock has already walked through the veil of. */
type Cut = { flip: number; board: string };

export interface VisibleProp {
  id: string;
  scene: string;
  box: Box;
  svg?: string;
  html?: string;
  css?: string;
  scene3d?: Scene3DSpec;
  label: string;
  note?: string;
  /** Nothing has been drawn into this frame yet — an empty frame, not a half-finished picture. */
  draft: boolean;
  /** A paint for this frame is in flight and it still shows nothing: the one frame worth marking. */
  awaiting: boolean;
  highlight?: string;
}

export interface RenderState {
  t: number;
  duration: number;
  rect: Box;
  viewport: { w: number; h: number };
  props: VisibleProp[];
  narration: { text: string; progress: number; reveal: number; duration: number; style: string } | null;
  veil: { style: string; progress: number } | null;
  gate: Gate | null;
  /** His own words for the card the playhead is standing in. On the tape, so a shared or replayed lesson carries the dialogue and not only the lecture. */
  said: string | null;
  playing: boolean;
  finished: boolean;
  track: TrackId;
  /** Whose lesson this is: `false` only for a tape somebody else played (a loaded or shared recording). Gates ask a question only when it is true, and the clock waits on artwork only when it is true. */
  live: boolean;
  /** The playhead is standing at the live edge rather than on a second the learner dragged to. This is what ● 实时 reports — and it is *not* ownership: looking back at your own lesson does not turn it into a recording. */
  following: boolean;
  /** Frames the current beat promised and the models have not handed over yet. */
  artOwed: number;
  /** The clock is standing still because the picture under it isn't there yet. */
  artWait: boolean;
  /** A question a director turn is blocked on, even if the clock has not reached its card yet. */
  askedGate: number | null;
}

const EASES: Record<string, (p: number) => number> = {
  linear: (p) => p,
  ease: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  "ease-in": (p) => p * p,
  "ease-out": (p) => 1 - (1 - p) * (1 - p),
  spring: (p) => 1 - Math.pow(1 - p, 3) * Math.cos(p * Math.PI * 1.2),
};

function lerpBox(a: Box, b: Box, p: number): Box {
  return {
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
    w: a.w + (b.w - a.w) * p,
    h: a.h + (b.h - a.h) * p,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Anything a shadow root or a WebGL window can paint. A box with only a label and a css block is an empty frame. */
function painted(r: { svg?: string; html?: string; scene3d?: Scene3DSpec }): boolean {
  return !!(r.svg || r.html || r.scene3d);
}

export class Stage {
  readonly log = new OpLog();
  /*
   * 一条轨道一台解释器。带子只增不改，所以"走到这一刻手上有的东西"本来就该活着，而不该每批被重新
   * 发明一遍 —— 这三条字段就是那台机器，`compiled*` 是它当下演出来的台面。
   *
   * 机器的生死完全由带子的引用决定（`perform`），所以这里不需要给"哪一头换了带子"维护清单：
   * `append` 让那一轨的数组长一截（引用不变 → 续演），`cutFrom`/`restore`/`clear` 换数组（→ 从零演）。
   */
  private machineMain: Interpreter | null = null;
  private machineAside: Interpreter | null = null;
  private compiledMain: Compiled = compile([]);
  private compiledAside: Compiled | null = null;
  /*
   * 带子的位置索引跟着带子走：换卷那一刻建一本，落一笔只吸收新落的那一截，一帧只问二分。它不重新
   * 解释任何东西 —— 拿的就是上面那两份 `Compiled`，所以"索引算错了"和"解释器算错了"不会混成一处。
   *
   * `StandingIndex` 是同一件事的另一半：cue 表那边走的是"这一刻哪一格还在跑"，道具那边走的是"这一刻
   * 什么站在台上"。它读的也是上面那两份 `Compiled` 里的外观，所以它对账的对象和 `TapeIndex` 是同一个。
   */
  private indexMain = reindex(null, this.compiledMain);
  private indexAside: TapeIndex | null = null;
  private standingMain = new StandingIndex(this.compiledMain);
  private standingAside: StandingIndex | null = null;
  private preview = new Map<string, { box: Box; svg?: string; html?: string; css?: string; label: string; scene: string }>();
  private listeners = new Set<() => void>();
  private snapshot: RenderState;
  private raf = 0;
  private last = 0;
  private speed = 1;

  t = 0;
  playing = false;
  live = true;
  /** Whether the learner wants the live edge. `seek` turns it off, `goLive` and an aside turn it back on — this is the one piece of playback intent that survives a turn being appended. */
  private followTail = true;
  track: TrackId = MAIN_TRACK;
  asideResume: { track: TrackId; t: number; live?: boolean; following?: boolean } | null = null;
  /** Frames a paint is in flight for. A frame they will fill is not delivered until it lands. */
  private artFor = new Set<string>();
  /** Paints dispatched to run in the background. Their frames are owed even once the turn has moved on. */
  private painting = new Set<string>();
  /** A director or painter turn is in flight: the empty frames it scheduled are still expected. */
  private turnOpen = false;
  /** Parked on a learner gate: nothing on the tape is owed, or the card the turn waits on is unreachable. */
  private debtSuspended = false;
  private owed = 0;
  /** Debt that refused the last step: the clock parks a frame short of a beat edge, where the beat under the playhead reads nothing. */
  private blockedBy = 0;
  private artWait = false;
  private rect: Box = { x: 0, y: 0, w: 1600, h: 900 };
  private camFrom: Box | null = null;
  private camFromAt = -1;
  /** The show was walking when the tab went dark, so it should start walking again when it comes back. */
  private awaitingAudience = false;

  constructor() {
    this.snapshot = this.render();
    this.tick = this.tick.bind(this);
  }

  /**
   * A hidden tab is an empty room: browsers throttle rAF there to a frame a second or stop it, and
   * the next visible frame then carries a `dt` the size of the whole absence — the learner comes back
   * to a lesson that already ended, with the narration having read itself out to nobody. The rule that
   * parks the clock for a picture that has not landed is the same rule for an audience that is not here.
   */
  private watchingAudience = false;

  /** The ear is on while the clock walks, and while it waits for a room to have somebody in it. */
  private watchAudience() {
    const on = (this.playing || this.awaitingAudience) && typeof document !== "undefined";
    if (on === this.watchingAudience) return;
    this.watchingAudience = on;
    if (on) document.addEventListener("visibilitychange", this.onVisibility);
    else document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private onVisibility = () => this.audience(!document.hidden);

  private audience(seen: boolean) {
    if (seen) {
      if (!this.awaitingAudience) return;
      this.play();
      return;
    }
    // A show already standing still has nothing to lose: the stop it is in was someone's decision.
    if (this.playing) this.standStill(true);
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = this.render();
    for (const l of this.listeners) l();
  }

  recompile() {
    /*
     * 一条轨道一台机器，机器跟着那一轨的带子活。`perform` 只问一句"还是不是那一卷"（数组引用），
     * 所以这里不需要另外记游标，也不需要给"哪一头换了带子"写清单 —— `log` 那三扇门（`append` 长一截、
     * `cutFrom`/`restore` 换一卷）已经把答案写进引用里了。
     *
     * 插播那一头连"换轨道"都不用管：新的 `aside:N` 是另一卷带子，引用不同，`perform` 当场就把上一支
     * 插播的机器扔掉、开一台新的，而旧机器只剩这一条字段握着它 —— 换掉就是回收。
     */
    const main = perform(this.machineMain, this.log.ofTrack(MAIN_TRACK));
    this.machineMain = main.it;
    this.compiledMain = main.compiled;
    this.indexMain = reindex(this.indexMain, this.compiledMain);
    this.standingMain = restand(this.standingMain, this.compiledMain);
    const asides = this.log.asides();
    const aside = asides[asides.length - 1];
    if (aside) {
      const withAside = perform(this.machineAside, this.log.ofTrack(aside));
      this.machineAside = withAside.it;
      this.compiledAside = withAside.compiled;
      this.indexAside = reindex(this.indexAside, this.compiledAside);
      this.standingAside = restand(this.standingAside, this.compiledAside);
    } else {
      this.machineAside = null;
      this.compiledAside = null;
      this.indexAside = null;
      this.standingAside = null;
    }
    this.emit();
  }

  reset() {
    this.log.clear();
    this.preview.clear();
    this.pending.clear();
    this.track = MAIN_TRACK;
    this.asideResume = null;
    this.t = 0;
    this.live = true;
    this.followTail = true;
    this.artFor.clear();
    this.painting.clear();
    this.turnOpen = false;
    this.blockedBy = 0;
    // A tape that was just replaced or imported is not owed an audience: it starts held, and only
    // the learner's own play starts it walking.
    this.awaitingAudience = false;
    this.watchAudience();
    this.recompile();
  }

  load(entries: OpEntry[]) {
    this.reset();
    this.log.restore(entries);
    this.t = 0;
    this.live = false;
    // Somebody else's tape starts at its beginning, not at a live edge: the light stays off until the
    // learner takes the board over (● 实时 / 接着说, both of which are `goLive`).
    this.followTail = false;
    this.hold();
    this.recompile();
  }

  get compiled(): Compiled {
    return this.track === MAIN_TRACK || !this.compiledAside ? this.compiledMain : this.compiledAside;
  }

  /** 这一帧要问的那卷带子的索引，和上面那份 `Compiled` 同一卷。 */
  private get index(): TapeIndex {
    return this.track === MAIN_TRACK || !this.indexAside ? this.indexMain : this.indexAside;
  }

  /** 同上，站着的那一半：一帧问"此刻台上有几个"，不是"一共有过几个道具"。 */
  private get standing(): StandingIndex {
    return this.track === MAIN_TRACK || !this.standingAside ? this.standingMain : this.standingAside;
  }

  append(ops: Op[], track: TrackId = this.track): OpEntry[] {
    const added = this.log.append(ops, track);
    this.recompile();
    return added;
  }

  /** The tape head: transient partial visuals while the model is still emitting them. */
  setPreview(id: string, patch: Partial<{ box: Box; svg: string; html: string; css: string; label: string; scene: string }>) {
    const cur = this.preview.get(id) ?? { box: { x: 0, y: 0, w: 200, h: 200 }, label: id, scene: "default" };
    this.preview.set(id, { ...cur, ...patch } as typeof cur);
    this.beginArt(id);
  }

  clearPreview(id: string) {
    const had = this.preview.delete(id);
    const flying = this.artFor.delete(id);
    if (had || flying) this.emit();
  }

  /**
   * A paint has been asked for. `beginArt` must be matched by `endArt` on every path — the loop runs
   * it in a `finally` — because an id left in flight is a clock that waits on a paint forever.
   */
  beginArt(id: string) {
    this.artFor.add(id);
    this.emit();
  }

  endArt(id: string) {
    if (this.artFor.delete(id)) this.emit();
  }

  /**
   * A paint dispatched to run in the background: its frame is owed until it lands, whoever is
   * working on the tape head when it does. `beginPaint` must be matched by `endPaint` on every
   * path out — delivered, failed, or cancelled — for the same reason `beginArt` must be.
   */
  beginPaint(id: string) {
    this.painting.add(id);
    this.emit();
  }

  endPaint(id: string) {
    if (this.painting.delete(id)) this.emit();
  }

  /** The teacher's turn owns the debt: while it is open, an empty frame is a frame still expected. */
  setTurnOpen(on: boolean) {
    if (this.turnOpen === on) return;
    this.turnOpen = on;
    this.emit();
  }

  /**
   * Called in every debt a turn holds — including background paints, which outlive the turn that
   * dispatched them. A director parked on a question cannot pay art debt, and a beat that owes a
   * frame would hold the clock short of the very card it is waiting for. Nothing is abandoned by
   * this: the debt is re-billed on resume, and delivered art lands on the tape regardless.
   */
  setDebtSuspended(on: boolean) {
    if (this.debtSuspended === on) return;
    this.debtSuspended = on;
    this.emit();
  }

  private get room() {
    return typeof document === "undefined" || !document.hidden;
  }

  play() {
    if (this.playing) return;
    // Asked to start in an empty room — an aside can finish while the tab is dark — so remember the
    // ask and stand still, rather than walking a lesson nobody is watching.
    if (!this.room) {
      this.standStill(true);
      return;
    }
    this.awaitingAudience = false;
    this.playing = true;
    this.last = performance.now();
    this.watchAudience();
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  /** A stop the learner (or a gate, or the end of the tape) decided: not owed an audience. */
  hold() {
    if (!this.playing && !this.awaitingAudience) return;
    this.standStill(false);
  }

  /** @param awaitedByRoom the stop is not a decision, it is "come back when there is an audience" */
  private standStill(awaitedByRoom: boolean) {
    this.playing = false;
    this.awaitingAudience = awaitedByRoom;
    this.watchAudience();
    cancelAnimationFrame(this.raf);
    this.emit(); // the narrator reads `playing` off the snapshot, so the voice stops with the clock
  }

  toggle() {
    if (this.playing) this.hold();
    else this.play();
  }

  setSpeed(x: number) {
    this.speed = x;
    this.emit();
  }

  getRate() {
    return this.speed;
  }

  seek(t: number) {
    this.t = Math.max(0, Math.min(t, this.compiled.duration));
    this.camFrom = null;
    this.blockedBy = 0;
    // Standing on an old second is a look back, not a change of ownership: the tape is still this
    // learner's lesson — the card still asks him, the clock still waits on the painter. Only the
    // ● 实时 light goes off, because the playhead is no longer where the director is writing.
    this.followTail = false;
    this.emit();
  }

  /** Stand the playhead at the live edge and stay there: this is what ● 实时 does, and what a loaded recording switches ownership back on with. */
  goLive() {
    this.live = true;
    this.followTail = true;
    this.t = this.compiled.duration;
    this.emit();
  }

  /** Whether the playhead belongs to the live edge. `seek` turns this off and nothing but `goLive` turns it back on. */
  get following(): boolean {
    return this.followTail;
  }

  /** Rewind to the previous beat boundary so an interrupted passage can be re-played. */
  rewindToBeatStart(within = 4000) {
    // 窄表按 `t` 递增，"最近那一拍的开头"是一次二分。旧写法每按一次把整张 cue 表 `filter` 一份新
    // 数组、`reverse`、再 `find` —— 带的价钱和它替上一件消掉的那笔是同一笔。
    const prev = this.index.prevSpokenStart(this.t, within);
    this.seek(prev === null ? Math.max(0, this.t - within) : prev);
    this.play();
  }

  /**
   * Stand the clock at the edge of a cut. Everything from `seq` onward is forgotten on every
   * track, and the stage lands exactly where that op would have appeared — so the director can
   * re-perform the passage instead of appending to it. His answers on the cut passage go back with it:
   * they are ops now, not bookkeeping, so there is nothing here to keep in step.
   */
  rerollFrom(seq: number): number {
    this.log.cutFrom(seq);
    this.preview.clear();
    this.track = MAIN_TRACK;
    this.asideResume = null;
    this.camFrom = null;
    this.live = true;
    // A re-take is staged from the cut forward, so the playhead belongs to the live edge again.
    this.followTail = true;
    this.recompile();
    this.t = this.compiledMain.duration;
    this.play();
    return this.t;
  }

  beginAside() {
    // Through `hold()`, not just the flag: the main track's rAF is still armed when an interruption
    // arrives, and a bare assignment leaves a loop ticking a clock that is no longer being played.
    this.hold();
    // An aside is its own performance, and it is always live: the director is answering *this* person
    // right now, so a card it queues must stop for him and a frame it promises must be waited on. What
    // the main track was owned as goes back on `endAside` — it was never a question of the aside's.
    this.asideResume = { track: MAIN_TRACK, t: this.t, live: this.live, following: this.followTail };
    this.track = `aside:${this.log.asides().length + 1}`;
    this.t = 0;
    this.camFrom = null;
    this.live = true;
    this.followTail = true;
    this.emit();
    return this.track;
  }

  endAside() {
    const resume = this.asideResume;
    this.track = MAIN_TRACK;
    this.asideResume = null;
    this.recompile();
    if (resume) {
      this.t = resume.t;
      this.camFrom = null;
      // The lesson was not re-owned by being interrupted: hand back exactly what the main track was
      // standing as, ownership and playhead both.
      this.live = resume.live ?? true;
      this.followTail = resume.following ?? true;
    }
    this.play();
    this.emit();
  }

  /**
   * Take the learner's answer and put it on the tape.
   *
   * `seq` names the card the director's turn is blocked on; the card under the playhead is the fallback
   * for a learner who answers without a turn waiting. The parked card has to win, because the clock can
   * still be walking toward it — a director who queued two questions in one turn is parked on the second
   * while the first sits open under the playhead, and answering whichever arrived first strands the
   * promise the turn is actually waiting on.
   */
  answerGate(value: string, seq?: number) {
    const parked = seq !== undefined ? this.compiled.gates.find((g) => g.seq === seq && g.said === null) : undefined;
    const gate = parked ?? this.currentGate() ?? undefined;
    if (!gate) return;
    this.append([{ kind: "answer", gate: gate.seq, text: value }]);
    this.pending.get(gate.seq)?.resolve(value);
    this.pending.delete(gate.seq);
    this.play();
    this.emit();
  }

  /** The director's turn blocks here until a real learner answers. */
  waitForGate(seq: number): Promise<string> {
    const waiting = new Promise<string>((resolve) => this.pending.set(seq, { resolve }));
    // The host builds its button out of this snapshot, so a question a turn is blocked on has to be in
    // it even before the clock reaches the card — otherwise the button promises an interruption and
    // delivers an answer.
    this.emit();
    return waiting;
  }

  private pending = new Map<number, { resolve: (v: string) => void }>();

  openGateSeqs(): number[] {
    return this.index.openGateSeqs();
  }

  /**
   * The card the playhead is standing in. An open question wins; otherwise the card whose own beat is
   * still on screen — his answer shows for that beat and then goes away, because it belonged to the
   * moment he was asked, not to the rest of the lesson.
   */
  private cardAt(t: number): Gate | null {
    return this.index.cardAt(t);
  }

  /**
   * The question to stop the clock on, if the show is performing live.
   *
   * A recording never asks again. The answer is on the tape or it isn't, and either way the person
   * opening the link is watching, not learning: holding the clock on a card whose learner is elsewhere
   * turns a replay into a lesson with nobody in it. Press 接着说 and the board goes live from there,
   * which is the way to actually take the course.
   */
  currentGate(): Gate | null {
    if (!this.live) return null;
    const card = this.cardAt(this.t);
    return card && card.said === null ? card : null;
  }

  /** First gate not yet reached by the clock and not yet answered. */
  nextGate(): Gate | null {
    return this.index.firstOpenGate();
  }

  /**
   * How many pictures the beat under the playhead is owed: an empty frame scheduled inside it, or a
   * paint still in flight for a frame of it. A streaming drawing is NOT delivery — the tape head has
   * to finish before the line that describes it can start, which is what let captions run ahead.
   * An empty frame from a beat already read is not owed any more: a frame the director walked away
   * from must not park the clock forever — unless a paint was dispatched for it, which is owed no
   * matter whose turn is open, because it is the background pipeline that keeps the clock running.
   */
  private owedAt(t: number): number {
    if (!this.live || this.debtSuspended) return 0;
    if (!this.turnOpen && this.artFor.size === 0 && this.painting.size === 0) return 0;
    // 站着的这一拍：占时钟的 cue 互不重叠，所以二分就是那一格。旧写法把整条带子读到 `t` 为止，
    // 只为了问"此刻我站在哪一拍里"—— 而带子只增不改，这件事在排好的那一刻就该有答案。
    const beat = this.index.beatAt(t);
    const start = beat ? beat.t : t;
    const end = beat ? beat.end : t;
    // Half-open: a frame laid down at the exact millisecond this beat ends belongs to the NEXT beat,
    // so it must not bill the line still being spoken. Inclusive here parked a caption mid-sentence.
    const inThisBeat = (at: number) => at >= start && at < end;
    // A frame is only owed to the beat the clock is standing in: one pre-staged on the board the show
    // is walking onto belongs to the beats after the cut, not to the line being spoken now.
    const cut = this.cutAt(t);
    let n = 0;
    // 这一拍落的笔由索引二分出来，不是把整张道具表走一遍：旧写法连观众早就看不见的（换场扫走的、
    // 已经撤下的、站在别的板上的）也要问一次"这一刻它站着吗"。
    for (const s of this.standing.laidIn(start, end, t)) {
      if (this.swept(s.rev, cut)) continue;
      if (!painted(s.rev) && (this.turnOpen || !this.painting.has(s.prop.id))) n++;
    }
    // 在飞的画只问"它落在站着这一拍里吗"：道具表按 id 查，最新一次外观是一个下标，
    // 都不需要扫带子 —— 需要扫带子的那个问题（此刻站着哪一拍）上面已经二分掉了。
    for (const id of this.artFor) {
      const p = this.compiled.props.get(id);
      const rev = p ? p.revisions[p.revisions.length - 1] : undefined;
      // A frame being drawn that has not reached the tape is being made for right now.
      // 已经在带子上的那一格还得站在观众眼前：落笔那一遍问过 `swept`（换场扫走的那一格不欠时钟
      // 任何东西），在飞的这一遍以前没问 —— 于是一块被幕布压住的板上的空框仍然能让时钟停死，而
      // 观众已经不在那块板上。
      if (!rev || (inThisBeat(rev.t) && !this.swept(rev, cut))) n++;
    }
    for (const id of this.painting) {
      if (this.turnOpen || this.artFor.has(id)) continue; // already billed by the loops above
      const p = this.compiled.props.get(id);
      const rev = p ? p.revisions[p.revisions.length - 1] : undefined;
      // A background paint is owed to the beat it was placed in; a beat not reached yet bills
      // nothing here, or the clock would stand still for art belonging to a later line.
      if (!rev || (inThisBeat(rev.t) && !painted(rev) && !this.swept(rev, cut))) n++;
    }
    return n;
  }

  private tick(now: number) {
    // A frame that arrives while the show stands still is not a reason to move: a hidden tab still
    // gets a throttled callback, and an already-armed one can land after `hold()` cancelled it.
    if (!this.playing) return;
    const dt = (now - this.last) * this.speed;
    this.last = now;
    const dur = this.compiled.duration;
    const next = Math.min(this.t + dt, dur);
    // Standing still is not holding: `playing` stays on and the rAF keeps re-arming, so the frame
    // after the artwork lands the clock picks up by itself.
    const owedNext = this.owedAt(next);
    if (owedNext === 0) {
      this.t = next;
      this.blockedBy = 0;
      const gate = this.currentGate();
      if (gate) this.hold();
      // The tape runs out: stand still, unless this is the show riding its own live edge — there the
      // end is where the director is writing next, and the clock has to pick up by itself when a new
      // cut lands. (This used to key off `live`, which is why looking back at your own lesson was
      // enough to make it a recording.)
      else if (this.t >= dur && (!this.live || !this.followTail)) this.hold();
    } else this.blockedBy = owedNext;
    this.emit();
    if (this.playing) this.raf = requestAnimationFrame(this.tick);
  }

  /**
   * How far a prop has been displaced from its anchor by the motion running under it. A `track` shot
   * aims at the anchor when it is compiled, so without this the camera sits still while the artwork it
   * is following slides out of the frame.
   */
  private followOffset(id: string, t: number): { dx: number; dy: number } {
    const mo = this.index.motionFor(id, t);
    return mo ? motionOffset(mo.op as MotionOp, t - mo.t) : { dx: 0, dy: 0 };
  }

  /** The prop a settled `track` shot is still following, if the cue the camera last landed on is one. */
  private followed(cue: Cue | null | undefined): string | null {
    return cue?.op.kind === "camera" && cue.op.mode === "track" && cue.op.follow ? cue.op.follow : null;
  }

  /**
   * 这一帧的画面：先二分问"哪一刀还挂着这块板"，再插值正在滑的那一刀。旧写法每帧 `filter` 出一份
   * 新的镜头轨（十二万八千条带里九万六千个元素）再顺序扫一遍 —— 带子只增不改，这条窄表在排好的
   * 那一刻就该在那儿。落点与跟读的顺序和旧写法逐条覆盖的一致：站定的取最后走完的那条，滑动的取
   * 第一条没走完的。
   */
  private cameraAt(t: number): Box {
    const { settled, moving } = this.index.cameraFrame(t);
    if (moving) {
      const op = moving.op as { duration: number; easing: string };
      const p = Math.min(1, Math.max(0, (t - moving.t) / Math.max(moving.end - moving.t, 1)));
      const from = this.live && this.camFrom && this.camFromAt <= moving.t ? this.camFrom : moving.from;
      if (!this.camFrom || this.camFromAt !== moving.t) {
        this.camFrom = from;
        this.camFromAt = moving.t;
      }
      const follow = this.followed(moving) ?? this.followed(settled);
      const glide = lerpBox(from, moving.to, (EASES[op.easing] ?? EASES.ease)(p));
      return this.ride(glide, follow, t);
    }
    const rect = settled ? settled.to : this.rect;
    return this.ride(rect, this.followed(settled), t);
  }

  private ride(rect: Box, follow: string | null, t: number): Box {
    if (!follow) return rect;
    // 跟读的那一格已经不在观众眼前了 —— `discard` 落在这一刀滑动的中途是常事（overlay 不占时钟，带子
    // 可以紧跟着下一句落）。这时画面停在它的落点上，不许再往外推：往一件刚消失的东西的方向滑，看上去
    // 像是镜头还在找它，而名单里早就没有它了。
    if (!this.standing.seen(follow, t, this.cutAt(t))) return rect;
    const { dx, dy } = this.followOffset(follow, t);
    return dx === 0 && dy === 0 ? rect : { ...rect, x: rect.x + dx, y: rect.y + dy };
  }

  /**
   * The last transition the clock has walked through the veil of, if any: `flip` is the instant it
   * swept (the veil's midpoint, where the figure covers the frame, so nothing pops out from under a
   * transparent wipe) and `board` is where it landed.
   */
  private cutAt(t: number): Cut | null {
    return this.index.cutAt(t);
  }

  /**
   * Has a cut swept this artwork off the board? A transition wipes what was standing when it landed;
   * only what the director re-placed onto the destination board (`recall` stamps the board) or laid
   * down afterwards survives. Before the first cut everything shares one board, because panning into
   * empty space to open a new line of thought is not a scene change and art must not vanish from it.
   */
  private swept(rev: Revision, cut: Cut | null): boolean {
    return !!cut && rev.t < cut.flip && rev.scene !== cut.board;
  }

  /**
   * Can the audience see this name at `t` — a prop standing there, not swept off, or a board with such
   * a prop on it. Read off the same answer `visibleProps` paints from, because the two used to disagree:
   * this one never looked at `discard`, so a camera that named a freshly-retired prop got told "the
   * audience has it", moved nowhere, and the turn read that silence as a cut that happened.
   */
  visibleName(id: string, t: number): boolean {
    for (const { prop, rev } of this.standing.visible(t, this.cutAt(t))) {
      if (prop.id === id || rev.scene === id) return true;
    }
    return false;
  }

  /**
   * 这几刀点的名，观众在**它们各自落下的那一刻**看不见哪些 —— 一次问完，按点名的次序、去掉重复。
   *
   * 上一件把这句对账交给了 `agent/loop.ts`，而它那一头是 `compiled.cues.find((c) => c.op === askedBy)`
   * 加一次 `visibleName`。找的那个用法恰恰是**找不到才说话**，于是点一个空名字就要把整张 cue 表走完
   * （128 001 条的带子实测 1.17ms/次，命中同一个数 —— 钱在 `find` 上），而导演一轮要点几十次名。带子只增不改，"这一刀
   * 落在哪一刻"在排好的那一刻就有答案（`Compiled.shotAt`），所以这一问和它下面那句 `visibleName`
   * 一起搬到台上 —— 对账的规矩只许有一处说法。
   */
  blindNames(ops: Op[]): string[] {
    const blind: string[] = [];
    const seen = new Set<string>();
    const end = this.compiled.duration;
    for (const op of ops) {
      if (op.kind !== "camera") continue;
      // 问的是这一刻的台，不是带子尽头：`here`、`discard`、换场都能让同一个名字在两刻之间换了说法。
      const at = this.compiled.shotAt.get(op) ?? end;
      const names = [
        ...(op.target ? (Array.isArray(op.target) ? op.target : [op.target]) : []),
        ...(op.follow ? [op.follow] : []),
      ];
      for (const id of names) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (!this.visibleName(id, at)) blind.push(id);
      }
    }
    return blind;
  }

  /** The board the show is standing on at `t`, or null before its first cut. */
  boardAt(t: number): string | null {
    return this.cutAt(t)?.board ?? null;
  }

  /**
   * 台上这一刻有什么。强调叠层和运动都问索引（"此刻在跑的几格"），名单也问索引：游标走过落笔与收笔，
   * 一帧只付"这一刻真的越过的事件"加"台上有几样东西"。旧写法每帧把整张道具表走一遍，把观众早就看不见
   * 的那些也走 —— 一堂课长到几百格时，一帧的价钱就是"这堂课一共有过几个道具"。
   */
  private visibleProps(t: number): VisibleProp[] {
    const out: VisibleProp[] = [];
    const highlights = this.index.highlightsAt(t);
    for (const { prop: p, rev } of this.standing.visible(t, this.cutAt(t))) {
      const style = highlights.get(p.id);
      const pv = this.preview.get(p.id);
      const mo = this.index.motionFor(p.id, t);
      const box = displaced(pv?.box ?? rev.box, mo ? motionOffset(mo.op as MotionOp, t - mo.t) : { dx: 0, dy: 0 });
      // Delivery is read off the tape, never off the tape head: a drawing still streaming in is a
      // promise, so the caption for it waits. The outline below is the other question — is anything
      // visible here at all yet — and a streaming stroke answers that one.
      const streaming = pv ? { svg: pv.svg, html: pv.html, scene3d: rev.scene3d } : rev;
      out.push({
        id: p.id,
        // 站着那一格的板名，不是道具最后被挪去了哪：`standing.ts` 分板、镜头取景、导演快照说的都是
        // 前者，一帧的名单以前报的是后者 —— 于是同一卷带子上 `a` 在两处两个板名上，而"这一件东西
        // 此刻在哪块板上"是一帧要拿去画的东西。
        scene: rev.scene,
        box,
        svg: pv?.svg ?? rev.svg,
        html: pv?.html ?? rev.html,
        css: pv?.css ?? rev.css,
        scene3d: rev.scene3d,
        label: pv?.label ?? rev.label,
        note: rev.note,
        draft: !painted(rev),
        awaiting: this.artFor.has(p.id) && !painted(streaming) && overlaps(box, this.rect),
        highlight: style,
      });
    }
    for (const [id, pv] of this.preview) {
      if (this.compiled.props.has(id)) continue;
      out.push({
        id,
        scene: pv.scene,
        box: pv.box,
        svg: pv.svg,
        html: pv.html,
        css: pv.css,
        draft: true,
        awaiting: !painted(pv) && overlaps(pv.box, this.rect),
        label: pv.label,
      });
    }
    return out;
  }

  private render(): RenderState {
    const t = this.t;
    this.rect = this.cameraAt(t);
    const props = this.visibleProps(t);
    this.owed = this.owedAt(t) || (this.playing ? this.blockedBy : 0);
    this.artWait = this.playing && this.owed > 0;
    // 旁白和幕布各问一次索引：旧写法每一帧把整条带子筛两遍再 pop。两者都不重叠（占时钟的），
    // 所以"最后落下的那一条还在跑"就是"站着的那一条"。
    const narr = this.index.narrationAt(t);
    const veil = this.index.veilAt(t);
    return {
      t,
      duration: this.compiled.duration,
      rect: this.rect,
      viewport: { w: 1600, h: 900 },
      props,
      narration: narr
        ? {
            text: (narr.op as { text: string }).text,
            progress: Math.min(1, (t - narr.t) / Math.max(narr.end - narr.t, 1)),
            // The line is finished on screen `SETTLE_MS` before the beat ends: the last characters must
            // not be appearing at the very instant the camera moves, or the settle buys nothing.
            reveal: Math.min(1, (t - narr.t) / Math.max(narr.end - narr.t - SETTLE_MS, 1)),
            duration: Math.max(narr.end - narr.t, 1),
            style: (narr.op as { style?: string }).style ?? "caption",
          }
        : null,
      veil: veil ? { style: (veil.op as { style: string }).style, progress: (t - veil.t) / Math.max(veil.end - veil.t, 1) } : null,
      gate: this.currentGate(),
      said: this.cardAt(t)?.said ?? null,
      askedGate: this.pending.size ? Math.min(...this.pending.keys()) : null,
      playing: this.playing,
      finished: !this.playing && t >= this.compiled.duration && this.compiled.duration > 0,
      track: this.track,
      live: this.live,
      following: this.followTail,
      artOwed: this.owed,
      artWait: this.artWait,
    };
  }

  /**
   * What the teacher model is allowed to see about the stage: geometry + identity, never SVG source.
   *
   * 它读的是**播放头站着的那一刻**，不是带子尽头。这条以前是"最新一次外观"：学习者倒回三分钟前、
   * 导演在那一刻接上一句，快照就把还没落下的图报给他 —— 他照着"台上明明有的东西"发一刀 fit，画面
   * 一动不动，还以为是自己的镜头写错了。导演能看见的台，必须是观众此刻能看见的那一台。
   */
  agentSnapshot(): string {
    const c = this.compiled;
    const t = this.t;
    const cut = this.cutAt(t);
    const board = cut?.board ?? null;
    const live: string[] = [];
    // 一次遍历答完三件事：站着什么、什么正在动、被换场扫走的还剩几格。索引按道具给运动，
    // 所以"正在动"不再需要把整条 cue 表走一遍。
    for (const { prop: p, rev: r } of this.standing.standing(t)) {
      const mo = this.index.motionFor(p.id, t);
      const off = this.swept(r, cut) ? "·已被换场扫走（recall 才带得回来）" : "";
      // 一条关系也是一个时刻：`link` 落在哪一刻就归哪一刻，倒带回到那一刀之前不许报出它 —— 它指着的
      // 那个名字此刻可能还没上台。落下次序，所以这是一段前缀。
      const ties = p.links.filter((l) => l.at <= t);
      live.push(
        `  ${p.id} [${r.scene}${off}] ${r.label} @(${Math.round(r.box.x)},${Math.round(r.box.y)} ${Math.round(r.box.w)}x${Math.round(r.box.h)})${r.scene3d ? ` [3D${r.scene3d.interactive ? "·可拖" : ""}]` : ""}${mo ? ` moving:${(mo.op as MotionOp).mode}(anchor stands)` : ""}${ties.length ? ` links:${ties.map((l) => l.relation + "->" + l.to).join(",")}` : ""}`,
      );
    }
    const scenes = [...c.scenes.entries()].map(([s, b]) => `${s}=(${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)})`).join(" ");
    const gate = this.currentGate();
    const staged = c.beats
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.headline)
      .map(({ b, i }) => `  ${i + 1}. ${b.headline.slice(0, 46)} (${Math.round(b.start)}–${Math.round(b.end)}ms)`)
      .join("\n");
    return [
      // The rect, not just its centre: to build in the empty space the camera just slid to, the
      // director has to know what is inside the frame, and a centre point alone can't be placed in.
      `stage clock: ${Math.round(this.t)}ms / ${Math.round(c.duration)}ms, camera sees=(${Math.round(this.rect.x)},${Math.round(this.rect.y)} ${Math.round(this.rect.w)}x${Math.round(this.rect.h)}) zoom=${(1600 / this.rect.w).toFixed(2)}`,
      board
        ? `standing on board「${board}」— 换场会扫板：这一刀之前落下的东西，只有属于这块板的观众还看得见。要用别的板上的道具只有 recall 带过来；不写 scene 的 build 就落在脚下这块板，写了 scene 是把它挪到那块板上。接着讲同一块板用 pan，别用 transition。`
        : "还没换过场：台上就是一整张无限画布，换场前的东西全都还在眼前。不写 scene 的 build 落在脚下。要开新思路就 pan 一屏到空白处落笔，那不算是换场。",
      `scenes: ${scenes || "-"}`,
      `props on file (source not shown; fetch_prop to recall it):`,
      live.join("\n") || "  (empty)",
      c.beats.length > 1
        ? `beats already on the tape — these lines have been spoken, do not re-lay them, continue from where they stop:\n${staged}`
        : "",
      gate ? `WAITING ON LEARNER: ${JSON.stringify(gate.op)}` : "no open question",
    ]
      .filter(Boolean)
      .join("\n");
  }
}
