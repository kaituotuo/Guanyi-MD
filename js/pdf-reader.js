/* PDF.js GENERIC viewer adapter. Rendering and annotations belong to upstream. */
(function () {
  'use strict';

  const VIEWER_URL = 'vendor/pdfjs/web/viewer.html?file=';
  const copyBytes = (bytes) => new Uint8Array(bytes).slice();

  async function open(options) {
    const { container, toolbar, icon, onChange, onSnapshot, notify, onPosition } = options;
    const frame = document.createElement('iframe');
    frame.className = 'guanyi-pdf-frame';
    frame.title = 'PDF 阅读与批注';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-modals');
    let viewer;
    let disposed = false;
    let closing = false;
    let checkpointTimer;
    let positionTimer;
    let revision = String(options.edits?.revision || 'original');
    let savedRevision = revision;
    let savedBytes = copyBytes(options.bytes);
    let checkpointQueue = Promise.resolve();
    let themeObserver;
    let storageHash;
    const listeners = new AbortController();
    const controls = [];

    function button(label, symbol, action) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'fmt-btn guanyi-pdf-tool';
      element.setAttribute('aria-label', label);
      element.title = label;
      element.innerHTML = icon(symbol);
      element.addEventListener('mousedown', event => event.preventDefault());
      element.addEventListener('click', action, { signal: listeners.signal });
      toolbar.append(element);
      controls.push(element);
      return element;
    }

    function scheduleCheckpoint() {
      clearTimeout(checkpointTimer);
      checkpointTimer = setTimeout(() => {
        // Keep the user's insertion point until their current text edit commits.
        const focused = frame.contentDocument?.activeElement;
        if (focused?.isContentEditable || /^(INPUT|TEXTAREA)$/.test(focused?.tagName || '')) return;
        checkpoint().catch(error => notify(`PDF 草稿保存失败：${error.message}`));
      }, 450);
    }

    function markChanged() {
      if (disposed || closing) return;
      revision = crypto.randomUUID();
      onChange({ revision });
      scheduleCheckpoint();
    }

    function endEditing() {
      const childDocument = frame.contentDocument;
      // PDF.js comments use their own dialog, outside the FreeText editor.
      // Commit through its native action so text still being typed also survives
      // a tab switch, Save As, or the application's awaited close handshake.
      const commentDialog = childDocument.getElementById('commentManagerDialog');
      const commentSave = childDocument.getElementById('commentManagerSaveButton');
      if (commentDialog?.open && !commentSave?.disabled) commentSave.click();
      viewer.pdfViewer._layerProperties.annotationEditorUIManager?.endCurrentEditing();
      childDocument.activeElement?.blur();
    }

    function syncStorageRevision() {
      if (disposed || closing || storageHash === undefined) return;
      const hash = viewer.pdfDocument.annotationStorage.serializable.hash;
      if (hash !== storageHash) {
        storageHash = hash;
        markChanged();
      }
    }

    function checkpoint(commit = false) {
      if (commit && !disposed) endEditing();
      // Flush native undo/delete/commit synchronously before the host takes its
      // saved revision, rather than depending on a later pointer/key event.
      syncStorageRevision();
      clearTimeout(checkpointTimer);
      const job = checkpointQueue.catch(() => {}).then(async () => {
        if (disposed || savedRevision === revision) return { bytes: copyBytes(savedBytes), revision: savedRevision };
        const capturedRevision = revision;
        const documentProxy = viewer.pdfDocument;
        const bytes = documentProxy.annotationStorage.size
          ? await documentProxy.saveDocument()
          : await documentProxy.getData();
        if (onSnapshot) await onSnapshot(copyBytes(bytes), capturedRevision);
        savedBytes = copyBytes(bytes);
        savedRevision = capturedRevision;
        return { bytes: copyBytes(bytes), revision: capturedRevision };
      });
      checkpointQueue = job;
      return job;
    }

    function reportPosition() {
      clearTimeout(positionTimer);
      positionTimer = setTimeout(() => {
        if (disposed) return;
        onPosition?.({ page: viewer.pdfViewer.currentPageNumber, zoom: viewer.pdfViewer.currentScaleValue });
      }, 150);
    }

    function applyFrameAppearance() {
      const root = frame.contentDocument.documentElement;
      const dark = document.documentElement.dataset.theme === 'dark';
      root.style.colorScheme = dark ? 'dark' : 'light';
      root.style.setProperty('--body-bg-color', dark ? '#222222' : '#f3f1ed');
      root.style.setProperty('--toolbar-bg-color', dark ? '#2b2b2b' : '#ffffff');
      root.style.setProperty('--toolbar-fg-color', dark ? '#eeeeee' : '#37332e');
    }

    let readyTimeout;
    const ready = new Promise((resolve, reject) => {
      readyTimeout = setTimeout(() => reject(new Error('PDF 阅读器加载超时，请重新打开')), 30000);
      document.addEventListener('webviewerloaded', event => {
        if (event.detail?.source !== frame.contentWindow) return;
        const appOptions = frame.contentWindow.PDFViewerApplicationOptions;
        appOptions.setAll({
          defaultUrl: '', disablePreferences: true, disableHistory: true,
          enableScripting: false, isEvalSupported: false,
          localeProperties: { lang: 'zh-CN' },
          enableComment: true, enableHighlightFloatingButton: true,
          enableSplitMerge: false, enableMerge: false, enableSignatureEditor: false,
          enableAltTextModelDownload: false, enableGuessAltText: false,
          enablePermissions: true, supportsPrinting: false,
          maxCanvasPixels: 16777216, maxCanvasDim: 8192
        });
        viewer = frame.contentWindow.PDFViewerApplication;
        viewer.initializedPromise.then(resolve, reject);
      }, { signal: listeners.signal });
      frame.addEventListener('error', () => reject(new Error('PDF 阅读器资源无法加载')), { once: true });
    });
    frame.src = new URL(VIEWER_URL, document.baseURI).href;
    container.append(frame);

    try {
      await ready;
      clearTimeout(readyTimeout);
      const childDocument = frame.contentDocument;
      const style = childDocument.createElement('link');
      style.rel = 'stylesheet';
      style.href = 'guanyi.css';
      childDocument.head.append(style);
      for (const id of ['findbar', 'viewsManager', 'editorHighlightParamsToolbar', 'editorFreeTextParamsToolbar', 'editorCommentParamsToolbar']) {
        const popover = childDocument.getElementById(id);
        if (popover) {
          popover.classList.add('guanyi-pdf-popover');
          childDocument.body.append(popover);
        }
      }
      applyFrameAppearance();
      themeObserver = new MutationObserver(applyFrameAppearance);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      // Route both the upstream download command and Ctrl/Cmd+S to the host.
      viewer.downloadOrSave = async () => {
        const save = toolbar.querySelector('.app-reader-save');
        if (save) save.click();
      };
      const upstreamHasChanges = viewer._hasChanges.bind(viewer);
      viewer._hasChanges = () => upstreamHasChanges() && (!onSnapshot || savedRevision !== revision);
      childDocument.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          event.stopImmediatePropagation();
          viewer.downloadOrSave();
        }
      }, { capture: true, signal: listeners.signal });
      if (viewer.downloadManager) {
        viewer.downloadManager.download = () => notify('请使用顶部“另存为”保存 PDF');
        viewer.downloadManager.openOrDownloadData = () => notify('请先另存 PDF，再使用系统阅读器打开附件');
      }
      viewer.pdfLinkService.externalLinkEnabled = false;
      await viewer.open({ data: copyBytes(options.bytes), filename: 'document.pdf', isEvalSupported: false });
      const eventBus = viewer.eventBus;
      if (!viewer.pdfViewer.pagesCount) {
        await new Promise(resolve => eventBus.on('pagesinit', resolve, { once: true }));
      }
      const dispatch = (name, detail = {}) => eventBus.dispatch(name, { source: frame.contentWindow, ...detail });
      // PDF.js interprets detail=0 as a keyboard action and immediately inserts
      // an editor at page centre. Host toolbar activation should only select the
      // tool; the following pointer click determines the annotation position.
      const nativeClick = id => {
        const element = childDocument.getElementById(id);
        if (!element || element.disabled) return;
        element.dispatchEvent(new frame.contentWindow.MouseEvent('click', {
          bubbles: true, detail: 1, view: frame.contentWindow
        }));
      };
      button('目录与页面缩略图', 'list-ul', () => nativeClick('viewsManagerToggleButton'));
      button('在 PDF 中查找', 'search', () => viewer.findBar.toggle());
      const previous = button('上一页', 'chevron-right', () => dispatch('previouspage'));
      previous.classList.add('guanyi-pdf-previous');
      const pageInput = document.createElement('input');
      pageInput.className = 'guanyi-pdf-page-number';
      pageInput.type = 'number';
      pageInput.min = '1';
      pageInput.max = String(viewer.pdfDocument.numPages);
      pageInput.setAttribute('aria-label', 'PDF 页码');
      pageInput.addEventListener('change', () => {
        const number = Math.max(1, Math.min(viewer.pdfDocument.numPages, Number(pageInput.value) || 1));
        viewer.pdfViewer.currentPageNumber = number;
      });
      const pageCount = document.createElement('span');
      pageCount.className = 'guanyi-pdf-page-count';
      pageCount.textContent = `/ ${viewer.pdfDocument.numPages}`;
      toolbar.append(pageInput, pageCount);
      controls.push(pageInput, pageCount);
      const next = button('下一页', 'chevron-right', () => dispatch('nextpage'));
      button('缩小', 'collapse-all', () => dispatch('zoomout'));
      button('放大', 'expand-all', () => dispatch('zoomin'));
      const fit = button('适合页宽', 'description', () => { viewer.pdfViewer.currentScaleValue = 'page-width'; });
      fit.insertAdjacentHTML('beforeend', '<span>页宽</span>');
      const highlighter = button('高亮批注', 'review', () => {
        if (childDocument.getSelection()?.toString().trim()) dispatch('editingaction', { name: 'highlightSelection' });
        else nativeClick('editorHighlightButton');
      });
      const textNote = button('文字笔记', 'rename', () => nativeClick('editorFreeTextButton'));
      const comment = button('评论笔记', 'comment-add', () => {
        if (childDocument.getSelection()?.toString().trim()) dispatch('editingaction', { name: 'commentSelection' });
        else nativeClick('editorCommentButton');
      });
      const undo = button('撤销批注', 'undo', () => dispatch('editingaction', { name: 'undo' }));
      const redo = button('恢复批注', 'redo', () => dispatch('editingaction', { name: 'redo' }));
      undo.disabled = redo.disabled = true;
      function updatePage() {
        const page = viewer.pdfViewer.currentPageNumber;
        pageInput.value = page;
        previous.disabled = page <= 1;
        next.disabled = page >= viewer.pdfDocument.numPages;
        reportPosition();
      }
      eventBus.on('pagechanging', updatePage);
      eventBus.on('scalechanging', reportPosition);
      eventBus.on('annotationeditormodechanged', ({ mode }) => {
        // Reuse upstream's state to keep toolbar buttons in sync with Escape.
        for (const [buttonElement, id] of [[highlighter, 'editorHighlightButton'], [textNote, 'editorFreeTextButton'], [comment, 'editorCommentButton']]) {
          buttonElement.setAttribute('aria-pressed', String(childDocument.getElementById(id).classList.contains('toggled')));
        }
      });
      eventBus.on('editingstateschanged', ({ details }) => {
        undo.disabled = !details?.hasSomethingToUndo;
        redo.disabled = !details?.hasSomethingToRedo;
        scheduleCheckpoint();
      });
      const annotationStorage = viewer.pdfDocument.annotationStorage;
      const originalModified = annotationStorage.onSetModified;
      annotationStorage.onSetModified = () => { originalModified?.(); markChanged(); };
      childDocument.addEventListener('input', event => {
        if (event.target.closest('.annotationEditorLayer, .annotationLayer, #commentManagerDialog')) markChanged();
      }, { capture: true, signal: listeners.signal });
      childDocument.addEventListener('focusout', () => scheduleCheckpoint(), { signal: listeners.signal });
      frame.contentWindow.addEventListener('beforeunload', () => {
        endEditing();
        syncStorageRevision();
        // The GENERIC viewer warns whenever annotationStorage is non-empty,
        // including annotations already saved. The host keeps that live storage
        // for undo/editing, and has a native awaited close handshake. Suppress
        // the upstream download warning only for an acknowledged binary draft,
        // through its _hasChanges bridge above. Unpersisted changes still block.
      }, { capture: true, signal: listeners.signal });
      // Once storage is dirty, its onSetModified callback does not fire again.
      // Editor commit/delete/undo signals therefore also need a revision.
      storageHash = annotationStorage.serializable.hash;
      const detectCommittedChange = () => {
        setTimeout(syncStorageRevision, 0);
      };
      childDocument.addEventListener('pointerup', detectCommittedChange, { signal: listeners.signal });
      childDocument.addEventListener('keyup', detectCommittedChange, { signal: listeners.signal });
      eventBus.on('editingstateschanged', detectCommittedChange);
      eventBus.on('annotationeditorparamschanged', detectCommittedChange);
      const initial = options.position || {};
      const restorePosition = () => {
        viewer.pdfViewer.currentScaleValue = initial.zoom || 'page-width';
        viewer.pdfViewer.currentPageNumber = Math.max(1, Math.min(viewer.pdfDocument.numPages, Number(initial.page) || 1));
        updatePage();
      };
      if (viewer.pdfViewer.pageViewsReady) restorePosition();
      else eventBus.on('pagesloaded', restorePosition, { once: true });
      updatePage();
      return {
        async serialize() { return (await checkpoint(true)).bytes; },
        async serializeSnapshot() { return checkpoint(true); },
        async flush() { return (await checkpoint(true)).bytes; },
        async dispose() {
          if (disposed) return;
          endEditing();
          await checkpoint();
          closing = true;
          disposed = true;
          clearTimeout(checkpointTimer);
          clearTimeout(positionTimer);
          listeners.abort();
          themeObserver.disconnect();
          // Host has persisted the draft; suppress upstream's auto-download-on-close.
          viewer.pdfDocument.annotationStorage.resetModified();
          await viewer.close();
          frame.remove();
          controls.forEach(control => control.remove());
        }
      };
    } catch (error) {
      clearTimeout(readyTimeout);
      clearTimeout(checkpointTimer);
      listeners.abort();
      themeObserver?.disconnect();
      await viewer?.pdfLoadingTask?.destroy().catch(() => {});
      frame.remove();
      controls.forEach(control => control.remove());
      throw error;
    }
  }
  window.GuanyiPdfReader = { open };
})();
