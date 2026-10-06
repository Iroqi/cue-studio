import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Stage, VisibleProp } from "./runtime";
import { Scene3D } from "./Scene3D";

/** Model-authored markup is inert by construction: shadow DOM scope, scripts stripped, no inline handlers. */
export function sanitize(markup: string): string {
  return markup
    .replace(/<\/?(script|iframe|object|embed|link|meta)[^>]*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed|link|meta)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "");
}

/** Opaque and covering the whole artboard: that is the painter filling in the canvas we already have. */
function isFullBleedRect(el: Element, svg: Element): boolean {
  const num = (name: string) => parseFloat(el.getAttribute(name) ?? "");
  // No fill attribute at all is SVG's default: black. That is the laziest way to paint a backdrop.
  const fill = (el.getAttribute("fill") ?? "#000").trim().toLowerCase();
  if (fill === "none" || /url\(/.test(fill)) return false;
  if ((el.getAttribute("opacity") ?? "1") !== "1" || (el.getAttribute("fill-opacity") ?? "1") !== "1") return false;
  if (el.getAttribute("stroke")) return false;
  const vb = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const [w, h] = vb.length === 4 ? [vb[2], vb[3]] : [parseFloat(svg.getAttribute("width") ?? ""), parseFloat(svg.getAttribute("height") ?? "")];
  if (!(w > 0 && h > 0)) return false;
  const x = num("x") || 0;
  const y = num("y") || 0;
  if (Math.abs(x) > w * 0.02 || Math.abs(y) > h * 0.02) return false;
  return num("width") >= w * 0.9 && num("height") >= h * 0.9;
}

function PropView({ p, t, pending }: { p: VisibleProp; t: number; pending: boolean }) {
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
      `svg{display:block;width:100%;height:100%}${sanitize(p.css ?? "")}</style>` +
      sanitize(p.svg ?? p.html ?? "");
    const svg = root.querySelector("svg");
    if (svg && p.svg) {
      const bg = svg.querySelector(":scope > rect[width][height]");
      if (bg && isFullBleedRect(bg, svg)) bg.remove();
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      if (!svg.getAttribute("viewBox")) svg.setAttribute("viewBox", `0 0 ${Math.round(p.box.w)} ${Math.round(p.box.h)}`);
      if (!svg.getAttribute("preserveAspectRatio")) svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }
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

  const cls = ["prop", p.draft && pending && "draft", p.highlight && `hl-${p.highlight}`].filter(Boolean).join(" ");
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

export function StageView({ stage }: { stage: Stage }) {
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
  const scale = Math.min(size.w / rect.w, size.h / rect.h);
  const ox = (size.w - rect.w * scale) / 2 - rect.x * scale;
  const oy = (size.h - rect.h * scale) / 2 - rect.y * scale;
  const three = s.props.filter((p) => p.scene3d).length;
  const drag = s.props.some((p) => p.scene3d?.interactive);

  return (
    <div className="stage" data-track={s.track} ref={hostRef}>
      <div className="world" style={{ transform: `translate(${ox}px, ${oy}px) scale(${scale})` }}>
        {s.props.map((p) => (
          <PropView key={p.id} p={p} t={s.t} pending={s.pendingArt > 0} />
        ))}
      </div>
      {s.veil && <div className={`veil veil-${s.veil.style}`} style={{ opacity: veilOpacity(s.veil.progress) }} />}
      {s.narration && s.narration.style === "verse" && (
        <div className="narration verse">
          {verseRows(s.narration.text, s.narration.progress).map((row, i) => (
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
            {s.narration.text.slice(0, Math.max(1, Math.round(s.narration.text.length * s.narration.progress)))}
            <i className="caret" />
            <em className="unsaid">{s.narration.text.slice(Math.max(1, Math.round(s.narration.text.length * s.narration.progress)))}</em>
          </span>
        </div>
      )}
      <div className="telemetry">
        {s.props.length} props{three ? ` · ${three} 3D${drag ? "（可拖动·转动不进分享）" : ""}` : ""} · t={Math.round(s.t)}ms
        {s.track === "main" ? "" : ` · ${s.track}`}
        {s.artWait ? " · 时钟等美工" : ""}
      </div>
    </div>
  );
}
