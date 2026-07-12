/**
 * Provider-agnostic tool-call contract. Every provider client (Gemini,
 * OpenAI, Anthropic) accepts a ProviderTool and returns the parsed arguments
 * of the single forced tool call, translating to/from its own wire format
 * internally.
 */
export interface ProviderTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Signature every provider's `call` function implements. */
export type ProviderCall = (
  apiKey: string,
  model: string,
  text: string,
  tool: ProviderTool,
  toolName: string,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;
