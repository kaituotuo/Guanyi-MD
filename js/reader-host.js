(function () {
  'use strict';

  const MAX_BYTES = 100 * 1024 * 1024;
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
    await cache(doc.id, new Uint8Array(bytes));
    return true;
  }

  async function prepare({ id, name, bytes }) {
    const readerFormat = format(name);
    const data = new Uint8Array(bytes);
    if (!readerFormat) throw new Error('不支持的阅读格式');
    if (!data.length || data.byteLength > MAX_BYTES) throw new Error('请选择小于 100 MB 的有效文档');
    const prefix = new TextDecoder().decode(data.subarray(0, 1024));
    if (readerFormat === 'pdf' ? !prefix.includes('%PDF-') : !prefix.startsWith('PK')) {
      throw new Error(`文件内容不是有效的 ${readerFormat.toUpperCase()}`);
    }
    await cache(id, data);
    const content = readerFormat === 'pdf' ? JSON.stringify({ revision: 'original' }) : '{}';
    return { readerFormat, content, lastSavedContent: content, readerPosition: null };
  }

  function retire(session) {
    retiring.add(session);
    session.closeFailed = false;
    session.disposePromise = Promise.resolve(session.ready).then(instance => instance?.dispose()).then(() => {
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
    return session.ready;
  }

  function hide() {
    const previous = active;
    active = null;
    if (previous) {
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
        container.replaceChildren();
        const engine = doc.readerFormat === 'pdf' ? window.GuanyiPdfReader : window.GuanyiEpubReader;
        const instance = await engine.open({
          bytes, container, toolbar, icon: hooks.icon, notify: hooks.notify,
          edits: JSON.parse(doc.content || '{}'), position: doc.readerPosition,
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
    await instance?.flush?.();
    await session?.hooks.persist(true);
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

  window.GuanyiReaderHost = { format, isDocument, prepare, reuse, show, hide, saveAs, flush };
})();
