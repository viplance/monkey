/**
 * Internal Gemini wire types for the generateContent REST API. These mirror the
 * subset of the response/request shape we actually read or send.
 */

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** A function declaration passed in the `tools` array. */
export interface GeminiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
