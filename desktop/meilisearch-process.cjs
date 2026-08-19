const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_START_TIMEOUT = 20_000;
const DEFAULT_TASK_TIMEOUT = 10 * 60_000;

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
      await delay(60);
    }
    throw new Error(`Meilisearch 任务 ${taskUid} 等待超时`);
  }
}

class MeilisearchProcess {
  constructor({ binaryPath, dataDir, keyFile, startTimeout = DEFAULT_START_TIMEOUT }) {
    this.binaryPath = binaryPath;
    this.dataDir = dataDir;
    this.keyFile = keyFile || path.join(dataDir, 'master-key');
    this.startTimeout = startTimeout;
    this.child = null;
    this.client = null;
    this.starting = null;
    this.disposed = false;
    this.logs = [];
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

  appendLog(chunk) {
    String(chunk || '').split(/\r?\n/).filter(Boolean).forEach((line) => this.logs.push(line));
    if (this.logs.length > 30) this.logs.splice(0, this.logs.length - 30);
  }

  start() {
    if (this.disposed) return Promise.reject(new Error('Meilisearch 服务已关闭'));
    if (this.client && this.child && !this.child.killed) return Promise.resolve(this.client);
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    return this.starting.finally(() => { this.starting = null; });
  }

  async startInternal() {
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
    child.stdout.on('data', (chunk) => this.appendLog(chunk));
    child.stderr.on('data', (chunk) => this.appendLog(chunk));
    child.once('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.client = null;
      }
    });
    const spawnFailure = new Promise((_, reject) => child.once('error', reject));
    const client = new MeilisearchHttpClient({ host, apiKey });
    const deadline = Date.now() + this.startTimeout;
    while (Date.now() < deadline) {
      try {
        const health = await Promise.race([client.health(), spawnFailure]);
        if (health?.status === 'available') {
          this.client = client;
          return client;
        }
      } catch (error) {
        if (!this.child || this.child.killed) {
          throw new Error(`本地 Meilisearch 启动失败：${this.logs.at(-1) || error.message}`);
        }
      }
      await delay(80);
    }
    child.kill();
    throw new Error(`本地 Meilisearch 启动超时：${this.logs.at(-1) || '未通过健康检查'}`);
  }

  async dispose() {
    this.disposed = true;
    const child = this.child;
    this.child = null;
    this.client = null;
    if (!child || child.killed) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        resolve();
      }, 8_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}

module.exports = {
  MeilisearchHttpClient,
  MeilisearchHttpError,
  MeilisearchProcess,
  reserveLoopbackPort
};
