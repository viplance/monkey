/**
 * Content script: the agent's hands and eyes on the page.
 *
 * - SNAPSHOT: builds a compact, ranked map of interactive elements + a stable
 *   `ref` per element (stored on the element so the model's ref resolves back
 *   to the live node).
 * - HIGHLIGHT / CLEAR_HIGHLIGHT: overlays a highlight on referenced elements.
 * - EXECUTE: performs a confirmed action.
 */

import type {
  AgentAction,
  BgToContent,
  ContentReply,
  ElementSnapshot,
  PageContext,
} from "../shared/types";

const REF_ATTR = "data-gba-ref";
let refCounter = 0;
const refMap = new Map<string, Element>();

const INTERACTIVE =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [contenteditable="true"], [onclick]';

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0")
    return false;
  return (
    r.bottom > 0 &&
    r.right > 0 &&
    r.top < (innerHeight || document.documentElement.clientHeight) &&
    r.left < (innerWidth || document.documentElement.clientWidth)
  );
}

function labelFor(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const ref = document.getElementById(labelledby);
    if (ref?.textContent) return ref.textContent.trim();
  }
  if (el instanceof HTMLInputElement && el.labels?.length) {
    return Array.from(el.labels).map((l) => l.textContent).join(" ").trim();
  }
  const title = el.getAttribute("title");
  if (title) return title.trim();
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, 120);
}

function snapshot(): PageContext {
  // Reset refs each snapshot so they stay aligned with what the model sees.
  refMap.clear();
  document.querySelectorAll(`[${REF_ATTR}]`).forEach((e) => e.removeAttribute(REF_ATTR));
  refCounter = 0;

  const nodes = Array.from(document.querySelectorAll(INTERACTIVE));
  const elements: ElementSnapshot[] = [];

  for (const el of nodes) {
    const visible = isVisible(el);
    const label = labelFor(el);
    // Skip noise: invisible elements with no useful label.
    if (!visible && !label) continue;

    const ref = `e${++refCounter}`;
    el.setAttribute(REF_ATTR, ref);
    refMap.set(ref, el);

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

// --- highlight overlay ----------------------------------------------------

const HL_CLASS = "__gba_highlight__";
let styleInjected = false;

function ensureStyle() {
  if (styleInjected) return;
  const s = document.createElement("style");
  s.textContent = `.${HL_CLASS}{outline:3px solid #6d5efc !important;outline-offset:2px !important;box-shadow:0 0 0 4px rgba(109,94,252,.25)!important;border-radius:3px!important;transition:outline .1s;}`;
  document.documentElement.appendChild(s);
  styleInjected = true;
}

function clearHighlight() {
  document.querySelectorAll(`.${HL_CLASS}`).forEach((e) => e.classList.remove(HL_CLASS));
}

function highlight(refs: string[]) {
  ensureStyle();
  clearHighlight();
  for (const ref of refs) {
    const el = refMap.get(ref);
    if (el) {
      el.classList.add(HL_CLASS);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

// --- action execution -----------------------------------------------------

function fireInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value); // bypass React's value tracking
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function execute(action: AgentAction): ContentReply {
  const el = action.ref ? refMap.get(action.ref) : null;

  switch (action.kind) {
    case "click": {
      if (!(el instanceof HTMLElement)) return fail("Element not found for click.");
      el.scrollIntoView({ block: "center" });
      el.click();
      return { type: "EXECUTE_RESULT", ok: true };
    }
    case "type": {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        fireInput(el, action.value ?? "");
        return { type: "EXECUTE_RESULT", ok: true };
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        el.focus();
        el.textContent = action.value ?? "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return { type: "EXECUTE_RESULT", ok: true };
      }
      return fail("Target is not a text field.");
    }
    case "select": {
      if (el instanceof HTMLSelectElement) {
        const want = (action.value ?? "").toLowerCase();
        const opt = Array.from(el.options).find(
          (o) => o.label.toLowerCase() === want || o.value.toLowerCase() === want,
        );
        if (!opt) return fail(`Option "${action.value}" not found.`);
        el.value = opt.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { type: "EXECUTE_RESULT", ok: true };
      }
      return fail("Target is not a <select>.");
    }
    case "scrollTo": {
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return { type: "EXECUTE_RESULT", ok: true };
      }
      return fail("Element not found to scroll to.");
    }
    case "extract": {
      const text = el instanceof HTMLElement
        ? el.innerText.trim().slice(0, 500)
        : (document.body?.innerText ?? "").trim().slice(0, 500);
      return { type: "EXECUTE_RESULT", ok: true, extracted: text };
    }
    default:
      return fail(`Unsupported action in content script: ${action.kind}`);
  }
}

function fail(error: string): ContentReply {
  return { type: "EXECUTE_RESULT", ok: false, error };
}

// --- message handling -----------------------------------------------------

chrome.runtime.onMessage.addListener(
  (msg: BgToContent, _sender, sendResponse: (r: ContentReply) => void) => {
    switch (msg.type) {
      case "SNAPSHOT":
        sendResponse({ type: "SNAPSHOT_RESULT", context: snapshot() });
        break;
      case "HIGHLIGHT":
        highlight(msg.refs);
        sendResponse({ type: "ACK" });
        break;
      case "CLEAR_HIGHLIGHT":
        clearHighlight();
        sendResponse({ type: "ACK" });
        break;
      case "EXECUTE":
        sendResponse(execute(msg.action));
        break;
    }
    return true;
  },
);
