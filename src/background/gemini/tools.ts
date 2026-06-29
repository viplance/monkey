import type { GeminiTool } from "./types";

/** Tool the model calls to emit the plan. */
export const planTool: GeminiTool = {
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
export const actionTool: GeminiTool = {
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
          "respond",
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
        description:
          "Why this action; if kind=ask, the question text; if kind=respond, the user-facing answer",
      },
    },
    required: ["kind", "rationale"],
  },
};
