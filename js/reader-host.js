(function () {
  'use strict';

  const MAX_PDF_BYTES = 1024 * 1024 * 1024;
  const MAX_EPUB_BYTES = 100 * 1024 * 1024;
  let active = null;
  let saving = false;
  let database;
  const retiring = new Set();

  function format(name) {
    return String(name || '').match(/\.(epub|pdf)$/i)?.[1].toLowerCase() || null;
  }

  function isDocument(doc) {
    return doc?.readerFormat === 'pdf' || doc?.readerFormat === 'epub';
  }

  function openDatabase() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('guanyi-reader-originals-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('originals');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database;
  }

  async function browserCache(id, bytes) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('originals', bytes ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('originals');
      const request = bytes ? store.put(bytes, id) : store.get(id);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('文档缓存写入中断'));
    });
  }

  async function cache(id, bytes) {
    if (window.guanyiDesktop?.files?.cacheBinary) {
      await window.guanyiDesktop.files.cacheBinary(id, bytes);
    } else {
      await browserCache(id, bytes);
    }
  }

  async function cachedBytes(id) {
    const files = window.guanyiDesktop?.files;
    const value = files?.readCachedBinary ? await files.readCachedBinary(id) : await browserCache(id);
    return value ? new Uint8Array(value) : null;
  }

  async function hashSource(bytes) {
    if (window.GuanyiPdfEvidence?.hashBytes) return window.GuanyiPdfEvidence.hashBytes(bytes);
    if (!globalThis.crypto?.subtle) throw new Error('文档来源校验不可用，请使用桌面版或本机服务');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function sourceHashFor(doc, openingBytes) {
    if (/^[a-f0-9]{64}$/i.test(String(doc.readerSourceHash || ''))) return doc.readerSourceHash;
    // The pristine cache is a separate identity from a PDF annotation draft.
    // Legacy records migrate from it; adding an annotation never rotates this hash.
    const pristine = await cachedBytes(doc.id);
    const bytes = pristine || openingBytes;
    if (!bytes) throw new Error('原文缓存不可用，请先重新打开文档');
    doc.readerSourceHash = await hashSource(bytes);
    return doc.readerSourceHash;
  }

  async function original(doc) {
    const files = window.guanyiDesktop?.files;
    const cached = files?.readCachedBinary
      ? await files.readCachedBinary(doc.readerDraftKey || doc.id)
      : await browserCache(doc.readerDraftKey || doc.id);
    if (cached) return new Uint8Array(cached);
    if (doc.readerDraftKey) throw new Error('批注缓存不可用，已保留阅读记录；请恢复缓存或打开已导出的 PDF');
    if (doc.desktopPath && files?.read) {
      const [record] = await files.read([doc.desktopPath]);
      if (record && !record.error && record.lastModified === doc.externalModifiedAt && record.size === doc.externalSize) {
        const bytes = new Uint8Array(record.bytes);
        await cache(doc.id, bytes);
        return bytes;
      }
    }
    throw new Error('文档缓存不可用，请重新打开原文件');
  }

  async function reuse(doc, bytes) {
    const files = window.guanyiDesktop?.files;
    const key = doc.readerDraftKey || doc.id;
    const cached = files?.readCachedBinary ? await files.readCachedBinary(key) : await browserCache(key);
    if (cached) return true;
    // Reopening the source cannot reconstruct missing PDF annotations. Keep
    // that record intact and let the host open a separate copy of the source.
    if (doc.readerDraftKey) return false;
    await cache(doc.id, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    return true;
  }

  async function prepare({ id, name, bytes }) {
    const readerFormat = format(name);
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!readerFormat) throw new Error('不支持的阅读格式');
    const maxMb = readerFormat === 'pdf' ? 1024 : 100;
    const maxBytes = readerFormat === 'pdf' ? MAX_PDF_BYTES : MAX_EPUB_BYTES;
    if (!data.length || data.byteLength > maxBytes) throw new Error(`请选择不超过 ${maxMb} MB 的有效文档`);
    const prefix = new TextDecoder().decode(data.subarray(0, 1024));
    if (readerFormat === 'pdf' ? !prefix.includes('%PDF-') : !prefix.startsWith('PK')) {
      throw new Error(`文件内容不是有效的 ${readerFormat.toUpperCase()}`);
    }
    await cache(id, data);
    const content = readerFormat === 'pdf' ? JSON.stringify({ revision: 'original' }) : '{}';
    return { readerFormat, content, lastSavedContent: content, readerPosition: null, readerSourceHash: await hashSource(data) };
  }

  function retire(session) {
    retiring.add(session);
    session.closeFailed = false;
    session.disposePromise = Promise.resolve(session.ready).then(async instance => {
      await session.study?.flush?.();
      await session.study?.dispose?.();
      session.study = null;
      await instance?.dispose();
    }).then(() => {
      retiring.delete(session);
      session.container.remove(); session.toolbar.remove();
    }, error => {
      session.closeFailed = true;
      session.hooks.notify(`保存阅读记录失败，批注仍保留在页签中：${error.message}`);
      throw error;
    });
    // Keep the failed session and its iframe available for retry/reopening.
    session.disposePromise.catch(() => {});
  }

  function resume(session) {
    retiring.delete(session);
    active = session;
    session.container.hidden = false;
    session.toolbar.hidden = false;
    session.ready = Promise.resolve(session.ready).then(async instance => {
      if (!session.study) await mountStudy(session, instance);
      return instance;
    });
    return session.ready;
  }

  async function mountStudy(session, instance) {
    if (session.doc.readerFormat !== 'pdf' || !instance?.study || !session.hooks.study || !window.GuanyiPdfStudy?.mount) return;
    try {
      session.study = await window.GuanyiPdfStudy.mount({ doc: session.doc, reader: instance.study,
        container: session.container, toolbar: session.toolbar, ...session.hooks.study });
    } catch (error) {
      session.hooks.notify(`智能研读暂不可用，PDF 阅读仍可继续：${error.message || error}`);
    }
  }

  function hide() {
    const previous = active;
    active = null;
    if (previous) {
      previous.hooks.review?.onDetach?.();
      previous.container.hidden = true;
      previous.toolbar.hidden = true;
      clearTimeout(previous.positionTimer);
      previous.hooks.persist();
      retire(previous);
    }
    document.querySelector('.app-main')?.classList.remove('has-format-reader');
  }

  function show(doc, hooks) {
    if (active?.doc === doc) return active.ready;
    hide();
    const main = document.querySelector('.app-main');
    main.classList.add('has-format-reader');
    const failed = [...retiring].find(session => session.doc === doc && session.closeFailed);
    if (failed) return resume(failed);
    const pending = [...retiring].filter(session => session.doc === doc).map(session => session.disposePromise);
    const toolbar = document.createElement('div');
    toolbar.className = 'app-reader-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', `${doc.readerFormat.toUpperCase()} 阅读与编辑`);
    const container = document.createElement('section');
    container.className = 'app-reader-container';
    container.setAttribute('aria-label', `${doc.readerFormat.toUpperCase()} 文档`);
    container.textContent = '正在打开文档…';
    main.insertBefore(toolbar, document.getElementById('fmtbar'));
    main.insertBefore(container, document.getElementById('editor-container'));
    const session = { doc, hooks, toolbar, container, instance: null, ready: null, positionTimer: null };
    active = session;
    session.ready = (async () => {
      try {
        await Promise.all(pending);
        const bytes = await original(doc);
        if (active !== session) return null;
        const previousSourceHash = doc.readerSourceHash;
        const sourceHash = await sourceHashFor(doc, bytes);
        if (previousSourceHash !== sourceHash) await hooks.persist(true);
        if (active !== session) return null;
        container.replaceChildren();
        const engine = doc.readerFormat === 'pdf' ? window.GuanyiPdfReader : window.GuanyiEpubReader;
        const instance = await engine.open({
          bytes, container, toolbar, icon: hooks.icon, notify: hooks.notify, sourceHash, title: doc.name,
          edits: JSON.parse(doc.content || '{}'), position: doc.readerPosition,
          review: doc.readerFormat === 'epub' ? hooks.review : undefined,
          onChange(edits) {
            doc.content = JSON.stringify(edits);
            if (doc.readerFormat === 'epub') doc.lastSavedContent = doc.content;
            hooks.changed();
          },
          async onSnapshot(bytes) {
            const key = `${doc.id}-pdf-draft`;
            await cache(key, bytes);
            doc.readerDraftKey = key;
            await hooks.persist(true);
          },
          onPosition(position) {
            if (active !== session) return;
            doc.readerPosition = position;
            clearTimeout(session.positionTimer);
            session.positionTimer = setTimeout(hooks.persist, 500);
          }
        });
        if (active !== session) return instance;
        session.instance = instance;
        if (doc.readerFormat === 'epub') hooks.review?.onReady?.(instance.review);
        await mountStudy(session, instance);
        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'fmt-btn app-reader-save';
        saveButton.innerHTML = hooks.icon('save') + `<span>${doc.readerFormat === 'epub' ? '导出笔记' : '另存为'}</span>`;
        saveButton.title = doc.readerFormat === 'epub' ? '导出高亮与笔记为 Markdown' : '另存含批注的 PDF（⌘/Ctrl+S）';
        saveButton.addEventListener('click', () => hooks.save());
        toolbar.append(saveButton);
        return instance;
      } catch (error) {
        if (active !== session) return null;
        const failed = [...retiring].find(previous => previous.doc === doc && previous.closeFailed);
        if (failed) {
          container.remove(); toolbar.remove();
          return resume(failed);
        }
        container.replaceChildren();
        toolbar.replaceChildren();
        const message = document.createElement('p');
        message.className = 'app-reader-error';
        message.setAttribute('role', 'alert');
        message.textContent = `无法打开文档：${error.message || error}`;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'fmt-btn';
        retry.textContent = '重新尝试';
        retry.addEventListener('click', () => { hide(); show(doc, hooks); });
        container.append(message, retry);
        return null;
      }
    })();
    return session.ready;
  }

  async function flush() {
    for (const session of retiring) if (session.closeFailed) retire(session);
    await Promise.all([...retiring].map(session => session.disposePromise));
    const session = active;
    const instance = await session?.ready;
    await session?.study?.flush?.();
    await instance?.flush?.();
    await session?.hooks.persist(true);
  }

  async function getStudyReader(docId) {
    const session = active;
    if (!session || session.doc.readerFormat !== 'pdf' || (docId && session.doc.id !== docId)) return null;
    const instance = await session.ready;
    return active === session ? instance?.study || null : null;
  }

  function getReviewReader(docId) {
    return active?.doc.readerFormat === 'epub' && (!docId || active.doc.id === docId)
      ? active.instance?.review || null : null;
  }

  async function waitForReviewReader(docId) {
    const session = active;
    if (!session || session.doc.readerFormat !== 'epub' || (docId && session.doc.id !== docId)) return null;
    const instance = await session.ready;
    return active === session ? instance?.review || null : null;
  }

  async function openStudy(docId) {
    const session = active;
    if (!session || session.doc.readerFormat !== 'pdf' || (docId && session.doc.id !== docId)) return false;
    await session.ready;
    if (active !== session || !session.study?.show) return false;
    await session.study.show();
    return true;
  }

  async function readSource(doc, options = {}) {
    if (!doc?.id || !isDocument(doc)) throw new Error('请选择应用文档列表中的 PDF 或 EPUB');
    const tools = window.GuanyiPdfEvidence;
    if (!tools) throw new Error('文档文字解析资源未就绪，请重新打开应用');
    tools.checkAbort(options.signal);
    const maxPages = Math.max(1, Math.min(100, Math.floor(Number(options.maxPages) || 50)));
    const maxChars = Math.max(1000, Math.min(120000, Math.floor(Number(options.maxChars) || 60000)));
    const reader = await getStudyReader(doc.id);
    if (reader) {
      const evidence = [];
      const processedPages = [];
      const scannedPages = [];
      const warnings = [];
      let characters = 0;
      let truncated = false;
      for (let page = 1; page <= Math.min(reader.info.numPages, maxPages); page += 1) {
        const record = await reader.page(page, { signal: options.signal });
        processedPages.push(page);
        if (record.scanned) scannedPages.push(page);
        if (record.warning) warnings.push({ page, message: record.warning });
        for (const block of record.blocks) {
          if (characters + block.text.length > maxChars) { truncated = true; break; }
          evidence.push(block); characters += block.text.length;
        }
        if (truncated) break;
      }
      return { evidence, coverage: { format: 'pdf', sourceHash: reader.info.sourceHash, totalPages: reader.info.numPages,
        processedPages, indexedPages: processedPages.length, scannedPages, warnings,
        complete: processedPages.length === reader.info.numPages && !truncated, truncated, maxPages, maxChars } };
    }
    // This path reads only the selected document's identity-bound cache. It never
    // follows a model-supplied path and never switches the active reading session.
    if (Number(doc.externalSize) > 128 * 1024 * 1024) throw new Error('请先打开这份较大的文档，再使用已加载的阅读器准备文字');
    const bytes = await cachedBytes(doc.id)
      || (doc.readerDraftKey === `${doc.id}-pdf-draft` ? await cachedBytes(doc.readerDraftKey) : null);
    if (!bytes) throw new Error('这份文档尚未缓存，请先打开一次后再选择为对话来源');
    if (bytes.byteLength > 128 * 1024 * 1024) throw new Error('请先打开这份较大的文档，再准备文字');
    tools.checkAbort(options.signal);
    const sourceHash = await sourceHashFor(doc, bytes);
    const request = { ...options, maxPages, maxChars, sourceHash, title: doc.name };
    return doc.readerFormat === 'pdf' ? tools.readPdf(bytes, request) : tools.readEpub(bytes, request);
  }

  async function exportNotes(session, instance) {
    const content = instance.exportNotes();
    const name = `${session.doc.name}-阅读笔记.md`;
    if (window.guanyiDesktop?.files?.saveAs) {
      const result = await window.guanyiDesktop.files.saveAs(name, content);
      if (!result || result.canceled) return false;
    } else {
      const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    session.hooks.notify('已导出阅读笔记');
    return true;
  }

  async function saveAs(doc) {
    const session = active;
    if (saving || !session || session.doc !== doc) return false;
    saving = true;
    try {
      const instance = await session.ready;
      if (!instance || active !== session) return false;
      if (doc.readerFormat === 'epub') return await exportNotes(session, instance);
      const exported = await instance.serializeSnapshot();
      const bytes = exported.bytes;
      const snapshot = JSON.stringify({ revision: exported.revision });
      const name = (doc.localFileName || `${doc.name}.${doc.readerFormat}`)
        .replace(/\.(epub|pdf)$/i, `-编辑.${doc.readerFormat}`);
      const mime = doc.readerFormat === 'pdf' ? 'application/pdf' : 'application/epub+zip';
      if (window.guanyiDesktop?.files?.saveBinaryAs) {
        const result = await window.guanyiDesktop.files.saveBinaryAs(name, bytes);
        if (!result || result.canceled) return false;
      } else if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: doc.readerFormat.toUpperCase(), accept: { [mime]: [`.${doc.readerFormat}`] } }]
        });
        const writable = await handle.createWritable();
        try { await writable.write(bytes); await writable.close(); }
        catch (error) { await writable.abort().catch(() => {}); throw error; }
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      doc.lastSavedContent = snapshot;
      session.hooks.changed();
      session.hooks.notify(`已另存 ${doc.readerFormat.toUpperCase()}`);
      return true;
    } catch (error) {
      if (error.name !== 'AbortError') session.hooks.notify(`另存失败：${error.message || error}`);
      return false;
    } finally {
      saving = false;
    }
  }

  window.GuanyiReaderHost = { format, isDocument, prepare, reuse, show, hide, saveAs, flush, getStudyReader, getReviewReader, waitForReviewReader, openStudy, readSource };
})();
