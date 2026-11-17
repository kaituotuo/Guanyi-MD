import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function createWorkspaceModelSession(');
const end = source.indexOf('  async function readWorkspaceSources(', start);
assert.ok(start > 0 && end > start);
const defaultTimeout = Number(source.match(/const AI_GENERATION_TIMEOUT = (\d+);/)[1]);
assert.equal(defaultTimeout, 90000, 'Ordinary AI generation retains its 90-second default');
let active = { model: 'first-model', apiKey: 'test-only-key', baseUrl: 'https://example.invalid', models: ['first-model'] };
let reads = 0;
const calls = [];
const context = vm.createContext({
  AbortSignal, TextEncoder,
  resolveRequestModelConfig: async () => { reads++; return { ...active }; },
  normalizeModelConfig: value => ({ ...value, models: [...value.models] }),
  modelReady: value => Boolean(value.apiKey && value.model),
  AI_GENERATION_TIMEOUT: defaultTimeout,
  requestModelWithRetry: async (messages, config, timeout, options) => { calls.push({ messages, config, timeout, options }); return 'ok'; }
});
vm.runInContext(source.slice(start, end), context);

const controller = new AbortController();
const request = await context.createWorkspaceModelSession({ signal: controller.signal });
await request([{ role: 'user', content: 'first complete batch' }], { maxTokens: 8000, timeoutMs: 300000 });
active = { ...active, model: 'next-model', models: ['next-model'] };
await request([{ role: 'user', content: 'last complete batch' }], { timeoutMs: 600000 });
assert.equal(reads, 1, 'One action reads CC Switch/current model only once');
assert.equal(calls[0].config, calls[1].config, 'Every batch retains the same connection snapshot');
assert.equal(calls[1].config.model, 'first-model');
assert.equal(calls[0].options.maxTokens, 8000);
assert.equal(calls[0].timeout, 300000, 'Paper requests reach the transport with a full five-minute budget');
assert.equal(calls[1].timeout, 300000, 'Explicit longer budgets remain bounded at five minutes');
assert.equal(calls[0].options.attempts, 2, 'Paper reading retains the existing retry allowance');
await context.requestWorkspaceModel([{ role: 'user', content: 'next action' }]);
assert.equal(reads, 2);
assert.equal(calls[2].config.model, 'next-model', 'A later action follows the latest selected model');
assert.equal(calls[2].timeout, 90000, 'Requests without a paper timeout keep the ordinary AI default');
await request([{ role: 'user', content: 'short explicit request' }], { timeoutMs: 15000 });
assert.equal(calls[3].timeout, 15000, 'Explicit short timeouts remain unchanged');
controller.abort();
await assert.rejects(request([{ role: 'user', content: 'late batch' }], { timeoutMs: 300000 }), { name: 'AbortError' });
assert.equal(calls.length, 4, 'Cancelled action cannot issue a later batch');
console.log('PASS stable model session, five-minute request budget, unchanged normal default and cancellation');

// Exercise the PDF task's outer cancellation boundary with virtual time. This
// catches an older 120-second cap without waiting minutes or contacting a model.
const studySource = await readFile(new URL('../js/pdf-study.js', import.meta.url), 'utf8');
const studyStart = studySource.indexOf('    async function modelRequest(');
const studyEnd = studySource.indexOf('    function onProgress(', studyStart);
assert.ok(studyStart > 0 && studyEnd > studyStart);
function studyHarness() {
  const controller = new AbortController(), timers = new Map(), requests = [];
  let now = 0, serial = 0, finish, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const response = new Promise(resolve => { finish = resolve; });
  const context = vm.createContext({
    DOMException, taskController: controller, taskRequestSession: null,
    abortCheck: signal => signal?.throwIfAborted(),
    options: { request: (messages, settings) => { requests.push({ messages, settings }); markStarted(); return response; } },
    setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(studySource.slice(studyStart, studyEnd), context);
  return { context, controller, timers, requests, started, finish, advance(ms) {
    now += ms;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  } };
}
{
  const h = studyHarness();
  const pending = h.context.modelRequest([{ role: 'user', content: 'full paper' }], { timeoutMs: 300000 });
  await h.started;
  assert.equal(h.requests[0].settings.timeoutMs, 300000);
  assert.equal(h.requests[0].settings.signal, h.controller.signal);
  assert.equal([...h.timers.values()][0].at, 605000, 'Outer watchdog allows two full five-minute attempts and grace');
  h.advance(120001);
  assert.equal(h.controller.signal.aborted, false, 'Old two-minute boundary cannot cancel the task');
  h.advance(484998);
  assert.equal(h.controller.signal.aborted, false, 'Task remains alive until the full retry budget expires');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  h.advance(1);
  await rejected;
  assert.equal(h.controller.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  h.finish('late model response');
  await assert.rejects(pending, { name: 'AbortError' });
}
{
  const h = studyHarness();
  const pending = h.context.modelRequest([{ role: 'user', content: 'cancelled paper' }], { timeoutMs: 300000 });
  await h.started;
  h.controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.timers.size, 0, 'Manual cancellation immediately releases the long watchdog');
  h.finish('late model response');
  await assert.rejects(pending, { name: 'AbortError' });
}
{
  const h = studyHarness();
  const pending = h.context.modelRequest([{ role: 'user', content: 'ordinary request' }]);
  await h.started;
  assert.equal([...h.timers.values()][0].at, 185000, 'Unspecified PDF request budget keeps its existing default');
  h.finish('ok');
  assert.equal(await pending, 'ok');
  assert.equal(h.timers.size, 0, 'Successful requests release the watchdog');
}
console.log('PASS virtual-clock PDF watchdog, full retry allowance, immediate stop and ignored late response');
