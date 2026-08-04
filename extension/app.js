/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];
let quickAccessBound = false;
let appShortcuts = [];
let contextShortcutId = null;
let editingShortcutId = null;
let lastRemovedShortcut = null;
let toastHideTimeout = null;
let undoTimeout = null;
let draggingShortcutId = null;
let dragMoved = false;
let tabRefreshTimeout = null;
let shortcutsExpanded = false;
let shortcutPointerDrag = null;
let shortcutResizeTimeout = null;
let shortcutModalReturnFocus = null;

// Google-like app shortcuts. Customize this list with your own apps.
const DEFAULT_APP_SHORTCUTS = [];
const APP_SHORTCUTS_STORAGE_KEY = 'appShortcuts';
const IS_EDGE = navigator.userAgent.includes('Edg/');

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      index:    t.index,
      lastAccessed: Number(t.lastAccessed) || 0,
      active:   t.active,
      pinned:   Boolean(t.pinned),
      audible:  Boolean(t.audible),
      mutedInfo: t.mutedInfo || null,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut:
        t.url === newtabUrl ||
        t.url === 'chrome://newtab/' ||
        t.url === 'edge://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/** Close the exact browser tabs represented by the dashboard. */
async function closeTabsByIds(ids) {
  const uniqueIds = [...new Set(ids)].filter(Number.isInteger);
  if (uniqueIds.length > 0) await chrome.tabs.remove(uniqueIds);
  await fetchOpenTabs();
}

function getProtectedTabReasons(tab) {
  const reasons = [];
  if (tab.pinned) reasons.push('pinned');
  if (tab.audible) reasons.push('playing audio');
  if (tab.active) reasons.push('active');
  if (tab.mutedInfo?.reason === 'capture') reasons.push('being captured');
  return reasons;
}

function partitionTabsForBulkClose(tabs) {
  const closeableTabs = [];
  const protectedTabs = [];
  for (const tab of tabs) {
    const reasons = getProtectedTabReasons(tab);
    if (reasons.length > 0) protectedTabs.push({ tab, reasons });
    else closeableTabs.push(tab);
  }
  return { closeableTabs, protectedTabs };
}

function bulkCloseButtonLabel(closeableCount, protectedCount) {
  if (closeableCount === 0) return `All ${protectedCount} protected`;
  const closeLabel = `Close ${closeableCount} tab${closeableCount !== 1 ? 's' : ''}`;
  return protectedCount > 0 ? `${closeLabel} · ${protectedCount} protected` : closeLabel;
}

async function restoreClosedTabs(tabs) {
  let restoredCount = 0;
  const orderedTabs = [...tabs].sort((a, b) =>
    (a.windowId - b.windowId) || (a.index - b.index)
  );

  for (const tab of orderedTabs) {
    const createProperties = { url: tab.url, active: false };
    if (Number.isInteger(tab.windowId)) createProperties.windowId = tab.windowId;
    if (Number.isInteger(tab.index)) createProperties.index = tab.index;

    try {
      await chrome.tabs.create(createProperties);
      restoredCount += 1;
    } catch {
      try {
        await chrome.tabs.create({ url: tab.url, active: false });
        restoredCount += 1;
      } catch {
        /* skip URLs the browser refuses to restore */
      }
    }
  }

  await refreshDashboardQuietly();
  showToast(restoredCount > 0
    ? `Restored ${restoredCount} tab${restoredCount !== 1 ? 's' : ''}`
    : 'Could not restore tabs');
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url, tabId = null) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Prefer the exact tab represented by the clicked row.
  let matches = Number.isInteger(tabId) ? allTabs.filter(t => t.id === tabId) : [];

  // Try exact URL match next.
  if (matches.length === 0) matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl ||
    t.url === 'chrome://newtab/' ||
    t.url === 'edge://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * clearArchivedTab(id)
 *
 * Clears one archived (completed) tab from the archive list.
 */
async function clearArchivedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab && tab.completed) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message, options = {}) {
  const { undoLabel = '', onUndo = null, durationMs = 2500 } = options;
  const toast = document.getElementById('toast');
  const undoBtn = document.getElementById('toastUndoBtn');
  document.getElementById('toastText').textContent = message;

  if (undoBtn) {
    undoBtn.style.display = onUndo ? 'inline-flex' : 'none';
    undoBtn.textContent = undoLabel || 'Undo';
    undoBtn.onclick = onUndo ? () => {
      onUndo();
      hideShortcutContextMenu();
      toast.classList.remove('visible');
      undoBtn.style.display = 'none';
    } : null;
  }

  toast.classList.add('visible');
  if (toastHideTimeout) clearTimeout(toastHideTimeout);
  toastHideTimeout = setTimeout(() => {
    toast.classList.remove('visible');
    if (undoBtn) undoBtn.style.display = 'none';
  }, durationMs);
}

/**
 * renderEmptyState()
 *
 * Keeps the cheerful "Inbox zero" state visible until tabs return.
 */
function renderEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  if (!missionsEl.querySelector('.missions-empty-state')) {
    missionsEl.innerHTML = `
      <div class="missions-empty-state">
        <div class="empty-checkmark">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
        </div>
        <div class="empty-title">Inbox zero, but for tabs.</div>
        <div class="empty-subtitle">You're free.</div>
      </div>
    `;
  }

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/** Shows the empty state after the last visible domain card closes. */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  renderEmptyState();
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}

function normalizeSearchDestination(rawInput) {
  const value = (rawInput || '').trim();
  if (!value) return '';

  const searchUrl = query => IS_EDGE
    ? `https://www.bing.com/search?q=${encodeURIComponent(query)}`
    : `https://www.google.com/search?q=${encodeURIComponent(query)}`;

  // If there are spaces, treat input as search query.
  if (/\s/.test(value)) {
    return searchUrl(value);
  }

  // Accept explicit URL protocols directly.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    return value;
  }

  // Looks like a host/path (e.g. github.com or localhost:3000/foo).
  if (value.includes('.') || value.startsWith('localhost:')) {
    return `https://${value}`;
  }

  return searchUrl(value);
}

function openExternalUrl(url) {
  if (!url) return;
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.update) {
    chrome.tabs.update({ url }).catch(() => {
      window.location.assign(url);
    });
    return;
  }
  window.location.assign(url);
}

function buildShortcutId() {
  return 'shortcut-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function normalizeShortcutUrl(rawUrl) {
  const value = (rawUrl || '').trim();
  if (!value) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(?:\/|$)/i.test(value)) return `http://${value}`;
  return `https://${value}`;
}

function isSupportedShortcutUrl(rawUrl) {
  try {
    const { protocol } = new URL(rawUrl);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
  } catch {
    return false;
  }
}

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Uses the browser's local favicon cache; no hostname is sent to a third party. */
function localFaviconUrl(pageUrl, size = 16) {
  try {
    const u = new URL(pageUrl);
    if (!['http:', 'https:', 'file:'].includes(u.protocol)) return '';
    const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
    favicon.searchParams.set('pageUrl', u.href);
    favicon.searchParams.set('size', String(size));
    return favicon.toString();
  } catch {
    return '';
  }
}

async function loadAppShortcuts() {
  const defaults = (typeof LOCAL_APP_SHORTCUTS !== 'undefined' && Array.isArray(LOCAL_APP_SHORTCUTS) && LOCAL_APP_SHORTCUTS.length > 0)
    ? LOCAL_APP_SHORTCUTS
    : DEFAULT_APP_SHORTCUTS;

  try {
    const stored = await chrome.storage.local.get(APP_SHORTCUTS_STORAGE_KEY);
    const fromStorage = stored[APP_SHORTCUTS_STORAGE_KEY];
    if (Array.isArray(fromStorage)) {
      appShortcuts = fromStorage.map(item => ({
        id: typeof item.id === 'string' && item.id ? item.id : buildShortcutId(),
        name: String(item.name || '').trim() || 'App',
        url: normalizeShortcutUrl(item.url),
        icon: String(item.icon || item.name || 'A').trim().slice(0, 2).toUpperCase(),
      }));
      return;
    }
  } catch (err) {
    console.warn('[tab-out] Could not read shortcut storage:', err);
  }

  appShortcuts = defaults.map(item => ({
    id: buildShortcutId(),
    name: (item.name || '').trim() || 'App',
    url: normalizeShortcutUrl(item.url),
    icon: ((item.icon || '').trim() || (item.name || 'A').charAt(0)).slice(0, 2).toUpperCase(),
  }));
  await saveAppShortcuts();
}

async function saveAppShortcuts() {
  await chrome.storage.local.set({ [APP_SHORTCUTS_STORAGE_KEY]: appShortcuts });
}

function getShortcutColumnCount(shortcutsEl) {
  const columnWidth = window.innerWidth <= 800 ? 72 : 84;
  const gap = 10;
  return Math.max(1, Math.floor((shortcutsEl.clientWidth + gap) / (columnWidth + gap)));
}

function announceShortcut(message) {
  const liveRegion = document.getElementById('shortcutLiveRegion');
  if (!liveRegion) return;
  liveRegion.textContent = '';
  requestAnimationFrame(() => { liveRegion.textContent = message; });
}

function renderAppShortcuts() {
  const shortcutsEl = document.getElementById('appShortcuts');
  if (!shortcutsEl) return;

  const columnCount = getShortcutColumnCount(shortcutsEl);
  const collapsedCapacity = Math.max(2, columnCount * 2);
  const hasOverflow = appShortcuts.length > collapsedCapacity;
  const visibleCount = shortcutsExpanded || !hasOverflow
    ? appShortcuts.length
    : collapsedCapacity - 1;
  const visibleShortcuts = appShortcuts.slice(0, visibleCount);
  const hiddenCount = appShortcuts.length - visibleShortcuts.length;

  shortcutsEl.classList.toggle('is-expanded', shortcutsExpanded);
  shortcutsEl.innerHTML = visibleShortcuts.map((item) => {
    const name = (item.name || '').trim() || 'App';
    const url = (item.url || '').trim();
    const icon = (item.icon || name.charAt(0) || 'A').slice(0, 2).toUpperCase();
    const safeName = escapeHtmlAttr(name);
    const safeUrl = escapeHtmlAttr(isSupportedShortcutUrl(url) ? url : '#');
    const safeId = escapeHtmlAttr(item.id);
    const faviconSrc = localFaviconUrl(url, 64);
    const favIconClass = faviconSrc ? ' app-shortcut-icon--favicon' : '';
    const favImg = faviconSrc
      ? `<img class="app-shortcut-favicon" src="${escapeHtmlAttr(faviconSrc)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      : '';
    return `
      <div class="app-shortcut" data-shortcut-id="${safeId}">
        <a class="app-shortcut-link" href="${safeUrl}" title="${safeName}" draggable="false" data-shortcut-link="${safeId}" aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown">
          <span class="app-shortcut-icon${favIconClass}" aria-hidden="true">
            ${favImg}
            <span class="app-shortcut-fallback">${escapeHtmlText(icon)}</span>
          </span>
          <span class="app-shortcut-label">${escapeHtmlText(name)}</span>
        </a>
        <button type="button" class="shortcut-options-btn" data-shortcut-options="${safeId}" aria-label="Options for ${safeName}" title="Shortcut options">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle></svg>
        </button>
      </div>
    `;
  }).join('') + (hasOverflow || shortcutsExpanded ? `
    <button type="button" class="app-shortcut shortcut-overflow-toggle" data-shortcut-overflow="true" aria-expanded="${shortcutsExpanded}">
      <span class="app-shortcut-icon shortcut-overflow-icon" aria-hidden="true">${shortcutsExpanded ? '−' : `+${hiddenCount}`}</span>
      <span class="app-shortcut-label">${shortcutsExpanded ? 'Show less' : 'More'}</span>
    </button>
  ` : '');

  shortcutsEl.querySelectorAll('.app-shortcut-favicon').forEach((img) => {
    img.addEventListener('error', () => {
      const wrap = img.closest('.app-shortcut-icon');
      if (wrap) wrap.classList.add('is-favicon-error');
    });
  });
}

function hideShortcutContextMenu() {
  const menu = document.getElementById('shortcutContextMenu');
  if (!menu) return;
  menu.style.display = 'none';
  contextShortcutId = null;
}

function showShortcutContextMenu(x, y, shortcutId) {
  const menu = document.getElementById('shortcutContextMenu');
  if (!menu) return;
  contextShortcutId = shortcutId;
  menu.style.display = 'block';
  const menuWidth = menu.offsetWidth || 164;
  const menuHeight = menu.offsetHeight || 88;
  const left = Math.min(x, window.innerWidth - menuWidth - 8);
  const top = Math.min(y, window.innerHeight - menuHeight - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  requestAnimationFrame(() => menu.querySelector('button')?.focus());
}

function closeShortcutModal() {
  const modal = document.getElementById('shortcutModal');
  if (!modal) return;
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
  editingShortcutId = null;
  if (shortcutModalReturnFocus && document.contains(shortcutModalReturnFocus)) {
    shortcutModalReturnFocus.focus();
  } else {
    document.getElementById('addShortcutBtn')?.focus();
  }
  shortcutModalReturnFocus = null;
}

function openShortcutModal(mode, shortcutId = null) {
  const modal = document.getElementById('shortcutModal');
  const form = document.getElementById('shortcutForm');
  const title = document.getElementById('shortcutModalTitle');
  const nameInput = document.getElementById('shortcutNameInput');
  const urlInput = document.getElementById('shortcutUrlInput');
  const iconInput = document.getElementById('shortcutIconInput');
  if (!modal || !form || !title || !nameInput || !urlInput || !iconInput) return;
  shortcutModalReturnFocus = shortcutId
    ? document.querySelector(`[data-shortcut-options="${CSS.escape(shortcutId)}"]`)
    : (document.activeElement && document.activeElement !== document.body
      ? document.activeElement
      : document.getElementById('addShortcutBtn'));

  if (mode === 'edit') {
    const shortcut = appShortcuts.find(item => item.id === shortcutId);
    if (!shortcut) return;
    editingShortcutId = shortcut.id;
    title.textContent = 'Edit shortcut';
    nameInput.value = shortcut.name || '';
    urlInput.value = shortcut.url || '';
    iconInput.value = (shortcut.icon || '').slice(0, 2);
  } else {
    editingShortcutId = null;
    title.textContent = 'Add shortcut';
    form.reset();
  }

  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
  nameInput.focus();
}

async function removeShortcutWithUndo(shortcutId) {
  const index = appShortcuts.findIndex(item => item.id === shortcutId);
  if (index === -1) return;
  const [removed] = appShortcuts.splice(index, 1);
  await saveAppShortcuts();
  renderAppShortcuts();

  if (undoTimeout) clearTimeout(undoTimeout);
  lastRemovedShortcut = { shortcut: removed, index };
  undoTimeout = setTimeout(() => {
    lastRemovedShortcut = null;
    undoTimeout = null;
  }, 5000);

  showToast('Shortcut removed', {
    undoLabel: 'Undo',
    durationMs: 5000,
    onUndo: async () => {
      if (!lastRemovedShortcut) return;
      const { shortcut, index: restoreIndex } = lastRemovedShortcut;
      appShortcuts.splice(Math.min(restoreIndex, appShortcuts.length), 0, shortcut);
      await saveAppShortcuts();
      renderAppShortcuts();
      lastRemovedShortcut = null;
      if (undoTimeout) clearTimeout(undoTimeout);
      undoTimeout = null;
      showToast('Shortcut restored');
    },
  });
}

async function saveVisibleShortcutOrder(shortcutsEl) {
  const visibleIds = [...shortcutsEl.querySelectorAll('.app-shortcut[data-shortcut-id]')]
    .map(el => el.dataset.shortcutId)
    .filter(Boolean);
  const visibleSet = new Set(visibleIds);
  const byId = new Map(appShortcuts.map(item => [item.id, item]));
  let nextVisibleIndex = 0;
  appShortcuts = appShortcuts.map(item => {
    if (!visibleSet.has(item.id)) return item;
    return byId.get(visibleIds[nextVisibleIndex++]);
  });
  await saveAppShortcuts();
}

async function moveShortcutByKeyboard(shortcutId, key, shortcutsEl) {
  const fromIndex = appShortcuts.findIndex(item => item.id === shortcutId);
  if (fromIndex === -1) return;
  const columns = getShortcutColumnCount(shortcutsEl);
  const offsets = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -columns,
    ArrowDown: columns,
  };
  const toIndex = Math.max(0, Math.min(appShortcuts.length - 1, fromIndex + offsets[key]));
  if (toIndex === fromIndex) {
    announceShortcut('Shortcut is already at the edge of the grid.');
    return;
  }

  const [moved] = appShortcuts.splice(fromIndex, 1);
  appShortcuts.splice(toIndex, 0, moved);
  if (appShortcuts.length > columns * 2) shortcutsExpanded = true;
  await saveAppShortcuts();
  renderAppShortcuts();
  requestAnimationFrame(() => {
    document.querySelector(`[data-shortcut-link="${CSS.escape(shortcutId)}"]`)?.focus();
  });
  announceShortcut(`${moved.name || 'Shortcut'} moved to position ${toIndex + 1} of ${appShortcuts.length}.`);
}

function animateShortcutReflow(shortcutsEl, beforeRects) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  shortcutsEl.querySelectorAll('.app-shortcut[data-shortcut-id]').forEach(el => {
    const before = beforeRects.get(el.dataset.shortcutId);
    if (!before) return;
    const after = el.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration: 190, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
    );
  });
}

function positionShortcutDragGhost(state, clientX, clientY) {
  state.ghost.style.left = `${clientX - state.offsetX}px`;
  state.ghost.style.top = `${clientY - state.offsetY}px`;
}

function beginShortcutPointerDrag(state, event, shortcutsEl) {
  state.started = true;
  dragMoved = true;
  draggingShortcutId = state.shortcut.dataset.shortcutId;
  const rect = state.shortcut.getBoundingClientRect();
  state.offsetX = event.clientX - rect.left;
  state.offsetY = event.clientY - rect.top;
  state.ghost = state.shortcut.cloneNode(true);
  state.ghost.classList.add('shortcut-drag-ghost');
  state.ghost.removeAttribute('data-shortcut-id');
  state.ghost.querySelectorAll('[id], [href], [data-shortcut-options]').forEach(el => {
    el.removeAttribute('id');
    el.removeAttribute('href');
    el.removeAttribute('data-shortcut-options');
  });
  state.ghost.style.width = `${rect.width}px`;
  state.ghost.style.height = `${rect.height}px`;
  document.body.appendChild(state.ghost);
  state.shortcut.classList.add('is-dragging');
  shortcutsEl.classList.add('is-sorting');
  state.shortcut.setPointerCapture(event.pointerId);
  positionShortcutDragGhost(state, event.clientX, event.clientY);
}

function updateShortcutPointerDrag(state, event, shortcutsEl) {
  positionShortcutDragGhost(state, event.clientX, event.clientY);
  const candidates = [...shortcutsEl.querySelectorAll('.app-shortcut[data-shortcut-id]')]
    .filter(el => el !== state.shortcut);
  if (candidates.length === 0) return;

  let target = null;
  let closestDistance = Infinity;
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const distance = dx * dx + dy * dy;
    if (distance < closestDistance) {
      closestDistance = distance;
      target = candidate;
    }
  }
  if (!target) return;

  const targetRect = target.getBoundingClientRect();
  const sameRow = event.clientY >= targetRect.top && event.clientY <= targetRect.bottom;
  const placeAfter = sameRow
    ? event.clientX > targetRect.left + targetRect.width / 2
    : event.clientY > targetRect.top + targetRect.height / 2;
  const reference = placeAfter ? target.nextElementSibling : target;
  if (reference === state.shortcut || (!reference && state.shortcut === shortcutsEl.lastElementChild)) return;

  const beforeRects = new Map(candidates.concat(state.shortcut).map(el => [
    el.dataset.shortcutId,
    el.getBoundingClientRect(),
  ]));
  shortcutsEl.insertBefore(state.shortcut, reference);
  animateShortcutReflow(shortcutsEl, beforeRects);
}

async function finishShortcutPointerDrag(state, shortcutsEl, cancelled = false) {
  if (state.ghost) state.ghost.remove();
  state.shortcut.classList.remove('is-dragging');
  shortcutsEl.classList.remove('is-sorting');
  draggingShortcutId = null;
  shortcutPointerDrag = null;
  if (!state.started) return;
  if (cancelled) {
    dragMoved = false;
    renderAppShortcuts();
    return;
  }
  await saveVisibleShortcutOrder(shortcutsEl);
  showToast('Shortcut order updated');
  setTimeout(() => { dragMoved = false; }, 0);
}

async function setupQuickAccess() {
  await loadAppShortcuts();
  renderAppShortcuts();
  if (quickAccessBound) return;

  const addBtn = document.getElementById('addShortcutBtn');
  const formEl = document.getElementById('quickSearchForm');
  const inputEl = document.getElementById('quickSearchInput');
  const resultsEl = document.getElementById('openTabSearchResults');
  const shortcutForm = document.getElementById('shortcutForm');
  const cancelBtn = document.getElementById('shortcutCancelBtn');
  const shortcutsEl = document.getElementById('appShortcuts');
  if (!formEl || !inputEl || !resultsEl || !shortcutForm || !cancelBtn || !addBtn || !shortcutsEl) return;

  let selectedSearchIndex = -1;

  function searchOptions() {
    return [...resultsEl.querySelectorAll('.open-tab-search-option')];
  }

  function hideOpenTabSearch() {
    resultsEl.hidden = true;
    selectedSearchIndex = -1;
    inputEl.setAttribute('aria-expanded', 'false');
    inputEl.removeAttribute('aria-activedescendant');
  }

  function selectSearchOption(index) {
    const options = searchOptions();
    if (options.length === 0) return;
    selectedSearchIndex = (index + options.length) % options.length;
    options.forEach((option, optionIndex) => {
      const selected = optionIndex === selectedSearchIndex;
      option.classList.toggle('is-active', selected);
      option.setAttribute('aria-selected', String(selected));
    });
    inputEl.setAttribute('aria-activedescendant', options[selectedSearchIndex].id);
  }

  function renderOpenTabSearch(rawQuery) {
    const query = rawQuery.trim();
    if (!query) {
      hideOpenTabSearch();
      return;
    }

    const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = getRealTabs()
      .filter(tab => {
        const searchable = `${tab.title || ''} ${tab.url || ''}`.toLocaleLowerCase();
        return tokens.every(token => searchable.includes(token));
      })
      .sort((a, b) => (b.lastAccessed - a.lastAccessed) || (a.index - b.index))
      .slice(0, 6);

    const openTabOptions = matches.map((tab, index) => {
      let hostname = tab.url;
      try { hostname = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
      const title = tab.title || hostname || tab.url;
      const faviconUrl = localFaviconUrl(tab.url, 18);
      return `<button type="button" class="open-tab-search-option" id="open-tab-search-option-${index}" role="option" aria-selected="false" data-search-tab-id="${escapeHtmlAttr(tab.id)}" data-search-tab-url="${escapeHtmlAttr(tab.url)}">
        ${faviconUrl ? `<img class="open-tab-search-favicon" src="${escapeHtmlAttr(faviconUrl)}" alt="">` : '<span class="open-tab-search-icon" aria-hidden="true">↗</span>'}
        <span class="open-tab-search-copy">
          <span class="open-tab-search-title">${escapeHtmlText(title)}</span>
          <span class="open-tab-search-meta">${escapeHtmlText(hostname)}</span>
        </span>
      </button>`;
    }).join('');

    const destination = normalizeSearchDestination(query);
    const provider = IS_EDGE ? 'Bing' : 'Google';
    const isWebSearch = destination.includes('/search?q=');
    const webLabel = isWebSearch ? `Search ${provider} for “${query}”` : `Open ${query}`;
    const webOptionIndex = matches.length;
    resultsEl.innerHTML = `${matches.length > 0 ? '<div class="open-tab-search-heading" role="presentation">Open tabs</div>' : ''}
      ${openTabOptions}
      <button type="button" class="open-tab-search-option open-tab-search-web" id="open-tab-search-option-${webOptionIndex}" role="option" aria-selected="false" data-search-destination="${escapeHtmlAttr(destination)}">
        <span class="open-tab-search-icon" aria-hidden="true">⌕</span>
        <span class="open-tab-search-copy">
          <span class="open-tab-search-title">${escapeHtmlText(webLabel)}</span>
          <span class="open-tab-search-meta">${matches.length > 0 ? 'Continue on the web' : 'No open tab matches'}</span>
        </span>
      </button>`;
    selectedSearchIndex = -1;
    resultsEl.hidden = false;
    inputEl.setAttribute('aria-expanded', 'true');
    inputEl.removeAttribute('aria-activedescendant');
  }

  resultsEl.addEventListener('click', async (e) => {
    const option = e.target.closest('.open-tab-search-option');
    if (!option) return;
    const tabId = Number(option.dataset.searchTabId);
    const tabUrl = option.dataset.searchTabUrl;
    const destination = option.dataset.searchDestination;
    hideOpenTabSearch();
    if (tabUrl && Number.isInteger(tabId)) await focusTab(tabUrl, tabId);
    else if (destination) openExternalUrl(destination);
    inputEl.select();
  });

  inputEl.addEventListener('input', () => renderOpenTabSearch(inputEl.value));
  inputEl.addEventListener('focus', () => renderOpenTabSearch(inputEl.value));
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (resultsEl.hidden) renderOpenTabSearch(inputEl.value);
      const options = searchOptions();
      if (options.length === 0) return;
      e.preventDefault();
      const offset = e.key === 'ArrowDown' ? 1 : -1;
      selectSearchOption(selectedSearchIndex === -1 && offset < 0 ? options.length - 1 : selectedSearchIndex + offset);
      return;
    }
    if (e.key === 'Enter' && !resultsEl.hidden && selectedSearchIndex >= 0) {
      e.preventDefault();
      searchOptions()[selectedSearchIndex]?.click();
      return;
    }
    if (e.key === 'Escape' && !resultsEl.hidden) {
      e.preventDefault();
      hideOpenTabSearch();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (!formEl.contains(e.target) && !resultsEl.contains(e.target)) hideOpenTabSearch();
  });

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const destination = normalizeSearchDestination(inputEl.value);
    if (!destination) return;
    hideOpenTabSearch();
    openExternalUrl(destination);
    inputEl.select();
  });

  addBtn.addEventListener('click', () => {
    hideShortcutContextMenu();
    openShortcutModal('add');
  });

  cancelBtn.addEventListener('click', closeShortcutModal);

  shortcutForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('shortcutNameInput');
    const urlInput = document.getElementById('shortcutUrlInput');
    const iconInput = document.getElementById('shortcutIconInput');
    if (!nameInput || !urlInput || !iconInput) return;

    const name = nameInput.value.trim();
    const normalizedUrl = normalizeShortcutUrl(urlInput.value);
    const icon = (iconInput.value.trim() || name.charAt(0) || 'A').slice(0, 2).toUpperCase();

    if (!name || !normalizedUrl) return;
    if (!isSupportedShortcutUrl(normalizedUrl)) {
      showToast('Please enter a valid URL');
      return;
    }

    if (editingShortcutId) {
      const index = appShortcuts.findIndex(item => item.id === editingShortcutId);
      if (index !== -1) {
        appShortcuts[index] = { ...appShortcuts[index], name, url: normalizedUrl, icon };
      }
      await saveAppShortcuts();
      renderAppShortcuts();
      closeShortcutModal();
      showToast('Shortcut updated');
      return;
    }

    appShortcuts.push({ id: buildShortcutId(), name, url: normalizedUrl, icon });
    shortcutsExpanded = true;
    await saveAppShortcuts();
    renderAppShortcuts();
    closeShortcutModal();
    showToast('Shortcut added');
  });

  document.addEventListener('contextmenu', (e) => {
    const shortcut = e.target.closest('.app-shortcut');
    if (!shortcut || !shortcut.dataset.shortcutId) return;
    e.preventDefault();
    showShortcutContextMenu(e.clientX, e.clientY, shortcut.dataset.shortcutId);
  });

  document.addEventListener('click', (e) => {
    const modal = document.getElementById('shortcutModal');
    if (modal && e.target === modal) closeShortcutModal();

    if (!e.target.closest('#shortcutContextMenu') && !e.target.closest('.app-shortcut')) {
      hideShortcutContextMenu();
    }
  });

  shortcutsEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const shortcut = e.target.closest('.app-shortcut[data-shortcut-id]');
    if (!shortcut) return;
    dragMoved = false;
    shortcutPointerDrag = {
      pointerId: e.pointerId,
      shortcut,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
      ghost: null,
    };
  });

  shortcutsEl.addEventListener('pointermove', (e) => {
    const state = shortcutPointerDrag;
    if (!state || state.pointerId !== e.pointerId) return;
    const distance = Math.hypot(e.clientX - state.startX, e.clientY - state.startY);
    if (!state.started && distance < 6) return;
    if (!state.started) beginShortcutPointerDrag(state, e, shortcutsEl);
    e.preventDefault();
    updateShortcutPointerDrag(state, e, shortcutsEl);
  });

  shortcutsEl.addEventListener('pointerup', async (e) => {
    const state = shortcutPointerDrag;
    if (!state || state.pointerId !== e.pointerId) return;
    if (state.shortcut.hasPointerCapture(e.pointerId)) state.shortcut.releasePointerCapture(e.pointerId);
    if (state.started) e.preventDefault();
    await finishShortcutPointerDrag(state, shortcutsEl);
  });

  shortcutsEl.addEventListener('pointercancel', async (e) => {
    const state = shortcutPointerDrag;
    if (!state || state.pointerId !== e.pointerId) return;
    await finishShortcutPointerDrag(state, shortcutsEl, true);
  });

  shortcutsEl.addEventListener('click', (e) => {
    const overflowToggle = e.target.closest('[data-shortcut-overflow]');
    if (overflowToggle) {
      shortcutsExpanded = !shortcutsExpanded;
      renderAppShortcuts();
      return;
    }

    const optionsButton = e.target.closest('[data-shortcut-options]');
    if (optionsButton) {
      e.preventDefault();
      e.stopPropagation();
      const rect = optionsButton.getBoundingClientRect();
      showShortcutContextMenu(rect.right, rect.bottom + 4, optionsButton.dataset.shortcutOptions);
      return;
    }

    if (dragMoved) {
      const shortcut = e.target.closest('.app-shortcut[data-shortcut-id]');
      if (!shortcut) return;
      e.preventDefault();
      e.stopPropagation();
      dragMoved = false;
    }
  });

  shortcutsEl.addEventListener('keydown', async (e) => {
    const link = e.target.closest('[data-shortcut-link]');
    if (!link || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    await moveShortcutByKeyboard(link.dataset.shortcutLink, e.key, shortcutsEl);
  });

  window.addEventListener('resize', () => {
    if (shortcutResizeTimeout) clearTimeout(shortcutResizeTimeout);
    shortcutResizeTimeout = setTimeout(() => {
      shortcutResizeTimeout = null;
      if (!shortcutPointerDrag) renderAppShortcuts();
    }, 120);
  });

  quickAccessBound = true;
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = escapeHtmlAttr(tab.url || '');
    const safeTitle = escapeHtmlAttr(label);
    const safeTabId = escapeHtmlAttr(tab.id);
    const faviconUrl = localFaviconUrl(tab.url, 16);
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-id="${safeTabId}" data-tab-url="${safeUrl}" title="${safeTitle}" role="link" tabindex="0">
      ${faviconUrl ? `<img class="chip-favicon" src="${escapeHtmlAttr(faviconUrl)}" alt="">` : ''}
      <span class="chip-text">${escapeHtmlText(label)}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-id="${safeTabId}" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later" aria-label="Save this tab for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-id="${safeTabId}" data-tab-url="${safeUrl}" title="Close this tab" aria-label="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips" role="button" tabindex="0">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const { closeableTabs, protectedTabs } = partitionTabsForBulkClose(tabs);
  const closeableCount = closeableTabs.length;
  const protectedCount = protectedTabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = escapeHtmlAttr(tab.url || '');
    const safeTitle = escapeHtmlAttr(label);
    const safeTabId = escapeHtmlAttr(tab.id);
    const faviconUrl = localFaviconUrl(tab.url, 16);
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-id="${safeTabId}" data-tab-url="${safeUrl}" title="${safeTitle}" role="link" tabindex="0">
      ${faviconUrl ? `<img class="chip-favicon" src="${escapeHtmlAttr(faviconUrl)}" alt="">` : ''}
      <span class="chip-text">${escapeHtmlText(label)}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-id="${safeTabId}" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later" aria-label="Save this tab for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-id="${safeTabId}" data-tab-url="${safeUrl}" title="Close this tab" aria-label="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}"${closeableCount === 0 ? ' disabled' : ''} title="Pinned, playing, active, and captured tabs stay open">
      ${ICONS.close}
      ${bulkCloseButtonLabel(closeableCount, protectedCount)}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${escapeHtmlText(isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain)))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = localFaviconUrl(item.url, 16);
  const ago = timeAgo(item.savedAt);
  const safeId = escapeHtmlAttr(item.id);
  const safeUrl = escapeHtmlAttr(isSupportedShortcutUrl(item.url) ? item.url : '#');
  const safeTitle = escapeHtmlAttr(item.title || item.url || '');
  const titleText = escapeHtmlText(item.title || item.url || '');

  return `
    <div class="deferred-item" data-deferred-id="${safeId}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${safeId}" aria-label="Mark saved tab complete">
      <div class="deferred-info">
        <a href="${safeUrl}" target="_blank" rel="noopener" class="deferred-title" title="${safeTitle}">
          ${faviconUrl ? `<img class="deferred-favicon" src="${escapeHtmlAttr(faviconUrl)}" alt="">` : ''}${titleText}
        </a>
        <div class="deferred-meta">
          <span>${escapeHtmlText(domain)}</span>
          <span>${escapeHtmlText(ago)}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${safeId}" title="Dismiss" aria-label="Dismiss saved tab">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  const safeId = escapeHtmlAttr(item.id);
  const safeUrl = escapeHtmlAttr(isSupportedShortcutUrl(item.url) ? item.url : '#');
  const safeTitle = escapeHtmlAttr(item.title || item.url || '');
  return `
    <div class="archive-item" data-deferred-id="${safeId}">
      <a href="${safeUrl}" target="_blank" rel="noopener" class="archive-item-title" title="${safeTitle}">
        ${escapeHtmlText(item.title || item.url || '')}
      </a>
      <span class="archive-item-date">${escapeHtmlText(ago)}</span>
      <button
        class="deferred-dismiss archive-clear-btn"
        data-action="clear-archived"
        data-deferred-id="${safeId}"
        title="Clear archived tab"
        aria-label="Clear archived tab"
        style="opacity:0;padding:0;margin-left:2px"
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();
  await setupQuickAccess();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Keep Homepages first; order the remaining domain cards by most recent tab use.
  const mostRecentUse = group => Math.max(0, ...group.tabs.map(tab => tab.lastAccessed || 0));
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;
    return (mostRecentUse(b) - mostRecentUse(a))
      || (b.tabs.length - a.tabs.length)
      || a.domain.localeCompare(b.domain);
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    const { closeableTabs, protectedTabs } = partitionTabsForBulkClose(realTabs);
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;"${closeableTabs.length === 0 ? ' disabled' : ''} title="Pinned, playing, active, and captured tabs stay open">${ICONS.close} ${bulkCloseButtonLabel(closeableTabs.length, protectedTabs.length)}</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSection.style.display = 'block';
    renderEmptyState();
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = realTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}

function waitForUi(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function refreshDashboardQuietly() {
  if (tabRefreshTimeout) {
    clearTimeout(tabRefreshTimeout);
    tabRefreshTimeout = null;
  }
  await renderStaticDashboard();
}

function scheduleTabRefresh() {
  if (tabRefreshTimeout) clearTimeout(tabRefreshTimeout);
  tabRefreshTimeout = setTimeout(() => {
    tabRefreshTimeout = null;
    refreshDashboardQuietly();
  }, 250);
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  if (action === 'edit-shortcut') {
    if (contextShortcutId) openShortcutModal('edit', contextShortcutId);
    hideShortcutContextMenu();
    return;
  }

  if (action === 'remove-shortcut') {
    if (contextShortcutId) await removeShortcutWithUndo(contextShortcutId);
    hideShortcutContextMenu();
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    const tabId = Number(actionEl.dataset.tabId);
    if (tabUrl) await focusTab(tabUrl, Number.isInteger(tabId) ? tabId : null);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabId = Number(actionEl.dataset.tabId);
    if (!Number.isInteger(tabId)) return;

    await closeTabsByIds([tabId]);

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Tab closed');
    await waitForUi(220);
    await refreshDashboardQuietly();
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    const tabId    = Number(actionEl.dataset.tabId);
    if (!tabUrl || !Number.isInteger(tabId)) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    await closeTabsByIds([tabId]);

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await waitForUi(220);
    await refreshDashboardQuietly();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Clear one archived tab item ----
  if (action === 'clear-archived') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;
    e.stopPropagation();
    await clearArchivedTab(id);
    await renderDeferredColumn();
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const { closeableTabs, protectedTabs } = partitionTabsForBulkClose(group.tabs);
    if (closeableTabs.length === 0) return;
    const tabIds = closeableTabs.map(t => t.id);
    await closeTabsByIds(tabIds);

    if (card) {
      playCloseSound();
      if (protectedTabs.length === 0) {
        animateCardOut(card);
      } else {
        const rect = card.getBoundingClientRect();
        shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
    }

    if (protectedTabs.length === 0) {
      const idx = domainGroups.indexOf(group);
      if (idx !== -1) domainGroups.splice(idx, 1);
    }

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    const protectedNote = protectedTabs.length > 0 ? ` · ${protectedTabs.length} protected` : '';
    showToast(`Closed ${tabIds.length} tab${tabIds.length !== 1 ? 's' : ''} from ${groupLabel}${protectedNote}`, {
      durationMs: 7000,
      onUndo: () => restoreClosedTabs(closeableTabs),
    });
    await waitForUi(320);
    await refreshDashboardQuietly();
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    await waitForUi(220);
    await refreshDashboardQuietly();
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const { closeableTabs, protectedTabs } = partitionTabsForBulkClose(getRealTabs());
    if (closeableTabs.length === 0) return;
    const tabIds = closeableTabs.map(t => t.id);
    await closeTabsByIds(tabIds);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      const domainId = c.dataset.domainId;
      const group = domainGroups.find(g =>
        'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId
      );
      if (!group) return;
      const groupPartition = partitionTabsForBulkClose(group.tabs);
      if (groupPartition.closeableTabs.length === 0) return;
      if (groupPartition.protectedTabs.length === 0) {
        animateCardOut(c);
      } else {
        const rect = c.getBoundingClientRect();
        shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
    });

    const protectedNote = protectedTabs.length > 0 ? ` · ${protectedTabs.length} protected` : '';
    showToast(`Closed ${tabIds.length} tab${tabIds.length !== 1 ? 's' : ''}${protectedNote}`, {
      durationMs: 7000,
      onUndo: () => restoreClosedTabs(closeableTabs),
    });
    await waitForUi(320);
    await refreshDashboardQuietly();
    return;
  }
});

document.addEventListener('keydown', async (e) => {
  const modal = document.getElementById('shortcutModal');
  const modalOpen = modal && modal.style.display !== 'none';

  if (e.key === 'Escape') {
    if (shortcutPointerDrag) {
      e.preventDefault();
      const shortcutsEl = document.getElementById('appShortcuts');
      if (shortcutsEl) await finishShortcutPointerDrag(shortcutPointerDrag, shortcutsEl, true);
      return;
    }
    if (modalOpen) {
      e.preventDefault();
      closeShortcutModal();
      return;
    }
    const menu = document.getElementById('shortcutContextMenu');
    if (menu && menu.style.display !== 'none') {
      e.preventDefault();
      const shortcutId = contextShortcutId;
      hideShortcutContextMenu();
      if (shortcutId) {
        document.querySelector(`[data-shortcut-options="${CSS.escape(shortcutId)}"]`)?.focus();
      }
      return;
    }
  }

  if (modalOpen && e.key === 'Tab') {
    const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]')]
      .filter(el => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
    return;
  }

  const menu = document.getElementById('shortcutContextMenu');
  if (menu && menu.style.display !== 'none' && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const currentIndex = items.indexOf(document.activeElement);
    const offset = e.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = (currentIndex + offset + items.length) % items.length;
    e.preventDefault();
    items[nextIndex]?.focus();
    return;
  }

  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-action][role="link"], [data-action][role="button"]')) {
    e.preventDefault();
    e.target.click();
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});

// ---- Archive item hover affordance — show clear (x) on hover ----
document.addEventListener('mouseover', (e) => {
  const item = e.target.closest('.archive-item');
  if (!item) return;
  const clearBtn = item.querySelector('.archive-clear-btn');
  if (clearBtn) clearBtn.style.opacity = '0.35';
});

document.addEventListener('mouseout', (e) => {
  const item = e.target.closest('.archive-item');
  if (!item) return;
  const next = e.relatedTarget;
  if (next && item.contains(next)) return;
  const clearBtn = item.querySelector('.archive-clear-btn');
  if (clearBtn) clearBtn.style.opacity = '0';
});

// Hide missing favicons without inline handlers, which Manifest V3 blocks.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.classList.contains('app-shortcut-favicon')) {
    const wrap = img.closest('.app-shortcut-icon');
    if (wrap) wrap.classList.add('is-favicon-error');
    return;
  }
  if (img.matches('.chip-favicon, .deferred-favicon')) img.style.display = 'none';
}, true);

chrome.tabs.onCreated.addListener(scheduleTabRefresh);
chrome.tabs.onRemoved.addListener(scheduleTabRefresh);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (
    changeInfo.url ||
    changeInfo.title ||
    changeInfo.status === 'complete' ||
    Object.hasOwn(changeInfo, 'pinned') ||
    Object.hasOwn(changeInfo, 'audible') ||
    Object.hasOwn(changeInfo, 'mutedInfo')
  ) scheduleTabRefresh();
});
chrome.tabs.onActivated.addListener(scheduleTabRefresh);


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
