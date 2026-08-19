const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');

const INDEX_SCHEMA_VERSION = 3;
const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
const MODEL_REVISION = '75c43b069aac4d136ba6bc1122f995fedcfd2781';
const MODEL_SHA256 = 'b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5';
const MODEL_DIMENSIONS = 512;
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';
const MAX_DOCUMENTS = 500;
const MAX_CHUNKS_PER_DOCUMENT = 4096;
const MAX_CHUNK_LENGTH = 1600;
const MAX_SNIPPET_LENGTH = 1200;
const EMBEDDING_BATCH_SIZE = 8;
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
      for (let start = 0; start + length <= sequence.length; start += 1) {
        terms.add(sequence.slice(start, start + length));
      }
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
  return Math.min(0.28, (terms || []).reduce((score, term) => score + Math.max(0.065, (term.length - 1) * 0.065), 0));
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

function meanNormalizedVector(entries) {
  const vector = new Float32Array(MODEL_DIMENSIONS);
  let count = 0;
  for (const entry of entries || []) {
    if (!entry.vector || entry.vector.length !== MODEL_DIMENSIONS) continue;
    for (let index = 0; index < MODEL_DIMENSIONS; index += 1) vector[index] += entry.vector[index];
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

function aggregateEntry(document, entries, granularity, heading, aggregateValue) {
  const vector = meanNormalizedVector(entries);
  if (!vector) return null;
  return {
    docId: document.id,
    title: document.title,
    path: document.path,
    chunkIndex: -1,
    start: Math.min(...entries.map((entry) => entry.start)),
    end: Math.max(...entries.map((entry) => entry.end)),
    snippet: '',
    heading: heading || '',
    chapter: granularity === 'chapter' ? aggregateValue : '',
    section: granularity === 'section' ? aggregateValue : '',
    granularity,
    aggregate: true,
    aggregateKind: granularity,
    aggregateValue: aggregateValue || document.id,
    lexicalText: [document.title, document.path, heading].filter(Boolean).join('\n'),
    vector
  };
}

function aggregateDocumentEntries(document, entries) {
  const aggregates = [];
  const groupAndAppend = (field, granularity) => {
    const groups = new Map();
    entries.forEach((entry) => {
      const value = String(entry[field] || '').trim();
      if (!value) return;
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(entry);
    });
    groups.forEach((groupEntries, value) => {
      const aggregate = aggregateEntry(document, groupEntries, granularity, value, value);
      if (aggregate) aggregates.push(aggregate);
    });
  };
  groupAndAppend('section', 'section');
  groupAndAppend('chapter', 'chapter');
  const documentAggregate = aggregateEntry(document, entries, 'document', document.title, document.id);
  if (documentAggregate) aggregates.push(documentAggregate);
  return aggregates;
}

class SemanticSearchService {
  constructor({ modelDir, indexFile }) {
    this.modelDir = modelDir;
    this.indexFile = indexFile;
    this.extractor = null;
    this.loadingModel = null;
    this.indexLoaded = false;
    this.index = this.emptyIndex();
    this.operation = Promise.resolve();
    this.modelVerified = false;
  }

  emptyIndex() {
    return {
      schemaVersion: INDEX_SCHEMA_VERSION,
      modelId: MODEL_ID,
      modelRevision: MODEL_REVISION,
      modelSha256: MODEL_SHA256,
      dimensions: MODEL_DIMENSIONS,
      updatedAt: 0,
      documentFingerprints: {},
      entries: []
    };
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

  async ensureIndexLoaded() {
    if (this.indexLoaded) return;
    this.indexLoaded = true;
    if (!this.indexFile) return;
    try {
      const serialized = await fs.promises.readFile(this.indexFile);
      const saved = v8.deserialize(serialized);
      const valid = saved
        && saved.schemaVersion === INDEX_SCHEMA_VERSION
        && saved.modelId === MODEL_ID
        && saved.modelSha256 === MODEL_SHA256
        && saved.dimensions === MODEL_DIMENSIONS
        && saved.documentFingerprints
        && Array.isArray(saved.entries);
      if (valid) this.index = saved;
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('语义索引读取失败，将重新建立', error);
    }
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
    if (!output?.data || output.dims?.at(-1) !== MODEL_DIMENSIONS) {
      throw new Error('本地语义模型返回了无法识别的向量');
    }
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
    return rawDocuments.slice(0, MAX_DOCUMENTS).map((document) => ({
      id: clampText(document?.id, 240),
      fingerprint: clampText(document?.fingerprint, 160),
      title: clampText(document?.title, 240),
      path: clampText(document?.path, 1000),
      chunks: Array.isArray(document?.chunks)
        ? document.chunks.slice(0, MAX_CHUNKS_PER_DOCUMENT).map((chunk) => ({
          text: clampText(chunk?.text, MAX_CHUNK_LENGTH),
          snippet: clampText(chunk?.snippet, MAX_SNIPPET_LENGTH),
          heading: clampText(chunk?.heading, 240),
          chapter: clampText(chunk?.chapter, 240),
          section: clampText(chunk?.section, 320),
          granularity: ['sentence', 'paragraph', 'passage'].includes(chunk?.granularity) ? chunk.granularity : 'passage',
          start: Math.max(0, Number(chunk?.start) || 0),
          end: Math.max(0, Number(chunk?.end) || 0)
        })).filter((chunk) => chunk.text.trim())
        : []
    })).filter((document) => document.id && document.fingerprint && document.chunks.length);
  }

  runExclusive(task) {
    const next = this.operation.then(task, task);
    this.operation = next.catch(() => {});
    return next;
  }

  async persistIndex() {
    if (!this.indexFile) return;
    await fs.promises.mkdir(path.dirname(this.indexFile), { recursive: true });
    await fs.promises.writeFile(this.indexFile, v8.serialize(this.index));
  }

  async status() {
    await this.ensureIndexLoaded();
    let modelAvailable = false;
    try { modelAvailable = fs.statSync(this.modelFile()).isFile(); } catch (_error) { /* Report below. */ }
    return {
      available: modelAvailable,
      modelReady: !!this.extractor,
      modelId: MODEL_ID,
      modelRevision: MODEL_REVISION,
      modelSha256: MODEL_SHA256,
      dimensions: MODEL_DIMENSIONS,
      indexedDocuments: Object.keys(this.index.documentFingerprints).length,
      indexedChunks: this.index.entries.length,
      updatedAt: this.index.updatedAt || 0
    };
  }

  indexDocuments(rawDocuments, options = {}, progress) {
    return this.runExclusive(async () => {
      await this.ensureIndexLoaded();
      const documents = this.sanitizeDocuments(rawDocuments);
      const activeIds = new Set(documents.map((document) => document.id));
      const force = !!options.force;
      const previousEntryCount = this.index.entries.length;
      const previousDocumentCount = Object.keys(this.index.documentFingerprints).length;
      const stale = documents.filter((document) => force
        || this.index.documentFingerprints[document.id] !== document.fingerprint);
      const staleIds = new Set(stale.map((document) => document.id));
      this.index.entries = this.index.entries.filter((entry) => activeIds.has(entry.docId) && !staleIds.has(entry.docId));
      Object.keys(this.index.documentFingerprints).forEach((docId) => {
        if (!activeIds.has(docId) || staleIds.has(docId)) delete this.index.documentFingerprints[docId];
      });

      const pending = stale.flatMap((document) => document.chunks.map((chunk, chunkIndex) => ({
        docId: document.id,
        fingerprint: document.fingerprint,
        title: document.title,
        path: document.path,
        chunkIndex,
        ...chunk
      })));

      if (pending.length) {
        safeProgress(progress, { phase: 'indexing', completed: 0, total: pending.length, message: `准备建立 ${pending.length} 个文本片段的索引` });
        for (let offset = 0; offset < pending.length; offset += EMBEDDING_BATCH_SIZE) {
          const batch = pending.slice(offset, offset + EMBEDDING_BATCH_SIZE);
          const vectors = await this.embed(batch.map((entry) => entry.text), progress, offset, pending.length);
          batch.forEach((entry, index) => {
            const { text, fingerprint, ...metadata } = entry;
            this.index.entries.push({ ...metadata, aggregate: false, lexicalText: text, vector: vectors[index] });
            this.index.documentFingerprints[entry.docId] = fingerprint;
          });
        }
        stale.forEach((document) => {
          const baseEntries = this.index.entries.filter((entry) => entry.docId === document.id && !entry.aggregate);
          this.index.entries.push(...aggregateDocumentEntries(document, baseEntries));
        });
      }

      const changed = pending.length
        || staleIds.size
        || previousEntryCount !== this.index.entries.length
        || previousDocumentCount !== Object.keys(this.index.documentFingerprints).length;
      if (changed) {
        this.index.updatedAt = Date.now();
        await this.persistIndex();
      }
      safeProgress(progress, { phase: 'ready', message: '本地语义索引已就绪' });
      return this.status();
    });
  }

  search(rawQuery, rawLimit, progress) {
    return this.runExclusive(async () => {
      await this.ensureIndexLoaded();
      const query = clampText(rawQuery, 500).trim();
      if (!query) return [];
      if (!this.index.entries.length) throw new Error('尚未建立本地语义索引');
      safeProgress(progress, { phase: 'searching', message: '正在进行本地语义检索' });
      const [queryVector] = await this.embed([`${QUERY_PREFIX}${query}`], progress, 0, 1);
      const queryTerms = semanticQueryTerms(query);
      const scoredEntries = [];
      for (const entry of this.index.entries) {
        const vector = entry.vector;
        if (!vector || vector.length !== MODEL_DIMENSIONS) continue;
        let semanticScore = 0;
        for (let index = 0; index < MODEL_DIMENSIONS; index += 1) semanticScore += queryVector[index] * vector[index];
        const highlightTerms = matchedQueryTerms(queryTerms, entry.lexicalText || `${entry.title}\n${entry.path}\n${entry.heading}\n${entry.snippet}`);
        const lexicalBoost = lexicalBoostForTerms(highlightTerms);
        scoredEntries.push({ entry, semanticScore, lexicalBoost, highlightTerms, score: semanticScore + lexicalBoost });
      }

      const belongsToAggregate = (candidate, aggregate) => {
        if (candidate.entry.aggregate || candidate.entry.docId !== aggregate.entry.docId) return false;
        if (aggregate.entry.aggregateKind === 'document') return true;
        if (aggregate.entry.aggregateKind === 'chapter') return candidate.entry.chapter === aggregate.entry.aggregateValue;
        if (aggregate.entry.aggregateKind === 'section') return candidate.entry.section === aggregate.entry.aggregateValue;
        return false;
      };
      const materialize = (candidate) => {
        let evidence = candidate;
        if (candidate.entry.aggregate) {
          evidence = scoredEntries.filter((item) => belongsToAggregate(item, candidate))
            .sort((a, b) => b.score - a.score)[0] || candidate;
        }
        const highlightTerms = [...new Set([...candidate.highlightTerms, ...evidence.highlightTerms])];
        const { vector: _vector, lexicalText: _lexicalText, ...metadata } = evidence.entry;
        return {
          ...metadata,
          heading: evidence.entry.heading || candidate.entry.heading || '',
          snippet: focusedSnippet(evidence.entry.snippet, highlightTerms),
          granularity: evidence.entry.granularity || 'passage',
          matchedGranularity: candidate.entry.granularity || evidence.entry.granularity || 'passage',
          semanticScore: candidate.semanticScore,
          lexicalBoost: candidate.lexicalBoost,
          highlightTerms,
          score: candidate.score
        };
      };
      const bestByDocument = new Map();
      for (const candidate of scoredEntries) {
        const previous = bestByDocument.get(candidate.entry.docId);
        if (!previous || candidate.score > previous.score) bestByDocument.set(candidate.entry.docId, candidate);
      }
      const limit = Math.max(1, Math.min(30, Number(rawLimit) || 12));
      const results = [...bestByDocument.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(materialize);
      safeProgress(progress, { phase: 'ready', message: '本地语义检索完成' });
      return results;
    });
  }

  async dispose() {
    try { await this.extractor?.dispose?.(); } catch (_error) { /* Process is exiting. */ }
    this.extractor = null;
  }
}

module.exports = {
  SemanticSearchService,
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
  aggregateDocumentEntries
};
