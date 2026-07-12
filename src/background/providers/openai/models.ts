import { fetchJson } from "../http";
import { BASE } from "./client";

/** Rank a model id so newer/more-capable models sort first. */
function scoreModel(id: string): number {
  const match = id.match(/gpt-(\d+(?:\.\d+)?)/);
  const version = match ? parseFloat(match[1]) : 0;
  const tier = /sol/.test(id) ? 0.3 : /terra/.test(id) ? 0.2 : /luna/.test(id) ? 0.1 : 0;
  return version * 10 + tier;
}

/**
 * Fetch the chat-capable models the given key can use. Returns bare model ids
 * like "gpt-5.6-luna", newest-looking first. Throws on a bad key.
 */
export async function listModels(apiKey: string): Promise<string[]> {
  const data = (await fetchJson(
    `${BASE}/models`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    "OpenAI",
  )) as { data?: Array<{ id: string }> };
  return Array.from(
    new Set(
      (data.data ?? [])
        .map((m) => m.id)
        .filter((id) => /^gpt-|^o\d|^chatgpt-/i.test(id) && !/transcribe|tts|image|audio|embedding|moderation/i.test(id)),
    ),
  ).sort((a, b) => scoreModel(b) - scoreModel(a) || a.localeCompare(b));
}
