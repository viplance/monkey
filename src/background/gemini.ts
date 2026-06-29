/**
 * Thin Gemini REST client for the background worker.
 *
 * We use the generateContent endpoint with function declarations so the model
 * returns structured plans and actions rather than free text we'd have to
 * parse. This mirrors the tool-use pattern used by AI coding agents.
 *
 * This module is the public surface; the wire types, prompt, tool declarations,
 * transport, and serialization helpers live under ./gemini/.
 */

import type { AgentAction, PageContext, PlanStep } from "../shared/types";
import { call } from "./gemini/client";
import { contextToText, planToText } from "./gemini/serialize";
import { actionTool, planTool } from "./gemini/tools";

export { listModels } from "./gemini/models";

export async function planTicket(
  apiKey: string,
  model: string,
  ticket: string,
  ctx: PageContext,
): Promise<Array<Pick<PlanStep, "title" | "detail">>> {
  const args = await call(
    apiKey,
    model,
    [
      {
        role: "user",
        parts: [
          {
            text: `TICKET:\n${ticket}\n\nCURRENT PAGE:\n${contextToText(ctx)}\n\nProduce the plan now.`,
          },
        ],
      },
    ],
    planTool,
    "propose_plan",
  );
  const steps = (args.steps as Array<{ title: string; detail: string }>) ?? [];
  return steps.map((s) => ({ title: s.title, detail: s.detail }));
}

export async function nextAction(
  apiKey: string,
  model: string,
  ticket: string,
  plan: PlanStep[],
  activeStep: PlanStep,
  ctx: PageContext,
  history: string[],
): Promise<AgentAction> {
  const args = await call(
    apiKey,
    model,
    [
      {
        role: "user",
        parts: [
          {
            text: `TICKET:\n${ticket}\n\nPLAN:\n${planToText(plan)}\n\nACTIVE STEP: ${activeStep.title} — ${activeStep.detail}\n\nACTIONS SO FAR THIS STEP:\n${
              history.length ? history.join("\n") : "(none)"
            }\n\nCURRENT PAGE:\n${contextToText(ctx)}\n\nPropose the next action for the active step. If the step is complete, return kind="done". If you need information from the user, return kind="ask".`,
          },
        ],
      },
    ],
    actionTool,
    "propose_action",
  );

  return {
    kind: args.kind as AgentAction["kind"],
    ref: args.ref as string | undefined,
    value: args.value as string | undefined,
    url: args.url as string | undefined,
    rationale: (args.rationale as string) ?? "",
  };
}
