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
    expect(next.providers[0].models.find((m) => m.id === "gpt-x")?.label).toBe("gpt-x"); // 新行自动填显示名，不用手写
    vi.unstubAllGlobals();
  });

  it("拉取自动填显示名：接口给了名字用名字，没给就用 id 顶上，已有行保留原显示名", async () => {
    const cfg: LlmConfig = {
      ...base,
      providers: [
        {
          ...base.providers[0],
          models: [{ id: "deepseek-chat", label: "我改过的名字", reasoning: true, contextWindow: 128000, maxTokens: 8192 }],
        },
      ],
    };
    const { host, onChange } = mount(cfg);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: "deepseek-chat", name: "DeepSeek Chat" }, { id: "deepseek-reasoner" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await act(async () => void byText(host, "拉取模型列表").click());
    const next = onChange.mock.calls.at(-1)![0] as LlmConfig;
    const models = next.providers[0].models;
    expect(models.find((m) => m.id === "deepseek-chat")?.label).toBe("我改过的名字"); // 已在板上的行，名字不许被覆盖
    expect(models.find((m) => m.id === "deepseek-reasoner")?.label).toBe("deepseek-reasoner"); // 接口没给名字 → id 顶上
    vi.unstubAllGlobals();
  });
});

/** 角色行的两个下拉：接入（provider）与模型。一行是 .role-row，[0] 是接入、[1] 是模型。 */
function roleSelects(host: HTMLElement, row = 0) {
  return [...host.querySelectorAll<HTMLSelectElement>(".role-row")][row].querySelectorAll<HTMLSelectElement>("select");
}

const withModels: LlmConfig = {
  providers: [
    {
      id: "p1",
      name: "接入 1",
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        { id: "deepseek", label: "flash", reasoning: true, contextWindow: 128000, maxTokens: 8192 },
        { id: "deepseek", label: "pro", reasoning: true, contextWindow: 128000, maxTokens: 8192 },
      ],
    },
  ],
  director: { provider: "p1", model: "" },
  painter: { provider: "p1", model: "" },
  thinking: "medium",
  scripted: false,
};

describe("模型配置：角色行的接入与模型联动", () => {
  it("选中接入后，模型下拉列出该接入的模型（flash / pro 都该在）", () => {
    const { host } = mount(withModels);
    const model = roleSelects(host)[1];
    const texts = [...model.options].map((o) => o.textContent);
    expect(texts).toContain("flash");
    expect(texts).toContain("pro");
  });

  it("没选接入时，接入下拉显示「选择接入…」而不是把第一个接入顶在脸上：没选中就是没选中", () => {
    const cfg: LlmConfig = { ...withModels, director: { provider: "", model: "" }, painter: { provider: "", model: "" } };
    const { host } = mount(cfg);
    const [prov, model] = roleSelects(host);
    expect(prov.value).toBe(""); // 确实没选中任何接入 —— 显示的文本不能伪装成已选中
    expect(prov.options[prov.selectedIndex]?.textContent).toBe("选择接入…");
    expect([...model.options].map((o) => o.textContent)).toEqual(["选择模型…"]); // 没有接入就没有模型，这是真实状态
  });

  it("加第一个接入时，还没选过接入的角色行自动指向它：模型下拉立刻有得选", () => {
    const empty: LlmConfig = { providers: [], director: { provider: "", model: "" }, painter: { provider: "", model: "" }, thinking: "medium", scripted: false };
    const { host, onChange } = mount(empty);
    act(() => byText(host, "OpenAI 兼容接入").click());
    const next = onChange.mock.calls.at(-1)![0] as LlmConfig;
    expect(next.providers).toHaveLength(1);
    expect(next.director.provider).toBe(next.providers[0].id);
    expect(next.painter.provider).toBe(next.providers[0].id);
  });

  it("已经选好接入的角色行，加新接入时不被动：选择留在原接入上", () => {
    const { host, onChange } = mount(withModels);
    act(() => byText(host, "OpenAI 兼容接入").click());
    const next = onChange.mock.calls.at(-1)![0] as LlmConfig;
    expect(next.providers).toHaveLength(2);
    expect(next.director.provider).toBe("p1");
    expect(next.painter.provider).toBe("p1");
  });
});
