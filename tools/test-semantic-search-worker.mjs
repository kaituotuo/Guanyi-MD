import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = path.join(projectRoot, '.tmp-test', 'semantic-search-worker');
await rm(temporaryRoot, { recursive: true, force: true });

const { SemanticSearchWorkerClient } = await import('../desktop/semantic-search-worker-client.cjs');
const modelDir = path.join(projectRoot, 'models', 'bge-small-zh-v1.5');
const binaryPath = path.join(projectRoot, 'runtime', 'meilisearch', 'v1.53.1', 'mac-arm64', 'meilisearch');
const source = '周瑜命军士杖打黄盖，以成苦肉计。';
const sentence = {
  unitId: 'sentence-1', text: source, semanticText: `三国演义\n第四十六回\n${source}`,
  snippet: source, heading: '第四十六回 献密计黄盖受刑', chapter: '第四十六回 献密计黄盖受刑', section: '',
  chapterId: 'chapter-1', sectionId: 'section-root', passageId: 'passage-1', passageIds: ['passage-1'],
  paragraphId: 'paragraph-1', sentenceId: 'sentence-1', granularity: 'sentence', start: 0, end: source.length
};
const document = {
  id: 'worker-three-kingdoms', fingerprint: 'worker-v1', title: '三国演义', path: '三国演义.txt', units: [sentence]
};

const client = new SemanticSearchWorkerClient({
  modelDir, binaryPath, dataDir: temporaryRoot,
  metadataFile: path.join(temporaryRoot, 'guanyi-index-metadata.json'),
  logFile: path.join(temporaryRoot, 'semantic-search.log'),
  workerPath: path.join(projectRoot, 'desktop', 'semantic-search-worker.cjs')
});
try {
  await client.indexDocuments([document], { force: true });
  const results = await client.search('谁打了黄盖', 5);
  assert.equal(results[0]?.docId, document.id);
  assert.match(results[0]?.snippet || '', /周瑜/);
  const child = client.worker;
  assert.ok(child?.pid, 'semantic service should run outside the editor process');
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  const restarted = await client.status();
  assert.equal(restarted.engineVersion, '1.53.1');
  assert.ok(client.worker?.pid && client.worker.pid !== child.pid, 'worker should restart after an isolated exit');
} finally {
  await client.dispose();
}

process.stdout.write('semantic search worker passed: native ONNX runs outside Electron main process and restarts after isolated exit\n');
