import { useEffect, useMemo, useState } from "react";
import { FALLBACK_MODELS, type PanelToBg, type Settings as TSettings } from "../shared/types";

const send = (msg: PanelToBg): Promise<unknown> => chrome.runtime.sendMessage(msg);

export function Settings({
  settings,
  onSave,
  onClose,
}: {
  settings: TSettings;
  onSave: (s: TSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TSettings>(settings);
  const [models, setModels] = useState<string[]>(FALLBACK_MODELS);
  const [loading, setLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [ruleQuery, setRuleQuery] = useState("");

  const rules = draft.autoRules ?? [];
  const filteredRules = useMemo(() => {
    const q = ruleQuery.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        r.kind.toLowerCase().includes(q) ||
        r.host.toLowerCase().includes(q),
    );
  }, [rules, ruleQuery]);

  function removeRule(ruleId: string) {
    setDraft({ ...draft, autoRules: rules.filter((r) => r.id !== ruleId) });
  }

  // Fetch the live model list the saved key can actually use. Falls back to the
  // static list on error so the dropdown is never empty.
  async function refreshModels(apiKey: string) {
    if (!apiKey.trim()) {
      setModels(FALLBACK_MODELS);
      setModelError(null);
      return;
    }
    setLoading(true);
    setModelError(null);
    const res = (await send({ type: "LIST_MODELS", apiKey })) as
      | { ok: true; models: string[] }
      | { ok: false; error: string };
    setLoading(false);
    if (res.ok && res.models.length) {
      setModels(res.models);
    } else {
      setModels(FALLBACK_MODELS);
      setModelError(res.ok ? "No usable models for this key." : res.error);
    }
  }

  // Auto-load once when opening Settings with a key already saved.
  useEffect(() => {
    if (settings.apiKey) void refreshModels(settings.apiKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ensure the currently-selected model is always selectable even if it isn't
  // in the fetched list (e.g. a custom or newly-released id).
  const options = models.includes(draft.model)
    ? models
    : [draft.model, ...models];

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">⚙️ Settings</span>
        <button className="icon-btn" onClick={onClose} title="Back">
          ✕
        </button>
      </header>

      <div className="settings">
        <label className="field">
          <span>Gemini API key</span>
          <input
            type="password"
            placeholder="AIza…"
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            onBlur={(e) => void refreshModels(e.target.value)}
          />
          <small>
            Get one free at{" "}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              aistudio.google.com/apikey
            </a>
            . Stored locally in this browser only.
          </small>
        </label>

        <label className="field">
          <span>
            Model{" "}
            <button
              type="button"
              className="link"
              disabled={loading || !draft.apiKey}
              onClick={() => void refreshModels(draft.apiKey)}
            >
              {loading ? "loading…" : "↻ refresh"}
            </button>
          </span>
          <select
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {modelError ? (
            <small style={{ color: "var(--warn)" }}>
              Couldn't load live list ({modelError}). Showing defaults.
            </small>
          ) : (
            <small>
              {draft.apiKey
                ? "List fetched live from your key."
                : "Add a key, then refresh to see the models you can use."}
            </small>
          )}
        </label>

        <label className="field row">
          <input
            type="checkbox"
            checked={draft.autoExecute}
            onChange={(e) => setDraft({ ...draft, autoExecute: e.target.checked })}
          />
          <span>
            Auto-execute actions <small>(skip per-action confirmation)</small>
          </span>
        </label>

        <label className="field row">
          <input
            type="checkbox"
            checked={draft.useHistory}
            onChange={(e) => setDraft({ ...draft, useHistory: e.target.checked })}
          />
          <span>
            Use browsing history to resolve URLs{" "}
            <small>(lets “open Jira” find the right link from your history)</small>
          </span>
        </label>

        <div className="field">
          <span>
            Auto-approval rules{" "}
            <small>({rules.length})</small>
          </span>
          <small>
            Actions matching a rule run without asking. Created when you choose
            “Always allow” on a proposed action; navigation/search are allowed by
            default.
          </small>
          <input
            type="text"
            placeholder="Search rules…"
            value={ruleQuery}
            onChange={(e) => setRuleQuery(e.target.value)}
          />
          <ul className="rules">
            {filteredRules.length === 0 && (
              <li className="rule-empty">
                {rules.length === 0 ? "No rules yet." : "No rules match your search."}
              </li>
            )}
            {filteredRules.map((r) => (
              <li key={r.id} className="rule">
                <span className="rule-main">
                  <span className={`rule-kind kind-${r.kind}`}>{r.kind}</span>
                  <span className="rule-label">{r.label}</span>
                  <span className="rule-host">{r.host === "*" ? "any site" : r.host}</span>
                </span>
                <button
                  className="icon-btn"
                  title="Remove rule"
                  onClick={() => removeRule(r.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>

        <button className="btn primary" onClick={() => onSave(draft)}>
          Save
        </button>
      </div>
    </div>
  );
}
