const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const BINARY_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.epub']);
const MAX_PDF_DOCUMENT_SIZE = 1024 * 1024 * 1024;
const MAX_EPUB_DOCUMENT_SIZE = 100 * 1024 * 1024;
const MAX_BINARY_DOCUMENT_SIZE = MAX_PDF_DOCUMENT_SIZE;
const cacheWrites = new Map();

function binaryDocumentSizeLimit(extension) {
  const normalized = String(extension || '').toLowerCase();
  if (normalized === '.pdf') return MAX_PDF_DOCUMENT_SIZE;
  if (normalized === '.epub') return MAX_EPUB_DOCUMENT_SIZE;
  throw new Error('不支持的二进制文档格式');
}

function validateBinaryDocumentSize(size, extension) {
  const maximum = binaryDocumentSizeLimit(extension);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('文档为空或大小无效');
  if (size > maximum) throw new Error(`文件超过 ${maximum / (1024 * 1024)} MB`);
}

function binaryDocumentFormat(bytes, extension) {
  const pdf = bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
  const epub = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  // Cached files have a .bin suffix. Prefer the ZIP signature so an EPUB that
  // embeds a PDF marker cannot acquire the larger PDF allowance.
  const format = extension ? String(extension).toLowerCase() : (epub ? '.epub' : (pdf ? '.pdf' : ''));
  if (!BINARY_DOCUMENT_EXTENSIONS.has(format) || (format === '.pdf' ? !pdf : !epub)) {
    throw new Error('文档内容与 PDF / EPUB 格式不符');
  }
  return format;
}

function binaryDocumentBytes(value, extension) {
  let bytes;
  if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
  else if (ArrayBuffer.isView(value)) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else throw new Error('文档数据无效');
  if (!bytes.length) throw new Error('文档为空');
  const format = binaryDocumentFormat(bytes, extension);
  validateBinaryDocumentSize(bytes.length, format);
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
  // Electron has already cloned this payload for the main process; retain its
  // backing storage until the queued write completes instead of copying it.
  const bytes = binaryDocumentBytes(value);
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
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('文档缓存已损坏');
    validateBinaryDocumentSize(stats.size, '.pdf');
    const header = Buffer.alloc(Math.min(stats.size, 1024));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const format = binaryDocumentFormat(header.subarray(0, bytesRead));
    validateBinaryDocumentSize(stats.size, format);
    const bytes = binaryDocumentBytes(await handle.readFile(), format);
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

module.exports = {
  BINARY_DOCUMENT_EXTENSIONS,
  MAX_BINARY_DOCUMENT_SIZE,
  MAX_PDF_DOCUMENT_SIZE,
  MAX_EPUB_DOCUMENT_SIZE,
  binaryDocumentSizeLimit,
  validateBinaryDocumentSize,
  binaryDocumentBytes,
  atomicWriteBinary,
  saveBinaryDocumentAs,
  cacheBinaryDocument,
  readCachedBinaryDocument
};
