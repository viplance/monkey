/**
 * Page automatability + blank-tab helpers (pure, no chrome.* access).
 *
 * Page automatability (TabKind from shared types):
 *  - "ok":      a real http(s) page we can snapshot and act on.
 *  - "blank":   a blank/New Tab page — can't be scripted, but the agent CAN
 *               navigate it to a real URL first, so it's a valid launchpad.
 *  - "blocked": chrome://, the Web Store, devtools, etc. — neither scriptable
 *               nor navigable by us; the user must switch tabs.
 */

import type { PageContext, TabKind } from "../shared/types";

const BLANK_RE = /^(about:blank|chrome:\/\/newtab\/?|chrome:\/\/new-tab-page\/?|edge:\/\/newtab\/?)$/;
const BLOCKED_RE = /^(chrome|edge|brave|opera|about|chrome-extension|devtools|view-source|file):/;

export function classifyUrl(url: string | undefined): TabKind {
  if (!url) return "blank";
  if (BLANK_RE.test(url)) return "blank";
  if (BLOCKED_RE.test(url)) return "blocked";
  if (url.startsWith("https://chromewebstore.google.com")) return "blocked";
  if (/^https?:\/\//.test(url)) return "ok";
  return "blocked";
}

/**
 * Thrown when the active tab is a page extensions can't touch (chrome://, the
 * Web Store, New Tab, other extensions). It's a normal situation, not a
 * failure, so it's surfaced as a soft notice rather than the error state.
 */
export class NotAutomatableError extends Error {}

/** A synthetic empty page so the planner navigates first from a blank tab. */
export function blankContext(url: string): PageContext {
  return {
    url: url || "about:blank",
    title: "(blank tab)",
    elements: [],
    textExcerpt:
      "This is a blank/new tab with no content. Navigate to the appropriate URL first.",
  };
}

/** Extract a bare host ("www.x.com" -> "x.com") for rule matching. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
