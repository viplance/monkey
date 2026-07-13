/**
 * Background service worker: the orchestrator.
 *
 * Holds the single source of truth (AgentState + Settings), talks to the
 * selected AI provider, drives the content script, and broadcasts state to the
 * side panel. The panel is a thin renderer — all decisions live here.
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
import { describe } from "./describe";
import { listModels, nextAction, planTicket } from "./providers/provider-router";
import {
  actionSignature,
  actionRepeatKey,
  compact,
  countBlockedRepeatedActionAttempts,
  countCompletedActions,
  countRepeatedActionAttempts,
  hasMeaningfulExtract,
  isNavigationTicket,
  isReportTicket,
  isReportingStep,
  looksLikeCredentialContent,
  looksLikeErrorPage,
  queryMatchesTicket,
  shouldFinishSatisfiedCloseRequest,
  shouldRetryTaskRestatement,
  shouldTreatAskAsResponse,
} from "./heuristics";
import { searchHistory } from "./history";
import { NotAutomatableError, blankContext, classifyUrl, hostOf } from "./tabs";

// --- state ----------------------------------------------------------------

let state: AgentState = freshState();
let settings: Settings = { ...DEFAULT_SETTINGS };
/** Monotonic run token. Pause/reset/start invalidate older async continuations. */
let flowId = 0;
/** Currently active provider request, if any, so Pause/Reset can abort the fetch. */
let activeProviderAbort: AbortController | null = null;
/** Per-step running log of action descriptions, fed back to the model. */
let stepHistory: string[] = [];
/** Cross-step memory for extracted/read content needed by final report steps. */
let runHistory: string[] = [];
/** Host of the page the pending action targets, for rule creation. */
let pendingHost = "";
/**
 * URL/title of the page the pending action was proposed against, captured at
 * the same time as pendingHost. executePending runs after either an
 * immediate auto-run or an async user confirmation — by then the model may
 * already be looking at a fresh snapshot for the *next* action, so this is
 * the only reliable record of "what page was this action actually taken on."
 * Used to tag stepHistory entries so a later action on a *different* page
 * (or the same page in a different state) is never confused for one taken
 * here — see executePending below.
 */
let pendingUrl = "";
let pendingTitle = "";
let pendingRepeatKey = "";
/**
 * Host the current run started on. Auto-execute/auto-rules for "type" and
 * "navigate" are restricted to this origin — a page that gets the agent to
 * fill a field or navigate to a *different* host is exactly the exfiltration
 * step used by prompt-injection attacks like BioShocking, so that hop always
 * requires a manual confirmation even if the user enabled auto-execute.
 */
let runOriginHost = "";
/**
 * Last URL seen (via proposeNext's snapshot) that did NOT look like an error
 * page, for the current run. The error-page "done" guard below offers this as
 * a recovery target (navigate back to it) when the model tries to finish a
 * navigation ticket while stuck on a broken page. Deliberately just a URL,
 * not a full page snapshot — the recovery step re-navigates and re-reads the
 * live page rather than trusting stale content.
 */
let lastGoodUrl = "";
/**
 * The tab a run is pinned to. Set when a ticket starts and used for every action
 * thereafter, so the agent keeps working in *that* tab even if the user switches
 * to a different one. `null` when no run owns a tab. If this tab is closed
 * mid-run we abort with an error (see the onRemoved listener below).
 */
let workTabId: number | null = null;
/**
 * Consecutive recoveries from a stale-ref ("element not found") failure. Bounded
 * so a genuinely missing target eventually surfaces as an error instead of
 * looping forever.
 */
let staleRetries = 0;
const MAX_STALE_RETRIES = 3;
/**
 * Circuit breaker against runaway loops. `stepCount` bounds the total number of
 * actions the model may take in a single run — a hard ceiling so no failure mode
 * can spin forever. `repeatSignature`/`repeatCount` catch the tighter loop where
 * the model keeps proposing the *same* action (e.g. re-navigating to an
 * unreachable URL): the page never changes, so the model never makes progress.
 */
let stepCount = 0;
const MAX_STEPS = 40;
let repeatSignature = "";
let repeatCount = 0;
const MAX_REPEATS = 3;
const NON_PROGRESS_REPEATABLE_ACTIONS: AgentAction["kind"][] = [
  "navigate",
  "click",
  "type",
  "select",
];
const MAX_RUN_HISTORY_CHARS = 60000;
const MAX_FINAL_REPORT_RETRIES = 2;
let finalReportRetries = 0;
let deliveredResponse = false;
/**
 * Consecutive times the model tried to end a navigation/find step with
 * kind="done" while the current page still looks like an error page (see
 * looksLikeErrorPage). Reset per-step like staleRetries — a step that
 * recovers shouldn't spend a later, unrelated step's budget. Bounded so a
 * genuinely unrecoverable site (down, geo-blocked, etc.) surfaces as an ask
 * instead of looping forever between "done" and a rejected retry.
 */
let errorRecoveryRetries = 0;
const MAX_ERROR_RECOVERY_RETRIES = 2;

/**
 * Everything a run needs to survive a service worker restart. MV3 kills the
 * worker after ~30s without extension activity, wiping all module state; the
 * snapshot in chrome.storage.session lets a restarted worker pick the run back
 * up instead of leaving the panel frozen on a stale "working…" broadcast.
 */
const RUN_SNAPSHOT_KEY = "monkey.runSnapshot";

interface RunSnapshot {
  state: AgentState;
  stepHistory: string[];
  runHistory: string[];
  workTabId: number | null;
  pendingHost: string;
  pendingUrl: string;
  pendingTitle: string;
  pendingRepeatKey: string;
  runOriginHost: string;
  lastGoodUrl: string;
  stepCount: number;
  staleRetries: number;
  repeatSignature: string;
  repeatCount: number;
  finalReportRetries: number;
  errorRecoveryRetries: number;
  deliveredResponse: boolean;
}

function persistRun() {
  const snap: RunSnapshot = {
    state,
    stepHistory,
    runHistory,
    workTabId,
    pendingHost,
    pendingUrl,
    pendingTitle,
    pendingRepeatKey,
    runOriginHost,
    lastGoodUrl,
    stepCount,
    staleRetries,
    repeatSignature,
    repeatCount,
    finalReportRetries,
    errorRecoveryRetries,
    deliveredResponse,
  };
  void chrome.storage.session.set({ [RUN_SNAPSHOT_KEY]: snap }).catch(() => {});
}

let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * MV3 terminates the service worker after ~30s of no extension activity, and a
 * pending fetch does NOT count as activity. A provider call may legitimately run
 * longer than that (the client allows 60s), so the worker could be killed
 * mid-request: the continuation vanishes, no error is ever delivered, and the
 * panel shows "working…" forever. While a run is busy, ping a trivial extension
 * API to reset the idle timer so in-flight work survives.
 */
function syncKeepAlive() {
  const busy = state.status === "planning" || state.status === "running";
  if (busy && keepAliveTimer === null) {
    keepAliveTimer = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  } else if (!busy && keepAliveTimer !== null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/** Reset the run-level circuit breaker. Call whenever a fresh run begins. */
function resetFuse() {
  staleRetries = 0;
  stepCount = 0;
  repeatSignature = "";
  repeatCount = 0;
  finalReportRetries = 0;
  errorRecoveryRetries = 0;
  deliveredResponse = false;
  pendingRepeatKey = "";
}

function combinedHistory(): string[] {
  return runHistory.length
    ? [
        "PREVIOUS COMPLETED STEPS / EXTRACTED MATERIALS:",
        ...runHistory,
        "CURRENT STEP HISTORY:",
        ...stepHistory,
      ]
    : stepHistory;
}

/**
 * Which stepHistory entries survive into runHistory once a step completes and
 * stepHistory itself is wiped. Originally only extract/history/navigation
 * failures were kept — but that silently dropped every ordinary type/click/
 * select, so the model would lose all memory of "I already typed this query"
 * the moment a step boundary crossed, and repeat it against the site. Keep
 * every completed action (`ACTION: `-tagged lines, which executePending now
 * also tags with the URL/page-title the action was taken on) plus the
 * existing extract/history/navigation-failure markers.
 */
function rememberCompletedStep(entries: string[]) {
  const useful = entries.filter(
    (entry) =>
      entry.includes("ACTION: ") ||
      entry.includes("EXTRACTED TEXT:") ||
      entry.includes("History matches") ||
      entry.includes("Navigation to "),
  );
  if (!useful.length) return;

  runHistory.push(...useful);
  let total = runHistory.join("\n\n").length;
  while (total > MAX_RUN_HISTORY_CHARS && runHistory.length > 1) {
    runHistory.shift();
    total = runHistory.join("\n\n").length;
  }
}

function needsFinalReport(step: PlanStep): boolean {
  return (
    isReportTicket(state.ticket) &&
    (isReportingStep(step) || state.plan[state.plan.length - 1]?.id === step.id) &&
    !deliveredResponse
  );
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
 * Final gate before an action is allowed to run without a manual click, on
 * top of global auto-execute / per-rule approval. Blocks the origin-hopping
 * pattern a page-content prompt-injection attack (e.g. BioShocking) relies on
 * for exfiltration: getting the agent to navigate or type into a host other
 * than the one the run started on (e.g. a hidden form posting to an attacker
 * domain). Credential-shaped *content* can only be judged once "extract" has
 * actually run (the rationale is just the model's pre-execution guess at why,
 * not the page data) — see the reply.extracted check in executePending,
 * which pauses the run instead of green-lighting further auto-actions.
 */
function isSafeToAutoRun(action: AgentAction, host: string): boolean {
  if ((action.kind === "navigate" || action.kind === "type") && runOriginHost) {
    const targetHost =
      action.kind === "navigate" && action.url ? hostOf(action.url) : host;
    if (targetHost && targetHost !== runOriginHost) return false;
  }
  return true;
}

/**
 * When the user manually confirms a pending "navigate" to a different host,
 * treat that as them steering the run there on purpose and widen the trusted
 * origin to match — otherwise every legitimate multi-site task (search on A,
 * open a result on B) would need a manual click for every action on B for the
 * rest of the run. Only manual confirmation widens the origin; an
 * auto-approved navigate (still possible via DEFAULT_RULES) never does, so a
 * malicious page can't use its own auto-run navigate to relocate trust.
 */
function widenRunOriginOnManualNavigate() {
  const action = state.pendingAction;
  if (action?.kind === "navigate" && action.url) {
    const targetHost = hostOf(action.url);
    if (targetHost) runOriginHost = targetHost;
  }
}

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
  // Every observable state change also adjusts the keepalive and persists the
  // run, so a worker restart can never strand the panel on a stale status.
  syncKeepAlive();
  persistRun();
}

function beginFlow(): number {
  flowId += 1;
  activeProviderAbort?.abort();
  activeProviderAbort = null;
  return flowId;
}

function cancelFlow(): number {
  return beginFlow();
}

function isCurrentFlow(flow: number): boolean {
  return flow === flowId;
}

function isCanceled(e: unknown): boolean {
  return e instanceof Error && /(?:Gemini|OpenAI|Anthropic) request canceled/i.test(e.message);
}

async function withProvider<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  activeProviderAbort = ctrl;
  try {
    return await fn(ctrl.signal);
  } finally {
    if (activeProviderAbort === ctrl) activeProviderAbort = null;
  }
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

/** Ids of shipped default rules retired from DEFAULT_RULES over time — dropped
 * from any persisted settings on load so removing one from the defaults
 * actually takes effect for existing installs, not just fresh ones. */
const RETIRED_BUILTIN_RULE_IDS = new Set(["builtin-extract"]);

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = (stored[STORAGE_KEY] ?? {}) as Partial<Settings>;
  settings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    apiKeys: {
      ...DEFAULT_SETTINGS.apiKeys,
      ...(raw.apiKeys ?? {}),
    },
  };
  if (raw.apiKey && !settings.apiKeys.gemini) {
    settings.apiKeys.gemini = raw.apiKey;
  }
  if (settings.autoRules?.some((r) => RETIRED_BUILTIN_RULE_IDS.has(r.id))) {
    settings = {
      ...settings,
      autoRules: settings.autoRules.filter((r) => !RETIRED_BUILTIN_RULE_IDS.has(r.id)),
    };
  }
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

function currentApiKey(): string {
  return settings.apiKeys?.[settings.provider] ?? "";
}

// --- tab / content helpers ------------------------------------------------

async function activeTab(): Promise<{ id: number; kind: TabKind; url: string }> {
  // Once a run is pinned to a tab, keep operating on *that* tab even if the user
  // switches away — otherwise the agent would start acting on whatever tab the
  // user happened to move to. Before a run starts (workTabId === null) fall back
  // to the current active tab so START/GET_TAB_STATUS pick the tab in view.
  if (workTabId !== null) {
    const tab = await chrome.tabs.get(workTabId).catch(() => null);
    if (!tab?.id) {
      throw new NotAutomatableError("User closed the active tab.");
    }
    return { id: tab.id, kind: classifyUrl(tab.url), url: tab.url ?? "" };
  }
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

/**
 * Resolve the built content script path from the *live* manifest (hashed by
 * Vite). Read fresh every time: the hash changes on each rebuild, and a stale
 * value would point at a file that no longer exists.
 */
function contentScriptFile(): string | null {
  const scripts = chrome.runtime.getManifest().content_scripts ?? [];
  for (const script of scripts) {
    const file = script.js?.find((js) => js.includes("content-script"));
    if (file) return file;
  }
  return null;
}

/**
 * Inject the built content script into a tab, turning the framework's opaque
 * "Could not load file: 'assets/…js'" into an actionable message. That error
 * means the running extension references a hashed asset that no longer exists on
 * disk — i.e. the code was rebuilt but the extension wasn't reloaded.
 */
async function injectContentScript(tabId: number): Promise<void> {
  const file = contentScriptFile();
  if (!file) throw new Error("Content script unavailable.");
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/could not load file/i.test(msg)) {
      throw new Error(
        "Extension is out of date — reload it at chrome://extensions (the page was built after this version loaded), then try again.",
      );
    }
    throw e;
  }
}

/** Send a message to the content script, injecting it first if needed. */
async function toContent(tabId: number, msg: BgToContent): Promise<ContentReply> {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Content script not present (e.g. page loaded before install) — inject the
    // built (hashed) file referenced by the manifest, then retry.
    await injectContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

/** Snapshot a specific tab's DOM via the content script. */
async function snapshotTab(tabId: number): Promise<PageContext> {
  const reply = await toContent(tabId, { type: "SNAPSHOT" });
  if (reply.type !== "SNAPSHOT_RESULT") throw new Error("Failed to read page.");
  return reply.context;
}

// --- core flow ------------------------------------------------------------

async function startTicket(ticket: string) {
  const flow = beginFlow();
  // Fresh run: unpin any previous tab so activeTab() picks the tab currently in
  // view for planning. It gets re-pinned below once we've validated it.
  workTabId = null;
  // Read fresh from storage — the worker may have restarted since the key was
  // saved, wiping the in-memory copy.
  await ensureSettings();
  if (!isCurrentFlow(flow)) return;
  if (!currentApiKey()) {
    setError(`Add your ${settings.provider} API key in Settings first.`);
    return;
  }

  // Validate the target page BEFORE touching state, so a blocked page only
  // shows the hint and never leaves the agent stuck in "planning…". A blank tab
  // is allowed: the agent will navigate it to a real URL as its first action.
  let tab: { id: number; kind: TabKind; url: string };
  try {
    tab = await activeTab();
    if (!isCurrentFlow(flow)) return;
    if (tab.kind === "blocked") {
      throw new NotAutomatableError(
        "Open a normal web page (http/https) to start — browser and store pages can't be automated.",
      );
    }
  } catch (e) {
    setError(e); // NotAutomatableError -> soft notice, stays idle
    return;
  }

  // Pin the run to this tab. From here on activeTab() resolves to it, so
  // switching tabs no longer redirects the agent to the wrong page, and closing
  // it aborts the run (see the onRemoved listener).
  workTabId = tab.id;
  runOriginHost = tab.kind === "ok" ? hostOf(tab.url) : "";
  lastGoodUrl = "";

  state = freshState();
  state.ticket = ticket;
  state.status = "planning";
  stepHistory = [];
  runHistory = [];
  resetFuse();
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
    if (!isCurrentFlow(flow)) return;
    const draft = await withProvider((signal) =>
      planTicket(settings.provider, currentApiKey(), settings.model, ticket, ctx, signal),
    );
    if (!isCurrentFlow(flow)) return;
    if (!draft.length) throw new Error("The selected provider returned an empty plan.");

    state.plan = draft.map((s, i): PlanStep => ({
      id: id(),
      title: s.title,
      detail: s.detail,
      status: i === 0 ? "active" : "pending",
    }));
    state.activeStepId = state.plan[0].id;
    pushMsg("agent", "Here's the plan. I'll propose the first action — review and confirm.");
    broadcast();
    await proposeNext(flow);
  } catch (e) {
    if (!isCurrentFlow(flow) || isCanceled(e)) return;
    setError(e);
  }
}

/** Ask the selected provider for the next action of the active step and present it. */
async function proposeNext(flow = flowId) {
  if (!isCurrentFlow(flow)) return;
  const step = state.plan.find((s) => s.id === state.activeStepId);
  if (!step) {
    finish();
    return;
  }
  // Circuit breaker: hard ceiling on total actions per run. Guarantees the loop
  // terminates even if every other safeguard is bypassed.
  if (++stepCount > MAX_STEPS) {
    setError(
      `Stopped after ${MAX_STEPS} actions without finishing — the task may be stuck (e.g. a page that won't load). Refine the request or check the site, then start again.`,
    );
    return;
  }
  state.status = "running";
  state.pendingAction = null;
  pendingRepeatKey = "";
  broadcast();

  try {
    // The current tab may still be a blank/blocked launchpad (e.g. before the
    // first navigate runs). Don't snapshot it — that would executeScript on
    // chrome:// and throw. Feed the planner an empty page so it navigates first.
    const tab = await activeTab();
    if (!isCurrentFlow(flow)) return;
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
    if (!isCurrentFlow(flow)) return;
    if (tab.kind === "ok" && !looksLikeErrorPage(ctx)) lastGoodUrl = ctx.url;
    console.log("[Monkey] asking provider for next action…", {
      provider: settings.provider,
      url: ctx.url,
      model: settings.model,
    });
    let action = await withProvider((signal) =>
      nextAction(
        settings.provider,
        currentApiKey(),
        settings.model,
        state.ticket!,
        state.plan,
        step,
        ctx,
        combinedHistory(),
        signal,
      ),
    );
    if (!isCurrentFlow(flow)) return;
    console.log("[Monkey] provider proposed:", action);

    // Circuit breaker: catch the tight loop where the model keeps proposing the
    // *same* side-effecting action (e.g. re-navigating to an unreachable URL).
    // The page never changes, so this never makes progress — bail out instead of
    // spinning. Terminal/internal actions (respond/ask/done/searchHistory) are
    // exempt: they either end the run or don't touch the page.
    const REPEATABLE: AgentAction["kind"][] = [
      "navigate", "click", "type", "select", "scrollTo", "waitFor", "extract",
    ];
    if (REPEATABLE.includes(action.kind)) {
      const sig = actionSignature(action);
      if (sig === repeatSignature) {
        if (++repeatCount >= MAX_REPEATS) {
          setError(
            `Stopped: the same action repeated ${MAX_REPEATS} times without making progress (${describe(action)}). ` +
              "The page may be unreachable or not responding. Check the site, then start again.",
          );
          return;
        }
      } else {
        repeatSignature = sig;
        repeatCount = 1;
      }
    }

    if (action.kind === "extract" && hasMeaningfulExtract(stepHistory, action)) {
      if (needsFinalReport(step)) {
        if (++finalReportRetries > MAX_FINAL_REPORT_RETRIES) {
          setError(
            "The agent reached the final reporting step but kept trying to read instead of producing the requested answer.",
          );
          return;
        }
        stepHistory.push(
          `Model tried to extract again during "${step.title}", but this is a final answer/report step. Do not read more unless critical content is missing; use the extracted materials above and return kind="respond" with the concise user-facing report.`,
        );
        await proposeNext(flow);
        return;
      }
      pushMsg("system", "Already extracted that content — moving to the next plan step.");
      completeActiveStep();
      return;
    }

    if (action.kind === "scrollTo" && countCompletedActions(stepHistory, "scrollTo") >= 3) {
      action = {
        kind: "extract",
        rationale:
          "Enough page content has been revealed; extract the loaded page content now instead of continuing to scroll.",
      };
    }

    if (NON_PROGRESS_REPEATABLE_ACTIONS.includes(action.kind)) {
      const repeatKey = actionRepeatKey(action, ctx);
      if (countRepeatedActionAttempts(stepHistory, repeatKey) > 0) {
        if (countBlockedRepeatedActionAttempts(stepHistory, repeatKey) > 0) {
          setError(
            `Stopped: the model kept retrying an action that already ran without making progress (${describe(action)}). ` +
              "Try a different instruction or adjust the page state, then start again.",
          );
          return;
        }
        stepHistory.push(
          `DUPLICATE ACTION BLOCKED: ${repeatKey}\n` +
            `Model proposed "${describe(action)}" again, but that action already ran in this step. Do not repeat it. ` +
            `Choose a different action: submit the already-filled field, click a search/apply button, use a different visible control, read the updated page, or ask the user if the page did not change.`,
        );
        await proposeNext(flow);
        return;
      }
    }

    if (action.kind === "respond") {
      respondAndComplete(action.rationale);
      return;
    }

    if (action.kind === "ask") {
      if (shouldFinishSatisfiedCloseRequest(state.ticket, state.messages, action)) {
        finishSatisfiedRequest("The popup is closed.");
        return;
      }
      // Same failure mode as the "done" guard below, one step earlier: the
      // model gave up and asked the user instead of finishing, but it hasn't
      // actually tried recovering from what looks like an error page yet.
      // Only nudge — don't block — once the recovery budget is exhausted, so
      // this can't out-loop the "done" guard's own retry ceiling.
      if (
        isNavigationTicket(state.ticket) &&
        looksLikeErrorPage(ctx) &&
        errorRecoveryRetries < MAX_ERROR_RECOVERY_RETRIES
      ) {
        errorRecoveryRetries++;
        stepHistory.push(
          `Model asked the user instead of continuing "${step.title}", but the current page looks like an error page ` +
            `(TITLE: "${ctx.title}"). Do not ask yet — this is a recoverable navigation failure. Try going back, ` +
            `navigating to the site's root, or using visible site navigation/search to reach the target again` +
            (lastGoodUrl && lastGoodUrl !== ctx.url
              ? `, or navigate to the last working page of this run (${lastGoodUrl})`
              : "") +
            `.`,
        );
        await proposeNext(flow);
        return;
      }
      if (shouldTreatAskAsResponse(stepHistory, action, step)) {
        if (shouldRetryTaskRestatement(stepHistory, action.rationale)) {
          stepHistory.push(
            `Model returned a task restatement as ask: "${action.rationale}". Do not ask the user; provide the actual user-facing answer now with kind="respond".`,
          );
          await proposeNext(flow);
          return;
        }
        respondAndComplete(action.rationale);
        return;
      }
      state.status = "paused";
      pushMsg("agent", action.rationale, true);
      broadcast();
      return;
    }

    if (action.kind === "done") {
      // The model finished a find/navigate/click step while the page it's
      // looking at still reads as an error page (see looksLikeErrorPage).
      // That's the "landed on 'Ошибка запроса', declared done" failure mode —
      // reject the done, offer concrete recovery options (including the last
      // URL that didn't look broken, if we have one), and let the model try
      // again instead of silently reporting the task as impossible.
      if (isNavigationTicket(state.ticket) && looksLikeErrorPage(ctx)) {
        if (++errorRecoveryRetries > MAX_ERROR_RECOVERY_RETRIES) {
          state.status = "paused";
          pushMsg(
            "agent",
            `I'm still stuck on what looks like an error page (${ctx.url}) after ${MAX_ERROR_RECOVERY_RETRIES} recovery attempts for "${step.title}". How should I proceed?`,
            true,
          );
          broadcast();
          return;
        }
        stepHistory.push(
          `Model tried to finish "${step.title}" with kind="done", but the current page looks like an error page ` +
            `(TITLE: "${ctx.title}"). This is a recoverable navigation failure, not task completion — do not return ` +
            `kind="done" or kind="ask" yet. Try, in order: go back to the previous page, navigate to the site's root, ` +
            `use visible site navigation/search to reach the target section again` +
            (lastGoodUrl && lastGoodUrl !== ctx.url
              ? `, or navigate to the last working page of this run (${lastGoodUrl})`
              : "") +
            `. Only use kind="ask" if none of these recovery paths are available.`,
        );
        await proposeNext(flow);
        return;
      }
      if (needsFinalReport(step)) {
        if (++finalReportRetries > MAX_FINAL_REPORT_RETRIES) {
          setError(
            "The agent reached the final reporting step without producing the requested answer. Please retry; the collected page text was preserved during this run but the model still returned done.",
          );
          return;
        }
        stepHistory.push(
          `Model tried to finish "${step.title}" with kind="done", but the original ticket asks for a final answer/report. Use the extracted materials above and return kind="respond" with the complete user-facing report.`,
        );
        await proposeNext(flow);
        return;
      }
      pushMsg("agent", `Step done: ${step.title}`);
      completeActiveStep();
      return;
    }

    // searchHistory is an internal "thinking" action: resolve a named
    // destination to a URL locally, feed the matches back, and immediately ask
    // for the next action. Nothing on the page changes, so it normally skips
    // confirmation — but it does expose local browsing destinations to the
    // model, so a query that isn't traceable to the user's own ticket (e.g.
    // one steered by page-injected content) must be confirmed like any other
    // action instead of running silently.
    if (action.kind === "searchHistory") {
      const query = action.value ?? "";
      if (!queryMatchesTicket(query, state.ticket)) {
        state.pendingAction = action;
        pendingHost = hostOf(ctx.url);
        pendingUrl = ctx.url;
        pendingTitle = ctx.title;
        pendingRepeatKey = actionRepeatKey(action, ctx);
        pushMsg(
          "agent",
          `Search browsing history for "${query}"? This isn't obviously related to your request — confirm before I look it up.`,
        );
        state.status = "awaiting-confirm";
        broadcast();
        return;
      }
      await runSearchHistory(action, flow);
      return;
    }

    // Highlight the target so the user sees what's about to happen.
    if (action.ref) {
      await toContent(tabId, { type: "HIGHLIGHT", refs: [action.ref] });
      if (!isCurrentFlow(flow)) return;
    }

    state.pendingAction = action;
    pendingHost = hostOf(ctx.url);
    pendingUrl = ctx.url;
    pendingTitle = ctx.title;
    pendingRepeatKey = actionRepeatKey(action, ctx);
    pushMsg("agent", describe(action));

    // Auto-run when global auto-execute is on, or an auto-approval rule matches
    // this action on this host (e.g. the user previously chose "always allow") —
    // but never bypass isSafeToAutoRun's cross-origin / credential checks.
    if (
      (settings.autoExecute || isAutoApproved(action, pendingHost)) &&
      isSafeToAutoRun(action, pendingHost)
    ) {
      await executePending(flow);
    } else {
      state.status = "awaiting-confirm";
      broadcast();
    }
  } catch (e) {
    if (!isCurrentFlow(flow) || isCanceled(e)) return;
    setError(e);
  }
}

function respondAndComplete(text: string) {
  pushMsg("agent", text);
  deliveredResponse = true;
  stepHistory.push(`✓ Responded to the user\nACTION: respond|ref=|value=|url=`);
  completeActiveStep();
}

function finishSatisfiedRequest(message: string) {
  for (const step of state.plan) {
    if (step.status !== "done") step.status = "done";
  }
  state.activeStepId = null;
  pushMsg("agent", message);
  finish();
}

/** Run a searchHistory action (confirmed or auto-approved) and loop. */
async function runSearchHistory(action: AgentAction, flow: number) {
  const query = action.value ?? "";
  const results = await searchHistory(query, settings.useHistory);
  if (!isCurrentFlow(flow)) return;
  pushMsg("agent", `Looked up history for "${query}".`);
  stepHistory.push(
    results
      ? `History matches for "${query}":\n${results}`
      : `History search for "${query}" found no matches${
          settings.useHistory ? "" : " (history lookup is disabled in Settings)"
        }.`,
  );
  state.pendingAction = null;
  pendingRepeatKey = "";
  await proposeNext(flow);
}

async function executePending(flow = flowId) {
  if (!isCurrentFlow(flow)) return;
  const action = state.pendingAction;
  if (!action) return;
  if (action.kind === "searchHistory") {
    await runSearchHistory(action, flow);
    return;
  }
  try {
    let extractedText: string | undefined;
    if (action.kind === "navigate" && action.url) {
      // Navigation works even from a blank/chrome:// launchpad — we're leaving
      // that page — so don't apply the automatability guard here. Just grab the
      // raw active tab and load the URL.
      pushMsg("system", `Opening ${action.url} …`);
      broadcast();
      const tab = await activeTab();
      if (!isCurrentFlow(flow)) return;
      await chrome.tabs.update(tab.id, { url: action.url });
      const loaded = await waitForTabLoad(tab.id);
      if (!isCurrentFlow(flow)) return;
      if (!loaded) {
        // The tab never reached a real, loaded http(s) page within the timeout —
        // the site is down, unreachable, or stuck. Record it and let the loop
        // continue: the model sees the failure in history and the repeat/step
        // fuses stop it if it keeps retrying a dead URL.
        pushMsg("system", `Couldn't load ${action.url} — the page didn't finish loading.`);
        stepHistory.push(
          `Navigation to ${action.url} failed: the page did not load (site may be down or unreachable). Do not retry the same URL; try a different approach or report that the site is unavailable.`,
        );
        broadcast();
        state.pendingAction = null;
        pendingRepeatKey = "";
        await proposeNext(flow);
        return;
      }
      pushMsg("system", "Page loaded. Reading it…");
      broadcast();
      // A run that started on a blank tab has no origin to protect yet — seed
      // it from the first page it lands on so the cross-origin gate in
      // isSafeToAutoRun actually engages for the rest of the run. Only seeds
      // when empty: once a real origin is set, only a manually-confirmed
      // navigate (see widenRunOriginOnManualNavigate) may change it — an
      // auto-approved navigate must never get to redefine "home".
      if (!runOriginHost) {
        const landedHost = hostOf(action.url);
        if (landedHost) runOriginHost = landedHost;
      }
    } else if (action.kind === "waitFor") {
      await new Promise((r) => setTimeout(r, 1200));
      if (!isCurrentFlow(flow)) return;
    } else {
      // All other actions touch the DOM, so the page must be automatable.
      const tabId = await activeTabId();
      if (!isCurrentFlow(flow)) return;
      const reply = await toContent(tabId, { type: "EXECUTE", action });
      if (!isCurrentFlow(flow)) return;
      if (reply.type === "EXECUTE_RESULT" && !reply.ok) {
        // A stale ref ("Element not found") usually means the page changed
        // between the snapshot the model saw and this execute (SPA re-render,
        // async load, re-injected content script). Rather than failing the run,
        // record what happened, re-snapshot, and let the model pick a fresh ref
        // on the next loop. This is the common cause of the agent "hanging" on
        // multi-step forms, so we recover instead of erroring out.
        if (++staleRetries <= MAX_STALE_RETRIES) {
          pushMsg(
            "system",
            "The target moved or re-rendered — re-reading the page and retrying…",
          );
          stepHistory.push(
            `Last action failed: ${reply.error ?? "element not found"}. The page changed; pick a fresh element from the new snapshot.`,
          );
          state.pendingAction = null;
          pendingRepeatKey = "";
          broadcast();
          await proposeNext(flow);
          return;
        }
        throw new Error(reply.error ?? "Action failed on the page.");
      }
      if (reply.type === "EXECUTE_RESULT" && reply.extracted) {
        extractedText = reply.extracted;
        pushMsg("agent", `Extracted: ${compact(reply.extracted)}`);
        // The rationale can't be checked before execution — it's the model's
        // guess at *why*, not the page data itself — so this is the earliest
        // point the real content is known. If it looks credential-shaped,
        // don't just warn: pause the run so a page can't chain this straight
        // into an auto-approved type/navigate that ships the data out.
        if (looksLikeCredentialContent(reply.extracted)) {
          pushMsg(
            "system",
            "⚠️ The extracted content looks like it may include a password, API key, or token. Pausing for review before continuing.",
          );
          stepHistory.push(
            `✓ ${describe(action)}\nACTION: ${actionSignature(action)}\nREPEAT_KEY: ${pendingRepeatKey || actionRepeatKey(action)}\nEXTRACTED TEXT:\n${extractedText}`,
          );
          state.pendingAction = null;
          pendingRepeatKey = "";
          state.status = "paused";
          broadcast();
          return;
        }
      }
      // A type-with-submit (pressed Enter) may kick off a full navigation
      // (classic search forms) or an in-page SPA update. Wait for it to settle
      // so the next snapshot reads the results page, not the one we just left.
      if (action.kind === "type" && action.submit) {
        await settleAfterSubmit(tabId);
        if (!isCurrentFlow(flow)) return;
      }
      // A click frequently opens a menu/dropdown/dialog or applies a filter —
      // all of which mutate the DOM *asynchronously* (React re-render, CSS
      // transition) or trigger a navigation. Snapshotting immediately reads the
      // pre-open page, so the model never sees the options it just revealed and
      // re-clicks the same control until the repeat fuse stops the run (the
      // Trendyol sort-dropdown loop). Let it settle first.
      if (action.kind === "click") {
        await settleAfterClick(tabId);
        if (!isCurrentFlow(flow)) return;
      }
    }

    // A successful action clears the stale-ref retry budget.
    staleRetries = 0;

    // Tag with the URL/title of the page the action was actually taken on
    // (captured in pendingUrl/pendingTitle when it was proposed) — the same
    // ref or the same-looking field can exist on multiple pages or in
    // multiple states of the same page, so a later step reading this history
    // needs to know *where* this happened, not just *that* it happened.
    const onPage = pendingUrl ? ` (on ${pendingUrl}${pendingTitle ? ` "${pendingTitle}"` : ""})` : "";
    const repeatKey = pendingRepeatKey || actionRepeatKey(action);
    stepHistory.push(
      extractedText
        ? `✓ ${describe(action)}${onPage}\nACTION: ${actionSignature(action)}\nREPEAT_KEY: ${repeatKey}\nEXTRACTED TEXT:\n${extractedText}`
        : `✓ ${describe(action)}${onPage}\nACTION: ${actionSignature(action)}\nREPEAT_KEY: ${repeatKey}`,
    );
    // Clear any highlight on the current page (skip after navigation — it's a
    // fresh page with nothing highlighted, and may briefly be unscriptable).
    if (action.kind !== "navigate") {
      const t = await activeTab().catch(() => null);
      if (!isCurrentFlow(flow)) return;
      if (t) await toContent(t.id, { type: "CLEAR_HIGHLIGHT" }).catch(() => {});
      if (!isCurrentFlow(flow)) return;
    }
    state.pendingAction = null;
    pendingRepeatKey = "";
    // Loop: ask for the next action of the same step.
    await proposeNext(flow);
  } catch (e) {
    if (!isCurrentFlow(flow) || isCanceled(e)) return;
    setError(e);
  }
}

function completeActiveStep(flow = flowId) {
  if (!isCurrentFlow(flow)) return;
  const idx = state.plan.findIndex((s) => s.id === state.activeStepId);
  if (idx === -1) return;
  rememberCompletedStep(stepHistory);
  state.plan[idx].status = "done";
  stepHistory = [];
  // A completed step is real progress: reset the per-run repeat/stale counters
  // so the next step starts with a full budget. Keep `stepCount` — it's the
  // whole-run ceiling.
  staleRetries = 0;
  repeatSignature = "";
  repeatCount = 0;
  errorRecoveryRetries = 0;
  const next = state.plan[idx + 1];
  if (next) {
    next.status = "active";
    state.activeStepId = next.id;
    broadcast();
    void proposeNext(flow);
  } else {
    finish();
  }
}

function finish() {
  if (isReportTicket(state.ticket) && !deliveredResponse) {
    state.status = "error";
    state.pendingAction = null;
    pendingRepeatKey = "";
    workTabId = null;
    const message =
      "Stopped before completion: the task asks for a final answer/report, but the model tried to finish without sending one.";
    state.error = message;
    pushMsg("system", `⚠️ ${message}`);
    broadcast();
    return;
  }
  state.status = "done";
  state.pendingAction = null;
  pendingRepeatKey = "";
  workTabId = null; // Run is over — release the pinned tab.
  pushMsg("agent", "✅ All steps complete.");
  broadcast();
}

/**
 * After Enter was pressed in a field, watch the tab briefly: if a navigation
 * started, wait for it to finish; if nothing starts within ~1.5s, assume the
 * update was in-page (SPA) and return so the loop can re-snapshot.
 */
async function settleAfterSubmit(tabId: number): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === "loading") {
      await waitForTabLoad(tabId);
      return;
    }
  }
}

/**
 * After a click, give the page a beat to react before the next snapshot. A
 * click can do one of three things, and the next snapshot must reflect the
 * result of whichever it was:
 *  - start a navigation (clicked a link/filter that reloads) — wait for it;
 *  - open a menu/dropdown/dialog in-page (React re-render + CSS transition) —
 *    a short fixed pause lets those nodes mount so the model sees the options;
 *  - do nothing observable — the same short pause just costs a fraction of a
 *    second.
 * Without this, an async dropdown (e.g. Trendyol's "Önerilen Sıralama" sort
 * menu) isn't in the DOM yet when we re-snapshot, so the model re-clicks the
 * closed control until the repeat fuse aborts the run.
 */
async function settleAfterClick(tabId: number): Promise<void> {
  // First, let a navigation (if any) declare itself; ~600ms covers the gap
  // before the tab flips to "loading".
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === "loading") {
      await waitForTabLoad(tabId);
      return;
    }
  }
  // No navigation — an in-page change. Wait once more for React/animation to
  // commit the opened overlay to the DOM before the next snapshot reads it.
  await new Promise((r) => setTimeout(r, 400));
}

/**
 * Wait until the tab has actually committed to a real http(s) page and finished
 * loading. Navigating away from chrome://newtab fires intermediate onUpdated
 * events while the URL is still chrome:// — acting then throws "Cannot access a
 * chrome:// URL", so we must confirm the URL left the blocked scheme.
 */
function waitForTabLoad(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearInterval(poll);
      clearTimeout(timer);
      resolve(ok);
    };
    const ready = (url?: string, status?: string) =>
      status === "complete" && !!url && /^https?:\/\//.test(url) &&
      classifyUrl(url) === "ok";

    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (id === tabId && ready(tab.url, info.status ?? tab.status)) finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Also poll, in case the "complete" event landed before the listener or the
    // page restored from bfcache without an event.
    const poll = setInterval(async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (ready(t.url, t.status)) finish(true);
      } catch {
        /* tab gone */
      }
    }, 300);

    // Timed out: the page never committed to a loaded http(s) page. Resolve
    // `false` so the caller can surface an "unreachable" message instead of
    // pretending the page loaded and looping.
    const timer = setTimeout(() => finish(false), 20000);
  });
}

// --- recovery after a worker restart ---------------------------------------

/**
 * Restore the last run from storage.session into a freshly started worker. If
 * the worker died while busy (planning/running), the async continuation is
 * gone and the run can't make progress on its own — downgrade it to "paused"
 * so the user sees an honest status and can press Resume, instead of a
 * "working…" spinner that never ends. Terminal and waiting states
 * (awaiting-confirm/paused/done/error) are restored as-is, so confirming an
 * action still works even after the worker slept while the user was thinking.
 */
async function rehydrate(): Promise<void> {
  let snap: RunSnapshot | undefined;
  try {
    const stored = await chrome.storage.session.get(RUN_SNAPSHOT_KEY);
    snap = stored[RUN_SNAPSHOT_KEY] as RunSnapshot | undefined;
  } catch {
    return;
  }
  // Only restore into a virgin worker; never clobber a run that has already
  // started, and don't bother restoring an idle snapshot.
  if (!snap?.state || snap.state.status === "idle") return;
  if (flowId !== 0 || state.status !== "idle") return;

  state = snap.state;
  stepHistory = snap.stepHistory ?? [];
  runHistory = snap.runHistory ?? [];
  workTabId = snap.workTabId ?? null;
  pendingHost = snap.pendingHost ?? "";
  pendingUrl = snap.pendingUrl ?? "";
  pendingTitle = snap.pendingTitle ?? "";
  pendingRepeatKey = snap.pendingRepeatKey ?? "";
  runOriginHost = snap.runOriginHost ?? "";
  lastGoodUrl = snap.lastGoodUrl ?? "";
  stepCount = snap.stepCount ?? 0;
  staleRetries = snap.staleRetries ?? 0;
  repeatSignature = snap.repeatSignature ?? "";
  repeatCount = snap.repeatCount ?? 0;
  finalReportRetries = snap.finalReportRetries ?? 0;
  errorRecoveryRetries = snap.errorRecoveryRetries ?? 0;
  deliveredResponse = snap.deliveredResponse ?? false;

  if (state.status === "planning" || state.status === "running") {
    state.status = "paused";
    state.pendingAction = null;
    pendingRepeatKey = "";
    state.notice =
      "The background worker was restarted mid-run. Press Resume to continue.";
  }
  broadcast();
}

const rehydrated = rehydrate();

// --- message routing ------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: PanelToBg, _sender, sendResponse) => {
  (async () => {
    // If the worker was just (re)started, finish restoring the previous run
    // before handling anything — otherwise GET_STATE would answer "idle" and
    // CONFIRM/RESUME would act on empty state.
    await rehydrated;
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
          const models = await listModels(msg.provider, msg.apiKey);
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
        await proposeNext(flowId);
        return;
      case "CONFIRM_ACTION":
        widenRunOriginOnManualNavigate();
        sendResponse({ ok: true });
        await executePending(flowId);
        return;
      case "CONFIRM_ACTION_ALWAYS":
        widenRunOriginOnManualNavigate();
        sendResponse({ ok: true });
        if (state.pendingAction) {
          await addRuleFromAction(state.pendingAction, msg.scope);
        }
        await executePending(flowId);
        return;
      case "REJECT_ACTION":
        if (msg.feedback) {
          pushMsg("user", msg.feedback);
          stepHistory.push(`User rejected last proposal: ${msg.feedback}`);
        } else {
          stepHistory.push("User rejected the last proposal; try a different approach.");
        }
        state.pendingAction = null;
        pendingRepeatKey = "";
        sendResponse({ ok: true });
        await proposeNext(flowId);
        return;
      case "ADVANCE_STEP":
        sendResponse({ ok: true });
        completeActiveStep(flowId);
        return;
      case "PAUSE":
        cancelFlow();
        state.status = "paused";
        broadcast();
        sendResponse({ ok: true });
        return;
      case "RESUME":
        sendResponse({ ok: true });
        if (!state.plan.length && state.ticket) {
          await startTicket(state.ticket);
        } else {
          await proposeNext(flowId);
        }
        return;
      case "RESET":
        cancelFlow();
        state = freshState();
        stepHistory = [];
        runHistory = [];
        resetFuse();
        pendingHost = "";
        pendingUrl = "";
        pendingTitle = "";
        pendingRepeatKey = "";
        runOriginHost = "";
        lastGoodUrl = "";
        workTabId = null;
        broadcast();
        sendResponse({ ok: true });
        return;
    }
  })();
  return true; // keep the channel open for async sendResponse
});

// If the tab a run is pinned to is closed, stop the run: there's nothing left to
// operate on. Abort any in-flight flow so pending continuations don't resurface,
// then surface a clear error to the user.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (workTabId === null || tabId !== workTabId) return;
  workTabId = null;
  cancelFlow();
  setError(new Error("User closed the active tab."));
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
