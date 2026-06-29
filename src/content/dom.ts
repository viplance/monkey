/**
 * Pure DOM inspection helpers shared by snapshot and ref resolution. No module
 * state — every function reads only the element(s) passed in.
 */

export const INTERACTIVE =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [contenteditable="true"], [onclick]';

export function isVisible(el: Element): boolean {
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

export function labelFor(el: Element): string {
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

export function normalizedText(el: Element | HTMLElement | null | undefined): string {
  if (!(el instanceof HTMLElement)) return "";
  return el.innerText.replace(/\s+/g, " ").trim();
}
