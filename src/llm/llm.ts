import {
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages";

export type ChatApi = "openai-completions" | "anthropic-messages";

export interface ModelCfg {
  id: string;
  label?: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderCfg {
  id: string;
  name: string;
  baseUrl: string;
  api: ChatApi;
  models: ModelCfg[];
}

export interface LlmConfig {
  providers: ProviderCfg[];
  director: { provider: string; model: string };
  painter: { provider: string; model: string };
  thinking: "off" | "minimal" | "low" | "medium" | "high";
  scripted: boolean;
}

export const DEFAULT_CONFIG: LlmConfig = {
  providers: [],
  director: { provider: "", model: "" },
  painter: { provider: "", model: "" },
  thinking: "medium",
  scripted: true,
};

const LS = "canvas-teacher.llm";
const CRED = "canvas-teacher.credential.";

/** The config row points at a provider; it never carries the secret. Older builds left one here. */
function dropKey(p: ProviderCfg): ProviderCfg {
  const { key: _stale, ...rest } = p as ProviderCfg & { key?: string };
  return rest as ProviderCfg;
}

export function loadConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return structuredClone(DEFAULT_CONFIG);
    const stored = { ...structuredClone(DEFAULT_CONFIG), ...(JSON.parse(raw) as LlmConfig) };
    return { ...stored, providers: stored.providers.map(dropKey) };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(cfg: LlmConfig) {
  localStorage.setItem(LS, JSON.stringify({ ...cfg, providers: cfg.providers.map(dropKey) }));
}

/** What the credential store actually holds for this provider — the only truth about a saved key. */
export async function readKey(providerId: string): Promise<string> {
  const cred = await credentialStore.read(providerId);
  return cred?.type === "api_key" ? (cred.key ?? "") : "";
}

/** pi-ai's CredentialStore over localStorage — the only write path is `modify`. */
const credentialStore: CredentialStore = {
  async read(providerId): Promise<Credential | undefined> {
    const raw = localStorage.getItem(CRED + providerId);
    return raw ? (JSON.parse(raw) as Credential) : undefined;
  },
  async list(): Promise<readonly CredentialInfo[]> {
    const out: CredentialInfo[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(CRED)) continue;
      const id = k.slice(CRED.length);
      const c = await credentialStore.read(id);
      if (c) out.push({ providerId: id, type: c.type });
    }
    return out;
  },
  async modify(providerId, fn): Promise<Credential | undefined> {
    const current = await credentialStore.read(providerId);
    const next = await fn(current);
    if (next) localStorage.setItem(CRED + providerId, JSON.stringify(next));
    return next;
  },
  async delete(providerId): Promise<void> {
    localStorage.removeItem(CRED + providerId);
  },
};

function toModel(cfg: ProviderCfg, m: ModelCfg): Model<ChatApi> {
  return {
    id: m.id,
    name: m.label ?? m.id,
    api: cfg.api,
    provider: cfg.id,
    baseUrl: cfg.baseUrl,
    reasoning: m.reasoning,
    input: ["text"],
    output: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow || 128000,
    maxTokens: m.maxTokens || 8192,
  } as Model<ChatApi>;
}

const API_IMPL: Record<ChatApi, { stream: never; streamSimple: never }> = {
  "openai-completions": openaiCompletions as never,
  "anthropic-messages": anthropicMessages as never,
};

export type Role = "director" | "painter";

let collection: MutableModels | null = null;
let builtFor = "";
let faux: ReturnType<typeof fauxProvider> | null = null;
let fauxModel: Model<Api> | null = null;
let scriptedQueue = 0;

export function getModels(cfg: LlmConfig): MutableModels {
  const key = JSON.stringify({ p: cfg.providers.map((p) => [p.id, p.baseUrl, p.api, p.models.length]), s: cfg.scripted });
  if (collection && builtFor === key) return collection;
  const m = createModels({ credentials: credentialStore });
  m.clearProviders();
  if (cfg.scripted) {
    faux = fauxProvider({ provider: "scripted", models: [{ id: "rehearsal", name: "排练脚本" }] });
    fauxModel = faux.getModel() as Model<Api>;
    m.setProvider(faux.provider);
  }
  for (const p of cfg.providers.filter((x) => x.id !== "scripted")) {
    m.setProvider(
      createProvider({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        api: API_IMPL[p.api] as never,
        models: p.models.map((model) => toModel(p, model)) as never,
        auth: {
          apiKey: {
            name: `${p.name} API key`,
            async resolve({ credential }) {
              const key = credential?.type === "api_key" ? credential.key : undefined;
              return key ? { auth: { apiKey: key, baseUrl: p.baseUrl } } : undefined;
            },
          },
        },
        async fetchModels() {
          return listRemoteModels(p).then((ids) => ids.map((id) => toModel(p, { id, reasoning: true, contextWindow: 128000, maxTokens: 8192 })));
        },
      }),
    );
  }
  collection = m;
  builtFor = key;
  return m;
}

/** The single write path for a secret: the credential store. Nothing about it enters LlmConfig. */
export async function setKey(providerId: string, key: string) {
  await credentialStore.modify(providerId, async () => ({ type: "api_key", key } as Credential));
  collection = null;
}

/** Removing a provider row must take its secret with it: the user can no longer point at it to clear it. */
export async function forgetKey(providerId: string) {
  await credentialStore.delete(providerId);
  collection = null;
}

export function modelFor(cfg: LlmConfig, role: Role): Model<ChatApi> | undefined {
  if (cfg.scripted) {
    getModels(cfg);
    return (fauxModel as unknown as Model<ChatApi>) ?? undefined;
  }
  const want = role === "director" ? cfg.director : cfg.painter;
  const p = cfg.providers.find((x) => x.id === want.provider);
  const m = p?.models.find((x) => x.id === want.model);
  if (!p || !m) return undefined;
  return toModel(p, m);
}

/** GET /models — the shape 中转站 and both first-party APIs answer, per provider api. */
export async function listRemoteModels(p: ProviderCfg): Promise<string[]> {
  if (!p.baseUrl) return [];
  const url = p.baseUrl.replace(/\/+$/, "") + (p.api === "anthropic-messages" ? "/models" : "/models");
  const headers: Record<string, string> = { Accept: "application/json" };
  // from the credential store, not from the config row: the key is not kept there any more
  const key = await readKey(p.id);
  if (key) {
    if (p.api === "anthropic-messages") Object.assign(headers, { "x-api-key": key, "anthropic-version": "2023-06-01" });
    else headers.Authorization = `Bearer ${key}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const rows = (body.data ?? body.models ?? body) as unknown;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => (typeof r === "string" ? r : ((r as Record<string, unknown>)?.id as string)))
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .sort();
}

export interface TurnEvents {
  onText?: (delta: string) => void;
  /** Progressive tool arguments: live artwork lands here while the model is still emitting it. */
  onToolArgs?: (name: string, args: Record<string, unknown>) => void;
}

export interface TurnResult {
  message: AssistantMessage;
}

export async function streamTurn(
  cfg: LlmConfig,
  role: Role,
  context: Context,
  events: TurnEvents,
  signal?: AbortSignal,
): Promise<TurnResult> {
  const model = modelFor(cfg, role);
  if (!model) throw new Error(`模型未配置：${role}`);
  const m = getModels(cfg);
  const scripted = cfg.scripted && faux;
  // A rehearsal script is a fixture of fixed length. Running out of lines is the end of the
  // rehearsal, not a provider failure — so the loop gets a stop message instead of an error,
  // and an interruption that resumes the main line can never end in a red status line.
  if (scripted) {
    if (scriptedQueue <= 0) return { message: fauxAssistantMessage("（排练剧本到这里演完了。真实演出由模型自己决定说到哪儿。）", { stopReason: "stop" }) };
    scriptedQueue--;
  }
  const stream = m.streamSimple(model, context, {
    toolChoice: "auto",
    reasoning: scripted ? undefined : cfg.thinking === "off" ? undefined : (cfg.thinking as never),
    signal,
  } as never);
  for await (const ev of stream) {
    if (ev.type === "text_delta") events.onText?.(ev.delta);
    if (ev.type === "toolcall_delta") {
      const block = ev.partial.content[ev.contentIndex] as { type: string; name?: string; arguments?: Record<string, unknown> };
      if (block?.type === "toolCall" && block.name) events.onToolArgs?.(block.name, block.arguments ?? {});
    }
  }
  const message = await stream.result();
  if (message.stopReason === "error") {
    throw new Error(message.errorMessage ?? `provider ${message.provider}/${message.model} 返回错误`);
  }
  return { message };
}

export function setScriptedResponses(steps: AssistantMessage[]) {
  scriptedQueue = steps.length;
  faux?.setResponses(steps as never);
}

export function queueScriptedResponses(steps: AssistantMessage[]) {
  scriptedQueue += steps.length;
  faux?.appendResponses(steps as never);
}

export function scriptedReady() {
  return !!faux;
}
