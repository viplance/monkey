/**
 * Shared types used across the side panel, background worker, and content
 * script. Keep this file dependency-free so every context can import it.
 */

export type ActionKind =
  | "click"
  | "type"
  | "select"
  | "scrollTo"
  | "navigate"
  | "extract"
  | "waitFor"
  | "searchHistory"
  | "respond"
  | "done"
  | "ask";

/** A single executable action the agent proposes for the current step. */
export interface AgentAction {
  kind: ActionKind;
  /** Stable ref into the element map (see ElementSnapshot.ref). */
  ref?: string;
  /** Text to type (kind="type") or option label/value (kind="select"). */
  value?: string;
  /**
   * kind="type" only: press Enter after typing (and submit the enclosing form
   * if the page doesn't handle the key itself). Needed for search boxes —
   * typing alone never runs the search.
   */
  submit?: boolean;
  /** URL for kind="navigate". */
  url?: string;
  /** Human-readable reason shown to the user before confirming. */
  rationale: string;
}

/** One step of the high-level plan derived from the ticket. */
export interface PlanStep {
  id: string;
  title: string;
  /** Short description of the goal of this step. */
  detail: string;
  status: "pending" | "active" | "done" | "skipped";
}

export interface ElementSnapshot {
  /** Opaque id the content script can resolve back to a live element. */
  ref: string;
  tag: string;
  role?: string;
  /** Trimmed visible/accessible label. */
  label: string;
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  /** True when in the viewport and clickable. */
  visible: boolean;
}

export interface PageDebugEntry {
  kind: "console" | "error" | "unhandledrejection";
  level: "log" | "info" | "warn" | "error" | "debug";
  message: string;
  source?: string;
  line?: number;
  column?: number;
  ts: number;
}

export interface PageContext {
  url: string;
  title: string;
  /** Compact, ranked list of interactive elements. */
  elements: ElementSnapshot[];
  /** Trimmed visible text for grounding (capped). */
  textExcerpt: string;
  /** Recent page errors collected by the content script, newest last. */
  debugEntries?: PageDebugEntry[];
}

/** Chat turn rendered in the side panel. */
export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  /** Optional clarifying question that expects a reply. */
  awaitingAnswer?: boolean;
  ts: number;
}

export type RunStatus = "idle" | "planning" | "awaiting-confirm" | "running" | "paused" | "done" | "error";

/** Full agent state mirrored into the side panel. */
export interface AgentState {
  status: RunStatus;
  ticket: string | null;
  plan: PlanStep[];
  activeStepId: string | null;
  messages: ChatMessage[];
  /** The action currently proposed and awaiting user confirmation. */
  pendingAction: AgentAction | null;
  error: string | null;
  /**
   * A soft, non-error hint (e.g. "open a normal web page"). Unlike `error`,
   * this does not put the agent in the error state and is dismissed as soon as
   * the user retries on a valid page.
   */
  notice: string | null;
}

// ---------------------------------------------------------------------------
// Messaging contract
// ---------------------------------------------------------------------------

/** Messages: side panel -> background. */
export type PanelToBg =
  | { type: "GET_STATE" }
  | { type: "START_TICKET"; ticket: string }
  | { type: "ANSWER"; text: string }
  | { type: "CONFIRM_ACTION" }
  /** Confirm + remember: create an auto-rule. scope "site" = this host only. */
  | { type: "CONFIRM_ACTION_ALWAYS"; scope: "site" | "any" }
  | { type: "REJECT_ACTION"; feedback?: string }
  | { type: "ADVANCE_STEP" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "RESET" }
  | { type: "SAVE_SETTINGS"; settings: Settings }
  | { type: "GET_SETTINGS" }
  | { type: "LIST_MODELS"; apiKey: string }
  | { type: "GET_TAB_STATUS" };

/** Automatability of the active tab, as seen by the panel. */
export type TabKind = "ok" | "blank" | "blocked";

/** Messages: background -> side panel (broadcast). */
export type BgToPanel =
  | { type: "STATE"; state: AgentState }
  | { type: "SETTINGS"; settings: Settings };

/** Messages: background -> content script. */
export type BgToContent =
  | { type: "SNAPSHOT" }
  | { type: "HIGHLIGHT"; refs: string[] }
  | { type: "CLEAR_HIGHLIGHT" }
  | { type: "EXECUTE"; action: AgentAction };

/** Replies: content script -> background. */
export type ContentReply =
  | { type: "SNAPSHOT_RESULT"; context: PageContext }
  | { type: "EXECUTE_RESULT"; ok: boolean; extracted?: string; error?: string }
  | { type: "ACK" };

/**
 * An auto-approval rule: an action matching it runs without asking for
 * confirmation. Created from built-in defaults or when the user chooses
 * "always allow" on a proposed action.
 */
export interface AutoRule {
  id: string;
  /** Action kind this rule auto-approves. */
  kind: ActionKind;
  /**
   * Optional host scope. Empty/"*" = any site. Otherwise matches the action's
   * page host (e.g. "facebook.com"), including subdomains.
   */
  host: string;
  /** Human-readable label shown in the rules list. */
  label: string;
  /** true for the shipped defaults the user can still delete. */
  builtin?: boolean;
}

export interface Settings {
  apiKey: string;
  model: string;
  /** When true, run steps without confirming each individual action. */
  autoExecute: boolean;
  /** Per-action auto-approval rules. */
  autoRules: AutoRule[];
  /**
   * When true, the agent may search the browser history (chrome.history) to
   * resolve a named destination (e.g. "open Jira") to a concrete URL. Lookups
   * are local and on-demand — only a handful of matches are ever sent to the
   * model — so this adds no per-query token cost unless the agent actually
   * needs a URL it doesn't know.
   */
  useHistory: boolean;
}

/**
 * Default rules: navigation and search/extract are low-risk and noisy to
 * confirm, so they're auto-approved out of the box (the user can delete them).
 */
export const DEFAULT_RULES: AutoRule[] = [
  { id: "builtin-navigate", kind: "navigate", host: "*", label: "Navigate to any URL", builtin: true },
  { id: "builtin-extract", kind: "extract", host: "*", label: "Extract page content", builtin: true },
  { id: "builtin-scroll", kind: "scrollTo", host: "*", label: "Scroll to elements", builtin: true },
  { id: "builtin-wait", kind: "waitFor", host: "*", label: "Wait for the page", builtin: true },
];

/**
 * Fallback model list shown before a key is entered (or if ListModels fails).
 * Once a valid key is saved the Settings view replaces this with the live list
 * from the API. Newest/most-capable first. Keep IDs in sync with what the
 * Gemini API actually serves — the live fetch is the source of truth.
 */
export const FALLBACK_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  // Fast, capable default; users can pick any model their key supports.
  model: "gemini-3.5-flash",
  autoExecute: false,
  autoRules: DEFAULT_RULES,
  useHistory: true,
};

export const STORAGE_KEY = "gba.settings";
