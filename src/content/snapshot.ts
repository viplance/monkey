/**
 * Builds the compact, ranked map of interactive elements (+ text excerpt) the
 * model reads as its view of the page.
 */

import { redactCredentialContent } from "../shared/redact";
import type { ElementSnapshot, PageContext } from "../shared/types";
import {
  CLICKABLE_CANDIDATE,
  INTERACTIVE,
  isLikelyClickable,
  isNoise,
  isSensitiveField,
  isVisible,
  labelFor,
  regionOf,
  regionPriority,
} from "./dom";
import { recentPageDebugEntries } from "./page-debug";
import { registerRef, resetRefs } from "./refs";

/**
 * Cap on how many interactive elements ride along in a snapshot. Bounds the
 * prompt size while staying generous enough for dense marketplace/SPA pages
 * (Trendyol, Amazon, …) whose header/mega-menu alone can hold well over a
 * hundred links. The cap is applied *after* ranking (see below), so it always
 * spends its budget on the on-screen controls the model actually needs.
 */
const MAX_ELEMENTS = 250;

export function snapshot(): PageContext {
  // Reset refs each snapshot so they stay aligned with what the model sees.
  resetRefs();

  // Semantic controls (links, buttons, inputs, ARIA widgets) — the reliable
  // pass. Then a second pass for framework-wired clickables (plain <div>/<span>/
  // <li> with a JS click handler and a pointer cursor) that the semantic
  // selector can't see. Custom dropdown options / sort & filter menus on SPAs
  // (e.g. Trendyol) are built this way, so without the second pass the model
  // opens a menu it then can't act inside and loops on the opener.
  const semantic = Array.from(document.querySelectorAll(INTERACTIVE));
  const matchesInteractive = (el: Element) => el.matches(INTERACTIVE);
  const clickable = Array.from(
    document.querySelectorAll(CLICKABLE_CANDIDATE),
  ).filter((el) => isVisible(el) && isLikelyClickable(el, matchesInteractive));

  // De-dupe (a node could match both passes) while preserving DOM order.
  const nodes = Array.from(new Set([...semantic, ...clickable]));

  // Collect every usable candidate first, THEN rank and cap — capping mid-scan
  // (in raw DOM order) used to blow the whole budget on the header/nav that
  // leads the document, so the visible controls a task needs (a just-opened
  // sort dropdown's options, product tiles, filters) could fall entirely
  // outside the snapshot and the model would loop, re-clicking a control whose
  // resulting menu it never sees.
  const candidates = nodes
    // Drop ad/tracking containers and aria-hidden subtrees outright — no user
    // task targets them, they're a common injection surface, and on dense
    // marketplace pages they'd otherwise eat into the element budget.
    .filter((el) => !isNoise(el))
    .map((el) => ({
      el,
      visible: isVisible(el),
      label: labelFor(el),
      region: regionOf(el),
    }))
    // Skip noise: invisible elements with no useful label.
    .filter(({ visible, label }) => visible || label);

  // Rank so the bounded element budget goes to what a task needs. Primary key
  // is visibility (the model reads top-down and acts on-screen); within that,
  // region priority floats an open dialog/menu and main content above page
  // chrome (nav/header) and pushes the footer last. Sort before assigning refs
  // (so ref order matches what the model sees) and before the cap (so the
  // dropped elements are the off-screen / low-priority ones).
  candidates.sort(
    (a, b) =>
      Number(b.visible) - Number(a.visible) ||
      regionPriority(b.region) - regionPriority(a.region),
  );

  const elements: ElementSnapshot[] = [];
  for (const { el, visible, label, region } of candidates) {
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
      region,
    });
    if (elements.length >= MAX_ELEMENTS) break; // keep the prompt bounded
  }

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
