import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  type AgentState,
  type BgToPanel,
  type PanelToBg,
  type Settings,
  type TabKind,
} from "../shared/types";
import { Settings as SettingsView } from "./Settings";

const send = (msg: PanelToBg): Promise<unknown> => chrome.runtime.sendMessage(msg);

const EMPTY: AgentState = {
  status: "idle",
  ticket: null,
  plan: [],
  activeStepId: null,
  messages: [],
  pendingAction: null,
  error: null,
  notice: null,
};

export function App() {
  const [state, setState] = useState<AgentState>(EMPTY);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState("");
  const [tabKind, setTabKind] = useState<TabKind>("ok");
  const logRef = useRef<HTMLDivElement>(null);

  // Subscribe to background broadcasts + hydrate initial state.
  useEffect(() => {
    const listener = (msg: BgToPanel) => {
      if (msg.type === "STATE") setState(msg.state);
      if (msg.type === "SETTINGS") setSettings(msg.settings);
    };
    chrome.runtime.onMessage.addListener(listener);
    send({ type: "GET_STATE" }).then((r) => {
      if (r && (r as BgToPanel).type === "STATE") setState((r as { state: AgentState }).state);
    });
    send({ type: "GET_SETTINGS" }).then((r) => {
      if (r && (r as BgToPanel).type === "SETTINGS")
        setSettings((r as { settings: Settings }).settings);
    });
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [state.messages]);

  // Track whether the active tab can be automated, so we can disable Go on
  // blocked pages. Re-check when the panel regains focus or tabs change.
  useEffect(() => {
    const refresh = () =>
      send({ type: "GET_TAB_STATUS" }).then((r) => {
        if (r && typeof (r as { kind?: TabKind }).kind === "string")
          setTabKind((r as { kind: TabKind }).kind);
      });
    refresh();
    window.addEventListener("focus", refresh);
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onUpdated.addListener(refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      chrome.tabs.onActivated.removeListener(refresh);
      chrome.tabs.onUpdated.removeListener(refresh);
    };
  }, []);

  const lastMsg = state.messages[state.messages.length - 1];
  const awaitingAnswer = lastMsg?.awaitingAnswer && state.status === "paused";
  const busy = state.status === "planning" || state.status === "running";
  // A blocked page (chrome://, store, devtools) can't start a ticket. A blank
  // tab is fine — the agent navigates away first. Answering a question is
  // always allowed regardless of the page.
  const pageBlocked = tabKind === "blocked";
  const goDisabled =
    (busy && !awaitingAnswer) || (pageBlocked && !awaitingAnswer) || !settings.apiKey;

  function submitTicket() {
    const t = input.trim();
    if (!t) return;
    if (awaitingAnswer) {
      send({ type: "ANSWER", text: t });
    } else {
      if (goDisabled) return; // guard: don't start on a blocked page
      send({ type: "START_TICKET", ticket: t });
    }
    setInput("");
  }

  if (showSettings) {
    return (
      <SettingsView
        settings={settings}
        onSave={async (s) => {
          // Await persistence before closing so the worker has the key on disk
          // even if it restarts immediately after.
          await send({ type: "SAVE_SETTINGS", settings: s });
          setSettings(s);
          setShowSettings(false);
        }}
        onClose={() => setShowSettings(false)}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">🐵 Monkey Browser AI</span>
        <div className="topbar-actions">
          <StatusPill status={state.status} />
          <button className="icon-btn" title="Settings" onClick={() => setShowSettings(true)}>
            ⚙️
          </button>
        </div>
      </header>

      {!settings.apiKey && (
        <div className="banner">
          No API key set.{" "}
          <button className="link" onClick={() => setShowSettings(true)}>
            Add your Gemini key
          </button>{" "}
          to start.
        </div>
      )}

      {pageBlocked && (
        <div className="banner">
          ⛔ This page can't be automated (browser/store/internal). Switch to a
          normal web page to start.
        </div>
      )}

      {state.notice && (
        <div className="banner banner-hint">💡 {state.notice}</div>
      )}

      {state.plan.length > 0 && (
        <section className="plan">
          <div className="plan-head">Plan</div>
          <ol>
            {state.plan.map((s) => (
              <li key={s.id} className={`step step-${s.status}`}>
                <span className="step-icon">
                  {s.status === "done" ? "✓" : s.status === "active" ? "▶" : "○"}
                </span>
                <span className="step-title" title={s.detail}>
                  {s.title}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="log" ref={logRef}>
        {state.messages.length === 0 && (
          <div className="empty">
            Describe a ticket — e.g. <em>"Find the cheapest flight to Berlin next Friday"</em>.
            I'll draft a plan, then propose each action for you to confirm.
          </div>
        )}
        {state.messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            {m.text}
          </div>
        ))}
      </div>

      {state.pendingAction && state.status === "awaiting-confirm" && (
        <div className="pending">
          <div className="pending-label">Proposed action</div>
          <div className="pending-rationale">{state.pendingAction.rationale}</div>
          <div className="pending-actions">
            <button className="btn primary" onClick={() => send({ type: "CONFIRM_ACTION" })}>
              ✓ Run
            </button>
            <button
              className="btn"
              title="Run now and auto-approve this action type on this site from now on"
              onClick={() => send({ type: "CONFIRM_ACTION_ALWAYS", scope: "site" })}
            >
              ✓✓ Always allow
            </button>
            <button
              className="btn"
              onClick={() => send({ type: "REJECT_ACTION", feedback: feedback || undefined })}
            >
              ✕ Skip
            </button>
            <button className="btn ghost" onClick={() => send({ type: "ADVANCE_STEP" })}>
              Next step ⏭
            </button>
          </div>
          <input
            className="feedback"
            placeholder="Optional: tell me what to do instead…"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onBlur={() => setFeedback(feedback)}
          />
        </div>
      )}

      <div className="controls">
        {busy && <span className="spinner">● working…</span>}
        {state.status === "paused" && !awaitingAnswer && (
          <button className="btn" onClick={() => send({ type: "RESUME" })}>
            ▶ Resume
          </button>
        )}
        {busy && (
          <button className="btn ghost" onClick={() => send({ type: "PAUSE" })}>
            ⏸ Pause
          </button>
        )}
        {state.status !== "idle" && (
          <button className="btn ghost" onClick={() => send({ type: "RESET" })}>
            ⟲ Reset
          </button>
        )}
      </div>

      <div className="composer">
        <textarea
          rows={2}
          placeholder={
            awaitingAnswer
              ? "Answer the question…"
              : pageBlocked
                ? "Switch to a normal web page to start…"
                : "Describe a ticket…"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submitTicket();
            }
          }}
        />
        <button
          className="btn primary send"
          onClick={submitTicket}
          disabled={awaitingAnswer ? false : goDisabled}
          title={pageBlocked && !awaitingAnswer ? "This page can't be automated" : undefined}
        >
          {awaitingAnswer ? "Reply" : "Go"}
        </button>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: AgentState["status"] }) {
  const label: Record<AgentState["status"], string> = {
    idle: "idle",
    planning: "planning",
    "awaiting-confirm": "confirm",
    running: "running",
    paused: "paused",
    done: "done",
    error: "error",
  };
  return <span className={`pill pill-${status}`}>{label[status]}</span>;
}
