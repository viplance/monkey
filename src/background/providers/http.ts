/** Shared fetch-with-timeout/abort helper used by the OpenAI and Anthropic clients. */

const REQUEST_TIMEOUT_MS = 60000;

function withTimeout(signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const abortFromCaller = () => ctrl.abort();
  if (signal?.aborted) abortFromCaller();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

/**
 * Fetch JSON with a timeout/abort and a consistent error shape:
 * "<providerLabel> <status>: <body>" on HTTP errors, "<providerLabel> request
 * timed out/canceled/failed" otherwise.
 */
export async function fetchJson(
  url: string,
  init: RequestInit,
  providerLabel: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const timed = withTimeout(signal);
  try {
    const res = await fetch(url, { ...init, signal: timed.signal });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${providerLabel} ${res.status}: ${body.slice(0, 400)}`);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      if (signal?.aborted) throw new Error(`${providerLabel} request canceled.`);
      throw new Error(`${providerLabel} request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    if (e instanceof Error && new RegExp(`^${providerLabel} \\d`).test(e.message)) throw e;
    throw new Error(`${providerLabel} request failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    timed.cleanup();
  }
}
