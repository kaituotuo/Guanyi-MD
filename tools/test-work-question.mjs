import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [appSource, indexSource, cssSource] = await Promise.all([
  readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../css/app.css', import.meta.url), 'utf8')
]);

const plannerStart = appSource.indexOf('  function normalizeWorkQuestion(');
const plannerEnd = appSource.indexOf('\n  async function planWorkRetrieval', plannerStart);
assert.ok(plannerStart >= 0 && plannerEnd > plannerStart, 'work retrieval planning helpers should be extractable');
const plannerHelpers = vm.runInNewContext(`(() => {
  const WORK_RETRIEVAL_QUERY_LIMIT = 5;
  const WORK_SCOPE_MANIFEST_LIMIT = 20;
  const WORK_EVIDENCE_LIMIT = 12;
  ${appSource.slice(plannerStart, plannerEnd)}
  return {
    normalizeWorkQuestion,
    discoverWorkEntityGroups,
    workEntityCombinationQueries,
    expandWorkRetrievalPlan,
    workEntityAliasAppears,
    filterWorkEvidenceForQuestion,
    localWorkRetrievalPlan,
    workScopeDocumentTitle,
    buildWorkScopeManifest,
    resolveWorkScopeDocumentIds,
    parseWorkRetrievalPlan
  };
})()`, {
  retrievalQueryVariants: (query) => [query, '人物 动机', '选择 后果'],
  normalizeCommentText: (value) => String(value || ''),
  currentReadingSelection: () => '',
  currentDoc: () => null,
  getCurrentMarkdown: () => '',
  headingPathAt: () => [],
  els: {},
  state: { currentDocId: null },
  documentSourceName: (doc) => doc?.relativePath || doc?.name || '',
  isPlainTextDocument: (doc) => /\.txt$/i.test(String(doc?.relativePath || doc?.name || '')),
  originalAnswerFingerprint: (value) => String(value).length,
  diversifyOriginalAnswerEvidence: (items, limit) => items.slice(0, limit)
});

assert.equal(plannerHelpers.normalizeWorkQuestion('  为什么\u0000人物\n行动  '), '为什么人物 行动');
assert.equal(plannerHelpers.localWorkRetrievalPlan('袭人的名字来历').route, 'direct');
assert.equal(plannerHelpers.localWorkRetrievalPlan('有没有其他作品写过类似的团队困境').route, 'analogy');
assert.equal(plannerHelpers.localWorkRetrievalPlan('用一句原文形容现在的情况').route, 'expression');
const planned = plannerHelpers.parseWorkRetrievalPlan({
  route: 'analogy',
  queries: ['权力冲突', '权力冲突', '人物选择', '制度约束', '资源变化', '超额表达']
}, '为什么一个枢纽城市会衰落');
assert.equal(planned.route, 'analogy');
assert.equal(planned.queries[0], '为什么一个枢纽城市会衰落');
assert.equal(planned.queries.length, 5, 'model query planning must remain bounded');

const scopedDocuments = [
  { id: 'three-kingdoms', name: '三国演义', relativePath: '私有书库/三国演义.txt', content: '不应发送的三国正文' },
  { id: 'red-chamber', name: '红楼梦', relativePath: '私有书库/红楼梦.txt', content: '不应发送的红楼正文' },
  { id: 'notes', name: '读书笔记', relativePath: '私人目录/读书笔记.md', content: '不应发送的笔记正文' }
];
const scopeManifest = plannerHelpers.buildWorkScopeManifest(
  '刘备什么时候萌生杀吕布的想法的',
  scopedDocuments,
  [{ docId: 'three-kingdoms', start: 10, end: 20 }],
  '当前文档列表'
);
assert.equal(scopeManifest.public.documents[0].title, '三国演义', 'local initial retrieval should prioritize the relevant work in the model scope');
assert.equal(scopeManifest.public.documents[0].id, 'D1', 'model scope should use opaque document ids');
assert.equal(scopeManifest.public.documents[0].type, 'txt');
const publicScopeJson = JSON.stringify(scopeManifest.public);
assert.doesNotMatch(publicScopeJson, /私有书库|私人目录|不应发送|content|relativePath/, 'model scope must not expose paths or document content');
assert.deepEqual(
  Array.from(plannerHelpers.resolveWorkScopeDocumentIds(scopeManifest, ['D1', 'D999', 'D1'])),
  ['three-kingdoms'],
  'only known opaque ids should resolve to local documents'
);
const scopedPlan = plannerHelpers.parseWorkRetrievalPlan({
  route: 'direct',
  queries: ['玄德 吕布 丁建阳 董卓'],
  targetDocumentIds: ['D1', 'D999'],
  facets: ['前期态度', '明确促杀', '前期态度']
}, '刘备什么时候萌生杀吕布的想法的', scopeManifest.public);
assert.deepEqual(Array.from(scopedPlan.targetDocumentIds), ['D1'], 'planner output must reject document ids outside the supplied scope');
assert.deepEqual(Array.from(scopedPlan.facets), ['前期态度', '明确促杀'], 'planner facets should be bounded and deduplicated');

const modelPlannerStart = appSource.indexOf('  async function planWorkRetrieval(');
const modelPlannerEnd = appSource.indexOf('\n  function workSearchResultFromSemantic', modelPlannerStart);
assert.ok(modelPlannerStart >= 0 && modelPlannerEnd > modelPlannerStart, 'scope-aware model planner should be extractable');
let capturedPlanningRequest = null;
const modelPlanner = vm.runInNewContext(`(() => {
  const WORK_PLANNER_TIMEOUT = 18000;
  ${appSource.slice(modelPlannerStart, modelPlannerEnd)}
  return { planWorkRetrieval };
})()`, {
  localWorkRetrievalPlan: plannerHelpers.localWorkRetrievalPlan,
  modelReady: () => true,
  requestModelWithRetry: async (messages, config, timeout, options) => {
    capturedPlanningRequest = { messages, config, timeout, options };
    return JSON.stringify({
      route: 'direct',
      queries: ['玄德 奉先 白门楼'],
      targetDocumentIds: ['D1', 'D999'],
      facets: ['前期冲突', '明确促杀']
    });
  },
  parseWorkRetrievalPlan: plannerHelpers.parseWorkRetrievalPlan,
  modelConfig: { model: 'scope-contract-test' }
});
const scopeRequestToken = { controller: new AbortController() };
const modelScopedPlan = await modelPlanner.planWorkRetrieval(
  '刘备什么时候萌生杀吕布的想法的',
  '当前阅读上下文',
  scopeManifest.public,
  scopeRequestToken
);
const planningPayload = JSON.parse(capturedPlanningRequest.messages[1].content);
assert.equal(JSON.stringify(planningPayload.availableDocumentScope), JSON.stringify(scopeManifest.public),
  'the model request should contain the bounded public document scope');
assert.doesNotMatch(capturedPlanningRequest.messages[1].content, /私有书库|私人目录|不应发送|three-kingdoms|red-chamber|relativePath|content/,
  'the actual planning request must not contain local paths, content or real document ids');
assert.deepEqual(Array.from(modelScopedPlan.targetDocumentIds), ['D1'],
  'the complete planner request/response path should discard unknown opaque ids');
assert.deepEqual(Array.from(modelScopedPlan.facets), ['前期冲突', '明确促杀']);

const romanceDocuments = [{
  id: 'three-kingdoms',
  content: '姓刘名备，字玄德。\n姓吕，名布，字奉先者也。\n\n布目视玄德曰：“是儿最无信者！”\n\n苦谏不从。韦康大开城门。'
}];
const entityGroups = plannerHelpers.discoverWorkEntityGroups('刘备什么时候萌生杀吕布的想法的？', romanceDocuments);
assert.deepEqual(Array.from(entityGroups, (group) => group.mentionedAlias), ['刘备', '吕布'],
  'direct relationship questions should discover the named people from corpus identity statements');
assert.ok(entityGroups.find((group) => group.mentionedAlias === '吕布').aliases.includes('奉先'),
  'identity statement suffixes such as 者也 must not leak into courtesy-name aliases');
const expandedPlan = plannerHelpers.expandWorkRetrievalPlan(
  { route: 'direct', queries: ['刘备杀吕布的动机'], source: 'rules' },
  '刘备什么时候萌生杀吕布的想法的？',
  romanceDocuments
);
assert.ok(expandedPlan.queries.some((query) => query.includes('玄德') && query.includes('奉先')),
  'retrieval expansion should include corpus aliases for every named person');
const filteredEvidence = plannerHelpers.filterWorkEvidenceForQuestion('刘备什么时候萌生杀吕布的想法的？', [
  { id: 'W1', quote: '布目视玄德曰：“是儿最无信者！”' },
  { id: 'W2', quote: '苦谏不从。韦康大开城门。' },
  { id: 'W3', quote: '刘备自领益州牧。' }
], romanceDocuments);
assert.equal(filteredEvidence.applied, true);
assert.deepEqual(Array.from(filteredEvidence.evidence, (item) => item.id), ['W1'],
  'a two-person question must reject evidence that does not contain both people or their aliases');
assert.equal(plannerHelpers.filterWorkEvidenceForQuestion('为什么一个枢纽城市会衰落', [{ id: 'W1', quote: '水路渐改。' }], romanceDocuments).applied, false,
  'generic semantic questions must not be constrained by unrelated character aliases');

const historyStart = appSource.indexOf('  function normalizeWorkHistory(');
const historyEnd = appSource.indexOf('\n  function diversifyOriginalAnswerEvidence', historyStart);
assert.ok(historyStart >= 0 && historyEnd > historyStart, 'work history normalizer should be extractable');
const historyHelpers = vm.runInNewContext(`(() => {
  const WORK_HISTORY_LIMIT = 20;
  ${appSource.slice(historyStart, historyEnd)}
  return { normalizeWorkHistory };
})()`, {
  normalizeWorkQuestion: (value) => String(value || '').trim(),
  originalAnswerFingerprint: (value) => `hash:${String(value).length}`,
  Date
});
const pendingHistory = historyHelpers.normalizeWorkHistory([{ id: 'work-1', question: '第一问', status: 'pending', evidence: [] }]);
assert.equal(pendingHistory[0].status, 'failed', 'an interrupted persisted request should become a recoverable failed history turn after restart');
assert.equal(historyHelpers.normalizeWorkHistory([{ id: 'work-1', question: '第一问', status: 'pending', evidence: [] }], { preservePending: true })[0].status, 'pending');
const boundedHistory = historyHelpers.normalizeWorkHistory(Array.from({ length: 25 }, (_, index) => ({ id: `work-${index}`, question: `问题${index}`, status: 'complete', evidence: [] })));
assert.equal(boundedHistory.length, 20, 'work conversation history should retain the latest 20 turns');
assert.equal(boundedHistory[0].question, '问题5');

const answerStart = appSource.indexOf('  function workEvidenceIsCurrent(');
const answerEnd = appSource.indexOf('\n  function workRouteLabel', answerStart);
assert.ok(answerStart >= 0 && answerEnd > answerStart, 'work answer validation helpers should be extractable');
const documentState = { docs: [{ id: 'red-chamber', content: '花气袭人知昼暖' }] };
const answerHelpers = vm.runInNewContext(`(() => {
  ${appSource.slice(answerStart, answerEnd)}
  return { workEvidenceIsCurrent, parseWorkAnswerResponse };
})()`, {
  state: documentState,
  originalAnswerFingerprint: (value) => `hash:${value}`
});
const evidence = [{
  id: 'W1', docId: 'red-chamber', title: '红楼梦', section: '第三回',
  quote: '花气袭人知昼暖', start: 0, end: 8, hash: 'hash:花气袭人知昼暖'
}];
const validated = answerHelpers.parseWorkAnswerResponse({
  supported: true,
  answer: '名字取自诗句。',
  evidence: [{ id: 'W1', quote: '模型伪造的原文', explanation: '编号对应的原文解释' }],
  confidence: 'high'
}, evidence, 'direct');
assert.equal(validated.evidence.length, 1);
assert.equal(validated.evidence[0].quote, '花气袭人知昼暖', 'rendered quotes must come from local evidence, not model output');
assert.equal(validated.evidence[0].explanation, '编号对应的原文解释');
assert.equal(answerHelpers.parseWorkAnswerResponse({ supported: true, answer: '无效', evidence: [{ id: 'W9' }] }, evidence).supported, false,
  'unknown evidence ids must fail closed');
documentState.docs[0].content = '原文已经变化';
assert.equal(answerHelpers.parseWorkAnswerResponse({ supported: true, answer: '过期', evidence: [{ id: 'W1' }] }, evidence).supported, false,
  'stale local evidence must not be exposed');

const retryStart = appSource.indexOf('  function isRetryableModelError(');
const retryEnd = appSource.indexOf('\n  async function testModelConnection', retryStart);
assert.ok(retryStart >= 0 && retryEnd > retryStart, 'model retry helpers should be extractable');
const retryHelpers = vm.runInNewContext(`(() => {
  const WORK_MODEL_MAX_ATTEMPTS = 2;
  ${appSource.slice(retryStart, retryEnd)}
  return { isRetryableModelError, requestModelWithRetry };
})()`, {
  requestModel: async () => '',
  setTimeout: (callback) => { callback(); return 1; }
});
let transientAttempts = 0;
const recovered = await retryHelpers.requestModelWithRetry([], {}, 1000, { attempts: 2 }, async () => {
  transientAttempts += 1;
  if (transientAttempts === 1) throw Object.assign(new Error('limited'), { status: 429 });
  return 'ok';
});
assert.equal(recovered, 'ok');
assert.equal(transientAttempts, 2, 'transient model failures should retry once');
let permanentAttempts = 0;
await assert.rejects(() => retryHelpers.requestModelWithRetry([], {}, 1000, { attempts: 2 }, async () => {
  permanentAttempts += 1;
  throw Object.assign(new Error('bad request'), { status: 400 });
}), /bad request/);
assert.equal(permanentAttempts, 1, 'permanent model failures must not be retried');

assert.match(appSource, /api\.search\(question, WORK_RETRIEVAL_RESULT_LIMIT, \{ docIds \}\)/,
  'work questions should immediately query the existing high-recall index');
assert.match(appSource, /ensureSemanticIndexSynced\(\)[\s\S]+retrieveWorkHighRecall/,
  'work questions should synchronize and reuse the existing semantic index');
assert.match(appSource, /Promise\.all\(\[worker\(\), worker\(\)\]\)/,
  'expanded retrieval should use bounded concurrency');
assert.match(appSource, /const localRetrievalPromise = retrieveWorkHighRecall[\s\S]+const modelPlanningPromise = modelReady\(\)[\s\S]+Promise\.all\(\[localRetrievalPromise, modelPlanningPromise\]\)/,
  'local retrieval and scope-aware model planning should run as independent parallel paths');
assert.match(appSource, /availableDocumentScope 只说明本地可搜索的作品范围，不是原文证据/,
  'the model planner must treat the document scope as routing metadata rather than evidence');
assert.match(appSource, /JSON\.stringify\(\{ question, currentContext: context \|\| '', availableDocumentScope \}\)/,
  'model planning should receive only the bounded public scope payload alongside the question context');
assert.match(appSource, /mergeWorkSearchChannels\(combinedChannels, 30, preferredDocIds\)/,
  'model-targeted documents should participate through soft fusion instead of hard filtering');
assert.match(appSource, /preferred\.has\(result\.docId\) \? WORK_MODEL_TARGET_BOOST : 1/,
  'preferred model targets should receive a bounded score boost');
assert.doesNotMatch(appSource, /api\.search\([^\n]+\{\s*docIds:\s*preferredDocIds\s*\}/,
  'model-targeted documents must not become a hard retrieval filter');
assert.match(appSource, /JSON\.stringify\(\{ route: plan\.route, question, currentContext: context \|\| '', evidence: candidates \}\)/,
  'model input should use a structured, bounded evidence payload');
assert.match(appSource, /evidence 只能填写已有编号，不要在 JSON 中复写 quote/,
  'model output contract must select evidence ids instead of generating quotes');
assert.match(appSource, /evidenceOnlyWorkAnswer\(question, evidence, plan\.route/,
  'model failure should degrade to local evidence instead of failing the whole request');
assert.match(appSource, /els\.readingQuestion\.value = '';/,
  'accepted work questions should clear the composer immediately');
const workInputHandler = appSource.slice(
  appSource.indexOf("els.readingQuestion.addEventListener('input'"),
  appSource.indexOf("els.readingQuestion.addEventListener('keydown'")
);
assert.doesNotMatch(workInputHandler, /controller\.abort\(/,
  'typing the next question must not cancel the accepted request');
assert.match(appSource, /workHistory:\s*normalizeWorkHistory\(state\.workHistory,\s*\{ preservePending: true \}\)/,
  'work conversation history should be included in the native state backup payload');
assert.match(appSource, /state\.workHistory\.forEach|history\.forEach\(\(answer\)/,
  'the work panel should render all retained turns instead of replacing the previous answer');
assert.match(appSource, /expandWorkRetrievalPlan\(plan, question, docs\)/,
  'high-recall retrieval should expand named people with corpus aliases');
assert.match(appSource, /mergeWorkEvidence\(retrieval\.results, localEvidence, question, docs, plan\.entityGroups\)/,
  'evidence should pass through question-aware entity consistency filtering');
assert.match(appSource, /必须区分原文明示与基于情节的推断/,
  'model answers should distinguish explicit source evidence from inference');

assert.match(indexSource, /class="app-reading-work__toolbar"[\s\S]+id="work-retrieval-state"[\s\S]+id="work-model-state"/,
  'work sidebar should expose retrieval and model state in a fixed toolbar');
assert.match(indexSource, /id="reading-work-thread"[\s\S]+id="reading-work-results"/,
  'work question results should live in an independently scrolling thread');
assert.match(indexSource, /id="reading-work-thread"[\s\S]+class="app-reading-work__footer"[\s\S]+id="reading-question"/,
  'the composer should remain after the scrolling thread');
assert.match(cssSource, /\.app-reading-work__toolbar\s*\{[\s\S]*?flex:\s*0 0 auto;/,
  'work sidebar toolbar should remain fixed');
assert.match(cssSource, /data-collab-content="works"\] \.app-reading-work\s*\{[\s\S]*?overflow-y:\s*auto;/,
  'work thread should scroll independently');

console.log('work question tests passed: multi-turn history, entity-aware evidence guards, high-recall routing, retry/degrade and chat sidebar verified');
