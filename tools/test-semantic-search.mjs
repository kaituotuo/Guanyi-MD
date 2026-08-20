import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, rm, stat } from 'node:fs/promises';
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
assert.notEqual(helperStart, -1, 'semantic hierarchy helpers should exist in js/app.js');
assert.notEqual(helperEnd, -1, 'semantic hierarchy helpers should end before semanticDocumentsForIndex');
assert.notEqual(sentenceBoundsStart, -1, 'keyword sentence-boundary helper should exist in js/app.js');

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
  meanNormalizedVector,
  recordId,
  semanticQueryTerms,
  matchedQueryTerms
} = require('../desktop/semantic-search.cjs');

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
assert.match(appSource, /SEMANTIC_CHUNKING_VERSION\s*=\s*3/);
assert.match(appSource, /contentFingerprint\(`\$\{SEMANTIC_CHUNKING_VERSION\}\\n/);

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
  }

  task() { return { taskUid: this.nextTask++ }; }
  version() { return Promise.resolve({ pkgVersion: '1.53.1-test' }); }
  createIndex() { return Promise.resolve(this.task()); }
  deleteIndex() { this.documents.clear(); return Promise.resolve(this.task()); }
  indexStats() { return Promise.resolve({ numberOfDocuments: this.documents.size }); }
  updateSettings(_uid, settings) { this.settings = settings; return Promise.resolve(this.task()); }
  addDocuments(_uid, documents) {
    this.addCalls += 1;
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
    const docId = JSON.parse(filter.slice(filter.indexOf('=') + 1).trim());
    for (const [id, document] of this.documents) {
      if (document.docId === docId) this.documents.delete(id);
    }
    return Promise.resolve(this.task());
  }
  waitTask(task) { return Promise.resolve({ ...task, status: 'succeeded' }); }
  search() { return Promise.resolve({ hits: structuredClone(this.searchHits) }); }
  multiSearch({ length }) {
    return Promise.resolve({ results: Array.from({ length }, (_value, index) => ({ hits: this.evidenceHits[index] ? [structuredClone(this.evidenceHits[index])] : [] })) });
  }
}

class FakeEngine {
  constructor(client) { this.client = client; this.disposed = false; }
  start() { return Promise.resolve(this.client); }
  dispose() { this.disposed = true; return Promise.resolve(); }
}

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
assert.equal(fakeSearchResults[0].matchedGranularity, 'chapter');

fakeClient.searchHits = [{ ...fakePassageRecord, _rankingScore: 0.81 }];
fakeClient.evidenceHits = [{ ...fakeSentenceRecords[0], _rankingScore: 0.76 }];
const fakePassageResults = await fakeService.search('长文中间的相关内容', 10);
assert.equal(fakePassageResults[0].matchedGranularity, 'passage');
assert.equal(fakePassageResults[0].start, fakeSentenceRecords[0].start, 'passage hits should resolve to exact sentence evidence');

await fakeService.indexDocuments([], { force: false });
assert.equal(fakeClient.documents.size, 0, 'removed documents should leave no stale Meilisearch records');
await fakeService.dispose();
assert.equal(fakeEngine.disposed, true);

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
  assert.ok(new Set(repeatedSentenceResults.filter((result) => result.docId === 'red-chamber').map((result) => result.start)).size >= 2, 'one document should return multiple sentence anchors');

  const naturalLanguageMatrix = [
    ['火烧博望坡', 'three-kingdoms', '四面芦苇一时火起'],
    ['诸葛亮五丈原', 'three-kingdoms', '五丈原军中病势沉重'],
    ['贾宝玉被嘲笑成呆雁', 'red-chamber', '神情如呆雁一般'],
    ['刘备伤心关羽去世', 'three-kingdoms', '放声大哭'],
    ['刘备称王', 'three-kingdoms', '即皇帝位']
  ];
  for (const [query, expectedDocId, expectedEvidence] of naturalLanguageMatrix) {
    const results = await realService.search(query, 12);
    assert.equal(results[0]?.docId, expectedDocId, `${query} should rank the expected book first`);
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
  assert.ok(headinglessResults.slice(0, 3).some((result) => result.snippet.includes('地磁感知')));

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
