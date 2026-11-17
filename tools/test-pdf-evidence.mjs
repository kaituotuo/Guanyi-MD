import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const evidence = require('../js/pdf-evidence.js');
const textItem = (str, x, y, extra = {}) => ({ str, transform: [20, 0, 0, 20, x, y], width: str.length * 9, height: 20, fontName: 'font', hasEOL: true, ...extra });
const content = items => ({ items, styles: { font: { ascent: 0.8, descent: -0.2 } } });

test('PDF blocks retain source identity, native order and distinct repeated-text coordinates', () => {
  const record = evidence.blocksFromTextContent(content([
    textItem('The same words', 40, 720), textItem('The same words', 350, 720), textItem('Another paragraph', 40, 680)
  ]), { page: 3, pageLabel: 'ii', sourceHash: 'source-version', pageWidth: 612 });
  assert.equal(record.blocks.length, 3);
  assert.equal(record.blocks[0].text, record.blocks[1].text);
  assert.notEqual(record.blocks[0].id, record.blocks[1].id);
  assert.equal(record.blocks[0].pageLabel, 'ii');
  assert.deepEqual(record.blocks[0].rects[0], [40, 716, 166, 736]);
  assert.deepEqual(record.blocks.map(block => [block.itemStart, block.itemEnd]), [[0, 1], [1, 2], [2, 3]]);
  assert.match(record.warning, /多栏/);
  assert.equal(record.blocks[0].extractionStatus, 'needs_review');
  const nextVersion = evidence.blocksFromTextContent(content([textItem('The same words', 40, 720)]), { page: 3, sourceHash: 'new-version' });
  assert.notEqual(record.blocks[0].id, nextVersion.blocks[0].id);
});

test('rotated text items retain an unrotated PDF coordinate rectangle', () => {
  const rect = evidence.itemRect(textItem('Test', 0, 0, { transform: [0, 20, -20, 0, 400, 200], width: 80 }), { font: { ascent: 0.8, descent: -0.2 } });
  assert.deepEqual(rect, [384, 200, 404, 280]);
});

test('an empty native text layer is explicitly scanned; a short valid page is retained', () => {
  assert.equal(evidence.blocksFromTextContent(content([]), { page: 1, sourceHash: 'v1' }).scanned, true);
  assert.equal(evidence.blocksFromTextContent(content([textItem('Hi', 40, 720)]), { page: 1, sourceHash: 'v1' }).scanned, false);
});

test('bounded PDF collection reports its real coverage and never claims unprocessed pages', async () => {
  const pages = [];
  const pdf = {
    numPages: 3,
    getPageLabels: async () => ['i', 'ii', 'iii'],
    getPage: async page => { pages.push(page); return { view: [0, 0, 612, 792], getTextContent: async () => content(page === 2 ? [] : [textItem(`Page ${page}`, 40, 720)]) }; }
  };
  const result = await evidence.collectPdf(pdf, { sourceHash: 'v1', maxPages: 2 });
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(result.coverage.processedPages, [1, 2]);
  assert.deepEqual(result.coverage.scannedPages, [2]);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.evidence[0].pageLabel, 'i');
});

test('cancellation stops before any page work and restricted PDF text is not extracted', async () => {
  const controller = new AbortController(); controller.abort();
  let pageCalls = 0;
  const pdf = { numPages: 2, getPage: async () => { pageCalls += 1; } };
  await assert.rejects(evidence.extractPage(pdf, 1, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(pageCalls, 0);
  await assert.rejects(evidence.collectPdf({ ...pdf, getPermissions: async () => [4, 32] }, {}), /限制复制/);
  assert.equal(pageCalls, 0);
});

test('source identity is SHA-256 of exact bytes, independent from text normalization', async () => {
  const bytes = new TextEncoder().encode('%PDF-original-source');
  assert.equal(await evidence.hashBytes(bytes), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(evidence.normalizedText('ﬁrst\u00ad\n  word'), 'first word');
});
