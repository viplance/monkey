import type { PageContext, PlanStep } from "../../shared/types";

/** Render a page context into the compact text grounding the model sees. */
export function contextToText(ctx: PageContext): string {
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

/** Render the plan as a checklist with the active step marked. */
export function planToText(plan: PlanStep[]): string {
  return plan
    .map(
      (s) =>
        `${s.status === "active" ? "→" : s.status === "done" ? "✓" : "•"} ${s.title}`,
    )
    .join("\n");
}
