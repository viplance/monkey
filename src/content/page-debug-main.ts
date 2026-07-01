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
