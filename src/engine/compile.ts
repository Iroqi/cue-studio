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

export const VIEWPORT: Box = { x: 0, y: 0, w: 1600, h: 900 };

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

function propBox(props: Map<string, Prop>, id: string): Box | undefined {
  const p = props.get(id);
  if (!p || p.revisions.length === 0) return undefined;
  return p.revisions[p.revisions.length - 1].box;
}

function sceneBox(props: Map<string, Prop>, scene: string): Box | undefined {
  const boxes = [...props.values()]
    .filter((p) => p.scene === scene && p.discardedAt === undefined)
    .map((p) => p.revisions[p.revisions.length - 1]?.box)
    .filter((b): b is Box => !!b);
  return boxes.length ? unionBox(boxes) : undefined;
}

/** Narration, transitions and beats own the clock; camera moves, highlights and motion run on top of them. */
type TimeOwning = NarrateOp | TransitionOp | BeatOp;

function ownsTime(op: Op): op is TimeOwning {
  return op.kind === "narrate" || op.kind === "beat" || op.kind === "transition";
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
  let lastSeq = 0;
  let slotKey = "";
  let slotN = 0;

  /**
   * `here` is what happens when the director asks for an object but names no coordinates: it lands
   * inside the frame the camera is on, tiled so a second one does not sit exactly on the first.
   * Placing things by world numbers is the part of an unbounded plane a model reliably gets wrong,
   * and a prop outside the frame is a lesson the learner never sees.
   */
  const framed = (box: Box, here: boolean | undefined, view: Box): Box => {
    if (!here) return box;
    const key = `${Math.round(view.x)},${Math.round(view.y)},${Math.round(view.w)},${Math.round(view.h)}`;
    if (key !== slotKey) {
      slotKey = key;
      slotN = 0;
    }
    const i = slotN++ % 4;
    return {
      x: view.x + view.w * (i % 2 ? 0.66 : 0.34) - box.w / 2,
      y: view.y + view.h * (i < 2 ? 0.36 : 0.64) - box.h / 2,
      w: box.w,
      h: box.h,
    };
  };

  const resolve = (op: CameraOp): Box => {
    const targets: Box[] = [];
    if (op.target) {
      const ids = Array.isArray(op.target) ? op.target : [op.target];
      for (const id of ids) {
        const b = propBox(props, id) ?? sceneBox(props, id);
        if (b) targets.push(b);
      }
    }
    if (op.region) targets.push(op.region);
    let rect = targets.length ? unionBox(targets) : cursor;
    if (op.at && targets.length === 1) {
      // A close-up frames a part, not a bigger version of the whole: the point is given as a
      // fraction of the prop's own box because the director never knows where the artwork ends.
      const b = targets[0];
      const side = Math.max(b.w, b.h) * Math.min(1, Math.max(0.05, op.span ?? 0.35));
      rect = { x: b.x + b.w * frac(op.at.x) - side / 2, y: b.y + b.h * frac(op.at.y) - side / 2, w: side, h: side };
    } else if (op.mode === "focus" && targets.length === 1) rect = padded(targets[0], 1.5);
    if (op.mode === "pan" && op.dir) {
      const f = Math.min(4, Math.max(0.1, op.screens ?? 0.8));
      const dx = op.dir === "right" ? f : op.dir === "left" ? -f : 0;
      const dy = op.dir === "down" ? f : op.dir === "up" ? -f : 0;
      rect = { x: cursor.x + dx * cursor.w, y: cursor.y + dy * cursor.h, w: cursor.w, h: cursor.h };
    }
    if (op.mode === "pan" && op.center) {
      const c = op.center;
      rect = { x: c.x - cursor.w / 2, y: c.y - cursor.h / 2, w: cursor.w, h: cursor.h };
    }
    if (op.mode === "zoom" && op.zoom) {
      const c = centerOf(cursor);
      const w = VIEWPORT.w / op.zoom;
      rect = { x: c.x - w / 2, y: c.y - (w / (cursor.w / cursor.h)) / 2, w, h: w / (cursor.w / cursor.h) };
    }
    if (op.mode === "track" && op.follow) {
      const b = propBox(props, op.follow);
      if (b) rect = { ...cursor, x: centerOf(b).x - cursor.w / 2, y: centerOf(b).y - cursor.h / 2 };
    }
    if (op.mode === "fit") rect = padded(rect, 1.2);
    return fitRect(rect, cursor.w / cursor.h);
  };

  const ensureProp = (id: string, scene: string): Prop => {
    let p = props.get(id);
    if (!p) {
      p = { id, scene, revisions: [], links: [] };
      props.set(id, p);
    }
    return p;
  };

  for (const entry of entries) {
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
        const p = ensureProp(op.id, op.scene ?? (props.get(op.id)?.scene ?? "default"));
        const prev = p.revisions[p.revisions.length - 1];
        const fillingPlaceholder = op.kind === "patch" && prev?.partial;
        const box = op.kind === "build" ? framed((op as BuildOp).box, (op as BuildOp).here, cursor) : op.box ?? prev?.box ?? { ...VIEWPORT };
        const revision: Revision = {
          t: fillingPlaceholder ? prev.t : start,
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
        src.scene = op.scene;
        src.revisions.push({ ...prev, t: start, box: framed((op as RecallOp).box, (op as RecallOp).here, cursor) });
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
        cues.push({ t: start, end: start + Math.max(op.duration, 1), op, from: cursor, to });
        cursor = to;
        break;
      }
      case "transition":
      case "narrate":
      case "highlight":
      case "motion": {
        cues.push({ t: start, end: start + Math.max(op.duration, 1), op, from: cursor, to: cursor });
        if (op.kind === "transition") {
          const b = sceneBox(props, op.to);
          if (b) {
            const to = fitRect(padded(b, 1.2), cursor.w / cursor.h);
            cues[cues.length - 1].to = to;
            cursor = to;
          }
        }
        break;
      }
      case "quiz":
      case "pause-for": {
        gates.push({ t: start, seq: entry.seq, kind: op.kind, op });
        break;
      }
      case "beat": {
        cues.push({ t: start, end: start + Math.max(op.duration, 1), op, from: cursor, to: cursor });
        break;
      }
    }
    if (ownsTime(op)) t = start + Math.max(op.duration, 1);
    cur.end = Math.max(cur.end, t);
    openNext = speaks;
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
