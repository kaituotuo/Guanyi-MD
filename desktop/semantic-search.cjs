const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { MeilisearchHttpError, MeilisearchProcess } = require('./meilisearch-process.cjs');

const INDEX_SCHEMA_VERSION = 4;
const INDEX_UID = `guanyi_content_v${INDEX_SCHEMA_VERSION}`;
const INDEX_SETTINGS_VERSION = 2;
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
const EMBEDDING_BATCH_SIZE = 16;
const DOCUMENT_BATCH_SIZE = 32;
const HYBRID_SEMANTIC_RATIO = 0.58;
const PURE_SEMANTIC_RATIO = 1;
const MIN_RANKING_SCORE = 0.2;
const PURE_SEMANTIC_MIN_SCORE = 0.35;
const SEMANTIC_QUERY_STOP_TERMS = new Set([
  '什么', '怎么', '如何', '为何', '为什么', '哪里', '哪儿', '哪个', '哪些',
  '是谁', '谁的', '是否', '是不是', '有没有', '请问', '一下'
]);

function clampText(value, limit) {
  return String(value || '').slice(0, limit);
}

function safeProgress(progress, payload) {
  try { progress?.(payload); } catch (_error) { /* Renderer may have closed. */ }
}

function semanticQueryTerms(rawQuery) {
  const value = String(rawQuery || '').trim().toLowerCase();
  const terms = new Set(value.split(/[\s,，。；;、/\\：:]+/).filter(Boolean));
  for (const sequence of value.match(/[\u3400-\u9fff]+/g) || []) {
    const maximum = Math.min(6, sequence.length);
    for (let length = maximum; length >= 2; length -= 1) {
      for (let start = 0; start + length <= sequence.length; start += 1) terms.add(sequence.slice(start, start + length));
    }
  }
  return [...terms].filter((term) => term.length >= 2 && !SEMANTIC_QUERY_STOP_TERMS.has(term));
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
  return Math.min(0.24, (terms || []).reduce((score, term) => score + Math.max(0.055, (term.length - 1) * 0.055), 0));
}

function focusedSnippet(rawText, terms, limit = 360) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const lower = text.toLowerCase();
  let matchIndex = -1;
  for (const term of terms || []) {
    matchIndex = lower.indexOf(String(term).toLowerCase());
    if (matchIndex >= 0) break;
  }
  if (matchIndex < 0) return `${text.slice(0, limit).trim()}…`;
  const left = Math.max(0, matchIndex - Math.floor(limit * 0.32));
  const right = Math.min(text.length, left + limit);
  return `${left ? '…' : ''}${text.slice(left, right).trim()}${right < text.length ? '…' : ''}`;
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

function recordId(docId, unitId) {
  return crypto.createHash('sha256').update(`${docId}\0${unitId}`).digest('hex');
}

function emptyMetadata() {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    settingsVersion: INDEX_SETTINGS_VERSION,
    updatedAt: 0,
    engineVersion: '',
    documents: {}
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
  constructor({ modelDir, binaryPath, dataDir, metadataFile, engine }) {
    this.modelDir = modelDir;
    this.binaryPath = binaryPath;
    this.dataDir = dataDir;
    this.metadataFile = metadataFile || (dataDir ? path.join(dataDir, 'guanyi-index-metadata.json') : null);
    this.engine = engine || new MeilisearchProcess({
      binaryPath,
      dataDir: path.join(dataDir, 'meilisearch-db'),
      keyFile: path.join(dataDir, 'master-key')
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
    this.operation = Promise.resolve();
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
        local_files_only: true
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

  async embed(texts, progress, completed, total) {
    const extractor = await this.ensureModel(progress);
    const output = await extractor(texts, { pooling: 'cls', normalize: true });
    if (!output?.data || output.dims?.at(-1) !== MODEL_DIMENSIONS) throw new Error('本地语义模型返回了无法识别的向量');
    const vectors = [];
    for (let index = 0; index < texts.length; index += 1) {
      const start = index * MODEL_DIMENSIONS;
      vectors.push(new Float32Array(output.data.slice(start, start + MODEL_DIMENSIONS)));
    }
    safeProgress(progress, {
      phase: 'indexing',
      completed: completed + texts.length,
      total,
      message: `正在建立本地索引 ${completed + texts.length}/${total}`
    });
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
        && saved.schemaVersion === INDEX_SCHEMA_VERSION
        && saved.settingsVersion === INDEX_SETTINGS_VERSION
        && saved.documents
        && typeof saved.documents === 'object';
      if (valid) this.metadata = saved;
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

  async ensureIndex(progress) {
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
    } catch (error) {
      if (!(error instanceof MeilisearchHttpError) || error.code !== 'index_already_exists') throw error;
    }
    const expectedRecords = Object.values(this.metadata.documents)
      .reduce((sum, document) => sum + (document.recordCount || 0), 0);
    const stats = await client.indexStats(INDEX_UID);
    if ((createdIndex && expectedRecords) || Number(stats?.numberOfDocuments) !== expectedRecords) {
      await client.waitTask(await client.deleteIndex(INDEX_UID));
      await client.waitTask(await client.createIndex(INDEX_UID, 'id'));
      this.metadata = emptyMetadata();
    }
    await client.waitTask(await client.updateSettings(INDEX_UID, {
      searchableAttributes: ['title', 'path', 'heading', 'text'],
      displayedAttributes: [
        'id', 'docId', 'fingerprint', 'title', 'path', 'unitId', 'granularity',
        'start', 'end', 'snippet', 'text', 'heading', 'chapter', 'section',
        'chapterId', 'sectionId', 'passageId', 'passageIds', 'paragraphId', 'sentenceId'
      ],
      filterableAttributes: ['docId', 'granularity', 'chapterId', 'sectionId', 'passageId', 'passageIds', 'paragraphId'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
      embedders: { [EMBEDDER_NAME]: { source: 'userProvided', dimensions: MODEL_DIMENSIONS } }
    }));
    this.metadata.engineVersion = this.engineVersion;
    await this.persistMetadata();
    this.indexReady = true;
    safeProgress(progress, { phase: 'engine-ready', message: '本地搜索服务已就绪' });
    return client;
  }

  async status() {
    await this.loadMetadata();
    let modelAvailable = false;
    let engineAvailable = false;
    try { modelAvailable = fs.statSync(this.modelFile()).isFile(); } catch (_error) { /* Report below. */ }
    try { engineAvailable = fs.statSync(this.binaryPath).isFile(); } catch (_error) { /* Report below. */ }
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
      updatedAt: this.metadata.updatedAt || 0
    };
  }

  recordFor(document, unit, vector) {
    return {
      id: recordId(document.id, unit.unitId),
      docId: document.id,
      fingerprint: document.fingerprint,
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

  async addRecordBatches(client, records) {
    for (let offset = 0; offset < records.length; offset += DOCUMENT_BATCH_SIZE) {
      await client.waitTask(await client.addDocuments(INDEX_UID, records.slice(offset, offset + DOCUMENT_BATCH_SIZE)));
    }
  }

  async indexOneDocument(client, document, progress, completed, total) {
    const previous = this.metadata.documents[document.id];
    if (previous?.recordCount) await client.waitTask(await client.deleteDocumentsByFilter(INDEX_UID, `docId = ${meiliString(document.id)}`));
    delete this.metadata.documents[document.id];
    await this.persistMetadata();

    const sentences = document.units.filter((unit) => unit.granularity === 'sentence');
    const accumulators = {
      paragraph: new VectorAccumulator(),
      passage: new VectorAccumulator(),
      section: new VectorAccumulator(),
      chapter: new VectorAccumulator()
    };
    let recordCount = 0;
    const sentenceRecordBuffer = [];
    for (let offset = 0; offset < sentences.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = sentences.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const vectors = await this.embed(batch.map((unit) => unit.semanticText), progress, completed + offset, total);
      const records = batch.map((unit, index) => {
        const vector = vectors[index];
        accumulators.paragraph.add(unit.paragraphId, vector);
        unit.passageIds.forEach((passageId) => accumulators.passage.add(passageId, vector));
        accumulators.section.add(unit.sectionId, vector);
        accumulators.chapter.add(unit.chapterId, vector);
        const record = this.recordFor(document, unit, vector);
        recordCount += 1;
        return record;
      });
      sentenceRecordBuffer.push(...records);
      if (sentenceRecordBuffer.length >= DOCUMENT_BATCH_SIZE) {
        await this.addRecordBatches(client, sentenceRecordBuffer.splice(0));
      }
    }
    await this.addRecordBatches(client, sentenceRecordBuffer);

    const parentRecords = [];
    for (const unit of document.units.filter((candidate) => candidate.granularity !== 'sentence')) {
      const key = unit.granularity === 'paragraph' ? unit.paragraphId
        : unit.granularity === 'passage' ? unit.passageId
          : unit.granularity === 'section' ? unit.sectionId
            : unit.chapterId;
      const vector = accumulators[unit.granularity]?.normalized(key);
      if (!vector) continue;
      const record = this.recordFor(document, unit, vector);
      parentRecords.push(record);
      recordCount += 1;
    }
    await this.addRecordBatches(client, parentRecords);
    this.metadata.documents[document.id] = {
      fingerprint: document.fingerprint,
      recordCount,
      updatedAt: Date.now()
    };
    this.metadata.updatedAt = Date.now();
    await this.persistMetadata();
    return sentences.length;
  }

  indexDocuments(rawDocuments, options = {}, progress) {
    return this.runExclusive(async () => {
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
      if (total) {
        safeProgress(progress, { phase: 'indexing', completed: 0, total, message: `准备建立 ${total} 个句子的分层索引` });
        for (const document of stale) completed += await this.indexOneDocument(client, document, progress, completed, total);
      }
      this.metadata.updatedAt = Date.now();
      await this.persistMetadata();
      safeProgress(progress, { phase: 'ready', message: '本地分层索引已就绪' });
      return this.status();
    });
  }

  searchParameters(query, queryVector, limit, filter, rankingScoreThreshold = MIN_RANKING_SCORE) {
    return {
      q: query,
      vector: Array.from(queryVector),
      hybrid: { embedder: EMBEDDER_NAME, semanticRatio: HYBRID_SEMANTIC_RATIO },
      filter,
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

  semanticSearchParameters(query, queryVector, limit) {
    return {
      ...this.searchParameters(query, queryVector, limit),
      hybrid: { embedder: EMBEDDER_NAME, semanticRatio: PURE_SEMANTIC_RATIO },
      rankingScoreThreshold: PURE_SEMANTIC_MIN_SCORE
    };
  }

  mergeCandidateHits(...groups) {
    const merged = new Map();
    groups.flat().forEach((hit) => {
      if (!hit?.id) return;
      const previous = merged.get(hit.id);
      if (!previous || Number(hit._rankingScore) > Number(previous._rankingScore)) merged.set(hit.id, hit);
    });
    return [...merged.values()].sort((a, b) => Number(b._rankingScore) - Number(a._rankingScore));
  }

  hierarchyFilter(hit) {
    const filters = [`granularity = ${meiliString('sentence')}`, `docId = ${meiliString(hit.docId)}`];
    if (hit.granularity === 'paragraph') filters.push(`paragraphId = ${meiliString(hit.paragraphId)}`);
    else if (hit.granularity === 'passage') filters.push(`passageIds = ${meiliString(hit.passageId)}`);
    else if (hit.granularity === 'section') filters.push(`sectionId = ${meiliString(hit.sectionId)}`);
    else if (hit.granularity === 'chapter') filters.push(`chapterId = ${meiliString(hit.chapterId)}`);
    return filters.join(' AND ');
  }

  materialize(candidate, evidence, queryTerms) {
    const visibleText = [evidence.title, evidence.path, evidence.heading, evidence.text, evidence.snippet].filter(Boolean).join('\n');
    const highlightTerms = matchedQueryTerms(queryTerms, visibleText);
    const fields = [];
    if (matchedQueryTerms(queryTerms, evidence.title).length) fields.push('name');
    if (matchedQueryTerms(queryTerms, evidence.path).length) fields.push('path');
    if (matchedQueryTerms(queryTerms, `${evidence.text}\n${evidence.snippet}`).length) fields.push('content');
    fields.push('semantic');
    const rankingScore = Number(candidate._rankingScore) || 0;
    const lexicalBoost = lexicalBoostForTerms(highlightTerms);
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
      highlightTerms,
      fields,
      semanticScore: rankingScore,
      lexicalBoost,
      score: rankingScore + lexicalBoost
    };
  }

  search(rawQuery, rawLimit, progress) {
    return this.runExclusive(async () => {
      const query = clampText(rawQuery, 500).trim();
      if (!query) return [];
      const client = await this.ensureIndex(progress);
      if (!Object.keys(this.metadata.documents).length) throw new Error('尚未建立本地语义索引');
      safeProgress(progress, { phase: 'searching', message: '正在统一检索关键词与相关内容' });
      const [queryVector] = await this.embed([`${QUERY_PREFIX}${query}`], progress, 0, 1);
      const limit = Math.max(1, Math.min(50, Number(rawLimit) || 15));
      const candidateLimit = Math.max(60, limit * 4);
      const [hybrid, semantic] = await Promise.all([
        client.search(INDEX_UID, this.searchParameters(query, queryVector, candidateLimit)),
        client.search(INDEX_UID, this.semanticSearchParameters(query, queryVector, candidateLimit))
      ]);
      const candidates = this.mergeCandidateHits(
        Array.isArray(hybrid?.hits) ? hybrid.hits : [],
        Array.isArray(semantic?.hits) ? semantic.hits : []
      );
      const hierarchyCandidates = candidates.filter((hit) => hit.granularity !== 'sentence').slice(0, Math.max(20, limit * 2));
      if (hierarchyCandidates.length) {
        const evidenceResponse = await client.multiSearch(hierarchyCandidates.map((hit) => ({
          indexUid: INDEX_UID,
          ...this.searchParameters(query, queryVector, 1, this.hierarchyFilter(hit), 0.05)
        })));
        (evidenceResponse?.results || []).forEach((result, index) => {
          const evidence = result?.hits?.[0];
          if (evidence) hierarchyCandidates[index].evidence = evidence;
        });
      }

      const queryTerms = semanticQueryTerms(query);
      const materialized = [];
      for (const candidate of candidates) {
        if (candidate.granularity === 'sentence') materialized.push(this.materialize(candidate, candidate, queryTerms));
        else if (candidate.evidence) materialized.push(this.materialize(candidate, candidate.evidence, queryTerms));
      }
      const bestByAnchor = new Map();
      materialized.forEach((result) => {
        const key = `${result.docId}:${result.start}:${result.end}`;
        const previous = bestByAnchor.get(key);
        if (!previous || result.score > previous.score) bestByAnchor.set(key, result);
      });
      const results = [...bestByAnchor.values()]
        .sort((a, b) => b.score - a.score || a.start - b.start)
        .slice(0, limit);
      safeProgress(progress, { phase: 'ready', message: '本地统一搜索完成' });
      return results;
    });
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
  QUERY_PREFIX,
  semanticQueryTerms,
  matchedQueryTerms,
  lexicalBoostForTerms,
  focusedSnippet,
  meanNormalizedVector,
  recordId
};
