/**
 * Human-readable rendering of a proposed action for the chat log. Pure: maps an
 * AgentAction (+ optional page context for element labels) to a one-line string.
 */

import type { AgentAction, PageContext } from "../shared/types";
import { compact } from "./heuristics";

function elementLabel(
  ctx: PageContext | undefined,
  ref: string | undefined,
): string {
  if (!ctx || !ref) return "element";
  const el = ctx.elements.find((e) => e.ref === ref);
  if (!el) return "element";

  const label = compact(el.label || el.placeholder || el.value || "", 80);
  const kind = el.role || el.tag;
  if (label) return `"${label}" ${kind}`;
  return el.visible ? `${kind} element` : `offscreen ${kind} element`;
}

function scrollLabel(a: AgentAction, ctx: PageContext | undefined): string {
  if (/down|bottom|rest|more|below|further/i.test(a.rationale)) {
    return "Scroll down";
  }
  return `Scroll to ${elementLabel(ctx, a.ref)}`;
}

export function describe(a: AgentAction, ctx?: PageContext): string {
  switch (a.kind) {
    case "click":
      return `Click ${elementLabel(ctx, a.ref)} — ${a.rationale}`;
    case "type":
      return `Type "${a.value ?? ""}" — ${a.rationale}`;
    case "select":
      return `Select "${a.value ?? ""}" — ${a.rationale}`;
    case "scrollTo":
      return `${scrollLabel(a, ctx)} — ${a.rationale}`;
    case "navigate":
      return `Navigate to ${a.url} — ${a.rationale}`;
    case "extract":
      return `Extract page content — ${a.rationale}`;
    case "waitFor":
      return `Wait — ${a.rationale}`;
    case "searchHistory":
      return `Search history for "${a.value ?? ""}" — ${a.rationale}`;
    case "respond":
      return `Respond — ${compact(a.rationale)}`;
    default:
      return a.rationale;
  }
}
