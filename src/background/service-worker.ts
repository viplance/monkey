/**
 * Background service worker: the orchestrator.
 *
 * Holds the single source of truth (AgentState + Settings), talks to Gemini,
 * drives the content script, and broadcasts state to the side panel. The panel
 * is a thin renderer — all decisions live here.
 */

import {
  DEFAULT_SETTINGS,
  STORAGE_KEY,
  type AgentAction,
  type AgentState,
  type AutoRule,
  type BgToContent,
  type ChatMessage,
  type ContentReply,
  type PageContext,
  type PanelToBg,
  type PlanStep,
  type Settings,
  type TabKind,
} from "../shared/types";
import { listModels, nextAction, planTicket } from "./gemini";

// --- state ----------------------------------------------------------------

let state: AgentState = freshState();
let settings: Settings = { ...DEFAULT_SETTINGS };
/** Per-step running log of action descriptions, fed back to the model. */
let stepHistory: string[] = [];
/** Host of the page the pending action targets, for rule creation. */
let pendingHost = "";

/** Extract a bare host ("www.x.com" -> "x.com") for rule matching. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Create + persist an auto-rule from an approved action. */
async function addRuleFromAction(action: AgentAction, scope: "site" | "any") {
  const host = scope === "site" ? pendingHost || "*" : "*";
  const kindLabel: Record<string, string> = {
    click: "Click", type: "Type into fields", select: "Select options",
    scrollTo: "Scroll", navigate: "Navigate", extract: "Extract", waitFor: "Wait",
  };
  const where = host === "*" ? "any site" : host;
  const rule: AutoRule = {
    id: id(),
    kind: action.kind,
    host,
    label: `${kindLabel[action.kind] ?? action.kind} on ${where}`,
  };
  const rules = settings.autoRules ?? [];
  // Skip if an equivalent rule already exists.
  if (!rules.some((r) => r.kind === rule.kind && r.host === rule.host)) {
    settings = { ...settings, autoRules: [...rules, rule] };
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    chrome.runtime.sendMessage({ type: "SETTINGS", settings }).catch(() => {});
  }
}

/** True if any saved rule auto-approves this action on this host. */
function isAutoApproved(action: AgentAction, host: string): boolean {
  return (settings.autoRules ?? []).some((r) => {
    if (r.kind !== action.kind) return false;
    if (!r.host || r.host === "*") return true;
    const scope = r.host.replace(/^www\./, "");
    return host === scope || host.endsWith("." + scope);
  });
}

/**
 * Thrown when the active tab is a page extensions can't touch (chrome://, the
 * Web Store, New Tab, other extensions). It's a normal situation, not a
 * failure, so it's surfaced as a soft notice rather than the error state.
 */
class NotAutomatableError extends Error {}

function freshState(): AgentState {
  return {
    status: "idle",
    ticket: null,
    plan: [],
    activeStepId: null,
    messages: [],
    pendingAction: null,
    error: null,
    notice: null,
  };
}

function id() {
  return Math.random().toString(36).slice(2, 10);
}

function pushMsg(role: ChatMessage["role"], text: string, awaitingAnswer = false) {
  state.messages.push({ id: id(), role, text, awaitingAnswer, ts: Date.now() });
}

function broadcast() {
  chrome.runtime.sendMessage({ type: "STATE", state }).catch(() => {});
}

function setError(e: unknown) {
  // A non-automatable page is expected, not a failure: show a calm hint and
  // return to idle so the user can just switch tabs and retry.
  if (e instanceof NotAutomatableError) {
    state.status = state.plan.length ? "paused" : "idle";
    state.notice = e.message;
    broadcast();
    return;
  }
  const msg = e instanceof Error ? e.message : String(e);
  state.status = "error";
  state.error = msg;
  pushMsg("system", `⚠️ ${msg}`);
  broadcast();
}

// --- settings -------------------------------------------------------------

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] ?? {}) };
  return settings;
}

/**
 * Always read settings from storage before using them. The MV3 service worker
 * can be killed and restarted between messages, which resets the in-memory
 * `settings` to defaults (empty key). Reading storage on demand avoids the race
 * where a ticket starts before the initial async load finished.
 */
async function ensureSettings(): Promise<Settings> {
  return loadSettings();
}

// --- tab / content helpers ------------------------------------------------

/**
 * Page automatability (TabKind from shared types):
 *  - "ok":      a real http(s) page we can snapshot and act on.
 *  - "blank":   a blank/New Tab page — can't be scripted, but the agent CAN
 *               navigate it to a real URL first, so it's a valid launchpad.
 *  - "blocked": chrome://, the Web Store, devtools, etc. — neither scriptable
 *               nor navigable by us; the user must switch tabs.
 */
const BLANK_RE = /^(about:blank|chrome:\/\/newtab\/?|chrome:\/\/new-tab-page\/?|edge:\/\/newtab\/?)$/;
const BLOCKED_RE = /^(chrome|edge|brave|opera|about|chrome-extension|devtools|view-source|file):/;

function classifyUrl(url: string | undefined): TabKind {
  if (!url) return "blank";
  if (BLANK_RE.test(url)) return "blank";
  if (BLOCKED_RE.test(url)) return "blocked";
  if (url.startsWith("https://chromewebstore.google.com")) return "blocked";
  if (/^https?:\/\//.test(url)) return "ok";
  return "blocked";
}

async function activeTab(): Promise<{ id: number; kind: TabKind; url: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new NotAutomatableError("No active tab — open a normal web page to start.");
  }
  return { id: tab.id, kind: classifyUrl(tab.url), url: tab.url ?? "" };
}

/** Returns the active tab id, throwing the soft error for blocked pages. */
async function activeTabId(): Promise<number> {
  const tab = await activeTab();
  if (tab.kind === "blocked") {
    throw new NotAutomatableError(
      "Open a normal web page (http/https) to start — browser and store pages can't be automated.",
    );
  }
  return tab.id;
}

/** Resolve the built content script path from the manifest (hashed by Vite). */
function contentScriptFile(): string | null {
  const cs = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0];
  return cs ?? null;
}

/** Send a message to the content script, injecting it first if needed. */
async function toContent(tabId: number, msg: BgToContent): Promise<ContentReply> {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Content script not present (e.g. page loaded before install) — inject the
    // built (hashed) file referenced by the manifest, then retry.
    const file = contentScriptFile();
    if (!file) throw new Error("Content script unavailable.");
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

/** Snapshot a specific tab's DOM via the content script. */
async function snapshotTab(tabId: number): Promise<PageContext> {
  const reply = await toContent(tabId, { type: "SNAPSHOT" });
  if (reply.type !== "SNAPSHOT_RESULT") throw new Error("Failed to read page.");
  return reply.context;
}

/** A synthetic empty page so the planner navigates first from a blank tab. */
function blankContext(url: string): PageContext {
  return {
    url: url || "about:blank",
    title: "(blank tab)",
    elements: [],
    textExcerpt:
      "This is a blank/new tab with no content. Navigate to the appropriate URL first.",
  };
}

// --- core flow ------------------------------------------------------------

async function startTicket(ticket: string) {
  // Read fresh from storage — the worker may have restarted since the key was
  // saved, wiping the in-memory copy.
  await ensureSettings();
  if (!settings.apiKey) {
    setError("Add your Gemini API key in Settings first.");
    return;
  }

  // Validate the target page BEFORE touching state, so a blocked page only
  // shows the hint and never leaves the agent stuck in "planning…". A blank tab
  // is allowed: the agent will navigate it to a real URL as its first action.
  let tab: { id: number; kind: TabKind; url: string };
  try {
    tab = await activeTab();
    if (tab.kind === "blocked") {
      throw new NotAutomatableError(
        "Open a normal web page (http/https) to start — browser and store pages can't be automated.",
      );
    }
  } catch (e) {
    setError(e); // NotAutomatableError -> soft notice, stays idle
    return;
  }

  state = freshState();
  state.ticket = ticket;
  state.status = "planning";
  stepHistory = [];
  pushMsg("user", ticket);
  pushMsg(
    "system",
    tab.kind === "blank"
      ? "Blank tab — I'll navigate to the right page first, then plan."
      : "Reading the page and drafting a plan…",
  );
  broadcast();

  try {
    // On a blank launchpad we can't snapshot; give the planner an empty page so
    // it proposes a navigation first. On a real page, read the live DOM.
    const ctx =
      tab.kind === "blank" ? blankContext(tab.url) : await snapshotTab(tab.id);
    const draft = await planTicket(settings.apiKey, settings.model, ticket, ctx);
    if (!draft.length) throw new Error("Gemini returned an empty plan.");

    state.plan = draft.map((s, i): PlanStep => ({
      id: id(),
      title: s.title,
      detail: s.detail,
      status: i === 0 ? "active" : "pending",
    }));
    state.activeStepId = state.plan[0].id;
    pushMsg("agent", "Here's the plan. I'll propose the first action — review and confirm.");
    broadcast();
    await proposeNext();
  } catch (e) {
    setError(e);
  }
}

/** Ask Gemini for the next action of the active step and present it. */
async function proposeNext() {
  const step = state.plan.find((s) => s.id === state.activeStepId);
  if (!step) {
    finish();
    return;
  }
  state.status = "running";
  state.pendingAction = null;
  broadcast();

  try {
    // The current tab may still be a blank/blocked launchpad (e.g. before the
    // first navigate runs). Don't snapshot it — that would executeScript on
    // chrome:// and throw. Feed the planner an empty page so it navigates first.
    const tab = await activeTab();
    const tabId = tab.id;
    let ctx: PageContext;
    if (tab.kind === "ok") {
      ctx = await snapshotTab(tabId);
    } else if (tab.kind === "blank") {
      ctx = blankContext(tab.url);
    } else {
      throw new NotAutomatableError(
        "Open a normal web page (http/https) to continue — this page can't be automated.",
      );
    }
    console.log("[GBA] asking Gemini for next action…", { url: ctx.url, model: settings.model });
    const action = await nextAction(
      settings.apiKey,
      settings.model,
      state.ticket!,
      state.plan,
      step,
      ctx,
      stepHistory,
    );
    console.log("[GBA] Gemini proposed:", action);

    if (action.kind === "ask") {
      state.status = "paused";
      pushMsg("agent", action.rationale, true);
      broadcast();
      return;
    }

    if (action.kind === "done") {
      pushMsg("agent", `Step done: ${step.title}`);
      completeActiveStep();
      return;
    }

    // Highlight the target so the user sees what's about to happen.
    if (action.ref) {
      await toContent(tabId, { type: "HIGHLIGHT", refs: [action.ref] });
    }

    state.pendingAction = action;
    pendingHost = hostOf(ctx.url);
    pushMsg("agent", describe(action));

    // Auto-run when global auto-execute is on, or an auto-approval rule matches
    // this action on this host (e.g. the user previously chose "always allow").
    if (settings.autoExecute || isAutoApproved(action, pendingHost)) {
      await executePending();
    } else {
      state.status = "awaiting-confirm";
      broadcast();
    }
  } catch (e) {
    setError(e);
  }
}

function describe(a: AgentAction): string {
  switch (a.kind) {
    case "click":
      return `Click ${a.ref ?? "element"} — ${a.rationale}`;
    case "type":
      return `Type "${a.value ?? ""}" — ${a.rationale}`;
    case "select":
      return `Select "${a.value ?? ""}" — ${a.rationale}`;
    case "scrollTo":
      return `Scroll to ${a.ref ?? "element"} — ${a.rationale}`;
    case "navigate":
      return `Navigate to ${a.url} — ${a.rationale}`;
    case "extract":
      return `Extract from ${a.ref ?? "page"} — ${a.rationale}`;
    case "waitFor":
      return `Wait — ${a.rationale}`;
    default:
      return a.rationale;
  }
}

async function executePending() {
  const action = state.pendingAction;
  if (!action) return;
  try {
    if (action.kind === "navigate" && action.url) {
      // Navigation works even from a blank/chrome:// launchpad — we're leaving
      // that page — so don't apply the automatability guard here. Just grab the
      // raw active tab and load the URL.
      pushMsg("system", `Opening ${action.url} …`);
      broadcast();
      const tab = await activeTab();
      await chrome.tabs.update(tab.id, { url: action.url });
      await waitForTabLoad(tab.id);
      pushMsg("system", "Page loaded. Reading it…");
      broadcast();
    } else if (action.kind === "waitFor") {
      await new Promise((r) => setTimeout(r, 1200));
    } else {
      // All other actions touch the DOM, so the page must be automatable.
      const tabId = await activeTabId();
      const reply = await toContent(tabId, { type: "EXECUTE", action });
      if (reply.type === "EXECUTE_RESULT") {
        if (!reply.ok) throw new Error(reply.error ?? "Action failed on the page.");
        if (reply.extracted) pushMsg("agent", `Extracted: ${reply.extracted}`);
      }
    }

    stepHistory.push(`✓ ${describe(action)}`);
    // Clear any highlight on the current page (skip after navigation — it's a
    // fresh page with nothing highlighted, and may briefly be unscriptable).
    if (action.kind !== "navigate") {
      const t = await activeTab().catch(() => null);
      if (t) await toContent(t.id, { type: "CLEAR_HIGHLIGHT" }).catch(() => {});
    }
    state.pendingAction = null;
    // Loop: ask for the next action of the same step.
    await proposeNext();
  } catch (e) {
    setError(e);
  }
}

function completeActiveStep() {
  const idx = state.plan.findIndex((s) => s.id === state.activeStepId);
  if (idx === -1) return;
  state.plan[idx].status = "done";
  stepHistory = [];
  const next = state.plan[idx + 1];
  if (next) {
    next.status = "active";
    state.activeStepId = next.id;
    broadcast();
    void proposeNext();
  } else {
    finish();
  }
}

function finish() {
  state.status = "done";
  state.pendingAction = null;
  pushMsg("agent", "✅ All steps complete.");
  broadcast();
}

/**
 * Wait until the tab has actually committed to a real http(s) page and finished
 * loading. Navigating away from chrome://newtab fires intermediate onUpdated
 * events while the URL is still chrome:// — acting then throws "Cannot access a
 * chrome:// URL", so we must confirm the URL left the blocked scheme.
 */
function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    };
    const ready = (url?: string, status?: string) =>
      status === "complete" && !!url && /^https?:\/\//.test(url) &&
      classifyUrl(url) === "ok";

    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (id === tabId && ready(tab.url, info.status ?? tab.status)) finish();
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Also poll, in case the "complete" event landed before the listener or the
    // page restored from bfcache without an event.
    const poll = setInterval(async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (ready(t.url, t.status)) finish();
      } catch {
        /* tab gone */
      }
    }, 300);

    const timer = setTimeout(finish, 20000);
  });
}

// --- message routing ------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: PanelToBg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "GET_STATE":
        sendResponse({ type: "STATE", state });
        return;
      case "GET_SETTINGS":
        sendResponse({ type: "SETTINGS", settings: await ensureSettings() });
        return;
      case "SAVE_SETTINGS":
        settings = msg.settings;
        await chrome.storage.local.set({ [STORAGE_KEY]: settings });
        sendResponse({ type: "SETTINGS", settings });
        return;
      case "LIST_MODELS":
        try {
          const models = await listModels(msg.apiKey);
          sendResponse({ ok: true, models });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      case "GET_TAB_STATUS":
        try {
          const tab = await activeTab();
          sendResponse({ kind: tab.kind });
        } catch {
          sendResponse({ kind: "blocked" as TabKind });
        }
        return;
      case "START_TICKET":
        sendResponse({ ok: true });
        await startTicket(msg.ticket.trim());
        return;
      case "ANSWER":
        pushMsg("user", msg.text);
        stepHistory.push(`User answered: ${msg.text}`);
        sendResponse({ ok: true });
        await proposeNext();
        return;
      case "CONFIRM_ACTION":
        sendResponse({ ok: true });
        await executePending();
        return;
      case "CONFIRM_ACTION_ALWAYS":
        sendResponse({ ok: true });
        if (state.pendingAction) {
          await addRuleFromAction(state.pendingAction, msg.scope);
        }
        await executePending();
        return;
      case "REJECT_ACTION":
        if (msg.feedback) {
          pushMsg("user", msg.feedback);
          stepHistory.push(`User rejected last proposal: ${msg.feedback}`);
        } else {
          stepHistory.push("User rejected the last proposal; try a different approach.");
        }
        state.pendingAction = null;
        sendResponse({ ok: true });
        await proposeNext();
        return;
      case "ADVANCE_STEP":
        sendResponse({ ok: true });
        completeActiveStep();
        return;
      case "PAUSE":
        state.status = "paused";
        broadcast();
        sendResponse({ ok: true });
        return;
      case "RESUME":
        sendResponse({ ok: true });
        await proposeNext();
        return;
      case "RESET":
        state = freshState();
        stepHistory = [];
        broadcast();
        sendResponse({ ok: true });
        return;
    }
  })();
  return true; // keep the channel open for async sendResponse
});

// Clicking the toolbar icon opens the side panel. Set this on every worker
// startup (not just onInstalled) so it survives the service worker sleeping
// and re-running, and so it applies even if the extension predates this code.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn("setPanelBehavior failed:", e));

// Explicit fallback: if openPanelOnActionClick didn't take, open the panel
// directly from the click gesture. open() must be called synchronously within
// the user gesture, so we don't await anything before it.
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) =>
      console.warn("sidePanel.open failed:", e),
    );
  }
});

void loadSettings();
