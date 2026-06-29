/**
 * The ref registry: stable `ref` ids that map back to live DOM nodes, plus the
 * resilient resolution that survives a lost map or an SPA re-render.
 *
 * Refs are fragile on their own: the map lives only as long as this module
 * instance, and `data-gba-ref` attributes are wiped whenever the SPA re-mounts
 * a node. When that happens `refMap.get(ref)` returns nothing (or a detached
 * node) and a click fails with "Element not found". Keeping a lightweight
 * fingerprint per ref lets us find the element again by its identifying traits.
 */

import { INTERACTIVE, labelFor } from "./dom";

export const REF_ATTR = "data-gba-ref";

/**
 * Descriptors recorded at snapshot time so a ref can be re-resolved against the
 * live DOM even after the map is lost or the original node was re-rendered.
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

let refCounter = 0;
const refMap = new Map<string, Element>();
const refDescriptors = new Map<string, RefDescriptor>();

/** Drop all refs and their `data-gba-ref` attributes. Called per snapshot. */
export function resetRefs() {
  refMap.clear();
  refDescriptors.clear();
  document.querySelectorAll(`[${REF_ATTR}]`).forEach((e) => e.removeAttribute(REF_ATTR));
  refCounter = 0;
}

/**
 * Register `el` under a fresh ref: tag the node, store it in the map, and record
 * its fingerprint for later re-resolution. Returns the assigned ref.
 */
export function registerRef(el: Element): string {
  const ref = `e${++refCounter}`;
  el.setAttribute(REF_ATTR, ref);
  refMap.set(ref, el);

  const input = el as HTMLInputElement;
  refDescriptors.set(ref, {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role"),
    type: input.type || null,
    label: labelFor(el),
    href: (el as HTMLAnchorElement).href || null,
    placeholder: input.placeholder || null,
    name: el.getAttribute("name"),
  });
  return ref;
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
export function resolveRef(ref: string | undefined): Element | null {
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
