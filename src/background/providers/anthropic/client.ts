/** Low-level transport for the Anthropic Messages API. */

import { PLANNER_SYSTEM } from "../prompt";
import type { ProviderTool } from "../types";
import { fetchJson } from "../http";

export const BASE = "https://api.anthropic.com/v1";

export async function call(
  apiKey: string,
  model: string,
  text: string,
  tool: ProviderTool,
  toolName: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const data = (await fetchJson(
    `${BASE}/messages`,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0.2,
        system: PLANNER_SYSTEM,
        messages: [{ role: "user", content: text }],
        tools: [
          {
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          },
        ],
        tool_choice: { type: "tool", name: toolName },
      }),
    },
    "Anthropic",
    signal,
  )) as { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> };

  const call = data.content?.find((item) => item.type === "tool_use" && item.name === toolName);
  if (!call) throw new Error("Anthropic returned no tool call.");
  return call.input ?? {};
}
