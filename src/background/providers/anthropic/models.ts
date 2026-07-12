import { fetchJson } from "../http";
import { BASE } from "./client";

/**
 * Fetch the Claude models the given key can use. Returns bare model ids like
 * "claude-sonnet-5". Throws on a bad key.
 */
export async function listModels(apiKey: string): Promise<string[]> {
  const data = (await fetchJson(
    `${BASE}/models`,
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    },
    "Anthropic",
  )) as { data?: Array<{ id: string }> };
  return Array.from(
    new Set((data.data ?? []).map((m) => m.id).filter((id) => id.startsWith("claude-"))),
  );
}
