import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayHistory } from '../web/js/mobile/navigation.js';

function harness() {
  const entries = [{ page: 'previous' }, { page: 'ava', keep: 'existing state' }];
  let index = 1;
  let layers = [];
  let pop = null;
  let closes = 0;
  const history = {
    get state() { return entries[index]; },
    pushState(state) { entries.splice(index + 1); entries.push(state); index++; },
    replaceState(state) { entries[index] = state; },
    back() { pop = () => { index = Math.max(0, index - 1); subject.onPopState(); }; },
  };
  const subject = createOverlayHistory({
    history,
    getOverlay: () => layers.at(-1) || null,
    onBack() { closes++; layers.pop(); subject.sync(); },
  });
  return {
    subject, history, entries,
    get index() { return index; },
    get layers() { return [...layers]; },
    get closes() { return closes; },
    open(kind) { layers.push(kind); subject.open(kind); },
    replace(kind) { layers[layers.length - 1] = kind; subject.open(kind); },
    close() { layers.pop(); subject.sync(); },
    flush() { const fn = pop; pop = null; fn?.(); },
    userBack() { history.back(); this.flush(); },
    forward() { index = Math.min(entries.length - 1, index + 1); subject.onPopState(); },
  };
}

test('repeated sheet open and close cycles never accumulate dead history entries', () => {
  const h = harness();
  for (let i = 0; i < 20; i++) {
    h.open('sheet');
    assert.equal(h.index, 2);
    h.close();
    h.flush();
    assert.equal(h.index, 1);
    assert.equal(h.closes, 0, 'programmatic back must not dismiss another layer');
    assert.equal(h.entries.length, 3, 'only one forward overlay entry may remain');
  }
  h.userBack();
  assert.equal(h.history.state.page, 'previous', 'one Back should leave after closing the last sheet');
});

test('a sheet above a call shares one entry and browser Back dismisses only the top layer', () => {
  const h = harness();
  h.open('call');
  h.open('sheet');
  assert.equal(h.entries.length, 3);
  h.userBack();
  assert.deepEqual(h.layers, ['call']);
  assert.equal(h.history.state.__avaOverlay, 'call');
  assert.equal(h.closes, 1);
  h.userBack();
  assert.deepEqual(h.layers, []);
  assert.equal(h.index, 1);
  assert.equal(h.closes, 2);
});

test('closing a nested sheet by button keeps the underlying panel and history entry', () => {
  const h = harness();
  h.open('kb');
  h.open('sheet');
  h.close();
  h.flush();
  assert.deepEqual(h.layers, ['kb']);
  assert.equal(h.history.state.__avaOverlay, 'kb');
  assert.equal(h.index, 2);
  h.close();
  h.flush();
  assert.equal(h.index, 1);
});

test('opening a new overlay before the programmatic pop completes does not close it', () => {
  const h = harness();
  h.open('sheet');
  h.close();
  h.open('call');
  h.flush();
  assert.deepEqual(h.layers, ['call']);
  assert.equal(h.history.state.__avaOverlay, 'call');
  assert.equal(h.closes, 0);
  assert.equal(h.entries.length, 3);
});

test('open and close during a pending pop settles on the base page', () => {
  const h = harness();
  h.open('sheet');
  h.close();
  h.open('kb');
  h.close();
  h.flush();
  assert.equal(h.index, 1);
  assert.deepEqual(h.layers, []);
  assert.equal(h.closes, 0);
});

test('replacing a sheet updates ownership without adding another entry or losing existing state', () => {
  const h = harness();
  h.open('sheet');
  h.replace('sheet');
  h.replace('sheet');
  assert.equal(h.entries.length, 3);
  assert.equal(h.history.state.keep, 'existing state');
  h.close();
  h.flush();
  assert.deepEqual(h.history.state, { page: 'ava', keep: 'existing state' });
});

test('forward navigation to a dismissed overlay returns to the base without resurrecting it', () => {
  const h = harness();
  h.open('sheet');
  h.close();
  h.flush();
  h.forward();
  h.flush();
  assert.equal(h.index, 1);
  assert.deepEqual(h.layers, []);
  assert.equal(h.closes, 0);
});

test('history unavailability never prevents ordinary controls from operating', () => {
  let layer = 'sheet';
  const history = {
    state: { __avaOverlay: 'sheet', keep: true },
    pushState() { throw new Error('disabled'); },
    replaceState(state) { this.state = state; },
    back() { throw new Error('disabled'); },
  };
  const subject = createOverlayHistory({ history, getOverlay: () => layer, onBack() { layer = null; } });
  assert.doesNotThrow(() => subject.open('sheet'));
  layer = null;
  assert.doesNotThrow(() => subject.sync());
  assert.deepEqual(history.state, { keep: true });
});
