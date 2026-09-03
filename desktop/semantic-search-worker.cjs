const { SemanticSearchService } = require('./semantic-search.cjs');

let service = null;
let shuttingDown = false;

function send(message) {
  if (process.connected) process.send(message);
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code || '',
    message: String(error?.message || error || '本地语义搜索失败').slice(0, 2_000),
    stack: String(error?.stack || '').slice(0, 4_000)
  };
}

async function dispose() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await service?.dispose?.(); } catch (_error) { /* The parent is already leaving. */ }
  service = null;
}

process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init') {
    try {
      service = new SemanticSearchService(message.options || {});
      send({ type: 'ready' });
    } catch (error) {
      send({ type: 'init-error', error: serializeError(error) });
      process.exitCode = 1;
    }
    return;
  }
  if (message.type === 'dispose') {
    await dispose();
    send({ type: 'disposed', requestId: message.requestId });
    process.disconnect?.();
    return;
  }
  if (message.type !== 'request' || !service || shuttingDown) return;
  const { requestId, method, args = [] } = message;
  const progress = (payload) => send({ type: 'progress', requestId, payload });
  try {
    let result;
    if (method === 'indexDocuments') result = await service.indexDocuments(args[0], args[1], progress);
    else if (method === 'search') result = await service.search(args[0], args[1], args[2], progress);
    else if (method === 'status') result = await service.status();
    else throw Object.assign(new Error(`未知语义搜索方法：${method}`), { code: 'SEMANTIC_WORKER_METHOD' });
    send({ type: 'response', requestId, result });
  } catch (error) {
    send({ type: 'response', requestId, error: serializeError(error) });
  }
});

process.on('disconnect', () => {
  dispose().finally(() => process.exit(0));
});

process.on('uncaughtException', (error) => {
  send({ type: 'fatal', error: serializeError(error) });
  dispose().finally(() => process.exit(1));
});

process.on('unhandledRejection', (error) => {
  send({ type: 'fatal', error: serializeError(error) });
  dispose().finally(() => process.exit(1));
});
