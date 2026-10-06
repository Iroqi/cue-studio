import type { Box, MotionOp } from "./types";

const RAMP = 140;

function along(v: number, axis: MotionOp["axis"]): { dx: number; dy: number } {
  if (axis === "x") return { dx: v, dy: 0 };
  if (axis === "y") return { dx: 0, dy: v };
  return { dx: v * Math.SQRT1_2, dy: v * Math.SQRT1_2 };
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Displacement `el` ms into the cue. Every mode lands back on the anchor when it finishes, so the
 * log describes one stable position for a prop and the motion is only ever an interpretation of it.
 */
export function motionOffset(op: MotionOp, el: number): { dx: number; dy: number } {
  const dur = Math.max(op.duration, 1);
  if (el < 0 || el > dur) return { dx: 0, dy: 0 };
  const out = clamp01((dur - el) / RAMP);
  const inn = clamp01(el / RAMP);
  const wave = (2 * Math.PI * el) / Math.max(op.period, 60);
  switch (op.mode) {
    case "oscillate":
      return along(op.amp * Math.sin(wave) * Math.min(inn, out), op.axis);
    case "approach":
      return along(op.amp * Math.exp(-el / Math.max(op.decay, 200)) * out, op.axis);
    case "orbit": {
      const r = op.radius > 0 ? op.radius : Math.max(op.amp, 40) * Math.SQRT1_2;
      const a = wave - Math.PI / 2;
      const k = Math.min(inn, out);
      return { dx: r * Math.cos(a) * k, dy: r * Math.sin(a) * k };
    }
    case "iterate": {
      // A strobe: hop across `steps` slots and walk back. If the requested period doesn't fit the
      // cue, it is shortened so the round trip always completes before the prop goes home.
      const n = Math.max(2, Math.round(op.steps));
      const cycle = 2 * (n - 1);
      const per = Math.min(Math.max(op.period, 60), dur / cycle);
      const q = Math.floor(el / per) % cycle;
      const u = q < n ? q / (n - 1) : (cycle - q) / (n - 1);
      return along(op.amp * u * out, op.axis);
    }
    case "flow":
      return along(op.amp * Math.sin(wave) * Math.sin((Math.PI * el) / dur), op.axis);
  }
}

export function displaced(b: Box, d: { dx: number; dy: number }): Box {
  return d.dx === 0 && d.dy === 0 ? b : { ...b, x: b.x + d.dx, y: b.y + d.dy };
}
