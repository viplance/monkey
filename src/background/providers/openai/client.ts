/** Low-level transport for the OpenAI Responses API. */

import { PLANNER_SYSTEM } from "../prompt";
import type { ProviderTool } from "../types";
import { fetchJson } from "../http";

export const BASE = "https://api.openai.com/v1";

export async function call(
  apiKey: string,
  model: string,
  text: string,
  tool: ProviderTool,
  toolName: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const data = (await fetchJson(
    `${BASE}/responses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: PLANNER_SYSTEM,
        input: [{ role: "user", content: [{ type: "input_text", text }] }],
        tools: [
          {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        ],
        tool_choice: { type: "function", name: toolName },
      }),
    },
    "OpenAI",
    signal,
  )) as { output?: Array<{ type?: string; name?: string; arguments?: string | Record<string, unknown> }> };

  const call = data.output?.find((item) => item.type === "function_call" && item.name === toolName);
  if (!call) throw new Error("OpenAI returned no function call.");
  if (typeof call.arguments === "string") {
    try {
      return JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      throw new Error("OpenAI returned invalid function-call JSON.");
    }
  }
  return call.arguments ?? {};
}
