import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultBookRoot = process.env.GUANYI_BOOK_ROOT || path.join(os.homedir(), 'Downloads', '文学名著');
const desktopStatePath = process.env.GUANYI_DESKTOP_STATE
  || path.join(os.homedir(), 'Library', 'Application Support', 'guanyi-md', 'state', 'editor-state-v1.json');
const redChamberPath = process.argv[2] || path.join(defaultBookRoot, '红楼梦.txt');
const threeKingdomsPath = process.argv[3] || path.join(defaultBookRoot, '三国演义.txt');
const luXunPath = process.argv[4] || path.join(defaultBookRoot, '鲁迅全集.txt');
const temporaryRoot = path.join(projectRoot, '.tmp-test', 'semantic-search-real-books');

const appSource = await readFile(path.join(projectRoot, 'js/app.js'), 'utf8');
const helperStart = appSource.indexOf('function plainTextSectionHeading(');
const helperEnd = appSource.indexOf('\n  async function semanticDocumentsForIndex', helperStart);
const sentenceBoundsStart = appSource.indexOf('function searchSentenceBounds(');
const sentenceBoundsEnd = appSource.indexOf('\n  function formatSearchRecency', sentenceBoundsStart);
assert.notEqual(helperStart, -1);
assert.notEqual(helperEnd, -1);
const { chunkMarkdownForSearch } = vm.runInNewContext(`(() => {
  const SEMANTIC_SENTENCE_MAX_LENGTH = 620;
  const SEMANTIC_MAX_UNITS_PER_DOCUMENT = 1000000;
  const SEMANTIC_PASSAGE_TARGET_LENGTH = 1000;
  const SEMANTIC_PASSAGE_MAX_LENGTH = 1800;
  const SEMANTIC_PASSAGE_MAX_PARAGRAPHS = 6;
  const SEMANTIC_PASSAGE_OVERLAP_PARAGRAPHS = 2;
  ${appSource.slice(sentenceBoundsStart, sentenceBoundsEnd)}
  ${appSource.slice(helperStart, helperEnd)}
  return { chunkMarkdownForSearch };
})()`);

const { SemanticSearchService } = require('../desktop/semantic-search.cjs');
const binaryPath = path.join(projectRoot, 'runtime', 'meilisearch', 'v1.53.1', 'mac-arm64', 'meilisearch');
const modelDir = path.join(projectRoot, 'models', 'bge-small-zh-v1.5');

let cachedDesktopState = null;
async function readBookContent(title, filePath) {
  try {
    return { content: await readFile(filePath, 'utf8'), source: filePath };
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOENT'].includes(error?.code)) throw error;
    cachedDesktopState ||= JSON.parse(await readFile(desktopStatePath, 'utf8'));
    const cached = cachedDesktopState.docs?.find((doc) => doc?.desktopPath === filePath || doc?.name === title);
    if (!cached || typeof cached.content !== 'string' || !cached.content.trim()) throw error;
    return { content: cached.content, source: `${desktopStatePath} (read-only cached document)` };
  }
}

async function loadBook(id, title, filePath) {
  const loaded = await readBookContent(title, filePath);
  const content = loaded.content.replace(/^\uFEFF/, '');
  const replacementRatio = (content.match(/\uFFFD/g) || []).length / Math.max(1, content.length);
  assert.ok(replacementRatio < 0.0001, `${title} is not valid UTF-8`);
  const units = chunkMarkdownForSearch(content).map((unit) => ({
    ...unit,
    semanticText: `${title}\n${path.basename(filePath)}\n${unit.semanticText}`.slice(0, 1600)
  }));
  assert.ok(units.some((unit) => unit.granularity === 'sentence'), `${title} has no searchable sentences`);
  return {
    document: {
      id,
      title,
      path: filePath,
      fingerprint: crypto.createHash('sha256').update(`real-books-v3\n${title}\n${content}`).digest('hex'),
      units
    },
    content,
    source: loaded.source
  };
}

function fixtureDocument(id, title, content) {
  const units = chunkMarkdownForSearch(content).map((unit) => ({
    ...unit,
    semanticText: `${title}\n${title}.md\n${unit.semanticText}`.slice(0, 1600)
  }));
  return {
    id,
    title,
    path: `${title}.md`,
    fingerprint: crypto.createHash('sha256').update(`fixture-v1\n${title}\n${content}`).digest('hex'),
    units
  };
}

if (process.env.GUANYI_REAL_BOOKS_RESET === '1') await rm(temporaryRoot, { recursive: true, force: true });
const books = await Promise.all([
  loadBook('real-red-chamber', '红楼梦', redChamberPath),
  loadBook('real-three-kingdoms', '三国演义', threeKingdomsPath),
  loadBook('real-lu-xun', '鲁迅全集', luXunPath)
]);
const queryEchoDocument = fixtureDocument('query-echo-design', '搜索功能验收记录', [
  '# 语义搜索用例',
  '',
  '测试用例：搜索“袭人的名字来历”，预期返回《红楼梦》原文。',
  '',
  '本文档仅记录用户问题、检索功能和返回结果，不是文学原文证据。'
].join('\n'));
const documents = [...books.map((book) => book.document), queryEchoDocument];
process.stdout.write(`Real-book units: ${documents.map((doc) => `${doc.title} ${doc.units.length}`).join(', ')}\n`);
process.stdout.write(`Read-only sources: ${books.map((book) => `${book.document.title}: ${book.source}`).join('; ')}\n`);

const progress = (event) => {
  if (event?.phase === 'indexing' && (event.completed === event.total || event.completed % 500 < 16)) {
    process.stdout.write(`${event.message}\n`);
  }
};
const service = new SemanticSearchService({ modelDir, binaryPath, dataDir: temporaryRoot });
try {
  await service.indexDocuments(documents, { force: process.env.GUANYI_REAL_BOOKS_RESET === '1' }, progress);
  const matrix = [
    { query: '袭人的名字来历', docId: 'real-red-chamber', evidence: /花气袭人|改名.{0,8}袭人|袭人.{0,12}名字/, maximumRank: 3 },
    { query: '谁打了黄盖', docId: 'real-three-kingdoms', evidence: /黄盖|苦肉/, maximumRank: 1 },
    { query: '火烧博望坡', docId: 'real-three-kingdoms', evidence: /博望坡|火起|放火/, maximumRank: 1 },
    { query: '不在沉默中爆发', docId: 'real-lu-xun', evidence: /不在沉默中爆发.{0,18}沉默中灭亡/, maximumRank: 1 },
    { query: '不再沉默中爆发', docId: 'real-lu-xun', evidence: /不在沉默中爆发.{0,18}沉默中灭亡/, maximumRank: 3 },
    { query: '沉默之中，不奋起便消亡', docId: 'real-lu-xun', evidence: /不在沉默中爆发.{0,18}沉默中灭亡/, maximumRank: 5 }
  ];
  for (const expected of matrix) {
    const results = await service.search(expected.query, 24);
    const evidenceRank = results.findIndex((result) => result.docId === expected.docId
      && expected.evidence.test(`${result.heading}\n${result.snippet}`));
    assert.ok(evidenceRank >= 0 && evidenceRank < expected.maximumRank,
      `${expected.query} should expose exact sentence evidence within top ${expected.maximumRank}: ${JSON.stringify(results.slice(0, 24))}`);
    if (expected.query === '袭人的名字来历') {
      const echoRank = results.findIndex((result) => result.docId === 'query-echo-design');
      assert.ok(echoRank < 0 || evidenceRank < echoRank, 'original naming evidence must rank ahead of a design document that repeats the query');
    }
    if (expected.query === '不再沉默中爆发') {
      assert.ok(results[evidenceRank].highlightTerms.includes('沉默中爆发'), 'the corrected stable fragment should be highlighted');
      assert.ok(results[evidenceRank].highlightTerms.includes('不'), 'the preserved negation should be highlighted');
    }
    process.stdout.write(`${expected.query}: #${evidenceRank + 1} ${results[evidenceRank].heading} | ${results[evidenceRank].snippet}\n`);
  }
  const workQuestion = '刘备什么时候萌生杀吕布的想法的';
  const workQueries = [workQuestion, '刘备 吕布', '玄德 奉先', '玄德 吕布', '刘备杀吕布的动机'];
  const workChannels = await Promise.all(workQueries.map(async (query) => ({ query, results: await service.search(query, 12) })));
  const workCandidates = workChannels.flatMap((channel) => channel.results.map((result, rank) => ({ ...result, query: channel.query, rank })));
  const whiteGate = workCandidates.find((result) => result.docId === 'real-three-kingdoms'
    && /公不见丁建阳|布目视玄德|大耳儿.*辕门射戟/.test(`${result.heading}\n${result.snippet}`));
  assert.ok(whiteGate,
    `multi-channel work retrieval should recall White Gate evidence: ${JSON.stringify(workChannels.map((channel) => ({ query: channel.query, top: channel.results.slice(0, 4) })))}`);
  const hasLiu = (text) => /刘备|玄德|备(?:曰|问|答|见|闻|听|从|劝|救|害|杀|缚|放|目|视)/.test(text);
  const hasLu = (text) => /吕布|奉先|布(?:曰|问|答|见|闻|听|从|劝|救|害|杀|缚|放|目|视)/.test(text);
  const entityConsistent = workCandidates.filter((result) => hasLiu(result.snippet) && hasLu(result.snippet));
  assert.ok(entityConsistent.some((result) => result.start === whiteGate.start), 'White Gate evidence should survive the two-person consistency gate');
  assert.ok(entityConsistent.every((result) => !/苦谏不从。韦康大开城门/.test(result.snippet)), 'the unrelated chapter 65 evidence must not survive the two-person consistency gate');
  process.stdout.write(`${workQuestion}: ${whiteGate.query} #${whiteGate.rank + 1} ${whiteGate.heading} | ${whiteGate.snippet}\n`);
  const stabilityKeys = (results) => results.slice(0, 10).map((result) => `${result.docId}:${result.start}:${result.end}`);
  const repeatedTimings = [];
  let stableTopTen = null;
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    const repeated = await service.search('沉默之中，不奋起便消亡', 24);
    repeatedTimings.push(performance.now() - startedAt);
    const keys = stabilityKeys(repeated);
    stableTopTen ||= keys;
    assert.deepEqual(keys, stableTopTen, 'the same query should keep a deterministic top 10 order');
    const passageKeys = repeated.slice(0, 10).map((result) => `${result.docId}:${result.passageId || result.start}`);
    assert.equal(new Set(passageKeys).size, passageKeys.length, 'one passage should appear at most once in the top 10');
  }
  const sortedTimings = [...repeatedTimings].sort((a, b) => a - b);
  const p95 = sortedTimings[Math.ceil(sortedTimings.length * 0.95) - 1];
  assert.ok(p95 <= 2500, `warm-search P95 should stay within 2.5 seconds, measured ${p95.toFixed(0)}ms`);
  process.stdout.write(`Warm search P95: ${p95.toFixed(0)}ms\n`);
  const status = await service.status();
  assert.equal(status.indexedDocuments, 4);
  assert.ok(status.indexedChunks > 1_000);
} finally {
  await service.dispose();
}

const restart = new SemanticSearchService({ modelDir, binaryPath, dataDir: temporaryRoot });
let repeatedEmbeddings = 0;
restart.embed = async () => { repeatedEmbeddings += 1; throw new Error('unchanged books must reuse persisted vectors'); };
try {
  await restart.indexDocuments(documents, { force: false });
  assert.equal(repeatedEmbeddings, 0, 'restarting the app must not rebuild unchanged full-book embeddings');
} finally {
  await restart.dispose();
}

process.stdout.write('Real three-book semantic matrix passed, including typo tolerance, paraphrase recall, deterministic ranking and persistent index reuse\n');
