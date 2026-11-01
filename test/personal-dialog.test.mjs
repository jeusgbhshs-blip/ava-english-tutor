/** Exercise the real dialog controller with a small connected DOM/focus model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/js/mobile/dialog.js', import.meta.url), 'utf8').replace(/^export\s+/gm, '');

class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.activeElement = null;
    this.root = new FakeElement(this, 'body');
  }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  emit(name, event) {
    for (const callback of this.listeners.get(name) || []) callback(event);
  }
}

class FakeElement {
  constructor(doc, tagName = 'div', attrs = {}) {
    this.ownerDocument = doc;
    this.tagName = tagName.toUpperCase();
    this.attrs = {};
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.hidden = false;
    this.inert = false;
    this.disabled = false;
    this.rendered = true;
    this.tabIndex = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName) ? 0 : -1;
    this.textContent = '';
    this.focusCount = 0;
    for (const [name, value] of Object.entries(attrs)) this.setAttribute(name, value);
  }
  get isConnected() { return this === this.ownerDocument.root || !!this.parentElement?.isConnected; }
  get id() { return this.attrs.id || ''; }
  setAttribute(name, value = '') {
    this.attrs[name] = String(value);
    if (name === 'hidden') this.hidden = true;
    if (name === 'inert') this.inert = true;
    if (name === 'disabled') this.disabled = true;
    if (name === 'tabindex') this.tabIndex = Number(value);
    if (name === 'href' && this.tagName === 'A') this.tabIndex = 0;
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  append(child) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  contains(other) {
    for (let current = other; current; current = current.parentElement) if (current === this) return true;
    return false;
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const item = part.trim();
      if (item === '[hidden]') return this.hidden;
      if (item === '[inert]') return this.inert;
      if (item === '[aria-hidden="true"]') return this.attrs['aria-hidden'] === 'true';
      if (item.startsWith('#')) return this.id === item.slice(1);
      if (item === '[autofocus]') return 'autofocus' in this.attrs;
      if (item === '[data-initial-focus]') return 'data-initial-focus' in this.attrs;
      if (item.startsWith('[tabindex]')) return 'tabindex' in this.attrs && (!item.includes(':not([tabindex="-1"])') || this.tabIndex !== -1);
      const tag = item.match(/^[a-z]+/i)?.[0]?.toUpperCase();
      if (!tag || tag !== this.tagName) return false;
      if (item.includes(':not([disabled])') && this.disabled) return false;
      if (item.includes('[href]') && !('href' in this.attrs)) return false;
      if (item.includes(':not([type="hidden"])') && this.attrs.type === 'hidden') return false;
      return true;
    });
  }
  closest(selector) {
    for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current;
    return null;
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = element => {
      for (const child of element.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() {
    if (!this.isConnected) return [];
    for (let current = this; current; current = current.parentElement) if (current.hidden || !current.rendered) return [];
    return [{}];
  }
  focus(options) {
    if (!this.isConnected || this.disabled || this.closest('[hidden], [inert]')) return;
    this.focusCount += 1;
    this.lastFocusOptions = options;
    this.ownerDocument.activeElement = this;
    this.ownerDocument.emit('focusin', { target: this });
  }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  dispatch(name, properties = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
    for (const callback of this.listeners.get(name) || []) callback(event);
    return event;
  }
  set innerHTML(html) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._html = String(html);
    const stack = [this];
    for (const match of this._html.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
      if (match[1]) { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      for (const attribute of match[3].matchAll(/([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        attrs[attribute[1]] = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      }
      const element = stack.at(-1).append(new FakeElement(this.ownerDocument, match[2], attrs));
      if (!['input', 'br', 'img', 'hr', 'meta', 'link'].includes(match[2].toLowerCase()) && !match[3].endsWith('/')) stack.push(element);
    }
  }
  get innerHTML() { return this._html || ''; }
}

function harness({ withClose = true } = {}) {
  const doc = new FakeDocument();
  const make = (tag, attrs, parent = doc.root) => parent.append(new FakeElement(doc, tag, attrs));
  const main = make('main', { id: 'main' });
  const locked = make('aside', { id: 'already-inert', inert: '' });
  const trigger = make('button', { id: 'trigger' }, main);
  const fallback = make('button', { id: 'fallback' }, main);
  const outside = make('button', { id: 'outside' });
  const dialog = make('div', { id: 'sheet', hidden: '' });
  const backdrop = make('div', { id: 'backdrop', hidden: '' });
  const title = make('span', { id: 'sheet-title' }, dialog);
  const closeButton = withClose ? make('button', { id: 'sheet-close' }, dialog) : null;
  const body = make('div', { id: 'sheet-body' }, dialog);
  const callbackErrors = [];
  const context = vm.createContext({ console: { error: (...args) => callbackErrors.push(args) }, queueMicrotask });
  vm.runInContext(`${source}\nthis.create = createDialogController;`, context, { filename: 'web/js/mobile/dialog.js' });
  const controller = context.create({ dialog, backdrop, title, body,
    getBackground: () => [main, locked, dialog, doc.root],
    getFallbackFocus: () => fallback,
  });
  trigger.focus();
  return { controller, doc, dialog, backdrop, title, body, main, locked, trigger, fallback, outside, closeButton, callbackErrors,
    byId: id => dialog.querySelector(`#${id}`),
  };
}

test('stale tokens cannot update or close a replaced or dismissed sheet', () => {
  const h = harness();
  const first = h.controller.open('First', '<button id="first">First</button>');
  const second = h.controller.open('Second', '<button id="second">Second</button>');
  assert.equal(h.controller.isCurrent(first), false);
  assert.equal(h.controller.isCurrent(second), true);
  assert.equal(h.controller.update(first, 'Stale', 'stale body'), false);
  assert.equal(h.controller.close(first), false);
  assert.equal(h.title.textContent, 'Second');
  assert.match(h.body.innerHTML, /second/);
  assert.equal(h.dialog.hidden, false);
  assert.equal(h.controller.close(second), true);
  assert.equal(h.controller.update(second, 'Late', 'late body'), false);
  assert.equal(h.controller.close(second), false);
  assert.equal(h.controller.currentId, null);
});

test('replacement and dismissal callbacks run exactly once with the correct reason', () => {
  const h = harness();
  const events = [];
  const first = h.controller.open('First', '', { onClose: reason => events.push(['first', reason]) });
  const second = h.controller.open('Second', '', { onClose: reason => events.push(['second', reason]) });
  assert.deepEqual(events, [['first', 'replaced']]);
  h.controller.close(first);
  h.controller.close(second);
  h.controller.close(second);
  assert.deepEqual(events, [['first', 'replaced'], ['second', 'dismissed']]);
});

test('background isolation survives replacement and restores each original inert value', () => {
  const h = harness();
  const first = h.controller.open('First', '');
  assert.equal(h.main.inert, true);
  assert.equal(h.locked.inert, true);
  assert.equal(h.dialog.inert, false, 'the dialog itself must not be made inert');
  assert.equal(h.doc.root.inert, false, 'an ancestor containing the dialog must not be made inert');
  const second = h.controller.open('Second', '');
  assert.equal(h.controller.close(first), false);
  assert.equal(h.main.inert, true);
  h.controller.close(second);
  assert.equal(h.main.inert, false);
  assert.equal(h.locked.inert, true);
  assert.equal(h.backdrop.hidden, true);
  assert.equal(h.dialog.hidden, true);
});

test('opening assigns dialog semantics and honors an available explicit initial focus', () => {
  const h = harness();
  h.controller.open('Edit', '<input id="preferred" data-initial-focus><button id="save">Save</button>');
  assert.equal(h.doc.activeElement, h.byId('preferred'));
  assert.equal(h.dialog.getAttribute('aria-modal'), 'true');
  assert.equal(h.dialog.getAttribute('aria-labelledby'), 'sheet-title');
  assert.equal(h.dialog.tabIndex, -1);
  assert.equal(h.doc.activeElement.lastFocusOptions.preventScroll, true);
});

test('unusable initial focus falls back to the first visible enabled control', () => {
  const h = harness();
  h.controller.open('Edit', '<input id="preferred" autofocus disabled><button id="save">Save</button>');
  assert.equal(h.doc.activeElement, h.closeButton);
});

test('Tab and Shift-Tab wrap at the boundaries while ordinary middle movement stays native', () => {
  const h = harness();
  h.controller.open('Edit', '<input id="middle"><button id="last">Save</button><button disabled>Disabled</button><div hidden><button>Hidden</button></div>');
  const first = h.closeButton;
  const last = h.byId('last');
  last.focus();
  assert.equal(h.dialog.dispatch('keydown', { key: 'Tab' }).defaultPrevented, true);
  assert.equal(h.doc.activeElement, first);
  assert.equal(h.dialog.dispatch('keydown', { key: 'Tab', shiftKey: true }).defaultPrevented, true);
  assert.equal(h.doc.activeElement, last);
  h.byId('middle').focus();
  assert.equal(h.dialog.dispatch('keydown', { key: 'Tab' }).defaultPrevented, false);
  h.dialog.focus();
  h.dialog.dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(h.doc.activeElement, last);
});

test('negative-tabindex controls are not part of the keyboard wrap order', () => {
  const h = harness();
  h.controller.open('Edit', '<button id="last">Last tab stop</button><button id="programmatic" tabindex="-1">Programmatic only</button>');
  h.byId('last').focus();
  const event = h.dialog.dispatch('keydown', { key: 'Tab' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.doc.activeElement, h.closeButton);
  h.closeButton.focus();
  h.dialog.dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(h.doc.activeElement, h.byId('last'));
});

test('a sheet with no usable control focuses itself and traps Tab in place', () => {
  const h = harness({ withClose: false });
  h.controller.open('Message', '<p>Read this message.</p><button disabled>Unavailable</button>');
  assert.equal(h.doc.activeElement, h.dialog);
  assert.equal(h.dialog.dispatch('keydown', { key: 'Tab' }).defaultPrevented, true);
  assert.equal(h.doc.activeElement, h.dialog);
});

test('focus escaping the active sheet is redirected, but the trap stops after close', () => {
  const h = harness();
  const id = h.controller.open('Edit', '<input id="preferred" autofocus>');
  h.outside.focus();
  assert.equal(h.doc.activeElement, h.byId('preferred'));
  h.controller.close(id);
  h.outside.focus();
  assert.equal(h.doc.activeElement, h.outside);
});

test('updates refocus replaced body controls without stealing focus from surviving header controls', () => {
  const h = harness();
  const id = h.controller.open('Edit', '<input id="old" autofocus>');
  const old = h.byId('old');
  h.controller.update(id, 'Updated', '<input id="new" autofocus>');
  assert.equal(old.isConnected, false);
  assert.equal(h.doc.activeElement, h.byId('new'));
  h.closeButton.focus();
  const focusedCount = h.closeButton.focusCount;
  h.controller.update(id, 'Again', '<input id="newer" autofocus>');
  assert.equal(h.doc.activeElement, h.closeButton);
  assert.equal(h.closeButton.focusCount, focusedCount);
});

test('closing restores the original trigger across replacements and falls back if that trigger disappeared', () => {
  for (const disconnected of [false, true]) {
    const h = harness();
    h.controller.open('First', '<input autofocus>');
    const current = h.controller.open('Second', '<button>Continue</button>');
    if (disconnected) h.trigger.remove();
    h.controller.close(current);
    assert.equal(h.doc.activeElement, disconnected ? h.fallback : h.trigger);
    assert.equal(h.main.inert, false);
  }
});

test('onClose may synchronously open a new sheet without the outer close hiding it or restoring its background', () => {
  const h = harness();
  const events = [];
  let next;
  const first = h.controller.open('First', '', { onClose: reason => {
    events.push(['first', reason]);
    next = h.controller.open('Next', '<input id="next" autofocus>', { onClose: why => events.push(['next', why]) });
  } });
  assert.equal(h.controller.close(first), true);
  assert.equal(h.controller.currentId, next);
  assert.equal(h.dialog.hidden, false);
  assert.equal(h.backdrop.hidden, false);
  assert.equal(h.main.inert, true);
  assert.equal(h.doc.activeElement, h.byId('next'));
  assert.equal(h.controller.close(first), false);
  h.controller.close(next);
  assert.deepEqual(events, [['first', 'dismissed'], ['next', 'dismissed']]);
  assert.equal(h.main.inert, false);
  assert.equal(h.locked.inert, true);
  assert.equal(h.doc.activeElement, h.trigger);
});

test('a replacement callback may open a third sheet and invalidate the intermediate token exactly once', () => {
  const h = harness();
  const events = [];
  let third;
  const first = h.controller.open('First', '', { onClose: reason => {
    events.push(['first', reason]);
    third = h.controller.open('Third', '<input id="third" autofocus>', { onClose: why => events.push(['third', why]) });
  } });
  const second = h.controller.open('Second', '<input id="second" autofocus>', { onClose: reason => events.push(['second', reason]) });
  assert.equal(h.controller.isCurrent(first), false);
  assert.equal(h.controller.isCurrent(second), false);
  assert.equal(h.controller.isCurrent(third), true);
  assert.deepEqual(events, [['first', 'replaced'], ['second', 'replaced']]);
  assert.equal(h.controller.update(second, 'Late second', 'late'), false);
  assert.equal(h.controller.close(second), false);
  assert.equal(h.title.textContent, 'Third');
  assert.equal(h.doc.activeElement, h.byId('third'));
  h.controller.close(third);
  assert.deepEqual(events, [['first', 'replaced'], ['second', 'replaced'], ['third', 'dismissed']]);
  assert.equal(h.main.inert, false);
  assert.equal(h.doc.activeElement, h.trigger);
});

test('a throwing onClose callback cannot leave the sheet active or run twice', () => {
  const h = harness();
  let calls = 0;
  const id = h.controller.open('Failing callback', '', { onClose: () => { calls += 1; throw new Error('fabricated callback failure'); } });
  assert.equal(h.controller.close(id), true);
  assert.equal(h.controller.close(id), false);
  assert.equal(calls, 1);
  assert.equal(h.callbackErrors.length, 1);
  assert.equal(h.controller.currentId, null);
  assert.equal(h.main.inert, false);
});
