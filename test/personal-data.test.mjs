/** Personal learning regressions: isolated data, local fake providers only. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let scratch;
let source;
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'ava-personal-data-'));
  source = join(scratch, 'source');
  await mkdir(source);
  for (const entry of ['server.js', 'package.json', 'lib', 'content']) {
    await cp(join(root, entry), join(source, entry), { recursive: true });
  }
});
after(async () => { await rm(scratch, { recursive: true, force: true }); });

async function waitFor(predicate, message = 'operation did not finish', timeout = 1800) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function modules(t) {
  const dir = await mkdtemp(join(scratch, 'modules-'));
  for (const entry of ['package.json', 'lib', 'content']) await cp(join(source, entry), join(dir, entry), { recursive: true });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AVA_')));
  for (const key of Object.keys(environment)) delete process.env[key];
  process.env.AVA_DATA_DIR = join(dir, 'data');
  t.after(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith('AVA_')) delete process.env[key];
    Object.assign(process.env, environment);
  });
  const load = name => import(pathToFileURL(join(dir, 'lib', name + '.js')).href);
  const [plans, generation, assistant, kb, config] = await Promise.all(['plans', 'lessonGen', 'assistant', 'kb', 'config'].map(load));
  return { plans, generation, assistant, kb, config };
}

function generatedLessons(label, level = 'A2') {
  return [1, 2, 3].map(n => ({
    title: `${label} ${n}`, topic: label, level,
    phrases: [1, 2, 3].map(i => ({ en: `${label} phrase ${i}.`, zh: `${label} 第 ${i} 句。` })),
    objectives: [`Practice ${label}`], taskPrompt: `Practice ${label}.`,
  }));
}
const modelReply = (label, level = 'A2') => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lessons: generatedLessons(label, level) }) } }] }), { status: 200 });

function readyPlan(plans) {
  let plan = plans.fillPlanLessons(plans.createUserPlan({ goalText: '咖啡店点单', level: 'A2', teacherId: 'maya' }), generatedLessons('Coffee'));
  plan = plans.completeLesson(plan, { lessonId: 'lesson_1', stepsCompleted: 3 }).plan;
  plan = plans.saveLessonProgress(plan, { lessonId: 'lesson_2', step: 2, phraseIdx: 1, practiceTurns: 1 }).plan;
  return plan;
}

test('changing a goal or level regenerates unfinished lessons while preserving completed work and the prior version', async (t) => {
  const { plans } = await modules(t);
  const original = readyPlan(plans);
  const changed = plans.updatePlan(original, { goalText: '机场值机', level: 'B1' });
  assert.equal(changed.generating, true);
  assert.equal(changed.lessons.lesson_1.done, true);
  assert.deepEqual(changed.lessons.lesson_1, original.lessons.lesson_1);
  assert.equal(changed.lessons.lesson_2.status, 'generating');
  assert.deepEqual(changed.lessons.lesson_2.phrases, original.lessons.lesson_2.phrases);
  assert.deepEqual(changed.lessons.lesson_2.resume, original.lessons.lesson_2.resume);
  const revision = changed.generationRevision;
  assert.ok(revision > (original.generationRevision || 0));
  assert.equal(plans.updatePlan(changed, { goalText: '机场值机', level: 'B1' }).generationRevision, revision);
  const filled = plans.fillPlanLessons(changed, generatedLessons('Airport', 'B1'));
  assert.deepEqual(filled.lessons.lesson_1, original.lessons.lesson_1);
  assert.equal(filled.lessons.lesson_2.level, 'B1');
  assert.equal(filled.lessons.lesson_2.title, 'Airport 2');
  assert.equal(filled.lessons.lesson_2.resume, null);
  assert.equal(filled.lessons.lesson_2.previousVersion.title, 'Coffee 2');
  assert.deepEqual(filled.lessons.lesson_2.previousVersion.resume, original.lessons.lesson_2.resume);
  const changedAgain = plans.updatePlan(filled, { goalText: '酒店入住' });
  const filledAgain = plans.fillPlanLessons(changedAgain, generatedLessons('Hotel', 'B1'));
  assert.equal(filledAgain.lessons.lesson_2.previousVersion.title, 'Airport 2');
  assert.equal(filledAgain.lessons.lesson_2.previousVersion.previousVersion, undefined);
  assert.equal(filledAgain.doneLessons, 1);
});

test('a short explicit goal change takes effect without silently changing the current level or teacher', async (t) => {
  const { plans, assistant } = await modules(t);
  const original = plans.fillPlanLessons(plans.createUserPlan({ goalText: '咖啡店点单', level: 'B1', teacherId: 'maya' }), generatedLessons('Coffee', 'B1'));
  const answer = assistant.buildAssistantReply({ message: '换目标成机场值机', currentPlan: original, level: 'A2', characterId: 'elena' });
  assert.equal(answer.action.type, 'update_plan');
  assert.match(answer.action.payload.goalText, /机场值机/);
  assert.equal(answer.action.payload.level, 'B1');
  assert.equal(answer.action.payload.teacherId, 'maya');
  assert.equal(answer.action.payload.generating, true);
  assert.match(answer.reply, /更新|生成/);
  const noChange = assistant.buildAssistantReply({ message: '更新我的计划', currentPlan: original, level: 'A2', characterId: 'elena' });
  assert.equal(noChange.action.payload.goalText, original.goalText);
  assert.equal(noChange.action.payload.generating, false);
  const justLevel = assistant.buildAssistantReply({ message: '把难度调整成B2', currentPlan: original, level: 'A2', characterId: 'elena' });
  assert.equal(justLevel.action.payload.level, 'B2');
  assert.equal(justLevel.action.payload.goalText, original.goalText);
});

for (const staleOutcome of ['success', 'failure']) {
  test(`a stale generation ${staleOutcome} cannot overwrite a newer goal and the latest generation resumes`, async (t) => {
    const { plans, generation, config } = await modules(t);
    config.saveSettingsPatch({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fabricated-only' });
    const calls = [];
    t.mock.method(globalThis, 'fetch', (_url, options) => new Promise((resolve, reject) => calls.push({ resolve, reject, request: JSON.parse(options.body) })));
    const first = plans.createUserPlan({ goalText: '咖啡店点单', level: 'A2' });
    plans.savePlan(first);
    generation.generatePlanLessonsInBackground(first.id);
    await waitFor(() => calls.length === 1);
    const second = plans.updatePlan(plans.loadPlan(), { goalText: '机场值机', level: 'B1' });
    plans.savePlan(second);
    generation.generatePlanLessonsInBackground(second.id);
    if (staleOutcome === 'success') calls[0].resolve(modelReply('STALE Coffee'));
    else calls[0].reject(new Error('stale fabricated failure'));
    await waitFor(() => calls.length === 2, 'the newer goal must get its own generation after the stale task ends');
    assert.equal(plans.loadPlan().goalText, '机场值机');
    assert.equal(plans.loadPlan().lessons.lesson_1.status, 'generating');
    assert.doesNotMatch(plans.loadPlan().lessons.lesson_1.title, /STALE/);
    assert.match(JSON.stringify(calls[1].request.messages), /机场值机/);
    calls[1].resolve(modelReply('Airport', 'B1'));
    await waitFor(() => !generation.isPlanGenerating(first.id));
    assert.equal(plans.loadPlan().lessons.lesson_1.title, 'Airport 1');
    assert.equal(plans.loadPlan().lessons.lesson_1.level, 'B1');
  });
}

test('failed lesson refresh preserves old content and progress, and retry replaces only unfinished lessons', async (t) => {
  const { plans, generation, config } = await modules(t);
  config.saveSettingsPatch({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fabricated-only' });
  const original = readyPlan(plans);
  const pending = plans.updatePlan(original, { goalText: '机场值机', level: 'B1' });
  plans.savePlan(pending);
  let succeed = false;
  t.mock.method(globalThis, 'fetch', async () => succeed ? modelReply('Airport', 'B1') : new Response('fabricated failure', { status: 503 }));
  generation.generatePlanLessonsInBackground(pending.id);
  await waitFor(() => !generation.isPlanGenerating(pending.id));
  const failed = plans.loadPlan();
  assert.equal(failed.lessons.lesson_2.status, 'error');
  assert.deepEqual(failed.lessons.lesson_2.phrases, original.lessons.lesson_2.phrases);
  assert.deepEqual(failed.lessons.lesson_2.resume, original.lessons.lesson_2.resume);
  assert.deepEqual(failed.lessons.lesson_1, original.lessons.lesson_1);
  succeed = true;
  const retry = plans.resetPlanForGeneration(failed);
  plans.savePlan(retry);
  generation.generatePlanLessonsInBackground(retry.id);
  await waitFor(() => !generation.isPlanGenerating(retry.id));
  const ready = plans.loadPlan();
  assert.equal(ready.lessons.lesson_2.title, 'Airport 2');
  assert.equal(ready.lessons.lesson_2.previousVersion.title, 'Coffee 2');
  assert.deepEqual(ready.lessons.lesson_1, original.lessons.lesson_1);
});

test('knowledge documents without a key are stored, and incomplete or failed enrichment reports the real result', async (t) => {
  const { kb } = await modules(t);
  const text = 'Personal English learning material for local testing. '.repeat(90);
  const doc = kb.addDocument({ text, title: 'Local fixture' });
  assert.equal(doc.enrichStatus, 'stored');
  assert.equal(kb.kbStats().enriching, 0);
  await assert.rejects(kb.enrichDocument(doc.id, {}), /API Key/);
  assert.equal(kb.getDocument(doc.id).enrichStatus, 'stored');
  let fail = false;
  t.mock.method(globalThis, 'fetch', async () => {
    if (fail) throw new Error('fabricated provider failure');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ i: 1, summary: 'Only the first chunk', keywords: ['personal'] }] }) } }] }), { status: 200 });
  });
  const settings = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fabricated-only' };
  const partial = await kb.enrichDocument(doc.id, settings);
  assert.equal(partial.enrichStatus, 'partial');
  assert.equal(partial.enrichedChunks, 1);
  assert.ok(partial.chunks > partial.enrichedChunks);
  const originalChunks = kb.getDocument(doc.id).chunks.map(chunk => chunk.text);
  fail = true;
  const failureDoc = kb.addDocument({ text, title: 'Failure fixture' });
  const failure = await kb.enrichDocument(failureDoc.id, settings);
  assert.equal(failure.ok, false);
  assert.equal(failure.enrichStatus, 'failed');
  assert.match(failure.error, /失败/);
  assert.deepEqual(kb.getDocument(failureDoc.id).chunks.map(chunk => chunk.text), originalChunks);
  assert.equal(kb.kbStats().enriching, 0);
});

test('persisted orphan pending states recover, while a real enrichment stays pending and duplicate requests share one job', async (t) => {
  const { kb, config } = await modules(t);
  const doc = kb.addDocument({ text: 'A local fixture for interrupted enrichment. '.repeat(30), title: 'Interrupted fixture' });
  config.writeJsonFile(join(kb.KB_DIR, `${doc.id}.json`), { ...doc, enrichStatus: 'pending' });
  const index = config.readJsonFile(kb.KB_INDEX_PATH, { docs: [] });
  config.writeJsonFile(kb.KB_INDEX_PATH, { ...index, docs: index.docs.map(meta => ({ ...meta, enrichStatus: 'pending' })) });
  assert.equal(kb.listDocuments()[0].enrichStatus, 'stored');
  assert.equal(kb.getDocument(doc.id).enrichStatus, 'stored');
  let release;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls += 1;
    return new Promise(resolve => { release = resolve; });
  });
  const settings = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fabricated-only' };
  const first = kb.enrichDocument(doc.id, settings);
  const duplicate = kb.enrichDocument(doc.id, settings);
  assert.equal(calls, 1);
  assert.equal(kb.listDocuments()[0].enrichStatus, 'pending');
  assert.equal(kb.kbStats().enriching, 1);
  release(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: doc.chunks.map((_chunk, i) => ({ i: i + 1, summary: `Summary ${i + 1}` })) }) } }] }), { status: 200 }));
  const [completed, shared] = await Promise.all([first, duplicate]);
  assert.deepEqual(shared, completed);
  assert.equal(completed.enrichStatus, 'done');
  assert.equal(completed.enrichedChunks, doc.chunks.length);
  assert.equal(kb.kbStats().enriching, 0);
  assert.deepEqual(kb.getDocument(doc.id).chunks.map(chunk => chunk.text), doc.chunks.map(chunk => chunk.text));
});

async function startApp(t, { plan = null } = {}) {
  const dir = await mkdtemp(join(scratch, 'app-'));
  await cp(source, dir, { recursive: true });
  const dataDir = join(dir, 'data');
  await mkdir(dataDir);
  if (plan) await writeFile(join(dataDir, 'plans.json'), JSON.stringify({ active: plan }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AVA_')) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  env.AVA_DATA_DIR = dataDir;
  const child = spawn(process.execPath, [join(dir, 'server.js'), '--host', '127.0.0.1', '--port', '0'], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  });
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`local server failed: ${errors}`);
    return /Ava ready at (http:\/\/127\.0\.0\.1:\d+)/.test(output);
  }, 'local server did not start', 4000);
  return { url: output.match(/Ava ready at (http:\/\/127\.0\.0\.1:\d+)/)[1], dataDir };
}
async function request(app, path, method = 'GET', body) {
  const response = await fetch(app.url + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(4000) });
  return { status: response.status, data: await response.json() };
}

test('saving a level updates the active plan only after settings validation succeeds', async (t) => {
  const { plans } = await modules(t);
  const original = readyPlan(plans);
  const app = await startApp(t, { plan: original });
  const rejected = await request(app, '/api/settings', 'PUT', { baseUrl: 'http://[', level: 'B1' });
  assert.equal(rejected.status, 400);
  assert.equal((await request(app, '/api/plan')).data.plan.level, 'A2');
  const saved = await request(app, '/api/settings', 'PUT', { level: 'B1' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.level, 'B1');
  const updated = (await request(app, '/api/plan')).data.plan;
  assert.equal(updated.level, 'B1');
  assert.equal(updated.lessons.lesson_1.done, true);
  assert.deepEqual(updated.lessons.lesson_1.phrases, original.lessons.lesson_1.phrases);
  assert.deepEqual(updated.lessons.lesson_2.phrases, original.lessons.lesson_2.phrases);
  assert.equal(updated.lessons.lesson_2.status, 'error', 'missing model key must leave an honest retryable error');
});

test('knowledge HTTP responses distinguish stored raw text from a failed enhancement', async (t) => {
  const app = await startApp(t);
  const added = await request(app, '/api/kb/save-text', 'POST', { name: 'Local text', text: 'Personal English practice material. '.repeat(20) });
  assert.equal(added.status, 200);
  assert.equal(added.data.doc.enrichStatus, 'stored');
  assert.doesNotMatch(added.data.message, /生成中|正在生成/);
  assert.equal((await request(app, '/api/kb/list')).data.stats.enriching, 0);
  const provider = http.createServer((req, res) => { req.resume(); res.writeHead(503); res.end('fabricated provider failure'); });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  await request(app, '/api/settings', 'PUT', { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fabricated-only' });
  const failed = await request(app, `/api/kb/${added.data.doc.id}/enrich`, 'POST', {});
  assert.equal(failed.data.ok, false);
  assert.equal(failed.data.enrichStatus, 'failed');
  assert.match(failed.data.error, /失败/);
  const retained = (await request(app, `/api/kb/${added.data.doc.id}`)).data.doc;
  assert.ok(retained.chunks.every(chunk => chunk.text));
});
