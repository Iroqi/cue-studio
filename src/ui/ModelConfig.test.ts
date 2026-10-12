// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ModelConfig } from "./ModelConfig";
import type { LlmConfig } from "../llm/llm";

/*
 * 模型配置的"手填"这一头：接口检测不出模型（中转站不答 `/models`，或答的形状不认识）不该是死路。
 * 拉取是方便，不是唯一的大门 —— 手写的一行是探测器本来会产出的同一个 `ModelCfg`，而一次后来的
 * 拉取不许把它冲掉（`pull` 保留远程没列出的行）。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: LlmConfig = {
  providers: [{ id: "p1", name: "中转", baseUrl: "https://x/v1", api: "openai-completions", models: [] }],
  director: { provider: "p1", model: "" },
  painter: { provider: "p1", model: "" },
  thinking: "medium",
  scripted: false,
};

function mount(cfg: LlmConfig, onChange = vi.fn()) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(ModelConfig, { cfg, onChange, onEvent: () => {} })));
  return { host, root, onChange };
}

function byText(host: HTMLElement, text: string): HTMLButtonElement {
  return [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
}

/** React 的受控输入有自己的 value tracker：直接赋值再派事件不会过门，要走原型上的原生 setter。 */
function typeInto(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("模型配置：手填的入口", () => {
  it("检测不出来的模型，一行写出来：点「+ 手填一个模型」追加一行", () => {
    const { host, onChange } = mount(base);
    act(() => byText(host, "手填一个模型").click());
    const next = onChange.mock.calls.at(-1)![0] as LlmConfig;
    expect(next.providers[0].models).toHaveLength(1);
    expect(next.providers[0].models[0].id).toBe("model-id");
    expect(next.providers[0].models[0].label).toBe("");
  });

  it("手填的行可改显示名与 id：两格各自落进配置", () => {
    const cfg: LlmConfig = {
      ...base,
      providers: [{ ...base.providers[0], models: [{ id: "model-id", label: "", reasoning: true, contextWindow: 128000, maxTokens: 8192 }] }],
    };
    const { host, onChange } = mount(cfg);
    const inputs = [...host.querySelectorAll<HTMLInputElement>(".model-row input")];
    const labelInput = inputs[0];
    const idInput = inputs[1];
    typeInto(labelInput, "我的模型");
    expect((onChange.mock.calls.at(-1)![0] as LlmConfig).providers[0].models[0].label).toBe("我的模型");
    typeInto(idInput, "my-model-7b");
    expect((onChange.mock.calls.at(-1)![0] as LlmConfig).providers[0].models[0].id).toBe("my-model-7b");
  });

  it("手填的行不被下一次拉取冲掉：拉到的合并、手写的保留", async () => {
    const cfg: LlmConfig = {
      ...base,
      providers: [{ ...base.providers[0], models: [{ id: "model-id", label: "手写模型", reasoning: true, contextWindow: 128000, maxTokens: 8192 }] }],
    };
    const { host, onChange } = mount(cfg);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-x" }] }), { status: 200, headers: { "content-type": "application/json" } })),
    );
    await act(async () => void byText(host, "拉取模型列表").click());
    const next = onChange.mock.calls.at(-1)![0] as LlmConfig;
    const ids = next.providers[0].models.map((m) => m.id).sort();
    expect(ids).toEqual(["gpt-x", "model-id"]);
    expect(next.providers[0].models.find((m) => m.id === "model-id")?.label).toBe("手写模型");
    vi.unstubAllGlobals();
  });
});
