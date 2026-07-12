/** Low-level transport for the Gemini generateContent REST endpoint. */

import { PLANNER_SYSTEM } from "../prompt";
import type { ProviderTool } from "../types";
import type { GeminiContent, GeminiPart } from "./types";

export const BASE = "https://generativelanguage.googleapis.com/v1beta";

const REQUEST_TIMEOUT_MS = 60000;

/**
 * Gemini 3+ models think at level "medium" by default, which on a non-trivial
 * ticket can take well over 30 seconds — during which the connection carries
 * zero bytes, and intermediaries (proxies/VPNs) commonly reset such silent
 * connections, surfacing as "Failed to fetch" at ~30s. The agent loop forces a
 * single function call per request and doesn't need deep reasoning, so "low"
 * keeps answers fast (seconds) and cheap. Gemini 2.x models don't accept
 * thinkingLevel, so it's only sent to 3+.
 */
function thinkingConfigFor(model: string): Record<string, unknown> | undefined {
  return /^gemini-(?:[3-9]|\d{2,})/.test(model) ? { thinkingLevel: "LOW" } : undefined;
}

/**
 * Call generateContent forcing a single function call, and return the parsed
 * arguments of that call. Throws on timeout, HTTP errors, or when the model
 * returns no function call. Retries once on a transient network failure
 * (dropped connection, 429/5xx) unless the caller aborted.
 */
export async function call(
  apiKey: string,
  model: string,
  text: string,
  tool: ProviderTool,
  toolName: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const contents: GeminiContent[] = [{ role: "user", parts: [{ text }] }];
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await attemptCall(apiKey, model, contents, tool, toolName, signal);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const transient =
        /connection dropped|Failed to fetch/i.test(lastErr.message) ||
        /^Gemini (?:429|5\d\d)/.test(lastErr.message);
      if (!transient || signal?.aborted) throw lastErr;
      await new Promise((r) => setTimeout(r, 800));
      if (signal?.aborted) throw new Error("Gemini request canceled.");
    }
  }
  throw lastErr ?? new Error("Gemini request failed.");
}

async function attemptCall(
  apiKey: string,
  model: string,
  contents: GeminiContent[],
  tool: ProviderTool,
  toolName: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Abort a hung request rather than leaving the agent stuck on "working…".
  const ctrl = new AbortController();
  const abortFromCaller = () => ctrl.abort();
  if (signal?.aborted) abortFromCaller();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let data: { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> };
  try {
    const res = await fetch(
      `${BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: PLANNER_SYSTEM }] },
          contents,
          tools: [{ functionDeclarations: [tool] }],
          toolConfig: {
            functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolName] },
          },
          generationConfig: {
            temperature: 0.2,
            ...(thinkingConfigFor(model)
              ? { thinkingConfig: thinkingConfigFor(model) }
              : {}),
          },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini ${res.status}: ${body.slice(0, 400)}`);
    }
    // Read the body under the same timeout/abort as the request itself: a
    // stalled response stream must abort too, not hang the agent forever.
    data = await res.json();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      if (signal?.aborted) {
        throw new Error("Gemini request canceled.");
      }
      throw new Error(`Gemini request timed out after ${REQUEST_TIMEOUT_MS / 1000}s (model "${model}"). Check your key/model and network.`);
    }
    if (e instanceof Error && /^Gemini \d/.test(e.message)) throw e;
    // "Failed to fetch" is Chrome's generic network error — most often the
    // connection was reset mid-request (flaky network, or a proxy/VPN cutting
    // long-silent connections). Name the likely cause for the user.
    if (e instanceof Error && /Failed to fetch/i.test(e.message)) {
      throw new Error(
        `Gemini request failed: the network connection dropped mid-request (model "${model}"). If you use a VPN/proxy, it may be cutting long requests — try again.`,
      );
    }
    throw new Error(`Gemini request failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
  const parts: GeminiPart[] = data?.candidates?.[0]?.content?.parts ?? [];
  const fc = parts.find((p) => p.functionCall)?.functionCall;
  if (!fc) {
    const txt = parts.map((p) => p.text).filter(Boolean).join(" ");
    throw new Error(`No function call returned. Model said: ${txt || "(empty)"}`);
  }
  return fc.args ?? {};
}
