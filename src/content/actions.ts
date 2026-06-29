/** Performs a confirmed AgentAction against the live DOM. */

import type { AgentAction, ContentReply } from "../shared/types";
import { normalizedText } from "./dom";
import { resolveRef } from "./refs";

function fireInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value); // bypass React's value tracking
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
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

function fail(error: string): ContentReply {
  return { type: "EXECUTE_RESULT", ok: false, error };
}

export function execute(action: AgentAction): ContentReply {
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
