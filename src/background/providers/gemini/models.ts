import { BASE } from "./client";

/** Rank a model id so newer/more-capable models sort first. */
function scoreModel(id: string): number {
  const v = id.match(/gemini-(\d+(?:\.\d+)?)/);
  const ver = v ? parseFloat(v[1]) : 0;
  const tier = /pro/.test(id) ? 0.5 : /flash-lite/.test(id) ? 0.1 : 0.3;
  return ver * 10 + tier;
}

/**
 * Fetch the models the given key can actually use, filtered to ones that
 * support generateContent (i.e. usable for our agent). Returns bare model ids
 * like "gemini-2.5-flash", newest-looking first. Throws on a bad key.
 */
export async function listModels(apiKey: string): Promise<string[]> {
  const res = await fetch(
    `${BASE}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const models: Array<{
    name: string;
    supportedGenerationMethods?: string[];
  }> = data?.models ?? [];

  const ids = models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    // Drop non-chat variants we never want as the agent model.
    .filter(
      (id) =>
        id.startsWith("gemini-") &&
        !/embedding|aqa|imagen|veo|image|tts|learnlm/i.test(id),
    );

  // Sort by descending version, "pro" before "flash" within a version, so the
  // newest/most-capable models surface at the top of the dropdown.
  return Array.from(new Set(ids)).sort((a, b) => scoreModel(b) - scoreModel(a));
}
