/** Actual KB module: full-panel focus ownership and free-chat context boundaries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const moduleSource = name => readFileSync(new URL(`../web/js/mobile/${name}`, import.meta.url), 'utf8')
  .replace(/^import\s+[\s\S]*?\s+from\s+(['"])[^'"]+\1\s*;?\s*$/gm, '')
  .replace(/^export\s*\{[^}]*\}\s*;?/gm, '').replace(/^export\s+/gm, '');

class Node {
  constructor(doc, tag = 'div', attrs = {}) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.hidden = false;
    this.inert = false;
    this.disabled = false;
    this.rendered = true;
    this.tabIndex = ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) ? 0 : -1;
    this.classNames = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this.classNames.add(name)),
      remove: (...names) => names.forEach(name => this.classNames.delete(name)),
      contains: name => this.classNames.has(name),
      toggle: (name, force) => {
        const add = force === undefined ? !this.classNames.has(name) : force;
        if (add) this.classNames.add(name); else this.classNames.delete(name);
        return add;
      },
    };
    for (const [name, value] of Object.entries(attrs)) this.setAttribute(name, value);
  }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentElement?.isConnected; }
  setAttribute(name, value = '') {
    this.attrs[name] = String(value);
    if (['hidden', 'inert', 'disabled'].includes(name)) this[name] = true;
    if (name === 'tabindex') this.tabIndex = Number(value);
    if (name === 'href' && this.tagName === 'A') this.tabIndex = 0;
    if (name === 'class') this.classNames = new Set(String(value).split(/\s+/));
    if (name.startsWith('data-')) this.dataset[name.slice(5)] = String(value);
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  append(child) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  contains(other) {
    for (let node = other; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const s = part.trim();
      if (s === '[hidden]') return this.hidden;
      if (s === '[inert]') return this.inert;
      if (s === '[aria-hidden="true"]') return this.attrs['aria-hidden'] === 'true';
      if (s.startsWith('#')) return this.attrs.id === s.slice(1);
      if (s.startsWith('.')) return this.classNames.has(s.slice(1));
      if (s.includes(':not([disabled])') && this.disabled) return false;
      if (s.includes(':not([tabindex="-1"])') && this.tabIndex === -1) return false;
      if (s.includes(':not([type="hidden"])') && this.attrs.type === 'hidden') return false;
      const tag = s.match(/^[a-z]+/i)?.[0]?.toUpperCase();
      if (tag && tag !== this.tagName) return false;
      const attr = s.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]/);
      if (attr) return attr[2] === undefined ? attr[1] in this.attrs : this.attrs[attr[1]] === attr[2];
      if (s.includes('[href]') && !('href' in this.attrs)) return false;
      if (s.includes('[type=checkbox]') && this.attrs.type !== 'checkbox') return false;
      return !!tag;
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) {
    const descendant = selector.match(/^(#[\w-]+)\s+(.+)$/);
    if (descendant) return this.querySelector(descendant[1])?.querySelector(descendant[2]) || null;
    return this.querySelectorAll(selector)[0] || null;
  }
  getClientRects() {
    if (!this.isConnected) return [];
    for (let node = this; node; node = node.parentElement) if (node.hidden || !node.rendered) return [];
    return [{}];
  }
  focus() {
    if (!this.isConnected || this.disabled || this.closest('[hidden], [inert]') || !this.getClientRects().length) return;
    this.ownerDocument.activeElement = this;
    this.ownerDocument.dispatch('focusin', { target: this });
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  dispatch(name, properties = {}) {
    const event = { target: this, key: '', shiftKey: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...properties };
    for (const listener of this.listeners.get(name) || []) listener(event);
    return event;
  }
  set innerHTML(value) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.html = String(value);
    const stack = [this];
    for (const tag of this.html.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
      if (tag[1]) { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      for (const attr of tag[3].matchAll(/([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) attrs[attr[1]] = attr[2] ?? attr[3] ?? attr[4] ?? '';
      const child = stack.at(-1).append(new Node(this.ownerDocument, tag[2], attrs));
      if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag[2].toLowerCase())) stack.push(child);
    }
  }
  get innerHTML() { return this.html || ''; }
}

function harness() {
  const document = {
    activeElement: null, listeners: new Map(),
    addEventListener: Node.prototype.addEventListener,
    dispatch: Node.prototype.dispatch,
    querySelector(selector) { return this.body.querySelector(selector); },
    getElementById(id) { return this.querySelector('#' + id); },
  };
  document.body = new Node(document, 'body');
  const make = (tag, attrs, parent = document.body) => parent.append(new Node(document, tag, attrs));
  const screens = make('main', { id: 'screens' });
  const trigger = make('button', { id: 'open-kb' }, screens);
  const tabbar = make('nav', { id: 'tabbar' });
  const tab = make('button', { id: 'selected-tab', 'aria-selected': 'true' }, tabbar);
  const host = make('section', { id: 'kb-screen', hidden: '' });
  const calls = [];
  const sheets = [];
  const ui = { closeSheet: token => sheets.push(token), openCall: (...args) => calls.push(args) };
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    console, document, AbortController, apiFetch: async () => ({ ok: true, json: async () => ({ ok: true, maxFileBytes: 100 * 1024 * 1024, maxTextChars: 60000 }) }), Element: Node, M: { activeCharId: 'maya' }, ui,
    $: (selector, root = document) => root.querySelector(selector), esc: String, icon: () => '', toast() {}, sleep: async () => {},
    characterById: id => ({ id }), kbList: async () => ({ ok: true, docs: [] }),
    kbUpload: async () => ({}), kbImportUrl: async () => ({}), kbGet: async () => ({}), kbDelete: async () => ({}), postJSON: async () => ({}),
    libraryBlockHtml: () => '', refreshLibraryCard() {}, openLibrarySheet() {}, startTodayLesson() {}, completeToday() {},
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); }, queueMicrotask,
  });
  vm.runInContext(`${moduleSource('kb.js')}\nthis.subject = { KB, openKbPanel, closeKbPanel, startDiscussion };`, context, { filename: 'web/js/mobile/kb.js' });
  vm.runInContext(`${moduleSource('dialog.js')}\nthis.createDialog = createDialogController;`, context, { filename: 'web/js/mobile/dialog.js' });
  const h = { ...context.subject, document, screens, trigger, tabbar, tab, host, calls, sheets, ui, make, context,
    byId: id => document.getElementById(id),
    tabEvent(properties = {}) {
      const event = host.dispatch('keydown', { key: 'Tab', ...properties });
      document.dispatch('keydown', event);
      return event;
    },
  };
  ui.closeKbPanel = h.closeKbPanel;
  trigger.focus();
  return h;
}

test('opening the rendered knowledge panel isolates the background and focuses its return control', () => {
  const h = harness();
  h.openKbPanel();
  assert.equal(h.KB.open, true);
  assert.equal(h.screens.inert, true);
  assert.equal(h.tabbar.inert, true);
  assert.equal(h.document.activeElement, h.byId('kb-close'));
  assert.equal(h.host.hidden, false);
  assert.equal(h.host.getAttribute('aria-modal'), 'true');
});

test('repeated opening preserves the original focus/inert snapshot and does not duplicate keyboard listeners', () => {
  const h = harness();
  h.tabbar.inert = true;
  h.openKbPanel();
  const listeners = (h.host.listeners.get('keydown') || []).length + (h.document.listeners.get('keydown') || []).length;
  assert.equal(listeners, 1);
  const input = h.byId('kb-url-input');
  input.focus();
  h.openKbPanel();
  assert.equal(h.document.activeElement, input);
  assert.equal((h.host.listeners.get('keydown') || []).length + (h.document.listeners.get('keydown') || []).length, 1);
  h.closeKbPanel();
  assert.equal(h.screens.inert, false);
  assert.equal(h.tabbar.inert, true);
  assert.equal(h.document.activeElement, h.trigger);
  h.closeKbPanel();
  assert.equal(h.tabbar.inert, true);
});

test('Tab wraps only visible enabled nonnegative-tabindex controls within the panel', () => {
  const h = harness();
  h.openKbPanel();
  h.make('button', { tabindex: '-1' }, h.host);
  h.make('button', { disabled: '' }, h.host);
  h.make('button', { hidden: '' }, h.host);
  const first = h.byId('kb-refresh');
  const last = h.byId('kb-free');
  last.focus();
  assert.equal(h.tabEvent().defaultPrevented, true);
  assert.equal(h.document.activeElement, first);
  assert.equal(h.tabEvent({ shiftKey: true }).defaultPrevented, true);
  assert.equal(h.document.activeElement, last);
  h.byId('kb-url-input').focus();
  assert.equal(h.tabEvent().defaultPrevented, false);
});

test('knowledge Tab handling respects defaultPrevented, nested sheets and the closed panel', () => {
  const h = harness();
  h.openKbPanel();
  const last = h.byId('kb-free');
  last.focus();
  h.tabEvent({ defaultPrevented: true });
  assert.equal(h.document.activeElement, last);
  h.document.body.classList.add('sheet-open');
  assert.equal(h.tabEvent().defaultPrevented, false);
  assert.equal(h.document.activeElement, last);
  h.closeKbPanel();
  assert.equal(h.sheets.length, 0, 'closing KB must not close an unrelated active sheet');
  h.document.body.classList.remove('sheet-open');
  assert.equal(h.tabEvent().defaultPrevented, false);
});

test('closing returns to the visible entry or the active tab when that entry is no longer usable', () => {
  for (const unavailable of ['none', 'removed', 'hidden', 'not-rendered']) {
    const h = harness();
    h.openKbPanel();
    if (unavailable === 'removed') h.trigger.remove();
    if (unavailable === 'hidden') h.trigger.hidden = true;
    if (unavailable === 'not-rendered') h.trigger.rendered = false;
    h.closeKbPanel();
    assert.equal(h.document.activeElement, unavailable === 'none' ? h.trigger : h.tab);
    assert.equal(h.screens.inert, false);
    assert.equal(h.tabbar.inert, false);
  }
});

test('the existing dialog controller owns a nested sheet and restores KB before KB releases its own background', () => {
  const h = harness();
  h.openKbPanel();
  const sheet = h.make('div', { hidden: '' });
  const title = h.make('span', { id: 'nested-title' }, sheet);
  const body = h.make('div', {}, sheet);
  const backdrop = h.make('div', { hidden: '' });
  const controller = h.context.createDialog({ dialog: sheet, backdrop, title, body,
    getBackground: () => [h.screens, h.tabbar, h.host], getFallbackFocus: () => h.tab,
  });
  h.document.body.classList.add('sheet-open');
  const token = controller.open('Paste', '<input id="nested-input" autofocus>');
  const nestedInput = sheet.querySelector('#nested-input');
  assert.equal(h.host.inert, true);
  h.openKbPanel();
  h.tabEvent();
  assert.equal(h.document.activeElement, nestedInput);
  h.document.body.classList.remove('sheet-open');
  controller.close(token);
  assert.equal(h.host.inert, false);
  assert.equal(h.screens.inert, true);
  assert.equal(h.document.activeElement, h.byId('kb-close'));
  h.closeKbPanel();
  assert.equal(h.screens.inert, false);
  assert.equal(h.tabbar.inert, false);
  assert.equal(h.document.activeElement, h.trigger);
});

test('free chat omits selected materials while grounded and divergent discussions retain them', () => {
  const h = harness();
  h.KB.docs = [{ id: 'selected-document', title: 'Personal lesson' }];
  h.KB.selected.add('selected-document');
  h.ui.closeKbPanel = () => {};
  for (const mode of ['free', 'grounded', 'divergent']) h.startDiscussion(mode);
  assert.equal(h.calls.length, 3);
  const [free, grounded, divergent] = h.calls.map(call => call[2]);
  assert.equal(free.kbMode, 'free');
  assert.equal(free.kbDocIds, undefined);
  assert.equal(free.kbDocs, undefined);
  for (const options of [grounded, divergent]) {
    assert.deepEqual(Array.from(options.kbDocIds), ['selected-document']);
    assert.deepEqual(Array.from(options.kbDocs), ['Personal lesson']);
  }
  assert.equal(h.KB.selected.has('selected-document'), true, 'starting free chat should not erase the user selection');
});
