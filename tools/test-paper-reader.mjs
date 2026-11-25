import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/paper-reader.js', import.meta.url), 'utf8');
const skill = await readFile(new URL('../vendor/paper-reader-skill/SKILL.md', import.meta.url), 'utf8');
function engine(skillText = skill) {
  const context = { window: { GuanyiPaperReaderSkill: skillText }, console, setTimeout, clearTimeout, DOMException, AbortController, Map, Set };
  vm.runInNewContext(source, context);
  return context.window.GuanyiPaperReader;
}
const api = engine();
const fixture = (count, length = 30) => Array.from({ length: count }, (_, index) => ({ id: `native-${index}`, page: index + 1, pageLabel: String(index + 1), sourceHash: 'fixture-only-source-hash', text: `SOURCE_${index + 1}: ` + '连续正文和结果条件。'.repeat(Math.ceil(length / 10)), rects: [[0, 0, 10, 10]], itemStart: index, itemEnd: index + 1 }));
const reading = (ids, label = '完整解读', extra = {}) => ({
  reading: { title: '生成论文', documentType: '系统综述与 Meta 分析', summary: { body: label, evidenceIds: ids },
    sections: [{ kind: 'method', title: '研究过程', body: '按检索、纳排和统计合成组织研究。', basis: 'source', evidenceIds: ids }],
    wrapUp: { body: '结论应结合本研究的比较对象和测量条件理解。', basis: 'explanation', evidenceIds: ids }, terms: [], quotes: [], related: [], ...extra },
  questions: [{ question: '主要结论的适用条件是什么？', evidenceIds: ids }],
  cards: [{ question: '研究采用什么方法？', answer: '系统综述与统计合成。', type: '方法', evidenceIds: ids }]
});
const payloadOf = messages => JSON.parse(Array.isArray(messages[1].content) ? messages[1].content[0].text : messages[1].content);
const allIds = payload => {
  if (payload.evidence) return [...new Set([...payload.evidence, ...(payload.visuals || [])].map(item => item.id))];
  return payload.sourceIdRanges.flatMap(range => Array.from({ length: Number(range.last.slice(1)) - Number(range.first.slice(1)) + 1 }, (_, index) => `${range.first[0]}${Number(range.first.slice(1)) + index}`));
};

{
  const native = (id, page, text) => ({ id, text, page, pageLabel: String(page), sourceHash: 'source-hash', rects: [[0, 0, 14, 14]] });
  const blocks = [
    native('title', 1, '作者、标题及内部项目标记'),
    native('opening', 1, '摘 要： 比较一般鞋垫和矫形鞋垫在自然步态下的运动测量结果。'),
    native('closing', 1, '研究发现两种条件下关节活动指标不同。 关 键 词：不可发送的词'),
    native('english', 1, 'Ａｂｓｔｒａｃｔ： Other language version.'),
    native('contents', 2, '1. Introduction'), native('prose', 2, '正文不能发送')
  ];
  const passage = api.extractAbstract(blocks);
  assert.equal(passage.length, 2);
  assert.equal(passage[0].id, 'opening', 'whole native block retains exact locator identity');
  assert.equal(passage[1].text, '研究发现两种条件下关节活动指标不同。');
  assert.equal(passage[1].precise, false, 'cropped line cannot claim exact native text geometry');
  assert.match(passage[1].id, /^closing:abstract:/);
  passage[0].text = '改动过的显示文本不可以传给模型';
  const valid = { takeaway: '结果随步态条件变化。', question: '比较鞋垫的效果。', method: '测量正常行走中的关节运动。',
    finding: '一些指标在两种条件之间存在差异。', boundary: '比较限于正常行走。', evidenceIds: ['E1', 'E2'] };
  let requests = 0;
  const result = await api.quick({ blocks: passage, purpose: '  ' + '测量方法'.repeat(80) + '  ', title: '样本', request: async (messages, options) => {
    requests += 1;
    assert.equal(typeof messages[1].content, 'string', 'abstract quick read sends text only');
    assert.match(messages[0].content, /根据提供的原文摘要/);
    assert.doesNotMatch(messages[0].content, /摘要没有交代的对象、样本或指标标明缺项/);
    const payload = payloadOf(messages);
    assert.equal(payload.stage, 'quick-abstract');
    assert.equal(payload.purpose.length, 200);
    assert.equal(options.timeoutMs, 60000);
    assert.equal(options.maxTokens, 1200);
    assert.deepEqual(payload.evidence.map(item => item.page), [1, 1]);
    assert.doesNotMatch(messages[1].content, /标题及内部|不可发送的词|Other language|正文不能|改动过的显示文本/);
    return valid;
  } });
  assert.equal(requests, 1);
  assert.equal(result.takeaway, valid.takeaway);
  assert.equal(result.boundary, valid.boundary);
  assert.equal(result.sources[0].text, blocks[1].text);
  assert.equal(result.sources[1].text, '研究发现两种条件下关节活动指标不同。');
  const split = api.extractAbstract([
    native('heading', 1, 'ＡＢＳＴＲＡＣＴ'),
    native('summary', 1, 'We looked at three outcomes after changing the sample allocation.'),
    native('results', 2, 'Results measured clinical duration and test accuracy.'),
    native('keywords', 2, 'Key words: allocation'),
    native('body', 2, 'Main article does not enter the abstract prompt.'),
  ]);
  assert.deepEqual(Array.from(split, item => item.id), ['heading', 'summary', 'results']);
  const invalid = [[], blocks, api.extractAbstract(blocks.slice(0, 2)), api.extractAbstract([
    native('late', 3, 'Abstract: We analyzed a narrowly defined research question.'), native('key', 3, 'Keywords: abstract')
  ])];
  for (const blocks of invalid) await assert.rejects(api.quick({ blocks, request: async () => { assert.fail('missing or unchecked abstract reached the model'); } }), /边界可核对/);
  await assert.rejects(api.quick({ blocks: split, request: async () => ({ ...valid, evidenceIds: ['E999'] }) }), /未知/);
  await assert.rejects(api.quick({ blocks: split, request: async () => ({ ...valid, evidenceIds: [] }) }), /缺少原文依据/);
  await assert.rejects(api.quick({ blocks: split, request: async () => ({ ...valid, takeaway: '' }) }), /缺少摘要要点/);
  await assert.rejects(api.quick({ blocks: split, request: async () => ({ ...valid, finding: '' }) }), /缺少主要发现/);
  const concise = await api.quick({ blocks: passage, request: async () => ({
    takeaway: valid.takeaway,
    finding: valid.finding,
    method: valid.method,
    boundary: '',
    evidenceIds: valid.evidenceIds
  }) });
  assert.equal(concise.takeaway, valid.takeaway);
  assert.equal(concise.finding, valid.finding);
  assert.equal(concise.method, valid.method);
  assert.ok(!concise.question && !concise.boundary, 'absent or blank fields are optional');
  const tooManyLines = api.extractAbstract([native('heading', 1, '摘要：'), ...Array.from({ length: 2000 }, (_, index) => native('line-' + index, 1, '试验')), native('end', 1, '关键词：试验')]);
  assert.ok(tooManyLines.length > 1000, 'lots of tiny native lines fit the raw abstract character limit');
  await assert.rejects(api.quick({ blocks: tooManyLines, request: async () => { assert.fail('an over-budget abstract was partially sent'); } }), /超出单次快读/);
}
console.log('PASS concise abstract quick reading with optional fields, verified references and one bounded request');

// The old failure was an 80-line cap and a 50-page UI limit. A short corpus
// exceeding both remains one complete request and preserves native sources.
{
  const blocks = fixture(241, 12), calls = [], progress = [];
  blocks[0].text = '1. 研究问题\n作者提出需要核对的比较对象。';
  blocks[240].text = 'LATE_CONCLUSION: 置信区间与主要结论位于最后一页。';
  const result = await api.prepare({ blocks, title: '完整性验收', onProgress: value => progress.push(value), request: async (messages, options) => {
    const payload = payloadOf(messages); calls.push(payload);
    assert.ok(messages[0].content.includes(skill), 'the actual vendored skill is in the request');
    assert.match(messages[0].content, /系统综述和 Meta 分析/);
    assert.match(messages[0].content, /相邻.*evidenceIds/);
    assert.match(messages[0].content, /按作者实际行文顺序逐节展开/);
    assert.equal(options.maxTokens, 6000);
    assert.equal(options.timeoutMs, 300000, 'Single-document reading gets five minutes per request');
    return JSON.stringify(reading(['E1', 'E241'], '完整解读', {
      sections: [
        { kind: 'limitations', title: '核对结论边界', originalHeading: '未出现在原文中的标题', startEvidenceId: 'E241',
          body: '置信区间限制了解释范围。', readingCue: '核对置信区间和对应的比较对象。', basis: 'explanation', evidenceIds: ['E1', 'E241'] },
        { kind: 'background', title: '理解研究问题', originalHeading: '1. 研究问题', startEvidenceId: 'E1',
          body: '作者先提出需要核对的比较对象。', readingCue: '找出作者比较了什么。', basis: 'source', evidenceIds: ['E1'] }
      ],
      wrapUp: { body: '结论应结合比较对象理解。', limits: '结合置信区间判断精度。', basis: 'explanation', evidenceIds: ['E1', 'E241'] }
    }));
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stage, 'prepare-document');
  assert.equal(calls[0].evidence.length, blocks.length);
  assert.deepEqual(calls[0].evidence.map(item => item.text), blocks.map(item => item.text));
  assert.ok(!JSON.stringify(calls).includes('fixture-only-source-hash'), 'source hash stays local');
  assert.equal(result.coverage.totalBlocks, 241); assert.equal(result.coverage.sentBlocks, 241);
  assert.equal(result.reading.summary.sources.at(-1).page, 241);
  assert.equal(result.reading.summary.sources.at(-1).text, blocks.at(-1).text);
  assert.equal(result.reading.sectionOrder, 'source');
  assert.deepEqual(Array.from(result.reading.sections, item => item.title), ['理解研究问题', '核对结论边界']);
  assert.equal(result.reading.sections[0].originalHeading, '1. 研究问题');
  assert.equal(result.reading.sections[1].originalHeading, undefined, 'invented heading cannot pass as original text');
  assert.equal(result.reading.sections[1].readingCue, '核对置信区间和对应的比较对象。');
  assert.equal(result.reading.sections[1].startEvidenceId, undefined, 'internal anchor stays local');
  assert.equal(result.reading.wrapUp.limits, '结合置信区间判断精度。');
  assert.equal(result.reading.wrapUp.sources.at(-1).page, 241);
  assert.equal(result.candidates.length, 1); assert.equal(progress.at(-1).phase, 'complete');
}
console.log('PASS one complete request, source-ordered reading cues and wrap-up, verified original headings and local source binding');

// Long blocks are split, never clipped, including native whitespace and emoji.
{
  const value = '  begin\n' + '原文😀\n'.repeat(20000) + ' late-end  ';
  const blocks = [{ id: 'same-native-id', sourceHash: 'hash', page: 1, text: value }, { id: 'same-native-id', sourceHash: 'hash', page: 2, text: 'duplicate id must still be read' }];
  const calls = [], result = await api.prepare({ blocks, request: async messages => {
    const payload = payloadOf(messages); calls.push(payload);
    const ids = allIds(payload); return JSON.stringify(reading([ids[0], ids.at(-1)]));
  } });
  const originalCalls = calls.filter(call => call.evidence);
  assert.ok(originalCalls.length > 1);
  assert.ok(originalCalls.flatMap(call => call.evidence).filter(item => item.id === 'E1').map(item => item.text).join('') === value, 'every original character survives complete batching');
  assert.equal(originalCalls.flatMap(call => call.evidence).filter(item => item.id === 'E2').map(item => item.text).join(''), blocks[1].text);
  assert.ok(originalCalls.every(call => call.evidence.every(item => !/[\uD800-\uDBFF]$/.test(item.text))), 'no split high surrogate');
  assert.equal(result.coverage.totalBlocks, 2); assert.equal(result.coverage.sentBlocks, 2);
  assert.equal(result.coverage.processedBatches, originalCalls.length);
}
console.log('PASS oversize blocks, whitespace, Unicode and duplicate native IDs are fully read without clipping');

// Tiny lines are bounded by serialized request overhead rather than a new block
// cap. Every line must still appear across the initial continuous requests.
{
  const blocks = fixture(5000, 1).map((block, index) => ({ ...block, text: String(index % 10) }));
  const calls = [];
  const result = await api.prepare({ blocks, request: async messages => {
    const payload = payloadOf(messages); calls.push(payload); const ids = allIds(payload);
    return JSON.stringify(reading([ids[0], ids.at(-1)]));
  } });
  const originals = calls.filter(call => call.evidence);
  assert.ok(originals.length > 1);
  assert.equal(originals.flatMap(call => call.evidence).length, blocks.length);
  assert.ok(originals.every(call => JSON.stringify(call.evidence).length < 100000), 'metadata overhead remains bounded');
  assert.equal(result.coverage.sentBlocks, 5000);
}
console.log('PASS many tiny lines stay within per-call envelope without sampling or dropping late blocks');

// Multiple reduction levels receive every earlier note, in order, and keep the
// original evidence IDs rather than replacing sources with model-made IDs.
{
  const blocks = fixture(30, 47900), inputNotes = [], summaryNotes = [];
  let batch = 0;
  const result = await api.prepare({ blocks, request: async (messages, options) => {
    const payload = payloadOf(messages), ids = allIds(payload);
    assert.equal(options.timeoutMs, 300000, `${payload.stage}: every batch and synthesis level gets five minutes`);
    assert.equal(options.requireCompleteOutput, true, 'all guide requests ask transport to detect cutoff');
    if (!payload.coverage.final) {
      assert.ok(!messages[0].content.includes(skill), 'intermediate notes get one concise contract');
      assert.match(messages[0].content, /暂不生成结论回顾、词条、逐字摘录/);
    } else assert.ok(messages[0].content.includes(skill), 'final synthesis still uses the vendored guide');
    if (payload.evidence) {
      batch += 1; const label = `BATCH_NOTE_${batch}:` + '解释'.repeat(2400); inputNotes.push(label);
      return JSON.stringify(reading([ids[0]], label));
    }
    summaryNotes.push(payload);
    return JSON.stringify(reading([ids[0], ids.at(-1)], `LEVEL_${payload.coverage.synthesisLevel}_NOTES_${payload.notes.length}`));
  } });
  assert.ok(summaryNotes.length > 1 && summaryNotes.some(note => note.coverage.synthesisLevel > 1));
  const levelOne = summaryNotes.filter(note => note.coverage.synthesisLevel === 1).flatMap(note => note.notes.map(item => item.reading.summary.body));
  assert.deepEqual(levelOne, inputNotes, 'no first-stage notes were omitted from synthesis');
  assert.equal(result.coverage.sentBlocks, blocks.length);
  assert.ok(result.coverage.requests > result.coverage.batches);
}
console.log('PASS hierarchical complete-note synthesis with all intermediate inputs and original provenance');

// Unknown IDs cannot be repaired into a different citation. A bad optional
// quote or related title gets one whole-input repair rather than a half-result.
{
  const blocks = fixture(3), corpus = api._test.corpusFor(blocks);
  await assert.rejects(api.prepare({ blocks, request: async () => JSON.stringify(reading(['E999'])) }), /未知/);
  await assert.rejects(api.prepare({ blocks, request: async () => JSON.stringify(reading(['E1'], '核心解读', {
    wrapUp: { body: '不采用未知来源的结论。', evidenceIds: ['E999'] }
  })) }), /未知/);
  const bad = reading(['E1'], '核心解读', { quotes: [{ quote: 'invented quotation', translation: '', evidenceIds: ['E1'] }] });
  let attempts = 0; const payloads = [];
  const repaired = await api.prepare({ blocks, request: async (messages, options) => {
    payloads.push(payloadOf(messages)); attempts += 1;
    assert.equal(options.timeoutMs, 300000, 'Format repair retains the five-minute request budget');
    return JSON.stringify(attempts === 1 ? bad : reading(['E1']));
  } });
  assert.equal(attempts, 2); assert.deepEqual(payloads[0].evidence, payloads[1].evidence);
  assert.equal(repaired.coverage.repairs, 1); assert.equal(repaired.coverage.requests, 2);
  attempts = 0;
  await assert.rejects(api.prepare({ blocks, request: async () => { attempts += 1; return JSON.stringify(bad); } }), /逐字核对/);
  assert.equal(attempts, 2, 'repair is bounded');
  const cross = [{ id: 'a', page: 1, text: 'A Complete' }, { id: 'b', page: 1, text: 'Paper Title' }];
  const valid = await api.prepare({ blocks: cross, request: async () => JSON.stringify(reading(['E1', 'E2'], '跨行来源', {
    quotes: [{ quote: 'A Complete Paper Title', translation: '中文题名', evidenceIds: ['E1', 'E2'] }],
    related: [{ title: 'A Complete Paper Title', body: '原文中实际出现的文献', evidenceIds: ['E1', 'E2'] }]
  })) });
  assert.equal(valid.reading.quotes[0].sources.length, 2); assert.equal(valid.reading.related[0].sources.length, 2);
  assert.throws(() => api._test.cleanReading(reading(['E1'], '段外摘录', { quotes: [{ quote: blocks[0].text, evidenceIds: ['E1'] }] }), corpus, new Set(['E1']), new Map([['E1', 'only one fragment']])), /逐字核对/);
}
console.log('PASS unknown-ID rejection, exact contiguous quotes, cross-line reference titles and one bounded full-input format repair');

{
  const blocks = fixture(1);
  const wrap = value => `以下是研读笔记：\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  const wrapped = await api.prepare({ blocks, request:async () => wrap(reading(['E1'])) });
  assert.equal(wrapped.coverage.requests, 1, 'a single complete fenced object with a short introduction is accepted');
  assert.equal(wrapped.reading.summary.sources[0].text, blocks[0].text);
  await assert.rejects(api.prepare({ blocks, request:async () => wrap(reading(['E2'])) }), /未知/);

  const complete = JSON.stringify(reading(['E1']));
  for (const malformed of [complete.slice(0, -1), `结果如下：\n${complete}\n${complete}`]) {
    const inputs = [];
    await assert.rejects(api.prepare({ blocks, request:async messages => {
      inputs.push(payloadOf(messages));
      return malformed;
    } }), error => error.code === 'PAPER_INVALID_JSON' && error.studyStage.batch === 1);
    assert.equal(inputs.length, 2, 'invalid JSON gets at most one format repair');
    assert.deepEqual(inputs[0].evidence, inputs[1].evidence);
    assert.ok(inputs[1].formatRepair);
  }
}
console.log('PASS single wrapped guide JSON, unavailable source checking and bounded rejection of truncated or multiple objects');

{
  for (const [omitted, message] of [
    [{ sections: [] }, /章节精读/], [{ wrapUp: undefined }, /读完总结/], [{ sections: [], wrapUp: undefined }, /章节精读和读完总结/]
  ]) {
    const calls = [];
    await assert.rejects(api.prepare({ blocks: fixture(1), request: async request => {
      calls.push(payloadOf(request));
      return reading(['E1'], '未完成的导读', omitted);
    } }), error => error.code === 'PAPER_OUTPUT_SHAPE' && message.test(error.message) && error.studyStage.batch === 1);
    assert.equal(calls.length, 2);
    assert.match(calls[1].formatRepair, /sections 和 wrapUp/);
    assert.deepEqual(calls[0].evidence, calls[1].evidence);
  }
  const calls = [];
  const recovered = await api.prepare({ blocks: fixture(3, 47000), request: async request => {
    const payload = payloadOf(request);
    calls.push(payload.stage);
    const id = allIds(payload)[0];
    if (payload.formatRepair) return reading([id]);
    return reading([id], '仅含批次概览', { sections: [], wrapUp: undefined });
  } });
  assert.ok(calls.filter(stage => stage === 'read-batch').length > 1);
  assert.deepEqual(calls.slice(-2), ['synthesize-reading', 'synthesize-reading']);
  assert.equal(recovered.coverage.repairs, 1);
  assert.equal(recovered.reading.sections.length, 1);
  assert.ok(recovered.reading.wrapUp.sources.length);
}
console.log('PASS a final guide requires all three sections, with bounded repair and flexible intermediate notes');

{
  const blocks = fixture(180, 900); blocks.at(-1).text = 'LATE_ANSWER: 必须在最后一页核对结论。';
  const calls = [], result = await api.answer({ blocks, question: '结论在哪里？', makeCard: true, request: async (messages, options) => {
    const payload = payloadOf(messages); calls.push(payload); const ids = allIds(payload);
    assert.equal(options.timeoutMs, 300000, `${payload.stage}: question answering retains the full request budget`);
    if (payload.evidence && !payload.evidence.some(item => item.id === 'E180')) return JSON.stringify({ answer: '', evidenceIds: [], insufficient: true });
    return JSON.stringify({ answer: '最后一页明确说明了结论。', evidenceIds: ['E180'], insufficient: false, card: { question: '结论在哪里？', answer: '在末页。', type: '结论', evidenceIds: ['E180'] } });
  } });
  const originals = calls.filter(call => call.evidence).flatMap(call => call.evidence);
  assert.equal(originals.length, blocks.length); assert.equal(result.sources[0].page, 180);
  assert.equal(result.card.sources[0].page, 180); assert.equal(result.coverage.sentBlocks, 180);
  assert.ok(calls.at(-1).stage === 'synthesize-answer');
  const controller = new AbortController(); let count = 0;
  await assert.rejects(api.prepare({ blocks, signal: controller.signal, request: async (messages, options) => {
    assert.equal(options.timeoutMs, 300000);
    assert.equal(options.signal, controller.signal, 'Longer timeout must retain the user cancellation signal');
    count += 1; controller.abort(); return JSON.stringify(reading([allIds(payloadOf(messages))[0]]));
  } }), error => error.name === 'AbortError');
  assert.equal(count, 1, 'abort stops subsequent batches');
  let absentCalls = 0;
  await assert.rejects(engine('').prepare({ blocks: fixture(1), request: async () => { absentCalls += 1; } }), /规则尚未加载/);
  assert.equal(absentCalls, 0);
}
console.log('PASS full-text question answering includes late-page evidence, optional cards, cancellation and missing-rule failure');

{
  const fabricated = '研究证明长期缓解疼痛。';
  const result = await api.answer({ blocks: fixture(3, 47000), question: '研究是否测量长期疼痛？', makeCard: true, request: async request => {
    const payload = payloadOf(request);
    assert.match(request[0].content, /"insufficient":true,"answer":"","evidenceIds":\[\]/);
    if (payload.notes) assert.ok(!JSON.stringify(payload.notes).includes(fabricated), 'unsupported batch answer never reaches synthesis');
    const evidenceIds = [allIds(payload)[0]];
    return { insufficient: true, answer: fabricated, evidenceIds, card: { question: '疼痛有没有改善？', answer: fabricated, evidenceIds } };
  } });
  assert.equal(result.insufficient, true);
  assert.equal(result.answer, api.INSUFFICIENT_ANSWER);
  assert.equal(result.sources.length, 0);
  assert.equal(result.card, undefined);
}
console.log('PASS an insufficient answer retains only the trusted notice and excludes claims, citations and cards');

{
  const blocks = fixture(2);
  const reply = { answer:'应核对统计方法及指标定义。', evidenceIds:['E1'], insufficient:false };
  const candidate = { question:'哪些条件需要核对？', answer:'统计方法和指标定义。', type:'方法', evidenceIds:['E1'] };
  const suggested = await api.answer({ blocks, question:'如何确认？', request: async messages => {
    assert.match(messages[0].content, /可主动建议一张适合自测的 card/);
    assert.equal(payloadOf(messages).makeCard, false);
    return { ...reply, card:candidate };
  } });
  assert.equal(suggested.card.question, candidate.question);
  assert.equal(suggested.card.sources[0].id, blocks[0].id);
  for (const card of [undefined, { ...candidate, question:'' }, { ...candidate, evidenceIds:['E2'] }, { ...candidate, evidenceIds:['E999'] }]) {
    const result = await api.answer({ blocks, question:'如何确认？', request: async () => ({ ...reply, card }) });
    assert.equal(result.answer, reply.answer, 'a malformed optional suggestion keeps the valid answer');
    assert.equal(result.card, undefined);
  }
  await assert.rejects(api.answer({ blocks, question:'显式制卡', makeCard:true,
    request: async () => ({ ...reply, card:{ ...candidate, evidenceIds:['E999'] } }) }), /未知/);
  const many = fixture(3, 39000), stages = [];
  const synthesis = await api.answer({ blocks:many, question:'跨批核对后建议学习卡', request: async messages => {
    const payload = payloadOf(messages), id = allIds(payload)[0];
    stages.push(payload.stage);
    if (payload.stage === 'answer-batch') assert.match(messages[0].content, /只交付回答笔记，省略 card/);
    else assert.ok(payload.notes.every(note => !note.card), 'unsolicited batch cards never reach synthesis');
    return { ...reply, evidenceIds:[id], card:{ ...candidate, evidenceIds:[id] } };
  } });
  assert.ok(stages.filter(stage => stage === 'answer-batch').length > 1);
  assert.equal(stages.at(-1), 'synthesize-answer');
  assert.equal(synthesis.card.question, candidate.question);
}
console.log('PASS final sourced answers optionally recommend a verified self-test card without disrupting the answer');

// A native text corpus and every page image travel together, with no page cap,
// sampling, persisted data URL or eager whole-document image rendering.
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxkAAAAASUVORK5CYII=';
const renderedImage = () => ({ dataUrl: tinyPng, mimeType: 'image/png', width: 1, height: 1 });
const visualFixture = count => Array.from({ length: count }, (_, index) => ({ id: `local-visual-${index + 1}`, page: index + 1, pageLabel: String(index + 1), sourceHash: 'visual-only-local-hash', kind: 'page-image', text: '', rects: [], precise: false, privateDataUrl: tinyPng }));
{
  const modelDiagnostic = { reason: 'output_limit' };
  const cause = new Error('fixture cause');
  for (const [failedPhase, studyStage] of [
    ['second-batch', { phase: 'reading', batch: 2, totalBatches: 2 }],
    ['final-synthesis', { phase: 'synthesizing', batch: 1, totalBatches: 1, level: 1, final: true }]
  ]) {
    const failure = Object.assign(new Error('未返回正文', { cause }), { code: 'MODEL_EMPTY_RESPONSE', modelDiagnostic });
    const calls = [];
    await assert.rejects(api.prepare({ blocks: fixture(4), visuals: visualFixture(4), renderVisual: async () => renderedImage(), request: async messages => {
      const payload = payloadOf(messages);
      calls.push(payload.stage);
      if ((failedPhase === 'second-batch' && payload.coverage.batch === 2) || payload.stage === 'synthesize-reading') throw failure;
      return JSON.stringify(reading([allIds(payload)[0]]));
    } }), error => {
      assert.equal(error, failure);
      assert.equal(error.cause, cause);
      assert.equal(error.code, 'MODEL_EMPTY_RESPONSE');
      assert.equal(error.modelDiagnostic, modelDiagnostic);
      assert.deepEqual({ ...error.studyStage }, studyStage);
      return true;
    });
    assert.deepEqual(calls, failedPhase === 'second-batch'
      ? ['read-batch', 'read-batch', 'read-batch']
      : ['read-batch', 'read-batch', 'synthesize-reading', 'synthesize-reading']);
  }
  await assert.rejects(api.prepare({ blocks: fixture(6, 47900), request: async messages => {
    const payload = payloadOf(messages);
    if (payload.stage === 'synthesize-reading') throw new Error('intermediate synthesis failure');
    return JSON.stringify(reading([allIds(payload)[0]], '解释'.repeat(6500)));
  } }), error => {
    assert.deepEqual({ ...error.studyStage }, { phase: 'synthesizing', batch: 1, totalBatches: 2, level: 1, final: false });
    return true;
  });
  const aborted = new DOMException('已停止', 'AbortError');
  await assert.rejects(api.prepare({ blocks: fixture(1), request: async () => { throw aborted; } }), error => error === aborted && !error.studyStage);
}
console.log('PASS missing model text retains transport diagnostics and identifies reading batch, intermediate synthesis or final synthesis');

{
  const calls = [], renderedPages = [], progress = [];
  const outputLimit = Object.assign(new Error('模型达到输出上限'), { code:'MODEL_EMPTY_RESPONSE', modelDiagnostic:{ reason:'output_limit' } });
  const result = await api.prepare({ blocks:fixture(4), visuals:visualFixture(4), onProgress:value => progress.push(value),
    renderVisual:async visual => { renderedPages.push(visual.page); return renderedImage(); },
    request:async (messages, options) => {
      const payload = payloadOf(messages);
      calls.push({ payload, messages, maxTokens:options.maxTokens });
      if (calls.length === 1) throw outputLimit;
      return JSON.stringify(reading([allIds(payload)[0]]));
    } });
  assert.deepEqual(calls.map(call => call.maxTokens), [6000, 12000, 6000, 6000]);
  assert.deepEqual(calls[0].messages, calls[1].messages, 'retry sends the same first batch text and images');
  assert.deepEqual(calls.map(call => call.payload.stage), ['read-batch', 'read-batch', 'read-batch', 'synthesize-reading']);
  assert.deepEqual(renderedPages, [1, 2, 3, 4], 'the retry reuses rendered pages');
  assert.equal(result.coverage.sentImages, 4);
  assert.equal(result.coverage.processedBatches, 2);
  assert.equal(result.coverage.requests, 4);
  assert.equal(result.coverage.repairs, 0, 'output exhaustion is distinct from structure repair');
  assert.match(progress.find(value => value.phase === 'retrying-output').message, /第 1 \/ 2 批/);

  let requests = 0;
  const controller = new AbortController();
  await assert.rejects(api.prepare({ blocks:fixture(1), signal:controller.signal,
    onProgress:value => { if (value.phase === 'retrying-output') controller.abort(); },
    request:async () => { requests += 1; throw outputLimit; }
  }), { name:'AbortError' });
  assert.equal(requests, 1, 'stop prevents the higher-budget retry');
}
console.log('PASS output-limit recovery retries the same guide batch once, then resumes full coverage or stops');

{
  const blocks = fixture(30), visuals = visualFixture(30), calls = [], rendered = [], updates = [];
  const result = await api.prepare({ blocks, visuals, onProgress: value => updates.push(value), renderVisual: async (visual, options) => {
    assert.ok(!JSON.stringify(visual).includes('base64'), 'renderer receives safe local metadata');
    assert.ok(Object.hasOwn(options, 'signal'));
    rendered.push(visual.page); return renderedImage();
  }, request: async (messages, options) => {
    const payload = payloadOf(messages), ids = allIds(payload); calls.push(payload);
    assert.equal(options.timeoutMs, 300000, 'Multimodal reading and synthesis share the five-minute budget');
    const images = Array.isArray(messages[1].content) ? messages[1].content.filter(item => item.type === 'image_url') : [];
    assert.ok(images.length <= 3);
    if (payload.evidence) {
      assert.equal(images.length, payload.visuals.length);
      assert.equal(rendered.length, calls.filter(item => item.evidence).flatMap(item => item.visuals).length, 'no future pages rendered ahead of this batch');
      assert.ok(payload.visuals.every(visual => payload.evidence.some(block => block.page === visual.page)), 'normal-size page image stays with its text');
      assert.ok(images.every(image => image.image_url.detail === 'high' && image.image_url.url === tinyPng));
      assert.ok(!JSON.stringify(payload).includes('base64') && !JSON.stringify(payload).includes('visual-only-local-hash'));
      assert.match(messages[0].content, /页面图像.*待分析资料/);
      assert.match(messages[0].content, /坐标轴、单位、图例/);
    } else {
      assert.ok(payload.sourceIdRanges.some(range => range.first.startsWith('V')));
      assert.equal(payload.coverage.fullVisualsRead, true);
    }
    return JSON.stringify(reading([ids[0], ids.at(-1)], '文字与图表完整解读', { sections: [{ kind: 'figure', title: '图表', body: '按页面图像核对图例、单位及比较关系。', basis: 'source', evidenceIds: [ids.at(-1)] }] }));
  } });
  const original = calls.filter(item => item.evidence);
  assert.equal(original.length, 10);
  assert.deepEqual(original.flatMap(item => item.evidence.map(block => block.text)), blocks.map(block => block.text));
  assert.deepEqual(original.flatMap(item => item.visuals.map(visual => visual.id)), Array.from({ length: 30 }, (_, index) => `V${index + 1}`));
  assert.deepEqual(rendered, visuals.map(visual => visual.page));
  assert.equal(result.coverage.totalImages, 30); assert.equal(result.coverage.sentImages, 30);
  assert.equal(result.coverage.visualPages, 30); assert.equal(result.coverage.visualBatches, 10); assert.equal(result.coverage.processedVisualBatches, 10);
  assert.equal(result.coverage.sentBlocks, 30); assert.equal(result.reading.summary.sources.at(-1).kind, 'page-image');
  assert.equal(result.reading.summary.sources.at(-1).page, 30); assert.equal(result.reading.summary.sources.at(-1).precise, false);
  assert.ok(!JSON.stringify(result).includes('base64'), 'rendered bytes never persist in reading, candidates or coverage');
  assert.equal(updates.at(-1).phase, 'complete');
}
console.log('PASS all native text plus all 30 page images, three images per call, lazy rendering, visual sources and complete synthesis');

// Image-only scanned papers can be read and answered without pretending an OCR
// transcript exists. Image sources still cannot establish an exact quotation.
{
  const visuals = visualFixture(7), calls = [];
  const result = await api.prepare({ blocks: [], visuals, renderVisual: async () => renderedImage(), request: async messages => {
    const payload = payloadOf(messages); calls.push(payload); const ids = allIds(payload);
    return JSON.stringify(reading([ids[0], ids.at(-1)]));
  } });
  assert.equal(result.coverage.sentBlocks, 0); assert.equal(result.coverage.sentImages, 7);
  assert.ok(calls.filter(call => call.evidence).every(call => call.evidence.length === 0 && call.visuals.length > 0));
  assert.equal(result.reading.summary.sources.at(-1).page, 7);
  const answer = await api.answer({ blocks: [], visuals: visualFixture(1), question: '图表的比较对象是什么？', makeCard: true,
    renderVisual: async () => renderedImage(), request: async () => JSON.stringify({ answer: '图中比较了两个条件。', evidenceIds: ['V1'], insufficient: false,
      card: { question: '比较对象？', answer: '两个条件。', evidenceIds: ['V1'] } }) });
  assert.equal(answer.sources[0].kind, 'page-image'); assert.equal(answer.card.sources[0].page, 1);
  await assert.rejects(api.prepare({ blocks: [], visuals: visualFixture(1), renderVisual: async () => renderedImage(), request: async () => JSON.stringify(reading(['V2'])) }), /未知/);
  const corpus = api._test.corpusFor([], visualFixture(1));
  assert.throws(() => api._test.cleanReading(reading(['V1'], '不伪造图像转录', { quotes: [{ quote: '页面图像', evidenceIds: ['V1'] }] }), corpus), /逐字原文摘录/);
  assert.throws(() => api._test.cleanReading(reading(['V1'], '不伪造文献', { related: [{ title: '页面图像', body: '文献', evidenceIds: ['V1'] }] }), corpus), /逐字核对的文字来源/);
  let repairs = 0, renders = 0;
  const repairInputs = [];
  const repaired = await api.prepare({ blocks: [], visuals: visualFixture(1), renderVisual: async () => { renders += 1; return renderedImage(); }, request: async messages => {
    repairs += 1; repairInputs.push(messages[1].content);
    return repairs === 1 ? '{' : JSON.stringify(reading(['V1']));
  } });
  assert.equal(repaired.coverage.repairs, 1); assert.equal(renders, 1, 'format repair reuses just the current batch images');
  assert.deepEqual(repairInputs[0].slice(1), repairInputs[1].slice(1), 'repair retains exact original page images');
  assert.equal(JSON.parse(repairInputs[1][0].text).visuals[0].id, 'V1');
}
console.log('PASS scanned image-only documents, image-source answers and cards, and rejection of invented image quotations or IDs');

// Huge native pages continue to be split intact while their page image is sent
// once. Empty pages between native-text pages are still transmitted in order.
{
  const blocks = [{ id: 'large', page: 1, text: '完整文字😀\n'.repeat(18000) }, { id: 'later', page: 4, text: '末页原文' }], calls = [];
  const result = await api.prepare({ blocks, visuals: visualFixture(4), renderVisual: async () => renderedImage(), request: async messages => {
    const payload = payloadOf(messages); calls.push(payload); const ids = allIds(payload); return JSON.stringify(reading([ids[0], ids.at(-1)]));
  } });
  const originals = calls.filter(call => call.evidence);
  assert.equal(originals.flatMap(call => call.evidence).filter(block => block.id === 'E1').map(block => block.text).join(''), blocks[0].text);
  assert.deepEqual(originals.flatMap(call => (call.visuals || []).map(visual => visual.page)), [1, 2, 3, 4]);
  assert.equal(result.coverage.sentBlocks, 2); assert.equal(result.coverage.sentImages, 4);
}
console.log('PASS oversized native pages remain complete and image-only gaps keep their page ordering');

// Renderer, model capability and malformed image failures never publish a
// text-only or partly read success; errors cannot echo image data to the UI.
{
  const visuals = visualFixture(4); let calls = 0, renders = 0, progress = [];
  await assert.rejects(api.prepare({ blocks: fixture(4), visuals, onProgress: value => progress.push(value), renderVisual: async visual => {
    renders += 1; if (visual.page === 4) throw new Error(tinyPng); return renderedImage();
  }, request: async messages => { calls += 1; return JSON.stringify(reading([allIds(payloadOf(messages))[0]])); } }), error => {
    assert.deepEqual({ ...error.studyStage }, { phase: 'reading', batch: 2, totalBatches: 2 });
    return /第 4 页/.test(error.message) && !error.message.includes('base64');
  });
  assert.equal(calls, 1); assert.equal(renders, 4); assert.ok(!progress.some(value => value.phase === 'complete'));
  await assert.rejects(api.prepare({ blocks: [], visuals: visualFixture(1), request: async () => { throw new Error('must not call'); } }), /不能仅用文字代替/);
  for (const invalid of [
    { ...renderedImage(), dataUrl: 'https://example.com/image.png' },
    { ...renderedImage(), dataUrl: 'data:image/png;base64,!!!' },
    { ...renderedImage(), dataUrl: 'data:image/png;base64,aGVsbG8=' },
    { ...renderedImage(), dataUrl: tinyPng.slice(0, -8) },
    { ...renderedImage(), mimeType: 'image/jpeg' },
    { ...renderedImage(), width: 9000 },
    { ...renderedImage(), dataUrl: `data:image/png;base64,${Buffer.alloc(api._test.MAX_IMAGE_BYTES + 1).toString('base64')}` }
  ]) {
    let requestCalled = false;
    await assert.rejects(api.prepare({ blocks: [], visuals: visualFixture(1), renderVisual: async () => invalid, request: async () => { requestCalled = true; } }), error => /图像格式或大小/.test(error.message) && !error.message.includes('base64'));
    assert.equal(requestCalled, false);
  }
  const controller = new AbortController(); let abortCalls = 0, abortRenders = 0;
  await assert.rejects(api.prepare({ blocks: [], visuals, signal: controller.signal, renderVisual: async (_, options) => {
    assert.equal(options.signal, controller.signal); abortRenders += 1; controller.abort(); return renderedImage();
  }, request: async () => { abortCalls += 1; } }), error => error.name === 'AbortError');
  assert.equal(abortRenders, 1); assert.equal(abortCalls, 0);
  let unsupportedRenders = 0;
  await assert.rejects(api.prepare({ blocks: [], visuals, renderVisual: async () => { unsupportedRenders += 1; return renderedImage(); },
    request: async () => { throw new Error('当前模型不支持图像输入'); } }), /不支持图像/);
  assert.equal(unsupportedRenders, 3, 'unsupported models never continue rendering or silently retry without images');
}
console.log('PASS image size/format checks, safe renderer failure, model capability errors and cancellation without partial success');

console.log('Paper reader complete text and vision engine tests passed.');
