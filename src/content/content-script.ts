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

/**
 * Descriptors recorded at snapshot time so a ref can be re-resolved against the
 * live DOM even after the map is lost or the original node was re-rendered.
 *
 * Refs are fragile on their own: the map lives only as long as this module
 * instance, and `data-gba-ref` attributes are wiped whenever the SPA re-mounts
 * a node. When that happens `refMap.get(ref)` returns nothing (or a detached
 * node) and a click fails with "Element not found". Keeping a lightweight
 * fingerprint per ref lets us find the element again by its identifying traits.
 */
interface RefDescriptor {
  tag: string;
  role: string | null;
  type: string | null;
  label: string;
  href: string | null;
  placeholder: string | null;
  name: string | null;
}
const refDescriptors = new Map<string, RefDescriptor>();

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
  refDescriptors.clear();
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
    refDescriptors.set(ref, {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      type: input.type || null,
      label,
      href: (el as HTMLAnchorElement).href || null,
      placeholder: input.placeholder || null,
      name: el.getAttribute("name"),
    });
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
    const el = resolveRef(ref);
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

function normalizedText(el: Element | HTMLElement | null | undefined): string {
  if (!(el instanceof HTMLElement)) return "";
  return el.innerText.replace(/\s+/g, " ").trim();
}

function bestExtractText(target: Element | null): string {
  const candidates = [
    target,
    document.querySelector("main"),
    document.querySelector('[role="main"]'),
    document.querySelector("article"),
    document.body,
  ];

  let best = "";
  for (const candidate of candidates) {
    const text = normalizedText(candidate);
    if (text.length > best.length) best = text;
  }

  return best.slice(0, 12000);
}

/** An element still attached to the document we can act on. */
function isUsable(el: Element | null | undefined): el is Element {
  return !!el && el.isConnected;
}

/**
 * Resolve a ref to a live element, tolerating a lost map or a re-rendered node.
 *
 * Order of attempts:
 *  1. the in-memory map (fast path, node still attached);
 *  2. the `data-gba-ref` attribute in the DOM (survives map loss, e.g. when the
 *     content script was re-injected into a fresh module);
 *  3. the recorded descriptor — match a current interactive element by its
 *     identifying traits (tag/role/type/name/href/label). This rescues the case
 *     where the SPA re-mounted the node and dropped our attribute.
 */
function resolveRef(ref: string | undefined): Element | null {
  if (!ref) return null;

  const mapped = refMap.get(ref);
  if (isUsable(mapped)) return mapped;

  const byAttr = document.querySelector(`[${REF_ATTR}="${CSS.escape(ref)}"]`);
  if (isUsable(byAttr)) return byAttr;

  const desc = refDescriptors.get(ref);
  if (!desc) return null;

  const candidates = Array.from(document.querySelectorAll(INTERACTIVE)).filter(
    (el) => isUsable(el) && el.tagName.toLowerCase() === desc.tag,
  );
  // Score each candidate by how many identifying traits it shares with the
  // descriptor; the best non-zero match wins. Label match is weighted highest
  // because it's the most semantically meaningful.
  let best: Element | null = null;
  let bestScore = 0;
  for (const el of candidates) {
    const input = el as HTMLInputElement;
    let score = 0;
    if (desc.label && labelFor(el) === desc.label) score += 4;
    if (desc.role && el.getAttribute("role") === desc.role) score += 1;
    if (desc.type && (input.type || null) === desc.type) score += 1;
    if (desc.name && el.getAttribute("name") === desc.name) score += 2;
    if (desc.href && (el as HTMLAnchorElement).href === desc.href) score += 2;
    if (desc.placeholder && (input.placeholder || null) === desc.placeholder) score += 2;
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  if (best && bestScore > 0) {
    // Re-bind so subsequent actions on this ref hit the same node.
    refMap.set(ref, best);
    return best;
  }
  return null;
}

/**
 * Click that works on SPA widgets which ignore a bare `.click()`. Some
 * frameworks only react to a full pointer/mouse event sequence (e.g. custom
 * dropdowns, DHL's wizard buttons). We dispatch that sequence and also call
 * native `.click()` so plain links/buttons still fire exactly once.
 */
function robustClick(el: HTMLElement) {
  const opts = { bubbles: true, cancelable: true, view: window } as const;
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
}

function execute(action: AgentAction): ContentReply {
  const el = resolveRef(action.ref);

  switch (action.kind) {
    case "click": {
      if (!(el instanceof HTMLElement)) return fail("Element not found for click.");
      el.scrollIntoView({ block: "center" });
      robustClick(el);
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
      const text = bestExtractText(el);
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
