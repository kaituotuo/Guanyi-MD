import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const helperStart = appSource.indexOf('function normalizedSearchTerms(');
const helperEnd = appSource.indexOf('\n  function searchNavigationForResult', helperStart);
assert.notEqual(helperStart, -1, 'normalizedSearchTerms should exist in js/app.js');
assert.notEqual(helperEnd, -1, 'search range helpers should end before searchNavigationForResult');
const { normalizedSearchTerms, resolveSearchSourceRange } = vm.runInNewContext(
  `(() => { ${appSource.slice(helperStart, helperEnd)}; return { normalizedSearchTerms, resolveSearchSourceRange }; })()`
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
assert.match(indexSource, /gicon-collapse-all[^\n]+M1\.5 3\.25h6\.75/, 'collapse icon should use the list-and-arrow design');
assert.match(indexSource, /gicon-expand-all[^\n]+M12 2\.5V13/, 'expand icon should use the list-and-arrow design');

console.log('search navigation tests passed: source anchors, evidence terms, find/replace matching, icon states and article highlights verified');
