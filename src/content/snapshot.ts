/**
 * Builds the compact, ranked map of interactive elements (+ text excerpt) the
 * model reads as its view of the page.
 */

import type { ElementSnapshot, PageContext } from "../shared/types";
import { INTERACTIVE, isVisible, labelFor } from "./dom";
import { registerRef, resetRefs } from "./refs";

export function snapshot(): PageContext {
  // Reset refs each snapshot so they stay aligned with what the model sees.
  resetRefs();

  const nodes = Array.from(document.querySelectorAll(INTERACTIVE));
  const elements: ElementSnapshot[] = [];

  for (const el of nodes) {
    const visible = isVisible(el);
    const label = labelFor(el);
    // Skip noise: invisible elements with no useful label.
    if (!visible && !label) continue;

    const ref = registerRef(el);
    const input = el as HTMLInputElement;
    elements.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") ?? undefined,
      label,
      type: input.type || undefined,
      value: typeof input.value === "string" ? input.value.slice(0, 80) : undefined,
      placeholder: input.placeholder || undefined,
      href: (el as HTMLAnchorElement).href || undefined,
      visible,
    });
    if (elements.length >= 150) break; // keep the prompt bounded
  }

  // Rank visible elements first; the model reads top-down.
  elements.sort((a, b) => Number(b.visible) - Number(a.visible));

  const textExcerpt = (document.body?.innerText ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);

  return { url: location.href, title: document.title, elements, textExcerpt };
}
