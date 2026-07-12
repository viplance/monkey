const MONKEY_DEBUG_CHANNEL = "__monkey_page_debug__";

declare global {
  interface Window {
    __monkeyPageDebugInstalled?: boolean;
  }
}

function compactDebugValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message || value.name;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// This script runs in the page's own MAIN world (it needs direct access to
// window.onerror/unhandledrejection before the page's own handlers can
// intercept them), which means a page script can always forge a postMessage
// on this exact channel — no secret set up in this world stays hidden from
// the page, since it's the same `window` and MAIN-world scripts have no
// chrome.* APIs to coordinate a token through a channel the page can't see.
// The collector on the other end (./page-debug.ts) treats every entry here as
// page-controllable data, not a source of instructions: it's rendered inside
// the untrusted-content delimiters and capped in size/count so a forged flood
// can't crowd out real page content or itself be mistaken for a directive.
function emitDebug(payload: Record<string, unknown>) {
  try {
    window.postMessage(
      { channel: MONKEY_DEBUG_CHANNEL, ts: Date.now(), ...payload },
      "*",
    );
  } catch {
    /* ignore pages that block cross-context messaging */
  }
}

if (!window.__monkeyPageDebugInstalled) {
  window.__monkeyPageDebugInstalled = true;

  window.addEventListener("error", (event) => {
    emitDebug({
      kind: "error",
      level: "error",
      message:
        event.error instanceof Error
          ? event.error.stack || event.error.message
          : event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    emitDebug({
      kind: "unhandledrejection",
      level: "error",
      message: compactDebugValue(event.reason),
    });
  });
}

export {};
