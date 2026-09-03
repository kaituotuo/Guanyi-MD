const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_START_TIMEOUT = 20_000;
const DEFAULT_TASK_TIMEOUT = 10 * 60_000;
const DEFAULT_TASK_POLL_INTERVAL = 180;
const DEFAULT_START_ATTEMPTS = 2;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

class MeilisearchHttpError extends Error {
  constructor(message, status, code, payload) {
    super(message);
    this.name = 'MeilisearchHttpError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

class MeilisearchHttpClient {
  constructor({ host, apiKey }) {
    this.host = new URL(host);
    this.apiKey = apiKey;
  }

  request(method, pathname, body, timeout = 60_000) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = http.request({
        protocol: this.host.protocol,
        hostname: this.host.hostname,
        port: this.host.port,
        method,
        path: pathname,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': payload.length
          } : {})
        },
        timeout
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch (_error) { parsed = raw; }
          if ((response.statusCode || 500) >= 400) {
            reject(new MeilisearchHttpError(
              parsed?.message || `Meilisearch HTTP ${response.statusCode}`,
              response.statusCode,
              parsed?.code,
              parsed
            ));
            return;
          }
          resolve(parsed);
        });
      });
      request.once('timeout', () => request.destroy(new Error('Meilisearch 请求超时')));
      request.once('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  health() {
    return this.request('GET', '/health', undefined, 2_000);
  }

  version() {
    return this.request('GET', '/version');
  }

  createIndex(uid, primaryKey = 'id') {
    return this.request('POST', '/indexes', { uid, primaryKey });
  }

  deleteIndex(uid) {
    return this.request('DELETE', `/indexes/${encodeURIComponent(uid)}`);
  }

  updateSettings(uid, settings) {
    return this.request('PATCH', `/indexes/${encodeURIComponent(uid)}/settings`, settings);
  }

  indexStats(uid) {
    return this.request('GET', `/indexes/${encodeURIComponent(uid)}/stats`);
  }

  addDocuments(uid, documents) {
    return this.request('POST', `/indexes/${encodeURIComponent(uid)}/documents?primaryKey=id`, documents, DEFAULT_TASK_TIMEOUT);
  }

  deleteDocuments(uid, ids) {
    return this.request('POST', `/indexes/${encodeURIComponent(uid)}/documents/delete-batch`, ids);
  }

  deleteDocumentsByFilter(uid, filter) {
    return this.request('POST', `/indexes/${encodeURIComponent(uid)}/documents/delete`, { filter });
  }

  search(uid, parameters) {
    return this.request('POST', `/indexes/${encodeURIComponent(uid)}/search`, parameters);
  }

  multiSearch(queries) {
    return this.request('POST', '/multi-search', { queries });
  }

  getTask(taskUid) {
    return this.request('GET', `/tasks/${encodeURIComponent(taskUid)}`);
  }

  async waitTask(taskOrUid, timeout = DEFAULT_TASK_TIMEOUT) {
    const taskUid = Number(taskOrUid?.taskUid ?? taskOrUid?.uid ?? taskOrUid);
    if (!Number.isFinite(taskUid)) throw new Error('Meilisearch 未返回有效任务编号');
    const startedAt = Date.now();
    let pollInterval = DEFAULT_TASK_POLL_INTERVAL;
    while (Date.now() - startedAt < timeout) {
      const task = await this.getTask(taskUid);
      if (task.status === 'succeeded') return task;
      if (task.status === 'failed' || task.status === 'canceled') {
        throw new MeilisearchHttpError(
          task.error?.message || 'Meilisearch 后台任务失败',
          500,
          task.error?.code,
          task
        );
      }
      await delay(pollInterval);
      pollInterval = Math.min(600, Math.round(pollInterval * 1.15));
    }
    throw new Error(`Meilisearch 任务 ${taskUid} 等待超时`);
  }
}

class MeilisearchProcess {
  constructor({
    binaryPath,
    dataDir,
    keyFile,
    logFile,
    startTimeout = DEFAULT_START_TIMEOUT,
    startAttempts = DEFAULT_START_ATTEMPTS
  }) {
    this.binaryPath = binaryPath;
    this.dataDir = dataDir;
    this.keyFile = keyFile || path.join(dataDir, 'master-key');
    this.logFile = logFile || path.join(path.dirname(dataDir), 'semantic-search.log');
    this.startTimeout = startTimeout;
    this.startAttempts = Math.max(1, Number(startAttempts) || DEFAULT_START_ATTEMPTS);
    this.child = null;
    this.client = null;
    this.starting = null;
    this.disposed = false;
    this.logs = [];
    this.lastError = null;
    this.lastFailure = null;
    this.lastRecovery = null;
  }

  async masterKey() {
    try {
      const saved = (await fs.promises.readFile(this.keyFile, 'utf8')).trim();
      if (saved.length >= 32) {
        if (process.platform !== 'win32') await fs.promises.chmod(this.keyFile, 0o600);
        return saved;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const key = crypto.randomBytes(32).toString('hex');
    await fs.promises.mkdir(path.dirname(this.keyFile), { recursive: true });
    await fs.promises.writeFile(this.keyFile, `${key}\n`, { mode: 0o600 });
    return key;
  }

  appendLog(chunk, stream = 'output') {
    String(chunk || '').split(/\r?\n/).filter(Boolean)
      .forEach((line) => this.logs.push(`[${stream}] ${line}`));
    if (this.logs.length > 30) this.logs.splice(0, this.logs.length - 30);
  }

  async writeDiagnostic(event, details = {}) {
    const record = {
      at: new Date().toISOString(),
      event,
      binaryPath: this.binaryPath,
      dataDir: this.dataDir,
      ...details
    };
    try {
      await fs.promises.mkdir(path.dirname(this.logFile), { recursive: true });
      const existing = await fs.promises.stat(this.logFile).catch(() => null);
      if (existing?.size > 1024 * 1024) {
        await fs.promises.rename(this.logFile, `${this.logFile}.previous`).catch(() => {});
      }
      await fs.promises.appendFile(this.logFile, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (_error) {
      // Diagnostics must never replace the original search failure.
    }
  }

  failureDetails(error, attempt, exitInfo = {}) {
    const details = {
      at: Date.now(),
      attempt,
      code: exitInfo.code ?? error?.code ?? null,
      signal: exitInfo.signal ?? null,
      message: String(error?.message || error || '本地搜索服务启动失败'),
      logs: [...this.logs]
    };
    this.lastFailure = details;
    this.lastError = details;
    return details;
  }

  startupError(error, attempt, exitInfo = {}) {
    const details = this.failureDetails(error, attempt, exitInfo);
    const diagnostic = details.logs.at(-1) || details.message;
    const wrapped = new Error(`本地 Meilisearch 启动失败：${diagnostic}`);
    wrapped.code = 'MEILISEARCH_START_FAILED';
    wrapped.cause = error;
    wrapped.details = details;
    wrapped.recoverableDatabase = this.isConfirmedDatabaseFailure(details);
    return wrapped;
  }

  isConfirmedDatabaseFailure(details = this.lastFailure) {
    const evidence = [details?.message, ...(details?.logs || [])].filter(Boolean).join('\n');
    if (/lock|already in use|another process|address already in use/i.test(evidence)) return false;
    return /corrupt|corruption|checksum|invalid (?:database|store|page)|failed to (?:open|load) (?:database|store)|database.*(?:damaged|malformed)|heed.*(?:error|invalid)|mdb.*(?:corrupt|invalid)|io error.*(?:database|data\.ms)/i.test(evidence);
  }

  diagnosticStatus() {
    return {
      logFile: this.logFile,
      lastError: this.lastError,
      lastFailure: this.lastFailure,
      lastRecovery: this.lastRecovery
    };
  }

  start() {
    if (this.disposed) return Promise.reject(new Error('Meilisearch 服务已关闭'));
    if (this.client && this.child && !this.child.killed) return Promise.resolve(this.client);
    if (this.starting) return this.starting;
    this.starting = this.startWithRetry();
    return this.starting.finally(() => { this.starting = null; });
  }

  async startWithRetry() {
    let lastError;
    for (let attempt = 1; attempt <= this.startAttempts; attempt += 1) {
      try {
        const client = await this.startAttempt(attempt);
        this.lastError = null;
        await this.writeDiagnostic('engine-started', { attempt });
        return client;
      } catch (error) {
        lastError = error?.code === 'MEILISEARCH_START_FAILED'
          ? error
          : this.startupError(error, attempt);
        await this.writeDiagnostic('engine-start-failed', lastError.details);
        await this.stopChild();
        if (attempt < this.startAttempts) await delay(180);
      }
    }
    throw lastError;
  }

  async startAttempt(attempt) {
    const stats = await fs.promises.stat(this.binaryPath).catch(() => null);
    if (!stats?.isFile()) throw new Error('本地 Meilisearch 程序缺失，请重新安装观绎 MD');
    if (process.platform !== 'win32' && !(stats.mode & 0o111)) await fs.promises.chmod(this.binaryPath, 0o755);
    await fs.promises.mkdir(this.dataDir, { recursive: true });
    const apiKey = await this.masterKey();
    const port = await reserveLoopbackPort();
    const host = `http://127.0.0.1:${port}`;
    const args = [
      '--http-addr', `127.0.0.1:${port}`,
      '--db-path', this.dataDir,
      '--env', 'production',
      '--log-level', 'WARN',
      '--no-analytics'
    ];
    this.logs = [];
    const child = spawn(this.binaryPath, args, {
      cwd: this.dataDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MEILI_MASTER_KEY: apiKey,
        MEILI_NO_ANALYTICS: 'true',
        MEILI_ENV: 'production'
      }
    });
    this.child = child;
    const exitInfo = { code: null, signal: null, error: null };
    child.stdout.on('data', (chunk) => this.appendLog(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => this.appendLog(chunk, 'stderr'));
    child.once('error', (error) => { exitInfo.error = error; });
    child.once('exit', (code, signal) => {
      exitInfo.code = code;
      exitInfo.signal = signal;
      if (this.child === child) {
        this.child = null;
        this.client = null;
      }
    });
    const client = new MeilisearchHttpClient({ host, apiKey });
    const deadline = Date.now() + this.startTimeout;
    while (Date.now() < deadline) {
      if (exitInfo.error) throw this.startupError(exitInfo.error, attempt, exitInfo);
      if (exitInfo.code !== null || exitInfo.signal) {
        throw this.startupError(new Error('本地搜索进程提前退出'), attempt, exitInfo);
      }
      try {
        const health = await client.health();
        if (health?.status === 'available') {
          this.client = client;
          return client;
        }
      } catch (error) {
        if (!this.child || this.child.killed) {
          throw this.startupError(error, attempt, exitInfo);
        }
      }
      await delay(80);
    }
    child.kill();
    throw this.startupError(new Error(`启动超时：${this.logs.at(-1) || '未通过健康检查'}`), attempt, exitInfo);
  }

  async stopChild() {
    const child = this.child;
    this.child = null;
    this.client = null;
    if (!child || child.exitCode !== null || child.signalCode) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (!child.killed) child.kill('SIGTERM');
    });
  }

  async recoverDataDirectory(reason = 'database-startup-failure') {
    await this.stopChild();
    const suffix = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = `${this.dataDir}.recovery-${suffix}`;
    const existing = await fs.promises.stat(this.dataDir).catch(() => null);
    if (existing) await fs.promises.rename(this.dataDir, archivePath);
    await fs.promises.mkdir(this.dataDir, { recursive: true });
    this.lastRecovery = { at: Date.now(), reason, archivePath: existing ? archivePath : '' };
    this.lastError = null;
    await this.writeDiagnostic('engine-data-recovered', this.lastRecovery);
    return { ...this.lastRecovery, suffix };
  }

  async dispose() {
    this.disposed = true;
    await this.stopChild();
  }
}

module.exports = {
  MeilisearchHttpClient,
  MeilisearchHttpError,
  MeilisearchProcess,
  reserveLoopbackPort
};
