import type { PageContext, PlanStep } from "../../shared/types";

interface ContextToTextOptions {
  includeDebug?: boolean;
}

function debugEntriesToText(ctx: PageContext, options: ContextToTextOptions): string {
  if (!options.includeDebug) return "";
  const entries = ctx.debugEntries?.slice(-12) ?? [];
  if (!entries.length) return "";
  const now = Date.now();
  const lines = entries.map((entry) => {
    const ageSeconds = Math.max(0, Math.round((now - entry.ts) / 1000));
    const where =
      entry.source || entry.line
        ? ` (${[entry.source, entry.line, entry.column].filter(Boolean).join(":")})`
        : "";
    return `- ${entry.kind}/${entry.level} ${ageSeconds}s ago${where}: ${entry.message}`;
  });
  return `\n\nRECENT PAGE DEBUG (console/errors, newest last):\n${lines.join("\n")}`;
}

/** Render a page context into the compact text grounding the model sees. */
export function contextToText(
  ctx: PageContext,
  options: ContextToTextOptions = {},
): string {
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
  return `URL: ${ctx.url}\nTITLE: ${ctx.title}\n\nINTERACTIVE ELEMENTS:\n${els}\n\nVISIBLE TEXT (excerpt):\n${ctx.textExcerpt}${debugEntriesToText(ctx, options)}`;
}

/** Render the plan as a checklist with the active step marked. */
export function planToText(plan: PlanStep[]): string {
  return plan
    .map(
      (s) =>
        `${s.status === "active" ? "→" : s.status === "done" ? "✓" : "•"} ${s.title}`,
    )
    .join("\n");
}
