import type {
  Beat,
  Box,
  BeatOp,
  BuildOp,
  CameraOp,
  Compiled,
  Cue,
  Gate,
  NarrateOp,
  Op,
  OpEntry,
  Prop,
  RecallOp,
  Revision,
  TransitionOp,
} from "./types";
import { inkBox } from "./ink";
import { speechMs, SETTLE_MS } from "./speech";

export const VIEWPORT: Box = { x: 0, y: 0, w: 1600, h: 900 };

/**
 * How close a close-up may get, in world units of frame width. A painter's smallest text is 28 units
 * tall; at 450 units of frame the board pushes in 3.5x, so that text lands around 90-100 px — a big
 * word, still a word. The old floor of 260 meant 6x and ~155 px: a label stopped being a word and a
 * stroke became a wall, which is what made close-ups look blown up.
 */
const MIN_CLOSEUP_W = 450;

/**
 * How far apart two boards sit on the plane, when nothing on the tape says otherwise. The vocabulary
 * promises a scene of about one viewport with boards 2000~3000 apart; 2400 is the middle of that, so
 * the ground a named-but-empty board is given sits where a director would have put it by hand.
 */
const BOARD_SPACING = 2400;

export function unionBox(boxes: Box[]): Box {
  if (boxes.length === 0) return { ...VIEWPORT };
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: Math.max(x2 - x1, 1), h: Math.max(y2 - y1, 1) };
}

export function centerOf(b: Box): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function padded(b: Box, f = 1.25): Box {
  const c = centerOf(b);
  return { x: c.x - (b.w * f) / 2, y: c.y - (b.h * f) / 2, w: b.w * f, h: b.h * f };
}

function frac(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function fitRect(rect: Box, aspect: number): Box {
  const ra = rect.w / rect.h;
  if (ra > aspect) return { x: rect.x, y: rect.y - (rect.w / aspect - rect.h) / 2, w: rect.w, h: rect.w / aspect };
  return { x: rect.x - (rect.h * aspect - rect.w) / 2, y: rect.y, w: rect.h * aspect, h: rect.h };
}

/**
 * One ceiling on how far the eye may push in, applied to every camera mode after it resolves. `focus`
 * and a single-prop `fit` used to have none, so a small prop could be blown up arbitrarily while the
 * two modes that did clamp stopped at 6x. Widening only ever pulls the frame back, never crops.
 */
function limitPushIn(rect: Box, aspect: number): Box {
  if (rect.w >= MIN_CLOSEUP_W) return rect;
  const c = centerOf(rect);
  return { x: c.x - MIN_CLOSEUP_W / 2, y: c.y - MIN_CLOSEUP_W / aspect / 2, w: MIN_CLOSEUP_W, h: MIN_CLOSEUP_W / aspect };
}

function propBox(props: Map<string, Prop>, id: string): Box | undefined {
  const p = props.get(id);
  const rev = p?.revisions[p.revisions.length - 1];
  if (!rev) return undefined;
  // Aim at the ink, not at the frame the art was allowed to fill: a drawing that hugs one corner of its
  // own canvas sits a fifth of a view off centre while the arithmetic says it is perfectly framed.
  return inkBox(rev.svg, rev.box) ?? rev.box;
}

function sceneBox(props: Map<string, Prop>, scene: string): Box | undefined {
  const boxes = [...props.values()]
    .filter((p) => p.scene === scene && p.discardedAt === undefined)
    .map((p) => propBox(props, p.id))
    .filter((b): b is Box => !!b);
  return boxes.length ? unionBox(boxes) : undefined;
}

/** Narration, transitions and beats own the clock; camera moves, highlights and motion run on top of them. */
export type TimeOwning = NarrateOp | TransitionOp | BeatOp;

export function ownsTime(op: Op): op is TimeOwning {
  return op.kind === "narrate" || op.kind === "beat" || op.kind === "transition";
}

/**
 * How long an op holds the frame. Every cut in the show is timed off this window, so the two floors
 * here are what keep the picture from running ahead of its own narration: a line cannot be squeezed
 * under the time it takes to say out loud, and a scene change cannot be shorter than the half of it
 * the veil needs to cover the board — below that, the sweep of the old scene is an invisible jump cut.
 */
export function cueMs(op: Op): number {
  if (op.kind === "narrate") return Math.max(op.duration, speechMs(op.text) + SETTLE_MS);
  if (op.kind === "transition") return Math.max(op.duration, 700);
  return Math.max("duration" in op ? op.duration : 0, 1);
}

export function compile(entries: OpEntry[]): Compiled {
  const props = new Map<string, Prop>();
  const cues: Cue[] = [];
  const gates: Gate[] = [];
  const beats: Beat[] = [];
  let cur: Beat | null = null;
  let openNext = false;
  let t = 0;
  let cursor: Box = { ...VIEWPORT };
  // Which board the show is standing in, named by the last `transition`. A prop the director gives no
  // scene for lands on this one, because "the board I am looking at" is what they meant by leaving it
  // out — and a prop on some other board is not on it, which is what keeps a new scene clean.
  let standing = "";
  let lastSeq = 0;
  let slotKey = "";
  let slotN = 0;

  /*
   * A named board has a place on the plane. It used to have only whatever its props happened to
   * cover, so a board named before anything was laid on it had no bounds at all: `transition` fell
   * back to the frame it was already in, and the veil then swept the old lesson off a board the
   * camera never left — the audience watched their picture get erased and got nothing in its place.
   *
   * So boards are given out in the order the show walks onto them, at the spacing the vocabulary
   * already promises (a scene is about one viewport, boards 2000~3000 apart). Explicit coordinates
   * still widen the frame, so a director who places things by hand is not caged by this ground; it
   * only says where the board is when nothing on it says so yet.
   */
  const boards = new Map<string, Box>();
  const boardOf = (name: string): Box => {
    const known = boards.get(name);
    if (known) return known;
    const placed: Box = { x: (boards.size + 1) * BOARD_SPACING, y: 0, w: VIEWPORT.w, h: VIEWPORT.h };
    boards.set(name, placed);
    return placed;
  };

  /**
   * Where the camera stands for a board. If anything has been laid on it, frame that (padded, as it
   * always was) — a director who places by hand owns the position. If nothing has, the board still has
   * a place, and moving the camera there is the whole point of the cut: standing still while the veil
   * sweeps the previous board's art away leaves the learner staring at an empty frame they were never
   * shown.
   */
  const boardView = (name: string, aspect: number): Box => {
    const laid = sceneBox(props, name);
    return fitRect(laid ? padded(laid, 1.2) : boardOf(name), aspect);
  };

  /**
   * `here` is what happens when the director asks for an object but names no coordinates: it lands
   * inside the frame the camera is on, and a second one does not sit exactly on the first.
   * Placing things by world numbers is the part of an unbounded plane a model reliably gets wrong,
   * and a prop outside the frame is a lesson the learner never sees.
   *
   * The first slot is the centre of the frame — one object asked for one object, and the audience
   * should not have to look off-axis at it. After that the slots spiral outward over the region the
   * *centre* may occupy without the box leaving the frame (so a ring cannot push art out of shot),
   * which is what a skeleton with more than four ideas in a beat needs: the old four-quadrant
   * remainder folded the fifth prop back onto the first, and the learner saw one object and was
   * remainder folded the fifth prop back onto the first, and the learner saw one object and was
   * shown two. The rings hold 16 off-centre spots before the pattern repeats, each at its own angle.
   */
  const framed = (box: Box, here: boolean | undefined, view: Box): Box => {
    if (!here) return box;
    const key = `${Math.round(view.x)},${Math.round(view.y)},${Math.round(view.w)},${Math.round(view.h)}`;
    if (key !== slotKey) {
      slotKey = key;
      slotN = 0;
    }
    const i = slotN++;
    // The rectangle a box's centre may occupy while the box stays inside the frame.
    const rx = Math.max(view.w - box.w, 0) / 2;
    const ry = Math.max(view.h - box.h, 0) / 2;
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    if (i === 0 || (rx === 0 && ry === 0)) {
      // One slot, or a box as big as the frame: there is nowhere honest to put a second one, so it
      // centres. Overlap here is geometry, not a bug in the layout.
      return { x: cx - box.w / 2, y: cy - box.h / 2, w: box.w, h: box.h };
    }
    const ring = 1 + (i - 1) % 4;
    const cycle = Math.floor((i - 1) / 4);
    const per = 8; // eight positions per ring: the diagonal corners and the four edge midpoints, both ways
    const step = (2 * Math.PI) / per;
    // Start off-axis so the first ring slot never shares an x or a y with the centre; each overflow
    // cycle rotates by half a step, which is not a multiple of the step until the pattern is exhausted.
    const a = step * (((i - 1) % per) + 0.5) + cycle * (step / 2);
    const f = ring / 4;
    return { x: cx + Math.cos(a) * rx * f - box.w / 2, y: cy + Math.sin(a) * ry * f - box.h / 2, w: box.w, h: box.h };
  };

  /**
   * Where a camera op lands, given the frame it starts from. `from` is a parameter rather than the
   * live cursor because a `here` placement has to ask this question about a move that has not been
   * compiled yet — and a chain of two moves in one beat only looks right if the second is resolved
   * from where the first lands.
   */
  const resolve = (op: CameraOp, from: Box = cursor): Box => {
    const targets: Box[] = [];
    if (op.target) {
      const ids = Array.isArray(op.target) ? op.target : [op.target];
      for (const id of ids) {
        const b = propBox(props, id) ?? sceneBox(props, id);
        if (b) targets.push(b);
      }
    }
    if (op.region) targets.push(op.region);
    let rect = targets.length ? unionBox(targets) : from;
    if (op.at && targets.length === 1) {
      // A close-up frames a part, not a bigger version of the whole: the point is given as a
      // fraction of the prop's own box because the director never knows where the artwork ends.
      const b = targets[0];
      const side = Math.max(b.w, b.h) * Math.min(1, Math.max(0.05, op.span ?? 0.45));
      rect = { x: b.x + b.w * frac(op.at.x) - side / 2, y: b.y + b.h * frac(op.at.y) - side / 2, w: side, h: side };
    } else if (op.mode === "focus" && targets.length === 1) rect = padded(targets[0], 1.5);
    if (op.mode === "pan" && op.dir) {
      const f = Math.min(4, Math.max(0.1, op.screens ?? 0.8));
      const dx = op.dir === "right" ? f : op.dir === "left" ? -f : 0;
      const dy = op.dir === "down" ? f : op.dir === "up" ? -f : 0;
      rect = { x: from.x + dx * from.w, y: from.y + dy * from.h, w: from.w, h: from.h };
    }
    if (op.mode === "pan" && op.center) {
      const c = op.center;
      rect = { x: c.x - from.w / 2, y: c.y - from.h / 2, w: from.w, h: from.h };
    }
    if (op.mode === "zoom" && op.zoom) {
      const c = centerOf(from);
      const w = VIEWPORT.w / Math.max(op.zoom, 0.01);
      rect = { x: c.x - w / 2, y: c.y - (w / (from.w / from.h)) / 2, w, h: w / (from.w / from.h) };
    }
    if (op.mode === "track" && op.follow) {
      const b = propBox(props, op.follow);
      if (b) rect = { ...from, x: centerOf(b).x - from.w / 2, y: centerOf(b).y - from.h / 2 };
    }
    if (op.mode === "fit") rect = padded(rect, 1.2);
    return limitPushIn(fitRect(rect, from.w / from.h), from.w / from.h);
  };

  /**
   * The frame a `here` prop should be placed in: whatever the camera will be looking at by the time
   * this beat is spoken, not wherever it stood when the beat's props were laid down.
   *
   * A skeleton says "pan one screen into the empty space, and put the new idea there" as one beat:
   * `stage_script` emits the placeholder first and the move after it, because the prop has to be on
   * the tape before the line that points at it. Placing by the *current* cursor then anchors the new
   * object in the space the cut is walking away from, and the audience watches a camera glide to an
   * empty frame. Only `pan`/`zoom` are looked ahead: they resolve purely from the frame, and a
   * `fit`/`focus` that names this very prop is resolved after it lands, which already frames it.
   */
  const placementView = (at: number): Box => {
    let view = cursor;
    for (let n = at + 1; n < entries.length; n++) {
      const next = entries[n].op;
      if (ownsTime(next)) break;
      if (next.kind === "camera" && (next.mode === "pan" || next.mode === "zoom")) view = resolve(next, view);
    }
    return view;
  };

  /**
   * Where a `here` placement lands for a prop the director says belongs on a board the show is not
   * standing on. The frame it is placed into is that board's ground, not the view under the camera
   * right now: naming a board and then anchoring the object in another board's coordinates stacks two
   * scenes on the same patch of plane, and the cut that follows then frames the pile.
   */
  const hereView = (at: number, scene: string | undefined): Box => {
    if (scene && standing && scene !== standing) return boardView(scene, cursor.w / cursor.h);
    return placementView(at);
  };

  const ensureProp = (id: string, scene: string): Prop => {
    let p = props.get(id);
    if (!p) {
      p = { id, scene, revisions: [], links: [] };
      props.set(id, p);
    }
    return p;
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const op = entry.op;
    lastSeq = entry.seq;
    const start = t;

    // A beat is a line plus whatever was staged to make it: props and camera land *before* the
    // line, so once a line is spoken the next op opens the following beat.
    const speaks = op.kind === "narrate" || op.kind === "beat";
    if (!cur || openNext) {
      if (cur) cur.end = start;
      cur = { turn: entry.turn, start, end: start, headline: "", verbs: [], seqs: [], gate: false };
      beats.push(cur);
    }
    cur.seqs.push(entry.seq);
    if (!cur.verbs.includes(op.kind)) cur.verbs.push(op.kind);
    if (!cur.headline) {
      if (op.kind === "narrate") cur.headline = op.text;
      else if (op.kind === "quiz") cur.headline = op.prompt;
      else if (op.kind === "pause-for") cur.headline = op.reason;
    }
    if (op.kind === "quiz" || op.kind === "pause-for") cur.gate = true;

    switch (op.kind) {
      case "build":
      case "patch": {
        const p = ensureProp(op.id, op.scene ?? (props.get(op.id)?.scene ?? (standing || "default")));
        // Naming a board moves an established prop onto it, exactly as `recall` does: the name is the
        // director saying where this object belongs now, and a prop left on the old board is invisible.
        if (op.scene) p.scene = op.scene;
        const prev = p.revisions[p.revisions.length - 1];
        const fillingPlaceholder = op.kind === "patch" && prev?.partial;
        const box = op.kind === "build" ? framed((op as BuildOp).box, (op as BuildOp).here, hereView(i, p.scene)) : op.box ?? prev?.box ?? { ...VIEWPORT };
        const revision: Revision = {
          t: fillingPlaceholder ? prev.t : start,
          scene: p.scene,
          box,
          svg: op.svg ?? (op.kind === "patch" ? prev?.svg : undefined),
          html: op.html ?? (op.kind === "patch" ? prev?.html : undefined),
          css: op.css ?? (op.kind === "patch" ? prev?.css : undefined),
          scene3d: op.scene3d ?? (op.kind === "patch" ? prev?.scene3d : undefined),
          label: op.label ?? prev?.label ?? op.id,
          note: op.kind === "build" ? op.note : prev?.note,
          partial: !(op.svg || op.html || op.scene3d),
        };
        if (fillingPlaceholder) p.revisions[p.revisions.length - 1] = revision;
        else p.revisions.push(revision);
        p.discardedAt = undefined;
        break;
      }
      case "recall": {
        const src = props.get(op.id);
        if (!src || src.revisions.length === 0) break;
        const prev = src.revisions[src.revisions.length - 1];
        src.scene = op.scene || standing || "default";
        src.revisions.push({ ...prev, t: start, scene: src.scene, box: framed((op as RecallOp).box, (op as RecallOp).here, hereView(i, src.scene)) });
        src.discardedAt = undefined;
        break;
      }
      case "discard": {
        const p = props.get(op.id);
        if (p) p.discardedAt = start;
        break;
      }
      case "link": {
        ensureProp(op.from, props.get(op.from)?.scene ?? "default").links.push({
          to: op.to,
          relation: op.relation,
        });
        break;
      }
      case "camera": {
        const to = resolve(op);
        cues.push({ t: start, end: start + cueMs(op), op, from: cursor, to });
        cursor = to;
        break;
      }
      case "transition":
      case "narrate":
      case "highlight":
      case "motion": {
        cues.push({ t: start, end: start + cueMs(op), op, from: cursor, to: cursor });
        if (op.kind === "transition") {
          // Reserve the ground before anything is looked for on it, so a board cut to twice keeps the
          // same place and `recall`ing onto it is not relative to where the camera last stood.
          standing = op.to;
          const to = boardView(op.to, cursor.w / cursor.h);
          cues[cues.length - 1].to = to;
          cursor = to;
        }
        break;
      }
      case "quiz":
      case "pause-for": {
        gates.push({ t: start, seq: entry.seq, kind: op.kind, op, said: null, until: start });
        break;
      }
      case "answer": {
        // A record, not a move: his words hold no clock, and the cut-tape rule still applies —
        // rewinding past a card takes his answer back with it, because this is the only place they exist.
        const asked = gates.find((g) => g.seq === op.gate);
        if (asked && asked.said === null) asked.said = op.text;
        break;
      }
      case "beat": {
        cues.push({ t: start, end: start + cueMs(op), op, from: cursor, to: cursor });
        break;
      }
    }
    if (ownsTime(op)) t = start + cueMs(op);
    cur.end = Math.max(cur.end, t);
    openNext = speaks;
  }

  // A card's window is the beat that asked it, now that the beats have been closed off. His answer is
  // shown inside it and nowhere after: a card answered at the top of a lesson must not still be
  // standing on the board two scenes later.
  for (const g of gates) {
    const asked = beats.find((b) => b.seqs.includes(g.seq));
    if (asked) g.until = asked.end;
  }

  const scenes = new Map<string, Box>();
  for (const p of props.values()) {
    const b = sceneBox(props, p.scene);
    if (b) scenes.set(p.scene, b);
  }

  // Overlays don't advance the clock, but the show isn't over while one is still running: a camera
  // glide or a motion cue emitted after the last line would otherwise be truncated at the tape end.
  const tails = cues.reduce((m, c) => Math.max(m, c.end), 0);

  return { props, scenes, cues, gates, beats, duration: Math.max(t, tails), lastSeq };
}
