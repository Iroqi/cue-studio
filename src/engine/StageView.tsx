import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import DOMPurify from "dompurify";
import katex from "katex";
import type { Stage, VisibleProp } from "./runtime";
import { Scene3D } from "./Scene3D";

/**
 * Model markup is inert by construction — but the old construction was a regex that stripped tags and
 * `on*` attributes, which is the one wheel in this whole area that people stopped hand-rolling, because
 * a second parse gets around it (mutation XSS). The input is not only the painter: a `#s=` share link
 * hands this renderer arbitrary op payloads from whoever sent the URL, so this is a trust boundary.
 *
 * The defaults already allow the parts a teaching drawing is made of — path, rect, text, gradients,
 * markers, `foreignObject` excepted (see below). MathML is closed off — the stage typesets `.tex` itself with KaTeX, and
 * `annotation-xml` is the classic doorway back into HTML parsing. Links and form controls are closed:
 * a prop is a picture, nothing on this board should navigate.
 *
 * One default to know about: `foreignObject` is on DOMPurify's svg-disallowed list, so a model-authored
 * window is dropped *with its contents* — the painters' contract is `<text class="tex">`, and the window
 * is opened here, after sanitizing, by `hydrateMath`. That is why the prompt never asks for a window.
 */
const MARKUP = {
  FORBID_TAGS: [
    "math", "semantics", "annotation-xml", "mrow", "mi", "mo", "mn", "ms", "mtext", "mspace",
    "template", "noscript", "iframe", "frame", "object", "embed", "form", "input", "button", "select", "textarea", "a",
  ],
  FORBID_ATTR: ["formaction", "ping", "srcdoc", "srcset", "action", "target"],
  ALLOW_DATA_ATTR: false,
};

function sanitizeMarkup(markup: string): string {
  return DOMPurify.sanitize(markup, MARKUP);
}

/**
 * Prop CSS is dropped inside a `<style>` element, where a literal `</style>` is an escape hatch rather
 * than a syntax error. Tags out, text kept: the rule set survives, the breakout does not.
 */
function sanitizeCss(css: string): string {
  return DOMPurify.sanitize(css, { ALLOWED_TAGS: [], ALLOWED_ATTR: [], KEEP_CONTENT: true });
}

/** The drawing's own canvas, the way painters address it: viewBox first, width/height if there is none. */
function viewBoxOf(svg: Element): { x: number; y: number; w: number; h: number } | null {
  const vb = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every((n) => Number.isFinite(n)) && vb[2] > 0 && vb[3] > 0) {
    return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  }
  const w = parseFloat(svg.getAttribute("width") ?? "");
  const h = parseFloat(svg.getAttribute("height") ?? "");
  return w > 0 && h > 0 ? { x: 0, y: 0, w, h } : null;
}

/**
 * A backdrop is whatever the drawing paints *first*, sitting under the whole artboard. Painters keep
 * bringing one along (the prompt says not to, models do it anyway), and a second board inside the board
 * is exactly what makes a prop look pasted on rather than drawn on the stage.
 */
function firstPainted(root: Element): Element | null {
  for (const el of Array.from(root.children)) {
    const tag = el.tagName.toLowerCase();
    if (["defs", "style", "title", "desc", "clippath", "mask", "marker", "lineargradient", "radialgradient", "filter", "symbol", "metadata"].includes(tag)) continue;
    if (tag === "g") {
      const inner = firstPainted(el);
      if (inner) return inner;
      continue;
    }
    return el;
  }
  return null;
}

/** Reads `width="100%"` as the whole canvas — the idiom that used to slip straight past the scrub. */
function length(el: Element, name: string, total: number, dflt: number): number {
  const raw = (el.getAttribute(name) ?? "").trim();
  if (!raw) return dflt;
  const v = raw.endsWith("%") ? (parseFloat(raw) / 100) * total : parseFloat(raw);
  return Number.isFinite(v) ? v : dflt;
}

function isBackdrop(el: Element, w: number, h: number): boolean {
  if (el.tagName.toLowerCase() !== "rect") return false;
  const fill = (el.getAttribute("fill") ?? "#000").trim().toLowerCase();
  if (fill === "none" || /url\(/.test(fill)) return false;
  if ((el.getAttribute("stroke") ?? "").trim()) return false;
  const alpha = length(el, "opacity", 1, 1) * length(el, "fill-opacity", 1, 1);
  if (alpha < 0.12) return false;
  const rw = length(el, "width", w, 0);
  const rh = length(el, "height", h, 0);
  const x = length(el, "x", w, 0);
  const y = length(el, "y", h, 0);
  if (!(rw >= w * 0.9 && rh >= h * 0.9)) return false;
  return Math.abs(x) <= w * 0.02 && Math.abs(y) <= h * 0.02;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Painters open a `<foreignObject>` window to hold a `.tex` formula, but DOMPurify forbids the tag and
 * takes the formula down with it — and old tapes and share links are full of that window. So rewrite
 * each `.tex` window to a `<text class="tex">` before sanitizing: the sanitizer keeps `<text>`, and
 * `hydrateMath` opens the window back up afterward. The formula survives; the raw HTML never does.
 */
function rewriteMathWindows(markup: string): string {
  if (!markup.toLowerCase().includes("foreignobject")) return markup;
  // Parsed as HTML on purpose: that is the parser the consumer will use, and unlike XML it never fails
  // to parse, so markup that isn't well-formed can't blank the whole drawing here.
  const doc = new DOMParser().parseFromString(markup, "text/html");
  const windows = Array.from(doc.body.querySelectorAll("foreignobject"));
  if (windows.length === 0) return markup;
  for (const fo of windows) {
    const tex = fo.querySelector(".tex");
    const raw = (tex?.textContent ?? "").trim();
    if (!tex || !raw) continue;
    const style = tex.getAttribute("style") ?? "";
    const declared = parseFloat(tex.getAttribute("font-size") ?? "") || parseFloat(style.match(/font-size:\s*([^;]+)/)?.[1] ?? "");
    const size = declared || (parseFloat(fo.getAttribute("height") ?? "") || 96) / 2.4;
    const text = doc.createElementNS(SVG_NS, "text");
    text.setAttribute("class", "tex");
    text.setAttribute("x", fo.getAttribute("x") ?? "0");
    // A window's y is its top, a <text>'s y is its baseline, and `hydrateMath` subtracts one font-size
    // from that — so hand it the baseline that lands the formula where the painter put the window.
    text.setAttribute("y", String(Math.round((parseFloat(fo.getAttribute("y") ?? "") || 0) + size)));
    for (const a of ["width", "height"] as const) {
      const v = fo.getAttribute(a);
      if (v) text.setAttribute(a, v);
    }
    text.setAttribute("font-size", String(Math.round(size)));
    text.setAttribute("fill", style.match(/(?:^|;)\s*color:\s*([^;]+)/)?.[1].trim() || tex.getAttribute("fill") || "#e8e6f0");
    text.textContent = raw;
    fo.replaceWith(text);
  }
  return doc.body.innerHTML;
}

/**
 * LaTeX → MathML, and nothing else: Chrome lays MathML out on its own, so no KaTeX stylesheet and no
 * font files come along. That keeps the formula inside the picture's own scaling — a close-up enlarges
 * it exactly like a stroke.
 *
 * A half-typed formula is the normal state while the tape streams, so a parse failure leaves the source
 * sitting there in the drawing colour. KaTeX's own error rendering is magenta, which would flash
 * "something broke" at the learner every few characters over something that finishes a moment later.
 */
function typeset(host: Element, tex: string) {
  let out: string;
  try {
    out = katex.renderToString(tex, { output: "mathml", displayMode: true, throwOnError: true, strict: "ignore" });
  } catch {
    host.textContent = tex;
    return;
  }
  // An unsupported macro does not throw: KaTeX hands back red error markup, which would put a magenta
  // smudge on the board. Same deal as a half-typed formula — show the source in the drawing colour.
  if (/#cc0000|katex-error/.test(out)) {
    host.textContent = tex;
    return;
  }
  host.innerHTML = out;
}

/**
 * `class="tex"` anywhere in a prop's markup becomes a real formula. `<text class="tex">` is the slip we
 * expect from a model (right idea, wrong element), so it gets cut a window instead of raw backslashes.
 */
function hydrateMath(root: ShadowRoot) {
  for (const el of Array.from(root.querySelectorAll(".tex"))) {
    const tex = (el.textContent ?? "").trim();
    if (!tex) continue;
    if (el.namespaceURI !== SVG_NS) {
      typeset(el, tex);
      continue;
    }
    const size = parseFloat(el.getAttribute("font-size") ?? "") || 40;
    const isText = el.tagName === "text";
    const y = parseFloat(el.getAttribute("y") ?? "") || size;
    const declaredW = el.getAttribute("width");
    const fo = document.createElementNS(SVG_NS, "foreignObject");
    fo.setAttribute("x", el.getAttribute("x") || "0");
    // A <text>'s y is its baseline; a window's y is its top.
    fo.setAttribute("y", String(y - (isText ? size : 0)));
    fo.setAttribute("width", declaredW || String(Math.round(size * 2)));
    fo.setAttribute("height", el.getAttribute("height") || String(Math.round(size * 2.4)));
    const div = document.createElement("div");
    // A window the painter sized is the region the formula centers in, and a display-mode formula is
    // laid out against that width — so keep it. With no width the point *is* the anchor: inline-block
    // makes the box hug the ink, which then sits at x instead of drifting to the middle of a guessed
    // width (the old guess counted `\begin{pmatrix}` as thirteen characters and shoved a law of physics
    // a thousand units off the frame it was drawn on).
    div.setAttribute(
      "style",
      `${declaredW ? "" : "display:inline-block;"}font-size:${size}px;color:${el.getAttribute("fill") || "#e8e6f0"};white-space:nowrap`,
    );
    fo.appendChild(div);
    el.replaceWith(fo);
    typeset(div, tex);
    if (!declaredW && div.offsetWidth) {
      fo.setAttribute("width", String(Math.ceil(div.offsetWidth)));
      fo.setAttribute("height", String(Math.ceil(div.offsetHeight || size * 2.4)));
    }
  }
}

function PropView({ p, t }: { p: VisibleProp; t: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const signature = `${p.svg}|${p.html}|${p.css}`;

  useLayoutEffect(() => {
    const el = ref.current;
    // A 3-D prop paints itself through Scene3D; the shadow-root path only draws flat markup.
    if (!el || p.scene3d) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    // An empty frame paints nothing: the outline below is the only mark it gets, and only while a
    // paint is actually in flight for it.
    root.innerHTML =
      `<style>:host{display:block;width:100%;height:100%;overflow:visible}` +
      // The board behind this frame is the only background the drawing gets to have.
      `svg{display:block;width:100%;height:100%}:host>svg{background:none!important}` +
      // A window the painter sized too short must still not cut the formula in half.
      `foreignObject{overflow:visible}.tex{line-height:1.25}` +
      sanitizeCss(p.css ?? "") +
      `</style>` +
      sanitizeMarkup(rewriteMathWindows(p.svg ?? p.html ?? ""));
    const svg = root.querySelector("svg");
    if (svg && p.svg) {
      const box = viewBoxOf(svg) ?? { x: 0, y: 0, w: Math.round(p.box.w), h: Math.round(p.box.h) };
      const bg = firstPainted(svg);
      if (bg && isBackdrop(bg, box.w, box.h)) bg.remove();
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      // One magnification for the whole board: `meet` on a mismatched aspect shrinks the *drawing*
      // instead of the margins, so every prop got its own scale and two neighbours never lined up.
      // Padding the viewBox out to the box's aspect hands the spare room to the margins instead, and
      // keeps 1 viewBox unit = 1 world unit — art that sits on the stage rather than on a card.
      const want = p.box.w / p.box.h;
      let { x, y, w, h } = box;
      if (Number.isFinite(want) && want > 0 && h > 0) {
        if (w / h < want) {
          const nw = h * want;
          x -= (nw - w) / 2;
          w = nw;
        } else if (w / h > want) {
          const nh = w / want;
          y -= (nh - h) / 2;
          h = nh;
        }
      }
      svg.setAttribute("viewBox", `${Math.round(x)} ${Math.round(y)} ${Math.max(1, Math.round(w))} ${Math.max(1, Math.round(h))}`);
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }
    hydrateMath(root);
  }, [signature, p.svg, p.html, p.css, p.box.w, p.box.h, p.scene3d]);

  const style = { position: "absolute" as const, left: p.box.x, top: p.box.y, width: p.box.w, height: p.box.h };

  if (p.scene3d) {
    const cls = ["prop", "prop3d", p.highlight && `hl-${p.highlight}`].filter(Boolean).join(" ");
    return (
      <div className={cls} data-prop={p.id} style={style}>
        <Scene3D spec={p.scene3d} t={t} />
      </div>
    );
  }

  const cls = ["prop", p.awaiting && "draft", p.highlight && `hl-${p.highlight}`].filter(Boolean).join(" ");
  return <div ref={ref} className={cls} data-prop={p.id} style={style} />;
}

function veilOpacity(progress: number): number {
  return progress < 0.5 ? progress * 2 : (1 - progress) * 2;
}

/**
 * The rows the stage shows, already laid out at their final size. The clock only uncovers them: a
 * line that grows glyph by glyph inside a centred box drags every glyph before it sideways, and the
 * reader's eye has to chase it. So the tail is present and invisible — nothing reflows mid-verse.
 */
function verseRows(text: string, progress: number): { said: string; unsaid: string }[] {
  const shown = Math.round(text.length * progress);
  const rows: { said: string; unsaid: string }[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const cut = Math.max(0, Math.min(line.length, shown - at));
    if (line.trim()) rows.push({ said: line.slice(0, cut), unsaid: line.slice(cut) });
    at += line.length + 1;
  }
  return rows;
}

export function StageView({ stage, bottomInset = 0 }: { stage: Stage; bottomInset?: number }) {
  const s = useSyncExternalStore(stage.subscribe, stage.getSnapshot);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 1600, h: 900 });

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const rect = s.rect;
  // The dock is not a lid: whatever the camera frames has to be above it, so the world is fitted into
  // the board minus the band the composer stands in. Measure the dock and hand it the number.
  const usable = { w: size.w, h: Math.max(40, size.h - bottomInset) };
  const scale = Math.min(usable.w / rect.w, usable.h / rect.h);
  const ox = (usable.w - rect.w * scale) / 2 - rect.x * scale;
  const oy = (usable.h - rect.h * scale) / 2 - rect.y * scale;
  const three = s.props.filter((p) => p.scene3d).length;
  const drag = s.props.some((p) => p.scene3d?.interactive);

  return (
    <div className="stage" data-track={s.track} ref={hostRef}>
      <div className="world" style={{ transform: `translate(${ox}px, ${oy}px) scale(${scale})` }}>
        {s.props.map((p) => (
          <PropView key={p.id} p={p} t={s.t} />
        ))}
      </div>
      {s.veil && <div className={`veil veil-${s.veil.style}`} style={{ opacity: veilOpacity(s.veil.progress) }} />}
      {s.narration && s.narration.style === "verse" && (
        <div className="narration verse">
          {verseRows(s.narration.text, s.narration.reveal).map((row, i) => (
            <span key={i}>
              {row.said}
              <em className="unsaid">{row.unsaid}</em>
            </span>
          ))}
        </div>
      )}
      {s.narration && s.narration.style !== "verse" && s.narration.style !== "voice" && (
        <div className="narration">
          <span>
            {s.narration.text.slice(0, Math.max(1, Math.round(s.narration.text.length * s.narration.reveal)))}
            <i className="caret" />
            <em className="unsaid">{s.narration.text.slice(Math.max(1, Math.round(s.narration.text.length * s.narration.reveal)))}</em>
          </span>
        </div>
      )}
      <div className="telemetry">
        {s.props.length} props{three ? ` · ${three} 3D${drag ? "（可拖动·转动不进分享）" : ""}` : ""} · t={Math.round(s.t)}ms
        {s.track === "main" ? "" : ` · ${s.track}`}
        {s.artWait ? ` · 时钟等美工（欠 ${s.artOwed} 格）` : ""}
      </div>
    </div>
  );
}
