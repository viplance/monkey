/**
 * Pure decision heuristics that drive the agent loop: detecting redundant
 * extracts, deciding when an "ask" is really an answer, recognising a satisfied
 * close request, etc. All functions are side-effect free and take the relevant
 * slice of state (step history, chat messages, ticket) as arguments.
 */

import { looksLikeCredentialContent as sharedLooksLikeCredentialContent } from "../shared/redact";
import type { AgentAction, ChatMessage, PageContext, PlanStep } from "../shared/types";

export function compact(s: string, max = 600): string {
  const text = s.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function actionSignature(a: AgentAction): string {
  return `${a.kind}|ref=${a.ref ?? ""}|value=${a.value ?? ""}|url=${a.url ?? ""}${a.submit ? "|submit" : ""}`;
}

export function actionRepeatKey(
  a: AgentAction,
  ctx?: Pick<PageContext, "elements">,
): string {
  const target = a.ref ? ctx?.elements.find((el) => el.ref === a.ref) : undefined;
  const targetKey = target
    ? [
        target.tag,
        target.role ?? "",
        target.label,
        target.type ?? "",
        target.placeholder ?? "",
        target.href ?? "",
      ].join("|")
    : `ref:${a.ref ?? ""}`;

  return `${a.kind}|target=${targetKey}|value=${a.value ?? ""}|url=${a.url ?? ""}${a.submit ? "|submit" : ""}`;
}

export function countCompletedActions(
  stepHistory: string[],
  kind: AgentAction["kind"],
): number {
  return stepHistory.filter((line) => line.includes(`ACTION: ${kind}|`)).length;
}

export function countRepeatedActionAttempts(
  stepHistory: string[],
  repeatKey: string,
): number {
  return stepHistory.filter((line) => line.includes(`REPEAT_KEY: ${repeatKey}`)).length;
}

export function countBlockedRepeatedActionAttempts(
  stepHistory: string[],
  repeatKey: string,
): number {
  return stepHistory.filter((line) =>
    line.includes(`DUPLICATE ACTION BLOCKED: ${repeatKey}`),
  ).length;
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

/**
 * True if the ticket asks the agent to locate/reach something on a site
 * (find/open/navigate/click/go to …). Used to scope the error-page "done"
 * guard below to tasks where finishing on a broken page is actually wrong —
 * a report/summary ticket already has its own finish guard (needsFinalReport
 * in service-worker.ts), and gating every ticket kind on this would fight it.
 */
export function isNavigationTicket(ticket: string | null): boolean {
  return /\b(find|open|navigate|go\s*to|click|search|locate|visit)\b|найди|найти|перейди|перейти|открой|открыть|зайди|зайти|нажми|нажать|кликни|поищи|поискать/i.test(
    ticket ?? "",
  );
}

/**
 * Heuristic "we're stuck on an error page" signal, checked against the raw
 * page context (title/text), not a trusted classification — a page can put
 * any text it wants in its own title or body. This is only ever used to push
 * the model toward recovery (retry navigation, go back, ask), never to skip a
 * confirmation or widen what's auto-run, so a false positive just costs an
 * extra planning turn and a false negative just misses a nudge.
 */
export function looksLikeErrorPage(ctx: Pick<PageContext, "title" | "textExcerpt">): boolean {
  return /(?:^|\W)(?:error|not\s*found|404|request\s*failed|page\s*(?:can'?t|cannot)\s*be\s*(?:displayed|found)|this\s*site\s*can'?t\s*be\s*reached)(?:\W|$)|ошибка\s*(?:запроса|соединения|сервера|страниц)|страниц[а-я]*\s*не\s*найдена|не\s*удалось\s*(?:загрузить|подключиться|открыть)/i.test(
    `${ctx.title} ${ctx.textExcerpt}`.slice(0, 500),
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
