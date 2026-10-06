import type { OpEntry } from "./types";

/**
 * A lesson is its tape, so a shareable lesson is a URL carrying the tape. Deflate + base64url
 * keeps a whole performance inside the fragment, which never reaches a server.
 */

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const s = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function encodeTape(entries: OpEntry[]): Promise<string> {
  const stream = new Blob([JSON.stringify(entries)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

export async function decodeTape(payload: string): Promise<OpEntry[]> {
  let entries: unknown;
  try {
    const stream = new Blob([fromBase64Url(payload)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    entries = JSON.parse(await new Response(stream).text());
  } catch {
    // A truncated or mistyped fragment surfaces here as a network error, not as a parse error.
    throw new Error("不是一段舞台录像");
  }
  if (!Array.isArray(entries) || entries.some((e) => typeof e.seq !== "number" || !e.op)) {
    throw new Error("不是一段舞台录像");
  }
  return entries as OpEntry[];
}
