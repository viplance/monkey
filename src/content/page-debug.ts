import type { PageDebugEntry } from "../shared/types";

const CHANNEL = "__monkey_page_debug__";
const MAX_ENTRIES = 80;
const MAX_MESSAGE = 800;
const CONSOLE_LEVELS = ["debug", "log", "info", "warn", "error"] as const;

type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

interface RawDebugMessage {
  channel?: string;
  kind?: PageDebugEntry["kind"];
  level?: ConsoleLevel;
  message?: string;
  source?: string;
  line?: number;
  column?: number;
  ts?: number;
}

const entries: PageDebugEntry[] = [];
let installed = false;

function compact(value: string, max = MAX_MESSAGE): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizePart(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message || value.name;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function push(entry: PageDebugEntry) {
  entries.push({ ...entry, message: compact(entry.message) });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

function onPageDebugMessage(event: MessageEvent<RawDebugMessage>) {
  if (event.source !== window || event.data?.channel !== CHANNEL) return;
  const { kind, level, message, source, line, column, ts } = event.data;
  if (!kind || !level || !message) return;
  push({
    kind,
    level,
    message,
    source,
    line,
    column,
    ts: typeof ts === "number" ? ts : Date.now(),
  });
}

export function installPageDebugCollector() {
  if (installed) return;
  installed = true;
  window.addEventListener("message", onPageDebugMessage);

  window.addEventListener("error", (event) => {
    push({
      kind: "error",
      level: "error",
      message: event.error instanceof Error
        ? event.error.stack || event.error.message
        : event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      ts: Date.now(),
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    push({
      kind: "unhandledrejection",
      level: "error",
      message: normalizePart(event.reason),
      ts: Date.now(),
    });
  });
}

export function recentPageDebugEntries(): PageDebugEntry[] {
  return entries.slice(-20);
}
