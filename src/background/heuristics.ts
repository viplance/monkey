/**
 * Pure decision heuristics that drive the agent loop: detecting redundant
 * extracts, deciding when an "ask" is really an answer, recognising a satisfied
 * close request, etc. All functions are side-effect free and take the relevant
 * slice of state (step history, chat messages, ticket) as arguments.
 */

import { looksLikeCredentialContent as sharedLooksLikeCredentialContent } from "../shared/redact";
import type { AgentAction, ChatMessage, PlanStep } from "../shared/types";

export function compact(s: string, max = 600): string {
  const text = s.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function actionSignature(a: AgentAction): string {
  return `${a.kind}|ref=${a.ref ?? ""}|value=${a.value ?? ""}|url=${a.url ?? ""}${a.submit ? "|submit" : ""}`;
}

export function countCompletedActions(
  stepHistory: string[],
  kind: AgentAction["kind"],
): number {
  return stepHistory.filter((line) => line.includes(`ACTION: ${kind}|`)).length;
}

export function hasMeaningfulExtract(
  stepHistory: string[],
  a: AgentAction,
): boolean {
  const marker = `ACTION: ${actionSignature(a)}`;
  return stepHistory.some(
    (line) =>
      line.includes("ACTION: extract|") &&
      line.includes("EXTRACTED TEXT:") &&
      (line.includes(marker) || line.length > 1000),
  );
}

export function hasExtractedText(stepHistory: string[]): boolean {
  return stepHistory.some((line) => line.includes("EXTRACTED TEXT:"));
}

export function isReportTicket(ticket: string | null): boolean {
  return /summari|summary|summar|саммари|резюм|обобщ|explain|ответ|answer|\bwhere\b|\bhow\b|где|как|score|скор|\breport\b|репорт|отчет|отчёт|translate|перев/i.test(
    ticket ?? "",
  );
}

export function looksLikeQuestion(text: string): boolean {
  return /[?？؟]\s*$/.test(text.trim());
}

export function isReportingStep(step: PlanStep): boolean {
  return /summari|summary|summar|саммари|резюм|обобщ|explain|ответ|report|translate|перев/i.test(
    `${step.title} ${step.detail}`,
  );
}

export function shouldTreatAskAsResponse(
  stepHistory: string[],
  action: AgentAction,
  step: PlanStep,
): boolean {
  return (
    !looksLikeQuestion(action.rationale) &&
    (hasExtractedText(stepHistory) || isReportingStep(step))
  );
}

/**
 * Heuristic check for credential-shaped content in extracted page text —
 * password-manager fills, API keys, tokens, auth headers. A page that
 * surfaces this to an "extract" action is a red flag for the BioShocking-
 * style pattern (trick the agent into reading + relaying secrets), so such
 * extracts should never be silently auto-approved. Shared with the content
 * script's textExcerpt redaction (../shared/redact) so both checks stay in
 * sync.
 */
export const looksLikeCredentialContent = sharedLooksLikeCredentialContent;

/**
 * True if `query` is plausibly something the user actually asked to resolve —
 * a substring of their ticket (or vice versa for short queries). searchHistory
 * results (local browsing destinations) get fed straight back into model
 * context, so a page-injected instruction that gets the model to search for
 * an attacker-chosen term (e.g. "bank", "admin portal") would otherwise leak
 * the user's browsing history to the model unconfirmed. Restricting
 * unconfirmed lookups to terms traceable to the user's own ticket closes that
 * off without breaking the normal "open Jira" / "go to our dashboard" flow.
 */
export function queryMatchesTicket(query: string, ticket: string | null): boolean {
  const q = query.trim().toLowerCase();
  const t = (ticket ?? "").trim().toLowerCase();
  if (!q || !t) return false;
  return t.includes(q) || (q.length >= 3 && q.includes(t));
}

export function isCloseOrDismissTicket(ticket: string | null): boolean {
  return /(?:\b(?:close|dismiss|hide)\b|закро[йи]|закрыть|скро[йи]|убери|убрать)/i.test(
    ticket ?? "",
  );
}

export function saysTargetIsAlreadyGone(text: string): boolean {
  return /(?:no|not|none|nothing|нет|не)\s+(?:open|visible|present|found|открыт|видим|найден)|(?:already|уже)\s+(?:closed|gone|dismissed|закрыт|закрыто|нет)|(?:нет|no)\s+(?:popup|pop-up|modal|dialog|попап|модал|окн)/i.test(
    text,
  );
}

export function hasSuccessfulCloseAction(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      m.role === "agent" &&
      /^(?:Click|Select|Type|Navigate|Scroll|Wait|Extract)\b/i.test(m.text) &&
      /(?:close|dismiss|hide|закро|закры|скро|убер|popup|pop-up|modal|dialog|попап|модал)/i.test(
        m.text,
      ),
  );
}

export function shouldFinishSatisfiedCloseRequest(
  ticket: string | null,
  messages: ChatMessage[],
  action: AgentAction,
): boolean {
  return (
    isCloseOrDismissTicket(ticket) &&
    hasSuccessfulCloseAction(messages) &&
    saysTargetIsAlreadyGone(action.rationale)
  );
}

export function shouldRetryTaskRestatement(
  stepHistory: string[],
  text: string,
): boolean {
  if (
    stepHistory.some((line) =>
      line.includes("Model returned a task restatement as ask:"),
    )
  ) {
    return false;
  }
  const t = text.trim();
  return (
    t.length < 180 &&
    /^(provide|create|write|summari[sz]e|make|сделай|создай|напиши|предоставить|подготовь|резюмируй|суммари|саммари)(?:\s|$|[.,:;])/i.test(
      t,
    )
  );
}
