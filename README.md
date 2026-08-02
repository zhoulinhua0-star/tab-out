# Tab Out

**Keep tabs on your tabs.**

Tab Out is a Chrome and Edge extension that replaces the new tab page with a dashboard of everything you have open. Tabs are grouped by domain, with homepages (Gmail, X, LinkedIn, etc.) pulled into their own group. Find an existing tab, save something for later, or close a whole group without leaving the dashboard.

This fork also ships **Tab Out for Edge**: the same behavior in a dedicated **`edge-tab-out/`** folder for Chromium-based Microsoft Edge.

No server. No account. No tab or saved-page data leaves your browser.

---

## Install with a coding agent

Send your coding agent (Claude Code, Codex, etc.) this repo and say **"install this"**:

```
https://github.com/zhoulinhua0-star/tab-out
```

The agent will walk you through it. Takes about 1 minute.

---

## Features

- **See all your tabs at a glance** on a clean grid, grouped by domain
- **Homepages group** pulls Gmail inbox, X home, YouTube, LinkedIn, GitHub homepages into one card
- **Close tabs with style** with swoosh sound + confetti burst
- **Duplicate detection** flags when you have the same page open twice, with one-click cleanup
- **Safe bulk cleanup** keeps pinned, playing, active, and browser-detected captured tabs open, with a 7-second Undo for domain and global closes
- **Click any tab to jump to it** across windows, no new tab opened
- **Open-tab search** finds matching tabs as you type, with keyboard navigation before Google or Bing search
- **Recently used ordering** keeps Homepages first and brings the most recently used domain cards forward
- **Save for later** bookmark tabs to a checklist before closing them
- **Localhost grouping** shows port numbers next to each tab so you can tell your vibe coding projects apart
- **Expandable groups** show the first 8 tabs with a clickable "+N more"
- **Warm Paper design** — the original calm paper background and orange accent stay consistent in Chrome and Edge
- **Smooth shortcut organizer** — drag shortcuts with live reflow, keep the dashboard compact with a two-row limit, and expand the rest with **More**
- **Keyboard-friendly controls** — reorder shortcuts with Alt + Arrow keys, operate dialogs and menus without a pointer, and reduce motion automatically when requested by the OS
- **Stable new-tab rendering** — opening or refreshing the dashboard does not run full-frame entrance animations
- **Browser-local favicons** use Chromium's favicon cache instead of a third-party icon service
- **Local data** — open-tab information stays in the browser and saved items use `chrome.storage.local`
- **Pure Chrome extension** no server, no Node.js, no npm, no setup beyond loading the extension

---

## Everyday guide

| When you want to… | Use… | What happens |
|---|---|---|
| Find a page you already opened | The top search box | Matching open tabs appear before the Google or Bing fallback |
| Return to recent work | Recently used ordering | Homepages stays first; the remaining domain cards follow their most recently used tab |
| Close one page | The **×** beside that tab | Only that exact tab closes |
| Clean up one website | **Close N tabs** on its card | Ordinary tabs close; protected tabs stay open; Undo remains available for 7 seconds |
| Clean up everything | The close button beside **Open tabs** | All closeable tabs are removed across domain cards, with the same protection and Undo behavior |
| Keep something for later | The bookmark button beside a tab | The page moves into the Saved for later checklist |
| Remove duplicate pages | **Close duplicates** | One copy remains open |
| Open a frequent destination | An app shortcut | The shortcut opens directly; use **+ Add shortcut** to create more |
| Organize shortcuts | Drag, or press **Alt + Arrow** | The new order is saved locally |

Bulk cleanup automatically protects pinned tabs, tabs playing audio, the currently active tab, and tabs Chromium reports as being captured. The close button tells you how many tabs will close and how many are protected.

Search keyboard controls:

- **Up / Down** selects an open-tab result or the web-search fallback.
- **Enter** opens the selected result. With no result selected, it performs the normal web search.
- **Escape** closes the suggestions.

---

## Manual Setup

**1. Clone the repo**

```bash
git clone https://github.com/zhoulinhua0-star/tab-out.git
```

**2. Load the Chrome extension**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Navigate to the `extension/` folder inside the cloned repo and select it

**3. Open a new tab**

You'll see Tab Out.

---

## Microsoft Edge (`edge-tab-out`)

The Edge build mirrors the Chrome extension (Manifest V3, same features). Load **`edge-tab-out/`**, not `extension/`.

**1. Open Edge extension settings**

Go to `edge://extensions`.

**2. Enable Developer mode**

Use the **Developer mode** toggle in the left sidebar.

**3. Load unpacked**

Click **Load unpacked** and select the **`edge-tab-out`** folder inside your cloned repo.

**4. Open a new tab**

You should see **Tab Out for Edge** with the Warm Paper dashboard. The quick-search bar uses **Bing** for plain queries (aligned with Edge).

**Note:** Only one extension can override the new tab page at a time. If another extension already replaces new tabs, disable its override or unload that extension first.

---

## How it works

```
You open a new tab
  -> Tab Out reads the current browser tabs locally
  -> Homepages stays first; other domain cards follow recent use
  -> Search checks existing tabs before Google or Bing
  -> Click any tab title to jump to it
  -> Close groups you're done with while protected tabs stay open
  -> Use Undo within 7 seconds after a domain or global bulk close
  -> Save tabs for later before closing them
```

Everything runs inside the extension. Saved tabs and shortcut order are stored in `chrome.storage.local`; browsing and tab data are not sent to a Tab Out server.

---

## Permissions

| Permission | Why Tab Out needs it |
|---|---|
| `tabs` | Read, focus, create, and close the exact tabs shown on the dashboard |
| `activeTab` | Work with the active browser tab when the user invokes the extension |
| `storage` | Save shortcuts and the Saved for later checklist locally |
| `favicon` | Display favicons from Chromium's local favicon cache |

Tab Out does not request host permissions for the websites you visit.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |
| UI regression tests | Node.js + isolated Chrome DevTools harness (development only) |

Chrome and Edge keep separate extension folders, but their dashboard logic is intentionally kept in sync. See [CHANGELOG.md](CHANGELOG.md) for the release history and current unreleased improvements.

---

## License

MIT

---

Fork maintained as **Tab-out**. Original project by [Zara](https://x.com/zarazhangrui).
