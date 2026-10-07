import { useEffect, useState } from "react";
import { forgetKey, listRemoteModels, readKey, setKey, type LlmConfig, type ProviderCfg } from "../llm/llm";

interface Props {
  cfg: LlmConfig;
  onChange: (next: LlmConfig) => void;
  onEvent: (msg: string) => void;
}

const API_LABEL: Record<ProviderCfg["api"], string> = {
  "openai-completions": "OpenAI 兼容（/chat/completions）",
  "anthropic-messages": "Anthropic Messages",
};

export function ModelConfig({ cfg, onChange, onEvent }: Props) {
  const [busy, setBusy] = useState("");
  const [armed, setArmed] = useState("");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const idList = cfg.providers.map((p) => p.id).join(",");

  // The key lives in the credential store, not in the config row: read it back so the field is a
  // view of what is stored rather than a second copy that drifts.
  useEffect(() => {
    let live = true;
    const ids = idList ? idList.split(",") : [];
    Promise.all(ids.map(async (id) => [id, await readKey(id)] as const)).then((rows) => {
      if (live) setKeys(Object.fromEntries(rows));
    });
    return () => {
      live = false;
    };
  }, [idList]);

  const patchProvider = (id: string, patch: Partial<ProviderCfg>) =>
    onChange({ ...cfg, providers: cfg.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) });

  const addProvider = (api: ProviderCfg["api"]) => {
    // Counting existing rows collides as soon as one is deleted: two providers with the same id
    // share a credential slot, and the later save silently overwrites the other one's key.
    const taken = new Set(cfg.providers.map((p) => p.id));
    let n = 1;
    while (taken.has(`custom-${n}`)) n++;
    const preset =
      api === "anthropic-messages"
        ? { baseUrl: "https://api.anthropic.com/v1", models: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000, maxTokens: 8192 }] }
        : { baseUrl: "", models: [] };
    const p: ProviderCfg = { id: `custom-${n}`, name: `接入 ${n}`, api, ...preset };
    onChange({ ...cfg, providers: [...cfg.providers, p] });
  };

  const removeProvider = (p: ProviderCfg) => {
    void forgetKey(p.id);
    onChange({ ...cfg, providers: cfg.providers.filter((x) => x.id !== p.id) });
  };

  const pull = async (p: ProviderCfg) => {
    setBusy(p.id);
    try {
      const ids = await listRemoteModels(p);
      if (ids.length === 0) onEvent(`${p.name}：接口没有返回模型列表，请手动填写 id`);
      else onEvent(`${p.name}：拉到 ${ids.length} 个模型`);
      const known = new Map(p.models.map((m) => [m.id, m]));
      patchProvider(p.id, {
        models: [...ids.map((id) => known.get(id) ?? { id, reasoning: true, contextWindow: 128000, maxTokens: 8192 }), ...p.models.filter((m) => !ids.includes(m.id))],
      });
    } catch (e) {
      onEvent(`拉取模型失败：${(e as Error).message}（跨域或被服务商拒绝，可改为手填 id）`);
    } finally {
      setBusy("");
    }
  };

  const saveKey = async (p: ProviderCfg, key: string) => {
    if ((keys[p.id] ?? "") === key) return; // a blur that changed nothing must not rewrite anything
    setKeys((k) => ({ ...k, [p.id]: key }));
    await setKey(p.id, key);
    onEvent(
      key
        ? `已保存 ${p.name} 的密钥（只写在凭据存储里，配置行不留副本；纯浏览器直连意味着它对打开 DevTools 的人可见）`
        : `${p.name} 的密钥已清除。`,
    );
  };

  const real = cfg.providers.filter((p) => p.id !== "scripted");
  const rolesFor = (role: "director" | "painter") => (
    <div className="role-row">
      <span className="role-name">{role === "director" ? "编导 / 教师" : "舞台美术（画图）"}</span>
      <select
        value={cfg[role].provider}
        onChange={(e) => onChange({ ...cfg, [role]: { provider: e.target.value, model: "" } } as LlmConfig)}
      >
        {real.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select
        value={cfg[role].model}
        onChange={(e) => onChange({ ...cfg, [role]: { ...cfg[role], model: e.target.value } })}
      >
        <option value="">选择模型…</option>
        {(real.find((p) => p.id === cfg[role].provider)?.models ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.label ?? m.id}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="panel config">
      {import.meta.env.DEV && (
        <label className="switch">
          <input type="checkbox" checked={cfg.scripted} onChange={(e) => onChange({ ...cfg, scripted: e.target.checked })} />
          <span>本地排练模式（不联网，用固定谱子驱动同一套舞台）</span>
        </label>
      )}

      {!cfg.scripted && (
        <>
          <div className="roles">
            {rolesFor("director")}
            {rolesFor("painter")}
            <div className="role-row">
              <span className="role-name">推理强度</span>
              <select value={cfg.thinking} onChange={(e) => onChange({ ...cfg, thinking: e.target.value as LlmConfig["thinking"] })}>
                {["off", "minimal", "low", "medium", "high"].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="hint">编导要会安排戏，画图要快 —— 两个位置可以填不同模型。</div>
        </>
      )}

      <div className="prov-list">
        {real.map((p) => (
          <div className="prov" key={p.id}>
            <div className="prov-head">
              <input className="name" value={p.name} onChange={(e) => patchProvider(p.id, { name: e.target.value })} />
              <select value={p.api} onChange={(e) => patchProvider(p.id, { api: e.target.value as ProviderCfg["api"] })}>
                {(Object.keys(API_LABEL) as ProviderCfg["api"][]).map((a) => (
                  <option key={a} value={a}>
                    {API_LABEL[a]}
                  </option>
                ))}
              </select>
              {armed === p.id ? (
                <button
                  className="x confirm"
                  onClick={() => {
                    removeProvider(p);
                    setArmed("");
                  }}
                  title="再点一次就真的删除"
                >
                  确认删除
                </button>
              ) : (
                <button className="x" onClick={() => setArmed(p.id)} title="移除">
                  ×
                </button>
              )}
            </div>
            {armed === p.id && (
              <div className="confirm-note">
                删除「{p.name}」会把它和它的密钥一起抹掉，无法恢复。确认要删？
                <button className="x" onClick={() => setArmed("")}>
                  取消
                </button>
              </div>
            )}
            <input className="base" placeholder="Base URL，例如 https://中转地址/v1" value={p.baseUrl} onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })} />
            <input
              className="key"
              type="password"
              placeholder={keys[p.id] ? "已保存的密钥" : "API key"}
              value={keys[p.id] ?? ""}
              onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
              onBlur={(e) => void saveKey(p, e.target.value)}
            />
            <div className="prov-actions">
              <button onClick={() => void pull(p)} disabled={busy === p.id}>
                {busy === p.id ? "拉取中…" : "拉取模型列表"}
              </button>
              <span className="count">{p.models.length} 个模型</span>
            </div>
            <details>
              <summary>模型清单（context / max tokens / 是否支持推理）</summary>
              {p.models.map((m, i) => (
                <div className="model-row" key={m.id}>
                  <input value={m.id} onChange={(e) => patchProvider(p.id, { models: p.models.map((x, j) => (i === j ? { ...x, id: e.target.value } : x)) })} />
                  <input
                    className="cw"
                    type="number"
                    value={m.contextWindow}
                    onChange={(e) => patchProvider(p.id, { models: p.models.map((x, j) => (i === j ? { ...x, contextWindow: Number(e.target.value) } : x)) })}
                  />
                  <input
                    className="cw"
                    type="number"
                    value={m.maxTokens}
                    onChange={(e) => patchProvider(p.id, { models: p.models.map((x, j) => (i === j ? { ...x, maxTokens: Number(e.target.value) } : x)) })}
                  />
                  <label>
                    <input
                      type="checkbox"
                      checked={m.reasoning}
                      onChange={(e) => patchProvider(p.id, { models: p.models.map((x, j) => (i === j ? { ...x, reasoning: e.target.checked } : x)) })}
                    />
                    推理
                  </label>
                  <button className="x" onClick={() => patchProvider(p.id, { models: p.models.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                </div>
              ))}
            </details>
          </div>
        ))}
      </div>

      <div className="add-row">
        <button onClick={() => addProvider("openai-completions")}>+ OpenAI 兼容接入</button>
        <button onClick={() => addProvider("anthropic-messages")}>+ Anthropic 接入</button>
      </div>
    </div>
  );
}

