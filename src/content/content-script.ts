/**
 * Content script: the agent's hands and eyes on the page. This is the entry
 * point — it routes background messages to the focused modules:
 *
 * - SNAPSHOT (./snapshot): builds a compact, ranked map of interactive elements
 *   + a stable `ref` per element (see ./refs) so the model's ref resolves back
 *   to the live node.
 * - HIGHLIGHT / CLEAR_HIGHLIGHT (./highlight): overlays a highlight on refs.
 * - EXECUTE (./actions): performs a confirmed action.
 */

import type { BgToContent, ContentReply } from "../shared/types";
import { execute } from "./actions";
import { clearHighlight, highlight } from "./highlight";
import { installPageDebugCollector } from "./page-debug";
import { snapshot } from "./snapshot";

installPageDebugCollector();

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
