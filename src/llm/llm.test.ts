import { afterEach, describe, expect, it, vi } from "vitest";
import { getModels, readKey, setKey } from "./llm";
import { DEFAULT_CONFIG } from "./llm";

/** A corrupt entry is a leftover from an interrupted write or an old build. */
function makeFakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  } as Storage;
}

describe("credentialStore over localStorage", () => {
  let storage: Storage;
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubStorage = () => {
    storage = makeFakeStorage();
    vi.stubGlobal("localStorage", storage);
  };

  it("readKey 返回空串，而不是把整条模型链炸掉：一条损坏的凭据被清掉", async () => {
    stubStorage();
    storage.setItem("canvas-teacher.credential.provider-x", "{broken json!!");

    // The corrupt entry must not throw — it is skipped and removed, like every other
    // guarded localStorage read in this app (`loadConfig`, `archive`).
    await expect(readKey("provider-x")).resolves.toBe("");
    expect(storage.getItem("canvas-teacher.credential.provider-x")).toBeNull();
  });

  it("正常凭据仍可读回", async () => {
    stubStorage();
    await setKey("provider-y", "sk-real-key");
    await expect(readKey("provider-y")).resolves.toBe("sk-real-key");
  });

  it("getModels 遇到损坏凭据不抛异常：注册模型表时带伤工作，而不是把整条链炸掉", async () => {
    stubStorage();
    storage.setItem("canvas-teacher.credential.provider-z", "{nope");
    const cfg = {
      ...DEFAULT_CONFIG,
      providers: [
        {
          id: "provider-z",
          name: "接 Z",
          baseUrl: "https://example.test/v1",
          api: "openai-completions" as const,
          models: [{ id: "model-a", reasoning: false, contextWindow: 128000, maxTokens: 8192 }],
        },
      ],
      director: { provider: "provider-z", model: "model-a" },
      painter: { provider: "provider-z", model: "model-a" },
    };
    // 构造 registry 本身不读凭据（auth 解析时才读）；关键是它不因坏条目抛错，
    // 而随后第一次读该凭据时坏条目会被清理（见上一条用例）。
    expect(() => getModels(cfg)).not.toThrow();
  });
});
