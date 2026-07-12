import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_MODELS,
  FALLBACK_MODELS,
  type AiProvider,
  type PanelToBg,
  type Settings as TSettings,
} from "../shared/types";

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
  const [models, setModels] = useState<string[]>(FALLBACK_MODELS[settings.provider]);
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

  const providerLabels: Record<AiProvider, string> = {
    gemini: "Gemini",
    openai: "OpenAI",
    anthropic: "Claude",
  };
  const keyPlaceholders: Record<AiProvider, string> = {
    gemini: "AIza...",
    openai: "sk-...",
    anthropic: "sk-ant-...",
  };
  const keyLinks: Record<AiProvider, { href: string; label: string }> = {
    gemini: {
      href: "https://aistudio.google.com/apikey",
      label: "aistudio.google.com/apikey",
    },
    openai: {
      href: "https://platform.openai.com/api-keys",
      label: "platform.openai.com/api-keys",
    },
    anthropic: {
      href: "https://console.anthropic.com/settings/keys",
      label: "console.anthropic.com/settings/keys",
    },
  };

  const apiKeys = { ...(draft.apiKeys ?? { gemini: "", openai: "", anthropic: "" }) };
  const activeKey = apiKeys[draft.provider] ?? "";

  function selectProvider(provider: AiProvider) {
    setDraft({
      ...draft,
      provider,
      apiKeys,
      model: DEFAULT_MODELS[provider],
    });
    setModels(FALLBACK_MODELS[provider]);
    setModelError(null);
  }

  function updateActiveKey(value: string) {
    setDraft({
      ...draft,
      apiKeys: { ...apiKeys, [draft.provider]: value },
      apiKey: draft.provider === "gemini" ? value : draft.apiKey,
    });
  }

  // Fetch the live model list the saved key can actually use. Falls back to the
  // static list on error so the dropdown is never empty.
  async function refreshModels(provider: AiProvider, apiKey: string) {
    if (!apiKey.trim()) {
      setModels(FALLBACK_MODELS[provider]);
      setModelError(null);
      return;
    }
    setLoading(true);
    setModelError(null);
    const res = (await send({ type: "LIST_MODELS", provider, apiKey })) as
      | { ok: true; models: string[] }
      | { ok: false; error: string };
    setLoading(false);
    if (res.ok && res.models.length) {
      setModels(res.models);
    } else {
      setModels(FALLBACK_MODELS[provider]);
      setModelError(res.ok ? "No usable models for this key." : res.error);
    }
  }

  // Auto-load once when opening Settings with a key already saved.
  useEffect(() => {
    const key = settings.apiKeys?.[settings.provider] ?? settings.apiKey ?? "";
    if (key) void refreshModels(settings.provider, key);
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
          <span>Provider</span>
          <select
            value={draft.provider}
            onChange={(e) => selectProvider(e.target.value as AiProvider)}
          >
            <option value="gemini">Gemini</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Claude</option>
          </select>
        </label>

        <label className="field">
          <span>{providerLabels[draft.provider]} API key</span>
          <input
            type="password"
            placeholder={keyPlaceholders[draft.provider]}
            value={activeKey}
            onChange={(e) => updateActiveKey(e.target.value)}
            onBlur={(e) => void refreshModels(draft.provider, e.target.value)}
          />
          <small>
            Create one at{" "}
            <a href={keyLinks[draft.provider].href} target="_blank" rel="noreferrer">
              {keyLinks[draft.provider].label}
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
              disabled={loading || !activeKey}
              onClick={() => void refreshModels(draft.provider, activeKey)}
            >
              {loading ? "loading..." : "refresh"}
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
              {activeKey
                ? draft.provider === "anthropic"
                  ? "Showing the current Claude model defaults; availability is checked on use."
                  : "List fetched live from your key."
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
