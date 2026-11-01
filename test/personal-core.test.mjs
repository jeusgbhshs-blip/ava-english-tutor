/** Independent verification of the shipped mobile core state and sheet lifecycle. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/js/mobile/core.js', import.meta.url), 'utf8')
  .replace(/^import\s+[\s\S]*?\s+from\s+(['"])[^'"]+\1\s*;?\s*$/gm, '')
  .replace(/^export\s*\{[^}]*\}\s*;?/gm, '')
  .replace(/^export\s+/gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness(api = {}, overrides = {}) {
  const nodes = new Map();
  const state = { current: null, opens: [], updates: [], sequence: 0 };
  function render(html) {
    nodes.clear();
    if (html.includes('id="wordbook-retry"')) {
      nodes.set('#wordbook-retry', { addEventListener(event, fn) { this[event] = fn; } });
    }
  }
  const context = vm.createContext({
    console, setTimeout, clearTimeout, AbortController, Response,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { querySelector: selector => nodes.get(selector) || null, querySelectorAll: () => [] },
    api, chatStream: () => {},
    getJSON: async () => { throw new Error('unexpected API fallback'); },
    postJSON: async () => { throw new Error('unexpected API fallback'); },
    fetch: async () => { throw new Error('network is disabled in this test'); },
    ...overrides,
  });
  vm.runInContext(`${source}\nthis.subject = { M, ui, loadSettings, loadContent, loadWordbook, loadProgress, loadProfile, saveSettings, showWordbookSheet, loadPlan, saveLocalPlan };`, context, { filename: 'web/js/mobile/core.js' });
  const subject = context.subject;
  Object.assign(subject.ui, {
    openSheet(title, html) {
      const token = ++state.sequence;
      state.current = { token, title, html };
      state.opens.push({ token, title, html });
      render(html);
      return token;
    },
    isSheetCurrent(token) { return state.current?.token === token; },
    updateSheet(token, title, html) {
      // Record attempts as well as accepted updates, to catch an unsafe late write.
      state.updates.push({ token, title, html });
      if (state.current?.token !== token) return false;
      state.current = { token, title, html };
      render(html);
      return true;
    },
    closeSheet(token) {
      if (!state.current || (token !== undefined && token !== state.current.token)) return false;
      state.current = null;
      nodes.clear();
      return true;
    },
  });
  return { ...subject, state, nodes };
}

const loaders = [
  ['loadSettings', 'getSettings', 'settings', { level: 'A2', voiceEngine: 'browser' }, { level: 'B1' }],
  ['loadContent', 'getContent', 'content', { topics: ['old topic'] }, { topics: ['new topic'] }],
  ['loadWordbook', 'getWordbook', 'wordbook', { days: [{ words: [{ word: 'retained' }] }] }, { days: [] }],
  ['loadProgress', 'getProgress', 'progress', { minutes: 12, rounds: 4 }, { minutes: 18, rounds: 6 }],
  ['loadProfile', 'getProfile', 'profile', { interests: ['music'] }, { profile: { interests: ['travel'] } }],
];

for (const [method, apiMethod, field, cached] of loaders) {
  test(`${method} returns null on network, structured, empty and invalid responses without replacing cached ${field}`, async () => {
    for (const response of [
      async () => { throw new Error('fabricated connection failure'); },
      async () => ({ ok: false, error: '服务暂不可用', level: 'C1', days: [], interests: [] }),
      async () => null,
      async () => 'invalid response',
    ]) {
      const h = harness({ [apiMethod]: response });
      const old = structuredClone(cached);
      h.M[field] = old;
      assert.equal(await h[method](), null);
      assert.equal(h.M[field], old, 'failed reads must preserve the exact previously loaded value');
      assert.deepEqual(h.M[field], cached);
    }
  });
}

test('successful reads replace cached state, including an explicitly successful empty wordbook', async () => {
  for (const [method, apiMethod, field, cached, response] of loaders) {
    const h = harness({ [apiMethod]: async () => response });
    h.M[field] = structuredClone(cached);
    const result = await h[method]();
    const expected = field === 'profile' ? response.profile : response;
    assert.deepEqual(plain(result), expected);
    assert.equal(h.M[field], result);
  }
});

test('each cached resource only accepts its latest request, including when that newest request fails', async () => {
  for (const [method, apiMethod, field, cached, response] of loaders) {
    for (const latestFails of [false, true]) {
      const first = deferred();
      const second = deferred();
      let calls = 0;
      const h = harness({ [apiMethod]: () => (++calls === 1 ? first.promise : second.promise) });
      h.M[field] = cached;
      const older = h[method]();
      const newer = h[method]();
      second.resolve(latestFails ? { ok: false, error: 'newest request failed' } : response);
      await newer;
      const accepted = h.M[field];
      first.resolve(field === 'profile' ? { profile: { interests: ['stale'] } } : { stale: true });
      await older;
      assert.equal(h.M[field], accepted, `${method}: older response must not roll back cache`);
      if (latestFails) assert.equal(h.M[field], cached);
    }
  }
});

test('fallback read errors also preserve the previously loaded state', async () => {
  const h = harness({}, {
    getJSON: async () => { throw new Error('fabricated fallback failure'); },
    fetch: async () => new Response(JSON.stringify({ error: 'local service unavailable' }), { status: 503 }),
  });
  for (const [method, _apiMethod, field, cached] of loaders) {
    h.M[field] = cached;
    assert.equal(await h[method](), null);
    assert.equal(h.M[field], cached);
  }
});

test('saveSettings failures never merge error payloads or attempted values into M.settings', async () => {
  for (const response of [
    async () => { throw new Error('fabricated save failure'); },
    async () => null,
    async () => ({ ok: false, error: '保存失败', level: 'C1', voiceEngine: 'volc' }),
    async () => 'invalid response',
  ]) {
    const h = harness({ saveSettings: response });
    const old = { level: 'A2', voiceEngine: 'browser', hasKey: true };
    h.M.settings = old;
    await h.saveSettings({ level: 'B1' });
    assert.equal(h.M.settings, old);
    assert.deepEqual(h.M.settings, { level: 'A2', voiceEngine: 'browser', hasKey: true });
  }
});

test('saveSettings waits for confirmation and merges only the successful server response', async () => {
  const reply = deferred();
  let sent;
  const h = harness({ saveSettings: patch => { sent = patch; return reply.promise; } });
  h.M.settings = { level: 'A2', voiceEngine: 'browser' };
  const pending = h.saveSettings({ level: 'B1' });
  assert.equal(h.M.settings.level, 'A2');
  assert.deepEqual(sent, { level: 'B1' });
  reply.resolve({ level: 'B2', hasKey: false });
  await pending;
  assert.deepEqual(plain(h.M.settings), { level: 'B2', voiceEngine: 'browser', hasKey: false });
});

test('a confirmed settings save invalidates older pending reads so the saved level cannot roll back', async () => {
  const read = deferred();
  const h = harness({
    getSettings: () => read.promise,
    saveSettings: async () => ({ level: 'B1', voiceEngine: 'browser' }),
  });
  h.M.settings = { level: 'A2', voiceEngine: 'browser' };
  const pendingRead = h.loadSettings();
  await h.saveSettings({ level: 'B1' });
  const saved = h.M.settings;
  read.resolve({ level: 'A2', voiceEngine: 'browser' });
  await pendingRead;
  assert.equal(h.M.settings, saved);
  assert.equal(h.M.settings.level, 'B1');
});

test('reads started during a settings save cannot override the confirmed write in either completion order', async () => {
  for (const readFinishesFirst of [true, false]) {
    const read = deferred();
    const write = deferred();
    const h = harness({ getSettings: () => read.promise, saveSettings: () => write.promise });
    h.M.settings = { level: 'A2', voiceEngine: 'browser' };
    const pendingWrite = h.saveSettings({ level: 'B1' });
    const pendingRead = h.loadSettings();
    if (readFinishesFirst) {
      read.resolve({ level: 'A2', voiceEngine: 'browser' });
      await pendingRead;
    }
    write.resolve({ level: 'B1', voiceEngine: 'browser' });
    await pendingWrite;
    if (!readFinishesFirst) {
      read.resolve({ level: 'A2', voiceEngine: 'browser' });
      await pendingRead;
    }
    assert.equal(h.M.settings.level, 'B1', `saved value wins when read finishes ${readFinishesFirst ? 'first' : 'last'}`);
  }
});

for (const outcome of ['success', 'failure']) {
  test(`a late wordbook ${outcome} cannot reopen a closed sheet or overwrite a replacement`, async () => {
    for (const dismiss of ['close', 'replace']) {
      const reply = deferred();
      const h = harness({ getWordbook: () => reply.promise });
      const old = { days: [{ words: [{ word: 'cached' }] }] };
      h.M.wordbook = old;
      const pending = h.showWordbookSheet();
      assert.equal(h.state.opens.length, 1);
      if (dismiss === 'close') h.ui.closeSheet();
      else h.ui.openSheet('Another activity', '<p>Keep this sheet</p>');
      const before = h.state.current;
      reply.resolve(outcome === 'success'
        ? { days: [{ words: [{ word: 'late result' }] }] }
        : { ok: false, error: 'failed after dismissal' });
      await pending;
      assert.equal(h.state.current, before);
      assert.equal(h.state.updates.length, 0, 'stale requests must not even attempt a sheet update');
      assert.equal(h.state.opens.length, dismiss === 'close' ? 1 : 2);
      if (outcome === 'failure') assert.equal(h.M.wordbook, old);
    }
  });
}

test('the newer wordbook sheet wins when two loads complete out of order', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const h = harness({ getWordbook: () => (++calls === 1 ? first.promise : second.promise) });
  const older = h.showWordbookSheet();
  const newer = h.showWordbookSheet();
  second.resolve({ days: [{ words: [{ word: 'newest', meaning: '最新' }] }] });
  await newer;
  const shown = h.state.current;
  assert.match(shown.html, /newest/);
  first.resolve({ days: [{ words: [{ word: 'stale', meaning: '迟到' }] }] });
  await older;
  assert.equal(h.state.current, shown);
  assert.equal(h.state.updates.length, 1);
  assert.doesNotMatch(h.state.current.html, /stale/);
  assert.equal(h.M.wordbook.days[0].words[0].word, 'newest', 'a stale sheet request must not roll back the shared cache');
});

test('a wordbook failure shows retry instead of an empty book, and retry is tied to the owning sheet', async () => {
  let calls = 0;
  const h = harness({ getWordbook: async () => ++calls === 1
    ? { ok: false, error: '暂时断开' }
    : { days: [{ words: [{ word: 'recovered', meaning: '恢复' }] }] },
  });
  const cached = { days: [{ words: [{ word: 'cached' }] }] };
  h.M.wordbook = cached;
  await h.showWordbookSheet();
  assert.equal(h.M.wordbook, cached);
  assert.match(h.state.current.html, /暂时无法读取单词表/);
  assert.match(h.state.current.html, /重新加载/);
  assert.doesNotMatch(h.state.current.html, /还没有单词/);
  const retry = h.nodes.get('#wordbook-retry').click;
  retry();
  await tick();
  assert.equal(calls, 2);
  assert.match(h.state.current.html, /recovered/);
  const current = h.state.current;
  retry(); // The old retry belongs to the replaced error sheet.
  await tick();
  assert.equal(calls, 2);
  assert.equal(h.state.current, current);
});

test('a successful empty wordbook has an honest empty state without a retry error', async () => {
  const h = harness({ getWordbook: async () => ({ days: [] }) });
  h.M.wordbook = { days: [{ words: [{ word: 'old' }] }] };
  await h.showWordbookSheet();
  assert.match(h.state.current.html, /还没有单词/);
  assert.doesNotMatch(h.state.current.html, /暂时无法读取|wordbook-retry/);
  assert.deepEqual(plain(h.M.wordbook), { days: [] });
});

const makePlan = id => ({ version: 3, id, stages: [], lessons: { first: { id: `${id}-lesson`, title: id } } });

function planStorage(plan) {
  const values = new Map(plan ? [['ava.mobile.plan', JSON.stringify(plan)]] : []);
  const writes = [];
  return {
    values, writes,
    getItem: key => values.get(key) || null,
    setItem(key, value) { writes.push(['set', key, value]); values.set(key, value); },
    removeItem(key) { writes.push(['remove', key]); values.delete(key); },
  };
}

test('saving a confirmed plan updates its lessons and invalidates all older plan reads before any side effect', async () => {
  for (const oldResponse of [
    { ok: true, plan: makePlan('stale') },
    { ok: true, plan: null },
    { ok: false, error: 'stale failure' },
    { ok: true, plan: { version: 2, id: 'obsolete' } },
  ]) {
    const waiting = deferred();
    const storage = planStorage(makePlan('cached'));
    const h = harness({ getPlan: () => waiting.promise }, { localStorage: storage });
    h.M.plan = makePlan('old');
    h.M.lessons = [{ id: 'old-lesson' }];
    const read = h.loadPlan();
    const saved = makePlan('saved');
    h.saveLocalPlan(saved);
    const lessons = h.M.lessons;
    const writeCount = storage.writes.length;
    waiting.resolve(oldResponse);
    assert.equal(await read, saved);
    assert.equal(h.M.plan, saved);
    assert.equal(h.M.lessons, lessons, 'an outdated response must not even replace the current lesson array');
    assert.deepEqual(plain(h.M.lessons), Object.values(saved.lessons));
    assert.equal(storage.values.get('ava.mobile.plan'), JSON.stringify(saved));
    assert.equal(storage.writes.length, writeCount, 'a stale response must not write or remove local cache');
  }
});

test('the latest plan read wins, including when it fails and an earlier response says no plan exists', async () => {
  for (const latestFails of [false, true]) {
    const first = deferred();
    const second = deferred();
    const cached = makePlan('old-cache');
    const current = makePlan('current');
    const latest = makePlan('latest');
    const storage = planStorage(cached);
    let calls = 0;
    const h = harness({ getPlan: () => ++calls === 1 ? first.promise : second.promise }, { localStorage: storage });
    h.M.plan = current;
    h.M.lessons = Object.values(current.lessons);
    const oldRead = h.loadPlan();
    const newRead = h.loadPlan();
    second.resolve(latestFails ? { ok: false, error: 'latest request failed' } : { ok: true, plan: latest });
    await newRead;
    const accepted = latestFails ? current : latest;
    const lessons = h.M.lessons;
    const writeCount = storage.writes.length;
    first.resolve({ ok: true, plan: null });
    assert.equal(await oldRead, accepted);
    assert.equal(h.M.plan, accepted);
    assert.equal(h.M.lessons, lessons);
    assert.deepEqual(plain(h.M.lessons), Object.values(accepted.lessons));
    assert.equal(storage.values.get('ava.mobile.plan'), JSON.stringify(cached));
    assert.equal(storage.writes.length, writeCount);
  }
});

test('failed plan reads preserve an existing in-memory plan and lessons instead of rolling back to local cache', async () => {
  for (const getPlan of [
    async () => { throw new Error('network unavailable'); },
    async () => ({ ok: false, error: 'server unavailable' }),
    async () => null,
    async () => 'invalid response',
  ]) {
    const storage = planStorage(makePlan('older-cache'));
    const current = makePlan('current');
    const lessons = Object.values(current.lessons);
    const h = harness({ getPlan }, { localStorage: storage });
    h.M.plan = current;
    h.M.lessons = lessons;
    assert.equal(await h.loadPlan(), current);
    assert.equal(h.M.plan, current);
    assert.equal(h.M.lessons, lessons);
    assert.equal(storage.writes.length, 0);
  }
});

test('a current successful no-plan response clears the plan, lessons and obsolete local cache', async () => {
  const storage = planStorage(makePlan('old'));
  const h = harness({ getPlan: async () => ({ ok: true, plan: null }) }, { localStorage: storage });
  h.M.plan = makePlan('current');
  h.M.lessons = Object.values(h.M.plan.lessons);
  assert.equal(await h.loadPlan(), null);
  assert.equal(h.M.plan, null);
  assert.deepEqual(plain(h.M.lessons), []);
  assert.equal(storage.values.has('ava.mobile.plan'), false);
});

test('the initial offline plan read may recover a version 3 local cache when no in-memory plan exists', async () => {
  const cached = makePlan('offline');
  const storage = planStorage(cached);
  const h = harness({ getPlan: async () => ({ ok: false }) }, { localStorage: storage });
  assert.equal(h.M.plan, null);
  assert.deepEqual(plain(await h.loadPlan()), cached);
  assert.deepEqual(plain(h.M.lessons), Object.values(cached.lessons));
});

test('saveLocalPlan synchronizes lesson state even when local storage is unavailable or the plan is cleared', () => {
  const h = harness({}, { localStorage: {
    getItem: () => null,
    setItem() { throw new Error('storage unavailable'); },
    removeItem() { throw new Error('storage unavailable'); },
  } });
  const plan = makePlan('saved');
  h.M.lessons = [{ id: 'previous' }];
  h.saveLocalPlan(plan);
  assert.equal(h.M.plan, plan);
  assert.deepEqual(plain(h.M.lessons), Object.values(plan.lessons));
  h.saveLocalPlan(null);
  assert.equal(h.M.plan, null);
  assert.deepEqual(plain(h.M.lessons), []);
});

function screenPlanActions(core, api) {
  const code = readFileSync(new URL('../web/js/mobile/screens.js', import.meta.url), 'utf8')
    .replace(/^import\s+[\s\S]*?\s+from\s+(['"])[^'"]+\1\s*;?\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*;?/gm, '')
    .replace(/^export\s+/gm, '');
  const context = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, api,
    M: core.M, loadPlan: core.loadPlan, saveLocalPlan: core.saveLocalPlan,
    $: () => null, toast() {}, characterById: id => ({ id, name: id }),
  });
  vm.runInContext(`${code}\nthis.subject = { pickPlanTeacher, restartPlanLesson, retryPlanGeneration };`, context, { filename: 'web/js/mobile/screens.js' });
  return context.subject;
}

for (const [action, apiMethod, argument] of [
  ['pickPlanTeacher', 'setPlanTeacher', 'maya'],
  ['restartPlanLesson', 'restartLesson', 'lesson-1'],
  ['retryPlanGeneration', 'regeneratePlan', undefined],
]) {
  test(`${action} saves its confirmed plan through core so an older read cannot undo it`, async () => {
    const waiting = deferred();
    const storage = planStorage(makePlan('old-cache'));
    const h = harness({ getPlan: () => waiting.promise }, { localStorage: storage });
    h.M.plan = { ...makePlan('old'), teacherId: 'elena' };
    const read = h.loadPlan();
    const saved = { ...makePlan('confirmed'), teacherId: 'maya' };
    const screens = screenPlanActions(h, { [apiMethod]: async () => ({ ok: true, plan: saved }) });
    await screens[action](argument);
    waiting.resolve({ ok: true, plan: makePlan('stale') });
    await read;
    assert.equal(h.M.plan, saved);
    assert.deepEqual(plain(h.M.lessons), Object.values(saved.lessons));
    assert.equal(storage.values.get('ava.mobile.plan'), JSON.stringify(saved));
  });
}

test('a confirmed teacher-only response also invalidates older reads and persists the updated teacher', async () => {
  const waiting = deferred();
  const storage = planStorage(makePlan('old-cache'));
  const h = harness({ getPlan: () => waiting.promise }, { localStorage: storage });
  h.M.plan = { ...makePlan('current'), teacherId: 'elena' };
  const read = h.loadPlan();
  const screens = screenPlanActions(h, { setPlanTeacher: async () => ({ ok: true }) });
  await screens.pickPlanTeacher('maya');
  waiting.resolve({ ok: true, plan: { ...makePlan('stale'), teacherId: 'elena' } });
  await read;
  assert.equal(h.M.plan.teacherId, 'maya');
  assert.equal(h.M.plan.id, 'current');
  assert.equal(JSON.parse(storage.values.get('ava.mobile.plan')).teacherId, 'maya');
  assert.deepEqual(plain(h.M.lessons), Object.values(h.M.plan.lessons));
});
