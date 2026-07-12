/**
 * Builds the compact, ranked map of interactive elements (+ text excerpt) the
 * model reads as its view of the page.
 */

import { redactCredentialContent } from "../shared/redact";
import type { ElementSnapshot, PageContext } from "../shared/types";
import { INTERACTIVE, isSensitiveField, isVisible, labelFor } from "./dom";
import { recentPageDebugEntries } from "./page-debug";
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
    // Never send raw values for password/hidden/credential-shaped fields to the
    // model — only whether they're filled. Autofilled login forms and hidden
    // exfiltration fields on a malicious page are exactly what a prompt-
    // injection attack (e.g. BioShocking) relies on being visible in the
    // snapshot before any downstream guard ever runs.
    const sensitive = isSensitiveField(el, label);
    const rawValue = typeof input.value === "string" ? input.value : undefined;
    elements.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") ?? undefined,
      label,
      type: input.type || undefined,
      value: sensitive
        ? rawValue
          ? "(filled)"
          : undefined
        : rawValue?.slice(0, 80),
      placeholder: input.placeholder || undefined,
      href: (el as HTMLAnchorElement).href || undefined,
      visible,
    });
    if (elements.length >= 150) break; // keep the prompt bounded
  }

  // Rank visible elements first; the model reads top-down.
  elements.sort((a, b) => Number(b.visible) - Number(a.visible));

  // Redact credential-shaped substrings (api_key=..., Authorization: Bearer
  // ..., etc.) before this ever leaves the page context — the extract-time
  // credential pause only fires for an explicit "extract" action, but this
  // excerpt reaches the model unconditionally on every planning/action turn.
  const textExcerpt = redactCredentialContent(
    (document.body?.innerText ?? "").replace(/\s+/g, " ").trim(),
  ).slice(0, 2000);

  const debugEntries = recentPageDebugEntries();

  return {
    url: location.href,
    title: document.title,
    elements,
    textExcerpt,
    ...(debugEntries.length ? { debugEntries } : {}),
  };
}
