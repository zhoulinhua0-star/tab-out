# Tab Out

**Keep tabs on your tabs.**

Tab Out is a Chrome extension that replaces your new tab page with a dashboard of everything you have open. Tabs are grouped by domain, with homepages (Gmail, X, LinkedIn, etc.) pulled into their own group. Close tabs with a satisfying swoosh + confetti.

This fork also ships **Tab Out for Edge**: the same behavior in a dedicated **`edge-tab-out/`** folder with a cooler visual theme for Chromium-based Microsoft Edge.

No server. No account. No external API calls. Just a browser extension.

---

## Install with a coding agent

Send your coding agent (Claude Code, Codex, etc.) this repo and say **"install this"**:

```
https://github.com/zarazhangrui/tab-out
```

The agent will walk you through it. Takes about 1 minute.

---

## Features

- **See all your tabs at a glance** on a clean grid, grouped by domain
- **Homepages group** pulls Gmail inbox, X home, YouTube, LinkedIn, GitHub homepages into one card
- **Close tabs with style** with swoosh sound + confetti burst
- **Duplicate detection** flags when you have the same page open twice, with one-click cleanup
- **Click any tab to jump to it** across windows, no new tab opened
- **Save for later** bookmark tabs to a checklist before closing them
- **Localhost grouping** shows port numbers next to each tab so you can tell your vibe coding projects apart
- **Expandable groups** show the first 8 tabs with a clickable "+N more"
- **Background theme** — pick warm (classic orange paper), cool blue, or your own custom color; choice is saved locally in `chrome.storage.local`
- **100% local** your data never leaves your machine
- **Pure Chrome extension** no server, no Node.js, no npm, no setup beyond loading the extension

---

## Manual Setup

**1. Clone the repo**

```bash
git clone https://github.com/zarazhangrui/tab-out.git
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

You should see **Tab Out for Edge** with the glacier-themed dashboard. The quick-search bar uses **Bing** for plain queries (aligned with Edge).

**Note:** Only one extension can override the new tab page at a time. If another extension already replaces new tabs, disable its override or unload that extension first.

---

## How it works

```
You open a new tab
  -> Tab Out shows your open tabs grouped by domain
  -> Homepages (Gmail, X, etc.) get their own group at the top
  -> Click any tab title to jump to it
  -> Close groups you're done with (swoosh + confetti)
  -> Save tabs for later before closing them
```

Everything runs inside the Chrome extension. No external server, no API calls, no data sent anywhere. Saved tabs are stored in `chrome.storage.local`.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |

---

## License

MIT

---

Fork maintained as **Tab-out**. Original project by [Zara](https://x.com/zarazhangrui).
