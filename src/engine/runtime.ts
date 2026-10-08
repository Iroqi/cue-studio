import { compile } from "./compile";
import { MAIN_TRACK, OpLog } from "./log";
import { displaced, motionOffset } from "./motion";
import { cardAt, framingAt, revisionAt, runningLast, windowOf } from "./reads";
import { upperBound } from "./search";
import { SETTLE_MS } from "./speech";
import type { Box, Compiled, Cue, Gate, HighlightOp, MotionOp, Op, OpEntry, Prop, Revision, Scene3DSpec, TrackId, TransitionOp } from "./types";

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
  private compiledMain: Compiled = compile([]);
  private compiledAside: Compiled | null = null;
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
    this.compiledMain = compile(this.log.ofTrack(MAIN_TRACK));
    const aside = this.log.asides()[this.log.asides().length - 1];
    this.compiledAside = aside ? compile(this.log.ofTrack(aside)) : null;
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
    const beats = this.compiled.cues.filter((c) => c.op.kind === "narrate" || c.op.kind === "beat");
    const prev = [...beats].reverse().find((c) => c.t < this.t - 200 && this.t - c.t <= within);
    this.seek(prev ? prev.t : Math.max(0, this.t - within));
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
    return this.compiled.frame.gates.open.map((g) => g.seq);
  }

  /**
   * The card the playhead is standing in. An open question wins; otherwise the card whose own beat is
   * still on screen — his answer shows for that beat and then goes away, because it belonged to the
   * moment he was asked, not to the rest of the lesson.
   */
  private cardAt(t: number): Gate | null {
    return cardAt(this.compiled.frame.gates, t);
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
    return this.compiled.frame.gates.open[0] ?? null;
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
    /*
     * The frame the clock is standing in. The old read walked the whole cue list keeping the last
     * time-owning running cue; `frame.owning` is exactly those cues, in the same order, so the same
     * answer is one window. Nothing running means a zero-length beat at `t`, which is what the old
     * `start = end = t` did — and `inThisBeat` then bills nothing, which is the point.
     */
    const beat = runningLast(this.compiled.frame.owning, t);
    const start = beat ? beat.t : t;
    const end = beat ? beat.end : t;
    // Half-open: a frame laid down at the exact millisecond this beat ends belongs to the NEXT beat,
    // so it must not bill the line still being spoken. Inclusive here parked a caption mid-sentence.
    const inThisBeat = (at: number) => at >= start && at < end;
    // A frame is only owed to the beat the clock is standing in: one pre-staged on the board the show
    // is walking onto belongs to the beats after the cut, not to the line being spoken now.
    const cut = this.cutAt(t);
    let n = 0;
    const { props, reach } = this.compiled.frame.staged;
    // Everything past the bound belongs to a scene the show has not walked into yet — it had no
    // revision at `t`, so the old loop skipped it after building a filtered array to find that out.
    const landed = upperBound(reach, t);
    for (let i = 0; i < landed; i++) {
      const p = props[i];
      if (p.discardedAt !== undefined && p.discardedAt <= t) continue;
      const rev = revisionAt(p, t);
      if (!rev) continue;
      if (this.swept(rev, cut)) continue;
      if (!painted(rev) && inThisBeat(rev.t) && (this.turnOpen || !this.painting.has(p.id))) n++;
    }
    for (const id of this.artFor) {
      const p = this.compiled.props.get(id);
      const rev = p?.revisions[p.revisions.length - 1];
      // A frame being drawn that has not reached the tape is being made for right now.
      if (!rev || inThisBeat(rev.t)) n++;
    }
    for (const id of this.painting) {
      if (this.turnOpen || this.artFor.has(id)) continue; // already billed by the loops above
      const p = this.compiled.props.get(id);
      const rev = p?.revisions[p.revisions.length - 1];
      // A background paint is owed to the beat it was placed in; a beat not reached yet bills
      // nothing here, or the clock would stand still for art belonging to a later line.
      if (!rev || (inThisBeat(rev.t) && !painted(rev))) n++;
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
   *
   * `motionByProp` already holds this id's cues and nothing else, so "the last one running" is the
   * window's tail rather than a `filter` + `pop` over the whole tape — this used to run once per
   * settled `track` shot, every frame.
   */
  private followOffset(id: string, t: number): { dx: number; dy: number } {
    const line = this.compiled.frame.motionByProp.get(id);
    const mo = line ? runningLast(line, t) : null;
    return mo ? motionOffset(mo.op as MotionOp, t - mo.t) : { dx: 0, dy: 0 };
  }

  /** The prop a settled `track` shot is still following, if the cue the camera last landed on is one. */
  private followed(cue: Cue | undefined): string | null {
    return cue?.op.kind === "camera" && cue.op.mode === "track" && cue.op.follow ? cue.op.follow : null;
  }

  /**
   * Where the eye is at `t`. The old read `filter`ed a fresh camera list every frame and then walked
   * all of it; this asks `framingAt` for the two indexes the walk would have stopped at and reads those
   * two cues.
   *
   * `settled` is not just an optimization for the common case: it is the frame the tape landed *before*
   * the glide the clock is inside, and the one landed after it stays unread — which is exactly what the
   * old loop's `break`/`return` did, and what keeps a future cut from pulling the picture backward.
   */
  private cameraAt(t: number): Box {
    const line = this.compiled.frame.framing;
    const { settled, running } = framingAt(line, t);
    if (running < 0) {
      const c = settled < 0 ? undefined : line.cues[settled];
      return this.ride(c ? c.to : this.rect, this.followed(c), t);
    }
    const c = line.cues[running];
    const op = c.op as { duration: number; easing: string };
    const p = Math.min(1, Math.max(0, (t - c.t) / Math.max(c.end - c.t, 1)));
    const from = this.live && this.camFrom && this.camFromAt <= c.t ? this.camFrom : c.from;
    if (!this.camFrom || this.camFromAt !== c.t) {
      this.camFrom = from;
      this.camFromAt = c.t;
    }
    const settledCue = settled < 0 ? undefined : line.cues[settled];
    const follow = this.followed(c) ?? this.followed(settledCue);
    const glide = lerpBox(from, c.to, (EASES[op.easing] ?? EASES.ease)(p));
    return this.ride(glide, follow, t);
  }

  private ride(rect: Box, follow: string | null, t: number): Box {
    if (!follow) return rect;
    const { dx, dy } = this.followOffset(follow, t);
    return dx === 0 && dy === 0 ? rect : { ...rect, x: rect.x + dx, y: rect.y + dy };
  }

  /**
   * The last transition the clock has walked through the veil of, if any: `flip` is the instant it
   * swept (the veil's midpoint, where the figure covers the frame, so nothing pops out from under a
   * transparent wipe) and `board` is where it landed.
   *
   * `flips` is non-decreasing — a transition owns the clock, so the next one starts where this one ends,
   * and the midpoint of one cut cannot land after the start of the next. That makes the answer one
   * subtraction instead of the old walk over every cue in the show, and this was called once per prop
   * list read, i.e. twice a frame.
   */
  private cutAt(t: number): Cut | null {
    const { cuts, flips } = this.compiled.frame;
    const i = upperBound(flips, t) - 1;
    if (i < 0) return null;
    return { flip: flips[i], board: (cuts.cues[i].op as TransitionOp).to };
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

  /** The revision standing on the board at `t`, unless a cut has swept it off. */
  private standingAt(p: Prop, t: number, cut: Cut | null): Revision | undefined {
    const rev = revisionAt(p, t);
    return rev && !this.swept(rev, cut) ? rev : undefined;
  }

  /**
   * Can the audience see this name at `t` — a prop painted by then and not swept off, or a board with
   * such a prop on it. Read off the revisions standing at `t`, exactly as `visibleProps` paints them.
   *
   * "Some other board has a prop on it" used to walk the whole prop table. `Compiled.sceneProps` is that
   * question answered once per recompile, so a director's `camera fit 一整块板` costs a lookup.
   *
   * One deliberate non-fix, so the index cannot quietly smuggle in a semantic change: neither the old
   * read nor this one asks `discardedAt`, even though `visibleProps` does. The probe caught that
   * difference and `docs/iteration-frame-read.md` records it as the next hole; here the answer must be
   * the same one the tape gave before.
   */
  visibleName(id: string, t: number): boolean {
    const c = this.compiled;
    const cut = this.cutAt(t);
    const named = c.props.get(id);
    if (named && this.standingAt(named, t, cut)) return true;
    for (const p of c.sceneProps.get(id) ?? []) {
      // A candidate, not an answer: the board it is *standing* on at `t` is what the audience can see.
      const rev = this.standingAt(p, t, cut);
      if (rev && rev.scene === id) return true;
    }
    return false;
  }

  /** The board the show is standing on at `t`, or null before its first cut. */
  boardAt(t: number): string | null {
    return this.cutAt(t)?.board ?? null;
  }

  private visibleProps(t: number): VisibleProp[] {
    const out: VisibleProp[] = [];
    const c = this.compiled;
    const cut = this.cutAt(t);
    /*
     * The two overlay lines, read once into a table instead of once per prop. The old code ran
     * `cues.filter(...)` twice and then `highlights.find`/`motions.filter(...).pop()` *inside* the prop
     * loop — so a frame paid for the tape once per cell on it.
     *
     * `windowOf` is "started and not known finished", so the highlight/motion pairs are found in the same
     * handful of cues the old filter kept; first/last wins are preserved by the direction each walk goes.
     */
    const hl = new Map<string, string>();
    const { from, to } = windowOf(c.frame.highlights, t);
    for (let i = from; i < to; i++) {
      const cue = c.frame.highlights.cues[i];
      if (cue.end <= t) continue; // the window is a bound; the old filter asked the cue itself
      const op = cue.op as HighlightOp;
      if (hl.has(op.target)) continue; // the old `find`: the earliest running highlight wins
      hl.set(op.target, op.style);
    }
    const { props, reach } = c.frame.staged;
    // Props past the bound had no revision at `t` — the old loop built a filtered array to learn that.
    const landed = upperBound(reach, t);
    for (let i = 0; i < landed; i++) {
      const p = props[i];
      if (p.discardedAt !== undefined && p.discardedAt <= t) continue;
      const rev = revisionAt(p, t);
      if (!rev) continue;
      if (this.swept(rev, cut)) continue;
      const pv = this.preview.get(p.id);
      const line = c.frame.motionByProp.get(p.id);
      // The old `filter(...).pop()`: the last motion running here, which is the window's tail.
      const mo = line ? runningLast(line, t) : null;
      const box = displaced(pv?.box ?? rev.box, mo ? motionOffset(mo.op as MotionOp, t - mo.t) : { dx: 0, dy: 0 });
      // Delivery is read off the tape, never off the tape head: a drawing still streaming in is a
      // promise, so the caption for it waits. The outline below is the other question — is anything
      // visible here at all yet — and a streaming stroke answers that one.
      const streaming = pv ? { svg: pv.svg, html: pv.html, scene3d: rev.scene3d } : rev;
      out.push({
        id: p.id,
        scene: p.scene,
        box,
        svg: pv?.svg ?? rev.svg,
        html: pv?.html ?? rev.html,
        css: pv?.css ?? rev.css,
        scene3d: rev.scene3d,
        label: pv?.label ?? rev.label,
        note: rev.note,
        draft: !painted(rev),
        awaiting: this.artFor.has(p.id) && !painted(streaming) && overlaps(box, this.rect),
        highlight: hl.get(p.id),
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
    const c = this.compiled;
    this.rect = this.cameraAt(t);
    const props = this.visibleProps(t);
    this.owed = this.owedAt(t) || (this.playing ? this.blockedBy : 0);
    this.artWait = this.playing && this.owed > 0;
    // The line and the veil: the old read built two more filtered arrays per frame.
    const narr = runningLast(c.frame.narrate, t);
    const veil = runningLast(c.frame.cuts, t);
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
   * And it has to stay a *summary*. This string is re-read every director turn and rides in the
   * transcript as a tool result, so an unbounded one is the same hole `budget.ts` just closed from the
   * other side: a long lesson either pushes its own context over the ceiling or gets deflated to a
   * pointer — and a deflated `<stage>` is worse than a short one, because the director then re-performs
   * lines that were already spoken and repaints frames the audience can already see.
   *
   * So the report holds what the clock can act on: the frame under the playhead, the board being
   * stood on, the cells actually in front of the audience, and the last few lines spoken. Everything
   * folded away is *counted*, never dropped silently, and each fold names the tool that reads it back
   * (`fetch_prop`) — the tape is still the memory; this is only the window onto it.
   */
  agentSnapshot(): string {
    const c = this.compiled;
    const t = this.t;
    const cut = this.cutAt(t);
    const board = cut?.board ?? null;
    /*
     * What is moving under the playhead. The old read walked the whole cue list for this; one window
     * over `frame.motions` is the same answer — `end > t` re-applied, because the bound is a bound.
     */
    const moving = new Map<string, string>();
    const mw = windowOf(c.frame.motions, t);
    for (let i = mw.from; i < mw.to; i++) {
      const cue = c.frame.motions.cues[i];
      if (cue.end <= t) continue;
      const op = cue.op as MotionOp;
      moving.set(op.id, op.mode);
    }

    const listed: string[] = [];
    let swept = 0;
    let offFrame = 0;
    let overCap = 0;
    for (const p of c.frame.staged.props) {
      if (p.discardedAt !== undefined && p.discardedAt <= t) continue;
      const r = revisionAt(p, t);
      // Not on the board yet: the same rule that keeps a name only `link`ed out of here.
      if (!r) continue;
      if (this.swept(r, cut)) {
        swept++;
        continue;
      }
      // Which thing folded it away matters to the reader: only one of these three is fixed by panning.
      if (!overlaps(r.box, this.rect)) {
        offFrame++;
        continue;
      }
      if (listed.length >= MAX_SNAPSHOT_PROPS) {
        overCap++;
        continue;
      }
      listed.push(
        `  ${p.id} [${p.scene}] ${r.label} @(${Math.round(r.box.x)},${Math.round(r.box.y)} ${Math.round(r.box.w)}x${Math.round(r.box.h)})${r.scene3d ? ` [3D${r.scene3d.interactive ? "·可拖" : ""}]` : ""}${moving.has(p.id) ? ` moving:${moving.get(p.id)}(anchor stands)` : ""}${p.links.length ? ` links:${p.links.map((l) => l.relation + "->" + l.to).join(",")}` : ""}`,
      );
    }
    const why = [
      swept ? `${swept} 格已被换场扫走（recall 才带得回来）` : "",
      offFrame ? `${offFrame} 格在镜头框外（pan/fit 才看得见，或 fetch_prop 直接读几何）` : "",
      overCap ? `${overCap} 格就在框内，只是这一屏只列 ${MAX_SNAPSHOT_PROPS} 格（剩下的 fetch_prop 一格一格读）` : "",
    ]
      .filter(Boolean)
      .join("，");
    const folded = swept + offFrame + overCap === 0 ? "" : `  …台上还有 ${swept + offFrame + overCap} 格没列出来：${why}。`;
    const live = [listed.join("\n"), folded].filter(Boolean).join("\n");

    const scenes = boardScenes(c, this.rect, board);
    const gate = this.currentGate();
    // The beats the director must not re-lay. Only the tail is listed; the ones before it are counted,
    // and where they stop is the one number the next line actually needs.
    const spoken = c.beats.filter((b) => b.headline);
    const shown = spoken.slice(-MAX_SNAPSHOT_BEATS);
    const earlier = spoken.length - shown.length;
    const staged = [
      earlier > 0 ? `  …前面还有 ${earlier} 拍说过了（从 ${Math.round(c.beats[0]?.end ?? 0)}ms 之后折成一句 —— 那一拍之前的台词都不必再读）` : "",
      ...shown.map((b, i) => `  ${earlier + i + 1}. ${b.headline.slice(0, 46)} (${Math.round(b.start)}–${Math.round(b.end)}ms)`),
    ]
      .filter(Boolean)
      .join("\n");
    return [
      // The rect, not just its centre: to build in the empty space the camera just slid to, the
      // director has to know what is inside the frame, and a centre point alone can't be placed in.
      `stage clock: ${Math.round(t)}ms / ${Math.round(c.duration)}ms, camera sees=(${Math.round(this.rect.x)},${Math.round(this.rect.y)} ${Math.round(this.rect.w)}x${Math.round(this.rect.h)}) zoom=${(1600 / this.rect.w).toFixed(2)}`,
      board
        ? `standing on board「${board}」— 换场会扫板：这一刀之前落下的东西，只有属于这块板的观众还看得见。要用别的板上的道具只有 recall 带过来；不写 scene 的 build 就落在脚下这块板，写了 scene 是把它挪到那块板上。接着讲同一块板用 pan，别用 transition。`
        : "还没换过场：台上就是一整张无限画布，换场前的东西全都还在眼前。不写 scene 的 build 落在脚下。要开新思路就 pan 一屏到空白处落笔，那不算是换场。",
      `scenes: ${scenes}`,
      `props on file (source not shown; fetch_prop to recall it):`,
      live || "  (empty)",
      spoken.length > 1
        ? `beats already on the tape — these lines have been spoken, do not re-lay them, continue from where they stop:\n${staged}`
        : "",
      gate ? `WAITING ON LEARNER: ${JSON.stringify(gate.op)}` : "no open question",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/** How many cells the `<stage>` may name. A frame that holds more than this is a wall, not a shot. */
const MAX_SNAPSHOT_PROPS = 40;

/** How many beats the `<stage>` may quote. Older lines are counted; the director continues from the tail. */
const MAX_SNAPSHOT_BEATS = 12;

/**
 * The boards worth naming to the director: the one he is standing on, and the ones with something
 * inside the current frame.
 *
 * This used to print every board the lesson had ever put a foot on, because the scene map grows with
 * the show. A director cannot act on a coordinate list that outlives the screen — and once the lesson
 * has walked a few dozen boards, the list is the part that blows the budget. `n boards off view` says
 * the rest, and `transition`/`recall` reach them by name anyway.
 */
function boardScenes(c: Compiled, rect: Box, board: string | null): string {
  const named: string[] = [];
  let off = 0;
  for (const [name, b] of c.scenes) {
    if (name === board || overlaps(b, rect)) named.push(`${name}=(${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)})`);
    else off++;
  }
  if (off > 0) named.push(`…另有 ${off} 块板不在视野里（按名字 transition 过去就行）`);
  return named.join(" ") || "-";
}
