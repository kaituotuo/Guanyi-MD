import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = await readFile(path.join(projectRoot, 'js/app.js'), 'utf8');
const helperStart = appSource.indexOf('function plainTextSectionHeading(');
const helperEnd = appSource.indexOf('\n  async function semanticDocumentsForIndex', helperStart);
assert.notEqual(helperStart, -1, 'semantic chunk helpers should exist in js/app.js');
assert.notEqual(helperEnd, -1, 'semantic chunk helpers should end before semanticDocumentsForIndex');

const {
  plainTextHeadingKind,
  searchGranularityForBlock,
  chunkMarkdownForSearch
} = vm.runInNewContext(`(() => {
  const SEMANTIC_CHUNK_TARGET = 420;
  const SEMANTIC_CHUNK_OVERLAP = 80;
  const SEMANTIC_MAX_CHUNKS_PER_DOCUMENT = 4096;
  ${appSource.slice(helperStart, helperEnd)}
  return { plainTextHeadingKind, searchGranularityForBlock, chunkMarkdownForSearch };
})()`);

const {
  SemanticSearchService,
  MODEL_DIMENSIONS,
  aggregateDocumentEntries,
  semanticQueryTerms,
  matchedQueryTerms
} = require('../desktop/semantic-search.cjs');

assert.equal(plainTextHeadingKind('第四十六回 用奇谋孔明借箭'), 'chapter');
assert.equal(plainTextHeadingKind('第三节 人物关系'), 'section');
assert.equal(searchGranularityForBlock('只有一句话。', 1), 'sentence');
assert.equal(searchGranularityForBlock('第一句。第二句。', 1), 'paragraph');
assert.equal(searchGranularityForBlock('第一段。\n\n第二段。', 2), 'passage');

const hierarchyFixture = [
  '第四十六回 用奇谋孔明借箭 献密计黄盖受刑',
  '',
  '周瑜传令。',
  '',
  '黄盖上前说话。众将在旁观看。',
  '',
  '苦肉计由此开始。',
  '',
  '第一节 受刑',
  '',
  '周瑜大怒，喝令左右将黄盖拖翻，脊杖五十。',
  '',
  '黄盖受刑，乃苦肉计也。'
].join('\n');
const hierarchyChunks = chunkMarkdownForSearch(hierarchyFixture);
const granularities = new Set(hierarchyChunks.map((chunk) => chunk.granularity));
assert.ok(granularities.has('sentence'), 'single-sentence blocks should be indexed');
assert.ok(granularities.has('paragraph'), 'multi-sentence paragraphs should be indexed');
assert.ok(granularities.has('passage'), 'adjacent paragraphs should also form passage-level chunks');
assert.ok(
  hierarchyChunks.some((chunk) => chunk.chapter.startsWith('第四十六回') && !chunk.section),
  'a classical chapter should not be duplicated as a section'
);
assert.ok(
  hierarchyChunks.some((chunk) => chunk.section.includes('第四十六回') && chunk.section.includes('第一节')),
  'a classical section should retain its parent chapter path'
);

const markdownChunks = chunkMarkdownForSearch('# 上卷\n\n## 第一节\n\n小节正文。');
assert.equal(markdownChunks[0].chapter, '上卷');
assert.equal(markdownChunks[0].section, '上卷 / 第一节');

const lateChapters = Array.from({ length: 220 }, (_value, index) => [
  `第${index + 1}回 测试章节`,
  '',
  index === 219 ? '周瑜下令让军士杖打黄盖，用的是苦肉计。' : `这是第${index + 1}回的普通正文。`
].join('\n')).join('\n\n');
const lateChunks = chunkMarkdownForSearch(lateChapters);
assert.ok(lateChunks.length > 160, 'long books should retain content beyond the former 160-chunk limit');
assert.ok(lateChunks.some((chunk) => chunk.snippet.includes('黄盖')), 'late-book evidence should be indexed');

function unitVector(index) {
  const vector = new Float32Array(MODEL_DIMENSIONS);
  vector[index] = 1;
  return vector;
}

const aggregateDocument = { id: 'book', title: '测试书', path: '测试书.md' };
const aggregateBaseEntries = hierarchyChunks.map((chunk, index) => ({
  docId: aggregateDocument.id,
  title: aggregateDocument.title,
  path: aggregateDocument.path,
  chunkIndex: index,
  aggregate: false,
  lexicalText: chunk.text,
  vector: unitVector(index % 4),
  ...chunk
}));
const aggregates = aggregateDocumentEntries(aggregateDocument, aggregateBaseEntries);
const aggregateKinds = new Set(aggregates.map((entry) => entry.granularity));
assert.ok(aggregateKinds.has('section'), 'section vectors should be aggregated');
assert.ok(aggregateKinds.has('chapter'), 'chapter vectors should be aggregated');
assert.ok(aggregateKinds.has('document'), 'whole-book vectors should be aggregated');
assert.equal(
  aggregates.filter((entry) => entry.granularity === 'section' && entry.section.startsWith('第四十六回')).length,
  1,
  'chapter-only content should not create a duplicate section aggregate'
);

const mockService = new SemanticSearchService({ modelDir: '', indexFile: null });
mockService.indexLoaded = true;
mockService.embed = async () => [unitVector(0)];
mockService.index.entries = [
  {
    docId: 'mock-book', title: '模拟书', path: '模拟书.md', chunkIndex: 0,
    start: 120, end: 148, snippet: '具体的原文证据在这里。', heading: '第一章', chapter: '第一章', section: '',
    granularity: 'sentence', aggregate: false, lexicalText: '具体的原文证据在这里。', vector: unitVector(1)
  },
  {
    docId: 'mock-book', title: '模拟书', path: '模拟书.md', chunkIndex: -1,
    start: 120, end: 148, snippet: '', heading: '第一章', chapter: '第一章', section: '',
    granularity: 'chapter', aggregate: true, aggregateKind: 'chapter', aggregateValue: '第一章',
    lexicalText: '第一章', vector: unitVector(0)
  }
];
const [materializedAggregate] = await mockService.search('章节主题', 5);
assert.equal(materializedAggregate.matchedGranularity, 'chapter');
assert.equal(materializedAggregate.granularity, 'sentence');
assert.equal(materializedAggregate.start, 120, 'aggregate hits should return concrete evidence offsets');
assert.ok(materializedAggregate.snippet.includes('原文证据'));

const yellowCoverTerms = semanticQueryTerms('谁打了黄盖');
assert.ok(matchedQueryTerms(yellowCoverTerms, '周瑜命人杖打黄盖').includes('黄盖'));
const xirenTerms = semanticQueryTerms('袭人的名字来历');
assert.ok(matchedQueryTerms(xirenTerms, '花气袭人知昼暖').includes('袭人'));

function semanticDocument(id, title, content, revision = 'v1') {
  const chunks = chunkMarkdownForSearch(content).map((chunk) => ({
    ...chunk,
    text: `${title}\n${title}.md\n${chunk.text}`
  }));
  return { id, title, path: `${title}.md`, fingerprint: `${id}-fixture-${revision}`, chunks };
}

const realService = new SemanticSearchService({
  modelDir: path.join(projectRoot, 'models/bge-small-zh-v1.5'),
  indexFile: null
});
const initialDocuments = [
  semanticDocument('three-kingdoms', '三国演义', [
    '第四十六回 用奇谋孔明借箭 献密计黄盖受刑',
    '',
    '周瑜大怒，喝令左右将黄盖拖翻，脊杖五十。黄盖受刑，乃苦肉计也。'
  ].join('\n')),
  semanticDocument('red-chamber', '红楼梦', [
    '第二十三回 西厢记妙词通戏语 牡丹亭艳曲警芳心',
    '',
    '宝玉说道：“古人有诗云，花气袭人知昼暖。因她本姓花，便改名袭人。”'
  ].join('\n')),
  semanticDocument('astronomy', '天文笔记', '# 星空\n\n春夜观测星宿，记录月相和行星运行。')
];
try {
  await realService.indexDocuments(initialDocuments, { force: true });

  const yellowCoverResults = await realService.search('谁打了黄盖', 10);
  assert.equal(yellowCoverResults[0]?.docId, 'three-kingdoms');
  assert.ok(yellowCoverResults[0]?.heading.includes('第四十六回'));
  assert.ok(yellowCoverResults[0]?.highlightTerms.includes('黄盖'));

  const xirenResults = await realService.search('袭人的名字来历', 10);
  assert.equal(xirenResults[0]?.docId, 'red-chamber');
  assert.ok(xirenResults[0]?.heading.includes('第二十三回'));
  assert.ok(xirenResults[0]?.highlightTerms.includes('袭人'));

  const beeDocument = semanticDocument(
    'bee-notes',
    '蜂群观察',
    '# 蜂群协作\n\n工蜂通过舞蹈向同伴传递花源的方向和距离。'
  );
  await realService.indexDocuments([...initialDocuments, beeDocument], { force: false });
  const beeResults = await realService.search('蜜蜂怎样告诉同伴花在哪里', 10);
  assert.equal(beeResults[0]?.docId, 'bee-notes', 'a newly added, previously unseen document should be searchable');
  assert.ok(beeResults[0]?.snippet.includes('舞蹈'), 'semantic retrieval may match a paraphrase without inventing highlight text');
  assert.equal((await realService.status()).indexedDocuments, 4);

  const updatedBeeDocument = semanticDocument(
    'bee-notes',
    '蜂群观察',
    '# 蜂群越冬\n\n冬季蜂群聚拢成团，通过振翅产热维持蜂巢温度。',
    'v2'
  );
  await realService.indexDocuments([...initialDocuments, updatedBeeDocument], { force: false });
  const updatedBeeEntries = realService.index.entries.filter((entry) => entry.docId === 'bee-notes');
  assert.ok(updatedBeeEntries.some((entry) => entry.lexicalText?.includes('越冬')));
  assert.ok(updatedBeeEntries.every((entry) => !entry.lexicalText?.includes('舞蹈')), 'changed content should replace stale vectors');

  await realService.indexDocuments(initialDocuments, { force: false });
  assert.ok(realService.index.entries.every((entry) => entry.docId !== 'bee-notes'), 'removed documents should leave no stale vectors');
  assert.equal((await realService.status()).indexedDocuments, 3);
} finally {
  await realService.dispose();
}

console.log(`semantic search tests passed: ${lateChunks.length} long-book chunks, generic index lifecycle and real local model verified`);
