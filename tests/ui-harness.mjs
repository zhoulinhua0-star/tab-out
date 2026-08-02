import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const websocketUrl = process.argv[2];
if (!websocketUrl) throw new Error('Pass a Chrome page WebSocket URL.');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPageUrl = pathToFileURL(path.join(projectRoot, 'extension', 'index.html')).href;

const socket = new WebSocket(websocketUrl);
const pending = new Map();
let messageId = 0;

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function command(method, params = {}) {
  const id = ++messageId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression, awaitPromise = true) {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

const mockBrowserApis = String.raw`
(() => {
  const listeners = () => {
    const callbacks = [];
    return {
      addListener(callback) { callbacks.push(callback); },
      emit(...args) { callbacks.forEach(callback => callback(...args)); },
    };
  };

  const shortcutNames = Array.from({ length: 20 }, (_, index) => ({
    id: 'shortcut-' + index,
    name: index === 3 ? '<img id="shortcut-xss">' : 'Shortcut ' + (index + 1),
    url: 'https://example' + index + '.com/path',
    icon: 'S' + (index % 10),
  }));
  const tabs = [
    { id: 1, url: 'https://github.com/', title: 'GitHub', windowId: 1, index: 0, active: false, lastAccessed: 400 },
    { id: 2, url: 'https://github.com/openai/project', title: 'Project · GitHub', windowId: 1, index: 1, active: false, pinned: true, lastAccessed: 500 },
    { id: 3, url: 'https://github.com/openai/project', title: 'Project · GitHub', windowId: 2, index: 0, active: false, lastAccessed: 600 },
    { id: 4, url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox (42)', windowId: 1, index: 2, active: false, audible: true, lastAccessed: 300 },
    { id: 5, url: 'https://news.ycombinator.com/item?id=1', title: 'A useful article', windowId: 1, index: 3, active: true, lastAccessed: 800 },
    { id: 6, url: 'chrome-extension://tabouttestid/index.html', title: 'Tab Out', windowId: 2, index: 1, active: true, lastAccessed: 1000 },
    { id: 7, url: 'https://meet.example.com/room', title: 'Captured meeting', windowId: 1, index: 4, active: false, lastAccessed: 900, mutedInfo: { muted: true, reason: 'capture' } },
  ];
  let nextTabId = 100;
  const storage = {
    appShortcuts: shortcutNames,
    deferred: [{
      id: 'saved-1',
      url: 'https://example.com/read-later',
      title: 'Read this later',
      savedAt: new Date().toISOString(),
      completed: false,
      dismissed: false,
    }],
  };
  const onCreated = listeners();
  const onRemoved = listeners();
  const onUpdated = listeners();
  const onActivated = listeners();

  window.__tabOutTest = { removed: [], created: [], updated: [], storage, errors: [] };
  window.addEventListener('error', event => {
    if (event instanceof ErrorEvent) window.__tabOutTest.errors.push(event.message);
  });
  window.addEventListener('unhandledrejection', event => {
    window.__tabOutTest.errors.push(String(event.reason));
  });

  globalThis.chrome = {
    runtime: {
      id: 'tabouttestid',
      getURL(path) { return 'file:///tmp/tab-out-mock-favicon' + path; },
    },
    tabs: {
      async query() { return tabs.map(tab => ({ ...tab })); },
      async remove(ids) {
        const list = Array.isArray(ids) ? ids : [ids];
        window.__tabOutTest.removed.push([...list]);
        for (const id of list) {
          const index = tabs.findIndex(tab => tab.id === id);
          if (index !== -1) tabs.splice(index, 1);
          onRemoved.emit(id, { windowId: 1, isWindowClosing: false });
        }
      },
      async create(properties) {
        const tab = {
          id: nextTabId++,
          url: properties.url,
          title: properties.url,
          windowId: properties.windowId ?? 1,
          index: properties.index ?? tabs.length,
          lastAccessed: 0,
          active: properties.active ?? true,
          pinned: Boolean(properties.pinned),
        };
        tabs.push(tab);
        window.__tabOutTest.created.push({ ...properties, id: tab.id });
        onCreated.emit({ ...tab });
        return { ...tab };
      },
      async update(idOrProperties, properties) {
        const id = typeof idOrProperties === 'number' ? idOrProperties : tabs[0]?.id;
        const updates = properties || idOrProperties;
        const tab = tabs.find(item => item.id === id);
        if (tab) Object.assign(tab, updates);
        window.__tabOutTest.updated.push({ id, updates: { ...updates } });
        return tab;
      },
      onCreated,
      onRemoved,
      onUpdated,
      onActivated,
    },
    windows: {
      async getCurrent() { return { id: 1 }; },
      async update() {},
    },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === 'string') return { [keys]: storage[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, storage[key]]));
          return { ...storage };
        },
        async set(values) { Object.assign(storage, structuredClone(values)); },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
        },
      },
    },
  };
})();
`;

await command('Page.enable');
await command('Runtime.enable');
await command('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await command('Page.addScriptToEvaluateOnNewDocument', { source: mockBrowserApis });
await command('Page.navigate', {
  url: extensionPageUrl,
});
await waitFor(`document.querySelectorAll('.app-shortcut[data-shortcut-id]').length === 15`);

const wideLayout = await evaluate(`(() => {
  const shortcuts = [...document.querySelectorAll('.app-shortcut[data-shortcut-id]')];
  return {
    visible: shortcuts.length,
    rows: new Set(shortcuts.map(item => Math.round(item.getBoundingClientRect().top))).size,
    hiddenCount: document.querySelector('.shortcut-overflow-icon')?.textContent,
    overflow: document.documentElement.scrollWidth > innerWidth,
    options: document.querySelectorAll('[data-shortcut-options]').length,
    cards: document.querySelectorAll('.mission-card').length,
    cardOrder: [...document.querySelectorAll('.mission-name')].map(item => item.textContent),
    xssElement: Boolean(document.getElementById('shortcut-xss')),
    xssText: document.body.textContent.includes('<img id="shortcut-xss">'),
    themeControl: Boolean(document.getElementById('tabThemeSelect')),
    paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent-amber').trim(),
    loadFadeAnimations: document.getAnimations().filter(animation => animation.animationName === 'fadeUp').length,
    fullFrameAnimations: document.getAnimations().filter(animation => animation.effect?.target?.matches?.('body, .container')).length,
  };
})()`);
assert.deepEqual(wideLayout, {
  visible: 15,
  rows: 2,
  hiddenCount: '+5',
  overflow: false,
  options: 15,
  cards: 4,
  cardOrder: ['Homepages', 'Meet Example', 'Hacker News', 'GitHub'],
  xssElement: false,
  xssText: true,
  themeControl: false,
  paper: '#f8f5f0',
  accent: '#c8713a',
  loadFadeAnimations: 0,
  fullFrameAnimations: 0,
});

await evaluate(`document.querySelector('[data-shortcut-overflow]').click()`);
await waitFor(`document.querySelectorAll('.app-shortcut[data-shortcut-id]').length === 20`);

const expandedLayout = await evaluate(`(() => ({
  visible: document.querySelectorAll('.app-shortcut[data-shortcut-id]').length,
  label: document.querySelector('[data-shortcut-overflow] .app-shortcut-label').textContent,
}))()`);
assert.deepEqual(expandedLayout, { visible: 20, label: 'Show less' });

await evaluate(`document.getElementById('addShortcutBtn').click()`);
await waitFor(`document.getElementById('shortcutModal').style.display === 'flex'`);
assert.equal(await evaluate(`document.activeElement.id`), 'shortcutNameInput');
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
assert.equal(await evaluate(`document.getElementById('shortcutModal').style.display`), 'none');
assert.equal(await evaluate(`document.activeElement.id`), 'addShortcutBtn');

const dragPoints = await evaluate(`(() => {
  const from = document.querySelector('[data-shortcut-id="shortcut-0"]').getBoundingClientRect();
  const to = document.querySelector('[data-shortcut-id="shortcut-4"]').getBoundingClientRect();
  return {
    fromX: from.left + from.width / 2,
    fromY: from.top + from.height / 2,
    toX: to.left + to.width / 2,
    toY: to.top + to.height / 2,
  };
})()`);
await command('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: dragPoints.fromX,
  y: dragPoints.fromY,
  button: 'left',
  buttons: 1,
  clickCount: 1,
});
await command('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: dragPoints.fromX + 12,
  y: dragPoints.fromY,
  button: 'none',
  buttons: 1,
});
await command('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: dragPoints.toX,
  y: dragPoints.toY,
  button: 'none',
  buttons: 1,
});
await command('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: dragPoints.toX,
  y: dragPoints.toY,
  button: 'left',
  buttons: 0,
  clickCount: 1,
});
await waitFor(`window.__tabOutTest.storage.appShortcuts.findIndex(item => item.id === 'shortcut-0') > 0`);
const pointerMovedIndex = await evaluate(`window.__tabOutTest.storage.appShortcuts.findIndex(item => item.id === 'shortcut-0')`);
assert.equal(await evaluate(`Boolean(document.querySelector('.shortcut-drag-ghost'))`), false);

await evaluate(`(() => {
  const link = document.querySelector('[data-shortcut-link="shortcut-0"]');
  link.focus();
  link.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
})()`);
await waitFor(`window.__tabOutTest.storage.appShortcuts.findIndex(item => item.id === 'shortcut-0') === ${pointerMovedIndex + 1}`);
await waitFor(`document.activeElement?.dataset?.shortcutLink === 'shortcut-0'`);

await evaluate(`(() => {
  window.__undoWorked = false;
  showToast('Removed', { onUndo: () => { window.__undoWorked = true; }, durationMs: 5000 });
  document.getElementById('toastUndoBtn').click();
})()`);
assert.equal(await evaluate(`window.__undoWorked`), true);

await evaluate(`(() => {
  const githubCard = [...document.querySelectorAll('.mission-card')]
    .find(card => card.querySelector('.mission-name')?.textContent === 'GitHub');
  window.__githubCloseLabel = githubCard.querySelector('[data-action="close-domain-tabs"]').textContent.replace(/\\s+/g, ' ').trim();
  githubCard.querySelector('[data-action="close-domain-tabs"]').click();
})()`);
assert.equal(await evaluate(`window.__githubCloseLabel`), 'Close 1 tab · 1 protected');
await waitFor(`window.__tabOutTest.removed.length > 0`);
const domainRemoved = await evaluate(`window.__tabOutTest.removed[0]`);
assert.deepEqual(domainRemoved, [3]);
await waitFor(`document.getElementById('toastUndoBtn').style.display !== 'none'`);
await evaluate(`document.getElementById('toastUndoBtn').click()`);
await waitFor(`window.__tabOutTest.created.length === 1`);
assert.equal(await evaluate(`window.__tabOutTest.created[0].url`), 'https://github.com/openai/project');
assert.equal(await evaluate(`window.__tabOutTest.created[0].windowId`), 2);
assert.equal(await evaluate(`window.__tabOutTest.created[0].index`), 0);
await waitFor(`document.getElementById('toastText').textContent === 'Restored 1 tab'`);

await evaluate(`document.querySelector('[data-action="close-single-tab"][data-tab-id="1"]').click()`);
await waitFor(`window.__tabOutTest.removed.length > 1`);
const singleRemoved = await evaluate(`window.__tabOutTest.removed[1]`);
assert.deepEqual(singleRemoved, [1]);

await waitFor(`document.querySelector('[data-action="close-all-open-tabs"]').textContent.includes('Close 1 tab')`);
const closeAllLabel = await evaluate(`document.querySelector('[data-action="close-all-open-tabs"]').textContent.replace(/\\s+/g, ' ').trim()`);
assert.equal(closeAllLabel, 'Close 1 tab · 4 protected');
await evaluate(`document.querySelector('[data-action="close-all-open-tabs"]').click()`);
await waitFor(`window.__tabOutTest.removed.length > 2`);
const bulkRemoved = await evaluate(`window.__tabOutTest.removed[2]`);
assert.deepEqual(bulkRemoved, [100]);
await waitFor(`document.getElementById('toastUndoBtn').style.display !== 'none'`);
await evaluate(`document.getElementById('toastUndoBtn').click()`);
await waitFor(`window.__tabOutTest.created.length === 2`);

const protectedReasons = await evaluate(`(() => ({
  pinned: getProtectedTabReasons(openTabs.find(tab => tab.id === 2)),
  audible: getProtectedTabReasons(openTabs.find(tab => tab.id === 4)),
  active: getProtectedTabReasons(openTabs.find(tab => tab.id === 5)),
  captured: getProtectedTabReasons(openTabs.find(tab => tab.id === 7)),
}))()`);
assert.deepEqual(protectedReasons, {
  pinned: ['pinned'],
  audible: ['playing audio'],
  active: ['active'],
  captured: ['being captured'],
});

await evaluate(`(() => {
  const input = document.getElementById('quickSearchInput');
  input.focus();
  input.value = 'captured';
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await waitFor(`document.getElementById('openTabSearchResults').hidden === false`);
const openTabSearch = await evaluate(`(() => ({
  expanded: document.getElementById('quickSearchInput').getAttribute('aria-expanded'),
  resultTitles: [...document.querySelectorAll('#openTabSearchResults .open-tab-search-title')].map(item => item.textContent),
  matchingTabs: document.querySelectorAll('#openTabSearchResults [data-search-tab-id]').length,
}))()`);
assert.deepEqual(openTabSearch, {
  expanded: 'true',
  resultTitles: ['Captured meeting', 'Search Google for “captured”'],
  matchingTabs: 1,
});
await evaluate(`(() => {
  const input = document.getElementById('quickSearchInput');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
await waitFor(`window.__tabOutTest.updated.some(entry => entry.id === 7 && entry.updates.active === true)`);
assert.equal(await evaluate(`document.getElementById('openTabSearchResults').hidden`), true);

await command('Emulation.setDeviceMetricsOverride', {
  width: 375,
  height: 812,
  deviceScaleFactor: 1,
  mobile: true,
});
await evaluate(`window.dispatchEvent(new Event('resize'))`);
await new Promise(resolve => setTimeout(resolve, 250));
if (await evaluate(`document.querySelector('[data-shortcut-overflow]')?.getAttribute('aria-expanded') === 'true'`)) {
  await evaluate(`document.querySelector('[data-shortcut-overflow]').click()`);
}
const narrowLayout = await evaluate(`(() => ({
  overflow: document.documentElement.scrollWidth > innerWidth,
  activeWidth: document.querySelector('.active-section')?.getBoundingClientRect().width || 0,
  viewport: innerWidth,
  shortcutRows: new Set([...document.querySelectorAll('.app-shortcut[data-shortcut-id]')].map(item => Math.round(item.getBoundingClientRect().top))).size,
}))()`);
assert.equal(narrowLayout.overflow, false);
assert.ok(narrowLayout.activeWidth <= narrowLayout.viewport);
assert.ok(narrowLayout.shortcutRows <= 2);

const responsiveLayouts = {};
for (const [label, width, height] of [
  ['landscape', 812, 375],
  ['tablet', 980, 720],
  ['desktop', 1024, 768],
  ['wide', 1440, 900],
]) {
  await command('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 1024,
  });
  await evaluate(`window.dispatchEvent(new Event('resize'))`);
  await new Promise(resolve => setTimeout(resolve, 180));
  responsiveLayouts[label] = await evaluate(`(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    columnsDirection: getComputedStyle(document.querySelector('.dashboard-columns')).flexDirection,
  }))()`);
  assert.equal(responsiveLayouts[label].overflow, false, `${label} layout overflowed`);
}
assert.equal(responsiveLayouts.landscape.columnsDirection, 'column');
assert.equal(responsiveLayouts.tablet.columnsDirection, 'column');
assert.equal(responsiveLayouts.desktop.columnsDirection, 'row');

await command('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
});
assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
const confettiDelta = await evaluate(`(() => {
  const before = document.body.childElementCount;
  shootConfetti(100, 100);
  return document.body.childElementCount - before;
})()`);
assert.equal(confettiDelta, 0);

await command('Emulation.setEmulatedMedia', { features: [] });
await command('Page.reload', { ignoreCache: true });
await waitFor(`document.querySelectorAll('.app-shortcut[data-shortcut-id]').length === 15`);
const reloadRender = await evaluate(`(() => ({
  cards: document.querySelectorAll('.mission-card').length,
  headerOpacity: getComputedStyle(document.querySelector('header')).opacity,
  loadFadeAnimations: document.getAnimations().filter(animation => animation.animationName === 'fadeUp').length,
  fullFrameAnimations: document.getAnimations().filter(animation => animation.effect?.target?.matches?.('body, .container')).length,
}))()`);
assert.deepEqual(reloadRender, {
  cards: 4,
  headerOpacity: '1',
  loadFadeAnimations: 0,
  fullFrameAnimations: 0,
});

const runtimeErrors = await evaluate(`window.__tabOutTest.errors`);
assert.deepEqual(runtimeErrors, []);

console.log(JSON.stringify({ wideLayout, expandedLayout, pointerMovedIndex, narrowLayout, responsiveLayouts, domainRemoved, singleRemoved, bulkRemoved, protectedReasons, openTabSearch, reloadRender, runtimeErrors }, null, 2));
socket.close();
