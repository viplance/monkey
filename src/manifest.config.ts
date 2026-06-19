import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Monkey Browser AI",
  version: "0.1.0",
  description:
    "Turn natural-language tickets into step-by-step, confirm-before-act browser automation driven by Gemini.",
  permissions: ["sidePanel", "storage", "scripting", "activeTab", "tabs"],
  // The agent must be able to read/act on whatever page the user is on, and
  // call the Gemini API. http(s)://*/* covers any normal web page; the Gemini
  // host is included explicitly. (Chrome:// and store pages are never
  // accessible regardless and are filtered out in the worker.)
  host_permissions: [
    "http://*/*",
    "https://*/*",
    "https://generativelanguage.googleapis.com/*",
  ],
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  action: {
    default_title: "Open Monkey Browser AI",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  content_scripts: [
    {
      // Injected programmatically too, but declaring keeps it available on
      // navigation for already-open pages.
      matches: ["<all_urls>"],
      js: ["src/content/content-script.ts"],
      run_at: "document_idle",
    },
  ],
  icons: {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png",
  },
});
