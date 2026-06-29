/** Highlight overlay drawn over referenced elements before an action runs. */

import { resolveRef } from "./refs";

const HL_CLASS = "__gba_highlight__";
let styleInjected = false;

function ensureStyle() {
  if (styleInjected) return;
  const s = document.createElement("style");
  s.textContent = `.${HL_CLASS}{outline:3px solid #6d5efc !important;outline-offset:2px !important;box-shadow:0 0 0 4px rgba(109,94,252,.25)!important;border-radius:3px!important;transition:outline .1s;}`;
  document.documentElement.appendChild(s);
  styleInjected = true;
}

export function clearHighlight() {
  document.querySelectorAll(`.${HL_CLASS}`).forEach((e) => e.classList.remove(HL_CLASS));
}

export function highlight(refs: string[]) {
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
