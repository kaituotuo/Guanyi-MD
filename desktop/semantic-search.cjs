const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { MeilisearchHttpError, MeilisearchProcess } = require('./meilisearch-process.cjs');

const INDEX_SCHEMA_VERSION = 4;
const INDEX_UID = `guanyi_content_v${INDEX_SCHEMA_VERSION}`;
const INDEX_SETTINGS_VERSION = 3;
const EMBEDDER_NAME = 'bgeZh';
const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
const MODEL_REVISION = '75c43b069aac4d136ba6bc1122f995fedcfd2781';
const MODEL_SHA256 = 'b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5';
const MODEL_DIMENSIONS = 512;
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';
const MAX_DOCUMENTS = 500;
const MAX_UNITS_PER_DOCUMENT = 1_000_000;
const MAX_TEXT_LENGTH = 20_000;
const MAX_SEMANTIC_TEXT_LENGTH = 1_600;
const MAX_SNIPPET_LENGTH = 1_200;
// Keep native ONNX allocations bounded in the Electron main process. The
// smaller batch also makes a failed document retryable without retaining a
// large intermediate tensor graph.
const EMBEDDING_BATCH_SIZE = 8;
const DOCUMENT_BATCH_SIZE = 64;
const ONNX_SESSION_OPTIONS = Object.freeze({
  executionProviders: [{ name: 'cpu', useArena: false }],
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  executionMode: 'sequential',
  enableCpuMemArena: false,
  enableMemPattern: false,
  logSeverityLevel: 4
});
const HYBRID_SEMANTIC_RATIO = 0.58;
const PURE_SEMANTIC_RATIO = 1;
const MIN_RANKING_SCORE = 0.2;
const PURE_SEMANTIC_MIN_SCORE = 0.35;
const INTERNAL_SENTENCE_CANDIDATES = 160;
const INTERNAL_PARENT_CANDIDATES = 80;
const INTERNAL_PARENT_EVIDENCE_QUERIES = 4;
const QUERY_VECTOR_CACHE_SIZE = 32;
const INTERNAL_LEXICAL_CANDIDATES = 24;
const MAX_QUERY_VARIANTS = 12;
const RRF_RANK_CONSTANT = 60;
const QUERY_NEGATIONS = new Set(['不', '未', '无', '非', '莫', '勿', '别', '没']);
const SEMANTIC_QUERY_STOP_TERMS = new Set([
  '什么', '怎么', '如何', '为何', '为什么', '哪里', '哪儿', '哪个', '哪些',
  '是谁', '谁的', '是否', '是不是', '有没有', '请问', '一下'
]);

function toWellFormedText(value) {
  const text = String(value ?? '');
  if (typeof text.toWellFormed === 'function') return text.toWellFormed();
  return text.replace(/[\uD800-\uDFFF]/g, (character, index, source) => {
    const code = character.charCodeAt(0);
    const next = source.charCodeAt(index + 1);
    const previous = source.charCodeAt(index - 1);
    if (code <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) return character;
    if (code >= 0xDC00 && previous >= 0xD800 && previous <= 0xDBFF) return character;
    return '\uFFFD';
  });
}

function clampText(value, limit) {
  const maximum = Math.max(0, Number(limit) || 0);
  if (!maximum) return '';
  let result = '';
  let length = 0;
  for (const character of String(value ?? '')) {
    if (length >= maximum) break;
    const code = character.charCodeAt(0);
    result += character.length === 1 && code >= 0xD800 && code <= 0xDFFF ? '\uFFFD' : character;
    length += 1;
  }
  return result;
}

function safeProgress(progress, payload) {
  try { progress?.(payload); } catch (_error) { /* Renderer may have closed. */ }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeSearchText(rawValue) {
  const value = String(rawValue || '').toLowerCase();
  const normalized = typeof value.normalize === 'function' ? value.normalize('NFKC') : value;
  return normalized.replace(/[^\p{L}\p{N}]+/gu, '');
}

function cjkQuerySequences(rawValue) {
  const value = String(rawValue || '').toLowerCase();
  const normalized = typeof value.normalize === 'function' ? value.normalize('NFKC') : value;
  return normalized.match(/[\u3400-\u9fff]+/g) || [];
}

function retrievalQueryVariants(rawQuery, maximum = MAX_QUERY_VARIANTS) {
  const original = String(rawQuery || '').trim();
  if (!original) return [];
  const variants = [];
  const seen = new Set();
  const add = (value) => {
    const term = String(value || '').trim().toLowerCase();
    if (!term || seen.has(term) || SEMANTIC_QUERY_STOP_TERMS.has(term)) return;
    seen.add(term);
    variants.push(term);
  };
  add(original);
  String(original).split(/[\s,，。；;、/\\：:!?！？]+/).forEach(add);
  const fragments = [];
  for (const sequence of cjkQuerySequences(original)) {
    for (let length = Math.min(6, sequence.length); length >= 2; length -= 1) {
      for (let start = 0; start + length <= sequence.length; start += 1) {
        fragments.push(sequence.slice(start, start + length));
      }
    }
    for (const character of sequence) {
      if (QUERY_NEGATIONS.has(character)) add(character);
    }
  }
  fragments.sort((a, b) => b.length - a.length || original.indexOf(a) - original.indexOf(b));
  fragments.forEach(add);
  return variants.slice(0, Math.max(1, Number(maximum) || MAX_QUERY_VARIANTS));
}

function semanticQueryTerms(rawQuery) {
  const value = String(rawQuery || '').trim().toLowerCase();
  const terms = new Set(retrievalQueryVariants(value, 64));
  for (const sequence of cjkQuerySequences(value)) {
    const maximum = Math.min(6, sequence.length);
    for (let length = maximum; length >= 2; length -= 1) {
      for (let start = 0; start + length <= sequence.length; start += 1) terms.add(sequence.slice(start, start + length));
    }
  }
  if (/(情谊|情义|友谊|关系|交情|感情|兄弟|结义|同袍|同生共死|深厚|亲密|相交|相知)/.test(value)) {
    [
      '人物关系', '情谊', '情义', '友谊', '关系', '交情', '感情',
      '兄弟', '结义', '同袍', '同生共死', '誓同生死', '同患难',
      '至交', '相交', '相知', '深厚'
    ].forEach((term) => terms.add(term));
  }
  return [...terms].filter((term) => (term.length >= 2 || QUERY_NEGATIONS.has(term)) && !SEMANTIC_QUERY_STOP_TERMS.has(term));
}

function semanticQueryText(rawQuery) {
  const query = String(rawQuery || '').trim();
  const expansions = [];
  if (/(?:名字|名称|称呼|名号).*(?:来历|由来|起源|缘由)|(?:来历|由来|起源|缘由).*(?:名字|名称|称呼|名号)|为什么.*(?:叫|称为)|如何.*(?:得名|命名)/.test(query)) {
    expansions.push('名称由来 本名 原名 改名 更名 起名 命名原因 为什么这样称呼');
  }
  if (/(?:原因|缘故|为何|为什么|怎么会|何以)/.test(query)) {
    expansions.push('原因 缘故 解释 因为 所以');
  }
  if (/谁.*(?:打|杀|害|救|骗|送|写|说|做)/.test(query)) {
    expansions.push('人物行为的实施者是谁');
  }
  if (/(情谊|情义|友谊|关系|交情|感情|兄弟|结义|同袍|同生共死|深厚|亲密|相交|相知)/.test(query)) {
    expansions.push('人物关系 情谊 情义 友谊 关系 交情 感情 兄弟 结义 同袍 同生共死 誓同生死 同患难 至交 相交 相知 深厚');
  }
  return [query, ...expansions].join('；');
}

function matchedQueryTerms(terms, rawText) {
  const text = String(rawText || '').toLowerCase();
  const found = [...new Set((terms || []).filter((term) => text.includes(String(term).toLowerCase())))]
    .sort((a, b) => b.length - a.length);
  const selected = [];
  for (const term of found) {
    if (selected.some((existing) => existing.includes(term))) continue;
    selected.push(term);
    if (selected.length >= 8) break;
  }
  return selected;
}

function lexicalBoostForTerms(terms) {
  return Math.min(0.08, (terms || []).reduce((score, term) => score + Math.max(0.018, (term.length - 1) * 0.018), 0));
}

function textNgrams(rawValue, size = 2) {
  const value = normalizeSearchText(rawValue);
  if (!value) return [];
  if (value.length <= size) return [value];
  const grams = [];
  for (let index = 0; index + size <= value.length; index += 1) grams.push(value.slice(index, index + size));
  return grams;
}

function longestCommonSubstringLength(leftValue, rightValue) {
  const left = normalizeSearchText(leftValue).slice(0, 160);
  const right = normalizeSearchText(rightValue).slice(0, 1600);
  if (!left || !right) return 0;
  let previous = new Uint16Array(right.length + 1);
  let maximum = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Uint16Array(right.length + 1);
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] !== right[rightIndex - 1]) continue;
      current[rightIndex] = previous[rightIndex - 1] + 1;
      if (current[rightIndex] > maximum) maximum = current[rightIndex];
    }
    previous = current;
  }
  return maximum;
}

function queryFragmentCoverage(rawQuery, rawText) {
  const query = normalizeSearchText(rawQuery);
  const text = normalizeSearchText(rawText);
  if (!query || !text) return 0;
  if (text.includes(query)) return 1;
  const queryCharacters = [...query];
  const available = new Map();
  for (const character of text) available.set(character, (available.get(character) || 0) + 1);
  let characterMatches = 0;
  for (const character of queryCharacters) {
    const count = available.get(character) || 0;
    if (!count) continue;
    characterMatches += 1;
    available.set(character, count - 1);
  }
  const queryBigrams = textNgrams(query, 2);
  const textBigrams = new Set(textNgrams(text, 2));
  const bigramCoverage = queryBigrams.length
    ? queryBigrams.filter((gram) => textBigrams.has(gram)).length / queryBigrams.length
    : 0;
  const characterCoverage = characterMatches / queryCharacters.length;
  const longestCoverage = longestCommonSubstringLength(query, text) / query.length;
  return Math.min(1, longestCoverage * 0.5 + bigramCoverage * 0.3 + characterCoverage * 0.2);
}

function textNgramSimilarity(leftValue, rightValue) {
  const left = new Set(textNgrams(leftValue, 2));
  const right = new Set(textNgrams(rightValue, 2));
  if (!left.size || !right.size) return normalizeSearchText(leftValue) === normalizeSearchText(rightValue) ? 1 : 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

function reciprocalRankFusion(channels, rankConstant = RRF_RANK_CONSTANT) {
  const fused = new Map();
  for (const channel of channels || []) {
    const weight = Math.max(0, Number(channel?.weight) || 0);
    (channel?.hits || []).forEach((hit, index) => {
      if (!hit?.id || !weight) return;
      const entry = fused.get(hit.id) || { hit, rrfScore: 0, channels: [], bestRankingScore: 0 };
      entry.rrfScore += weight / (Math.max(1, Number(rankConstant) || RRF_RANK_CONSTANT) + index + 1);
      entry.channels.push(channel.name || 'recall');
      const rankingScore = Number(hit._rankingScore) || 0;
      if (rankingScore > entry.bestRankingScore) {
        entry.bestRankingScore = rankingScore;
        entry.hit = hit;
      }
      fused.set(hit.id, entry);
    });
  }
  return [...fused.values()].sort((a, b) => b.rrfScore - a.rrfScore || b.bestRankingScore - a.bestRankingScore);
}

function namingOriginEntity(rawQuery) {
  const query = normalizeSearchText(rawQuery);
  if (!/(?:名字|名称|称呼|名号).*(?:来历|由来|起源|缘由)|(?:来历|由来|起源|缘由).*(?:名字|名称|称呼|名号)/.test(query)) return '';
  return query.replace(/(?:的)?(?:名字|名称|称呼|名号|来历|由来|起源|缘由)/g, '').slice(0, 24);
}

function intentRetrievalVariants(rawQuery) {
  const entity = namingOriginEntity(rawQuery);
  if (!entity) return [];
  return [
    `${entity} 诗云`,
    `${entity} 本姓`,
    `${entity} 改名`,
    `${entity} 起名`,
    entity,
    '诗云',
    '本姓',
    '改名'
  ];
}

function intentEvidenceScore(rawQuery, rawText) {
  const text = normalizeSearchText(rawText);
  const entity = namingOriginEntity(rawQuery);
  if (!entity) return 0;
  const hasEntity = text.includes(entity);
  if (!hasEntity) return 0;
  const source = String(rawText || '');
  const namingAction = /(?:改名|更名|起名|取名|命名|起.{0,20}名字|名字叫|叫作|称作|名为)/.test(source);
  const originEvidence = /(?:本姓|原名|本名|改名|更名|因.{0,120}姓|姓.{0,80}(?:起|改|取|名)|取自|出自|诗云|诗句)/.test(source);
  return 0.25 + (namingAction ? 0.2 : 0) + (originEvidence ? 0.55 : 0);
}

function queryEchoPenalty(rawQuery, rawText) {
  const query = normalizeSearchText(rawQuery);
  const text = normalizeSearchText(rawText);
  if (!query || !text.includes(query)) return 0;
  return /(?:搜索|检索|查询|语义|关键词|匹配|返回|结果|预期|用户|功能|测试|用例|优化|实现|问题)/.test(String(rawText || '')) ? 1 : 0;
}

function focusedSnippet(rawText, terms, limit = 520) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const lower = text.toLowerCase();
  let matchIndex = -1;
  for (const term of terms || []) {
    matchIndex = lower.indexOf(String(term).toLowerCase());
    if (matchIndex >= 0) break;
  }
  if (matchIndex < 0) return `${text.slice(0, limit).trim()}…`;
  const left = Math.max(0, matchIndex - Math.floor(limit * 0.2));
  const right = Math.min(text.length, left + limit);
  return `${left ? '…' : ''}${text.slice(left, right).trim()}${right < text.length ? '…' : ''}`;
}

function resultPassageKeys(result) {
  const keys = Array.isArray(result?.passageIds) && result.passageIds.length
    ? result.passageIds
    : [result?.passageId];
  return new Set(keys.filter(Boolean).map((id) => `${result.docId}:${id}`));
}

function diversifySearchResults(rawResults, rawLimit) {
  const limit = Math.max(1, Number(rawLimit) || 15);
  const remaining = [...(rawResults || [])]
    .filter((result) => result?.docId && Number.isFinite(Number(result.score)))
    .sort((a, b) => Number(b.score) - Number(a.score) || Number(a.start) - Number(b.start));
  const selected = [];
  const selectedPassages = new Set();
  while (remaining.length && selected.length < limit) {
    let bestIndex = -1;
    let bestAdjustedScore = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const passageKeys = resultPassageKeys(candidate);
      if ([...passageKeys].some((key) => selectedPassages.has(key))) continue;
      let maximumSimilarity = 0;
      for (const prior of selected) {
        const similarity = textNgramSimilarity(candidate.snippet, prior.snippet);
        if (similarity > maximumSimilarity) maximumSimilarity = similarity;
      }
      const duplicateThreshold = selected.some((prior) => prior.docId === candidate.docId) ? 0.86 : 0.94;
      if (maximumSimilarity >= duplicateThreshold) continue;
      const adjustedScore = Number(candidate.score) - maximumSimilarity * 0.22;
      if (adjustedScore > bestAdjustedScore) {
        bestAdjustedScore = adjustedScore;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    const [best] = remaining.splice(bestIndex, 1);
    selected.push(best);
    resultPassageKeys(best).forEach((key) => selectedPassages.add(key));
  }
  return selected;
}

function meanNormalizedVector(vectors) {
  const vector = new Float32Array(MODEL_DIMENSIONS);
  let count = 0;
  for (const source of vectors || []) {
    if (!source || source.length !== MODEL_DIMENSIONS) continue;
    for (let index = 0; index < MODEL_DIMENSIONS; index += 1) vector[index] += source[index];
    count += 1;
  }
  if (!count) return null;
  let magnitude = 0;
  for (let index = 0; index < MODEL_DIMENSIONS; index += 1) {
    vector[index] /= count;
    magnitude += vector[index] * vector[index];
  }
  magnitude = Math.sqrt(magnitude) || 1;
  for (let index = 0; index < MODEL_DIMENSIONS; index += 1) vector[index] /= magnitude;
  return vector;
}

function recordId(docId, unitId, revision = '') {
  return crypto.createHash('sha256').update(`${docId}\0${unitId}\0${revision}`).digest('hex');
}

function emptyMetadata() {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    settingsVersion: INDEX_SETTINGS_VERSION,
    updatedAt: 0,
    engineVersion: '',
    documents: {},
    failures: {}
  };
}

function meiliString(value) {
  return JSON.stringify(String(value || ''));
}

class VectorAccumulator {
  constructor() {
    this.sums = new Map();
  }

  add(key, vector) {
    if (!key || !vector) return;
    let entry = this.sums.get(key);
    if (!entry) {
      entry = { vector: new Float32Array(MODEL_DIMENSIONS), count: 0 };
      this.sums.set(key, entry);
    }
    for (let index = 0; index < MODEL_DIMENSIONS; index += 1) entry.vector[index] += vector[index];
    entry.count += 1;
  }

  normalized(key) {
    const entry = this.sums.get(key);
    if (!entry?.count) return null;
    return meanNormalizedVector([entry.vector]);
  }
}

class SemanticSearchService {
  constructor({ modelDir, binaryPath, dataDir, metadataFile, logFile, engine }) {
    this.modelDir = modelDir;
    this.binaryPath = binaryPath;
    this.dataDir = dataDir;
    this.metadataFile = metadataFile || (dataDir ? path.join(dataDir, 'guanyi-index-metadata.json') : null);
    this.engine = engine || new MeilisearchProcess({
      binaryPath,
      dataDir: path.join(dataDir, 'meilisearch-db'),
      keyFile: path.join(dataDir, 'master-key'),
      logFile: logFile || path.join(dataDir, 'semantic-search.log')
    });
    this.client = null;
    this.engineVersion = '';
    this.extractor = null;
    this.loadingModel = null;
    this.modelVerified = false;
    this.metadataLoaded = false;
    this.metadata = emptyMetadata();
    this.resetIndex = false;
    this.indexReady = false;
    this.settingsDirty = true;
    this.ensuringIndex = null;
    this.recoveryAttempted = false;
    this.lastServiceError = null;
    this.lastRecovery = null;
    this.operation = Promise.resolve();
    this.embeddingOperation = Promise.resolve();
    this.queryVectorCache = new Map();
  }

  modelFile() {
    return path.join(this.modelDir, 'onnx', 'model_int8.onnx');
  }

  async verifyModel() {
    if (this.modelVerified) return true;
    const bytes = await fs.promises.readFile(this.modelFile());
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== MODEL_SHA256) throw new Error('本地语义模型校验失败，请重新安装观绎 MD');
    this.modelVerified = true;
    return true;
  }

  async ensureModel(progress) {
    if (this.extractor) return this.extractor;
    if (this.loadingModel) return this.loadingModel;
    this.loadingModel = (async () => {
      safeProgress(progress, { phase: 'model', message: '正在加载本地语义模型' });
      await this.verifyModel();
      const { env, pipeline } = await import('@huggingface/transformers');
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      this.extractor = await pipeline('feature-extraction', this.modelDir, {
        dtype: 'int8',
        device: 'cpu',
        local_files_only: true,
        session_options: ONNX_SESSION_OPTIONS
      });
      safeProgress(progress, { phase: 'model-ready', message: '本地语义模型已就绪' });
      return this.extractor;
    })();
    try {
      return await this.loadingModel;
    } finally {
      this.loadingModel = null;
    }
  }

  async embed(texts, progress, completed, total, progressMode = 'index') {
    const run = async () => {
      const extractor = await this.ensureModel(progress);
      const output = await extractor(texts, { pooling: 'cls', normalize: true });
      if (!output?.data || output.dims?.at(-1) !== MODEL_DIMENSIONS) throw new Error('本地语义模型返回了无法识别的向量');
      const vectors = [];
      for (let index = 0; index < texts.length; index += 1) {
        const start = index * MODEL_DIMENSIONS;
        vectors.push(new Float32Array(output.data.slice(start, start + MODEL_DIMENSIONS)));
      }
      safeProgress(progress, progressMode === 'search'
        ? { phase: 'searching', message: '正在理解检索问题' }
        : {
            phase: 'indexing',
            completed: completed + texts.length,
            total,
            message: `正在建立本地索引 ${completed + texts.length}/${total}`
          });
      return vectors;
    };
    const next = this.embeddingOperation.then(run, run);
    this.embeddingOperation = next.catch(() => {});
    return next;
  }

  async queryVectors(query, semanticText, progress) {
    const key = `${query}\0${semanticText}`;
    const cached = this.queryVectorCache.get(key);
    if (cached) {
      this.queryVectorCache.delete(key);
      this.queryVectorCache.set(key, cached);
      safeProgress(progress, { phase: 'searching', message: '正在检索本地索引' });
      return cached;
    }
    const vectors = await this.embed([
      `${QUERY_PREFIX}${query}`,
      `${QUERY_PREFIX}${semanticText}`
    ], progress, 0, 2, 'search');
    this.queryVectorCache.set(key, vectors);
    while (this.queryVectorCache.size > QUERY_VECTOR_CACHE_SIZE) {
      this.queryVectorCache.delete(this.queryVectorCache.keys().next().value);
    }
    return vectors;
  }

  sanitizeDocuments(rawDocuments) {
    if (!Array.isArray(rawDocuments)) return [];
    return rawDocuments.slice(0, MAX_DOCUMENTS).map((document) => {
      const rawUnits = Array.isArray(document?.units) ? document.units : document?.chunks;
      const units = Array.isArray(rawUnits) ? rawUnits.slice(0, MAX_UNITS_PER_DOCUMENT).map((unit, index) => ({
        unitId: clampText(unit?.unitId || `legacy-${index}`, 240),
        text: clampText(unit?.text, MAX_TEXT_LENGTH),
        semanticText: clampText(unit?.semanticText || unit?.text, MAX_SEMANTIC_TEXT_LENGTH),
        snippet: clampText(unit?.snippet || unit?.text, MAX_SNIPPET_LENGTH),
        heading: clampText(unit?.heading, 500),
        chapter: clampText(unit?.chapter, 300),
        section: clampText(unit?.section, 500),
        chapterId: clampText(unit?.chapterId, 240),
        sectionId: clampText(unit?.sectionId, 240),
        passageId: clampText(unit?.passageId, 240),
        passageIds: [...new Set((Array.isArray(unit?.passageIds) ? unit.passageIds : [unit?.passageId])
          .map((id) => clampText(id, 240)).filter(Boolean))],
        paragraphId: clampText(unit?.paragraphId, 240),
        sentenceId: clampText(unit?.sentenceId, 240),
        granularity: ['sentence', 'paragraph', 'passage', 'section', 'chapter'].includes(unit?.granularity) ? unit.granularity : 'paragraph',
        start: Math.max(0, Number(unit?.start) || 0),
        end: Math.max(0, Number(unit?.end) || 0)
      })).filter((unit) => unit.unitId && unit.text.trim() && unit.end >= unit.start) : [];
      return {
        id: clampText(document?.id, 240),
        fingerprint: clampText(document?.fingerprint, 160),
        title: clampText(document?.title, 240),
        path: clampText(document?.path, 1_000),
        units
      };
    }).filter((document) => document.id && document.fingerprint && document.units.some((unit) => unit.granularity === 'sentence'));
  }

  runExclusive(task) {
    const next = this.operation.then(task, task);
    this.operation = next.catch(() => {});
    return next;
  }

  async loadMetadata() {
    if (this.metadataLoaded) return;
    this.metadataLoaded = true;
    if (!this.metadataFile) return;
    try {
      const saved = JSON.parse(await fs.promises.readFile(this.metadataFile, 'utf8'));
      const valid = saved
        && Number(saved.schemaVersion) === INDEX_SCHEMA_VERSION
        && Number(saved.settingsVersion) <= INDEX_SETTINGS_VERSION
        && saved.documents
        && typeof saved.documents === 'object';
      if (valid) {
        this.settingsDirty = Number(saved.settingsVersion) !== INDEX_SETTINGS_VERSION;
        this.metadata = {
          ...emptyMetadata(),
          ...saved,
          failures: saved.failures && typeof saved.failures === 'object' ? saved.failures : {}
        };
        this.metadata.settingsVersion = INDEX_SETTINGS_VERSION;
      }
      else this.resetIndex = true;
    } catch (error) {
      this.resetIndex = true;
      if (error?.code !== 'ENOENT') console.warn('本地搜索元数据无效，将重新建立索引', error);
    }
  }

  async persistMetadata() {
    if (!this.metadataFile) return;
    await fs.promises.mkdir(path.dirname(this.metadataFile), { recursive: true });
    const temporary = `${this.metadataFile}.tmp`;
    await fs.promises.writeFile(temporary, `${JSON.stringify(this.metadata, null, 2)}\n`);
    await fs.promises.rename(temporary, this.metadataFile);
  }

  errorSummary(error, category = 'semantic-search') {
    return {
      at: Date.now(),
      category,
      code: error?.code || '',
      message: String(error?.message || error || '本地语义搜索失败').slice(0, 1_000)
    };
  }

  recoverableIndexError(error) {
    if (error?.recoverableDatabase) return true;
    const evidence = [error?.code, error?.message, JSON.stringify(error?.payload || '')].join('\n');
    return /index_not_found|corrupt|corruption|invalid (?:database|store|page)|database.*(?:damaged|malformed)|internal.*(?:database|index)/i.test(evidence);
  }

  async recoverIndexStorage(error, progress) {
    if (this.recoveryAttempted || !this.recoverableIndexError(error)
      || typeof this.engine.recoverDataDirectory !== 'function') return false;
    this.recoveryAttempted = true;
    safeProgress(progress, { phase: 'recovering', message: '正在修复本地搜索索引，原索引将保留备份' });
    const recovery = await this.engine.recoverDataDirectory(error?.code || 'index-failure');
    let metadataArchive = '';
    if (this.metadataFile) {
      const existing = await fs.promises.stat(this.metadataFile).catch(() => null);
      if (existing) {
        metadataArchive = `${this.metadataFile}.recovery-${recovery.suffix}`;
        await fs.promises.rename(this.metadataFile, metadataArchive);
      }
    }
    this.client = null;
    this.indexReady = false;
    this.resetIndex = false;
    this.metadataLoaded = true;
    this.metadata = emptyMetadata();
    this.lastRecovery = {
      at: Date.now(),
      dataArchive: recovery.archivePath || '',
      metadataArchive
    };
    await this.persistMetadata();
    return true;
  }

  async ensureIndexAttempt(progress) {
    await this.loadMetadata();
    if (this.indexReady && this.client) {
      if (typeof this.client.health !== 'function') return this.client;
      try {
        const health = await this.client.health();
        if (health?.status === 'available') return this.client;
      } catch (_error) {
        this.client = null;
        this.indexReady = false;
      }
    }
    safeProgress(progress, { phase: 'engine', message: '正在启动本地搜索服务' });
    const client = await this.engine.start();
    this.client = client;
    const version = await client.version();
    this.engineVersion = version?.pkgVersion || version?.commitSha || '';
    if (this.resetIndex) {
      try { await client.waitTask(await client.deleteIndex(INDEX_UID)); }
      catch (error) {
        const missing = error instanceof MeilisearchHttpError
          && (error.status === 404 || error.code === 'index_not_found');
        if (!missing) throw error;
      }
      this.metadata = emptyMetadata();
      this.resetIndex = false;
    }
    let createdIndex = false;
    try {
      await client.waitTask(await client.createIndex(INDEX_UID, 'id'));
      createdIndex = true;
      this.settingsDirty = true;
    } catch (error) {
      if (!(error instanceof MeilisearchHttpError) || error.code !== 'index_already_exists') throw error;
    }
    const expectedRecords = Object.values(this.metadata.documents)
      .reduce((sum, document) => sum + (document.recordCount || 0), 0);
    const stats = await client.indexStats(INDEX_UID);
    if (createdIndex && expectedRecords) {
      // A newly created index cannot satisfy an old manifest. Discard only the
      // stale manifest; never delete an existing user index just because counts differ.
      this.metadata = emptyMetadata();
    } else if (!createdIndex && Number(stats?.numberOfDocuments) !== expectedRecords) {
      await this.engine.writeDiagnostic?.('index-count-mismatch', {
        expectedRecords,
        actualRecords: Number(stats?.numberOfDocuments) || 0,
        indexUid: INDEX_UID
      });
    }
    if (createdIndex || this.settingsDirty) {
      await client.waitTask(await client.updateSettings(INDEX_UID, {
        searchableAttributes: ['title', 'path', 'heading', 'text'],
        displayedAttributes: [
          'id', 'docId', 'fingerprint', 'recordRevision', 'title', 'path', 'unitId', 'granularity',
          'start', 'end', 'snippet', 'text', 'heading', 'chapter', 'section',
          'chapterId', 'sectionId', 'passageId', 'passageIds', 'paragraphId', 'sentenceId'
        ],
        filterableAttributes: [
          'docId', 'fingerprint', 'recordRevision', 'granularity', 'chapterId',
          'sectionId', 'passageId', 'passageIds', 'paragraphId'
        ],
        rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
        embedders: { [EMBEDDER_NAME]: { source: 'userProvided', dimensions: MODEL_DIMENSIONS } }
      }));
      this.settingsDirty = false;
    }
    this.metadata.engineVersion = this.engineVersion;
    await this.persistMetadata();
    this.indexReady = true;
    safeProgress(progress, { phase: 'engine-ready', message: '本地搜索服务已就绪' });
    return client;
  }

  async ensureIndexWithRecovery(progress) {
    try {
      const client = await this.ensureIndexAttempt(progress);
      this.lastServiceError = null;
      return client;
    } catch (error) {
      this.lastServiceError = this.errorSummary(error, 'engine');
      if (!await this.recoverIndexStorage(error, progress)) throw error;
      try {
        const client = await this.ensureIndexAttempt(progress);
        this.lastServiceError = null;
        safeProgress(progress, { phase: 'engine-ready', message: '本地搜索索引已恢复' });
        return client;
      } catch (retryError) {
        this.lastServiceError = this.errorSummary(retryError, 'engine-recovery');
        throw retryError;
      }
    }
  }

  async ensureIndex(progress) {
    if (this.ensuringIndex) return this.ensuringIndex;
    this.ensuringIndex = this.ensureIndexWithRecovery(progress);
    try {
      return await this.ensuringIndex;
    } finally {
      this.ensuringIndex = null;
    }
  }

  async status() {
    await this.loadMetadata();
    let modelAvailable = false;
    let engineAvailable = false;
    try { modelAvailable = fs.statSync(this.modelFile()).isFile(); } catch (_error) { /* Report below. */ }
    try { engineAvailable = fs.statSync(this.binaryPath).isFile(); } catch (_error) { /* Report below. */ }
    const engineDiagnostic = typeof this.engine.diagnosticStatus === 'function'
      ? this.engine.diagnosticStatus()
      : {};
    return {
      available: modelAvailable && engineAvailable,
      modelAvailable,
      engineAvailable,
      unavailableReason: !modelAvailable
        ? '本地语义模型缺失，请重新安装观绎 MD'
        : (!engineAvailable ? '本地搜索服务缺失，请重新安装观绎 MD' : ''),
      modelReady: !!this.extractor,
      engine: 'Meilisearch',
      engineReady: !!this.client,
      engineVersion: this.engineVersion || this.metadata.engineVersion || '',
      modelId: MODEL_ID,
      modelRevision: MODEL_REVISION,
      modelSha256: MODEL_SHA256,
      dimensions: MODEL_DIMENSIONS,
      indexedDocuments: Object.keys(this.metadata.documents).length,
      indexedChunks: Object.values(this.metadata.documents).reduce((sum, document) => sum + (document.recordCount || 0), 0),
      indexedDocumentFingerprints: Object.fromEntries(Object.entries(this.metadata.documents)
        .map(([id, document]) => [id, document.fingerprint || ''])),
      failedDocuments: Object.values(this.metadata.failures || {}).filter((failure) => !failure?.resolvedAt).length,
      updatedAt: this.metadata.updatedAt || 0,
      lastError: this.lastServiceError || engineDiagnostic.lastError || null,
      lastRecovery: this.lastRecovery || engineDiagnostic.lastRecovery || null,
      diagnosticRecorded: !!engineDiagnostic.logFile
    };
  }

  activeDocumentFilter(baseFilter = '') {
    const fingerprints = [...new Set(Object.values(this.metadata.documents || {})
      .map((entry) => clampText(entry?.fingerprint, 160)).filter(Boolean))];
    if (!fingerprints.length) return baseFilter || '';
    const active = `fingerprint IN [${fingerprints.map(meiliString).join(', ')}]`;
    return baseFilter ? `(${active}) AND (${baseFilter})` : active;
  }

  async recordIndexFailure(error, context = {}) {
    const failure = {
      at: Date.now(),
      code: error?.code || '',
      message: String(error?.message || error || 'Meilisearch 写入失败').slice(0, 1_000),
      ...context
    };
    const key = context.documentId || `batch-${Date.now()}`;
    this.metadata.failures = this.metadata.failures || {};
    this.metadata.failures[key] = { ...(this.metadata.failures[key] || {}), ...failure };
    await this.engine.writeDiagnostic?.('index-write-failed', failure);
    return failure;
  }

  documentScopedIndexError(error) {
    const evidence = [error?.name, error?.code, error?.message, JSON.stringify(error?.payload || '')].join('\n');
    return /malformed_payload|invalid_document|payload_too_large|unexpected end of hex escape|lone surrogate|invalid unicode/i.test(evidence);
  }

  retryableIndexError(error) {
    if (this.documentScopedIndexError(error)) return false;
    const evidence = [error?.code, error?.message].join('\n');
    return Number(error?.status) === 429
      || Number(error?.status) >= 500
      || /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|请求超时|temporar|service unavailable|too many requests/i.test(evidence);
  }

  recordFor(document, unit, vector, recordRevision = '') {
    return {
      id: recordId(document.id, unit.unitId, recordRevision),
      docId: document.id,
      fingerprint: document.fingerprint,
      ...(recordRevision ? { recordRevision } : {}),
      title: document.title,
      path: document.path,
      unitId: unit.unitId,
      granularity: unit.granularity,
      start: unit.start,
      end: unit.end,
      snippet: unit.snippet,
      text: unit.text,
      heading: unit.heading,
      chapter: unit.chapter,
      section: unit.section,
      chapterId: unit.chapterId,
      sectionId: unit.sectionId,
      passageId: unit.passageId,
      passageIds: unit.passageIds,
      paragraphId: unit.paragraphId,
      sentenceId: unit.sentenceId,
      _vectors: { [EMBEDDER_NAME]: Array.from(vector) }
    };
  }

  async addRecordBatch(client, records, context = {}, attempt = 0) {
    if (!records.length) return 0;
    try {
      await client.waitTask(await client.addDocuments(INDEX_UID, records));
      return records.length;
    } catch (error) {
      if (attempt < 2 && this.retryableIndexError(error)) {
        const retry = attempt + 1;
        await this.engine.writeDiagnostic?.('index-write-retry', {
          at: Date.now(),
          ...context,
          attempt: retry,
          recordCount: records.length,
          code: error?.code || '',
          message: String(error?.message || error).slice(0, 500)
        });
        await delay(180 * (2 ** attempt));
        return this.addRecordBatch(client, records, context, retry);
      }
      if (records.length === 1) {
        await this.recordIndexFailure(error, {
          ...context,
          unitId: records[0]?.unitId || '',
          granularity: records[0]?.granularity || '',
          recordId: records[0]?.id || ''
        });
        throw error;
      }
      const middle = Math.ceil(records.length / 2);
      const left = await this.addRecordBatch(client, records.slice(0, middle), context);
      const right = await this.addRecordBatch(client, records.slice(middle), context);
      return left + right;
    }
  }

  async addRecordBatches(client, records, context = {}) {
    let written = 0;
    for (let offset = 0; offset < records.length; offset += DOCUMENT_BATCH_SIZE) {
      written += await this.addRecordBatch(
        client,
        records.slice(offset, offset + DOCUMENT_BATCH_SIZE),
        { ...context, batchOffset: offset }
      );
    }
    return written;
  }

  async indexOneDocument(client, document, progress, completed, total) {
    const previous = this.metadata.documents[document.id];
    const recordRevision = crypto.randomBytes(12).toString('hex');
    let committed = false;
    const context = {
      documentId: document.id,
      title: document.title,
      path: document.path,
      fingerprint: document.fingerprint,
      recordRevision
    };

    try {
      const sentences = document.units.filter((unit) => unit.granularity === 'sentence');
      const accumulators = {
        paragraph: new VectorAccumulator(),
        passage: new VectorAccumulator(),
        section: new VectorAccumulator(),
        chapter: new VectorAccumulator()
      };
      let recordCount = 0;
      const sentenceRecordBuffer = [];
      let pendingSentenceWrite = Promise.resolve();
      let pendingWriteError = null;
      for (let offset = 0; offset < sentences.length; offset += EMBEDDING_BATCH_SIZE) {
        if (pendingWriteError) throw pendingWriteError;
        const batch = sentences.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        const vectors = await this.embed(batch.map((unit) => unit.semanticText), progress, completed + offset, total);
        const records = batch.map((unit, index) => {
          const vector = vectors[index];
          accumulators.paragraph.add(unit.paragraphId, vector);
          unit.passageIds.forEach((passageId) => accumulators.passage.add(passageId, vector));
          accumulators.section.add(unit.sectionId, vector);
          accumulators.chapter.add(unit.chapterId, vector);
          const record = this.recordFor(document, unit, vector, recordRevision);
          recordCount += 1;
          return record;
        });
        sentenceRecordBuffer.push(...records);
        if (sentenceRecordBuffer.length >= DOCUMENT_BATCH_SIZE) {
          const recordsToWrite = sentenceRecordBuffer.splice(0);
          pendingSentenceWrite = pendingSentenceWrite
            .then(() => this.addRecordBatches(client, recordsToWrite, context))
            .catch((error) => { pendingWriteError = error; });
        }
      }
      await pendingSentenceWrite;
      if (pendingWriteError) throw pendingWriteError;
      await this.addRecordBatches(client, sentenceRecordBuffer, context);

      const parentRecords = [];
      for (const unit of document.units.filter((candidate) => candidate.granularity !== 'sentence')) {
        const key = unit.granularity === 'paragraph' ? unit.paragraphId
          : unit.granularity === 'passage' ? unit.passageId
            : unit.granularity === 'section' ? unit.sectionId
              : unit.chapterId;
        const vector = accumulators[unit.granularity]?.normalized(key);
        if (!vector) continue;
        const record = this.recordFor(document, unit, vector, recordRevision);
        parentRecords.push(record);
        recordCount += 1;
      }
      await this.addRecordBatches(client, parentRecords, context);

      this.metadata.documents[document.id] = {
        fingerprint: document.fingerprint,
        recordRevision,
        recordCount,
        updatedAt: Date.now()
      };
      delete this.metadata.failures?.[document.id];
      this.metadata.updatedAt = Date.now();
      await this.persistMetadata();
      committed = true;

      if (previous?.recordCount) {
        const oldVersion = previous.recordRevision
          ? `recordRevision = ${meiliString(previous.recordRevision)}`
          : `fingerprint = ${meiliString(previous.fingerprint)}`;
        try {
          await client.waitTask(await client.deleteDocumentsByFilter(
            INDEX_UID,
            `docId = ${meiliString(document.id)} AND ${oldVersion}`
          ));
        } catch (cleanupError) {
          await this.recordIndexFailure(cleanupError, { ...context, phase: 'old-version-cleanup' });
        }
      }
      return sentences.length;
    } catch (error) {
      if (committed) throw error;
      await this.recordIndexFailure(error, context);
      try {
        await client.waitTask(await client.deleteDocumentsByFilter(
          INDEX_UID,
          `docId = ${meiliString(document.id)} AND recordRevision = ${meiliString(recordRevision)}`
        ));
      } catch (cleanupError) {
        await this.recordIndexFailure(cleanupError, { ...context, phase: 'cleanup' });
      }
      await this.persistMetadata();
      throw error;
    }
  }

  indexDocuments(rawDocuments, options = {}, progress) {
    return this.runExclusive(async () => {
      try {
        const client = await this.ensureIndex(progress);
      const documents = this.sanitizeDocuments(rawDocuments);
      const suppliedActiveIds = Array.isArray(options.activeDocumentIds)
        ? options.activeDocumentIds.map((id) => clampText(id, 240)).filter(Boolean)
        : null;
      const activeIds = new Set(suppliedActiveIds || documents.map((document) => document.id));
      const force = !!options.force;

      if (options.prune !== false) {
        for (const [docId, saved] of Object.entries(this.metadata.documents)) {
          if (activeIds.has(docId)) continue;
          if (saved.recordCount) await client.waitTask(await client.deleteDocumentsByFilter(INDEX_UID, `docId = ${meiliString(docId)}`));
          delete this.metadata.documents[docId];
        }
      }

      const stale = documents.filter((document) => force
        || this.metadata.documents[document.id]?.fingerprint !== document.fingerprint);
      const total = stale.reduce((sum, document) => sum + document.units.filter((unit) => unit.granularity === 'sentence').length, 0);
      let completed = 0;
      const failedDocuments = [];
      if (total) {
        safeProgress(progress, { phase: 'indexing', completed: 0, total, message: `准备建立 ${total} 个句子的分层索引` });
        for (const document of stale) {
          const sentenceCount = document.units.filter((unit) => unit.granularity === 'sentence').length;
          try {
            completed += await this.indexOneDocument(client, document, progress, completed, total);
          } catch (error) {
            if (!this.documentScopedIndexError(error) && !this.retryableIndexError(error)) throw error;
            completed += sentenceCount;
            failedDocuments.push({ id: document.id, title: document.title, message: String(error?.message || error).slice(0, 300) });
            safeProgress(progress, {
              phase: 'indexing-warning',
              completed,
              total,
              message: `“${document.title || document.id}”索引失败，已保留旧版本并继续处理其他文档`
            });
            if (this.retryableIndexError(error)) break;
          }
        }
      }
      this.metadata.updatedAt = Date.now();
      await this.persistMetadata();
      safeProgress(progress, { phase: 'ready', message: '本地分层索引已就绪' });
        const status = await this.status();
        this.lastServiceError = null;
        return { ...status, lastIndexRun: { attempted: stale.length, failedDocuments } };
      } catch (error) {
        this.lastServiceError = this.errorSummary(error, 'index');
        throw error;
      }
    });
  }

  searchParameters(query, queryVector, limit, filter, rankingScoreThreshold = MIN_RANKING_SCORE) {
    return {
      q: query,
      vector: Array.from(queryVector),
      hybrid: { embedder: EMBEDDER_NAME, semanticRatio: HYBRID_SEMANTIC_RATIO },
      filter: this.activeDocumentFilter(filter),
      limit,
      rankingScoreThreshold,
      showRankingScore: true,
      showRankingScoreDetails: true,
      attributesToRetrieve: [
        'id', 'docId', 'title', 'path', 'unitId', 'granularity', 'start', 'end',
        'snippet', 'text', 'heading', 'chapter', 'section', 'chapterId', 'sectionId',
        'passageId', 'passageIds', 'paragraphId', 'sentenceId'
      ]
    };
  }

  semanticSearchParameters(query, queryVector, limit, filter) {
    return {
      ...this.searchParameters(query, queryVector, limit, filter),
      hybrid: { embedder: EMBEDDER_NAME, semanticRatio: PURE_SEMANTIC_RATIO },
      rankingScoreThreshold: PURE_SEMANTIC_MIN_SCORE
    };
  }

  lexicalSearchParameters(query, limit, filter = '') {
    const sentenceFilter = `granularity = ${meiliString('sentence')}`;
    const scopedFilter = filter ? `(${filter}) AND (${sentenceFilter})` : sentenceFilter;
    return {
      q: query,
      filter: this.activeDocumentFilter(scopedFilter),
      limit,
      showRankingScore: true,
      showRankingScoreDetails: true,
      attributesToRetrieve: [
        'id', 'docId', 'title', 'path', 'unitId', 'granularity', 'start', 'end',
        'snippet', 'text', 'heading', 'chapter', 'section', 'chapterId', 'sectionId',
        'passageId', 'passageIds', 'paragraphId', 'sentenceId'
      ]
    };
  }

  hierarchyFilter(hit) {
    const filters = [`granularity = ${meiliString('sentence')}`, `docId = ${meiliString(hit.docId)}`];
    if (hit.granularity === 'paragraph') filters.push(`paragraphId = ${meiliString(hit.paragraphId)}`);
    else if (hit.granularity === 'passage') filters.push(`passageIds = ${meiliString(hit.passageId)}`);
    else if (hit.granularity === 'section') filters.push(`sectionId = ${meiliString(hit.sectionId)}`);
    else if (hit.granularity === 'chapter') filters.push(`chapterId = ${meiliString(hit.chapterId)}`);
    return filters.join(' AND ');
  }

  sentenceBelongsToHierarchy(sentence, parent) {
    if (!sentence || !parent || sentence.docId !== parent.docId || sentence.granularity !== 'sentence') return false;
    if (parent.granularity === 'paragraph') return sentence.paragraphId === parent.paragraphId;
    if (parent.granularity === 'passage') return Array.isArray(sentence.passageIds)
      ? sentence.passageIds.includes(parent.passageId)
      : sentence.passageId === parent.passageId;
    if (parent.granularity === 'section') return sentence.sectionId === parent.sectionId;
    if (parent.granularity === 'chapter') return sentence.chapterId === parent.chapterId;
    return false;
  }

  materialize(candidate, evidence, query, queryTerms) {
    const visibleText = [evidence.title, evidence.path, evidence.heading, evidence.text, evidence.snippet].filter(Boolean).join('\n');
    const highlightTerms = matchedQueryTerms(queryTerms, visibleText);
    const fields = [];
    if (matchedQueryTerms(queryTerms, evidence.title).length) fields.push('name');
    if (matchedQueryTerms(queryTerms, evidence.path).length) fields.push('path');
    if (matchedQueryTerms(queryTerms, `${evidence.text}\n${evidence.snippet}`).length) fields.push('content');
    fields.push('semantic');
    const rankingScore = Number(evidence._rankingScore) || Number(candidate._rankingScore) || 0;
    const rrfScore = Number(candidate._rrfScore) || 0;
    const lexicalBoost = lexicalBoostForTerms(highlightTerms);
    const exactPhrase = normalizeSearchText(visibleText).includes(normalizeSearchText(query)) ? 1 : 0;
    const fragmentCoverage = queryFragmentCoverage(query, visibleText);
    const intentScore = intentEvidenceScore(query, visibleText);
    const echoPenalty = queryEchoPenalty(query, visibleText);
    const queryLength = Math.max(1, normalizeSearchText(query).length);
    const longestHighlight = highlightTerms.reduce((maximum, term) => Math.max(maximum, normalizeSearchText(term).length), 0);
    const stableFragmentBoost = Math.min(0.55, (longestHighlight / queryLength) * 0.6);
    const channelDiversity = Math.min(0.2, new Set(candidate._recallChannels || []).size * 0.04);
    return {
      docId: evidence.docId,
      title: evidence.title,
      path: evidence.path,
      start: Number(evidence.start) || 0,
      end: Number(evidence.end) || 0,
      snippet: focusedSnippet(evidence.snippet || evidence.text, highlightTerms),
      heading: evidence.heading || candidate.heading || '',
      chapter: evidence.chapter || candidate.chapter || '',
      section: evidence.section || candidate.section || '',
      granularity: 'sentence',
      matchedGranularity: candidate.granularity || 'sentence',
      passageId: evidence.passageId || '',
      passageIds: Array.isArray(evidence.passageIds) ? evidence.passageIds : [],
      paragraphId: evidence.paragraphId || '',
      highlightTerms,
      fields,
      semanticScore: rankingScore,
      rrfScore,
      fragmentCoverage,
      intentScore,
      echoPenalty,
      lexicalBoost,
      score: rankingScore * 2.4
        + rrfScore * 5
        + exactPhrase * 1.25
        + fragmentCoverage * 0.75
        + intentScore * 0.9
        + stableFragmentBoost
        + lexicalBoost
        + channelDiversity
        - echoPenalty * 3.5
    };
  }

  search(rawQuery, rawLimit, rawOptions, progress) {
    return (async () => {
      try {
      if (typeof rawOptions === 'function' && progress === undefined) {
        progress = rawOptions;
        rawOptions = null;
      }
      const query = clampText(rawQuery, 500).trim();
      if (!query) return [];
      const hasDocumentScope = !!rawOptions && Object.prototype.hasOwnProperty.call(rawOptions, 'docIds');
      const scopedDocumentIds = [...new Set((Array.isArray(rawOptions?.docIds) ? rawOptions.docIds : [])
        .map((id) => clampText(id, 240).trim()).filter(Boolean))];
      if (hasDocumentScope && !scopedDocumentIds.length) return [];
      const documentScopeFilter = scopedDocumentIds.length
        ? `docId IN [${scopedDocumentIds.map(meiliString).join(', ')}]`
        : '';
      const scopedFilter = (filter = '') => {
        if (!documentScopeFilter) return filter;
        return filter ? `(${documentScopeFilter}) AND (${filter})` : documentScopeFilter;
      };
      const client = await this.ensureIndex(progress);
      if (!Object.keys(this.metadata.documents).length) throw new Error('尚未建立本地语义索引');
      safeProgress(progress, { phase: 'searching', message: '正在统一检索关键词与相关内容' });
      const semanticText = semanticQueryText(query);
      const [queryVector, expandedQueryVector] = await this.queryVectors(query, semanticText, progress);
      const limit = Math.max(1, Math.min(50, Number(rawLimit) || 15));
      const sentenceFilter = `granularity = ${meiliString('sentence')}`;
      const parentFilter = `granularity != ${meiliString('sentence')}`;
      const queryVariants = [...new Set([
        ...retrievalQueryVariants(query),
        ...intentRetrievalVariants(query)
      ])].slice(0, 20);
      const [hybrid, semanticSentences, expandedSentences, semanticParents, lexical] = await Promise.all([
        client.search(INDEX_UID, this.searchParameters(query, queryVector, INTERNAL_SENTENCE_CANDIDATES, scopedFilter())),
        client.search(INDEX_UID, this.semanticSearchParameters(query, queryVector, INTERNAL_SENTENCE_CANDIDATES, scopedFilter(sentenceFilter))),
        client.search(INDEX_UID, this.semanticSearchParameters(semanticText, expandedQueryVector, INTERNAL_SENTENCE_CANDIDATES, scopedFilter(sentenceFilter))),
        client.search(INDEX_UID, this.semanticSearchParameters(semanticText, expandedQueryVector, INTERNAL_PARENT_CANDIDATES, scopedFilter(parentFilter))),
        client.multiSearch(queryVariants.map((variant) => ({
          indexUid: INDEX_UID,
          ...this.lexicalSearchParameters(variant, INTERNAL_LEXICAL_CANDIDATES, documentScopeFilter)
        })))
      ]);
      const lexicalChannels = queryVariants.map((variant, index) => {
        const normalizedLength = normalizeSearchText(variant).length;
        const queryLength = Math.max(1, normalizeSearchText(query).length);
        const intentVariant = variant.includes(' ');
        const weight = QUERY_NEGATIONS.has(variant)
          ? 0.12
          : (index === 0 ? 1.35 : intentVariant ? 1.05 : 0.35 + Math.min(0.85, normalizedLength / queryLength));
        return { name: `lexical:${variant}`, weight, hits: lexical?.results?.[index]?.hits || [] };
      });
      const fused = reciprocalRankFusion([
        { name: 'hybrid', weight: 1.15, hits: hybrid?.hits || [] },
        { name: 'semantic-sentence', weight: 1, hits: semanticSentences?.hits || [] },
        { name: 'semantic-expanded', weight: 1.08, hits: expandedSentences?.hits || [] },
        { name: 'semantic-parent', weight: 0.5, hits: semanticParents?.hits || [] },
        ...lexicalChannels
      ]);
      const candidates = fused.map((entry) => ({
        ...entry.hit,
        _rankingScore: Math.max(Number(entry.hit?._rankingScore) || 0, entry.bestRankingScore),
        _rrfScore: entry.rrfScore,
        _recallChannels: entry.channels
      }));
      const hierarchyCandidates = candidates
        .filter((hit) => hit.granularity !== 'sentence')
        .slice(0, INTERNAL_PARENT_CANDIDATES * 2);
      const sentenceCandidates = candidates.filter((hit) => hit.granularity === 'sentence');
      hierarchyCandidates.forEach((parent) => {
        parent.evidence = sentenceCandidates
          .filter((sentence) => this.sentenceBelongsToHierarchy(sentence, parent))
          .sort((left, right) => (Number(right._rankingScore) || 0) - (Number(left._rankingScore) || 0))[0];
      });
      const unresolvedHierarchy = hierarchyCandidates
        .filter((hit) => !hit.evidence)
        .slice(0, Math.min(INTERNAL_PARENT_EVIDENCE_QUERIES, limit));
      if (unresolvedHierarchy.length) {
        const evidenceResponse = await client.multiSearch(unresolvedHierarchy.map((hit) => ({
          indexUid: INDEX_UID,
          ...this.semanticSearchParameters(semanticText, expandedQueryVector, 2, this.hierarchyFilter(hit)),
          rankingScoreThreshold: 0.05
        })));
        (evidenceResponse?.results || []).forEach((result, index) => {
          const evidence = result?.hits?.[0];
          if (evidence) unresolvedHierarchy[index].evidence = evidence;
        });
      }

      const queryTerms = semanticQueryTerms(query);
      const materialized = [];
      for (const candidate of candidates) {
        if (candidate.granularity === 'sentence') materialized.push(this.materialize(candidate, candidate, query, queryTerms));
        else if (candidate.evidence) materialized.push(this.materialize(candidate, candidate.evidence, query, queryTerms));
      }
      const bestByAnchor = new Map();
      materialized.forEach((result) => {
        const key = `${result.docId}:${result.start}:${result.end}`;
        const previous = bestByAnchor.get(key);
        if (!previous || result.score > previous.score) bestByAnchor.set(key, result);
      });
      const results = diversifySearchResults([...bestByAnchor.values()], limit);
      safeProgress(progress, { phase: 'ready', message: '本地统一搜索完成' });
        this.lastServiceError = null;
        return results;
      } catch (error) {
        this.lastServiceError = this.errorSummary(error, 'search');
        throw error;
      }
    })();
  }

  async dispose() {
    try { await this.extractor?.dispose?.(); } catch (_error) { /* Process is exiting. */ }
    this.extractor = null;
    await this.engine.dispose();
  }
}

module.exports = {
  SemanticSearchService,
  INDEX_SCHEMA_VERSION,
  INDEX_UID,
  INDEX_SETTINGS_VERSION,
  EMBEDDER_NAME,
  MODEL_ID,
  MODEL_REVISION,
  MODEL_SHA256,
  MODEL_DIMENSIONS,
  EMBEDDING_BATCH_SIZE,
  DOCUMENT_BATCH_SIZE,
  ONNX_SESSION_OPTIONS,
  QUERY_PREFIX,
  toWellFormedText,
  clampText,
  normalizeSearchText,
  retrievalQueryVariants,
  semanticQueryTerms,
  semanticQueryText,
  matchedQueryTerms,
  lexicalBoostForTerms,
  queryFragmentCoverage,
  reciprocalRankFusion,
  textNgramSimilarity,
  diversifySearchResults,
  intentEvidenceScore,
  intentRetrievalVariants,
  queryEchoPenalty,
  focusedSnippet,
  meanNormalizedVector,
  recordId
};
