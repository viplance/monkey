/**
 * Thin Gemini REST client for the background worker.
 *
 * We use the generateContent endpoint with function declarations so the model
 * returns structured plans and actions rather than free text we'd have to
 * parse. This mirrors the tool-use pattern used by AI coding agents.
 */

import type { AgentAction, PageContext, PlanStep } from "../shared/types";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Fetch the models the given key can actually use, filtered to ones that
 * support generateContent (i.e. usable for our agent). Returns bare model ids
 * like "gemini-2.5-flash", newest-looking first. Throws on a bad key.
 */
export async function listModels(apiKey: string): Promise<string[]> {
  const res = await fetch(
    `${BASE}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const models: Array<{
    name: string;
    supportedGenerationMethods?: string[];
  }> = data?.models ?? [];

  const ids = models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    // Drop non-chat variants we never want as the agent model.
    .filter(
      (id) =>
        id.startsWith("gemini-") &&
        !/embedding|aqa|imagen|veo|image|tts|learnlm/i.test(id),
    );

  // Sort by descending version, "pro" before "flash" within a version, so the
  // newest/most-capable models surface at the top of the dropdown.
  const score = (id: string): number => {
    const v = id.match(/gemini-(\d+(?:\.\d+)?)/);
    const ver = v ? parseFloat(v[1]) : 0;
    const tier = /pro/.test(id) ? 0.5 : /flash-lite/.test(id) ? 0.1 : 0.3;
    return ver * 10 + tier;
  };
  return Array.from(new Set(ids)).sort((a, b) => score(b) - score(a));
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

const PLANNER_SYSTEM = `You are a browser automation agent embedded in a Chrome extension.
You are given a user's "ticket" (a task) and a snapshot of the current web page.
Your job:
1. Produce a SHORT step-by-step plan (3-7 high-level steps).
2. For the active step, propose exactly ONE concrete next action, OR ask a
   clarifying question if you lack information to proceed safely.
3. Only reference elements by their "ref" from the provided element map.
Prefer asking a question over guessing when the page is ambiguous or when an
action is destructive (delete, purchase, submit payment).
Be concise. Never fabricate refs that are not in the element map.

URL resolution: when the task names a destination by name rather than URL
(e.g. "open Jira", "go to our dashboard") and you do not know its exact URL,
do NOT guess a public URL. Instead emit kind="searchHistory" with value set to
a short search term (e.g. "jira"). The browser history will be searched locally
and the matching URLs returned to you; then propose a navigate to the best
match. Only fall back to asking the user if the search returns nothing useful.`;

/** Tool the model calls to emit the plan. */
const planTool = {
  name: "propose_plan",
  description: "Emit a short ordered plan of high-level steps for the ticket.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short imperative title" },
            detail: { type: "string", description: "One-sentence goal" },
          },
          required: ["title", "detail"],
        },
      },
    },
    required: ["steps"],
  },
};

/** Tool the model calls to propose the next concrete action. */
const actionTool = {
  name: "propose_action",
  description:
    "Propose the single next action for the active step, or ask the user.",
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [
          "click",
          "type",
          "select",
          "scrollTo",
          "navigate",
          "extract",
          "waitFor",
          "searchHistory",
          "done",
          "ask",
        ],
      },
      ref: { type: "string", description: "Element ref from the map" },
      value: {
        type: "string",
        description:
          "Text to type / option / question / history search term (kind=searchHistory)",
      },
      url: { type: "string", description: "URL for navigate" },
      rationale: {
        type: "string",
        description: "Why this action; if kind=ask, the question text",
      },
    },
    required: ["kind", "rationale"],
  },
};

async function call(
  apiKey: string,
  model: string,
  contents: GeminiContent[],
  tool: object,
  toolName: string,
): Promise<Record<string, unknown>> {
  // Abort a hung request rather than leaving the agent stuck on "working…".
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30000);
  let res: Response;
  try {
    res = await fetch(
      `${BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: PLANNER_SYSTEM }] },
          contents,
          tools: [{ functionDeclarations: [tool] }],
          toolConfig: {
            functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolName] },
          },
          generationConfig: { temperature: 0.2 },
        }),
      },
    );
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`Gemini request timed out after 30s (model "${model}"). Check your key/model and network.`);
    }
    throw new Error(`Gemini request failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const parts: GeminiPart[] = data?.candidates?.[0]?.content?.parts ?? [];
  const fc = parts.find((p) => p.functionCall)?.functionCall;
  if (!fc) {
    const txt = parts.map((p) => p.text).filter(Boolean).join(" ");
    throw new Error(`No function call returned. Model said: ${txt || "(empty)"}`);
  }
  return fc.args ?? {};
}

function contextToText(ctx: PageContext): string {
  const els = ctx.elements
    .map(
      (e) =>
        `[${e.ref}] <${e.tag}${e.role ? ` role=${e.role}` : ""}${
          e.type ? ` type=${e.type}` : ""
        }> ${e.label || e.placeholder || ""}${
          e.value ? ` (value="${e.value}")` : ""
        }${e.visible ? "" : " (offscreen)"}`,
    )
    .join("\n");
  return `URL: ${ctx.url}\nTITLE: ${ctx.title}\n\nINTERACTIVE ELEMENTS:\n${els}\n\nVISIBLE TEXT (excerpt):\n${ctx.textExcerpt}`;
}

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
  const planText = plan
    .map((s) => `${s.status === "active" ? "→" : s.status === "done" ? "✓" : "•"} ${s.title}`)
    .join("\n");

  const args = await call(
    apiKey,
    model,
    [
      {
        role: "user",
        parts: [
          {
            text: `TICKET:\n${ticket}\n\nPLAN:\n${planText}\n\nACTIVE STEP: ${activeStep.title} — ${activeStep.detail}\n\nACTIONS SO FAR THIS STEP:\n${
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
