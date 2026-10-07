import { describe, expect, it } from "vitest";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { directorTools } from "../tools/director";
import type { Box, Op } from "./types";

/*
 * 道具的身份跨场景持续，所以"一个名字"和"一个已经落下的东西"是两件事：`link` 只说了一个名字，
 * 那一格就进了道具表，可它一条 revision 都没有 —— 它还没有样子。解释器一直防着这一点
 * （`propBox` 没有外观就返回 undefined，`visibleProps` 数都不数它），只有两处读者直接把
 * `revisions.at(-1)` 当成品读：`agentSnapshot` 和 `fetch_prop`。前者是导演每一拍都要读的那段
 * `<stage>`，后者是他主动去看的 —— 于是一个拼错的名字把导演自己的上下文炸掉，这一拍整个轮次
 * 死在半路，屏幕上没有原因。
 */

const at = (x: number, y: number): Box => ({ x, y, w: 200, h: 160 });
const art = (id: string): Op => ({ kind: "build", id, box: at(0, 0), label: id, html: `<p>${id}</p>` });
const line = (text: string, duration = 1000): Op => ({ kind: "narrate", text, duration });
const tie = (from: string, to: string): Op => ({ kind: "link", from, to, relation: "points-to" });

describe("一个只被念到名字、还没有样子的道具", () => {
  it("link 到没建过的名字，导演的 <stage> 照样读得出来", () => {
    const s = new Stage();
    s.append([art("vec-r"), tie("vec-q", "vec-r"), line("说话", 1000)], MAIN_TRACK);
    expect(() => s.agentSnapshot()).not.toThrow();
    const snap = s.agentSnapshot();
    expect(snap).toContain("vec-r");
    // 没样子的名字不该装作在台上有东西。
    expect(snap).not.toMatch(/^\s*vec-q/m);
  });

  it("fetch_prop 读它，拿到一句人话而不是一场崩溃", () => {
    const s = new Stage();
    s.append([art("vec-r"), tie("vec-q", "vec-r"), line("说话", 1000)], MAIN_TRACK);
    // link 就该在道具表里留下这个名字 —— 身份比画面先出现，那是设计。
    expect(s.compiled.props.get("vec-q")?.revisions).toHaveLength(0);
    const d = directorTools(s, { title: "", concepts: [], learner: "", beatsDone: 0 });
    const out = d.run("fetch_prop", { id: "vec-q" });
    expect(out.isError).toBe(true);
    expect(out.result).toContain("只被 link 念到过名字");
    expect(() => d.run("fetch_prop", { id: "vec-r" })).not.toThrow();
  });

  it("discard 掉唯一的道具之后，读它也是同一回事", () => {
    const s = new Stage();
    s.append([art("a"), { kind: "discard", id: "a" } as Op, line("s", 1000)], MAIN_TRACK);
    const after = s.compiled.props.get("a");
    expect(after?.revisions).toHaveLength(1); // 带上的历史不删，只是不再在台前
    expect(() => s.agentSnapshot()).not.toThrow();
  });

  it("只被 link 提及的名字，镜头指过去不算'看得见'", () => {
    const s = new Stage();
    s.append([art("a"), tie("ghost", "a"), line("说一句", 1000)], MAIN_TRACK);
    expect(s.visibleName("ghost", s.compiled.duration)).toBe(false);
    expect(s.visibleName("a", s.compiled.duration)).toBe(true);
  });
});

