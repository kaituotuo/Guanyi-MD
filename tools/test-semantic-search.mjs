import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = path.join(projectRoot, '.tmp-test', 'semantic-search');
await rm(temporaryRoot, { recursive: true, force: true });

const appSource = await readFile(path.join(projectRoot, 'js/app.js'), 'utf8');
const helperStart = appSource.indexOf('function plainTextSectionHeading(');
const helperEnd = appSource.indexOf('\n  async function semanticDocumentsForIndex', helperStart);
const sentenceBoundsStart = appSource.indexOf('function searchSentenceBounds(');
const sentenceBoundsEnd = appSource.indexOf('\n  function formatSearchRecency', sentenceBoundsStart);
const keywordHelperStart = appSource.indexOf('function searchTokens(');
const keywordHelperEnd = appSource.indexOf('\n  function searchSnippet', keywordHelperStart);
const resultMergeStart = appSource.indexOf('function mergeSearchResults(');
const resultMergeEnd = appSource.indexOf('\n  function originalAnswerFingerprint', resultMergeStart);
assert.notEqual(helperStart, -1, 'semantic hierarchy helpers should exist in js/app.js');
assert.notEqual(helperEnd, -1, 'semantic hierarchy helpers should end before semanticDocumentsForIndex');
assert.notEqual(sentenceBoundsStart, -1, 'keyword sentence-boundary helper should exist in js/app.js');
assert.notEqual(keywordHelperStart, -1, 'keyword tolerance helpers should exist in js/app.js');
assert.notEqual(resultMergeStart, -1, 'unified result rank fusion should exist in js/app.js');

const rendererSearchHelpers = vm.runInNewContext(`(() => {
  ${appSource.slice(keywordHelperStart, keywordHelperEnd)}
  return { retrievalQueryVariants, queryFragmentCoverage, searchQueryEchoPenalty, bestKeywordTextMatch };
})()`);
const { mergeSearchResults: mergeRendererSearchResults } = vm.runInNewContext(`(() => {
  const SEARCH_RESULT_LIMIT = 36;
  ${appSource.slice(resultMergeStart, resultMergeEnd)}
  return { mergeSearchResults };
})()`);

const {
  plainTextHeadingKind,
  sentenceRangesForSearch,
  searchSentenceBounds,
  chunkMarkdownForSearch
} = vm.runInNewContext(`(() => {
  const SEMANTIC_SENTENCE_MAX_LENGTH = 620;
  const SEMANTIC_MAX_UNITS_PER_DOCUMENT = 1000000;
  const SEMANTIC_PASSAGE_TARGET_LENGTH = 1000;
  const SEMANTIC_PASSAGE_MAX_LENGTH = 1800;
  const SEMANTIC_PASSAGE_MAX_PARAGRAPHS = 6;
  const SEMANTIC_PASSAGE_OVERLAP_PARAGRAPHS = 2;
  ${appSource.slice(sentenceBoundsStart, sentenceBoundsEnd)}
  ${appSource.slice(helperStart, helperEnd)}
  return { plainTextHeadingKind, sentenceRangesForSearch, searchSentenceBounds, chunkMarkdownForSearch };
})()`);

const {
  SemanticSearchService,
  INDEX_UID,
  EMBEDDER_NAME,
  MODEL_DIMENSIONS,
  EMBEDDING_BATCH_SIZE,
  DOCUMENT_BATCH_SIZE,
  ONNX_SESSION_OPTIONS,
  meanNormalizedVector,
  recordId,
  retrievalQueryVariants,
  semanticQueryTerms,
  semanticQueryText,
  matchedQueryTerms,
  queryFragmentCoverage,
  reciprocalRankFusion,
  textNgramSimilarity,
  diversifySearchResults,
  intentEvidenceScore,
  intentRetrievalVariants,
  queryEchoPenalty,
  toWellFormedText,
  clampText
} = require('../desktop/semantic-search.cjs');
const { MeilisearchProcess } = require('../desktop/meilisearch-process.cjs');

assert.equal(EMBEDDING_BATCH_SIZE, 8, 'native ONNX embedding batches must stay bounded');
assert.equal(DOCUMENT_BATCH_SIZE, 64, 'Meilisearch write batches must stay bounded');
assert.deepEqual(ONNX_SESSION_OPTIONS, {
  executionProviders: [{ name: 'cpu', useArena: false }],
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  executionMode: 'sequential',
  enableCpuMemArena: false,
  enableMemPattern: false,
  logSeverityLevel: 4
}, 'native ONNX runtime must use the bounded sequential CPU session');

assert.equal(plainTextHeadingKind('第四十六回 用奇谋孔明借箭'), 'chapter');
assert.equal(plainTextHeadingKind('第三节 人物关系'), 'section');
assert.equal(plainTextHeadingKind('第二部分 入城'), 'chapter');
assert.equal(plainTextHeadingKind('第二小节 线索'), 'section');
assert.equal(plainTextHeadingKind('第３章 全角编号'), 'chapter');
assert.equal(plainTextHeadingKind('第壹章 大写编号'), 'chapter');
assert.equal(plainTextHeadingKind('CHAPTER XII The Return'), 'chapter');
assert.equal(plainTextHeadingKind('Section 2 Evidence'), 'section');
assert.equal(plainTextHeadingKind('2.3 检索策略'), 'section');
assert.equal(plainTextHeadingKind('（一）索引策略'), 'section');
assert.equal(plainTextHeadingKind('一、故事开端'), 'chapter');
assert.equal(plainTextHeadingKind('序章 风起'), 'chapter');
assert.equal(plainTextHeadingKind('Epilogue'), 'chapter');
assert.equal(plainTextHeadingKind('2026年8月20日 工作记录'), '', 'dates should not become chapter headings');
assert.deepEqual(
  [...sentenceRangesForSearch('第一句。第二句！')].map((range) => '第一句。第二句！'.slice(range.start, range.end)),
  ['第一句。', '第二句！']
);
assert.deepEqual(
  { ...searchSentenceBounds('前一句。黄盖受刑，乃苦肉计也。后一句。', 4, 6) },
  { start: 4, end: 15 },
  'literal keyword hits should expand to the exact containing sentence'
);

const hierarchyFixture = [
  '第四十六回 用奇谋孔明借箭 献密计黄盖受刑',
  '',
  '周瑜传令。黄盖上前说话。',
  '',
  '第一节 受刑',
  '',
  '周瑜大怒，喝令左右将黄盖拖翻，脊杖五十。黄盖受刑，乃苦肉计也。'
].join('\n');
const hierarchyUnits = chunkMarkdownForSearch(hierarchyFixture);
const granularities = new Set(hierarchyUnits.map((unit) => unit.granularity));
assert.deepEqual([...granularities].sort(), ['chapter', 'paragraph', 'passage', 'section', 'sentence']);
const hierarchySentences = hierarchyUnits.filter((unit) => unit.granularity === 'sentence');
assert.equal(hierarchySentences.length, 4);
hierarchySentences.forEach((unit) => {
  assert.equal(hierarchyFixture.slice(unit.start, unit.end), unit.text, 'sentence offsets must select exact source text');
  assert.ok(unit.paragraphId && unit.chapterId && unit.sentenceId, 'sentence hierarchy ids must be complete');
});
assert.ok(
  hierarchySentences.find((unit) => unit.text.includes('黄盖上前'))?.semanticText.includes('周瑜传令'),
  'sentence embeddings should include adjacent sentence context'
);
const sectionUnit = hierarchyUnits.find((unit) => unit.granularity === 'section');
assert.ok(sectionUnit?.heading.includes('第四十六回') && sectionUnit.heading.includes('第一节'));
assert.ok(hierarchySentences.filter((unit) => unit.sectionId === sectionUnit.unitId).length >= 2);
const chapterUnit = hierarchyUnits.find((unit) => unit.granularity === 'chapter');
assert.ok(chapterUnit && hierarchySentences.every((unit) => unit.chapterId === chapterUnit.unitId));

const markdownUnits = chunkMarkdownForSearch('# 上卷\n\n## 第一节\n\n小节正文。\n\n### 其一\n\n更细正文。');
assert.ok(markdownUnits.some((unit) => unit.granularity === 'chapter' && unit.chapter === '上卷'));
assert.ok(markdownUnits.some((unit) => unit.granularity === 'section' && unit.section === '上卷 / 第一节'));
assert.ok(markdownUnits.some((unit) => unit.granularity === 'section' && unit.section === '上卷 / 第一节 / 其一'));

const numberedHeadingUnits = chunkMarkdownForSearch([
  '1. 结构起点',
  '',
  '这是第一部分的正文内容。',
  '',
  '1.1 检索范围',
  '',
  '这一小节说明应当如何选择文档。',
  '',
  'CHAPTER II Offline Search',
  '',
  'All vectors remain on the local computer.'
].join('\n'));
assert.ok(numberedHeadingUnits.some((unit) => unit.granularity === 'chapter' && unit.chapter === '1. 结构起点'));
assert.ok(numberedHeadingUnits.some((unit) => unit.granularity === 'section' && unit.section === '1. 结构起点 / 1.1 检索范围'));
assert.ok(numberedHeadingUnits.some((unit) => unit.granularity === 'chapter' && unit.chapter === 'CHAPTER II Offline Search'));

const setextUnits = chunkMarkdownForSearch([
  'Origins',
  '=======',
  '',
  'This paragraph explains where the project began.',
  '',
  'Details',
  '-------',
  '',
  'This paragraph contains the implementation details.'
].join('\n'));
assert.ok(setextUnits.some((unit) => unit.granularity === 'chapter' && unit.chapter === 'Origins'));
assert.ok(setextUnits.some((unit) => unit.granularity === 'section' && unit.section === 'Origins / Details'));
assert.ok(!setextUnits.some((unit) => unit.text === '=======' || unit.text === '-------'), 'setext underlines should not enter searchable text');

const implicitHeadingUnits = chunkMarkdownForSearch([
  '陌上初逢',
  '',
  '春日里两人在城外第一次相见，记下了彼此的名字。',
  '',
  '月下重逢',
  '',
  '入夜后他们再次在桥边见面，终于说清了当年的误会。'
].join('\n'));
assert.deepEqual(
  [...implicitHeadingUnits].filter((unit) => unit.granularity === 'chapter').map((unit) => unit.chapter),
  ['陌上初逢', '月下重逢'],
  'repeated isolated short titles should define plain-text chapter boundaries'
);

const listUnits = chunkMarkdownForSearch([
  '购物清单',
  '',
  '1. 苹果',
  '',
  '2. 香蕉',
  '',
  '3. 茶叶',
  '',
  '以上是今天需要购买的全部物品。'
].join('\n'));
assert.ok(!listUnits.some((unit) => unit.granularity === 'chapter' && /^[123]\./.test(unit.chapter)), 'consecutive numbered list items should remain body text');

const isolatedShortLineUnits = chunkMarkdownForSearch('风停了\n\n雨很快又落下来，街上的行人都加快了脚步。');
assert.ok(!isolatedShortLineUnits.some((unit) => unit.granularity === 'chapter' && unit.chapter === '风停了'), 'one isolated short sentence is not enough evidence for a heading');
assert.match(appSource, /SEMANTIC_CHUNKING_VERSION\s*=\s*4/);
assert.match(semanticQueryText('袭人的名字来历'), /本名.*改名.*更名.*起名/,
  'origin questions should expand to general naming evidence instead of a hard-coded character');
assert.match(semanticQueryText('谁打了黄盖'), /实施者是谁/,
  'actor questions should retain general action-role intent');
assert.match(semanticQueryText('刘关张情谊深厚'), /结义.*同生共死/,
  'relationship questions should expand to general affinity evidence');
assert.ok(semanticQueryTerms('刘关张情谊深厚').includes('结义'),
  'relationship evidence terms should contribute to result highlighting and lexical ranking');
assert.ok(retrievalQueryVariants('不再沉默中爆发').includes('沉默中爆发'),
  'a mistyped Chinese phrase should retain its longest stable substring as an independent recall query');
assert.ok(retrievalQueryVariants('不再沉默中爆发').includes('不'),
  'single-character negation should remain available as low-weight lexical evidence');
assert.ok(queryFragmentCoverage('不再沉默中爆发', '不在沉默中爆发，就在沉默中灭亡') > 0.68,
  'character, bigram and longest-fragment coverage should tolerate one wrong character');
assert.ok(rendererSearchHelpers.queryFragmentCoverage('不再沉默中爆发', '不在沉默中爆发，就在沉默中灭亡') > 0.68);
assert.deepEqual(
  Array.from(rendererSearchHelpers.bestKeywordTextMatch('不在沉默中爆发，就在沉默中灭亡', '不再沉默中爆发').terms.slice(0, 2)),
  ['沉默中爆发', '沉默中爆'],
  'renderer keyword search should expose stable fragments for red highlighting'
);
const rrfFixture = reciprocalRankFusion([
  { name: 'semantic', weight: 1, hits: [{ id: 'semantic-only' }, { id: 'shared' }] },
  { name: 'lexical', weight: 1.2, hits: [{ id: 'shared' }, { id: 'lexical-only' }] }
]);
assert.equal(rrfFixture[0].hit.id, 'shared', 'independent recall channels should be fused by rank instead of concatenated');
assert.ok(textNgramSimilarity('同一段重复内容', '同一段重复内容。') > 0.9);
assert.equal(diversifySearchResults([
  { docId: 'book', passageId: 'p1', snippet: '第一条证据', start: 1, score: 2 },
  { docId: 'book', passageId: 'p1', snippet: '同一段的另一句', start: 2, score: 1.9 },
  { docId: 'book', passageId: 'p2', snippet: '其他证据', start: 3, score: 1.8 }
], 10).length, 2, 'one passage should appear only once after diversification');
assert.equal(intentEvidenceScore('袭人的名字来历', '因她本姓花，便改名袭人。'), 1);
assert.ok(intentRetrievalVariants('袭人的名字来历').includes('袭人 诗云'),
  'naming-origin queries should add entity-plus-origin evidence channels');
assert.ok(intentEvidenceScore('袭人的名字来历', '袭人说宝玉给读书人起个名字叫作禄蠹。') < 0.6,
  'an unrelated naming action in a long sentence must not be treated as the entity origin');
assert.equal(queryEchoPenalty('袭人的名字来历', '测试用例：搜索袭人的名字来历应返回原文。'), 1);
assert.equal(rendererSearchHelpers.searchQueryEchoPenalty('袭人的名字来历', '测试用例：搜索袭人的名字来历应返回原文。'), 1);
const rendererFusedResults = mergeRendererSearchResults(
  [{ docId: 'query-echo', start: 1, end: 2, score: 95, echoPenalty: 1, fields: ['content'] }],
  [
    { docId: 'red-chamber', start: 10, end: 20, score: 3.2, echoPenalty: 0, fields: ['semantic'] },
    { docId: 'query-echo', start: 1, end: 2, score: 1.1, echoPenalty: 1, fields: ['semantic'] }
  ]
);
assert.equal(rendererFusedResults[0].docId, 'red-chamber',
  'renderer fusion must keep original evidence ahead of a keyword result that merely repeats the user query');
const overlappingEvidenceResults = mergeRendererSearchResults(
  [
    {
      docId: 'lu-xun', start: 100, end: 120, score: 89, fields: ['content'],
      snippet: '不在沉默中爆发，就在沉默中灭亡。', highlightTerms: ['不在沉默']
    },
    {
      docId: 'white-deer', start: 200, end: 240, score: 88, fields: ['content'],
      snippet: '在人群的沉默中，他站起来说话。', highlightTerms: ['沉默']
    }
  ],
  [{
    docId: 'lu-xun', start: 96, end: 126, score: 3.6, fields: ['semantic'],
    snippet: '……不在沉默中爆发，就在沉默中灭亡。五 但是……',
    section: '第110章 记念刘和珍君', granularity: 'sentence', paragraphId: 'lu-xun-p1'
  }]
);
assert.equal(overlappingEvidenceResults.filter((result) => result.docId === 'lu-xun').length, 1,
  'keyword and semantic ranges that point to the same source evidence must occupy one result row');
assert.deepEqual(Array.from(overlappingEvidenceResults.slice(0, 2), (result) => result.docId), ['lu-xun', 'white-deer'],
  'merging the duplicate top hit must keep the next distinct document visible in second place');
assert.equal(overlappingEvidenceResults[0].snippet, '不在沉默中爆发，就在沉默中灭亡。',
  'the result shown during keyword search should remain visually stable after semantic enrichment');
assert.equal(overlappingEvidenceResults[0].section, '第110章 记念刘和珍君',
  'semantic chapter context should enrich the retained keyword result');
assert.equal(mergeRendererSearchResults(
  Array.from({ length: 40 }, (_value, index) => ({
    docId: `keyword-${index}`, start: index * 10, end: index * 10 + 5, score: 100 - index, fields: ['content']
  })),
  []
).length, 36, 'the unified result list should expose at most 36 distinct rows');
assert.equal(mergeRendererSearchResults(
  [
    { docId: 'same-book', start: 10, end: 20, score: 90, fields: ['content'] },
    { docId: 'same-book', start: 40, end: 50, score: 80, fields: ['content'] }
  ],
  []
).length, 2, 'separate source ranges in the same document must remain independently discoverable');
assert.match(appSource, /function semanticDocumentFingerprint\([\s\S]+contentFingerprint\(`\$\{SEMANTIC_CHUNKING_VERSION\}\\n/);
assert.equal((appSource.match(/semanticDocumentFingerprint\(doc, content\)/g) || []).length, 3,
  'one versioned fingerprint helper must define, build and reuse semantic documents');
assert.doesNotMatch(appSource, /const fingerprint = contentFingerprint\(`\$\{doc\.id\}\\n/,
  'index reuse must not omit the semantic chunking version');
assert.match(appSource, /desktopApi && directory\?\.rootPath[\s\S]+desktopApi\.inspect\(directory\.rootPath\)/,
  'desktop directories must use their retained native path during semantic indexing');
assert.match(appSource, /desktopApi && directory\?\.rootPath && doc\.relativePath[\s\S]+readDesktopDirectoryEntry\(directory, doc\)/,
  'desktop directory documents must load content through their retained native path');
assert.match(appSource, /本地搜索服务启动失败，普通搜索仍可使用；诊断信息已记录/,
  'renderer should explain fallback behavior and confirm diagnostics');
assert.match(appSource, /const syncPromise = ensureSemanticIndexSynced\(\);[\s\S]+await api\.search\(query, SEMANTIC_RESULT_LIMIT, semanticOptions\)/,
  'scoped search should query the active index while synchronization continues in the background');

const headinglessLongArticle = chunkMarkdownForSearch(Array.from({ length: 12 }, (_value, index) =>
  `这是一段没有章节标题的通用长文章。第${index + 1}段记下不同的事实、观察和推理，用于验证多段语义检索。`).join('\n\n'));
const headinglessPassages = headinglessLongArticle.filter((unit) => unit.granularity === 'passage');
assert.ok(headinglessPassages.length >= 2, 'headingless long articles should receive several bounded passage units');
assert.ok(headinglessPassages.every((unit) => unit.passageId && unit.end > unit.start));
assert.ok(
  headinglessLongArticle.filter((unit) => unit.granularity === 'sentence').some((unit) => unit.passageIds.length > 1),
  'passage windows should overlap so boundary sentences retain context'
);
assert.equal(headinglessLongArticle.filter((unit) => unit.granularity === 'chapter').length, 1, 'headingless articles keep one root chapter only as a fallback container');

const lateChapters = Array.from({ length: 220 }, (_value, index) => [
  `第${index + 1}回 测试章节`,
  '',
  index === 219 ? '周瑜下令让军士杖打黄盖，用的是苦肉计。' : `这是第${index + 1}回的普通正文。`
].join('\n')).join('\n\n');
const lateUnits = chunkMarkdownForSearch(lateChapters);
assert.ok(lateUnits.some((unit) => unit.granularity === 'sentence' && unit.text.includes('黄盖')), 'late-book sentences must not be truncated');
assert.equal(lateUnits.filter((unit) => unit.granularity === 'chapter').length, 220);

function unitVector(index) {
  const vector = new Float32Array(MODEL_DIMENSIONS);
  vector[index % MODEL_DIMENSIONS] = 1;
  return vector;
}

const averaged = meanNormalizedVector([unitVector(0), unitVector(1)]);
assert.ok(Math.abs(averaged[0] - Math.SQRT1_2) < 1e-5);
assert.ok(Math.abs(averaged[1] - Math.SQRT1_2) < 1e-5);
assert.equal(recordId('book', 'sentence-1'), recordId('book', 'sentence-1'));
assert.notEqual(recordId('book', 'sentence-1'), recordId('book', 'sentence-2'));
const yellowCoverTerms = semanticQueryTerms('谁打了黄盖');
assert.ok(matchedQueryTerms(yellowCoverTerms, '周瑜命人杖打黄盖').includes('黄盖'));

class FakeMeilisearchClient {
  constructor() {
    this.nextTask = 1;
    this.documents = new Map();
    this.settings = null;
    this.addCalls = 0;
    this.deleteCalls = 0;
    this.searchHits = [];
    this.evidenceHits = [];
    this.lexicalHits = [];
    this.rejectedText = '';
    this.transientFailures = 0;
  }

  task() { return { taskUid: this.nextTask++ }; }
  version() { return Promise.resolve({ pkgVersion: '1.53.1-test' }); }
  createIndex() { return Promise.resolve(this.task()); }
  deleteIndex() { this.documents.clear(); return Promise.resolve(this.task()); }
  indexStats() { return Promise.resolve({ numberOfDocuments: this.documents.size }); }
  updateSettings(_uid, settings) { this.settings = settings; return Promise.resolve(this.task()); }
  addDocuments(_uid, documents) {
    this.addCalls += 1;
    if (this.transientFailures > 0) {
      this.transientFailures -= 1;
      const error = new Error('temporary service unavailable');
      error.status = 503;
      throw error;
    }
    if (this.rejectedText && documents.some((document) => document.text.includes(this.rejectedText))) {
      const error = new Error('The json payload provided is malformed: unexpected end of hex escape');
      error.name = 'MeilisearchHttpError';
      error.code = 'malformed_payload';
      throw error;
    }
    documents.forEach((document) => this.documents.set(document.id, structuredClone(document)));
    return Promise.resolve(this.task());
  }
  deleteDocuments(_uid, ids) {
    this.deleteCalls += 1;
    ids.forEach((id) => this.documents.delete(id));
    return Promise.resolve(this.task());
  }
  deleteDocumentsByFilter(_uid, filter) {
    this.deleteCalls += 1;
    const valueFor = (field) => {
      const match = String(filter).match(new RegExp(`${field}\\s*=\\s*("(?:\\\\.|[^"])*")`));
      return match ? JSON.parse(match[1]) : '';
    };
    const docId = valueFor('docId');
    const fingerprint = valueFor('fingerprint');
    const recordRevision = valueFor('recordRevision');
    for (const [id, document] of this.documents) {
      if (document.docId !== docId) continue;
      if (fingerprint && document.fingerprint !== fingerprint) continue;
      if (recordRevision && document.recordRevision !== recordRevision) continue;
      this.documents.delete(id);
    }
    return Promise.resolve(this.task());
  }
  waitTask(task) { return Promise.resolve({ ...task, status: 'succeeded' }); }
  search() { return Promise.resolve({ hits: structuredClone(this.searchHits) }); }
  multiSearch(queries) {
    const evidenceRequest = queries.some((query) => Array.isArray(query.vector));
    const source = evidenceRequest ? this.evidenceHits : this.lexicalHits;
    return Promise.resolve({ results: Array.from({ length: queries.length }, (_value, index) => ({ hits: source[index] ? [structuredClone(source[index])] : [] })) });
  }
}

class FakeEngine {
  constructor(client) { this.client = client; this.disposed = false; }
  start() { return Promise.resolve(this.client); }
  dispose() { this.disposed = true; return Promise.resolve(); }
}

const retryProcess = new MeilisearchProcess({
  binaryPath: path.join(projectRoot, 'package.json'),
  dataDir: path.join(temporaryRoot, 'retry-process'),
  startAttempts: 2
});
let retryAttempts = 0;
retryProcess.startAttempt = async (attempt) => {
  retryAttempts += 1;
  if (attempt === 1) throw new Error('transient startup failure');
  return { health: async () => ({ status: 'available' }) };
};
retryProcess.stopChild = async () => {};
retryProcess.writeDiagnostic = async () => {};
assert.ok(await retryProcess.start(), 'the second startup attempt should succeed');
assert.equal(retryAttempts, 2, 'Meilisearch startup must retry exactly once');
assert.equal(retryProcess.diagnosticStatus().lastError, null, 'a successful retry should clear the active error');
await retryProcess.dispose();

function semanticDocument(id, title, content, revision = 'v1') {
  const docPath = `${title}.md`;
  const units = chunkMarkdownForSearch(content).map((unit) => ({
    ...unit,
    semanticText: `${title}\n${docPath}\n${unit.semanticText}`.slice(0, 1600)
  }));
  return { id, title, path: docPath, fingerprint: `${id}-${revision}`, units };
}

const fakeClient = new FakeMeilisearchClient();
const fakeEngine = new FakeEngine(fakeClient);
const fakeService = new SemanticSearchService({
  modelDir: path.join(projectRoot, 'models', 'bge-small-zh-v1.5'),
  binaryPath: path.join(projectRoot, 'package.json'),
  dataDir: path.join(temporaryRoot, 'fake'),
  engine: fakeEngine
});
fakeService.embed = async (texts) => texts.map((_text, index) => unitVector(index));
assert.equal(toWellFormedText(`正常${String.fromCharCode(0xD83D)}文本`).includes(String.fromCharCode(0xD83D)), false,
  'lone surrogate code units must be repaired before JSON serialization');
const unicodeBoundary = `${'甲'.repeat(239)}😀尾`;
assert.equal(clampText(unicodeBoundary, 240).endsWith('😀'), true, 'text limits must count Unicode code points rather than UTF-16 code units');
assert.equal(clampText(unicodeBoundary, 240).isWellFormed(), true, 'clamped text must remain well formed');
const fakeDocument = semanticDocument('three-kingdoms', '三国演义', hierarchyFixture);
await fakeService.indexDocuments([fakeDocument], { force: true });
assert.equal(fakeClient.settings.embedders[EMBEDDER_NAME].source, 'userProvided');
assert.equal(fakeClient.settings.embedders[EMBEDDER_NAME].dimensions, MODEL_DIMENSIONS);
assert.ok(fakeClient.settings.filterableAttributes.includes('sentenceId') === false, 'sentenceId is an anchor, not a filter dimension');
assert.ok(fakeClient.settings.filterableAttributes.includes('passageIds'), 'passageIds should support overlapping sentence evidence lookup');
const fakeRecords = [...fakeClient.documents.values()];
assert.deepEqual([...new Set(fakeRecords.map((record) => record.granularity))].sort(), ['chapter', 'paragraph', 'passage', 'section', 'sentence']);
assert.ok(fakeRecords.every((record) => record._vectors[EMBEDDER_NAME].length === MODEL_DIMENSIONS));
const addCallsAfterFirstIndex = fakeClient.addCalls;
await fakeService.indexDocuments([fakeDocument], { force: false });
assert.equal(fakeClient.addCalls, addCallsAfterFirstIndex, 'unchanged documents should not be embedded or written again');
assert.equal((await fakeService.status()).indexedDocumentFingerprints['three-kingdoms'], fakeDocument.fingerprint);

const incrementalDocument = semanticDocument('incremental', '增量文档', '第一章 新增\n\n只应增量写入这一份文档。');
await fakeService.indexDocuments([incrementalDocument], { force: false, prune: false });
assert.ok([...fakeClient.documents.values()].some((record) => record.docId === 'three-kingdoms'), 'incremental indexing must preserve existing documents');
assert.ok([...fakeClient.documents.values()].some((record) => record.docId === 'incremental'));
await fakeService.indexDocuments([], { activeDocumentIds: ['three-kingdoms'], prune: true });
assert.ok([...fakeClient.documents.values()].every((record) => record.docId !== 'incremental'), 'manifest pruning should remove documents absent from the active list');

const updatedFakeDocument = semanticDocument('three-kingdoms', '三国演义', '第一回 新章\n\n更新后的句子。', 'v2');
await fakeService.indexDocuments([updatedFakeDocument], { force: false });
assert.ok(fakeClient.deleteCalls > 0, 'changed documents should delete stale records');
assert.ok([...fakeClient.documents.values()].every((record) => !record.text.includes('脊杖五十')));

const stableBeforeFailure = [...fakeClient.documents.values()]
  .filter((record) => record.docId === 'three-kingdoms')
  .map((record) => structuredClone(record));
fakeClient.rejectedText = '坏记录';
const failedUpdate = semanticDocument('three-kingdoms', '三国演义', '第一回 失败更新\n\n正常句子。坏记录。', 'v3');
const healthySibling = semanticDocument('healthy-sibling', '正常新增文档', '第一章 新增\n\n这份文档应继续完成索引。');
const partialStatus = await fakeService.indexDocuments([failedUpdate, healthySibling], { force: false, prune: false });
assert.equal(partialStatus.lastIndexRun.failedDocuments.length, 1, 'one malformed document should be isolated from the rest of the batch');
assert.equal((await fakeService.status()).indexedDocumentFingerprints['three-kingdoms'], updatedFakeDocument.fingerprint,
  'a failed update must keep the last successful fingerprint active');
assert.ok([...fakeClient.documents.values()].some((record) => record.docId === 'healthy-sibling'),
  'documents after one malformed document must continue indexing');
assert.deepEqual(
  [...fakeClient.documents.values()].filter((record) => record.docId === 'three-kingdoms').map((record) => record.text).sort(),
  stableBeforeFailure.map((record) => record.text).sort(),
  'all partial records from a failed revision must be removed while the old version stays searchable'
);
fakeClient.rejectedText = '';

fakeClient.transientFailures = 1;
const retryDocument = semanticDocument('transient-retry', '瞬时失败重试', '第一章 重试\n\n临时服务错误恢复后应自动完成。');
const retryAddCallsBefore = fakeClient.addCalls;
await fakeService.indexDocuments([retryDocument], { force: false, prune: false });
assert.ok(fakeClient.addCalls - retryAddCallsBefore >= 2, 'temporary Meilisearch failures should retry the same idempotent batch');
assert.ok([...fakeClient.documents.values()].some((record) => record.docId === 'transient-retry'),
  'a successful retry should activate the new document');

const throughputContent = Array.from({ length: 320 }, (_value, index) => `第${index + 1}条新文档句子，用于批量索引吞吐测试。`).join('\n\n');
const throughputDocument = semanticDocument('throughput', '批量吞吐测试', throughputContent);
const addCallsBeforeThroughput = fakeClient.addCalls;
await fakeService.indexDocuments([throughputDocument], { force: false, prune: false });
const throughputRecords = [...fakeClient.documents.values()].filter((record) => record.docId === 'throughput').length;
const throughputAddCalls = fakeClient.addCalls - addCallsBeforeThroughput;
assert.ok(throughputRecords / throughputAddCalls >= 45,
  `64-record batches should substantially reduce Meilisearch tasks: ${throughputRecords} records in ${throughputAddCalls} tasks`);

let signalIndexStarted;
let releaseIndexEmbedding;
const indexStarted = new Promise((resolve) => { signalIndexStarted = resolve; });
const indexEmbeddingGate = new Promise((resolve) => { releaseIndexEmbedding = resolve; });
fakeService.embed = async (texts, _progress, _completed, _total, mode = 'index') => {
  if (mode === 'index') {
    signalIndexStarted();
    await indexEmbeddingGate;
  }
  return texts.map((_text, index) => unitVector(index));
};
const backgroundIndex = fakeService.indexDocuments([
  semanticDocument('background-index', '后台索引', '第一章 后台\n\n建立索引时已有内容仍应可查。')
], { force: false, prune: false });
await indexStarted;
const searchDuringIndex = await Promise.race([
  fakeService.search('更新后的句子', 10),
  new Promise((_, reject) => setTimeout(() => reject(new Error('search waited for the complete background index')), 500))
]);
assert.ok(Array.isArray(searchDuringIndex), 'active-index search should remain available during background indexing');
releaseIndexEmbedding();
await backgroundIndex;
fakeService.embed = async (texts) => texts.map((_text, index) => unitVector(index));

const fakeSentenceRecords = [...fakeClient.documents.values()].filter((record) => record.granularity === 'sentence');
const fakeChapterRecord = [...fakeClient.documents.values()].find((record) => record.granularity === 'chapter');
const fakePassageRecord = [...fakeClient.documents.values()].find((record) => record.granularity === 'passage');
assert.match(fakeService.hierarchyFilter(fakePassageRecord), /passageIds = "passage-1"/);
fakeClient.searchHits = [
  { ...fakeSentenceRecords[0], _rankingScore: 0.72 },
  { ...fakeChapterRecord, _rankingScore: 0.88 }
];
fakeClient.evidenceHits = [{ ...fakeSentenceRecords[0], _rankingScore: 0.7 }];
const fakeSearchResults = await fakeService.search('更新了什么', 10);
assert.equal(fakeSearchResults.length, 1, 'hierarchy and direct hits for the same sentence should be deduplicated');
assert.equal(fakeSearchResults[0].start, fakeSentenceRecords[0].start);
assert.equal(fakeSearchResults[0].matchedGranularity, 'sentence',
  'direct child evidence should keep its own relevance instead of inheriting an averaged chapter score');

fakeClient.searchHits = [{ ...fakePassageRecord, _rankingScore: 0.81 }];
fakeClient.evidenceHits = [{ ...fakeSentenceRecords[0], _rankingScore: 0.76 }];
const fakePassageResults = await fakeService.search('长文中间的相关内容', 10);
assert.equal(fakePassageResults[0].matchedGranularity, 'passage');
assert.equal(fakePassageResults[0].start, fakeSentenceRecords[0].start, 'passage hits should resolve to exact sentence evidence');

await fakeService.indexDocuments([], { force: false });
assert.equal(fakeClient.documents.size, 0, 'removed documents should leave no stale Meilisearch records');
await fakeService.dispose();
assert.equal(fakeEngine.disposed, true);

const recoveryRoot = path.join(temporaryRoot, 'controlled-recovery');
const recoveryMetadata = path.join(recoveryRoot, 'guanyi-index-metadata.json');
await mkdir(recoveryRoot, { recursive: true });
await writeFile(recoveryMetadata, `${JSON.stringify({
  schemaVersion: 4,
  settingsVersion: 2,
  updatedAt: Date.now(),
  engineVersion: 'damaged-test',
  documents: { stale: { fingerprint: 'old', recordCount: 1, updatedAt: Date.now() } }
}, null, 2)}\n`);
class RecoveringFakeEngine extends FakeEngine {
  constructor(client) {
    super(client);
    this.startCalls = 0;
    this.recoveryCalls = 0;
  }
  async start() {
    this.startCalls += 1;
    if (this.startCalls === 1) {
      const error = new Error('database checksum corruption');
      error.code = 'MEILISEARCH_START_FAILED';
      error.recoverableDatabase = true;
      throw error;
    }
    return this.client;
  }
  async recoverDataDirectory() {
    this.recoveryCalls += 1;
    return { at: Date.now(), archivePath: 'meilisearch-db.recovery-test', suffix: 'test' };
  }
}
const recoveryClient = new FakeMeilisearchClient();
const recoveryEngine = new RecoveringFakeEngine(recoveryClient);
const recoveryService = new SemanticSearchService({
  modelDir: path.join(projectRoot, 'models', 'bge-small-zh-v1.5'),
  binaryPath: path.join(projectRoot, 'package.json'),
  dataDir: recoveryRoot,
  metadataFile: recoveryMetadata,
  engine: recoveryEngine
});
recoveryService.embed = async (texts) => texts.map((_text, index) => unitVector(index));
await recoveryService.indexDocuments([semanticDocument('recovered', '恢复测试', '第一章\n\n受控恢复后重新建立句子索引。')], { force: true });
assert.equal(recoveryEngine.recoveryCalls, 1, 'a confirmed database failure should trigger one controlled recovery');
assert.equal(recoveryEngine.startCalls, 2, 'the engine should restart after controlled recovery');
assert.ok((await readdir(recoveryRoot)).includes('guanyi-index-metadata.json.recovery-test'),
  'old metadata must be preserved beside the recovered index');
assert.equal((await recoveryService.status()).indexedDocuments, 1,
  'metadata and recovered database should describe the same rebuilt index');
await recoveryService.dispose();

const binaryPath = path.join(projectRoot, 'runtime', 'meilisearch', 'v1.53.1', 'mac-arm64', 'meilisearch');
const binaryStats = await stat(binaryPath);
assert.ok(binaryStats.size > 10_000_000, 'official Meilisearch binary should be completely downloaded before integration tests');

const realService = new SemanticSearchService({
  modelDir: path.join(projectRoot, 'models', 'bge-small-zh-v1.5'),
  binaryPath,
  dataDir: path.join(temporaryRoot, 'real')
});
const initialDocuments = [
  semanticDocument('three-kingdoms', '三国演义', [
    '第四十六回 用奇谋孔明借箭 献密计黄盖受刑',
    '',
    '周瑜大怒，喝令左右将黄盖拖翻，脊杖五十。黄盖受刑，乃苦肉计也。',
    '',
    '第三十九回 荆州城公子三求计 博望坡军师初用兵',
    '',
    '夏侯惇领兵追入博望坡，忽听一声炮响，四面芦苇一时火起，曹军大乱。',
    '',
    '第一百四回 陨大星汉丞相归天 见木像魏都督丧胆',
    '',
    '孔明积劳成疾，在五丈原军中病势沉重，夜观将星，自知命在旦夕。',
    '',
    '第七十七回 玉泉山关公显圣 洛阳城曹操感神',
    '',
    '汉中王听闻云长父子已经遇害，放声大哭，昏绝于地，众人急忙救醒。',
    '',
    '第八十回 曹丕废帝篡炎刘 汉王正位续大统',
    '',
    '群臣再三劝进，汉中王依礼在成都即皇帝位，改元章武。'
  ].join('\n')),
  semanticDocument('red-chamber', '红楼梦', [
    '第二十三回 西厢记妙词通戏语 牡丹亭艳曲警芳心',
    '',
    '宝玉说道：“古人有诗云，花气袭人知昼暖。因她本姓花，便改名袭人。”',
    '',
    '袭人听后，仍旧照料宝玉起居。',
    '',
    '宝玉听见众人取笑，只怔怔站在那里，神情如呆雁一般，半晌没有言语。'
  ].join('\n')),
  semanticDocument('astronomy', '天文笔记', '# 星空\n\n春夜观测星宿，记录月相和行星运行。')
];

try {
  await realService.indexDocuments(initialDocuments, { force: true });
  const status = await realService.status();
  assert.equal(status.engine, 'Meilisearch');
  assert.equal(status.engineVersion, '1.53.1');
  assert.equal(status.indexedDocuments, 3);
  assert.equal(realService.engine.client.host.hostname, '127.0.0.1', 'the search sidecar must only use loopback');
  const masterKeyPath = path.join(temporaryRoot, 'real', 'master-key');
  const masterKey = (await readFile(masterKeyPath, 'utf8')).trim();
  assert.equal((await stat(masterKeyPath)).mode & 0o777, 0o600, 'the local master key must be private on macOS');
  assert.ok(realService.engine.child.spawnargs.includes('--no-analytics'));
  assert.ok(!realService.engine.child.spawnargs.join(' ').includes(masterKey), 'the master key must not appear in process arguments');

  const yellowCoverResults = await realService.search('谁打了黄盖', 12);
  assert.equal(yellowCoverResults[0]?.docId, 'three-kingdoms');
  assert.ok(yellowCoverResults[0]?.heading.includes('第四十六回'));
  assert.ok(yellowCoverResults[0]?.highlightTerms.includes('黄盖'));
  assert.equal(initialDocuments[0].units.find((unit) => unit.start === yellowCoverResults[0].start)?.granularity, 'sentence');
  const excludedByScope = await realService.search('谁打了黄盖', 12, { docIds: ['red-chamber'] });
  assert.ok(excludedByScope.every((result) => result.docId === 'red-chamber'),
    'semantic scope should exclude documents outside the selected directory before ranking');
  const currentDocumentResults = await realService.search('谁打了黄盖', 12, { docIds: ['three-kingdoms'] });
  assert.ok(currentDocumentResults.length && currentDocumentResults.every((result) => result.docId === 'three-kingdoms'),
    'current-document semantic scope should return only the open document');

  const xirenResults = await realService.search('袭人的名字来历', 12);
  assert.equal(xirenResults[0]?.docId, 'red-chamber');
  assert.ok(xirenResults[0]?.snippet.includes('花气袭人') || xirenResults[0]?.snippet.includes('改名袭人'));
  assert.ok(xirenResults[0]?.highlightTerms.includes('袭人'));

  const firstEngineChild = realService.engine.child;
  await new Promise((resolve) => {
    firstEngineChild.once('exit', resolve);
    firstEngineChild.kill('SIGTERM');
  });
  const recoveredResults = await realService.search('谁打了黄盖', 12);
  assert.equal(recoveredResults[0]?.docId, 'three-kingdoms', 'semantic search should recover after the Meilisearch child exits');
  assert.notEqual(realService.engine.child, firstEngineChild, 'a failed local search process should be restarted');

  const exactSentenceResults = await realService.search('脊杖五十', 12);
  assert.equal(exactSentenceResults[0]?.docId, 'three-kingdoms');
  assert.ok(exactSentenceResults[0]?.snippet.includes('脊杖五十'));
  const repeatedSentenceResults = await realService.search('袭人', 12);
  const redChamberResults = repeatedSentenceResults.filter((result) => result.docId === 'red-chamber');
  assert.ok(redChamberResults.length >= 1, 'one document should still return its strongest sentence evidence');
  assert.equal(new Set(redChamberResults.map((result) => result.passageId)).size, redChamberResults.length,
    'the same passage should not occupy several result positions');

  const naturalLanguageMatrix = [
    ['火烧博望坡', 'three-kingdoms', '四面芦苇一时火起'],
    ['诸葛亮五丈原', 'three-kingdoms', '五丈原军中病势沉重'],
    ['贾宝玉被嘲笑成呆雁', 'red-chamber', '神情如呆雁一般'],
    ['刘备伤心关羽去世', 'three-kingdoms', '放声大哭'],
    ['刘备称王', 'three-kingdoms', '即皇帝位']
  ];
  for (const [query, expectedDocId, expectedEvidence] of naturalLanguageMatrix) {
    const results = await realService.search(query, 12);
    assert.equal(results[0]?.docId, expectedDocId,
      `${query} should rank the expected book first: ${JSON.stringify(results.slice(0, 5))}`);
    assert.ok(results.slice(0, 3).some((result) => result.snippet.includes(expectedEvidence)), `${query} should return its sentence evidence`);
  }

  const headinglessDocument = semanticDocument('headingless-article', '无标题长文', [
    '早春的河谷仍然寒冷，研究人员每天记录水温和风速。',
    '他们把不同测点的数据写入同一份观测日志，以便比较季节变化。',
    '迁徙候鸟在长距离飞行中会结合地标、太阳位置与地磁场判断方向。',
    '夜间看不清地标时，它们仍能借助地磁感知修正航线。',
    '沿途的湿地提供食物和休息地，也会影响群体选择的路径。',
    '抵达繁殖地后，观测人员再根据脚环信息核对它们的来源。',
    '夏季到来以后，河流水位上升，鱼类活动也变得更加频繁。',
    '这些连续记录最终用于分析气候与生态系统之间的关系。'
  ].join('\n\n'));
  assert.ok(headinglessDocument.units.filter((unit) => unit.granularity === 'passage').length >= 2);
  await realService.indexDocuments([...initialDocuments, headinglessDocument], { force: false });
  const headinglessResults = await realService.search('候鸟在夜间怎样找到迁徙方向', 12);
  assert.equal(headinglessResults[0]?.docId, 'headingless-article');
  assert.ok(headinglessResults.slice(0, 3).some((result) => result.snippet.includes('地磁')),
    `headingless query should expose magnetic navigation evidence: ${JSON.stringify(headinglessResults.slice(0, 5))}`);

  const beeDocument = semanticDocument('bee-notes', '蜂群观察', '# 蜂群协作\n\n工蜂通过舞蹈向同伴传递花源的方向和距离。');
  await realService.indexDocuments([...initialDocuments, beeDocument], { force: false });
  const beeResults = await realService.search('蜜蜂怎样告诉同伴花在哪里', 12);
  assert.equal(beeResults[0]?.docId, 'bee-notes');
  assert.ok(beeResults[0]?.snippet.includes('舞蹈'));

  const updatedBeeDocument = semanticDocument('bee-notes', '蜂群观察', '# 蜂群越冬\n\n冬季蜂群聚拢成团，通过振翅产热维持蜂巢温度。', 'v2');
  await realService.indexDocuments([...initialDocuments, updatedBeeDocument], { force: false });
  const winterResults = await realService.search('蜜蜂冬天怎样保暖', 12);
  assert.equal(winterResults[0]?.docId, 'bee-notes');
  assert.ok(winterResults[0]?.snippet.includes('振翅产热'));

  await realService.indexDocuments(initialDocuments, { force: false });
  assert.equal((await realService.status()).indexedDocuments, 3);
} finally {
  await realService.dispose();
}

const restartService = new SemanticSearchService({
  modelDir: path.join(projectRoot, 'models/bge-small-zh-v1.5'),
  binaryPath,
  dataDir: path.join(temporaryRoot, 'real')
});
restartService.embed = async () => { throw new Error('unchanged persistent indexes must not re-embed documents'); };
try {
  await restartService.indexDocuments(initialDocuments, { force: false });
  assert.equal((await restartService.status()).indexedDocuments, 3, 'a clean restart should reuse the persistent index');
} finally {
  await restartService.dispose();
}

console.log(`semantic search tests passed: ${hierarchySentences.length} exact sentences, ${lateUnits.length} long-book units, ${headinglessPassages.length} headingless passages, 6 user-query recalls, incremental Meilisearch lifecycle verified`);
