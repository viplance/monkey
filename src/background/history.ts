/**
 * Local browser-history lookup used to resolve a destination the agent named
 * but doesn't know the URL of (e.g. "jira").
 */

/**
 * Search the browser history for `query`. Returns a compact, de-duplicated list
 * of the most-visited matches as "title — url" lines, capped small so it costs
 * the model almost nothing. Returns an empty string when history is disabled or
 * nothing matches.
 */
export async function searchHistory(
  query: string,
  useHistory: boolean,
): Promise<string> {
  if (!useHistory) return "";
  if (!chrome.history?.search) return "";
  const term = query.trim();
  let items: chrome.history.HistoryItem[];
  try {
    items = await chrome.history.search({
      text: term,
      // Look back ~6 months; 0 startTime would also work but bounding it keeps
      // the result set relevant.
      startTime: Date.now() - 1000 * 60 * 60 * 24 * 180,
      maxResults: 50,
    });
  } catch {
    return "";
  }

  // Collapse to one entry per origin (the home/root is the useful target), rank
  // by total visit count, and keep only the top few.
  const byHost = new Map<string, { url: string; title: string; visits: number }>();
  for (const it of items) {
    if (!it.url) continue;
    let host: string;
    let origin: string;
    try {
      const u = new URL(it.url);
      host = u.hostname.replace(/^www\./, "");
      origin = u.origin;
    } catch {
      continue;
    }
    const prev = byHost.get(host);
    const visits = (prev?.visits ?? 0) + (it.visitCount ?? 1);
    // Prefer the shortest path as the representative URL (closest to the root).
    const keepUrl =
      !prev || it.url.length < prev.url.length ? origin || it.url : prev.url;
    byHost.set(host, {
      url: keepUrl,
      title: it.title || prev?.title || host,
      visits,
    });
  }

  const top = Array.from(byHost.values())
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 5);
  if (!top.length) return "";
  return top.map((m) => `${m.title} — ${m.url}`).join("\n");
}
