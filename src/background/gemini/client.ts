/** Low-level transport for the Gemini generateContent REST endpoint. */

import { PLANNER_SYSTEM } from "./prompt";
import type { GeminiContent, GeminiPart, GeminiTool } from "./types";

export const BASE = "https://generativelanguage.googleapis.com/v1beta";

const REQUEST_TIMEOUT_MS = 30000;

/**
 * Call generateContent forcing a single function call, and return the parsed
 * arguments of that call. Throws on timeout, HTTP errors, or when the model
 * returns no function call.
 */
export async function call(
  apiKey: string,
  model: string,
  contents: GeminiContent[],
  tool: GeminiTool,
  toolName: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Abort a hung request rather than leaving the agent stuck on "working…".
  const ctrl = new AbortController();
  const abortFromCaller = () => ctrl.abort();
  if (signal?.aborted) abortFromCaller();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(
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
          generationConfig: { temperature: 0.2 },
        }),
      },
    );
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      if (signal?.aborted) {
        throw new Error("Gemini request canceled.");
      }
      throw new Error(`Gemini request timed out after 30s (model "${model}"). Check your key/model and network.`);
    }
    throw new Error(`Gemini request failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const parts: GeminiPart[] = data?.candidates?.[0]?.content?.parts ?? [];
  const fc = parts.find((p) => p.functionCall)?.functionCall;
  if (!fc) {
    const txt = parts.map((p) => p.text).filter(Boolean).join(" ");
    throw new Error(`No function call returned. Model said: ${txt || "(empty)"}`);
  }
  return fc.args ?? {};
}
