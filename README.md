# 🐵 Gemini Browser Agent

A Chrome (Manifest V3) extension that makes the browser AI-driven. You type a
**ticket** in natural language into a side-panel chat; Gemini reads the current
page, drafts a **short step-by-step plan**, then walks the plan one action at a
time — **highlighting the element** it wants to touch and **asking for your
confirmation** before it clicks, types, or navigates.

It can also **ask clarifying questions** when the page is ambiguous or an action
looks risky.

## How it works

```
Side Panel (React)  ──msg──▶  Background worker  ──REST──▶  Gemini
   chat / plan / controls         orchestrator              (function calling)
        ▲                              │
        └──────── state ◀──────────────┤
                                       │ msg
                                       ▼
                              Content script (per tab)
                       snapshot DOM · highlight · execute action
```

- **Background service worker** ([src/background/](src/background/)) is the single
  source of truth. It holds state, calls Gemini with **function calling** so the
  model returns a structured plan and one structured action at a time, and drives
  the content script. The plan/step/action loop and all confirm-gating live here.
- **Content script** ([src/content/content-script.ts](src/content/content-script.ts)) builds a
  compact, ranked map of interactive elements (each tagged with a stable `ref`),
  draws the highlight overlay, and executes confirmed actions (`click`, `type`,
  `select`, `scrollTo`, `extract`). React-controlled inputs are handled via the
  native value setter so frameworks see the change.
- **Side panel** ([src/sidepanel/](src/sidepanel/)) is a thin renderer: chat
  input, live plan, the pending-action card (Run / Skip / Next step), and
  pause/resume/reset controls.

## Setup

Requires **Node 20.19+ (Node 22 LTS recommended)** and **pnpm**. An `.nvmrc`
pins Node 22; `package.json` pins `pnpm@10` via `packageManager`.

```bash
nvm use            # picks up .nvmrc (Node 22)
corepack enable    # provisions the pinned pnpm, if not already available
pnpm install
pnpm build         # outputs the unpacked extension to ./dist
# or, for iterative work:
pnpm dev           # rebuilds on change (still load ./dist as unpacked)
```

Toolchain: Vite 8, React 19, TypeScript 6, `@vitejs/plugin-react` 6, CRXJS 2.7.

### Load it in Chrome

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select the **`dist/`** folder.
4. Pin the extension and click its icon — the side panel opens.

### Add your Gemini key

1. Get a free key at <https://aistudio.google.com/apikey>.
2. In the side panel, click **⚙️ → Gemini API key**, paste it, **Save**.
   The key is stored with `chrome.storage.local` (this browser only) and is sent
   only to `generativelanguage.googleapis.com`.

> The question asked **API key vs Google-account OAuth**; this build uses an
> **API key** (AI Studio). Consumer Google accounts don't expose a clean Gemini
> API, so OAuth was intentionally skipped.

## Using it

1. Navigate to a normal web page (not `chrome://` / the Web Store — those are
   off-limits to extensions).
2. Type a ticket, e.g. *"Subscribe to the newsletter with my email"* and press
   **Enter**.
3. Review the plan. The agent proposes the first action and **highlights the
   target element** on the page.
4. **✓ Run** to execute, **✕ Skip** to reject (optionally type what to do
   instead), or **Next step ⏭** to mark the step done and move on.
5. If the agent needs info it **asks** — the composer switches to *Reply* mode.

Turn on **Settings → Auto-execute** to run each step's actions without per-action
confirmation (faster, less safe).

## Design notes / best practices borrowed from AI coding agents

- **Structured tool calling**, not prose parsing: the model emits `propose_plan`
  and `propose_action` function calls with a fixed schema.
- **One action at a time**, re-snapshotting the page between actions, so the
  model always reasons over fresh, grounded DOM state.
- **Human-in-the-loop by default** with a clear preview + highlight before any
  side effect; destructive actions are nudged toward asking first via the system
  prompt.
- **Bounded context**: the element map is capped and ranked (visible first) to
  keep prompts small and fast.

## Limitations

- Single-tab; iframes and shadow DOM aren't traversed.
- No persistent run history across browser restarts (state lives in the worker).
- The placeholder icons in `public/icons/` are solid-color squares — swap them
  for real art before publishing.

## Project layout

```
src/
  manifest.config.ts      # MV3 manifest (CRXJS)
  shared/types.ts         # shared types + messaging contract
  background/
    service-worker.ts     # orchestrator + message router
    gemini.ts             # Gemini REST client (function calling)
  content/content-script.ts  # DOM snapshot, highlight, action execution
  sidepanel/
    index.html main.tsx App.tsx Settings.tsx styles.css
public/icons/             # extension icons
```
