import test from 'node:test';
import assert from 'node:assert/strict';
import { viewportMetrics } from '../web/js/mobile/viewport.js';

test('keyboard reduces usable height and follows its visible top offset', () => {
  assert.deepEqual(viewportMetrics({ height: 844, layoutHeight: 844, visualHeight: 492, visualTop: 30, editing: true }),
    { height: 492, top: 30, keyboardOpen: true });
});

test('keyboard dismissal drops stale Safari viewport offset', () => {
  assert.deepEqual(viewportMetrics({ height: 844, layoutHeight: 844, visualHeight: 844, visualTop: 30 }),
    { height: 844, top: 0, keyboardOpen: false });
});

test('browser toolbar resizing is not treated as a keyboard', () => {
  assert.deepEqual(viewportMetrics({ height: 844, layoutHeight: 844, visualHeight: 790, editing: true }),
    { height: 790, top: 0, keyboardOpen: false });
});

test('pinch zoom does not trigger a layout resize', () => {
  assert.equal(viewportMetrics({ height: 844, layoutHeight: 844, visualHeight: 422, scale: 2, editing: true }), null);
});

test('browsers without VisualViewport use the window height', () => {
  assert.deepEqual(viewportMetrics({ height: 568, layoutHeight: 568 }),
    { height: 568, top: 0, keyboardOpen: false });
});
