import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const scopeStart = appSource.indexOf('function searchScopeDocumentIds(');
const scopeEnd = appSource.indexOf('\n  function documentsInSearchScope', scopeStart);
assert.notEqual(scopeStart, -1, 'search scope helper should exist');
assert.notEqual(scopeEnd, -1, 'search scope helper should have a stable boundary');
const searchScopeDocumentIds = vm.runInNewContext(`(${appSource.slice(scopeStart, scopeEnd)})`);
const scopedDocs = [
  { id: 'mine-a', sourceKind: 'browser' },
  { id: 'mine-b', sourceKind: 'browser', directoryId: null },
  { id: 'dir-a-1', sourceKind: 'directory-file', directoryId: 'dir-a' },
  { id: 'dir-a-2', sourceKind: 'directory-file', directoryId: 'dir-a' },
  { id: 'dir-b-1', sourceKind: 'directory-file', directoryId: 'dir-b' },
  { id: 'loose-a', sourceKind: 'local-file', desktopPath: '/books/a.md' },
  { id: 'loose-b', sourceKind: 'local-file', desktopPath: '/books/b.txt' },
  { id: 'loose-c', sourceKind: 'local-file' }
];
assert.deepEqual(
  [...searchScopeDocumentIds(scopedDocs, 'dir-a-1', 'list')],
  scopedDocs.map((doc) => doc.id),
  'document-list scope should include every document added to the editor regardless of source or directory'
);
assert.deepEqual([...searchScopeDocumentIds(scopedDocs, 'dir-a-1', 'document')], ['dir-a-1'], 'document scope should search only the open document');
assert.deepEqual(
  [...searchScopeDocumentIds(scopedDocs, 'missing-current-doc', 'list')],
  scopedDocs.map((doc) => doc.id),
  'document-list scope should remain available even when no document is currently open'
);
assert.deepEqual([...searchScopeDocumentIds(scopedDocs, 'missing-current-doc', 'document')], [], 'current-document scope should be empty when no document is open');
const helperStart = appSource.indexOf('function normalizedSearchTerms(');
const helperEnd = appSource.indexOf('\n  function searchNavigationForResult', helperStart);
assert.notEqual(helperStart, -1, 'normalizedSearchTerms should exist in js/app.js');
assert.notEqual(helperEnd, -1, 'search range helpers should end before searchNavigationForResult');
const { normalizedSearchTerms, resolveSearchSourceRange, searchResultAnchorRange } = vm.runInNewContext(
  `(() => { ${appSource.slice(helperStart, helperEnd)}; return { normalizedSearchTerms, resolveSearchSourceRange, searchResultAnchorRange }; })()`
);

assert.deepEqual(
  [...normalizedSearchTerms(['黄盖', '黄盖', '谁打了黄盖', '', ' 黄盖 '])],
  ['谁打了黄盖', '黄盖'],
  'highlight terms should be unique, trimmed and longest-first'
);

const threeKingdoms = [
  '第四十六回 用奇谋孔明借箭 献密计黄盖受刑',
  '',
  '周瑜大怒，喝令左右将黄盖拖翻，脊杖五十。黄盖受刑，乃苦肉计也。'
].join('\n');
const sentenceStart = threeKingdoms.indexOf('周瑜大怒');
const sentenceEnd = threeKingdoms.indexOf('。', sentenceStart) + 1;
const yellowCover = resolveSearchSourceRange(threeKingdoms, sentenceStart, sentenceEnd, ['谁打了黄盖', '黄盖']);
assert.equal(yellowCover.anchorStart, sentenceStart, 'sentence navigation should preserve the semantic anchor');
assert.equal(yellowCover.anchorEnd, sentenceEnd, 'sentence navigation should preserve the semantic evidence boundary');
assert.equal(yellowCover.start, threeKingdoms.indexOf('黄盖', sentenceStart), 'semantic navigation should select the evidence term');
assert.equal(threeKingdoms.slice(yellowCover.start, yellowCover.end), '黄盖');

const revisedDocument = '第一回\n\n旧段落。\n\n第二回\n\n周瑜大怒，喝令左右将黄盖拖翻，脊杖五十。';
const revisedAnchor = searchResultAnchorRange(revisedDocument, {
  start: 0,
  end: 4,
  quote: '周瑜大怒，喝令左右将黄盖拖翻，脊杖五十。'
});
assert.deepEqual(
  { start: revisedAnchor.anchorStart, end: revisedAnchor.anchorEnd, strategy: revisedAnchor.strategy },
  { start: revisedDocument.indexOf('周瑜大怒'), end: revisedDocument.length, strategy: 'quote' },
  'a stale semantic offset should be repaired from the exact evidence quote'
);

const snippetAnchor = searchResultAnchorRange(revisedDocument, {
  start: Number.NaN,
  end: Number.NaN,
  snippet: '…将黄盖拖翻，脊杖五十…'
});
assert.equal(revisedDocument.slice(snippetAnchor.anchorStart, snippetAnchor.anchorEnd), '将黄盖拖翻，脊杖五十');
assert.equal(snippetAnchor.strategy, 'snippet');

const phoenixSlope = '庞统行至落凤坡前，问此地名号。';
const exact = resolveSearchSourceRange(phoenixSlope, 0, phoenixSlope.length, ['落凤坡']);
assert.equal(phoenixSlope.slice(exact.start, exact.end), '落凤坡', 'keyword navigation should select the exact term');

const repeated = '袭人听后，宝玉又说起花气袭人的诗句。';
const firstEvidence = resolveSearchSourceRange(repeated, 0, repeated.length, ['花气袭人', '袭人']);
assert.equal(firstEvidence.start, 0, 'the first evidence inside the matched sentence should remain the primary location');
assert.equal(repeated.slice(firstEvidence.start, firstEvidence.end), '袭人');

const clamped = resolveSearchSourceRange('短文', -20, 999, ['不存在']);
assert.deepEqual(
  { anchorStart: clamped.anchorStart, anchorEnd: clamped.anchorEnd, start: clamped.start, end: clamped.end },
  { anchorStart: 0, anchorEnd: 2, start: 0, end: 2 },
  'invalid result offsets should be clamped to the current document'
);

const failureStart = appSource.indexOf('function semanticSearchFailureText(');
const failureEnd = appSource.indexOf('\n  function mergeSearchResults', failureStart);
assert.notEqual(failureStart, -1, 'semantic failure messages should be classified');
const semanticSearchFailureText = vm.runInNewContext(`(${appSource.slice(failureStart, failureEnd)})`);
assert.match(semanticSearchFailureText(new Error('本地语义模型缺失')), /模型不可用/);
assert.match(semanticSearchFailureText(new Error('本地 Meilisearch 启动失败')), /搜索服务启动失败/);
assert.match(semanticSearchFailureText(new Error('目录权限不足')), /目录需要重新授权/);

const cssSource = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const preloadSource = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
const semanticSource = await readFile(new URL('../desktop/semantic-search.cjs', import.meta.url), 'utf8');
assert.match(indexSource, /id="search-scope"[^>]+role="tablist"[^>]+aria-label="搜索范围"/, 'search modal should expose an accessible scope tablist');
assert.match(indexSource, /data-search-scope="list"[^>]+aria-selected="true"[^>]*>当前文档列表</, 'document-list scope should be selected by default');
assert.match(indexSource, /data-search-scope="document"[^>]+>当前打开文档</, 'current-document scope should be available');
assert.match(cssSource, /\.app-search-scope__tab\.is-active/, 'active search scope should have a visible selected state');
assert.match(appSource, /api\.search\(query, SEMANTIC_RESULT_LIMIT, semanticOptions\)/, 'semantic searches should receive the selected document scope');
assert.match(appSource, /defaultSearchScope: 'list'/,
  'search should default to the complete document list for a new installation');
assert.match(appSource, /function openSearchModal\([\s\S]*?searchScope = state\.settings\?\.defaultSearchScope === 'current' \? 'document' : 'list';[\s\S]*?updateSearchScopeTabs\(\)/,
  'each search session should honor the user-configured default scope');
assert.match(appSource, /let activeSearchQuery = '', lastSearchQuery = '', lastSearchResults = \[\], activeSearchNavigation = null;/, 'search should retain the latest query and result snapshot between modal sessions');
assert.match(appSource, /function openSearchModal\([\s\S]*?const rememberedQuery = lastSearchQuery\.trim\(\)[\s\S]*?els\.searchInput\.value = rememberedQuery;/, 'opening search should restore the latest query');
assert.match(appSource, /function openSearchModal\([\s\S]*?renderSearchResults\(rememberedResults/, 'opening search should restore cached results before refreshing');
assert.match(appSource, /function renderSearchResults\([\s\S]*?lastSearchResults = activeSearchResults\.map\(/, 'completed search results should update the retained result snapshot');
assert.match(appSource, /els\.searchInput\.addEventListener\('input', \(\) => \{[\s\S]*?lastSearchQuery = els\.searchInput\.value\.trim\(\);/, 'search input changes should update the retained query');
assert.match(appSource, /async function openSearchResultData\(result, query\) \{[\s\S]*?lastSearchQuery = String\(query \|\| els\.searchInput\.value \|\| ''\)\.trim\(\);/, 'clicking a result should retain the query used for navigation');
const locateWorkStart = appSource.indexOf('async function locateWorkEvidence(');
const locateWorkEnd = appSource.indexOf('\n  function appendWorkAnswerToCurrentDocument', locateWorkStart);
assert.notEqual(locateWorkStart, -1, 'work evidence locator should exist');
const locateWorkSource = appSource.slice(locateWorkStart, locateWorkEnd);
assert.match(locateWorkSource, /searchNavigationForResult\(/,
  'work evidence should reuse the search result navigation anchor repair');
assert.match(locateWorkSource, /activeSearchNavigation = navigation;/,
  'work evidence should activate cross-view preview highlighting');
assert.match(locateWorkSource, /locateSearchResult\(navigation(?:,\s*\{[^}]*silentPreviewFailure:\s*true[^}]*\})?\)/,
  'work evidence should scroll and select the repaired source range');
const previewLocatorStart = appSource.indexOf('function findPreviewTargetForQuote(');
const previewLocatorEnd = appSource.indexOf('\n  function flashReadingLocation', previewLocatorStart);
assert.notEqual(previewLocatorStart, -1, 'preview quote locator should exist');
assert.notEqual(previewLocatorEnd, -1, 'preview quote locator should have a stable boundary');
assert.match(
  appSource.slice(previewLocatorStart, previewLocatorEnd),
  /\.app-plain-text-line/,
  'TXT reading lines should be valid preview targets for search and work evidence navigation'
);
const locatorStart = appSource.indexOf('function locateSearchResult(');
const locatorEnd = appSource.indexOf('\n  async function openSearchResultData', locatorStart);
assert.notEqual(locatorStart, -1, 'search result locator should exist');
assert.notEqual(locatorEnd, -1, 'search result locator should have a stable boundary');
assert.match(
  appSource.slice(locatorStart, locatorEnd),
  /silentPreviewFailure/,
  'evidence navigation should be able to retry without showing an intermediate preview failure toast'
);
assert.match(
  appSource.slice(appSource.indexOf('async function locateWorkEvidence('), appSource.indexOf('\n  function appendWorkAnswerToCurrentDocument', appSource.indexOf('async function locateWorkEvidence('))),
  /locateSearchResult\(navigation, \{ silentPreviewFailure: true \}\)/,
  'work evidence navigation should fall back to quote location when the first preview target is not ready'
);
const normalizeTextStart = appSource.indexOf('function normalizeCommentText(');
const normalizeTextEnd = appSource.indexOf('\n  function reviewHash', normalizeTextStart);
const markdownToPlainStart = appSource.indexOf('function markdownToPlain(');
const markdownToPlainEnd = appSource.indexOf('\n  function sourceBlockBounds', markdownToPlainStart);
const quoteCandidatesStart = appSource.indexOf('function readingQuotePlainCandidates(');
const quoteCandidatesEnd = appSource.indexOf('\n  function flashReadingLocation', quoteCandidatesStart);
const txtPreviewLines = [
  { textContent: '第一回 测试' },
  { textContent: '周瑜大怒，喝令左右将黄盖拖翻，脊杖五十。' },
  { textContent: '第二回 测试' }
];
const findPreviewTargetForQuote = vm.runInNewContext(`(() => {
  ${appSource.slice(normalizeTextStart, normalizeTextEnd)}
  ${appSource.slice(markdownToPlainStart, markdownToPlainEnd)}
  ${appSource.slice(quoteCandidatesStart, quoteCandidatesEnd)}
  return findPreviewTargetForQuote;
})()`, {
  marked: undefined,
  els: { previewEditor: { querySelectorAll: () => txtPreviewLines } }
});
assert.equal(
  findPreviewTargetForQuote('周瑜大怒，喝令左右将黄盖拖翻，脊杖五十。'),
  txtPreviewLines[1],
  'TXT single-line evidence should resolve to its rendered reading line'
);
assert.equal(
  findPreviewTargetForQuote('周瑜大怒，喝令左右将黄盖拖翻，脊杖五十。\n第二回 测试'),
  txtPreviewLines[1],
  'TXT multi-line evidence should resolve to the first rendered line containing the evidence'
);
assert.match(preloadSource, /search: \(query, limit, options\).*\{ query, limit, options \}/, 'desktop bridge should forward semantic scope options');
assert.match(semanticSource, /docId IN \[\$\{scopedDocumentIds\.map\(meiliString\)\.join\(', '\)\}\]/, 'Meilisearch should filter candidates before ranking');
assert.match(cssSource, /mark\.app-search-match\.is-primary/, 'primary article highlight styling should exist');
assert.match(cssSource, /mark\.app-content-find-match\.is-primary/, 'find/replace primary highlight styling should exist');
const contentFindStart = appSource.indexOf('function contentFindMatches(');
const contentFindEnd = appSource.indexOf('\n  function clearContentFindHighlights', contentFindStart);
assert.notEqual(contentFindStart, -1, 'content find matcher should exist');
assert.notEqual(contentFindEnd, -1, 'content find matcher should end before highlight rendering');
const contentFindMatches = vm.runInNewContext(`(() => { ${appSource.slice(contentFindStart, contentFindEnd)}; return contentFindMatches; })()`);
const plainMatches = (text, query) => JSON.parse(JSON.stringify(contentFindMatches(text, query)));
assert.deepEqual(plainMatches('甲乙甲乙', '甲'), [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
assert.deepEqual(plainMatches('内容没有命中', '不存在'), []);
assert.deepEqual(plainMatches('Abc aBC', 'abc'), [{ start: 0, end: 3 }, { start: 4, end: 7 }], 'find should be case-insensitive');
const replaceFindStart = appSource.indexOf('function contentFindMatches(');
const replaceFindEnd = appSource.indexOf('\n  function clearContentFindHighlights', replaceFindStart);
const replaceContentMatches = vm.runInNewContext(`(() => { ${appSource.slice(replaceFindStart, replaceFindEnd)}; return replaceContentMatches; })()`);
assert.deepEqual(JSON.parse(JSON.stringify(replaceContentMatches('甲乙甲', '甲', '丙'))), { text: '丙乙丙', count: 2 });
assert.deepEqual(JSON.parse(JSON.stringify(replaceContentMatches('甲乙', '不存在', '丙'))), { text: '甲乙', count: 0 });
assert.match(indexSource, /id="btn-find-replace"[^>]+Ctrl\/Cmd\+F/, 'find/replace should be available from the editor toolbar');
assert.match(indexSource, /id="btn-content-replace-all"/, 'replace-all action should exist');
const findButtonIndex = indexSource.indexOf('id="btn-find-replace"');
const undoGroupStart = indexSource.indexOf('id="btn-undo"');
const undoGroupEnd = indexSource.indexOf('</div>', indexSource.indexOf('id="btn-redo"'));
const undoGroup = indexSource.slice(undoGroupStart, undoGroupEnd);
const horizontalRuleIndex = indexSource.indexOf('data-fmt="hr"');
const commentsIndex = indexSource.indexOf('id="btn-comments"');
assert.ok(!undoGroup.includes('btn-find-replace'), 'find/replace should not be placed in the undo/redo group');
assert.ok(findButtonIndex > horizontalRuleIndex, 'find/replace should follow the block-format controls');
assert.ok(findButtonIndex > undoGroupStart && findButtonIndex < commentsIndex, 'find/replace should sit between the separator and comments entry');
assert.match(indexSource, /id="content-find-empty"[^>]+role="status"/, 'find panel should include an accessible no-result status');
assert.match(appSource, /contentFindCount\.textContent = hasNoResults \? '无结果'/, 'find controls should expose an explicit no-result label');
assert.match(cssSource, /\.app-content-find-backdrop\s*\{[\s\S]*?align-items: flex-start;[\s\S]*?justify-content: flex-end;[\s\S]*?background: transparent;/, 'find panel should float below the toolbar on the right');
assert.match(cssSource, /\.app-content-find-modal\s*\{[\s\S]*?width: min\(400px, 100vw\);[\s\S]*?height: auto;[\s\S]*?border-radius: 8px;/, 'find panel should use a compact floating surface');
assert.match(cssSource, /\.app-content-find__input-wrap\.is-content-find-empty/, 'find input should provide visual no-result feedback');
assert.match(indexSource, /gicon-collapse-all[^\n]+M1\.5 3\.25h6\.75/, 'collapse icon should use the list-and-arrow design');
assert.match(indexSource, /gicon-expand-all[^\n]+M12 2\.5V13/, 'expand icon should use the list-and-arrow design');

console.log('search navigation tests passed: source anchors, evidence terms, find/replace matching, icon states and article highlights verified');
