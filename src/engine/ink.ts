import type { Box } from "./types";

/**
 * What a prop's artwork actually paints, in world units — as opposed to the rectangle the director
 * declared for it.
 *
 * The camera used to aim at the declared rectangle, so a drawing that hugged one corner of its own
 * canvas sat a fifth of a frame off centre while the mathematics said it was perfectly framed. The
 * declared box is the frame the art is *allowed* to fill; the ink is what the learner sees. Only the
 * second one can be pointed at.
 *
 * This is a pure function of the markup on the tape, so a replayed or shared lesson frames the same
 * way it did live. Measuring the rendered DOM instead would be exact but order-dependent, and the
 * clock is not allowed to depend on what has been painted to screen yet.
 */

function nums(s: string | null): number[] {
  if (!s) return [];
  return (s.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number).filter((n) => Number.isFinite(n));
}

/** The author's canvas. Absent or degenerate, and we know nothing about where the ink is. */
function viewBoxOf(svg: Element): Box | null {
  // Read through `nums`, not a capture-group regex: `match` hands back the whole match as its first
  // element, and a shift-by-one there reads the canvas as zero wide — which is the same as knowing
  // nothing, so every drawing silently kept framing itself by the declared box instead of the ink.
  const v = nums(svg.getAttribute("viewBox"));
  if (v.length >= 4 && v[2] > 0 && v[3] > 0) return { x: v[0], y: v[1], w: v[2], h: v[3] };
  // Without a viewBox the canvas is only as big as its own units say — and a percentage is not a unit.
  const raw = (n: string) => (/%/.test(svg.getAttribute(n) ?? "") ? NaN : nums(svg.getAttribute(n))[0]);
  const w = raw("width");
  const h = raw("height");
  return w > 0 && h > 0 ? { x: 0, y: 0, w, h } : null;
}

/**
 * The two affine transforms a model actually writes. Anything else (rotate, skew) moves ink to a place
 * this scan cannot predict, so the caller is told the estimate is not trustworthy rather than handed a
 * confident wrong box.
 */
type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };
const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

function apply(m: Affine, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

function parseTransform(raw: string | null): Affine | null {
  if (!raw) return IDENTITY;
  let m: Affine = IDENTITY;
  for (const fn of raw.match(/[a-zA-Z]+\([^)]*\)/g) ?? []) {
    const name = fn.slice(0, fn.indexOf("(")).toLowerCase();
    const p = nums(fn.slice(fn.indexOf("(") + 1, -1));
    if (name === "translate") {
      if (p.length < 1) return null;
      m = multiply(m, { a: 1, b: 0, c: 0, d: 1, e: p[0], f: p[1] ?? 0 });
    } else if (name === "scale") {
      if (p.length < 1) return null;
      m = multiply(m, { a: p[0], b: 0, c: 0, d: p[1] ?? p[0], e: 0, f: 0 });
    } else if (name === "matrix") {
      if (p.length < 6) return null;
      m = multiply(m, { a: p[0], b: p[1], c: p[2], d: p[3], e: p[4], f: p[5] });
    } else {
      return null;
    }
  }
  return m;
}

function declared(el: Element, name: string): string | null {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const attr = (n.getAttribute(name) ?? "").trim().toLowerCase();
    if (attr) return attr;
    const inline = (n.getAttribute("style") ?? "").toLowerCase().match(new RegExp(name + "\\s*:\\s*([^;]+)"));
    if (inline) return inline[1].trim();
  }
  return null;
}

/**
 * Ink only: a shape with nothing on it is invisible, and an invisible shape must not be pointed at.
 * SVG's own defaults are the floor here — fill black, stroke none — and the guess errs toward keeping
 * a shape: a false "painted" only loosens the frame, a false "unpainted" would crop the lesson.
 */
function invisible(el: Element): boolean {
  const opacity = declared(el, "opacity");
  if (opacity !== null && Number(opacity) === 0) return true;
  const fill = declared(el, "fill") ?? "black";
  const stroke = declared(el, "stroke") ?? "none";
  return fill === "none" && stroke === "none";
}

function hidden(el: Element): boolean {
  const style = (el.getAttribute("style") ?? "").toLowerCase();
  if (/display\s*:\s*none/.test(style) || /visibility\s*:\s*(hidden|collapse)/.test(style)) return true;
  const disp = (el.getAttribute("display") ?? "").trim().toLowerCase();
  return disp === "none";
}

class Extent {
  x1 = Infinity;
  y1 = Infinity;
  x2 = -Infinity;
  y2 = -Infinity;
  ok = true;

  point(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.x1 = Math.min(this.x1, x);
    this.y1 = Math.min(this.y1, y);
    this.x2 = Math.max(this.x2, x);
    this.y2 = Math.max(this.y2, y);
  }

  rect(x: number, y: number, w: number, h: number) {
    if (!(w > 0) || !(h > 0)) return;
    this.point(x, y);
    this.point(x + w, y + h);
  }

  get box(): Box | null {
    if (!Number.isFinite(this.x1)) return null;
    return { x: this.x1, y: this.y1, w: this.x2 - this.x1, h: this.y2 - this.y1 };
  }
}

/**
 * Endpoints of the path's segments — its control points are deliberately left out, since a handle can
 * sit far from anything the pen draws. A path this scan cannot follow marks the estimate as untrusted.
 */
const ARITY: Record<string, number> = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };

function walkPath(d: string, m: Affine, out: Extent): boolean {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return false;
  const isNum = (s: string) => /^[-+.]?\d/.test(s);
  let i = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const num = () => Number(tokens[i++]);
  const mark = (x: number, y: number) => {
    const [a, b] = apply(m, x, y);
    out.point(a, b);
  };
  while (i < tokens.length) {
    if (!isNum(tokens[i])) cmd = tokens[i++];
    if (!cmd) continue;
    const up = cmd.toUpperCase();
    const rel = cmd === cmd.toLowerCase();
    if (up === "Z") {
      cx = sx;
      cy = sy;
      mark(cx, cy);
      continue;
    }
    const arity = ARITY[up];
    if (!arity || !isNum(tokens[i])) return false;
    do {
      if (i + arity > tokens.length) return false;
      let nx = cx;
      let ny = cy;
      if (up === "H") nx = rel ? cx + num() : num();
      else if (up === "V") ny = rel ? cy + num() : num();
      else if (up === "A") {
        const rx = num();
        const ry = num();
        num();
        num();
        num();
        const ex = num();
        const ey = num();
        nx = rel ? cx + ex : ex;
        ny = rel ? cy + ey : ey;
        const [ax, ay] = apply(m, nx - rx, ny - ry);
        const [bx, by] = apply(m, nx + rx, ny + ry);
        out.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      } else {
        const args: number[] = [];
        for (let k = 0; k < arity; k++) args.push(num());
        nx = rel ? cx + args[arity - 2] : args[arity - 2];
        ny = rel ? cy + args[arity - 1] : args[arity - 1];
      }
      cx = nx;
      cy = ny;
      if (up === "M") {
        sx = cx;
        sy = cy;
      }
      mark(cx, cy);
    } while (i < tokens.length && isNum(tokens[i]));
    // A move followed by bare pairs is a polyline: the pen keeps drawing, and a repeated M would
    // otherwise be read as a fresh subpath whose start we already have.
    if (up === "M") cmd = rel ? "l" : "L";
  }
  return true;
}

function scan(el: Element, m: Affine, out: Extent) {
  const tag = el.tagName.toLowerCase();
  if (["defs", "title", "desc", "metadata", "style", "script", "clippath", "mask", "lineargradient", "radialgradient", "symbol", "pattern", "tspan", "textpath"].includes(tag)) return;
  if (hidden(el)) return;
  const local = parseTransform(el.getAttribute("transform"));
  if (!local) {
    out.ok = false;
    return;
  }
  const t = multiply(m, local);
  const num = (name: string, dflt = 0) => {
    const v = nums(el.getAttribute(name))[0];
    return v === undefined ? dflt : v;
  };
  const pt = (x: number, y: number) => {
    const [a, b] = apply(t, x, y);
    out.point(a, b);
  };
  const box = (x: number, y: number, w: number, h: number) => {
    const [ax, ay] = apply(t, x, y);
    const [bx, by] = apply(t, x + w, y + h);
    out.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
  };

  // A container that carries no paint still has children that do; only shapes are tested.
  if (!["svg", "g", "a", "switch"].includes(tag) && invisible(el)) return;

  if (tag === "rect") box(num("x"), num("y"), num("width"), num("height"));
  else if (tag === "circle") {
    const r = num("r");
    box(num("cx") - r, num("cy") - r, 2 * r, 2 * r);
  } else if (tag === "ellipse") {
    const rx = num("rx");
    const ry = num("ry");
    box(num("cx") - rx, num("cy") - ry, 2 * rx, 2 * ry);
  } else if (tag === "line") {
    pt(num("x1"), num("y1"));
    pt(num("x2"), num("y2"));
  } else if (tag === "polyline" || tag === "polygon") {
    const p = nums(el.getAttribute("points"));
    for (let i = 0; i + 1 < p.length; i += 2) pt(p[i], p[i + 1]);
  } else if (tag === "path") {
    if (!walkPath(el.getAttribute("d") ?? "", t, out)) out.ok = false;
  } else if (tag === "image" || tag === "foreignobject") box(num("x"), num("y"), num("width"), num("height"));
  else if (tag === "text") {
    const size = nums(el.getAttribute("font-size"))[0] ?? (parseFloat((el.getAttribute("style") ?? "").match(/font-size\s*:\s*(\d+(\.\d+)?)/)?.[1] ?? "") || 16);
    const chars = (el.textContent ?? "").replace(/\s+/g, " ").trim().length;
    const w = Math.max(size, chars * size * 0.55);
    const anchor = (el.getAttribute("text-anchor") ?? "start").trim();
    const x = num("x") - (anchor === "middle" ? w / 2 : anchor === "end" ? w : 0);
    // `y` is the baseline: the ink sits above it and drops a little below for descenders.
    box(x, num("y") - size, w, size * 1.3);
  } else if (tag === "use") {
    // A `<use>` clones geometry that lives in defs; where it lands is knowable, how big is not.
    out.ok = false;
    return;
  }
  for (const child of Array.from(el.children)) scan(child, t, out);
}

/** The author's canvas plus the ink inside it, both in viewBox units. */
export type Measure = { vb: Box; ink: Box } | null;

/*
 * 一份"量过的墨"的账。
 *
 * 以前它到 160 条就**整份抹掉**。带子只增不改，而 `compile` 每落一笔把整卷重排一遍，于是量过的墨每
 * 一批都要重量 —— 只要这堂课画得比 160 格多，那一抹就把全部已知的墨一起带走，下一遍从头再解析一次。
 *
 * 数的是**解析次数**（把 `DOMParser.parseFromString` 包一层计数器），毫秒只作对照。同一支探针在改前的
 * 代码上量同一批带子（每格一段互不相同的真标记；只交 `html` 的带子不过这个门，同规模一直是 1ms 量级）：
 * 81 格那卷 首遍 81 / 再排一遍 0 —— 还没到那道 160，旧写法看起来没问题。151 格：首遍 231，也就是**一
 * 遍之内就自己抹了自己一次**。201 格：首遍 402、再排仍然 402、1494ms。401 格：802 / 802 / 5133ms。
 * 于是带子一旦长过那道 160，每一遍都要把全部已知重解析一遍 —— 导演落一笔付一秒半，而这笔钱随课上画的
 * 格数长，它恰好是"一堂好课"的形状。改后同一批带子：首遍正好 props 次，其后每遍 0，墙钟 0.9 → 4.0ms
 * 线性。`ink.test.ts` 末尾那一节把这几个数和退出的次序一起钉住。
 *
 * 换成有界的 LRU：命中就把它挪到最新那一头，越界从最久没人问的那一头**一条条**退。边界有两道 —— 条数
 * 和 keyed 标记的总字数。后者才是真的那道，因为这一份账多花的只是引用（字面量本来就在带子上）加一个
 * 几百字节的量出来的框；它真正防的是剪带之后：`cutFrom` 把带子剪断重排，那些画已经从带子上掉了，缓存
 * 还在替它们握着字符串。一条比整份预算还长的画不进这一份账（存进去就是当场全部退出，不如不存）。
 *
 * 两个边界和这道类一起导出：退出的价钱要在**小预算**上钉（真要灌 4096 条各不相同的画，光是解析就要
 * 十几秒，那一头量的是浏览器不是这一件），而小预算上"谁被挤出去、谁留在账上"才是这一件要说的那句话。
 */
export const MAX_ENTRIES = 4096;
export const MAX_CHARS = 8_000_000;

export class InkCache {
  private readonly map = new Map<string, Measure>();
  private chars = 0;
  private readonly maxEntries: number;
  private readonly maxChars: number;

  constructor(maxEntries: number, maxChars: number) {
    this.maxEntries = maxEntries;
    this.maxChars = maxChars;
  }

  /** 量一遍并记账。`inkBox` 走的就是这一条，只是它用的是那道默认的预算。 */
  measure(markup: string): Measure {
    const hit = this.get(markup);
    if (hit !== undefined) return hit;
    const out = readInk(markup);
    this.set(markup, out);
    return out;
  }

  /** 命中过的就变成最新的一条；`null`（量不出墨）也算命中 —— 读不懂的画每批重解析一遍是最冤枉的那笔钱。 */
  get(markup: string): Measure | undefined {
    const hit = this.map.get(markup);
    if (hit === undefined) return undefined;
    this.map.delete(markup);
    this.map.set(markup, hit);
    return hit;
  }

  set(markup: string, out: Measure): void {
    if (markup.length > this.maxChars) return;
    if (!this.map.has(markup)) this.chars += markup.length;
    this.map.set(markup, out);
    while (this.map.size > this.maxEntries || this.chars > this.maxChars) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.chars -= oldest.value.length;
      this.map.delete(oldest.value);
    }
  }

  /** 账上现在握着多少条、多少字。给对账那一头问"越界之后还剩几格"。 */
  get size(): number {
    return this.map.size;
  }

  get held(): number {
    return this.chars;
  }
}

const inkCache = new InkCache(MAX_ENTRIES, MAX_CHARS);

function readInk(markup: string): Measure {
  let out: Measure = null;
  try {
    const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
    const svg = doc.querySelector("svg");
    const vb = svg ? viewBoxOf(svg) : null;
    if (vb && svg) {
      const e = new Extent();
      scan(svg, IDENTITY, e);
      const found = e.ok ? e.box : null;
      if (found && found.w > 0 && found.h > 0) out = { vb, ink: found };
    }
  } catch {
    out = null;
  }
  return out;
}

/**
 * PropView lays art out by padding the viewBox symmetrically to the prop's aspect and meeting it, so
 * the centre of the author's canvas is the centre of the declared box, and one scale runs both ways.
 * The same mapping here is what keeps the frame on the ink instead of on the margin.
 */
export function inkBox(markup: string | undefined, world: Box): Box | undefined {
  if (!markup || !(world.w > 0) || !(world.h > 0)) return undefined;
  const found = inkCache.measure(markup);
  if (!found) return undefined;
  const { vb, ink } = found;
  const want = world.w / world.h;
  let { x, y, w, h } = vb;
  if (w / h < want) {
    const nw = h * want;
    x -= (nw - w) / 2;
    w = nw;
  } else if (w / h > want) {
    const nh = w / want;
    y -= (nh - h) / 2;
    h = nh;
  }
  const k = world.w / w;
  return {
    x: world.x + world.w / 2 + (ink.x - (x + w / 2)) * k,
    y: world.y + world.h / 2 + (ink.y - (y + h / 2)) * k,
    w: Math.max(ink.w * k, 1),
    h: Math.max(ink.h * k, 1),
  };
}
