const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_FILE = 'semantic-search-worker.cjs';

function workerError(payload, fallback = '本地语义搜索服务不可用') {
  const error = new Error(String(payload?.message || fallback));
  if (payload?.name) error.name = payload.name;
  if (payload?.code) error.code = payload.code;
  if (payload?.stack) error.workerStack = payload.stack;
  return error;
}

class SemanticSearchWorkerClient {
  constructor(options = {}) {
    this.options = { ...options };
    this.worker = null;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.disposing = false;
  }

  workerPath() {
    if (this.options.workerPath) return this.options.workerPath;
    if (this.options.resourcesPath) return path.join(this.options.resourcesPath, 'app.asar', 'desktop', WORKER_FILE);
    return path.join(__dirname, WORKER_FILE);
  }

  rejectPending(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  appendDiagnostic(event, details = {}) {
    if (!this.options.logFile) return;
    const record = { at: new Date().toISOString(), event, ...details };
    fs.promises.mkdir(path.dirname(this.options.logFile), { recursive: true })
      .then(() => fs.promises.appendFile(this.options.logFile, `${JSON.stringify(record)}\n`, 'utf8'))
      .catch(() => {});
  }

  killWorkerTree(child, signal = 'SIGTERM') {
    if (!child?.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (_error) {
      try { child.kill(signal); } catch (_nestedError) { /* Already exited. */ }
    }
  }

  onWorkerExit(child, code, signal) {
    if (this.worker !== child) return;
    this.worker = null;
    this.startPromise = null;
    if (!this.disposing) {
      this.killWorkerTree(child);
      this.appendDiagnostic('semantic-worker-exited', { pid: child.pid, code, signal });
      const error = new Error(`本地语义搜索进程已退出${signal ? `（${signal}）` : `（${code ?? '未知原因'}）`}`);
      error.code = 'SEMANTIC_WORKER_EXITED';
      this.rejectPending(error);
    }
  }

  start() {
    if (this.worker?.connected) return Promise.resolve(this.worker);
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const child = fork(this.workerPath(), [], {
        cwd: process.cwd(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: process.versions.electron ? '1' : process.env.ELECTRON_RUN_AS_NODE },
        execPath: process.execPath,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
      this.worker = child;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        this.worker = null;
        this.startPromise = null;
        this.killWorkerTree(child);
        reject(error);
      };
      child.once('error', fail);
      child.on('exit', (code, signal) => {
        this.onWorkerExit(child, code, signal);
        if (!settled) fail(new Error(`本地语义搜索进程启动失败${signal ? `（${signal}）` : ''}`));
      });
      child.on('message', (message) => {
        if (message?.type === 'ready') {
          if (!settled) {
            settled = true;
            this.startPromise = null;
            resolve(child);
          }
          return;
        }
        if (message?.type === 'init-error') { fail(workerError(message.error, '本地语义搜索服务初始化失败')); return; }
        this.handleMessage(message);
      });
      child.send({ type: 'init', options: this.options });
    });
    return this.startPromise;
  }

  handleMessage(message) {
    if (message?.type === 'fatal') {
      const error = workerError(message.error, '本地语义搜索进程发生致命错误');
      error.code ||= 'SEMANTIC_WORKER_FATAL';
      this.appendDiagnostic('semantic-worker-fatal', { pid: this.worker?.pid || 0, error: message.error });
      this.rejectPending(error);
      return;
    }
    const request = this.pending.get(message?.requestId);
    if (!request) return;
    if (message.type === 'progress') {
      try { request.progress?.(message.payload); } catch (_error) { /* Renderer may have closed. */ }
      return;
    }
    if (message.type !== 'response') return;
    this.pending.delete(message.requestId);
    if (message.error) request.reject(workerError(message.error));
    else request.resolve(message.result);
  }

  request(method, args, progress) {
    return this.start().then((child) => new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++;
      this.pending.set(requestId, { resolve, reject, progress });
      try { child.send({ type: 'request', requestId, method, args }); }
      catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    }));
  }

  status() { return this.request('status', []); }

  indexDocuments(documents, options, progress) {
    return this.request('indexDocuments', [documents, options], progress);
  }

  search(query, limit, options, progress) {
    if (typeof options === 'function' && progress === undefined) {
      progress = options;
      options = null;
    }
    return this.request('search', [query, limit, options], progress);
  }

  async dispose() {
    this.disposing = true;
    const child = this.worker;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      const finish = () => { clearTimeout(timer); resolve(); };
      child.once('exit', finish);
      try { child.send({ type: 'dispose', requestId: this.nextRequestId++ }); }
      catch (_error) { finish(); }
    });
    if (this.worker === child) {
      this.killWorkerTree(child);
      this.worker = null;
    }
    this.rejectPending(new Error('本地语义搜索服务已关闭'));
  }
}

module.exports = { SemanticSearchWorkerClient };
