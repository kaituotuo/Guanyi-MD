const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const BINARY_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.epub']);
const MAX_BINARY_DOCUMENT_SIZE = 100 * 1024 * 1024;
const cacheWrites = new Map();

function binaryDocumentBytes(value, extension) {
  let bytes;
  if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
  else if (ArrayBuffer.isView(value)) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else throw new Error('文档数据无效');
  if (!bytes.length || bytes.length > MAX_BINARY_DOCUMENT_SIZE) throw new Error('文档为空或超过 100 MB');
  const pdf = bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
  const epub = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  if ((extension === '.pdf' && !pdf) || (extension === '.epub' && !epub) || (!pdf && !epub)) {
    throw new Error('文档内容与 PDF / EPUB 格式不符');
  }
  return bytes;
}

async function atomicWriteBinary(filePath, bytes, fileSystem = fs.promises) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let mode = 0o600;
  try {
    const previous = await fileSystem.lstat(filePath);
    if (!previous.isFile() || previous.isSymbolicLink()) throw new Error('目标位置必须是普通文件');
    mode = previous.mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let handle;
  try {
    handle = await fileSystem.open(temporary, 'wx', mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporary, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function saveBinaryDocumentAs(payload, options) {
  const suggestedName = path.basename(String(payload?.suggestedName || '').replace(/\\/g, '/'));
  const extension = path.extname(suggestedName).toLowerCase();
  if (!BINARY_DOCUMENT_EXTENSIONS.has(extension)) throw new Error('请选择 PDF 或 EPUB 文件名');
  const bytes = binaryDocumentBytes(payload?.bytes, extension);
  const result = await options.dialogApi.showSaveDialog(options.window, {
    title: extension === '.pdf' ? '另存 PDF' : '另存 EPUB',
    defaultPath: suggestedName,
    filters: [{ name: extension === '.pdf' ? 'PDF 文档' : 'EPUB 电子书', extensions: [extension.slice(1)] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const filePath = path.extname(result.filePath) ? result.filePath : `${result.filePath}${extension}`;
  if (path.extname(filePath).toLowerCase() !== extension) throw new Error(`请使用 ${extension} 扩展名`);
  const fileSystem = options.fileSystem || fs.promises;
  await atomicWriteBinary(filePath, bytes, fileSystem);
  const stats = await fileSystem.stat(filePath);
  return {
    canceled: false,
    path: filePath,
    name: path.basename(filePath),
    size: stats.size,
    lastModified: stats.mtimeMs,
    storageKind: 'external'
  };
}

function binaryCachePath(userDataPath, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('文档缓存标识无效');
  return path.join(userDataPath, 'binary-documents', `${id}.bin`);
}

async function cacheBinaryDocument(userDataPath, id, value) {
  const filePath = binaryCachePath(userDataPath, id);
  const bytes = Buffer.from(binaryDocumentBytes(value));
  const previous = cacheWrites.get(filePath) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteBinary(filePath, bytes);
    return { id, size: bytes.length };
  });
  cacheWrites.set(filePath, pending);
  try { return await pending; }
  finally { if (cacheWrites.get(filePath) === pending) cacheWrites.delete(filePath); }
}

async function readCachedBinaryDocument(userDataPath, id) {
  const filePath = binaryCachePath(userDataPath, id);
  await cacheWrites.get(filePath);
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile() || stats.size > MAX_BINARY_DOCUMENT_SIZE) throw new Error('文档缓存超过 100 MB 或已损坏');
    const bytes = binaryDocumentBytes(await fs.promises.readFile(filePath));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

module.exports = {
  BINARY_DOCUMENT_EXTENSIONS,
  MAX_BINARY_DOCUMENT_SIZE,
  binaryDocumentBytes,
  atomicWriteBinary,
  saveBinaryDocumentAs,
  cacheBinaryDocument,
  readCachedBinaryDocument
};
