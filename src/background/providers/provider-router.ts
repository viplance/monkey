/**
 * Provider-agnostic entry point the service worker talks to. Picks the right
 * client (Gemini/OpenAI/Anthropic) for the selected provider, builds the
 * ticket/page-context prompt text shared by all of them, and normalizes each
 * provider's tool-call arguments into the agent's PlanStep/AgentAction shape.
 */

import type { AgentAction, AiProvider, PageContext, PlanStep } from "../../shared/types";
import { call as callAnthropic } from "./anthropic/client";
import { listModels as listAnthropicModels } from "./anthropic/models";
import { call as callGemini } from "./gemini/client";
import { listModels as listGeminiModels } from "./gemini/models";
import { call as callOpenAI } from "./openai/client";
import { listModels as listOpenAIModels } from "./openai/models";
import { contextToText, planToText } from "./serialize";
import { actionTool, planTool } from "./tools";
import type { ProviderCall, ProviderTool } from "./types";

const PROVIDER_CALL: Record<AiProvider, ProviderCall> = {
  gemini: callGemini,
  openai: callOpenAI,
  anthropic: callAnthropic,
};

function callProvider(
  provider: AiProvider,
  apiKey: string,
  model: string,
  text: string,
  tool: ProviderTool,
  toolName: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return PROVIDER_CALL[provider](apiKey, model, text, tool, toolName, signal);
}

export async function listModels(provider: AiProvider, apiKey: string): Promise<string[]> {
  if (provider === "gemini") return listGeminiModels(apiKey);
  if (provider === "openai") return listOpenAIModels(apiKey);
  return listAnthropicModels(apiKey);
}

function shouldIncludePageDebug(ticket: string, ctx: PageContext): boolean {
  const asksForDebug =
    /(?:\blogs?\b|\bconsole\b|\berrors?\b|\bdebug(?:ging)?\b|stack trace|exception|failed|broken|not working|логи|консоль|ошибк|отлад|дебаг|сломал|сломано|не работает)/i.test(
      ticket,
    );
  const hasWarningsOrErrors = ctx.debugEntries?.some(
    (entry) =>
      entry.level === "warn" ||
      entry.level === "error" ||
      entry.kind === "error" ||
      entry.kind === "unhandledrejection",
  );
  return asksForDebug || !!hasWarningsOrErrors;
}

export async function planTicket(
  provider: AiProvider,
  apiKey: string,
  model: string,
  ticket: string,
  ctx: PageContext,
  signal?: AbortSignal,
): Promise<Array<Pick<PlanStep, "title" | "detail">>> {
  const args = await callProvider(
    provider,
    apiKey,
    model,
    `TICKET:\n${ticket}\n\nCURRENT PAGE:\n${contextToText(ctx, { includeDebug: shouldIncludePageDebug(ticket, ctx) })}\n\nProduce the plan now.`,
    planTool,
    "propose_plan",
    signal,
  );
  const steps = (args.steps as Array<{ title: string; detail: string }>) ?? [];
  return steps.map((s) => ({ title: s.title, detail: s.detail }));
}

export async function nextAction(
  provider: AiProvider,
  apiKey: string,
  model: string,
  ticket: string,
  plan: PlanStep[],
  activeStep: PlanStep,
  ctx: PageContext,
  history: string[],
  signal?: AbortSignal,
): Promise<AgentAction> {
  const args = await callProvider(
    provider,
    apiKey,
    model,
    `TICKET:\n${ticket}\n\nPLAN:\n${planToText(plan)}\n\nACTIVE STEP: ${activeStep.title} — ${activeStep.detail}\n\nRUN HISTORY AND EXTRACTED MATERIALS:\n${
      history.length ? history.join("\n") : "(none)"
    }\n\nCURRENT PAGE:\n${contextToText(ctx, { includeDebug: shouldIncludePageDebug(ticket, ctx) })}\n\nPropose the next action for the active step. If the step is complete, return kind="done". If you need information from the user, return kind="ask".`,
    actionTool,
    "propose_action",
    signal,
  );

  return {
    kind: args.kind as AgentAction["kind"],
    ref: args.ref as string | undefined,
    value: args.value as string | undefined,
    submit: args.submit === true || undefined,
    url: args.url as string | undefined,
    rationale: (args.rationale as string) ?? "",
  };
}
