/**
 * Pure DOM inspection helpers shared by snapshot and ref resolution. No module
 * state — every function reads only the element(s) passed in.
 */

export const INTERACTIVE =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="radio"], [role="checkbox"], [role="switch"], [role="menuitemradio"], [role="menuitemcheckbox"], [contenteditable="true"], [tabindex], [onclick], [jsaction]';

/**
 * Elements the INTERACTIVE selector can't catch: framework-driven controls
 * built from plain <div>/<span>/<li> with a click handler attached in JS
 * (React/Vue addEventListener) rather than an inline onclick or an ARIA role.
 * These are extremely common for custom dropdown options, sort/filter menus,
 * chips and cards on modern SPAs (e.g. Trendyol's "Önerilen Sıralama" sort
 * options) — the exact controls a task needs to click but that were previously
 * invisible to the snapshot, causing the agent to re-click the opener forever.
 * We can't read attached listeners, so we approximate "clickable" via
 * `cursor: pointer`, which frameworks set (directly or via CSS) on such
 * controls. Kept to leaf-ish, short-text elements so we surface the actual
 * option/row, not the giant wrapper around it.
 */
const CLICKABLE_CANDIDATE = "div, span, li";

/**
 * True if `el` looks like a JS-wired clickable that the semantic INTERACTIVE
 * selector would miss: styled with a pointer cursor, holding a short label, and
 * not merely a container whose clickable child is already a better target.
 * `matchesInteractive` is passed in so we can cheaply skip anything the primary
 * pass already covers.
 */
export function isLikelyClickable(
  el: Element,
  matchesInteractive: (el: Element) => boolean,
): boolean {
  if (matchesInteractive(el)) return false; // already captured by INTERACTIVE
  const style = getComputedStyle(el);
  if (style.cursor !== "pointer") return false;
  // Skip a wrapper that contains its own clickable child — prefer the leaf so
  // the ref points at the row/option the user would actually click, and we
  // don't double-list the same control as parent + child.
  if (el.querySelector(`${CLICKABLE_CANDIDATE}, a[href], button, [role], [onclick]`)) {
    const inner = el.querySelector<HTMLElement>("*");
    if (inner && getComputedStyle(inner).cursor === "pointer") return false;
  }
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  // A real option/button has a short label; long text is a content block that
  // merely inherited pointer cursor from an ancestor.
  return text.length > 0 && text.length <= 80;
}

export { CLICKABLE_CANDIDATE };

/**
 * Coarse page region an element belongs to, used to rank the snapshot so the
 * model's bounded element budget is spent on the controls a task actually needs
 * (an open menu, the main content) rather than the chrome that leads the
 * document (mega-menu, category nav). Derived from ARIA landmarks / semantic
 * tags by walking up from the element — the first ancestor that resolves a
 * region wins, so a button inside an open dialog is "dialog" even though the
 * dialog sits inside <main>.
 */
export type PageRegion = "dialog" | "main" | "nav" | "header" | "footer" | "other";

/**
 * Priority for ranking: a just-opened dropdown/dialog is what the model most
 * needs to see next, main content next, then the page chrome. Higher wins.
 */
const REGION_PRIORITY: Record<PageRegion, number> = {
  dialog: 5,
  main: 4,
  other: 3,
  nav: 2,
  header: 2,
  footer: 1,
};

export function regionPriority(region: PageRegion): number {
  return REGION_PRIORITY[region];
}

/**
 * Map a single element to its region by matching its tag/role/aria against the
 * landmark that owns it. Only decides for elements that *are* a landmark root;
 * regionOf() walks ancestors and calls this on each.
 */
function regionOfSelf(el: Element): PageRegion | null {
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  // Open menus/dialogs/listboxes: the transient overlay a click just opened.
  if (
    role === "dialog" ||
    role === "alertdialog" ||
    role === "menu" ||
    role === "listbox" ||
    tag === "dialog"
  ) {
    return "dialog";
  }
  if (tag === "main" || role === "main") return "main";
  if (tag === "nav" || role === "navigation") return "nav";
  if (tag === "header" || role === "banner") return "header";
  if (tag === "footer" || role === "contentinfo") return "footer";
  return null;
}

export function regionOf(el: Element): PageRegion {
  let node: Element | null = el;
  // Bound the walk: real landmark nesting is shallow, and this runs per element.
  for (let depth = 0; node && depth < 30; depth++) {
    const region = regionOfSelf(node);
    if (region) return region;
    node = node.parentElement;
  }
  return "other";
}

/** id/class fragments that reliably mark advertising / tracking containers. */
const AD_CONTAINER_RE =
  /(?:^|[-_\s])(?:ad|ads|advert|advertis\w*|sponsor\w*|banner|promo|gpt|dfp|taboola|outbrain|doubleclick|adslot|ad-slot|ad-unit|ad-container)(?:$|[-_\s\d])/i;

/**
 * True if this element is page noise the model should not spend budget on:
 * ad/tracking containers, or anything explicitly hidden from the accessibility
 * tree (aria-hidden). Footer links are ranked *low* (see regionOf) rather than
 * dropped, since a task can legitimately target them ("open the privacy
 * policy"); ads are dropped outright because no user task targets them and they
 * are a common injection surface. Walks a bounded set of ancestors so an ad
 * <iframe>'s inner controls are caught too.
 */
export function isNoise(el: Element): boolean {
  let node: Element | null = el;
  for (let depth = 0; node && depth < 30; depth++) {
    if (node.getAttribute("aria-hidden") === "true") return true;
    const tag = node.tagName.toLowerCase();
    if (tag === "ins") return true; // adsbygoogle et al.
    const id = node.id || "";
    const cls = typeof node.className === "string" ? node.className : "";
    if (AD_CONTAINER_RE.test(id) || AD_CONTAINER_RE.test(cls)) return true;
    node = node.parentElement;
  }
  return false;
}

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

/** input[type] values that commonly hold secrets — never send their raw value. */
const SENSITIVE_INPUT_TYPES = new Set(["password", "hidden"]);

/** Field name/autocomplete/label hints that suggest a secret even on type="text". */
const SENSITIVE_FIELD_RE =
  /pass(?:word|wd|code)|secret|token|api[_-]?key|auth|otp|one[_-]?time|cvv|cvc|card[_-]?number|ssn|pin\b/i;

/**
 * True if this element's value should never be sent to the model verbatim.
 * Covers password/hidden inputs and text-like fields whose name/id/autocomplete/
 * placeholder/label mark them as a credential or one-time-code field (many
 * login and MFA forms use type="text" for these). Redacting by type alone
 * would miss those. `label` is the computed label (labelFor(el)) — pass it in
 * rather than recomputing here since the caller already has it.
 */
export function isSensitiveField(el: Element, label = ""): boolean {
  const input = el as HTMLInputElement;
  const type = (input.type || "").toLowerCase();
  if (SENSITIVE_INPUT_TYPES.has(type)) return true;
  const hints = [
    input.name,
    input.id,
    input.getAttribute("autocomplete"),
    input.placeholder,
    label,
  ]
    .filter(Boolean)
    .join(" ");
  return SENSITIVE_FIELD_RE.test(hints);
}
