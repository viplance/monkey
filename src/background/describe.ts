/**
 * Human-readable rendering of a proposed action for the chat log. Pure: maps an
 * AgentAction to a one-line string.
 */

import type { AgentAction } from "../shared/types";
import { compact } from "./heuristics";

export function describe(a: AgentAction): string {
  switch (a.kind) {
    case "respond":
      return compact(a.rationale);
    default:
      return a.rationale;
  }
}
