import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '1.53.1';
const releaseRoot = `https://github.com/meilisearch/meilisearch/releases/download/v${version}`;
const assets = [
  {
    name: 'mac-arm64',
    url: `${releaseRoot}/meilisearch-macos-apple-silicon`,
    output: path.join(projectRoot, 'runtime', 'meilisearch', `v${version}`, 'mac-arm64', 'meilisearch'),
    size: 121899744,
    executable: true
  },
  {
    name: 'win-x64',
    url: `${releaseRoot}/meilisearch-windows-amd64.exe`,
    output: path.join(projectRoot, 'runtime', 'meilisearch', `v${version}`, 'win-x64', 'meilisearch.exe'),
    size: 128611840,
    executable: false
  }
];
const partCount = 8;
const temporaryRoot = path.join(projectRoot, '.tmp-test', 'meili-download');
const selectedAssets = process.argv.includes('--mac') ? assets.filter((asset) => asset.name === 'mac-arm64')
  : process.argv.includes('--win') ? assets.filter((asset) => asset.name === 'win-x64')
    : assets;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRetry(task, label, attempts = 24) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await task(); }
    catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(Math.min(2000, attempt * 120));
    }
  }
  throw new Error(`${label}失败：${lastError?.message || lastError}`);
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: options.headers,
      timeout: 30_000
    }, resolve);
    req.once('timeout', () => req.destroy(new Error('请求超时')));
    req.once('error', reject);
    req.end();
  });
}

async function redirectLocation(url) {
  const response = await request(url, { method: 'HEAD' });
  response.resume();
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    return new URL(response.headers.location, url).toString();
  }
  if (response.statusCode === 200) return url;
  throw new Error(`HTTP ${response.statusCode}`);
}

async function downloadRange(url, target, start, end, expectedTotal) {
  const expectedSize = end - start + 1;
  let existingSize = (await stat(target).catch(() => null))?.size || 0;
  if (existingSize > expectedSize) {
    await rm(target, { force: true });
    existingSize = 0;
  }
  if (existingSize === expectedSize) return;
  const requestStart = start + existingSize;
  const response = await request(url, { headers: { Range: `bytes=${requestStart}-${end}` } });
  if (response.statusCode !== 206) {
    response.resume();
    throw new Error(`分段请求返回 HTTP ${response.statusCode}`);
  }
  const contentRange = String(response.headers['content-range'] || '');
  if (contentRange !== `bytes ${requestStart}-${end}/${expectedTotal}`) {
    response.resume();
    throw new Error(`分段范围不符：${contentRange}`);
  }
  await new Promise((resolve, reject) => {
    const output = createWriteStream(target, { flags: existingSize ? 'a' : 'w' });
    response.once('error', reject);
    response.once('aborted', () => reject(new Error('分段连接提前中断')));
    output.once('error', reject);
    output.once('finish', resolve);
    response.pipe(output);
  });
  const downloaded = (await stat(target)).size;
  if (downloaded !== expectedSize) throw new Error(`分段字节数不符：${downloaded}`);
}

async function appendFile(handle, source) {
  const input = createReadStream(source);
  for await (const chunk of input) await handle.write(chunk);
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadAsset(asset) {
  await mkdir(path.dirname(asset.output), { recursive: true });
  const existing = await stat(asset.output).catch(() => null);
  if (existing?.size === asset.size) return sha256(asset.output);
  const signedUrl = await withRetry(() => redirectLocation(asset.url), `${asset.name} 重定向`);
  const partDirectory = path.join(temporaryRoot, asset.name);
  await mkdir(partDirectory, { recursive: true });
  const partSize = Math.ceil(asset.size / partCount);
  const parts = Array.from({ length: partCount }, (_value, index) => {
    const start = index * partSize;
    const end = Math.min(asset.size - 1, start + partSize - 1);
    return { start, end, file: path.join(partDirectory, `part-${index}`) };
  }).filter((part) => part.start <= part.end);
  await Promise.all(parts.map((part) => withRetry(
    () => downloadRange(signedUrl, part.file, part.start, part.end, asset.size),
    `${asset.name} ${part.start}-${part.end}`
  )));
  const handle = await open(asset.output, 'w');
  try {
    for (const part of parts) await appendFile(handle, part.file);
  } finally {
    await handle.close();
  }
  const result = await stat(asset.output);
  if (result.size !== asset.size) throw new Error(`${asset.name} 总字节数不符：${result.size}`);
  if (asset.executable) await chmod(asset.output, 0o755);
  await rm(partDirectory, { recursive: true, force: true });
  return sha256(asset.output);
}

async function downloadLicenses() {
  const licenseDirectory = path.join(projectRoot, 'runtime', 'meilisearch', 'licenses');
  await mkdir(licenseDirectory, { recursive: true });
  for (const name of ['LICENSE', 'LICENSE-MIT', 'LICENSE-EE']) {
    const destination = path.join(licenseDirectory, name);
    const existing = await stat(destination).catch(() => null);
    if (existing?.size >= 200) continue;
    const url = `https://raw.githubusercontent.com/meilisearch/meilisearch/v${version}/${name}`;
    const body = await withRetry(async () => {
      const response = await request(url);
      if (response.statusCode !== 200) {
        response.resume();
        throw new Error(`HTTP ${response.statusCode}`);
      }
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      return Buffer.concat(chunks);
    }, `${name} 下载`);
    if (body.length < 200) throw new Error(`${name} 内容不完整`);
    await writeFile(destination, body);
  }
}

await Promise.all(selectedAssets.map(downloadAsset));
await downloadLicenses();
const macAsset = selectedAssets.find((asset) => asset.name === 'mac-arm64');
if (macAsset) {
  const { stdout } = await execFileAsync(macAsset.output, ['--version']);
  if (!stdout.includes(`meilisearch ${version}`)) throw new Error(`macOS 二进制版本不符：${stdout.trim()}`);
}
const verifiedAssets = [];
for (const asset of assets) {
  const assetStats = await stat(asset.output).catch(() => null);
  if (assetStats?.size === asset.size) verifiedAssets.push({ asset, hash: await sha256(asset.output) });
}
const manifest = [
  `Meilisearch v${version}`,
  ...verifiedAssets.map(({ asset, hash }) => `${hash}  ${path.relative(projectRoot, asset.output)}`),
  ''
].join('\n');
await writeFile(path.join(projectRoot, 'runtime', 'meilisearch', 'SHA256SUMS.txt'), manifest);
console.log(manifest.trim());
