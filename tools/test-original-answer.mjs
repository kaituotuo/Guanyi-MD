import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');

const helperStart = appSource.indexOf('function originalAnswerFingerprint(');
const helperEnd = appSource.indexOf('\n  function originalAnswerEvidenceIsCurrent', helperStart);
assert.notEqual(helperStart, -1, 'original-answer evidence helpers should exist');
assert.notEqual(helperEnd, -1, 'original-answer helper boundary should exist');
const helpers = vm.runInNewContext(`(() => {
  const activeSearchQuery = '谁打了黄盖';
  const SAVED_ANSWER_LIMIT = 50;
  const SAVED_ANSWER_EVIDENCE_LIMIT = 5;
  const searchPathForDoc = (doc) => doc.path || doc.name;
  const resultHighlightTerms = (_query, result) => result.highlightTerms || [];
  const normalizedSearchTerms = (terms) => [...new Set((terms || []).map((term) => String(term || '').trim()).filter(Boolean))];
  ${appSource.slice(helperStart, helperEnd)}
  return {
    originalAnswerFingerprint,
    originalAnswerLabel,
    originalAnswerEvidence,
    parseOriginalAnswerPlan,
    parseOriginalRetrievalPlan,
    mergeOriginalAnswerCandidates,
    diversifyOriginalAnswerEvidence,
    normalizeSavedAnswer,
    normalizeSavedAnswers,
    originalAnswerMarkdown,
    insertMarkdownBlock
  };
})()`);

const text = '第四十六回\n\n  周瑜大怒，喝令左右将黄盖拖翻，脊杖五十。  \n\n后文。';
const sentenceStart = text.indexOf('  周瑜');
const sentenceEnd = text.indexOf('\n\n后文');
const docs = [{ id: 'three-kingdoms', name: '三国演义', path: '文库/三国演义.txt', content: text }];
const results = [
  { docId: 'three-kingdoms', start: sentenceStart, end: sentenceEnd, section: '第四十六回', highlightTerms: ['黄盖'] },
  { docId: 'three-kingdoms', start: sentenceStart, end: sentenceEnd, section: '重复结果' },
  { docId: 'missing', start: 0, end: 3 },
  { docId: 'three-kingdoms', start: -1, end: 3 }
];
const evidence = helpers.originalAnswerEvidence(results, docs);
assert.equal(evidence.length, 1, 'duplicate and invalid locations should not become answer evidence');
assert.equal(evidence[0].id, 'E1');
assert.equal(evidence[0].quote, '周瑜大怒，喝令左右将黄盖拖翻，脊杖五十。', 'evidence should be copied exactly from the located document range');
assert.equal(text.slice(evidence[0].start, evidence[0].end), evidence[0].quote, 'stored offsets should reproduce the exact quote');
assert.equal(evidence[0].hash, helpers.originalAnswerFingerprint(evidence[0].quote), 'quote hash should bind the evidence to its exact text');
assert.equal(evidence[0].resultIndex, 0, 'evidence should retain its source result order');
assert.equal(evidence[0].result.quote, evidence[0].quote, 'click navigation should carry the same verified quote, not a generated copy');

const plan = helpers.parseOriginalAnswerPlan('```json\n{"supported":true,"quoteIds":["E1","E9","E1"],"relation":"周瑜下令行刑。","confidence":"high","quote":"伪造原文"}\n```', evidence);
assert.deepEqual(JSON.parse(JSON.stringify(plan)), {
  supported: true,
  quoteIds: ['E1'],
  relation: '周瑜下令行刑。',
  confidence: 'high'
}, 'the model may select known IDs but cannot inject quote text or unknown evidence');

const refused = helpers.parseOriginalAnswerPlan({ supported: false, quoteIds: ['E1'], relation: '不应展示' }, evidence);
assert.deepEqual(JSON.parse(JSON.stringify(refused)), {
  supported: false,
  quoteIds: [],
  relation: '',
  confidence: 'medium'
}, 'insufficient evidence should produce a clean refusal');
assert.throws(() => helpers.parseOriginalAnswerPlan('not-json', evidence), /有效的证据计划/);

const retrievalPlan = helpers.parseOriginalRetrievalPlan({
  mode: 'analogy',
  queries: ['交通受阻 资源短缺 战略困境', '交通受阻 资源短缺 战略困境', '孤城 外援']
}, '为什么一个地方不被看好');
assert.deepEqual(JSON.parse(JSON.stringify(retrievalPlan)), {
  mode: 'analogy',
  queries: ['为什么一个地方不被看好', '交通受阻 资源短缺 战略困境', '孤城 外援']
}, 'analogy questions should expand into deduplicated literary-theme retrieval expressions');
const mergedCandidates = helpers.mergeOriginalAnswerCandidates(
  [{ docId: 'book', start: 1, end: 3, fields: ['semantic'], highlightTerms: ['困境'] }],
  [{ docId: 'book', start: 1, end: 3, fields: ['content'], highlightTerms: ['外援'] }]
);
assert.deepEqual([...mergedCandidates[0].fields].sort(), ['content', 'semantic']);
assert.deepEqual([...mergedCandidates[0].highlightTerms].sort(), ['困境', '外援']);

assert.equal(helpers.originalAnswerLabel('direct'), '原文直答');
assert.equal(helpers.originalAnswerLabel('analogy'), '原文类答');

const crossWorkEvidence = [
  { id: 'E1', docId: 'a', title: '三国演义', start: 0, end: 2, quote: '甲乙', hash: helpers.originalAnswerFingerprint('甲乙') },
  { id: 'E2', docId: 'a', title: '三国演义', start: 3, end: 5, quote: '丙丁', hash: helpers.originalAnswerFingerprint('丙丁') },
  { id: 'E3', docId: 'b', title: '红楼梦', start: 0, end: 2, quote: '戊己', hash: helpers.originalAnswerFingerprint('戊己') },
  { id: 'E4', docId: 'c', title: '水浒传', start: 0, end: 2, quote: '庚辛', hash: helpers.originalAnswerFingerprint('庚辛') }
];
assert.deepEqual(
  JSON.parse(JSON.stringify(helpers.diversifyOriginalAnswerEvidence(crossWorkEvidence).map((item) => item.id))),
  ['E1', 'E3', 'E4', 'E2'],
  'candidate ordering should expose distinct works before repeated passages from one work'
);

const savedAnswer = helpers.normalizeSavedAnswer({
  query: ' 为什么一个枢纽城市会衰落\n',
  answerType: 'analogy',
  relation: ' 文学类比：交通、资源与外援共同变化。 ',
  evidence: crossWorkEvidence
});
assert.ok(savedAnswer.id.startsWith('answer-'));
assert.equal(savedAnswer.query, '为什么一个枢纽城市会衰落');
assert.equal(savedAnswer.answerType, 'analogy');
assert.equal(savedAnswer.evidence.length, 4);
assert.equal(helpers.normalizeSavedAnswers([savedAnswer, savedAnswer]).length, 1, 'favorites should deduplicate by stable answer id');
assert.equal(helpers.normalizeSavedAnswer({ query: '空答案', evidence: [] }), null, 'favorites without verifiable citations should be rejected');

const answerMarkdown = helpers.originalAnswerMarkdown(savedAnswer);
assert.match(answerMarkdown, /^## 原文类答：为什么一个枢纽城市会衰落/m);
assert.match(answerMarkdown, /关联说明（AI）：文学类比：交通、资源与外援共同变化。/);
assert.match(answerMarkdown, /> 甲乙\n\n——《三国演义》/);
assert.match(answerMarkdown, /> 戊己\n\n——《红楼梦》/);

const insertedMiddle = helpers.insertMarkdownBlock('前文。\n后文。', 3, answerMarkdown);
assert.equal(insertedMiddle.text.startsWith('前文。\n\n## 原文类答'), true, 'append action should insert a block at the captured source caret');
assert.equal(insertedMiddle.text.endsWith('\n\n后文。'), true, 'insertion should preserve following document content');
assert.equal(insertedMiddle.text.slice(insertedMiddle.start, insertedMiddle.caret), answerMarkdown, 'caret range should cover the exact inserted answer');
const insertedEnd = helpers.insertMarkdownBlock('正文', 999, answerMarkdown);
assert.equal(insertedEnd.text, `正文\n\n${answerMarkdown}`, 'unsafe or unavailable selection should append after the current document');

assert.match(indexSource, /id="btn-search-docs"[^>]+Ctrl\/Cmd\+Shift\+F/, 'library search should retain Cmd/Ctrl+Shift+F');
assert.match(indexSource, /id="btn-save"[^>]+Ctrl\/Cmd\+S/, 'Cmd/Ctrl+S should remain reserved for saving');
assert.match(indexSource, /id="btn-original-answer"[^>]+Ctrl\/Cmd\+Enter/, 'original answer should expose a non-conflicting shortcut');
assert.match(indexSource, /id="original-answer-panel"[^>]+hidden/, 'original answer should appear inside the unified search panel on demand');
assert.match(indexSource, /id="btn-original-answer-favorite"[^>]+aria-pressed="false"/, 'final answers should expose a favorite toggle');
assert.match(indexSource, /id="btn-original-answer-copy"/, 'final answers should expose citation copy');
assert.match(indexSource, /id="btn-original-answer-append"/, 'final answers should append into the current document');
assert.match(indexSource, /id="saved-answers-panel"[^>]+hidden/, 'saved answers should have a dedicated viewing surface');
assert.match(appSource, /keywordSearchDocuments\(query, token, scopedDocuments\)[\s\S]+api\.search\(query, SEMANTIC_RESULT_LIMIT, semanticOptions\)/, 'scoped full-text and semantic retrieval should still run before original answer');
assert.match(appSource, /btnOriginalAnswer\?\.addEventListener\('click', generateOriginalAnswer\)/, 'answer generation must require an explicit user action');
assert.match(appSource, /event\.key === 'Enter' && \(event\.ctrlKey \|\| event\.metaKey\)[\s\S]+generateOriginalAnswer\(\)/, 'Cmd/Ctrl+Enter should generate the original answer');
assert.match(appSource, /retrievalSystem[\s\S]+parseOriginalRetrievalPlan[\s\S]+expandedOriginalAnswerResults/, 'original answer should plan direct or analogy retrieval before selecting evidence');
assert.match(appSource, /expandedOriginalAnswerResults[\s\S]+api\.search\(query, 10, semanticOptions\)/, 'literary-theme expansions should reuse the scoped semantic-search API without replacing it');
assert.match(appSource, /analogy 模式在确有相关候选时，优先选择来自 2 至 4 部不同作品/, 'analogy selection should prefer complementary evidence across works');
assert.match(appSource, /state\.savedAnswers = normalizeSavedAnswers\(saved\.savedAnswers\)/, 'favorites should migrate through the shared persisted state');
assert.match(appSource, /savedAnswers: normalizeSavedAnswers\(state\.savedAnswers\)/, 'favorites should be included in browser and desktop state backups');
assert.match(appSource, /setCurrentMarkdown\(result\.text, \{ sourceSelection:/, 'append should use the editor history and render pipeline');
assert.match(appSource, /quote === item\.quote && originalAnswerFingerprint\(quote\) === item\.hash/, 'quotes must be revalidated before rendering');
assert.match(cssSource, /\.app-original-answer__relation::before\s*\{[\s\S]*关联说明（AI）/, 'generated explanation must be visibly separated from original quotes');
assert.match(cssSource, /\.app-original-answer__quote mark\s*\{[\s\S]*rgba\(239, 62, 35, \.14\)/, 'answer keywords should use the same cinnabar highlight family as search results');

console.log('original-answer tests passed: direct/analogy, cross-work evidence, favorites, citation copy, append and stale-evidence guards verified');
