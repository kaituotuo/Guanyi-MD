import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const reviewStart = appSource.indexOf('function normalizedReviewStatus(');
const reviewEnd = appSource.indexOf('\n  function updateSidecarState', reviewStart);
assert.notEqual(reviewStart, -1, 'review Markdown helpers should exist');
assert.notEqual(reviewEnd, -1, 'review Markdown helpers should have a stable boundary');

const review = {
  comments: [{
    id: 'comment-1', instruction: '改成更准确的表述', status: 'open',
    anchor: { selectedText: '原句', headingPath: ['第一章'] },
    relocation: { state: 'matched', strategy: 'saved-range' },
    createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z'
  }],
  sidecar: {}
};
const helpers = vm.runInNewContext(
  `(() => { ${appSource.slice(reviewStart, reviewEnd)}; return {
    normalizedReviewStatus, reviewMarkdown, parseReviewMarkdown,
    reviewMarkdownWithoutStatuses, mergeExternalReviewMarkdown, captureReviewMarkdownSnapshot
  }; })()`,
  {
    Date,
    reviewStateFor: () => review,
    documentFileName: () => '示例.md',
    reviewHash: (value) => `hash:${String(value || '').length}`
  }
);

const doc = { id: 'doc-1', content: '# 第一章\n\n原句' };
const initial = helpers.reviewMarkdown(doc);
assert.match(initial, /智能体仅可将每条批注的“状态”从“待处理”改为“已处理”/);
assert.match(initial, /## 待处理批注[\s\S]+- 状态：待处理/);
assert.match(initial, /## 已处理批注/);
assert.doesNotMatch(initial, /review\.json/i);

helpers.captureReviewMarkdownSnapshot(review, initial);
const externallyResolved = initial.replace('- 状态：待处理', '- 状态：已处理');
const mergeResult = helpers.mergeExternalReviewMarkdown(doc, externallyResolved);
assert.equal(mergeResult.ok, true);
assert.equal(mergeResult.changed, true);
assert.equal(review.comments[0].status, 'resolved');
assert.equal(review.comments[0].resolution.resolvedBy, 'agent');

review.comments.push({
  id: 'comment-2', instruction: '补充例子', status: 'open',
  anchor: { selectedText: '另一句', headingPath: ['第二章'] },
  relocation: { state: 'matched', strategy: 'saved-range' },
  createdAt: '2026-08-26T00:01:00.000Z', updatedAt: '2026-08-26T00:01:00.000Z'
});
assert.equal(helpers.mergeExternalReviewMarkdown(doc, externallyResolved).ok, true,
  'a status-only external change should merge while a newer local comment is pending');
assert.match(helpers.reviewMarkdown(doc), /comment-2/);
assert.equal(
  helpers.mergeExternalReviewMarkdown(doc, externallyResolved.replace('改成更准确的表述', '外部改写批注')).ok,
  false,
  'agents must not change review instructions'
);

const anchorStart = appSource.indexOf('function reviewAnchorOccurrences(');
const anchorEnd = appSource.indexOf('\n  function finalizeReviewAfterDocumentSave', anchorStart);
assert.notEqual(anchorStart, -1, 'review anchor reconciliation helpers should exist');
assert.notEqual(anchorEnd, -1, 'review anchor reconciliation helpers should have a stable boundary');
const anchorReview = {
  comments: [{
    id: 'comment-anchor', instruction: '处理原句', status: 'open',
    anchor: { selectedText: '需要修改的原句', selectedMarkdown: '需要修改的原句', prefix: '', suffix: '', headingPath: [], sourceRange: { start: 0, end: 7 } },
    relocation: { state: 'matched', strategy: 'saved-range' }, updatedAt: '2026-08-26T00:00:00.000Z'
  }], sidecar: {}
};
let persisted = 0;
const anchorHelpers = vm.runInNewContext(
  `(() => { ${appSource.slice(anchorStart, anchorEnd)}; return { resolveReviewAnchor, reconcileReviewCommentsWithDocument }; })()`,
  {
    Date,
    reviewStateFor: () => anchorReview,
    persistReviewStore: () => { persisted += 1; },
    normalizeCommentText: (value) => String(value || '').replace(/\s+/g, ' ').trim(),
    headingPathAt: () => [],
    markdownToPlain: (value) => String(value || '').replace(/[#*_~`>\[\]()-]/g, ' ').replace(/\s+/g, ' ').trim()
  }
);
assert.equal(anchorHelpers.resolveReviewAnchor('前文\n\n需要修改的原句\n\n后文', anchorReview.comments[0].anchor).state, 'matched');
assert.equal(anchorHelpers.resolveReviewAnchor('需要修改的原句\n\n需要修改的原句', { ...anchorReview.comments[0].anchor, sourceRange: null }).state, 'needs-confirmation');
assert.equal(anchorHelpers.reconcileReviewCommentsWithDocument({ id: 'doc-1', content: '原句已经被处理并删除' }), true);
assert.equal(anchorReview.comments[0].status, 'resolved');
assert.equal(anchorReview.comments[0].resolution.reason, 'source-edited');
assert.equal(persisted, 1);

assert.doesNotMatch(indexSource, /id="btn-download-review-json"|data-sidecar-format="json"|下载 JSON/);
assert.match(indexSource, /REVIEW\.md 是唯一协作文件/);
console.log('REVIEW.md status merge and source-resolution contracts: PASS');
