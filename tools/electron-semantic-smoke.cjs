const fs = require('node:fs');
const path = require('node:path');
const projectRoot = path.resolve(__dirname, '..');
const dataDir = process.argv[2];
if (!dataDir) throw new Error('missing smoke-test data directory');
const packagedResources = process.argv[3] ? path.resolve(process.argv[3]) : '';
const workerClientModule = packagedResources
  ? path.join(packagedResources, 'app.asar', 'desktop', 'semantic-search-worker-client.cjs')
  : path.join(projectRoot, 'desktop', 'semantic-search-worker-client.cjs');
const { SemanticSearchWorkerClient } = require(workerClientModule);
const binaryPath = packagedResources
  ? path.join(packagedResources, 'runtime', 'meilisearch', 'meilisearch')
  : path.join(projectRoot, 'runtime', 'meilisearch', 'v1.53.1', 'mac-arm64', 'meilisearch');
const modelDir = path.join(packagedResources || projectRoot, 'models', 'bge-small-zh-v1.5');
const source = '周瑜命军士杖打黄盖，以成苦肉计。';
const sentence = {
  unitId: 'sentence-1',
  text: source,
  semanticText: `三国演义\n第四十六回\n${source}`,
  snippet: source,
  heading: '第四十六回 献密计黄盖受刑',
  chapter: '第四十六回 献密计黄盖受刑',
  section: '',
  chapterId: 'chapter-1',
  sectionId: 'section-root',
  passageId: 'passage-1',
  passageIds: ['passage-1'],
  paragraphId: 'paragraph-1',
  sentenceId: 'sentence-1',
  granularity: 'sentence',
  start: 0,
  end: source.length
};

async function main() {
  await fs.promises.rm(dataDir, { recursive: true, force: true });
  const service = new SemanticSearchWorkerClient({
    modelDir,
    binaryPath,
    dataDir,
    metadataFile: path.join(dataDir, 'guanyi-index-metadata.json'),
    logFile: path.join(dataDir, 'semantic-search.log'),
    resourcesPath: packagedResources,
    workerPath: packagedResources ? '' : path.join(projectRoot, 'desktop', 'semantic-search-worker.cjs')
  });
  try {
    await service.indexDocuments([{
      id: 'three-kingdoms-electron',
      fingerprint: 'electron-smoke-v1',
      title: '三国演义',
      path: '三国演义.txt',
      units: [sentence]
    }], { force: true });
    const results = await service.search('谁打了黄盖', 5);
    if (results[0]?.docId !== 'three-kingdoms-electron' || !results[0]?.snippet.includes('周瑜')) {
      throw new Error(`Electron semantic recall failed: ${JSON.stringify(results.slice(0, 2))}`);
    }
    const status = await service.status();
    if (!status.modelReady || !status.engineReady || status.engineVersion !== '1.53.1') {
      throw new Error(`Electron semantic runtime incomplete: ${JSON.stringify(status)}`);
    }
    const failedWorker = service.worker;
    failedWorker.kill('SIGKILL');
    await new Promise((resolve) => failedWorker.once('exit', resolve));
    const restarted = await service.status();
    if (restarted.engineVersion !== '1.53.1' || service.worker?.pid === failedWorker.pid) {
      throw new Error(`Electron semantic worker did not recover: ${JSON.stringify(restarted)}`);
    }
    process.stdout.write(`Electron semantic worker smoke passed (${packagedResources ? 'packaged ASAR' : 'source'}): isolated ONNX, crash recovery, Meilisearch index and query verified\n`);
  } finally {
    await service.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
