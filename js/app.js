/**
 * 观绎 MD — 本地优先的 Markdown 阅读与编辑工作台
 * 单一真相源：当前文档的 Markdown 字符串
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'md-editor-demo-state-v2';
  const SAVE_DEBOUNCE = 400;
  const RENDER_DEBOUNCE = 120;
  const HISTORY_LIMIT = 20;
  const HISTORY_COALESCE_MS = 400;
  const INDENT = '  ';
  const TABLE_MAX_ROWS = 8;
  const TABLE_MAX_COLS = 10;
  const SPLIT_RATIO_MIN = 0.25;
  const SPLIT_RATIO_MAX = 0.75;
  const SPLIT_PANE_MIN_PX = 280;
  const SPLIT_KEY_STEP = 0.03;
  const HANDLE_DB_NAME = 'md-editor-file-handles-v1';
  const HANDLE_STORE = 'documents';
  const DIRECTORY_HANDLE_STORE = 'directories';
  const HANDLE_DB_VERSION = 2;
  const CONTENT_MIGRATION_VERSION = 1;
  const PRESET_MIGRATION_VERSION = 7;
  const DIRECTORY_MIGRATION_VERSION = 1;
  const OPEN_EXTS = ['.md', '.markdown', '.txt'];
  const DIRECTORY_EXTS = ['.md', '.markdown', '.txt'];
  const DIRECTORY_MAX_DEPTH = 5;
  const DIRECTORY_MAX_FILES = 500;
  const DIRECTORY_MAX_FILE_SIZE_MB = 20;
  const DIRECTORY_MAX_FILE_SIZE = DIRECTORY_MAX_FILE_SIZE_MB * 1024 * 1024;
  const DIRECTORY_SCAN_INTERVAL = 5 * 60 * 1000;
  const DIRECTORY_IMAGE_MAX_FILE_SIZE = 20 * 1024 * 1024;
  const DATA_URL_IMAGE_MAX_FILE_SIZE = 1024 * 1024;
  const DATA_URL_IMAGE_MAX_TOTAL_CHARS = 2600000;
  const IMAGE_MIME_EXTENSIONS = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/avif': '.avif'
  };
  const REVIEW_STORAGE_KEY = 'md-editor-review-state-v1';
  const MODEL_CONFIG_KEY = 'md-editor-model-config-v1';
  const MODEL_SESSION_KEY = 'md-editor-model-session-key-v1';
  const MODEL_PERSISTENT_KEY = 'md-editor-model-persistent-key-v1';
  const REVIEW_SYNC_DEBOUNCE = 350;
  const AI_CONNECTION_TIMEOUT = 15000;
  const AI_GENERATION_TIMEOUT = 90000;
  const AI_PROXY_PATH = '/__md-editor-ai-proxy__/chat/completions';
  const AI_PROXY_MODELS_PATH = '/__md-editor-ai-proxy__/models';
  const AI_PROXY_HEALTH_PATH = '/__md-editor-ai-proxy__/health';
  const AI_PROXY_HEADER = 'x-md-editor-ai-proxy';
  const TEXT_FILE_PICKER_TYPES = [{
    description: 'Markdown 和文本',
    accept: { 'text/plain': OPEN_EXTS }
  }];
  const SEARCH_DEBOUNCE = 180;
  const SEARCH_RESULT_LIMIT = 50;
  const SEMANTIC_RESULT_LIMIT = 24;
  const SEMANTIC_SENTENCE_MAX_LENGTH = 620;
  const SEMANTIC_MAX_UNITS_PER_DOCUMENT = 1000000;

  const state = { docs: [], directories: [], currentDocId: null, viewMode: 'split', splitRatio: 0.5, theme: 'light', myDocsCollapsed: false };
  let saveTimer = null, renderTimer = null, syncScrollLock = false;
  let turndownService = null, previewEditing = false, confirmDocActionId = null, confirmDirectoryRemoveId = null;
  let pendingInputStarted = null, exportInProgress = false;
  let lastEditSurface = 'source', lastPreviewRange = null;
  let directoryScanTimer = null, activeDirectoryScanId = null;
  let directoryRefreshPromise = null;
  let directoryModalPreviousFocus = null;
  let reviewStore = { schemaVersion: 1, documents: {} };
  let modelConfig = null, draftCommentAnchor = null, editingCommentId = null, deletingCommentId = null;
  let activeCommentId = null, selectedPreviewBlock = null, sidecarFormat = 'markdown';
  let reviewSyncTimer = null, readingProgressTimer = null, activeReadingRequest = null;
  let localModelProxyAvailable = false;
  let sourceSelectionCaptureVersion = 0;
  let pendingImageInsertion = null;
  let previewImageRenderToken = 0;
  let previewImagesReady = Promise.resolve();
  let draggedPreviewImage = null, previewImageDragSourceRow = null;
  let previewInputTimer = null;
  let previewPointerDown = null;
  const previewImageObjectUrls = new Set();
  const histories = new Map();
  const semanticDocumentCache = new Map();
  let semanticIndexSyncPromise = null, semanticIndexRevision = 0, semanticIndexSyncedRevision = -1;
  let semanticIndexSyncSummary = null;
  let semanticIndexSyncTimer = null;
  let searchTimer = null, searchRunToken = 0;
  let searchModalPreviousFocus = null, activeSearchResults = [], activeSearchResultIndex = -1;
  let activeSearchQuery = '', activeSearchNavigation = null;
  let removeSemanticProgressListener = null;
  const els = {};

  function $(id) { return document.getElementById(id); }

  function isImeCompositionEvent(event) {
    return !!event && (event.isComposing || event.keyCode === 229 || event.which === 229);
  }

  function initDOM() {
    els.docList = $('doc-list');
    els.outlineList = $('outline-list');
    els.viewSeg = $('view-seg');
    els.themeBtn = $('btn-theme');
    els.editorContainer = $('editor-container');
    els.sourceEditor = $('source-editor');
    els.splitResizer = $('split-resizer');
    els.previewWrap = $('preview-wrap');
    els.previewEditor = $('preview-editor');
    els.statusText = $('status-text');
    els.saveIndicator = $('save-indicator');
    els.tip = $('tip');
    els.dropMask = $('drop-mask');
    els.fileOpen = $('file-open');
    els.imageFileOpen = $('image-file-open');
    els.headingBtn = $('btn-heading');
    els.headingMenu = $('heading-menu');
    els.tableBtn = $('btn-table');
    els.tablePicker = $('table-picker');
    els.tablePickerGrid = $('table-picker-grid');
    els.tablePickerStatus = $('table-picker-status');
    els.imageBtn = $('btn-image');
    els.imageMenu = $('image-menu');
    els.btnImageFile = $('btn-image-file');
    els.btnImageUrl = $('btn-image-url');
    els.fmtbar = $('fmtbar');
    els.btnNewDoc = $('btn-new-doc');
    els.btnOpenDoc = $('btn-open-doc');
    els.btnAddDirectory = $('btn-add-directory');
    els.btnRefreshDirectories = $('btn-refresh-directories');
    els.btnToggleAllDocs = $('btn-toggle-all-docs');
    els.btnSearchDocs = $('btn-search-docs');
    els.searchModal = $('search-modal');
    els.searchInput = $('search-input');
    els.searchResults = $('search-results');
    els.searchSummaryTitle = $('search-summary-title');
    els.searchSummaryStatus = $('search-summary-status');
    els.semanticSearchStatus = $('semantic-search-status');
    els.btnSearchClose = $('btn-search-close');
    els.openDocInfo = $('open-doc-info');
    els.openDocTip = $('open-doc-tip');
    els.btnExport = $('btn-export');
    els.exportMenu = $('export-menu');
    els.btnMd = $('btn-md');
    els.btnPdf = $('btn-pdf');
    els.btnImg = $('btn-img');
    els.btnUndo = $('btn-undo');
    els.btnRedo = $('btn-redo');
    els.btnSave = $('btn-save');
    els.linkMenu = $('link-menu');
    els.linkMenuOpen = $('link-menu-open');
    els.directoryModal = $('directory-modal');
    els.directoryList = $('directory-list');
    els.directoryEmpty = $('directory-empty');
    els.directoryUnsupported = $('directory-unsupported');
    els.btnDirectoryAdd = $('btn-directory-add');
    els.btnDirectoryClose = $('btn-directory-close');
    els.btnDirectoryDone = $('btn-directory-done');
    els.conflictBar = $('directory-conflict-bar');
    els.conflictText = $('directory-conflict-text');
    els.btnConflictView = $('btn-conflict-view');
    els.btnConflictKeep = $('btn-conflict-keep');
    els.btnConflictReload = $('btn-conflict-reload');
    els.conflictModal = $('conflict-modal');
    els.conflictCurrent = $('conflict-current');
    els.conflictDisk = $('conflict-disk');
    els.btnConflictClose = $('btn-conflict-close');
    els.btnConflictCancel = $('btn-conflict-cancel');
    els.btnConflictConfirmReload = $('btn-conflict-confirm-reload');
    els.btnComments = $('btn-comments');
    els.commentCount = $('comment-count');
    els.collabDrawer = $('collab-drawer');
    els.drawerMask = $('drawer-mask');
    els.btnCloseDrawer = $('btn-close-drawer');
    els.commentList = $('comment-list');
    els.commentComposer = $('comment-composer');
    els.commentInput = $('comment-input');
    els.composerTitle = $('composer-title');
    els.composerScope = $('composer-scope');
    els.composerQuote = $('composer-quote');
    els.btnSubmitComment = $('btn-submit-comment');
    els.btnCancelComment = $('btn-cancel-comment');
    els.reviewSyncState = $('review-sync-state');
    els.sidecarModal = $('sidecar-modal');
    els.sidecarContent = $('sidecar-content');
    els.btnSidecarSync = $('btn-sidecar-sync');
    els.deleteCommentModal = $('delete-comment-modal');
    els.deleteCommentPreview = $('delete-comment-preview');
    els.modelModal = $('model-modal');
    els.modelForm = $('model-form');
    els.modelProvider = $('model-provider');
    els.modelBaseUrl = $('model-base-url');
    els.modelName = $('model-name');
    els.modelNameCustom = $('model-name-custom');
    els.modelApiKey = $('model-api-key');
    els.rememberApiKey = $('remember-api-key');
    els.modelState = $('model-state');
    els.btnGenerateSummary = $('btn-generate-summary');
    els.summaryHint = $('summary-hint');
    els.summaryResults = $('summary-results');
    els.readingProgress = $('reading-progress');
    els.readingProgressLabel = $('reading-progress-label');
    els.dropMaskPanel = els.dropMask?.querySelector('.app-drop-mask__panel') || null;
    els.imageUrlModal = $('image-url-modal');
    els.imageUrlForm = $('image-url-form');
    els.imageUrlInput = $('image-url-input');
    els.imageAltInput = $('image-alt-input');
    els.btnImageUrlClose = $('btn-image-url-close');
    els.btnImageUrlCancel = $('btn-image-url-cancel');
  }

  function initMarked() {
    if (typeof marked === 'undefined') { console.error('marked.js 未加载'); return; }
    marked.setOptions({ gfm: true, breaks: false });
  }

  function initTurndown() {
    if (typeof TurndownService === 'undefined') return;
    turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', emDelimiter: '*' });
    turndownService.addRule('strikethrough', { filter: ['del', 's'], replacement: (c) => '~~' + c + '~~' });
    turndownService.addRule('preservedImageSource', {
      filter: (n) => n.nodeName === 'IMG' && n.hasAttribute('data-md-image-source'),
      replacement: (_content, n) => markdownImageSyntax(
        n.getAttribute('alt') || '',
        n.getAttribute('data-md-image-source') || '',
        n.getAttribute('title') || ''
      )
    });
    turndownService.addRule('previewCaretPlaceholder', {
      filter: (n) => n.nodeName === 'P'
        && n.hasAttribute('data-md-preview-caret')
        && !String(n.textContent || '').replace(/[\s\u200B\uFEFF]/g, '')
        && !n.querySelector('img, table, hr, video, audio, iframe, canvas'),
      replacement: () => ''
    });
    turndownService.addRule('searchHighlight', {
      filter: (n) => n.nodeName === 'MARK' && n.classList.contains('app-search-match'),
      replacement: (content) => content
    });
    turndownService.addRule('taskCheckbox', {
      filter: (n) => n.type === 'checkbox' && n.parentNode && n.parentNode.nodeName === 'LI',
      replacement: () => ''
    });
    turndownService.addRule('compactListItem', {
      filter: 'li',
      replacement: (content, n) => {
        const checkbox = Array.from(n.children || []).find((child) => child.type === 'checkbox');
        const parent = n.parentNode;
        let prefix = checkbox ? `- [${checkbox.checked ? 'x' : ' '}] ` : '- ';
        if (!checkbox && parent?.nodeName === 'OL') {
          const start = Number(parent.getAttribute('start')) || 1;
          prefix = `${start + Array.prototype.indexOf.call(parent.children, n)}. `;
        }
        let body = content.replace(/[\u200B\uFEFF]/g, '');
        if (checkbox) body = body.replace(/^[ \t]+/, '');
        const hadTrailingNewline = /\n$/.test(body);
        body = body.replace(/^\n+|\n+$/g, '') + (hadTrailingNewline ? '\n' : '');
        const continuationIndent = checkbox ? 2 : prefix.length;
        body = body.replace(/\n/g, `\n${' '.repeat(continuationIndent)}`);
        return prefix + body + (n.nextSibling && !/\n$/.test(body) ? '\n' : '');
      }
    });
  }

  function currentDoc() { return state.docs.find((d) => d.id === state.currentDocId) || null; }
  function getCurrentMarkdown() { return currentDoc()?.content ?? ''; }
  function isLocalFileDoc(doc) { return !!doc && doc.sourceKind === 'local-file'; }
  function isDirectoryDoc(doc) { return !!doc && doc.sourceKind === 'directory-file'; }
  function isDiskFileDoc(doc) { return isLocalFileDoc(doc) || isDirectoryDoc(doc); }

  function setProgrammaticSourceSelection(start, end) {
    const version = ++sourceSelectionCaptureVersion;
    els.sourceEditor.setSelectionRange(start, end);
    requestAnimationFrame(() => {
      if (sourceSelectionCaptureVersion === version) sourceSelectionCaptureVersion = 0;
    });
  }

  function touchDoc(doc) {
    if (!doc) return;
    const latest = state.docs.reduce((max, item) => Math.max(max, Number(item.lastOpenedAt) || 0), 0);
    doc.lastOpenedAt = Math.max(Date.now(), latest + 1);
  }

  function revealDoc(docId) {
    requestAnimationFrame(() => {
      const item = els.docList && [...els.docList.querySelectorAll('.app-doc-item')].find((entry) => entry.dataset.docId === docId);
      if (item && !item.closest('[hidden]')) item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function openHandleDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { resolve(null); return; }
      const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(HANDLE_STORE)) {
          request.result.createObjectStore(HANDLE_STORE, { keyPath: 'id' });
        }
        if (!request.result.objectStoreNames.contains(DIRECTORY_HANDLE_STORE)) {
          request.result.createObjectStore(DIRECTORY_HANDLE_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('文件授权存储初始化失败'));
    });
  }

  async function persistDocHandles(doc) {
    if (!doc || !doc.fileHandle) return;
    try {
      const db = await openHandleDB();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).put({
          id: doc.id,
          fileHandle: doc.fileHandle,
          directoryHandle: doc.directoryHandle || null,
          localFileName: doc.localFileName || doc.fileHandle.name || null,
          directoryId: doc.directoryId || null,
          relativePath: doc.relativePath || null
        });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('文件授权保存失败'));
      });
      db.close();
    } catch (error) { console.warn('无法持久化文件授权', error); }
  }

  async function removePersistedHandles(docId) {
    try {
      const db = await openHandleDB();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).delete(docId);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('文件授权清理失败'));
      });
      db.close();
    } catch (error) { console.warn('无法清理文件授权', error); }
  }

  async function restoreDocHandles() {
    try {
      const db = await openHandleDB();
      if (!db) return;
      const records = await new Promise((resolve, reject) => {
        const request = db.transaction(HANDLE_STORE, 'readonly').objectStore(HANDLE_STORE).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('文件授权恢复失败'));
      });
      db.close();
      records.forEach((record) => {
        const doc = state.docs.find((item) => item.id === record.id);
        if (!doc || !record.fileHandle) return;
        doc.fileHandle = record.fileHandle;
        doc.directoryHandle = record.directoryHandle || null;
        doc.localFileName = record.localFileName || record.fileHandle.name || doc.localFileName || null;
        doc.openedWithoutHandle = false;
        doc.sourceKind = record.directoryId ? 'directory-file' : 'local-file';
        doc.directoryId = record.directoryId || doc.directoryId || null;
        doc.relativePath = record.relativePath || doc.relativePath || null;
      });
    } catch (error) { console.warn('无法恢复文件授权', error); }
  }

  async function persistDirectoryHandle(directory) {
    if (!directory || !directory.handle) return;
    try {
      const db = await openHandleDB();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DIRECTORY_HANDLE_STORE, 'readwrite');
        tx.objectStore(DIRECTORY_HANDLE_STORE).put({ id: directory.id, handle: directory.handle });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('目录授权保存失败'));
      });
      db.close();
    } catch (error) { console.warn('无法持久化目录授权', error); }
  }

  async function removePersistedDirectory(directoryId) {
    try {
      const db = await openHandleDB();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction([DIRECTORY_HANDLE_STORE, HANDLE_STORE], 'readwrite');
        tx.objectStore(DIRECTORY_HANDLE_STORE).delete(directoryId);
        const docStore = tx.objectStore(HANDLE_STORE);
        const request = docStore.getAll();
        request.onsuccess = () => {
          (request.result || []).forEach((record) => {
            if (record.directoryId === directoryId) docStore.delete(record.id);
          });
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('目录授权清理失败'));
      });
      db.close();
    } catch (error) { console.warn('无法清理目录授权', error); }
  }

  async function restoreDirectoryHandles() {
    try {
      const db = await openHandleDB();
      if (!db) return;
      const records = await new Promise((resolve, reject) => {
        const request = db.transaction(DIRECTORY_HANDLE_STORE, 'readonly').objectStore(DIRECTORY_HANDLE_STORE).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('目录授权恢复失败'));
      });
      db.close();
      records.forEach((record) => {
        const directory = state.directories.find((item) => item.id === record.id);
        if (directory && record.handle) directory.handle = record.handle;
      });
    } catch (error) { console.warn('无法恢复目录授权', error); }
  }

  function ensureHistory(doc) {
    if (!doc) return null;
    if (!histories.has(doc.id)) {
      histories.set(doc.id, { entries: [doc.content], uiEntries: [null], index: 0, lastInputAt: 0, lastInputSource: null });
    }
    const history = histories.get(doc.id);
    if (!Array.isArray(history.uiEntries)) history.uiEntries = history.entries.map(() => null);
    while (history.uiEntries.length < history.entries.length) history.uiEntries.push(null);
    if (history.uiEntries.length > history.entries.length) history.uiEntries.length = history.entries.length;
    return history;
  }

  function trimHistory(history) {
    const maxEntries = HISTORY_LIMIT + 1;
    if (!history || history.entries.length <= maxEntries) return;
    const overflow = history.entries.length - maxEntries;
    history.entries.splice(0, overflow);
    history.uiEntries.splice(0, overflow);
    history.index = Math.max(0, history.index - overflow);
  }

  function resetHistoryCoalescing(history) {
    if (!history) return;
    history.lastInputAt = 0;
    history.lastInputSource = null;
  }

  function recordHistory(doc, markdown, inputSource, historyUi) {
    const history = ensureHistory(doc);
    if (!history) return;
    if (history.entries[history.index] === markdown) {
      if (historyUi !== undefined) history.uiEntries[history.index] = historyUi;
      return;
    }
    const now = Date.now();
    const canCoalesce = !!inputSource
      && history.lastInputSource === inputSource
      && (now - history.lastInputAt) < HISTORY_COALESCE_MS
      && history.index === history.entries.length - 1
      && history.entries.length > 0;
    if (canCoalesce) {
      history.entries[history.index] = markdown;
      history.uiEntries[history.index] = historyUi || null;
      if (history.index > 0 && history.entries[history.index - 1] === markdown) {
        history.entries.splice(history.index, 1);
        history.uiEntries.splice(history.index, 1);
        history.index -= 1;
      }
    } else {
      history.entries = history.entries.slice(0, history.index + 1);
      history.uiEntries = history.uiEntries.slice(0, history.index + 1);
      history.entries.push(markdown);
      history.uiEntries.push(historyUi || null);
      history.index = history.entries.length - 1;
      trimHistory(history);
    }
    if (inputSource) {
      history.lastInputAt = now;
      history.lastInputSource = inputSource;
    } else {
      resetHistoryCoalescing(history);
    }
  }

  function setCurrentMarkdown(md, options) {
    const doc = currentDoc();
    if (!doc) return;
    const opts = options || {};
    if (doc.content === md) return;
    ensureHistory(doc);
    doc.content = md;
    markSemanticIndexDirty(doc.id);
    markCurrentAnalysisStale();
    if (opts.record !== false) recordHistory(doc, md, opts.inputSource || null, opts.historyUi);
    if (els.sourceEditor.value !== md) els.sourceEditor.value = md;
    // 预览 contenteditable 回写时禁止整页重渲染，否则会冲掉选区/光标
    if (opts.skipRender) updateOutline();
    else scheduleRender();
    scheduleSave();
    updateStatus();
    updateEditChrome();
  }

  function applyHistory(direction) {
    flushPendingPreviewCommit();
    const doc = currentDoc();
    const history = ensureHistory(doc);
    if (!doc || !history) return false;
    const nextIndex = history.index + direction;
    if (nextIndex < 0 || nextIndex >= history.entries.length) return false;
    history.index = nextIndex;
    resetHistoryCoalescing(history);
    setCurrentMarkdown(history.entries[nextIndex], { record: false });
    renderPreview();
    restorePreviewHistoryUi(history.uiEntries[nextIndex]);
    updateEditChrome();
    return true;
  }

  function canUndo() {
    const history = ensureHistory(currentDoc());
    return !!(history && history.index > 0);
  }

  function canRedo() {
    const history = ensureHistory(currentDoc());
    return !!(history && history.index < history.entries.length - 1);
  }

  function isDocDirty(doc) {
    if (!doc) return false;
    if (typeof doc.lastSavedContent !== 'string') return false;
    return doc.content !== doc.lastSavedContent;
  }

  function markDocSaved(doc, content) {
    if (!doc) return;
    doc.lastSavedContent = typeof content === 'string' ? content : doc.content;
  }

  function updateEditChrome() {
    const doc = currentDoc();
    const dirty = isDocDirty(doc);
    if (els.btnUndo) {
      els.btnUndo.disabled = !canUndo();
      els.btnUndo.setAttribute('aria-disabled', els.btnUndo.disabled ? 'true' : 'false');
    }
    if (els.btnRedo) {
      els.btnRedo.disabled = !canRedo();
      els.btnRedo.setAttribute('aria-disabled', els.btnRedo.disabled ? 'true' : 'false');
    }
    if (els.btnSave) {
      els.btnSave.classList.toggle('is-dirty', dirty);
      els.btnSave.title = dirty
        ? (doc && doc.fileHandle ? '保存到原文件 (Ctrl/Cmd+S)' : '保存到本地文档 (Ctrl/Cmd+S)')
        : (doc && doc.fileHandle ? '已与原文件同步 (Ctrl/Cmd+S)' : '保存到本地文档 (Ctrl/Cmd+S)');
    }
  }

  function stripLegacyProjectMetadata(content) {
    if (typeof content !== 'string') return content;
    return content
      .replace(/\n{2}\*\*负责人\*\*：[^\n]+/g, '')
      .replace(/\n{2}\*\*相关链接\*\*：\[[^\]]+\]\([^)]+\)/g, '');
  }

  function contentFingerprint(content) {
    let hash = 0;
    const text = typeof content === 'string' ? content : '';
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return `${text.length}:${hash >>> 0}`;
  }

  function normalizeRelativePath(path) {
    return String(path || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  }

  function directoryDocId(directoryId, relativePath) {
    const fingerprint = contentFingerprint(`${directoryId}\n${normalizeRelativePath(relativePath)}`).replace(':', '-');
    return `directory-file-${fingerprint}`;
  }

  function shouldIgnoreDirectoryEntry(name, kind, depth) {
    const value = String(name || '');
    if (!value || value.startsWith('.')) return true;
    if (kind === 'directory') return value === 'node_modules' || depth >= DIRECTORY_MAX_DEPTH;
    const lower = value.toLowerCase();
    if (lower.endsWith('.review.md') || lower.endsWith('.review.json')) return true;
    return !DIRECTORY_EXTS.some((extension) => lower.endsWith(extension));
  }

  function diffDirectoryIndex(existingDocs, entries) {
    const existing = new Map((existingDocs || []).map((doc) => [normalizeRelativePath(doc.relativePath), doc]));
    const scanned = new Map((entries || []).map((entry) => [normalizeRelativePath(entry.relativePath), entry]));
    const added = [], changed = [], unchanged = [], missing = [];
    scanned.forEach((entry, relativePath) => {
      const doc = existing.get(relativePath);
      if (!doc) added.push(entry);
      else if (Number(doc.externalModifiedAt) !== Number(entry.lastModified)
        || Number(doc.externalSize) !== Number(entry.size)) changed.push({ doc, entry });
      else unchanged.push({ doc, entry });
    });
    existing.forEach((doc, relativePath) => { if (!scanned.has(relativePath)) missing.push(doc); });
    return { added, changed, unchanged, missing };
  }

  function serializeDirectory(directory) {
    return {
      id: directory.id,
      name: directory.name,
      handleName: directory.handleName,
      permissionState: directory.permissionState || 'prompt',
      scanMode: directory.scanMode || 'interval',
      lastScannedAt: Number(directory.lastScannedAt) || 0,
      lastScanStatus: directory.lastScanStatus || 'idle',
      lastScanSummary: directory.lastScanSummary || null,
      order: Number(directory.order) || 0,
      collapsed: !!directory.collapsed,
      collapsedPaths: Array.isArray(directory.collapsedPaths) ? directory.collapsedPaths : [],
      createdAt: Number(directory.createdAt) || Date.now()
    };
  }

  function migratePresetDocs(docs, currentDocId, presets) {
    const legacyPresets = {
      'doc-1': { name: '功能演示', fingerprints: ['650:4030025944'], targetId: 'builtin-feature-demo' },
      'doc-2': { name: '产品方案', fingerprints: ['425:1752367512', '426:2783785330'], targetId: 'builtin-product-intro' },
      'doc-3': { name: '空白模板', fingerprints: ['156:1957678079'], targetId: 'builtin-general-template' }
    };
    const factoryPresetUpgrades = {
      'builtin-product-intro': { name: '产品介绍', fingerprints: ['549:979998719', '792:810326343', '993:1781648031'] },
      'builtin-product-intro-en': { name: '产品介绍（英文）', fingerprints: ['1211:2407879867', '1735:3783713428'] }
    };
    const presetById = new Map(presets.map((preset) => [preset.id, preset]));
    const existingPresetIds = new Set(docs.map((doc) => doc.id));
    let nextCurrentDocId = currentDocId;
    let changed = false;
    const migrated = docs.map((doc) => {
      const legacy = legacyPresets[doc.id];
      const target = legacy && presetById.get(legacy.targetId);
      if (target && doc.name === legacy.name && legacy.fingerprints.includes(contentFingerprint(doc.content))) {
        changed = true;
        if (nextCurrentDocId === doc.id) nextCurrentDocId = target.id;
        if (existingPresetIds.has(target.id)) return null;
        return {
          ...doc,
          id: target.id,
          name: target.name,
          content: target.content,
          lastSavedContent: target.content
        };
      }
      const upgrade = factoryPresetUpgrades[doc.id];
      const currentPreset = upgrade && presetById.get(doc.id);
      const browserPreset = !doc.sourceKind || doc.sourceKind === 'browser';
      if (!currentPreset || !browserPreset || doc.localFileName || doc.name !== upgrade.name
        || !upgrade.fingerprints.includes(contentFingerprint(doc.content))) return doc;
      changed = true;
      return { ...doc, name: currentPreset.name, content: currentPreset.content, lastSavedContent: currentPreset.content };
    }).filter(Boolean);

    const existingIds = new Set(migrated.map((doc) => doc.id));
    const oldestTime = migrated.reduce((min, doc) => {
      const time = Number(doc.lastOpenedAt);
      return Math.min(min, Number.isFinite(time) ? time : Date.now());
    }, Date.now());
    presets.forEach((preset, index) => {
      if (existingIds.has(preset.id)) return;
      changed = true;
      migrated.push({
        ...preset,
        lastSavedContent: preset.content,
        fileHandle: null,
        directoryHandle: null,
        localFileName: null,
        openedWithoutHandle: false,
        sourceKind: 'browser',
        lastOpenedAt: oldestTime - index - 1
      });
      existingIds.add(preset.id);
    });
    return { docs: migrated, currentDocId: nextCurrentDocId, changed };
  }

  function loadState() {
    const presets = (window.PRESET_DOCS || []).map((d) => ({ id: d.id, name: d.name, content: d.content }));
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && Array.isArray(saved.docs) && saved.docs.length) {
          const docs = saved.docs.filter((d) => d && d.id && typeof d.name === 'string' && typeof d.content === 'string');
          if (docs.length) {
            const savedMigrationVersion = Number(saved.contentMigrationVersion);
            const shouldMigrateMetadata = !Number.isFinite(savedMigrationVersion)
              || savedMigrationVersion < CONTENT_MIGRATION_VERSION;
            const validTimes = docs.map((d) => Number(d.lastOpenedAt)).filter(Number.isFinite);
            const fallbackBase = validTimes.length ? Math.min(...validTimes) - docs.length : Date.now() - docs.length;
            state.docs = docs.map((d) => {
              const content = shouldMigrateMetadata && d.id === 'doc-2' ? stripLegacyProjectMetadata(d.content) : d.content;
              const savedContent = typeof d.lastSavedContent === 'string' ? d.lastSavedContent : d.content;
              const lastSavedContent = shouldMigrateMetadata && d.id === 'doc-2'
                ? stripLegacyProjectMetadata(savedContent)
                : savedContent;
              return {
                ...d,
                content,
                lastSavedContent,
                fileHandle: null,
                directoryHandle: null,
                localFileName: d.localFileName || null,
                openedWithoutHandle: !!d.openedWithoutHandle,
                sourceKind: d.sourceKind || (d.localFileName ? 'local-file' : 'browser'),
                directoryId: d.directoryId || null,
                relativePath: d.relativePath || null,
                externalModifiedAt: Number(d.externalModifiedAt) || 0,
                externalSize: Number(d.externalSize) || 0,
                syncState: d.syncState || 'synced',
                unread: !!d.unread,
                contentLoaded: d.contentLoaded !== false,
                externalContent: typeof d.externalContent === 'string' ? d.externalContent : null,
                lastOpenedAt: Number.isFinite(Number(d.lastOpenedAt))
                  ? Number(d.lastOpenedAt)
                  : fallbackBase + (docs.length - docs.indexOf(d))
              };
            });
            state.currentDocId = saved.currentDocId && docs.some((d) => d.id === saved.currentDocId) ? saved.currentDocId : docs[0].id;
            const savedPresetMigrationVersion = Number(saved.presetMigrationVersion);
            const shouldMigratePresets = !Number.isFinite(savedPresetMigrationVersion)
              || savedPresetMigrationVersion < PRESET_MIGRATION_VERSION;
            if (shouldMigratePresets) {
              const migration = migratePresetDocs(state.docs, state.currentDocId, presets);
              state.docs = migration.docs;
              state.currentDocId = migration.currentDocId;
            }
            if (!validTimes.length) touchDoc(state.docs.find((d) => d.id === state.currentDocId));
            if (saved.viewMode) state.viewMode = saved.viewMode;
            if (Number.isFinite(Number(saved.splitRatio))) {
              state.splitRatio = Math.max(SPLIT_RATIO_MIN, Math.min(SPLIT_RATIO_MAX, Number(saved.splitRatio)));
            }
            if (saved.theme) state.theme = saved.theme;
            state.myDocsCollapsed = !!saved.myDocsCollapsed;
            state.directories = Array.isArray(saved.directories)
              ? saved.directories.filter((directory) => directory && directory.id && directory.name).map((directory, index) => ({
                ...serializeDirectory(directory),
                handle: null,
                order: Number.isFinite(Number(directory.order)) ? Number(directory.order) : index
              }))
              : [];
            if (shouldMigrateMetadata || shouldMigratePresets) saveState({ silent: true });
            return;
          }
        }
      }
    } catch (e) { console.warn('加载 localStorage 失败，使用预设文档', e); }
    state.docs = (presets.length ? presets : [{ id: 'doc-empty', name: '未命名文档', content: '' }])
      .map((d, index) => ({ ...d, lastSavedContent: d.content, fileHandle: null, directoryHandle: null,
        localFileName: null, openedWithoutHandle: false, sourceKind: 'browser', lastOpenedAt: Date.now() - index }));
    state.currentDocId = state.docs[0].id;
    state.directories = [];
  }

  function saveState(options) {
    const payload = {
      docs: state.docs.map((d) => ({
        id: d.id,
        name: d.name,
        content: d.content,
        lastSavedContent: typeof d.lastSavedContent === 'string' ? d.lastSavedContent : d.content,
        localFileName: d.localFileName || null,
        openedWithoutHandle: !!d.openedWithoutHandle,
        sourceKind: isDirectoryDoc(d) ? 'directory-file' : (isLocalFileDoc(d) ? 'local-file' : 'browser'),
        directoryId: d.directoryId || null,
        relativePath: d.relativePath || null,
        externalModifiedAt: Number(d.externalModifiedAt) || 0,
        externalSize: Number(d.externalSize) || 0,
        syncState: d.syncState || 'synced',
        unread: !!d.unread,
        contentLoaded: d.contentLoaded !== false,
        externalContent: typeof d.externalContent === 'string' ? d.externalContent : null,
        lastOpenedAt: Number(d.lastOpenedAt) || 0
      })),
      directories: state.directories.map(serializeDirectory),
      currentDocId: state.currentDocId,
      viewMode: state.viewMode,
      splitRatio: state.splitRatio,
      theme: state.theme,
      myDocsCollapsed: !!state.myDocsCollapsed,
      contentMigrationVersion: CONTENT_MIGRATION_VERSION,
      presetMigrationVersion: PRESET_MIGRATION_VERSION,
      directoryMigrationVersion: DIRECTORY_MIGRATION_VERSION
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); }
    catch (e) { console.warn('保存 localStorage 失败', e); }
    if (!options || !options.silent) flashSaveIndicator();
  }

  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, SAVE_DEBOUNCE); }
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(renderPreview, RENDER_DEBOUNCE); }

  function flashSaveIndicator() {
    els.saveIndicator.textContent = '已保存';
    clearTimeout(flashSaveIndicator._t);
    flashSaveIndicator._t = setTimeout(() => { els.saveIndicator.textContent = ''; }, 2000);
  }

  function annotatePreviewLinks() {
    els.previewEditor.querySelectorAll('a[href]').forEach((anchor) => {
      if (!anchor.getAttribute('title')) {
        anchor.setAttribute('title', 'Ctrl/Cmd+单击打开链接');
      }
    });
  }

  function releasePreviewImageUrls() {
    previewImageObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    previewImageObjectUrls.clear();
  }

  function isRelativeImageSource(source) {
    const value = String(source || '').trim();
    return !!value
      && value.charAt(0) !== '#'
      && value.charAt(0) !== '/'
      && !value.startsWith('//')
      && !/^[a-z][a-z0-9+.-]*:/i.test(value);
  }

  function safeRelativeImageParts(baseParts, source) {
    const path = String(source || '').split(/[?#]/, 1)[0].replace(/\\/g, '/');
    const parts = [...(baseParts || [])];
    for (const rawPart of path.split('/')) {
      if (!rawPart || rawPart === '.') continue;
      let part;
      try { part = decodeURIComponent(rawPart); }
      catch (_error) { throw new Error('图片路径编码无效'); }
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) throw new Error('图片路径超出已授权目录');
        parts.pop();
        continue;
      }
      if (part.includes('/') || part.includes('\\') || part.includes('\0')) throw new Error('图片路径无效');
      parts.push(part);
    }
    if (!parts.length) throw new Error('图片路径为空');
    return parts;
  }

  async function localImageFileForDoc(doc, source) {
    let root = null;
    let baseParts = [];
    if (isDirectoryDoc(doc)) {
      const directory = directoryForDoc(doc);
      root = directory?.handle || null;
      baseParts = normalizeRelativePath(doc.relativePath).split('/');
      baseParts.pop();
    } else if (isLocalFileDoc(doc) && doc.directoryHandle) {
      root = doc.directoryHandle;
    }
    if (!root) throw new Error('当前文档未关联可读目录');
    const permission = root.queryPermission ? await root.queryPermission({ mode: 'read' }) : 'granted';
    if (permission !== 'granted') throw new Error('需要重新授权文档目录');
    const parts = safeRelativeImageParts(baseParts, source);
    const fileName = parts.pop();
    const parent = await directoryHandleAtPath(root, parts);
    return (await parent.getFileHandle(fileName)).getFile();
  }

  function isImageOnlyParagraph(paragraph) {
    if (!paragraph || paragraph.tagName !== 'P') return false;
    const images = [...paragraph.children].filter((child) => child.tagName === 'IMG');
    if (!images.length || images.length !== paragraph.children.length) return false;
    return [...paragraph.childNodes].every((node) => node.nodeType === Node.TEXT_NODE ? !node.textContent.trim() : node.nodeName === 'IMG');
  }

  function markPreviewImageRow(paragraph) {
    const images = [...paragraph.querySelectorAll(':scope > img')];
    const count = images.length;
    if (!count || count > 6) return;
    paragraph.classList.add('app-image-row');
    paragraph.dataset.imageCount = String(count);
    paragraph.style.setProperty('--app-image-row-count', String(count));
    paragraph.setAttribute('role', 'group');
    paragraph.setAttribute('aria-label', `图片组，共 ${count} 张`);
    paragraph.setAttribute('contenteditable', 'false');
    paragraph.dataset.mdAtomicBlock = 'image';
    images.forEach((image) => {
      image.draggable = true;
      image.classList.add('app-image-row__item');
    });
  }

  function rebuildPreviewImageRow(row, images) {
    row.replaceChildren();
    images.forEach((image, index) => {
      if (index) row.appendChild(document.createTextNode(' '));
      row.appendChild(image);
    });
    row.classList.remove('is-image-drop-target', 'is-image-drop-blocked');
    row.querySelectorAll('.is-image-drop-before, .is-image-drop-after').forEach((image) => {
      image.classList.remove('is-image-drop-before', 'is-image-drop-after');
    });
    row.classList.remove('app-image-row');
    delete row.dataset.imageCount;
    row.style.removeProperty('--app-image-row-count');
    row.removeAttribute('role');
    row.removeAttribute('aria-label');
    row.removeAttribute('contenteditable');
    delete row.dataset.mdAtomicBlock;
    markPreviewImageRow(row);
  }

  function createPreviewCaretParagraph() {
    const paragraph = document.createElement('p');
    paragraph.className = 'app-preview-caret-paragraph';
    paragraph.dataset.mdPreviewCaret = 'true';
    paragraph.setAttribute('aria-label', '图片后的正文');
    paragraph.appendChild(document.createElement('br'));
    return paragraph;
  }

  function ensurePreviewCaretParagraphAfter(block) {
    if (!block || !els.previewEditor.contains(block)) return null;
    const next = block.nextElementSibling;
    if (next?.matches?.('p[data-md-preview-caret]')) return next;
    const paragraph = createPreviewCaretParagraph();
    block.after(paragraph);
    return paragraph;
  }

  function ensurePreviewTrailingAtomicCaret() {
    const last = els.previewEditor.lastElementChild;
    if (!last?.matches?.('.app-image-row, table, pre, hr')) return null;
    return ensurePreviewCaretParagraphAfter(last);
  }

  function promotePreviewCaretParagraphs() {
    els.previewEditor.querySelectorAll('p[data-md-preview-caret]').forEach((paragraph) => {
      if (!previewNodeHasContent(paragraph)) return;
      paragraph.classList.remove('app-preview-caret-paragraph');
      paragraph.removeAttribute('data-md-preview-caret');
      paragraph.removeAttribute('aria-label');
    });
  }

  function prunePreviewCaretParagraphs() {
    els.previewEditor.querySelectorAll('p[data-md-preview-caret]').forEach((paragraph) => {
      if (paragraph.previousElementSibling?.matches?.('.app-image-row, table, pre, hr')) return;
      paragraph.remove();
    });
  }

  function clearPreviewImageDropIndicators() {
    els.previewEditor.querySelectorAll('.is-image-drop-target, .is-image-drop-blocked').forEach((row) => {
      row.classList.remove('is-image-drop-target', 'is-image-drop-blocked');
    });
    els.previewEditor.querySelectorAll('.is-image-drop-before, .is-image-drop-after').forEach((image) => {
      image.classList.remove('is-image-drop-before', 'is-image-drop-after');
    });
  }

  function clearPreviewImageDragState() {
    clearPreviewImageDropIndicators();
    if (draggedPreviewImage) {
      draggedPreviewImage.classList.remove('is-image-dragging');
      draggedPreviewImage.setAttribute('aria-grabbed', 'false');
    }
    draggedPreviewImage = null;
    previewImageDragSourceRow = null;
  }

  function previewImageDropPosition(event, row) {
    const images = [...row.querySelectorAll(':scope > img')].filter((image) => image !== draggedPreviewImage);
    const hit = event.target.closest?.('.app-image-row > img');
    if (!hit || hit.parentElement !== row) return images.length;
    if (hit === draggedPreviewImage) {
      return Math.min([...row.querySelectorAll(':scope > img')].indexOf(hit), images.length);
    }
    const hitIndex = images.indexOf(hit);
    if (hitIndex < 0) return images.length;
    const rect = hit.getBoundingClientRect();
    return hitIndex + (event.clientX >= rect.left + rect.width / 2 ? 1 : 0);
  }

  function showPreviewImageDropIndicator(event, row, blocked) {
    clearPreviewImageDropIndicators();
    row.classList.add(blocked ? 'is-image-drop-blocked' : 'is-image-drop-target');
    if (blocked) return;
    const hit = event.target.closest?.('.app-image-row > img');
    if (!hit || hit.parentElement !== row || hit === draggedPreviewImage) return;
    const rect = hit.getBoundingClientRect();
    hit.classList.add(event.clientX >= rect.left + rect.width / 2
      ? 'is-image-drop-after'
      : 'is-image-drop-before');
  }

  function commitPreviewImageOrder() {
    if (!turndownService) return false;
    prunePreviewCaretParagraphs();
    const trailingNewlines = (getCurrentMarkdown().match(/\n*$/) || [''])[0];
    const markdown = turndownService.turndown(els.previewEditor.innerHTML)
      .replace(/\n*$/, trailingNewlines);
    previewEditing = true;
    try { setCurrentMarkdown(markdown, { skipRender: true, inputSource: 'preview' }); }
    finally { previewEditing = false; }
    lastEditSurface = 'preview';
    return true;
  }

  function bindPreviewImageReorder() {
    els.previewEditor.addEventListener('dragstart', (event) => {
      const image = event.target.closest?.('.app-image-row > img');
      if (!image || !els.previewEditor.contains(image)) return;
      draggedPreviewImage = image;
      previewImageDragSourceRow = image.parentElement;
      image.classList.add('is-image-dragging');
      image.setAttribute('aria-grabbed', 'true');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/x-guanyi-image', image.getAttribute('data-md-image-source') || image.alt || 'image');
      }
    });

    els.previewEditor.addEventListener('dragover', (event) => {
      if (!draggedPreviewImage) return;
      const row = event.target.closest?.('.app-image-row');
      if (!row || !els.previewEditor.contains(row)) return;
      event.preventDefault();
      event.stopPropagation();
      const blocked = row !== previewImageDragSourceRow
        && row.querySelectorAll(':scope > img').length >= 6;
      if (event.dataTransfer) event.dataTransfer.dropEffect = blocked ? 'none' : 'move';
      showPreviewImageDropIndicator(event, row, blocked);
    });

    els.previewEditor.addEventListener('drop', (event) => {
      if (!draggedPreviewImage) return;
      const targetRow = event.target.closest?.('.app-image-row');
      if (!targetRow || !els.previewEditor.contains(targetRow)) return;
      event.preventDefault();
      event.stopPropagation();
      const sourceRow = previewImageDragSourceRow;
      if (targetRow !== sourceRow && targetRow.querySelectorAll(':scope > img').length >= 6) {
        tip('每行最多 6 张图片');
        clearPreviewImageDragState();
        return;
      }

      const originalSourceImages = [...sourceRow.querySelectorAll(':scope > img')];
      const originalTargetImages = sourceRow === targetRow
        ? originalSourceImages
        : [...targetRow.querySelectorAll(':scope > img')];
      const targetImages = originalTargetImages.filter((image) => image !== draggedPreviewImage);
      const targetIndex = Math.max(0, Math.min(
        previewImageDropPosition(event, targetRow),
        targetImages.length
      ));
      targetImages.splice(targetIndex, 0, draggedPreviewImage);

      if (sourceRow === targetRow) {
        const unchanged = originalSourceImages.every((image, index) => image === targetImages[index]);
        if (!unchanged) rebuildPreviewImageRow(targetRow, targetImages);
        clearPreviewImageDragState();
        if (!unchanged && commitPreviewImageOrder()) tip('图片顺序已更新');
        return;
      }

      const remainingSourceImages = originalSourceImages.filter((image) => image !== draggedPreviewImage);
      if (remainingSourceImages.length) rebuildPreviewImageRow(sourceRow, remainingSourceImages);
      else sourceRow.remove();
      rebuildPreviewImageRow(targetRow, targetImages);
      clearPreviewImageDragState();
      if (commitPreviewImageOrder()) tip('图片已移入该行');
    });

    els.previewEditor.addEventListener('dragend', clearPreviewImageDragState);
  }

  function preparePreviewImageRows() {
    [...els.previewEditor.querySelectorAll('p')].forEach((paragraph) => {
      if (!isImageOnlyParagraph(paragraph)) return;
      const images = [...paragraph.querySelectorAll(':scope > img')];
      if (images.length <= 6) {
        markPreviewImageRow(paragraph);
        return;
      }
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < images.length; index += 6) {
        const row = document.createElement('p');
        images.slice(index, index + 6).forEach((image, imageIndex) => {
          if (imageIndex) row.appendChild(document.createTextNode(' '));
          row.appendChild(image);
        });
        markPreviewImageRow(row);
        fragment.appendChild(row);
      }
      paragraph.replaceWith(fragment);
    });
  }

  async function resolvePreviewImages(doc, token) {
    const images = [...els.previewEditor.querySelectorAll('img')];
    await Promise.all(images.map(async (image) => {
      const source = image.getAttribute('src') || '';
      image.setAttribute('data-md-image-source', source);
      if (!isRelativeImageSource(source)) return;
      image.removeAttribute('src');
      image.classList.add('is-loading-local');
      image.title = image.title || '正在读取本地图片';
      try {
        const file = await localImageFileForDoc(doc, source);
        const url = URL.createObjectURL(file);
        if (token !== previewImageRenderToken || state.currentDocId !== doc.id || !image.isConnected) {
          URL.revokeObjectURL(url);
          return;
        }
        previewImageObjectUrls.add(url);
        image.src = url;
        image.classList.remove('is-loading-local');
        image.removeAttribute('title');
        if (typeof image.decode === 'function') await image.decode().catch(() => {});
      } catch (error) {
        if (token !== previewImageRenderToken || !image.isConnected) return;
        image.classList.remove('is-loading-local');
        image.classList.add('is-unavailable-local');
        image.title = error?.message || '无法读取本地图片';
      }
    }));
  }

  function markdownForPreview(markdown) {
    let inFence = false;
    return String(markdown || '').split('\n').map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (!inFence && /^\s*[-*+]\s+\[[ xX]\]\s*$/.test(line)) {
        return line.replace(/\s*$/, '') + ' \u200B';
      }
      return line;
    }).join('\n');
  }

  function renderPreview() {
    clearTimeout(renderTimer);
    renderTimer = null;
    releasePreviewImageUrls();
    const imageToken = ++previewImageRenderToken;
    const started = pendingInputStarted;
    const md = getCurrentMarkdown();
    if (typeof marked !== 'undefined') els.previewEditor.innerHTML = marked.parse(markdownForPreview(md));
    preparePreviewImageRows();
    ensurePreviewTrailingAtomicCaret();
    const previewDoc = currentDoc();
    previewImagesReady = previewDoc ? resolvePreviewImages(previewDoc, imageToken) : Promise.resolve();
    prepareTaskCheckboxes();
    annotatePreviewLinks();
    updateOutline();
    refreshCollaborationUI();
    applySearchNavigationHighlight();
    requestAnimationFrame(updateReadingProgress);
    if (started !== null && typeof performance !== 'undefined') {
      const elapsed = performance.now() - started;
      window.__MD_EDITOR_LAST_RENDER_MS__ = elapsed;
      els.previewEditor.dataset.lastRenderMs = elapsed.toFixed(2);
      pendingInputStarted = null;
    }
  }

  function isSafeExternalUrl(href) {
    if (!href || href.charAt(0) === '#') return false;
    try {
      const url = new URL(href, window.location.href);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  function openPreviewLink(href) {
    if (!isSafeExternalUrl(href)) return false;
    window.open(href, '_blank', 'noopener,noreferrer');
    return true;
  }

  function hideLinkMenu() {
    if (!els.linkMenu) return;
    els.linkMenu.hidden = true;
    els.linkMenu.dataset.href = '';
  }

  function showLinkMenu(clientX, clientY, href) {
    if (!els.linkMenu) return;
    els.linkMenu.dataset.href = href;
    els.linkMenu.hidden = false;
    const pad = 8;
    const rect = els.linkMenu.getBoundingClientRect();
    const w = rect.width || 140;
    const h = rect.height || 36;
    let left = clientX;
    let top = clientY;
    if (left + w + pad > window.innerWidth) left = window.innerWidth - w - pad;
    if (top + h + pad > window.innerHeight) top = window.innerHeight - h - pad;
    els.linkMenu.style.left = Math.max(pad, left) + 'px';
    els.linkMenu.style.top = Math.max(pad, top) + 'px';
  }

  function syncSourceToDOM() {
    const md = getCurrentMarkdown();
    if (els.sourceEditor.value !== md) els.sourceEditor.value = md;
  }

  function render() { renderPreview(); updateStatus(); }

  // ── 大纲 ──
  function parseHeadings(markdown) {
    const headings = [];
    let offset = 0, inFence = false;
    markdown.split('\n').forEach((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; }
      else if (!inFence) {
        const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (m) headings.push({ level: m[1].length, text: m[2], line: index, offset });
      }
      offset += line.length + 1;
    });
    return headings;
  }

  function updateOutline() {
    if (!els.outlineList) return;
    const headings = parseHeadings(getCurrentMarkdown());
    els.outlineList.replaceChildren();
    if (!headings.length) {
      const empty = document.createElement('div');
      empty.className = 'app-outline__empty';
      empty.textContent = '暂无大纲';
      els.outlineList.appendChild(empty);
      return;
    }
    const phs = els.previewEditor.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach((h, i) => {
      const pid = `outline-heading-${i}`;
      if (phs[i]) phs[i].id = pid;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'app-outline__item';
      btn.dataset.level = h.level;
      btn.textContent = h.text;
      btn.title = h.text;
      btn.addEventListener('click', () => {
        const view = state.viewMode;
        if (view !== 'preview') {
          els.sourceEditor.focus();
          setProgrammaticSourceSelection(h.offset, h.offset + h.text.length + h.level + 1);
          const lh = parseFloat(getComputedStyle(els.sourceEditor).lineHeight) || 22;
          els.sourceEditor.scrollTop = Math.max(0, h.line * lh - els.sourceEditor.clientHeight / 3);
        }
        const ph = document.getElementById(pid);
        if (ph && view !== 'source') ph.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
      els.outlineList.appendChild(btn);
    });
  }

  function updateStatus() {
    const doc = currentDoc();
    const md = getCurrentMarkdown();
    const lines = md ? md.split('\n').length : 0;
    const chars = md.length;
    const viewMap = { source: '源码', preview: '预览', split: '分栏' };
    const dirtyLabel = isDocDirty(doc) ? ' · 未保存到文件' : '';
    const directory = directoryForDoc(doc);
    const sourceLabel = directory ? ` · ${directory.name}` : '';
    const syncLabels = { conflict: ' · 磁盘版本冲突', missing: ' · 原文件缺失', 'permission-required': ' · 需要目录授权', updated: ' · 磁盘版本已更新' };
    const syncLabel = doc ? (syncLabels[doc.syncState] || '') : '';
    els.statusText.textContent = `${doc?.name || '未命名文档'}${sourceLabel} · ${lines} 行 · ${chars} 字符 · 视图：${viewMap[state.viewMode] || '分栏'}${dirtyLabel}${syncLabel}`;
    updateEditChrome();
    updateConflictBar();
  }

  // ── Format engine (pure core) ──
  function applyTextEdits(text, start, end, edits) {
    const ordered = edits
      .filter((edit) => edit.remove > 0 || edit.insert)
      .sort((a, b) => a.position - b.position);
    let nextText = text;
    [...ordered].reverse().forEach((edit) => {
      nextText = nextText.slice(0, edit.position) + edit.insert + nextText.slice(edit.position + edit.remove);
    });

    const mapPosition = (position, affinity) => {
      let delta = 0;
      for (const edit of ordered) {
        if (position < edit.position) break;
        if (position === edit.position) {
          return edit.position + delta + (affinity === 'after' ? edit.insert.length : 0);
        }
        if (position < edit.position + edit.remove) {
          return edit.position + delta + (affinity === 'after' ? edit.insert.length : 0);
        }
        delta += edit.insert.length - edit.remove;
      }
      return position + delta;
    };

    const selStart = mapPosition(start, 'after');
    return {
      text: nextText,
      selStart,
      selEnd: start === end ? selStart : mapPosition(end, 'before')
    };
  }

  function togglePrefix(text, start, end, re, prefix) {
    const { lineStart, lineEnd } = selectedLineBounds(text, start, end);
    const lines = text.slice(lineStart, lineEnd).split('\n');
    const allOn = lines.length > 0 && lines.every((line) => re.test(line));
    let cursor = lineStart;
    const edits = lines.map((line) => {
      const match = line.match(re);
      const edit = {
        position: cursor,
        remove: match ? match[0].length : 0,
        insert: allOn ? '' : prefix
      };
      cursor += line.length + 1;
      return edit;
    });
    return applyTextEdits(text, start, end, edits);
  }

  function listMarkerOf(line) {
    const indent = (line.match(/^[ \t]*/) || [''])[0];
    const rest = line.slice(indent.length);
    const task = rest.match(/^[-*+]\s+\[([ xX])\](?:\s+|$)/);
    if (task) return { indent, marker: task[0], type: 'task', checked: task[1].toLowerCase() === 'x' };
    const ordered = rest.match(/^\d+\.\s+/);
    if (ordered) return { indent, marker: ordered[0], type: 'ol', checked: false };
    const unordered = rest.match(/^[-*+]\s+/);
    if (unordered) return { indent, marker: unordered[0], type: 'ul', checked: false };
    return { indent, marker: '', type: null, checked: false };
  }

  function toggleList(text, start, end, type) {
    const { lineStart, lineEnd } = selectedLineBounds(text, start, end);
    const lines = text.slice(lineStart, lineEnd).split('\n');
    const markers = lines.map(listMarkerOf);
    const nonBlankIndexes = lines
      .map((line, index) => line.trim() ? index : -1)
      .filter((index) => index !== -1);
    const singleEmptyCaret = start === end && lines.length === 1 && nonBlankIndexes.length === 0;
    const actionableIndexes = singleEmptyCaret ? [0] : nonBlankIndexes;
    if (!actionableIndexes.length) return { text, selStart: start, selEnd: end };
    const allOn = actionableIndexes.every((index) => markers[index].type === type);
    const removeBlankSeparators = !allOn && nonBlankIndexes.length > 0 && lines.length > 1;
    let cursor = lineStart;
    let orderedIndex = 0;
    const edits = [];
    lines.forEach((line, index) => {
      const current = markers[index];
      const blank = !line.trim();
      if (blank && removeBlankSeparators) {
        if (index < lines.length - 1) edits.push({ position: cursor, remove: line.length + 1, insert: '' });
        else if (index > 0) edits.push({ position: cursor - 1, remove: line.length + 1, insert: '' });
        cursor += line.length + 1;
        return;
      }
      if (blank && !singleEmptyCaret) {
        cursor += line.length + 1;
        return;
      }
      let insert = '';
      if (!allOn) {
        if (type === 'ol') insert = `${++orderedIndex}. `;
        else if (type === 'task') insert = current.type === 'task' && current.checked ? '- [x] ' : '- [ ] ';
        else insert = '- ';
      }
      edits.push({
        position: cursor + current.indent.length,
        remove: current.marker.length,
        insert
      });
      cursor += line.length + 1;
    });
    return applyTextEdits(text, start, end, edits);
  }

  function applyHeadingPure(text, start, end, level) {
    const { lineStart, lineEnd } = selectedLineBounds(text, start, end);
    const lines = text.slice(lineStart, lineEnd).split('\n');
    let cursor = lineStart;
    const edits = lines.map((line) => {
      const match = line.match(/^#{1,6}\s/);
      const edit = {
        position: cursor,
        remove: match ? match[0].length : 0,
        insert: level === 0 ? '' : '#'.repeat(level) + ' '
      };
      cursor += line.length + 1;
      return edit;
    });
    return applyTextEdits(text, start, end, edits);
  }

  function markerRunLength(text, position, marker, direction) {
    let length = 0;
    let cursor = direction < 0 ? position - 1 : position;
    while (cursor >= 0 && cursor < text.length && text[cursor] === marker) {
      length += 1;
      cursor += direction;
    }
    return length;
  }

  function toggleWrappedSelection(text, start, end, prefix, suffix, placeholder, active) {
    const selected = text.slice(start, end);
    const hasWrapper = typeof active === 'function'
      ? active(text, start, end)
      : text.slice(start - prefix.length, start) === prefix
        && text.slice(end, end + suffix.length) === suffix;
    if (hasWrapper) {
      return {
        text: text.slice(0, start - prefix.length) + selected + text.slice(end + suffix.length),
        selStart: start - prefix.length,
        selEnd: end - prefix.length
      };
    }
    const content = selected || placeholder;
    return {
      text: text.slice(0, start) + prefix + content + suffix + text.slice(end),
      selStart: start + prefix.length,
      selEnd: start + prefix.length + content.length
    };
  }

  function computeFormat(text, start, end, action, level) {
    const sel = text.slice(start, end);
    switch (action) {
      case 'bold': return toggleWrappedSelection(text, start, end, '**', '**', '加粗');
      case 'italic': return toggleWrappedSelection(text, start, end, '*', '*', '斜体', (value, from, to) => (
        markerRunLength(value, from, '*', -1) % 2 === 1
        && markerRunLength(value, to, '*', 1) % 2 === 1
      ));
      case 'strike': return toggleWrappedSelection(text, start, end, '~~', '~~', '删除线');
      case 'inlinecode': return toggleWrappedSelection(text, start, end, '`', '`', 'code');
      case 'link': { const l = sel || '链接文本'; const b = `[${l}](https://)`; const n = text.slice(0, start) + b + text.slice(end); const u = start + l.length + 3; return { text: n, selStart: u, selEnd: u + 8 }; }
      case 'codeblock': return toggleWrappedSelection(text, start, end, '```\n', '\n```', '代码');
      case 'hr': { const pre = text.slice(0, start); const needBr = pre && !pre.endsWith('\n\n'); const ins = (needBr ? '\n\n' : '') + '---\n\n'; const n = text.slice(0, start) + ins + text.slice(start); const p = start + ins.length; return { text: n, selStart: p, selEnd: p }; }
      case 'ul': return toggleList(text, start, end, 'ul');
      case 'task': return toggleList(text, start, end, 'task');
      case 'ol': return toggleList(text, start, end, 'ol');
      case 'quote': return togglePrefix(text, start, end, /^>\s/, '> ');
      case 'heading': return applyHeadingPure(text, start, end, parseInt(level, 10));
      default: return null;
    }
  }

  function insertTablePure(text, start, end, rows, cols) {
    const safeRows = Math.max(2, Math.min(TABLE_MAX_ROWS, Number(rows) || 2));
    const safeCols = Math.max(1, Math.min(TABLE_MAX_COLS, Number(cols) || 1));
    const header = `| ${Array.from({ length: safeCols }, (_, index) => `列 ${index + 1}`).join(' | ')} |`;
    const divider = `| ${Array.from({ length: safeCols }, () => '---').join(' | ')} |`;
    const dataRow = `| ${Array.from({ length: safeCols }, () => '').join(' | ')} |`;
    const block = [header, divider, ...Array.from({ length: safeRows - 1 }, () => dataRow)].join('\n');
    const before = text.slice(0, start);
    const after = text.slice(end);
    const prefix = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const suffix = !after ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    const insertion = prefix + block + suffix;
    const headerStart = start + prefix.length + 2;
    return {
      text: before + insertion + after,
      selStart: headerStart,
      selEnd: headerStart + '列 1'.length
    };
  }

  function continueListPure(text, start, end) {
    if (start > end || text.slice(start, end).includes('\n')) return null;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEndAt = text.indexOf('\n', end);
    const lineEnd = lineEndAt === -1 ? text.length : lineEndAt;
    const beforeCursor = text.slice(lineStart, start);
    const afterCursor = text.slice(end, lineEnd);
    const match = beforeCursor.match(/^([ \t]*)(?:([-*+]\s+\[[ xX]\](?:\s+|$))|([-*+]\s+)|(\d+)([.)])\s+|(>\s?))/);
    if (!match) return null;

    const indent = match[1];
    const marker = match[0].slice(indent.length);
    const itemText = beforeCursor.slice(match[0].length);
    if (!itemText.trim() && !afterCursor.trim()) {
      return {
        text: text.slice(0, lineStart) + text.slice(lineEnd),
        selStart: lineStart,
        selEnd: lineStart
      };
    }

    let nextMarker = marker;
    if (match[4]) nextMarker = `${Number(match[4]) + 1}${match[5]} `;
    else if (match[2]) nextMarker = `${marker[0]} [ ] `;
    const insertion = `\n${indent}${nextMarker}`;
    return {
      text: text.slice(0, start) + insertion + text.slice(end),
      selStart: start + insertion.length,
      selEnd: start + insertion.length
    };
  }

  function selectedLineBounds(text, start, end) {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    let effectiveEnd = end;
    if (end > start && text[end - 1] === '\n') effectiveEnd = end - 1;
    let lineEnd = text.indexOf('\n', effectiveEnd);
    if (lineEnd === -1) lineEnd = text.length;
    return { lineStart, lineEnd };
  }

  function indentLinesPure(text, start, end, outdent) {
    const { lineStart, lineEnd } = selectedLineBounds(text, start, end);
    const lines = text.slice(lineStart, lineEnd).split('\n');
    let cursor = lineStart;
    const edits = lines.map((line) => {
      const remove = outdent ? (line.startsWith('\t') ? 1 : Math.min(2, (line.match(/^ */) || [''])[0].length)) : 0;
      const edit = { position: cursor, remove, insert: outdent ? '' : INDENT };
      cursor += line.length + 1;
      return edit;
    });
    if (outdent && edits.every((edit) => edit.remove === 0)) {
      return { text, selStart: start, selEnd: end };
    }

    let nextText = text;
    [...edits].reverse().forEach((edit) => {
      nextText = nextText.slice(0, edit.position) + edit.insert + nextText.slice(edit.position + edit.remove);
    });
    const mapPosition = (position) => {
      let mapped = position;
      edits.forEach((edit) => {
        if (position <= edit.position) return;
        if (position < edit.position + edit.remove) mapped -= position - edit.position;
        else mapped += edit.insert.length - edit.remove;
      });
      return mapped;
    };
    return { text: nextText, selStart: mapPosition(start), selEnd: mapPosition(end) };
  }

  function applySourceTransform(result) {
    if (!result) return false;
    setCurrentMarkdown(result.text);
    els.sourceEditor.focus();
    setProgrammaticSourceSelection(result.selStart, result.selEnd);
    renderPreview();
    return true;
  }

  function format(action, level) {
    const ta = els.sourceEditor;
    const r = computeFormat(ta.value, ta.selectionStart, ta.selectionEnd, action, level);
    if (!r) return;
    applySourceTransform(r);
    if (action === 'heading') updateHeadingLabel(level);
  }

  function nodePathFrom(root, node) {
    const path = [];
    let current = node;
    while (current && current !== root) {
      const parent = current.parentNode;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    return current === root ? path : null;
  }

  function nodeAtPath(root, path) {
    return path.reduce((node, index) => node?.childNodes[index] || null, root);
  }

  const PREVIEW_CARET_BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, pre, div';

  function previewLineBlocks() {
    return [...els.previewEditor.querySelectorAll(PREVIEW_CARET_BLOCK_SELECTOR)].filter((block) => {
      if (block.tagName !== 'DIV') return true;
      return !block.querySelector(PREVIEW_CARET_BLOCK_SELECTOR);
    });
  }

  function isEffectivelyEmptyPreviewBlock(block) {
    if (!block || block === els.previewEditor || block.matches('pre')) return false;
    if (String(block.textContent || '').replace(/[\s\u200B\uFEFF]/g, '')) return false;
    return !block.querySelector('img, table, hr, video, audio, iframe, canvas');
  }

  function previewEmptyCaretBlock(range) {
    if (!range?.collapsed) return null;
    const blockForNode = (node) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      const block = element?.closest?.(PREVIEW_CARET_BLOCK_SELECTOR) || null;
      return block && block !== els.previewEditor && els.previewEditor.contains(block) ? block : null;
    };

    if (range.startContainer === els.previewEditor) {
      const after = blockForNode(els.previewEditor.childNodes[range.startOffset]);
      if (isEffectivelyEmptyPreviewBlock(after)) return after;
      const before = blockForNode(els.previewEditor.childNodes[range.startOffset - 1]);
      return isEffectivelyEmptyPreviewBlock(before) ? before : null;
    }

    const block = blockForNode(range.startContainer);
    return isEffectivelyEmptyPreviewBlock(block) ? block : null;
  }

  function previewSelectionBookmark(range) {
    if (!range) return null;
    const emptyBlock = previewEmptyCaretBlock(range);
    const emptyBlockIndex = emptyBlock ? previewLineBlocks().indexOf(emptyBlock) : -1;
    const textBefore = (node, offset) => {
      const before = document.createRange();
      before.selectNodeContents(els.previewEditor);
      before.setEnd(node, offset);
      return before.toString();
    };
    const full = document.createRange();
    full.selectNodeContents(els.previewEditor);
    const fullText = full.toString();
    const startText = textBefore(range.startContainer, range.startOffset);
    const endText = textBefore(range.endContainer, range.endOffset);
    const significantLength = (value) => value.replace(/\s/g, '').length;
    return {
      rawStart: startText.length,
      rawEnd: endText.length,
      rawTotal: fullText.length,
      significantStart: significantLength(startText),
      significantEnd: significantLength(endText),
      significantTotal: significantLength(fullText),
      collapsed: range.collapsed,
      emptyBlockIndex
    };
  }

  function previewTextPoint(rawOffset, significantOffset, useSignificant) {
    const walker = document.createTreeWalker(els.previewEditor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    if (!node) return { node: els.previewEditor, offset: 0 };

    if (!useSignificant) {
      let remaining = Math.max(0, rawOffset);
      let last = node;
      do {
        last = node;
        if (remaining <= node.data.length) return { node, offset: remaining };
        remaining -= node.data.length;
        node = walker.nextNode();
      } while (node);
      return { node: last, offset: last.data.length };
    }

    const target = Math.max(0, significantOffset);
    if (target === 0) return { node, offset: 0 };
    let count = 0;
    let last = node;
    do {
      last = node;
      for (let index = 0; index < node.data.length; index += 1) {
        if (/\s/.test(node.data[index])) continue;
        count += 1;
        if (count === target) return { node, offset: index + 1 };
      }
      node = walker.nextNode();
    } while (node);
    return { node: last, offset: last.data.length };
  }

  function restorePreviewSelection(bookmark, preferSignificant) {
    if (!bookmark) return false;
    if (bookmark.emptyBlockIndex >= 0) {
      const block = previewLineBlocks()[bookmark.emptyBlockIndex];
      if (block) {
        const checkboxIndex = [...block.childNodes].findIndex((node) => node.nodeType === Node.ELEMENT_NODE
          && node.matches?.('input[type="checkbox"]'));
        const range = document.createRange();
        range.setStart(block, checkboxIndex >= 0 ? checkboxIndex + 1 : 0);
        range.collapse(true);
        try { els.previewEditor.focus({ preventScroll: true }); }
        catch (_error) { els.previewEditor.focus(); }
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        lastEditSurface = 'preview';
        lastPreviewRange = range.cloneRange();
        return true;
      }
    }
    const full = document.createRange();
    full.selectNodeContents(els.previewEditor);
    const renderedText = full.toString();
    const significantTotal = renderedText.replace(/\s/g, '').length;
    const useSignificant = preferSignificant
      || renderedText.length !== bookmark.rawTotal
      || significantTotal !== bookmark.significantTotal;
    const start = previewTextPoint(bookmark.rawStart, bookmark.significantStart, useSignificant);
    const end = bookmark.collapsed
      ? start
      : previewTextPoint(bookmark.rawEnd, bookmark.significantEnd, useSignificant);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    try { els.previewEditor.focus({ preventScroll: true }); }
    catch (_error) { els.previewEditor.focus(); }
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    lastEditSurface = 'preview';
    lastPreviewRange = range.cloneRange();
    return true;
  }

  function currentPreviewRange() {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (els.previewEditor.contains(range.startContainer) && els.previewEditor.contains(range.endContainer)) {
        lastPreviewRange = range.cloneRange();
        return range;
      }
    }
    if (lastPreviewRange
      && lastPreviewRange.startContainer.isConnected
      && lastPreviewRange.endContainer.isConnected
      && els.previewEditor.contains(lastPreviewRange.startContainer)
      && els.previewEditor.contains(lastPreviewRange.endContainer)) {
      return lastPreviewRange;
    }
    return null;
  }

  function previewTextBoundary(container, offset, direction) {
    if (container.nodeType === Node.TEXT_NODE) return { node: container, offset };
    const boundary = document.createRange();
    boundary.setStart(container, offset);
    boundary.collapse(true);
    const walker = document.createTreeWalker(els.previewEditor, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node = walker.nextNode();
    while (node) {
      if (node.data.trim() || node.parentNode !== els.previewEditor) nodes.push(node);
      node = walker.nextNode();
    }
    if (direction === 'forward') {
      for (const candidate of nodes) {
        const candidateRange = document.createRange();
        candidateRange.selectNodeContents(candidate);
        if (boundary.compareBoundaryPoints(Range.START_TO_END, candidateRange) < 0) {
          return { node: candidate, offset: 0 };
        }
      }
    } else {
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const candidate = nodes[index];
        const candidateRange = document.createRange();
        candidateRange.selectNodeContents(candidate);
        if (boundary.compareBoundaryPoints(Range.END_TO_START, candidateRange) > 0) {
          return { node: candidate, offset: candidate.data.length };
        }
      }
    }
    return { node: container, offset };
  }

  function normalizedPreviewRange(range) {
    if (!range) return null;
    const emptyBlock = previewEmptyCaretBlock(range);
    if (emptyBlock) {
      const emptyRange = document.createRange();
      emptyRange.setStart(emptyBlock, 0);
      emptyRange.collapse(true);
      return emptyRange;
    }
    let start = previewTextBoundary(range.startContainer, range.startOffset, 'forward');
    if (range.collapsed && start.node.nodeType !== Node.TEXT_NODE) {
      start = previewTextBoundary(range.startContainer, range.startOffset, 'backward');
    }
    const end = range.collapsed
      ? start
      : previewTextBoundary(range.endContainer, range.endOffset, 'backward');
    const normalized = document.createRange();
    normalized.setStart(start.node, start.offset);
    normalized.setEnd(end.node, end.offset);
    return normalized;
  }

  function previewMarkdownSelection(range) {
    if (!range || !turndownService) return null;
    const normalized = normalizedPreviewRange(range);
    const startPath = nodePathFrom(els.previewEditor, normalized.startContainer);
    const endPath = nodePathFrom(els.previewEditor, normalized.endContainer);
    if (!startPath || !endPath) return null;

    const clone = els.previewEditor.cloneNode(true);
    const startNode = nodeAtPath(clone, startPath);
    const endNode = nodeAtPath(clone, endPath);
    if (!startNode || !endNode) return null;

    const nonce = `${Date.now()}${Math.random().toString(36).slice(2)}`.toUpperCase();
    const startMarker = `MDSELECTIONSTART${nonce}`;
    const endMarker = `MDSELECTIONEND${nonce}`;
    if (normalized.collapsed) {
      const caret = document.createRange();
      caret.setStart(startNode, normalized.startOffset);
      caret.collapse(true);
      caret.insertNode(document.createTextNode(startMarker));
    } else {
      const end = document.createRange();
      end.setStart(endNode, normalized.endOffset);
      end.collapse(true);
      end.insertNode(document.createTextNode(endMarker));
      const start = document.createRange();
      start.setStart(startNode, normalized.startOffset);
      start.collapse(true);
      start.insertNode(document.createTextNode(startMarker));
    }

    const sourceTrailingNewlines = (getCurrentMarkdown().match(/\n*$/) || [''])[0];
    const markedDown = turndownService.turndown(clone.innerHTML).replace(/\n*$/, sourceTrailingNewlines);
    const start = markedDown.indexOf(startMarker);
    if (start === -1) return null;
    if (normalized.collapsed) {
      return { markdown: markedDown.replace(startMarker, ''), start, end: start };
    }
    const markedEnd = markedDown.indexOf(endMarker);
    if (markedEnd === -1 || markedEnd < start) return null;
    return {
      markdown: markedDown.replace(startMarker, '').replace(endMarker, ''),
      start,
      end: markedEnd - startMarker.length
    };
  }

  function markdownLineInfos(markdown) {
    let offset = 0;
    return String(markdown).split('\n').map((raw, index, lines) => {
      const info = { raw, start: offset, end: offset + raw.length, projection: markdownLineProjection(raw) };
      offset += raw.length + (index < lines.length - 1 ? 1 : 0);
      return info;
    });
  }

  function markdownLineProjection(line) {
    let contentStart = 0;
    while (contentStart < line.length) {
      const prefix = line.slice(contentStart).match(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+]\s+\[[ xX]\](?:\s+|$)|[-*+]\s+|\d+[.)]\s+)/);
      if (!prefix) break;
      contentStart += prefix[0].length;
    }

    const text = [];
    const rawIndexes = [];
    for (let index = contentStart; index < line.length;) {
      const char = line[index];
      if (char === '\\' && index + 1 < line.length) {
        text.push(line[index + 1]);
        rawIndexes.push(index + 1);
        index += 2;
        continue;
      }
      if (char === '!' && line[index + 1] === '[') { index += 1; continue; }
      if (char === '[') { index += 1; continue; }
      if (char === ']' && line[index + 1] === '(') {
        const close = line.indexOf(')', index + 2);
        index = close === -1 ? index + 1 : close + 1;
        continue;
      }
      if (char === ']' || char === '*' || char === '_' || char === '~' || char === '`') {
        index += 1;
        continue;
      }
      if (char === '<') {
        const close = line.indexOf('>', index + 1);
        if (close !== -1) { index = close + 1; continue; }
      }
      text.push(char);
      rawIndexes.push(index);
      index += 1;
    }
    return {
      text: text.join(''),
      key: text.join('').replace(/\s+/g, ' ').trim(),
      rawIndexes,
      contentStart
    };
  }

  function markdownLineIndexAt(markdown, position, isEnd) {
    let safePosition = Math.max(0, Math.min(String(markdown).length, position));
    if (isEnd && safePosition > 0 && markdown[safePosition - 1] === '\n') safePosition -= 1;
    return String(markdown).slice(0, safePosition).split('\n').length - 1;
  }

  function alignMarkdownLines(normalizedLines, canonicalLines) {
    const mapping = new Map();
    let canonicalCursor = 0;
    normalizedLines.forEach((line, index) => {
      if (!line.projection.key) return;
      let match = -1;
      for (let candidate = canonicalCursor; candidate < canonicalLines.length; candidate += 1) {
        if (canonicalLines[candidate].projection.key === line.projection.key) { match = candidate; break; }
      }
      if (match === -1) return;
      mapping.set(index, match);
      canonicalCursor = match + 1;
    });
    return mapping;
  }

  function mappedMarkdownLine(index, mapping, normalizedLines, canonicalLines) {
    if (mapping.has(index)) return mapping.get(index);
    if (normalizedLines.length === canonicalLines.length) return Math.min(index, canonicalLines.length - 1);
    let before = index - 1;
    while (before >= 0 && !mapping.has(before)) before -= 1;
    let after = index + 1;
    while (after < normalizedLines.length && !mapping.has(after)) after += 1;
    if (before >= 0 && after < normalizedLines.length) {
      const lower = mapping.get(before);
      const upper = mapping.get(after);
      return Math.max(lower, Math.min(upper, lower + index - before));
    }
    if (before >= 0) return Math.min(canonicalLines.length - 1, mapping.get(before) + index - before);
    if (after < normalizedLines.length) return Math.max(0, mapping.get(after) - (after - index));
    return Math.min(index, canonicalLines.length - 1);
  }

  function markdownVisibleOffset(projection, rawColumn) {
    let visible = 0;
    while (visible < projection.rawIndexes.length && projection.rawIndexes[visible] < rawColumn) visible += 1;
    return visible;
  }

  function markdownRawColumn(projection, visibleOffset) {
    if (!projection.rawIndexes.length) return projection.contentStart;
    if (visibleOffset <= 0) return projection.rawIndexes[0];
    if (visibleOffset >= projection.rawIndexes.length) return projection.rawIndexes[projection.rawIndexes.length - 1] + 1;
    return projection.rawIndexes[visibleOffset];
  }

  function canonicalPreviewSelection(mapped, action) {
    const canonical = getCurrentMarkdown();
    if (mapped.markdown === canonical) return { markdown: canonical, start: mapped.start, end: mapped.end };
    if (mapped.start === 0 && mapped.end === mapped.markdown.length) {
      return { markdown: canonical, start: 0, end: canonical.length };
    }

    const normalizedLines = markdownLineInfos(mapped.markdown);
    const canonicalLines = markdownLineInfos(canonical);
    if (!normalizedLines.length || !canonicalLines.length) return null;
    const mapping = alignMarkdownLines(normalizedLines, canonicalLines);
    const startLineIndex = markdownLineIndexAt(mapped.markdown, mapped.start, false);
    const endLineIndex = markdownLineIndexAt(mapped.markdown, mapped.end, mapped.end > mapped.start);
    const canonicalStartIndex = mappedMarkdownLine(startLineIndex, mapping, normalizedLines, canonicalLines);
    const canonicalEndIndex = mappedMarkdownLine(endLineIndex, mapping, normalizedLines, canonicalLines);
    const startLine = normalizedLines[startLineIndex];
    const endLine = normalizedLines[endLineIndex];
    const canonicalStartLine = canonicalLines[canonicalStartIndex];
    const canonicalEndLine = canonicalLines[canonicalEndIndex];
    if (!startLine || !endLine || !canonicalStartLine || !canonicalEndLine) return null;

    if (['ul', 'ol', 'task', 'quote', 'heading'].includes(action)) {
      if (mapped.start === mapped.end) {
        return { markdown: canonical, start: canonicalStartLine.start, end: canonicalStartLine.start };
      }
      return {
        markdown: canonical,
        start: canonicalStartLine.start,
        end: canonicalEndLine.end
      };
    }

    const startVisible = markdownVisibleOffset(startLine.projection, mapped.start - startLine.start);
    const endVisible = markdownVisibleOffset(endLine.projection, mapped.end - endLine.start);
    return {
      markdown: canonical,
      start: canonicalStartLine.start + markdownRawColumn(canonicalStartLine.projection, startVisible),
      end: canonicalEndLine.start + markdownRawColumn(canonicalEndLine.projection, endVisible)
    };
  }

  function applyFormatToPreview(action, level) {
    const activeRange = currentPreviewRange();
    const bookmark = previewSelectionBookmark(activeRange);
    flushPendingPreviewCommit();
    const mapped = previewMarkdownSelection(activeRange);
    if (!mapped) return false;
    const canonicalSelection = canonicalPreviewSelection(mapped, action);
    if (!canonicalSelection) return false;
    const trailingNewlines = (getCurrentMarkdown().match(/\n*$/) || [''])[0];
    const result = computeFormat(
      canonicalSelection.markdown,
      canonicalSelection.start,
      canonicalSelection.end,
      action,
      level
    );
    if (!result) return false;
    if (action !== 'hr') result.text = result.text.replace(/\n*$/, trailingNewlines);
    const scrollTop = els.previewWrap.scrollTop;
    const scrollLeft = els.previewWrap.scrollLeft;
    setCurrentMarkdown(result.text);
    renderPreview();
    requestAnimationFrame(() => {
      restorePreviewSelection(bookmark, ['ul', 'ol', 'task', 'quote', 'heading'].includes(action));
      const maxTop = Math.max(0, els.previewWrap.scrollHeight - els.previewWrap.clientHeight);
      const maxLeft = Math.max(0, els.previewWrap.scrollWidth - els.previewWrap.clientWidth);
      els.previewWrap.scrollTop = Math.min(scrollTop, maxTop);
      els.previewWrap.scrollLeft = Math.min(scrollLeft, maxLeft);
    });
    if (action === 'heading') updateHeadingLabel(level);
    return true;
  }

  function formatFromActiveEditor(action, level) {
    const usePreview = state.viewMode === 'preview'
      || (state.viewMode === 'split' && lastEditSurface === 'preview');
    if (usePreview) {
      applyFormatToPreview(action, level);
      return;
    }
    format(action, level);
  }

  function insertTable(rows, cols) {
    const markdown = getCurrentMarkdown();
    const inPreview = state.viewMode === 'preview';
    const start = inPreview ? markdown.length : els.sourceEditor.selectionStart;
    const end = inPreview ? markdown.length : els.sourceEditor.selectionEnd;
    const result = insertTablePure(markdown, start, end, rows, cols);
    setCurrentMarkdown(result.text);
    setProgrammaticSourceSelection(result.selStart, result.selEnd);
    renderPreview();
    if (inPreview) els.tableBtn.focus();
    else els.sourceEditor.focus();
    tip(`已插入 ${Math.max(2, rows)} × ${cols} 表格`);
  }

  function updateHeadingLabel(level) {
    const label = els.headingBtn.querySelector('.fmt-btn__label');
    if (!label) return;
    const lv = parseInt(level, 10);
    label.textContent = isNaN(lv) || lv === 0 ? '正文' : 'H' + lv;
  }

  function taskMarkers(markdown) {
    const markers = [];
    const re = /^(\s*[-*+]\s+\[)([ xX])(\](?:\s+|$))/gm;
    let match;
    while ((match = re.exec(markdown)) !== null) {
      markers.push({ index: match.index + match[1].length, checked: match[2].toLowerCase() === 'x' });
    }
    return markers;
  }

  function ensureTaskContent(item, checkbox) {
    const existing = Array.from(item.children || []).find((child) => child.classList?.contains('app-task-content'));
    if (existing) return existing;
    const content = document.createElement('span');
    content.className = 'app-task-content';
    let node = checkbox.nextSibling;
    while (node && !(node.nodeType === Node.ELEMENT_NODE && /^(UL|OL)$/.test(node.tagName))) {
      const next = node.nextSibling;
      content.appendChild(node);
      node = next;
    }
    item.insertBefore(content, node);
    return content;
  }

  function prepareTaskCheckboxes() {
    const markers = taskMarkers(getCurrentMarkdown());
    const checkboxes = els.previewEditor.querySelectorAll('li input[type="checkbox"]');
    checkboxes.forEach((checkbox, index) => {
      if (!markers[index]) return;
      const item = checkbox.closest('li');
      if (item) {
        item.classList.add('task-list-item');
        ensureTaskContent(item, checkbox);
        if (!String(item.textContent || '').replace(/[\s\u200B\uFEFF]/g, '')
          && /[\u200B\uFEFF]/.test(item.textContent || '')) item.dataset.mdEmptyTask = 'true';
        else delete item.dataset.mdEmptyTask;
        const list = item.parentElement;
        if (list && list.tagName === 'UL') list.classList.add('contains-task-list');
      }
      checkbox.disabled = false;
      checkbox.dataset.mdTaskIndex = String(index);
      checkbox.setAttribute('aria-label', `任务 ${index + 1}`);
    });
  }

  function toggleTaskByIndex(index, checked) {
    const doc = currentDoc();
    if (!doc) return false;
    const markers = taskMarkers(doc.content);
    const marker = markers[index];
    if (!marker) return false;
    const value = checked ? 'x' : ' ';
    if (doc.content[marker.index].toLowerCase() === value) return true;
    const next = doc.content.slice(0, marker.index) + value + doc.content.slice(marker.index + 1);
    setCurrentMarkdown(next);
    renderPreview();
    return true;
  }

  function safeFileName(name) {
    const cleaned = String(name || 'Markdown 文档')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
      .replace(/[.\s]+$/g, '')
      .trim();
    return cleaned || 'Markdown 文档';
  }

  function markdownImageAlt(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/]/g, '\\]').trim();
  }

  function markdownImageSyntax(alt, source, title) {
    const safeSource = String(source || '').replace(/\(/g, '%28').replace(/\)/g, '%29');
    const safeTitle = String(title || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `![${markdownImageAlt(alt)}](${safeSource}${safeTitle ? ` "${safeTitle}"` : ''})`;
  }

  function normalizedHttpImageUrl(rawValue) {
    try {
      const url = new URL(String(rawValue || '').trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return url.href;
    } catch (_error) { return ''; }
  }

  function imageExtensionForFile(file) {
    const named = String(file?.name || '').match(/\.(png|jpe?g|gif|webp|avif)$/i);
    if (named) return named[0].toLowerCase().replace('.jpeg', '.jpg');
    return IMAGE_MIME_EXTENSIONS[String(file?.type || '').toLowerCase()] || '';
  }

  function isSupportedImageFile(file) {
    if (!file || typeof file.size !== 'number') return false;
    const mime = String(file.type || '').toLowerCase();
    return !!IMAGE_MIME_EXTENSIONS[mime] || (!mime && !!imageExtensionForFile(file));
  }

  function imageBaseName(file) {
    const raw = String(file?.name || '图片').replace(/\.(png|jpe?g|gif|webp|avif)$/i, '');
    return safeFileName(raw || '图片');
  }

  function encodedMarkdownPath(parts) {
    return parts.map((part) => encodeURIComponent(part).replace(/%2F/gi, '')).join('/');
  }

  function dataUrlCharactersInDocuments() {
    return state.docs.reduce((total, doc) => {
      const matches = String(doc.content || '').match(/data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+/g);
      return total + (matches ? matches.reduce((sum, value) => sum + value.length, 0) : 0);
    }, 0);
  }

  function fileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
      const mime = String(file.type || '').toLowerCase();
      const inferred = mime || Object.entries(IMAGE_MIME_EXTENSIONS).find(([, extension]) => extension === imageExtensionForFile(file))?.[0] || '';
      reader.readAsDataURL(inferred && !mime ? new Blob([file], { type: inferred }) : file);
    });
  }

  async function uniqueImageFileName(directory, file) {
    const base = imageBaseName(file);
    const extension = imageExtensionForFile(file);
    let index = 1;
    let candidate = `${base}${extension}`;
    while (await directoryHasFile(directory, candidate)) {
      index += 1;
      candidate = `${base}-${index}${extension}`;
    }
    return candidate;
  }

  async function storeDirectoryImage(file, doc) {
    if (file.size > DIRECTORY_IMAGE_MAX_FILE_SIZE) throw new Error(`图片「${file.name || '未命名'}」超过 20 MB`);
    const directory = directoryForDoc(doc);
    if (!directory?.handle || !await ensureReadWritePermission(directory.handle)) throw new Error('未获得文档目录读写权限');
    const docParts = normalizeRelativePath(doc.relativePath).split('/');
    const docFileName = docParts.pop() || documentFileName(doc);
    const parent = await directoryHandleAtPath(directory.handle, docParts);
    const assets = await parent.getDirectoryHandle('assets', { create: true });
    const docFolderName = safeFileName(docFileName.replace(/\.(md|markdown|txt)$/i, ''));
    const docFolder = await assets.getDirectoryHandle(docFolderName, { create: true });
    const fileName = await uniqueImageFileName(docFolder, file);
    const handle = await docFolder.getFileHandle(fileName, { create: true });
    try { await writeToFileHandle(handle, file); }
    catch (error) {
      try { await docFolder.removeEntry(fileName); } catch (_cleanupError) { /* 尽力清理写入失败文件 */ }
      throw error;
    }
    return {
      source: encodedMarkdownPath(['assets', docFolderName, fileName]),
      cleanup: async () => { try { await docFolder.removeEntry(fileName); } catch (_error) { /* 忽略回滚失败 */ } }
    };
  }

  async function storeDataUrlImage(file, projectedCharacters) {
    if (file.size > DATA_URL_IMAGE_MAX_FILE_SIZE) {
      throw new Error(`当前文档未关联目录，图片「${file.name || '未命名'}」需小于 1 MB`);
    }
    const source = await fileAsDataUrl(file);
    if (!/^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(source)) throw new Error('图片格式无法安全写入当前文档');
    if (dataUrlCharactersInDocuments() + projectedCharacters + source.length > DATA_URL_IMAGE_MAX_TOTAL_CHARS) {
      throw new Error('浏览器文档中的内嵌图片已接近本地存储上限，请先将文档放入目录后再插入');
    }
    return { source, cleanup: async () => {} };
  }

  function previewRangeAtPoint(clientX, clientY) {
    let range = null;
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(clientX, clientY);
      if (position) {
        range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
      }
    } else if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(clientX, clientY);
    }
    return range && els.previewEditor.contains(range.startContainer) ? range : null;
  }

  function captureImageInsertion(options = {}) {
    const doc = currentDoc();
    if (!doc) return null;
    const usePreview = options.surface === 'preview'
      || (!options.surface && (state.viewMode === 'preview' || (state.viewMode === 'split' && lastEditSurface === 'preview')));
    if (usePreview) {
      const range = options.range || currentPreviewRange();
      const mapped = range ? previewMarkdownSelection(range) : null;
      if (mapped) {
        const canonical = canonicalPreviewSelection(mapped, 'image');
        if (!canonical) return null;
        return {
          docId: doc.id, surface: 'preview', sourceMarkdown: doc.content,
          baseMarkdown: canonical.markdown, start: canonical.start, end: canonical.end,
          selectedText: markdownToPlain(canonical.markdown.slice(canonical.start, canonical.end)).trim().slice(0, 160)
        };
      }
      return {
        docId: doc.id, surface: 'preview', sourceMarkdown: doc.content,
        baseMarkdown: doc.content, start: doc.content.length, end: doc.content.length, selectedText: ''
      };
    }
    const start = Math.max(0, Math.min(doc.content.length, els.sourceEditor.selectionStart || 0));
    const end = Math.max(start, Math.min(doc.content.length, els.sourceEditor.selectionEnd || start));
    return {
      docId: doc.id, surface: 'source', sourceMarkdown: doc.content,
      baseMarkdown: doc.content, start, end,
      selectedText: markdownToPlain(doc.content.slice(start, end)).trim().slice(0, 160)
    };
  }

  function relocateCapturedRange(anchor, markdown) {
    if (markdown === anchor.sourceMarkdown) return { markdown: anchor.baseMarkdown, start: anchor.start, end: anchor.end };
    if (anchor.baseMarkdown !== anchor.sourceMarkdown) return { markdown, start: markdown.length, end: markdown.length };
    const before = anchor.sourceMarkdown;
    let prefix = 0;
    while (prefix < before.length && prefix < markdown.length && before[prefix] === markdown[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < markdown.length - prefix
      && before[before.length - 1 - suffix] === markdown[markdown.length - 1 - suffix]) suffix += 1;
    const oldChangeEnd = before.length - suffix;
    const delta = markdown.length - before.length;
    const mapPosition = (position) => position <= prefix ? position : (position >= oldChangeEnd ? position + delta : markdown.length - suffix);
    return { markdown, start: mapPosition(anchor.start), end: mapPosition(anchor.end) };
  }

  function imageInsertionLines(markdown) {
    const text = String(markdown || '');
    let offset = 0;
    return text.split('\n').map((raw, index, lines) => {
      const line = { raw, start: offset, end: offset + raw.length };
      offset += raw.length + (index < lines.length - 1 ? 1 : 0);
      return line;
    });
  }

  function imageInsertionLineAt(lines, position, isEnd = false) {
    const safePosition = Math.max(0, position - (isEnd && position > 0 ? 1 : 0));
    return lines.find((line) => safePosition >= line.start && safePosition <= line.end)
      || lines[lines.length - 1];
  }

  function imageStructuralLine(raw) {
    const line = String(raw || '');
    const kinds = [];
    let contentStart = 0;
    while (contentStart < line.length) {
      const rest = line.slice(contentStart);
      const patterns = [
        ['quote', /^[ \t]*>[ \t]?/],
        ['task', /^[ \t]*[-*+][ \t]+\[[ xX]\](?:[ \t]+|$)/],
        ['ul', /^[ \t]*[-*+][ \t]+/],
        ['ol', /^[ \t]*\d+[.)][ \t]+/],
        ['heading', /^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/]
      ];
      const matched = patterns.find(([, pattern]) => pattern.test(rest));
      if (!matched) break;
      const marker = rest.match(matched[1])[0];
      kinds.push(matched[0]);
      contentStart += marker.length;
    }
    if (!kinds.length) return null;
    return {
      kinds,
      contentStart,
      empty: !line.slice(contentStart).trim()
    };
  }

  function isImageOnlyMarkdownLine(raw) {
    return /^[ \t]*(?:!\[[^\]\n]*\]\([^\n]+?\)[ \t]*)+$/.test(String(raw || ''));
  }

  function imageInlineMarkdownLine(raw) {
    const line = String(raw || '');
    const formatted = /\[[^\]\n]*\]\([^\n)]+\)|\*\*[^\n]*?\*\*|__[^\n]*?__|~~[^\n]*?~~|`+[^\n]*?`+|\*[^*\n]+\*|_[^_\n]+_/.test(line);
    if (!formatted) return null;
    const visible = line
      .replace(/!\[[^\]\n]*\]\([^\n)]+\)/g, '')
      .replace(/\[([^\]\n]*)\]\([^\n)]+\)/g, '$1')
      .replace(/\*\*|__|~~|`+|\*|_/g, '');
    return {
      contentStart: (line.match(/^[ \t]*/) || [''])[0].length,
      empty: !visible.trim()
    };
  }

  function isHorizontalRuleMarkdownLine(raw) {
    const compact = String(raw || '').trim().replace(/[ \t]/g, '');
    return /^(?:\*{3,}|-{3,}|_{3,})$/.test(compact);
  }

  function imageFenceBlocks(markdown, lines) {
    const blocks = [];
    let open = null;
    lines.forEach((line) => {
      const marker = line.raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
      if (!marker) return;
      if (!open) {
        open = {
          start: line.start,
          marker: marker[1][0],
          markerLength: marker[1].length,
          markerRanges: [{ start: line.start, end: line.end }]
        };
        return;
      }
      const isClosing = marker[1][0] === open.marker
        && marker[1].length >= open.markerLength
        && !line.raw.slice(marker[0].length).trim();
      if (!isClosing) return;
      blocks.push({
        start: open.start,
        end: line.end,
        markerRanges: [...open.markerRanges, { start: line.start, end: line.end }]
      });
      open = null;
    });
    if (open) blocks.push({ start: open.start, end: String(markdown || '').length, markerRanges: open.markerRanges });
    return blocks;
  }

  function isTableDividerLine(raw) {
    const cells = String(raw || '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    return cells.length >= 2 && cells.every((cell) => /^[ \t]*:?-{3,}:?[ \t]*$/.test(cell));
  }

  function isTableCandidateLine(raw) {
    return !!String(raw || '').trim() && String(raw || '').includes('|');
  }

  function imageTableBlockAt(lines, position) {
    const line = imageInsertionLineAt(lines, position);
    const index = lines.indexOf(line);
    if (index < 0 || !isTableCandidateLine(line.raw)) return null;
    let first = index;
    let last = index;
    while (first > 0 && isTableCandidateLine(lines[first - 1].raw)) first -= 1;
    while (last < lines.length - 1 && isTableCandidateLine(lines[last + 1].raw)) last += 1;
    const tableLines = lines.slice(first, last + 1);
    if (!tableLines.some((item) => isTableDividerLine(item.raw))) return null;
    return { start: tableLines[0].start, end: tableLines[tableLines.length - 1].end, lines: tableLines };
  }

  function imageProtectedSelection(markdown, start, end) {
    if (end <= start) return null;
    const lines = imageInsertionLines(markdown);
    const firstLine = imageInsertionLineAt(lines, start);
    const lastLine = imageInsertionLineAt(lines, end, true);
    let protectedStart = firstLine.start;
    let protectedEnd = lastLine.end;
    let protectedSyntax = false;
    const overlaps = (from, to) => start < to && end > from;

    const fences = imageFenceBlocks(markdown, lines);
    fences.forEach((block) => {
      if (block.markerRanges.some((range) => overlaps(range.start, range.end))) {
        protectedSyntax = true;
        protectedStart = Math.min(protectedStart, block.start);
        protectedEnd = Math.max(protectedEnd, block.end);
      }
    });

    lines.forEach((line) => {
      if (!overlaps(line.start, line.end)) return;
      const structural = imageStructuralLine(line.raw);
      const inline = imageInlineMarkdownLine(line.raw);
      const selectedPart = String(markdown || '').slice(Math.max(start, line.start), Math.min(end, line.end));
      const localStart = Math.max(0, start - line.start);
      const localEnd = Math.min(line.raw.length, end - line.start);
      const inlineRemainder = inline
        ? line.raw.slice(0, localStart) + line.raw.slice(localEnd)
        : '';
      const selectionHitsPrefix = structural
        && overlaps(line.start, line.start + structural.contentStart);
      const selectionHitsInlineMarker = inline && /[*_~`\[\]()]/.test(selectedPart);
      const selectionEmptiesInline = inline && imageInlineMarkdownLine(inlineRemainder)?.empty;
      if (selectionHitsPrefix || selectionHitsInlineMarker || selectionEmptiesInline || isImageOnlyMarkdownLine(line.raw) || isHorizontalRuleMarkdownLine(line.raw)) {
        protectedSyntax = true;
      }
      const table = imageTableBlockAt(lines, line.start);
      if (table) {
        if (selectedPart.includes('|') || isTableDividerLine(line.raw)) {
          protectedSyntax = true;
          protectedStart = Math.min(protectedStart, table.start);
          protectedEnd = Math.max(protectedEnd, table.end);
        }
      }
    });

    return protectedSyntax ? { start: protectedStart, end: protectedEnd } : null;
  }

  function normalizeImageInsertion(markdown, start, end) {
    let text = String(markdown || '');
    let safeStart = Math.max(0, Math.min(text.length, Number(start) || 0));
    let safeEnd = Math.max(safeStart, Math.min(text.length, Number(end) || safeStart));
    const protectedSelection = imageProtectedSelection(text, safeStart, safeEnd);
    if (protectedSelection) {
      return { markdown: text, start: protectedSelection.start, end: protectedSelection.end };
    }
    if (safeEnd > safeStart) {
      text = text.slice(0, safeStart) + text.slice(safeEnd);
      safeEnd = safeStart;
    }

    const lines = imageInsertionLines(text);
    const fence = imageFenceBlocks(text, lines)
      .find((block) => safeStart >= block.start && safeStart <= block.end);
    if (fence) {
      const position = safeStart <= fence.start ? fence.start : fence.end;
      return { markdown: text, start: position, end: position };
    }

    const table = imageTableBlockAt(lines, safeStart);
    if (table) {
      const position = safeStart <= table.start ? table.start : table.end;
      return { markdown: text, start: position, end: position };
    }

    const line = imageInsertionLineAt(lines, safeStart);
    const structural = imageStructuralLine(line.raw);
    if (structural?.empty) return { markdown: text, start: line.start, end: line.end };
    if (structural) {
      const position = safeStart <= line.start + structural.contentStart ? line.start : line.end;
      return { markdown: text, start: position, end: position };
    }
    if (isImageOnlyMarkdownLine(line.raw) || isHorizontalRuleMarkdownLine(line.raw)) {
      const position = safeStart <= line.start ? line.start : line.end;
      return { markdown: text, start: position, end: position };
    }
    const inline = imageInlineMarkdownLine(line.raw);
    if (inline?.empty) return { markdown: text, start: line.start, end: line.end };
    if (inline) {
      const position = safeStart <= line.start + inline.contentStart ? line.start : line.end;
      return { markdown: text, start: position, end: position };
    }
    return { markdown: text, start: safeStart, end: safeEnd };
  }

  function insertImageBlocks(markdown, start, end, blocks) {
    const normalized = normalizeImageInsertion(markdown, start, end);
    const before = normalized.markdown.slice(0, normalized.start);
    const after = normalized.markdown.slice(normalized.end);
    const prefix = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const suffix = !after ? '' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    const rows = [];
    for (let index = 0; index < blocks.length; index += 6) rows.push(blocks.slice(index, index + 6).join(' '));
    const insertion = prefix + rows.join('\n\n') + suffix;
    const imageStartIndex = (before.match(/!\[[^\]\n]*\]\([^\n)]+\)/g) || []).length;
    return {
      text: before + insertion + after,
      caret: before.length + insertion.length,
      imageStartIndex,
      insertedImageCount: blocks.length
    };
  }

  function placePreviewCaretAfterInsertedImages(result) {
    const images = [...els.previewEditor.querySelectorAll('img')];
    const targetIndex = result.imageStartIndex + result.insertedImageCount - 1;
    const row = images[targetIndex]?.closest?.('.app-image-row');
    if (!row) return false;
    const paragraph = ensurePreviewCaretParagraphAfter(row);
    if (!paragraph) return false;
    placePreviewCaret(paragraph, 0);
    lastEditSurface = 'preview';
    return true;
  }

  function applyImageBlocks(anchor, blocks) {
    if (!anchor || !blocks.length || state.currentDocId !== anchor.docId) return false;
    const doc = currentDoc();
    const located = relocateCapturedRange(anchor, doc.content);
    const result = insertImageBlocks(located.markdown, located.start, located.end, blocks);
    setCurrentMarkdown(result.text);
    renderPreview();
    if (anchor.surface === 'preview') {
      placePreviewCaretAfterInsertedImages(result);
    } else if (state.viewMode !== 'preview') {
      els.sourceEditor.focus();
      setProgrammaticSourceSelection(result.caret, result.caret);
    }
    return true;
  }

  async function insertImageFiles(fileList, anchor) {
    const files = [...(fileList || [])].filter((file) => isSupportedImageFile(file));
    if (!files.length) { tip('请选择 PNG、JPG、GIF、WebP 或 AVIF 图片'); return false; }
    if (!anchor || state.currentDocId !== anchor.docId) { tip('插入位置已失效，请重试'); return false; }
    tip(files.length > 1 ? `正在处理 ${files.length} 张图片…` : '正在处理图片…');
    const stored = [];
    let projectedCharacters = 0;
    try {
      const doc = currentDoc();
      for (const file of files) {
        const item = isDirectoryDoc(doc)
          ? await storeDirectoryImage(file, doc)
          : await storeDataUrlImage(file, projectedCharacters);
        projectedCharacters += item.source.length;
        stored.push({ ...item, alt: imageBaseName(file) });
      }
      if (state.currentDocId !== anchor.docId) throw new Error('已切换文档，未插入图片');
      const blocks = stored.map((item, index) => markdownImageSyntax(index === 0 && anchor.selectedText ? anchor.selectedText : item.alt, item.source));
      if (!applyImageBlocks(anchor, blocks)) throw new Error('图片插入位置已失效');
      tip(files.length > 1 ? `已插入 ${files.length} 张图片` : (isDirectoryDoc(doc) ? '图片已写入文档 assets 目录' : '图片已内嵌到当前文档'));
      return true;
    } catch (error) {
      await Promise.all(stored.map((item) => item.cleanup()));
      console.warn('插入图片失败', error);
      tip(`插入图片失败：${error?.message || '未知错误'}`);
      return false;
    }
  }

  function insertImageUrl(rawUrl, alt, anchor) {
    const source = normalizedHttpImageUrl(rawUrl);
    if (!source) { tip('请输入有效的 HTTP 或 HTTPS 图片网址'); return false; }
    const label = String(alt || '').trim() || anchor?.selectedText || '图片';
    if (!applyImageBlocks(anchor, [markdownImageSyntax(label, source)])) {
      tip('插入位置已失效，请重试');
      return false;
    }
    tip('已插入网络图片');
    return true;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (!canvas || typeof canvas.toBlob !== 'function') {
        reject(new Error('当前浏览器不支持 PNG 导出'));
        return;
      }
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 生成失败')), 'image/png');
    });
  }

  async function waitForImages(container) {
    const images = [...container.querySelectorAll('img')];
    await Promise.all(images.map((image) => {
      if (image.complete) return Promise.resolve();
      return new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
    }));
  }

  function createExportCapture() {
    const capture = document.createElement('div');
    capture.className = 'editor-preview app-export-capture';
    capture.innerHTML = els.previewEditor.innerHTML;
    capture.querySelectorAll('.app-comment-anchor, .app-comment-draft').forEach((anchor) => anchor.replaceWith(...anchor.childNodes));
    capture.querySelectorAll('mark.app-search-match').forEach((mark) => mark.replaceWith(...mark.childNodes));
    capture.querySelectorAll('.app-search-target').forEach((target) => target.classList.remove('app-search-target'));
    capture.querySelectorAll('[data-md-preview-caret]').forEach((paragraph) => paragraph.remove());
    capture.querySelectorAll('.app-block-comment-anchor, .app-comment-block-target, .app-comment-locate').forEach((block) => {
      block.classList.remove('app-block-comment-anchor', 'app-comment-block-target', 'app-comment-locate', 'is-active');
      block.removeAttribute('data-comment-ids');
      block.removeAttribute('role');
      block.removeAttribute('tabindex');
      block.removeAttribute('aria-label');
    });
    capture.removeAttribute('contenteditable');
    capture.style.width = `${Math.max(720, Math.round(els.previewEditor.getBoundingClientRect().width || 720))}px`;
    document.body.appendChild(capture);
    return capture;
  }

  function setExportBusy(button, busy) {
    const controls = [button, els.btnExport, els.btnMd, els.btnPdf, els.btnImg].filter(Boolean);
    [...new Set(controls)].forEach((control) => {
      control.disabled = busy;
      control.classList.toggle('is-loading', busy);
      control.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
  }

  async function capturePreview(capture) {
    await waitForImages(capture);
    return html2canvas(capture, {
      backgroundColor: '#ffffff',
      scale: Math.min(2, window.devicePixelRatio || 1),
      useCORS: true,
      logging: false,
      width: capture.scrollWidth,
      height: capture.scrollHeight,
      windowWidth: capture.scrollWidth,
      windowHeight: capture.scrollHeight
    });
  }

  async function generatePdfBlob() {
    const JsPdf = window.jspdf && window.jspdf.jsPDF;
    if (typeof html2canvas === 'undefined' || !JsPdf) throw new Error('PDF 导出库未加载');
    await previewImagesReady;
    const capture = createExportCapture();
    try {
      const canvas = await capturePreview(capture);
      const pdf = new JsPdf({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 36;
      const contentWidth = pageWidth - margin * 2;
      const contentHeight = pageHeight - margin * 2;
      const pointsPerPixel = contentWidth / canvas.width;
      const pageSliceHeight = Math.max(1, Math.floor(contentHeight / pointsPerPixel));
      let pageIndex = 0;

      for (let offsetY = 0; offsetY < canvas.height; offsetY += pageSliceHeight) {
        const sliceHeight = Math.min(pageSliceHeight, canvas.height - offsetY);
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvas.width;
        pageCanvas.height = sliceHeight;
        const context = pageCanvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        context.drawImage(canvas, 0, offsetY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
        if (pageIndex > 0) pdf.addPage();
        pdf.addImage(
          pageCanvas.toDataURL('image/jpeg', 0.94),
          'JPEG',
          margin,
          margin,
          contentWidth,
          sliceHeight * pointsPerPixel,
          undefined,
          'FAST'
        );
        pageIndex += 1;
      }

      const fileName = `${safeFileName(currentDoc()?.name)}.pdf`;
      const blob = pdf.output('blob');
      return { blob, fileName, pageCount: pageIndex };
    } finally {
      capture.remove();
    }
  }

  function exportMarkdown() {
    if (exportInProgress) return false;
    const markdown = getCurrentMarkdown();
    const fileName = `${safeFileName(currentDoc()?.name)}.md`;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    window.__MD_EDITOR_LAST_MD__ = { fileName, content: markdown, size: blob.size };
    tip(`已导出 ${fileName}`);
    return true;
  }

  async function writeToFileHandle(handle, content) {
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  function fileExtension(fileName) {
    const match = String(fileName || '').match(/\.(md|markdown|txt)$/i);
    return match ? match[0] : '.md';
  }

  function validateFileBaseName(name) {
    const value = String(name || '').trim();
    if (!value) return '文档名称不能为空';
    if (/[<>:"/\\|?*\u0000-\u001F]/.test(value) || /[.\s]$/.test(value)) {
      return '名称不能包含 \\ / : * ? " < > |，且不能以句点或空格结尾';
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
      return '该名称是 Windows 系统保留名称，请换一个名称';
    }
    return '';
  }

  async function ensureReadWritePermission(handle) {
    if (!handle) return false;
    try {
      const options = { mode: 'readwrite' };
      const current = handle.queryPermission ? await handle.queryPermission(options) : 'granted';
      if (current === 'granted') return true;
      if (!handle.requestPermission) return false;
      return (await handle.requestPermission(options)) === 'granted';
    } catch (error) { return false; }
  }

  async function queryReadWritePermission(handle) {
    if (!handle) return 'denied';
    try {
      return handle.queryPermission ? await handle.queryPermission({ mode: 'readwrite' }) : 'granted';
    } catch (error) { return 'denied'; }
  }

  function directoryForDoc(doc) {
    return isDirectoryDoc(doc) ? state.directories.find((directory) => directory.id === doc.directoryId) || null : null;
  }

  async function enumerateDirectoryFiles(directoryHandle) {
    const entries = [], errors = [];
    let visited = 0, truncated = false, depthLimited = false;

    async function walk(handle, prefix, depth) {
      try {
        for await (const [name, entryHandle] of handle.entries()) {
          if (entries.length >= DIRECTORY_MAX_FILES) { truncated = true; return; }
          if (entryHandle.kind === 'directory') {
            if (shouldIgnoreDirectoryEntry(name, 'directory', depth)) {
              if (!String(name).startsWith('.') && name !== 'node_modules' && depth >= DIRECTORY_MAX_DEPTH) depthLimited = true;
              continue;
            }
            await walk(entryHandle, normalizeRelativePath(`${prefix}/${name}`), depth + 1);
          } else if (!shouldIgnoreDirectoryEntry(name, 'file', depth)) {
            try {
              const file = await entryHandle.getFile();
              if (file.size > DIRECTORY_MAX_FILE_SIZE) {
                errors.push({ path: normalizeRelativePath(`${prefix}/${name}`), reason: `文件超过 ${DIRECTORY_MAX_FILE_SIZE_MB} MB，未载入` });
              } else {
                entries.push({
                  relativePath: normalizeRelativePath(`${prefix}/${name}`),
                  fileName: name,
                  handle: entryHandle,
                  file,
                  lastModified: file.lastModified,
                  size: file.size
                });
              }
            } catch (error) {
              errors.push({ path: normalizeRelativePath(`${prefix}/${name}`), reason: error.message || '无法读取' });
            }
          }
          visited += 1;
          if (visited % 40 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch (error) {
        errors.push({ path: prefix || directoryHandle.name, reason: error.message || '无法访问目录' });
      }
    }

    await walk(directoryHandle, '', 0);
    return { entries, errors, truncated, depthLimited };
  }

  async function scanDirectory(directory, options) {
    const opts = options || {};
    if (!directory || !directory.handle || activeDirectoryScanId === directory.id) return null;
    let permission = await queryReadWritePermission(directory.handle);
    if (permission !== 'granted' && opts.interactive) {
      permission = await ensureReadWritePermission(directory.handle) ? 'granted' : 'denied';
    }
    directory.permissionState = permission;
    if (permission !== 'granted') {
      directory.lastScanStatus = 'permission-required';
      state.docs.filter((doc) => doc.directoryId === directory.id).forEach((doc) => { doc.syncState = 'permission-required'; });
      saveState({ silent: true });
      renderDocList();
      renderDirectoryModal();
      updateConflictBar();
      return null;
    }

    activeDirectoryScanId = directory.id;
    directory.lastScanStatus = 'scanning';
    renderDocList();
    renderDirectoryModal();
    try {
      const scan = await enumerateDirectoryFiles(directory.handle);
      const existingDocs = state.docs.filter((doc) => doc.directoryId === directory.id);
      const diff = diffDirectoryIndex(existingDocs, scan.entries);
      let refreshedCurrent = false;

      diff.added.forEach((entry) => markSemanticIndexDirty(directoryDocId(directory.id, entry.relativePath)));
      diff.changed.forEach(({ doc }) => markSemanticIndexDirty(doc.id));
      diff.missing.forEach((doc) => markSemanticIndexDirty(doc.id));

      for (const entry of diff.added) {
        const doc = {
          id: directoryDocId(directory.id, entry.relativePath),
          name: entry.fileName.replace(/\.(md|markdown|txt)$/i, ''),
          content: '',
          lastSavedContent: '',
          fileHandle: entry.handle,
          directoryHandle: directory.handle,
          localFileName: entry.fileName,
          openedWithoutHandle: false,
          sourceKind: 'directory-file',
          directoryId: directory.id,
          relativePath: entry.relativePath,
          externalModifiedAt: entry.lastModified,
          externalSize: entry.size,
          syncState: 'synced',
          unread: true,
          contentLoaded: false,
          externalContent: null,
          lastOpenedAt: 0
        };
        state.docs.push(doc);
        await persistDocHandles(doc);
      }

      for (const item of diff.changed) {
        const { doc, entry } = item;
        doc.fileHandle = entry.handle;
        doc.directoryHandle = directory.handle;
        doc.localFileName = entry.fileName;
        doc.externalModifiedAt = entry.lastModified;
        doc.externalSize = entry.size;
        const diskContent = await readFileAsText(entry.file);
        if (isDocDirty(doc)) {
          doc.syncState = 'conflict';
          doc.externalContent = diskContent;
        } else {
          doc.content = diskContent;
          doc.lastSavedContent = diskContent;
          doc.contentLoaded = true;
          doc.externalContent = null;
          doc.syncState = 'updated';
          doc.unread = doc.id !== state.currentDocId;
          histories.set(doc.id, { entries: [diskContent], index: 0, lastInputAt: 0, lastInputSource: null });
          if (doc.id === state.currentDocId) refreshedCurrent = true;
        }
        await persistDocHandles(doc);
      }

      diff.unchanged.forEach(({ doc, entry }) => {
        doc.fileHandle = entry.handle;
        doc.directoryHandle = directory.handle;
        if (doc.syncState === 'permission-required') doc.syncState = 'synced';
      });
      diff.missing.forEach((doc) => { doc.syncState = 'missing'; });

      directory.lastScannedAt = Date.now();
      directory.lastScanStatus = scan.errors.length || scan.truncated || scan.depthLimited ? 'partial' : 'success';
      directory.lastScanSummary = {
        added: diff.added.length,
        updated: diff.changed.length,
        missing: diff.missing.length,
        errors: scan.errors.length,
        errorDetails: scan.errors.slice(0, 5),
        total: scan.entries.length,
        truncated: scan.truncated,
        depthLimited: scan.depthLimited
      };
      saveState({ silent: true });
      renderDocList();
      renderDirectoryModal();
      if (refreshedCurrent) { syncSourceToDOM(); render(); updateEditChrome(); }
      updateConflictBar();
      if (opts.announce) {
        const summary = directory.lastScanSummary;
        tip(summary.added || summary.updated || summary.missing
          ? `扫描完成：新增 ${summary.added}，更新 ${summary.updated}，缺失 ${summary.missing}`
          : '扫描完成，暂无更新');
      }
      return directory.lastScanSummary;
    } catch (error) {
      directory.lastScanStatus = 'error';
      directory.lastScanSummary = { error: error.message || '扫描失败' };
      renderDirectoryModal();
      if (opts.announce) tip(`扫描失败：${error.message || '未知错误'}`);
      return null;
    } finally {
      activeDirectoryScanId = null;
      saveState({ silent: true });
      renderDocList();
    }
  }

  async function scanAllDirectories(options) {
    for (const directory of [...state.directories].sort((a, b) => a.order - b.order)) {
      if (directory.scanMode !== 'manual') await scanDirectory(directory, options);
    }
  }

  function updateDirectoryRefreshButton() {
    if (!els.btnRefreshDirectories) return;
    const refreshing = !!directoryRefreshPromise || !!activeDirectoryScanId;
    els.btnRefreshDirectories.disabled = !state.directories.length || refreshing;
    els.btnRefreshDirectories.classList.toggle('is-refreshing', refreshing);
    const label = refreshing ? '正在刷新目录' : (state.directories.length ? '刷新全部目录' : '暂无可刷新的目录');
    els.btnRefreshDirectories.title = label;
    els.btnRefreshDirectories.setAttribute('aria-label', label);
  }

  function refreshAllDirectories() {
    if (directoryRefreshPromise) return directoryRefreshPromise;
    if (!state.directories.length) {
      tip('请先添加目录');
      return Promise.resolve(null);
    }
    directoryRefreshPromise = (async () => {
      while (activeDirectoryScanId) await new Promise((resolve) => setTimeout(resolve, 80));
      updateDirectoryRefreshButton();
      const totals = { added: 0, updated: 0, missing: 0, errors: 0 };
      for (const directory of [...state.directories].sort((a, b) => a.order - b.order)) {
        const summary = await scanDirectory(directory, { interactive: true, announce: false });
        if (!summary) continue;
        totals.added += Number(summary.added) || 0;
        totals.updated += Number(summary.updated) || 0;
        totals.missing += Number(summary.missing) || 0;
        totals.errors += Number(summary.errors) || 0;
      }
      const permissionCount = state.directories.filter((directory) => directory.permissionState !== 'granted').length;
      if (totals.added || totals.updated || totals.missing) {
        tip(`目录刷新完成：新增 ${totals.added}，更新 ${totals.updated}，缺失 ${totals.missing}${permissionCount ? `；${permissionCount} 个目录需授权` : ''}`);
      } else if (permissionCount) {
        tip(`已刷新可访问目录；${permissionCount} 个目录需要重新授权`);
      } else {
        tip(totals.errors ? `目录刷新完成，跳过 ${totals.errors} 个无法读取的文件` : '目录刷新完成，暂无更新');
      }
      scheduleSemanticIndexSync(300);
      return { ...totals, permissionCount };
    })().finally(() => {
      directoryRefreshPromise = null;
      updateDirectoryRefreshButton();
    });
    updateDirectoryRefreshButton();
    return directoryRefreshPromise;
  }

  async function readDirectoryDocument(doc, interactive) {
    if (!isDirectoryDoc(doc)) return true;
    const directory = directoryForDoc(doc);
    if (!directory || !directory.handle || !doc.fileHandle) {
      doc.syncState = 'permission-required';
      updateConflictBar();
      return false;
    }
    let permission = await queryReadWritePermission(directory.handle);
    if (permission !== 'granted' && interactive) permission = await ensureReadWritePermission(directory.handle) ? 'granted' : 'denied';
    directory.permissionState = permission;
    if (permission !== 'granted') {
      doc.syncState = 'permission-required';
      renderDocList();
      renderDirectoryModal();
      updateConflictBar();
      tip('需要重新授权该目录后才能读取文档');
      return false;
    }
    try {
      const file = await doc.fileHandle.getFile();
      if (file.size > DIRECTORY_MAX_FILE_SIZE) throw new Error(`文件超过 ${DIRECTORY_MAX_FILE_SIZE_MB} MB，无法在编辑器中打开`);
      if (!doc.contentLoaded || (doc.syncState === 'updated' && !isDocDirty(doc))) {
        const content = await readFileAsText(file);
        doc.content = content;
        doc.lastSavedContent = content;
        doc.contentLoaded = true;
        doc.externalContent = null;
        histories.set(doc.id, { entries: [content], index: 0, lastInputAt: 0, lastInputSource: null });
      }
      doc.externalModifiedAt = file.lastModified;
      doc.externalSize = file.size;
      if (doc.syncState !== 'conflict') doc.syncState = 'synced';
      doc.unread = false;
      saveState({ silent: true });
      return true;
    } catch (error) {
      if (error && error.name === 'NotFoundError') doc.syncState = 'missing';
      else doc.syncState = 'permission-required';
      renderDocList();
      updateConflictBar();
      tip(`无法读取文档：${error.message || '未知错误'}`);
      return false;
    }
  }

  async function matchingFileInDirectory(directory, fileHandle) {
    let entry;
    try { entry = await directory.getFileHandle(fileHandle.name); }
    catch (error) {
      if (error && error.name === 'NotFoundError') return null;
      throw error;
    }
    if (entry.isSameEntry && fileHandle.isSameEntry && !await entry.isSameEntry(fileHandle)) return null;
    return entry;
  }

  async function selectParentDirectory(doc) {
    if (doc.directoryHandle) {
      try {
        if (await ensureReadWritePermission(doc.directoryHandle)
          && await matchingFileInDirectory(doc.directoryHandle, doc.fileHandle)) return doc.directoryHandle;
      } catch (error) { console.warn('已缓存的文件夹授权已失效', error); }
      doc.directoryHandle = null;
    }
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('当前浏览器不支持同步重命名，请使用最新版 Chrome 或 Edge');
    }
    const directory = await window.showDirectoryPicker({ mode: 'readwrite', startIn: doc.fileHandle });
    if (!await ensureReadWritePermission(directory)) throw new Error('未获得文件夹读写权限');
    if (!await matchingFileInDirectory(directory, doc.fileHandle)) {
      throw new Error(`所选文件夹中未找到当前文档「${doc.fileHandle.name}」`);
    }
    doc.directoryHandle = directory;
    return directory;
  }

  async function directoryHasFile(directory, fileName) {
    try {
      await directory.getFileHandle(fileName);
      return true;
    } catch (error) {
      if (error && error.name === 'NotFoundError') return false;
      throw error;
    }
  }

  async function renameLocalFile(doc, nextBaseName) {
    if (!doc.fileHandle) throw new Error('当前文档未获得原文件写入权限，请使用「打开文档」重新打开后再重命名');
    const oldFileName = doc.fileHandle.name;
    const nextFileName = `${nextBaseName}${fileExtension(oldFileName)}`;
    if (nextFileName === oldFileName) return { fileHandle: doc.fileHandle, fileName: oldFileName };

    const directory = await selectParentDirectory(doc);
    if (await directoryHasFile(directory, nextFileName)) throw new Error(`文件夹中已存在「${nextFileName}」`);

    const nextHandle = await directory.getFileHandle(nextFileName, { create: true });
    try {
      await writeToFileHandle(nextHandle, doc.content);
      await directory.removeEntry(oldFileName);
    } catch (error) {
      try { await directory.removeEntry(nextFileName); } catch (cleanupError) { console.warn('清理重命名临时文件失败', cleanupError); }
      throw error;
    }
    return { fileHandle: nextHandle, fileName: nextFileName, directoryHandle: directory };
  }

  async function directoryHandleAtPath(root, parts) {
    let handle = root;
    for (const part of parts) handle = await handle.getDirectoryHandle(part);
    return handle;
  }

  async function renameDirectoryDocument(doc, nextBaseName) {
    const directory = directoryForDoc(doc);
    if (!directory || !directory.handle || !doc.fileHandle) throw new Error('目录授权已失效，请重新授权后再重命名');
    if (!await ensureReadWritePermission(directory.handle)) throw new Error('未获得目录读写权限');
    const parts = normalizeRelativePath(doc.relativePath).split('/');
    const oldFileName = parts.pop();
    const nextFileName = `${nextBaseName}${fileExtension(oldFileName)}`;
    if (nextFileName === oldFileName) return doc;
    const parent = await directoryHandleAtPath(directory.handle, parts);
    if (await directoryHasFile(parent, nextFileName)) throw new Error(`当前文件夹中已存在「${nextFileName}」`);
    const nextHandle = await parent.getFileHandle(nextFileName, { create: true });
    try {
      await writeToFileHandle(nextHandle, doc.content);
      await parent.removeEntry(oldFileName);
    } catch (error) {
      try { await parent.removeEntry(nextFileName); } catch (cleanupError) { console.warn('清理重命名临时文件失败', cleanupError); }
      throw error;
    }
    const oldId = doc.id;
    const nextRelativePath = normalizeRelativePath([...parts, nextFileName].join('/'));
    const nextId = directoryDocId(directory.id, nextRelativePath);
    migrateReviewDocumentId(oldId, nextId);
    const history = histories.get(oldId);
    histories.delete(oldId);
    if (history) histories.set(nextId, history);
    if (state.currentDocId === oldId) state.currentDocId = nextId;
    doc.id = nextId;
    doc.relativePath = nextRelativePath;
    doc.fileHandle = nextHandle;
    doc.directoryHandle = directory.handle;
    doc.localFileName = nextFileName;
    doc.name = nextBaseName;
    const file = await nextHandle.getFile();
    doc.externalModifiedAt = file.lastModified;
    doc.externalSize = file.size;
    doc.syncState = 'synced';
    doc.externalContent = null;
    markSemanticIndexDirty(oldId);
    markSemanticIndexDirty(nextId);
    await removePersistedHandles(oldId);
    await persistDocHandles(doc);
    return doc;
  }

  async function saveCurrentDocument() {
    const doc = currentDoc();
    if (!doc) return false;
    const content = getCurrentMarkdown();

    if (doc.fileHandle) {
      try {
        if (isDirectoryDoc(doc)) {
          if (doc.syncState === 'conflict') {
            updateConflictBar();
            tip('磁盘版本已更新，请先处理版本冲突');
            return false;
          }
          const latestFile = await doc.fileHandle.getFile();
          if (doc.externalModifiedAt && (latestFile.lastModified !== doc.externalModifiedAt || latestFile.size !== doc.externalSize)) {
            doc.externalContent = await readFileAsText(latestFile);
            doc.externalModifiedAt = latestFile.lastModified;
            doc.externalSize = latestFile.size;
            doc.syncState = 'conflict';
            saveState({ silent: true });
            renderDocList();
            updateConflictBar();
            tip('检测到磁盘版本更新，已停止保存');
            return false;
          }
        }
        if (!await ensureReadWritePermission(doc.fileHandle)) throw new Error('未获得文件写入权限');
        await writeToFileHandle(doc.fileHandle, content);
        doc.localFileName = doc.fileHandle.name || doc.localFileName || null;
        doc.openedWithoutHandle = false;
        if (!isDirectoryDoc(doc)) doc.sourceKind = 'local-file';
        if (isDirectoryDoc(doc)) {
          const savedFile = await doc.fileHandle.getFile();
          doc.externalModifiedAt = savedFile.lastModified;
          doc.externalSize = savedFile.size;
          doc.syncState = 'synced';
          doc.externalContent = null;
        }
        await persistDocHandles(doc);
        markDocSaved(doc, content);
        clearTimeout(saveTimer);
        saveState();
        updateStatus();
        renderDocList();
        updateConflictBar();
        tip(`已保存到「${doc.name}」`);
        window.__MD_EDITOR_LAST_SAVE__ = { mode: 'handle', name: doc.name, size: content.length };
        return true;
      } catch (e) {
        console.warn('写回原文件失败，尝试另存', e);
      }
    }

    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: `${safeFileName(doc.name)}.md`,
          types: TEXT_FILE_PICKER_TYPES
        });
        await writeToFileHandle(handle, content);
        doc.fileHandle = handle;
        doc.localFileName = handle.name || `${safeFileName(doc.name)}.md`;
        doc.openedWithoutHandle = false;
        doc.sourceKind = 'local-file';
        await persistDocHandles(doc);
        if (handle.name) {
          const base = handle.name.replace(/\.(md|markdown|txt)$/i, '');
          if (base && base !== doc.name && !state.docs.some((d) => d.id !== doc.id && d.name === base)) {
            doc.name = base;
            renderDocList();
          }
        }
        markDocSaved(doc, content);
        clearTimeout(saveTimer);
        saveState();
        updateStatus();
        tip(`已保存到「${doc.name}」`);
        window.__MD_EDITOR_LAST_SAVE__ = { mode: 'picker', name: doc.name, size: content.length };
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') return false;
        console.warn('另存为失败，回退下载', e);
      }
    }

    if (!exportMarkdown()) {
      tip('当前正在导出，请稍后再保存');
      return false;
    }
    markDocSaved(doc, content);
    doc.localFileName = `${safeFileName(doc.name)}.md`;
    doc.openedWithoutHandle = true;
    clearTimeout(saveTimer);
    saveState();
    updateStatus();
    tip('已下载保存（当前环境无法直接写回原文件）');
    window.__MD_EDITOR_LAST_SAVE__ = { mode: 'download', name: doc.name, size: content.length };
    return true;
  }

  async function exportPdf() {
    if (exportInProgress) return;
    exportInProgress = true;
    setExportBusy(els.btnPdf, true);
    tip('正在生成 PDF…');
    try {
      const result = await generatePdfBlob();
      window.__MD_EDITOR_LAST_PDF__ = result;
      const { blob, fileName } = result;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      tip(`已导出 ${fileName}`);
    } catch (error) {
      console.error('PDF 导出失败', error);
      tip(`PDF 导出失败：${error.message || '未知错误'}`);
    } finally {
      exportInProgress = false;
      setExportBusy(els.btnPdf, false);
    }
  }

  async function exportImage() {
    if (exportInProgress) return;
    if (typeof html2canvas === 'undefined') { tip('图片导出库未加载'); return; }
    exportInProgress = true;
    setExportBusy(els.btnImg, true);
    tip('正在生成完整 PNG…');
    let capture = null;
    try {
      await previewImagesReady;
      capture = createExportCapture();
      const canvas = await capturePreview(capture);
      const blob = await canvasToBlob(canvas);
      const fileName = `${safeFileName(currentDoc()?.name)}.png`;
      window.__MD_EDITOR_LAST_PNG__ = { blob, fileName, width: canvas.width, height: canvas.height };
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      tip(`已导出 ${anchor.download}`);
    } catch (error) {
      console.error('图片导出失败', error);
      tip(`图片导出失败：${error.message || '未知错误'}`);
    } finally {
      if (capture) capture.remove();
      exportInProgress = false;
      setExportBusy(els.btnImg, false);
    }
  }

  function exportMenuItems() {
    return [...els.exportMenu.querySelectorAll('.export-menu__item')];
  }

  function positionExportMenu() {
    if (!els.exportMenu || els.exportMenu.hidden) return;
    const buttonRect = els.btnExport.getBoundingClientRect();
    const menuRect = els.exportMenu.getBoundingClientRect();
    const gap = 6;
    const viewportGap = 8;
    const left = Math.min(
      Math.max(viewportGap, buttonRect.right - menuRect.width),
      Math.max(viewportGap, window.innerWidth - menuRect.width - viewportGap)
    );
    const below = buttonRect.bottom + gap;
    const top = below + menuRect.height <= window.innerHeight - viewportGap
      ? below
      : Math.max(viewportGap, buttonRect.top - menuRect.height - gap);
    els.exportMenu.style.left = `${Math.round(left)}px`;
    els.exportMenu.style.top = `${Math.round(top)}px`;
  }

  function closeExportMenu(restoreFocus) {
    if (!els.exportMenu || els.exportMenu.hidden) return;
    els.exportMenu.hidden = true;
    els.btnExport.setAttribute('aria-expanded', 'false');
    if (restoreFocus) els.btnExport.focus();
  }

  function openExportMenu() {
    if (exportInProgress) return;
    els.headingMenu.hidden = true;
    closeTablePicker(false);
    closeImageMenu(false);
    els.exportMenu.hidden = false;
    els.btnExport.setAttribute('aria-expanded', 'true');
    positionExportMenu();
    requestAnimationFrame(() => exportMenuItems()[0]?.focus());
  }

  function selectExportFormat(action) {
    closeExportMenu(false);
    Promise.resolve(action()).finally(() => requestAnimationFrame(() => els.btnExport.focus()));
  }

  function bindExportMenu() {
    els.btnExport.addEventListener('click', (event) => {
      event.stopPropagation();
      if (els.exportMenu.hidden) openExportMenu();
      else closeExportMenu(true);
    });
    els.exportMenu.addEventListener('click', (event) => event.stopPropagation());
    els.btnMd.addEventListener('click', () => selectExportFormat(exportMarkdown));
    els.btnPdf.addEventListener('click', () => selectExportFormat(exportPdf));
    els.btnImg.addEventListener('click', () => selectExportFormat(exportImage));
    els.exportMenu.addEventListener('keydown', (event) => {
      const items = exportMenuItems();
      const index = items.indexOf(document.activeElement);
      let nextIndex = index;
      if (event.key === 'ArrowDown') nextIndex = (index + 1) % items.length;
      else if (event.key === 'ArrowUp') nextIndex = (index - 1 + items.length) % items.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = items.length - 1;
      else if (event.key === 'Escape') {
        event.preventDefault();
        closeExportMenu(true);
        return;
      } else return;
      event.preventDefault();
      items[nextIndex]?.focus();
    });
    document.addEventListener('click', () => closeExportMenu(false));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !els.exportMenu.hidden) {
        event.preventDefault();
        closeExportMenu(true);
      }
    });
    window.addEventListener('resize', positionExportMenu);
    window.addEventListener('scroll', positionExportMenu, true);
  }

  function imageMenuItems() {
    return [...els.imageMenu.querySelectorAll('.image-menu__item')];
  }

  function positionImageMenu() {
    if (!els.imageMenu || els.imageMenu.hidden) return;
    const buttonRect = els.imageBtn.getBoundingClientRect();
    const menuRect = els.imageMenu.getBoundingClientRect();
    const gap = 6;
    const viewportGap = 8;
    const left = Math.min(
      Math.max(viewportGap, buttonRect.left),
      Math.max(viewportGap, window.innerWidth - menuRect.width - viewportGap)
    );
    const below = buttonRect.bottom + gap;
    const top = below + menuRect.height <= window.innerHeight - viewportGap
      ? below
      : Math.max(viewportGap, buttonRect.top - menuRect.height - gap);
    els.imageMenu.style.left = `${Math.round(left)}px`;
    els.imageMenu.style.top = `${Math.round(top)}px`;
  }

  function closeImageMenu(restoreFocus) {
    if (!els.imageMenu || els.imageMenu.hidden) return;
    els.imageMenu.hidden = true;
    els.imageBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) els.imageBtn.focus();
  }

  function openImageMenu() {
    els.headingMenu.hidden = true;
    closeTablePicker(false);
    closeExportMenu(false);
    els.imageMenu.hidden = false;
    els.imageBtn.setAttribute('aria-expanded', 'true');
    positionImageMenu();
    requestAnimationFrame(() => imageMenuItems()[0]?.focus());
  }

  function closeImageUrlModal(restoreFocus) {
    setModalOpen(els.imageUrlModal, false);
    pendingImageInsertion = null;
    if (restoreFocus) els.imageBtn.focus();
  }

  function openImageUrlModal(anchor) {
    pendingImageInsertion = anchor;
    els.imageUrlForm.reset();
    if (anchor?.selectedText) els.imageAltInput.value = anchor.selectedText;
    setModalOpen(els.imageUrlModal, true);
    requestAnimationFrame(() => els.imageUrlInput.focus());
  }

  function bindImageInsert() {
    els.imageBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (els.imageMenu.hidden) openImageMenu();
      else closeImageMenu(true);
    });
    els.imageMenu.addEventListener('click', (event) => event.stopPropagation());
    els.btnImageFile.addEventListener('click', () => {
      pendingImageInsertion = captureImageInsertion();
      closeImageMenu(false);
      els.imageFileOpen.value = '';
      els.imageFileOpen.click();
    });
    els.btnImageUrl.addEventListener('click', () => {
      const anchor = captureImageInsertion();
      closeImageMenu(false);
      openImageUrlModal(anchor);
    });
    els.imageFileOpen.addEventListener('change', async () => {
      const anchor = pendingImageInsertion;
      pendingImageInsertion = null;
      const files = [...els.imageFileOpen.files];
      els.imageFileOpen.value = '';
      if (files.length) await insertImageFiles(files, anchor);
    });
    els.imageUrlForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!insertImageUrl(els.imageUrlInput.value, els.imageAltInput.value, pendingImageInsertion)) {
        els.imageUrlInput.focus();
        return;
      }
      closeImageUrlModal(false);
    });
    els.btnImageUrlClose.addEventListener('click', () => closeImageUrlModal(true));
    els.btnImageUrlCancel.addEventListener('click', () => closeImageUrlModal(true));
    els.imageUrlModal.addEventListener('click', (event) => {
      if (event.target === els.imageUrlModal) closeImageUrlModal(true);
    });
    els.imageMenu.addEventListener('keydown', (event) => {
      const items = imageMenuItems();
      const index = items.indexOf(document.activeElement);
      let nextIndex = index;
      if (event.key === 'ArrowDown') nextIndex = (index + 1) % items.length;
      else if (event.key === 'ArrowUp') nextIndex = (index - 1 + items.length) % items.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = items.length - 1;
      else if (event.key === 'Escape') {
        event.preventDefault(); closeImageMenu(true); return;
      } else return;
      event.preventDefault();
      items[nextIndex]?.focus();
    });
    document.addEventListener('click', () => closeImageMenu(false));
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!els.imageMenu.hidden) { event.preventDefault(); closeImageMenu(true); }
      else if (!els.imageUrlModal.hidden) { event.preventDefault(); closeImageUrlModal(true); }
    });
    window.addEventListener('resize', positionImageMenu);
    window.addEventListener('scroll', positionImageMenu, true);
  }

  let tablePickerSelection = null;

  function tablePickerCells() {
    return [...els.tablePickerGrid.querySelectorAll('.table-picker__cell')];
  }

  function updateTablePicker(row, col) {
    const safeRow = Math.max(1, Math.min(TABLE_MAX_ROWS, Number(row) || 1));
    const safeCol = Math.max(1, Math.min(TABLE_MAX_COLS, Number(col) || 1));
    tablePickerSelection = { row: safeRow, col: safeCol };
    els.tablePickerStatus.textContent = safeRow === 1
      ? `1 × ${safeCol}（插入 2 × ${safeCol}）`
      : `${safeRow} × ${safeCol}`;
    tablePickerCells().forEach((cell) => {
      const selected = Number(cell.dataset.row) <= safeRow && Number(cell.dataset.col) <= safeCol;
      cell.classList.toggle('is-selected', selected);
      cell.setAttribute('aria-selected', selected ? 'true' : 'false');
      cell.tabIndex = Number(cell.dataset.row) === safeRow && Number(cell.dataset.col) === safeCol ? 0 : -1;
    });
  }

  function resetTablePicker() {
    tablePickerSelection = null;
    els.tablePickerStatus.textContent = '选择表格大小';
    tablePickerCells().forEach((cell, index) => {
      cell.classList.remove('is-selected');
      cell.setAttribute('aria-selected', 'false');
      cell.tabIndex = index === 0 ? 0 : -1;
    });
  }

  function positionTablePicker() {
    if (els.tablePicker.hidden) return;
    const buttonRect = els.tableBtn.getBoundingClientRect();
    const pickerRect = els.tablePicker.getBoundingClientRect();
    const gap = 4;
    const viewportGap = 8;
    const left = Math.min(
      Math.max(viewportGap, buttonRect.left),
      Math.max(viewportGap, window.innerWidth - pickerRect.width - viewportGap)
    );
    const below = buttonRect.bottom + gap;
    const top = below + pickerRect.height <= window.innerHeight - viewportGap
      ? below
      : Math.max(viewportGap, buttonRect.top - pickerRect.height - gap);
    els.tablePicker.style.left = `${Math.round(left)}px`;
    els.tablePicker.style.top = `${Math.round(top)}px`;
  }

  function openTablePicker() {
    resetTablePicker();
    els.headingMenu.hidden = true;
    closeExportMenu(false);
    closeImageMenu(false);
    els.tablePicker.hidden = false;
    els.tableBtn.setAttribute('aria-expanded', 'true');
    positionTablePicker();
    requestAnimationFrame(() => tablePickerCells()[0]?.focus());
  }

  function closeTablePicker(restoreFocus) {
    if (els.tablePicker.hidden) return;
    els.tablePicker.hidden = true;
    els.tableBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus !== false) els.tableBtn.focus();
  }

  function confirmTablePicker(row, col) {
    const selectedRows = Math.max(2, Number(row) || 1);
    const selectedCols = Math.max(1, Number(col) || 1);
    closeTablePicker(false);
    insertTable(selectedRows, selectedCols);
  }

  function buildTablePicker() {
    const fragment = document.createDocumentFragment();
    for (let row = 1; row <= TABLE_MAX_ROWS; row += 1) {
      for (let col = 1; col <= TABLE_MAX_COLS; col += 1) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'table-picker__cell';
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-selected', 'false');
        cell.setAttribute('aria-label', `${row} 行 ${col} 列${row === 1 ? '，将插入 2 行' : ''}`);
        cell.tabIndex = row === 1 && col === 1 ? 0 : -1;
        fragment.appendChild(cell);
      }
    }
    els.tablePickerGrid.appendChild(fragment);
  }

  function bindTablePicker() {
    buildTablePicker();
    els.tableBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (els.tablePicker.hidden) openTablePicker();
      else closeTablePicker(true);
    });
    els.tablePicker.addEventListener('click', (event) => {
      event.stopPropagation();
      const cell = event.target.closest('.table-picker__cell');
      if (cell) confirmTablePicker(cell.dataset.row, cell.dataset.col);
    });
    els.tablePickerGrid.addEventListener('pointerover', (event) => {
      const cell = event.target.closest('.table-picker__cell');
      if (cell) updateTablePicker(cell.dataset.row, cell.dataset.col);
    });
    els.tablePickerGrid.addEventListener('keydown', (event) => {
      const cell = event.target.closest('.table-picker__cell');
      if (!cell) return;
      let row = Number(cell.dataset.row);
      let col = Number(cell.dataset.col);
      if (event.key === 'ArrowUp') row -= 1;
      else if (event.key === 'ArrowDown') row += 1;
      else if (event.key === 'ArrowLeft') col -= 1;
      else if (event.key === 'ArrowRight') col += 1;
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        confirmTablePicker(tablePickerSelection?.row || row, tablePickerSelection?.col || col);
        return;
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeTablePicker(true);
        return;
      } else return;
      event.preventDefault();
      row = Math.max(1, Math.min(TABLE_MAX_ROWS, row));
      col = Math.max(1, Math.min(TABLE_MAX_COLS, col));
      updateTablePicker(row, col);
      tablePickerCells().find((item) => Number(item.dataset.row) === row && Number(item.dataset.col) === col)?.focus();
    });
    document.addEventListener('click', () => closeTablePicker(false));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !els.tablePicker.hidden) {
        event.preventDefault();
        closeTablePicker(true);
      }
    });
    window.addEventListener('resize', positionTablePicker);
    window.addEventListener('scroll', positionTablePicker, true);
  }

  function bindFmtbar() {
    els.fmtbar.querySelectorAll('.fmt-btn[data-fmt]').forEach((btn) => {
      btn.addEventListener('click', () => formatFromActiveEditor(btn.dataset.fmt));
    });
    els.headingBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeExportMenu(false);
      closeTablePicker(false);
      closeImageMenu(false);
      els.headingMenu.hidden = !els.headingMenu.hidden;
    });
    document.addEventListener('click', () => { els.headingMenu.hidden = true; });
    els.headingMenu.addEventListener('click', (e) => e.stopPropagation());
    els.headingMenu.querySelectorAll('.fmt-menu__item').forEach((item) => {
      item.addEventListener('click', () => { formatFromActiveEditor('heading', item.dataset.level); els.headingMenu.hidden = true; });
    });
    if (els.btnUndo) els.btnUndo.addEventListener('click', () => applyHistory(-1));
    if (els.btnRedo) els.btnRedo.addEventListener('click', () => applyHistory(1));
    if (els.btnSave) els.btnSave.addEventListener('click', () => { saveCurrentDocument(); });
    bindExportMenu();
  }

  function setViewMode(mode) {
    if (mode !== state.viewMode) flushPendingPreviewCommit();
    draftCommentAnchor = null;
    selectedPreviewBlock = null;
    state.viewMode = mode;
    els.editorContainer.dataset.view = mode;
    els.viewSeg.querySelectorAll('.ui-segmented-item').forEach((item) => {
      const active = item.dataset.view === mode;
      item.classList.toggle('is-active', active);
      const btn = item.querySelector('.ui-button');
      if (btn) btn.className = 'ui-button ui-button-sm ' + (active ? 'ui-button-secondary' : 'ui-button-light');
    });
    els.previewEditor.contentEditable = (mode === 'preview' || mode === 'split') ? 'true' : 'false';
    if (mode === 'split') requestAnimationFrame(() => renderSplitRatio(state.splitRatio));
    scheduleSave();
    updateStatus();
  }

  function bindViewSeg() {
    els.viewSeg.querySelectorAll('.ui-segmented-item').forEach((item) => {
      item.addEventListener('click', () => setViewMode(item.dataset.view));
    });
  }

  function splitRatioBounds() {
    const dividerWidth = els.splitResizer?.offsetWidth || 12;
    const availableWidth = Math.max(1, els.editorContainer.clientWidth - dividerWidth);
    const pixelMinimum = Math.min(SPLIT_PANE_MIN_PX, availableWidth / 2);
    const minimum = Math.max(SPLIT_RATIO_MIN, pixelMinimum / availableWidth);
    return { minimum, maximum: Math.min(SPLIT_RATIO_MAX, 1 - minimum), availableWidth };
  }

  function renderSplitRatio(ratio) {
    if (!els.splitResizer || !els.editorContainer) return 0.5;
    const bounds = splitRatioBounds();
    const applied = Math.max(bounds.minimum, Math.min(bounds.maximum, Number(ratio) || 0.5));
    const percent = Math.round(applied * 100);
    els.editorContainer.style.setProperty('--split-source-size', `${bounds.availableWidth * applied}px`);
    els.splitResizer.setAttribute('aria-valuemin', String(Math.round(bounds.minimum * 100)));
    els.splitResizer.setAttribute('aria-valuemax', String(Math.round(bounds.maximum * 100)));
    els.splitResizer.setAttribute('aria-valuenow', String(percent));
    els.splitResizer.setAttribute('aria-valuetext', `源码 ${percent}%，预览 ${100 - percent}%`);
    return applied;
  }

  function setSplitRatio(ratio, persist) {
    state.splitRatio = renderSplitRatio(ratio);
    if (persist) scheduleSave();
    return state.splitRatio;
  }

  function bindSplitResizer() {
    if (!els.splitResizer) return;
    let activePointerId = null;

    const resizeFromPointer = (clientX) => {
      const rect = els.editorContainer.getBoundingClientRect();
      const dividerWidth = els.splitResizer.offsetWidth || 12;
      const availableWidth = Math.max(1, rect.width - dividerWidth);
      setSplitRatio((clientX - rect.left - dividerWidth / 2) / availableWidth, false);
    };

    const finishResize = (event) => {
      if (activePointerId === null || (event.pointerId !== undefined && event.pointerId !== activePointerId)) return;
      activePointerId = null;
      els.splitResizer.classList.remove('is-dragging');
      document.documentElement.classList.remove('is-split-resizing');
      scheduleSave();
    };

    els.splitResizer.addEventListener('pointerdown', (event) => {
      if (state.viewMode !== 'split' || event.button !== 0) return;
      event.preventDefault();
      activePointerId = event.pointerId;
      els.splitResizer.classList.add('is-dragging');
      document.documentElement.classList.add('is-split-resizing');
      resizeFromPointer(event.clientX);
    });
    window.addEventListener('pointermove', (event) => {
      if (activePointerId !== event.pointerId) return;
      resizeFromPointer(event.clientX);
    });
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
    window.addEventListener('blur', finishResize);
    els.splitResizer.addEventListener('dblclick', () => setSplitRatio(0.5, true));
    els.splitResizer.addEventListener('keydown', (event) => {
      const bounds = splitRatioBounds();
      let next = state.splitRatio;
      if (event.key === 'ArrowLeft') next -= event.shiftKey ? 0.1 : SPLIT_KEY_STEP;
      else if (event.key === 'ArrowRight') next += event.shiftKey ? 0.1 : SPLIT_KEY_STEP;
      else if (event.key === 'Home') next = bounds.minimum;
      else if (event.key === 'End') next = bounds.maximum;
      else return;
      event.preventDefault();
      setSplitRatio(next, true);
    });
    window.addEventListener('resize', () => renderSplitRatio(state.splitRatio));
    renderSplitRatio(state.splitRatio);
  }

  function applyTheme(theme) {
    state.theme = theme;
    const isDark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    els.themeBtn.title = isDark ? '切换到亮色主题' : '切换到暗色主题';
    els.themeBtn.setAttribute('aria-label', els.themeBtn.title);
    scheduleSave();
  }

  function toggleTheme() { applyTheme(state.theme === 'dark' ? 'light' : 'dark'); }

  function iconSvg(name) {
    return `<svg viewBox="0 0 16 16" focusable="false"><use href="#gicon-${name}"></use></svg>`;
  }

  function iconTemplate(name) {
    return `<span class="ui-icon gicon" aria-hidden="true">${iconSvg(name)}</span>`;
  }

  function installFunctionalIcons() {
    const iconMap = [
      ['#btn-new-doc > .ui-icon', 'new-doc'],
      ['#btn-open-doc > .ui-icon', 'open-doc'],
      ['#open-doc-info .ui-icon', 'info'],
      ['#btn-add-directory .ui-icon', 'folder-plus'],
      ['#btn-refresh-directories .ui-icon', 'refresh'],
      ['#btn-toggle-all-docs .ui-icon', 'collapse-all'],
      ['#btn-undo .ui-icon', 'undo'],
      ['#btn-redo .ui-icon', 'redo'],
      ['#btn-heading .fmt-btn__caret', 'chevron-down'],
      ['[data-fmt="bold"] .ui-icon', 'bold'],
      ['[data-fmt="italic"] .ui-icon', 'italic'],
      ['[data-fmt="strike"] .ui-icon', 'strike'],
      ['[data-fmt="link"] .ui-icon', 'link'],
      ['[data-fmt="codeblock"] .ui-icon', 'code-block'],
      ['[data-fmt="inlinecode"] .ui-icon', 'inline-code'],
      ['[data-fmt="ul"] .ui-icon', 'list-ul'],
      ['[data-fmt="ol"] .ui-icon', 'list-ol'],
      ['[data-fmt="task"] .ui-icon', 'task'],
      ['#btn-table .ui-icon', 'table'],
      ['#btn-image .ui-icon', 'image'],
      ['#btn-image-file .ui-icon', 'image'],
      ['#btn-image-url .ui-icon', 'link'],
      ['[data-fmt="quote"] .ui-icon', 'quote'],
      ['[data-fmt="hr"] .ui-icon', 'divider'],
      ['#btn-comments .ui-icon', 'review'],
      ['#btn-save .ui-icon', 'save'],
      ['#btn-export .ui-icon', 'export'],
      ['#btn-md .ui-icon', 'markdown'],
      ['#btn-pdf .ui-icon', 'pdf'],
      ['#btn-img .ui-icon', 'image'],
      ['#btn-theme .theme-icon--moon', 'moon'],
      ['#btn-theme .theme-icon--sun', 'sun'],
      ['#btn-model-settings .ui-icon', 'settings'],
      ['#btn-directory-add .ui-icon', 'folder-plus']
    ];
    iconMap.forEach(([selector, name]) => {
      const target = document.querySelector(selector);
      if (!target) return;
      target.classList.add('gicon');
      target.innerHTML = iconSvg(name);
    });
    document.querySelectorAll('.app-modal__close').forEach((button) => {
      button.innerHTML = iconTemplate('close');
    });
    document.body.classList.add('gicons-ready');
  }

  const ICON_RENAME = iconTemplate('rename');
  const ICON_DELETE = iconTemplate('delete');
  const ICON_CONFIRM = iconTemplate('confirm');
  const ICON_CANCEL = iconTemplate('cancel');
  const ICON_FOLDER = iconTemplate('folder');
  const ICON_REFRESH = iconTemplate('refresh');

  function createTreeRoot(label, count, collapsed, action, dataset, subtitle) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-tree-root';
    button.dataset.action = action;
    Object.entries(dataset || {}).forEach(([key, value]) => { button.dataset[key] = value; });
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const caret = document.createElement('span');
    caret.className = 'app-tree-caret';
    caret.innerHTML = collapsed ? iconTemplate('chevron-right') : iconTemplate('chevron-down');
    const folder = document.createElement('span');
    folder.className = 'app-tree-folder';
    folder.innerHTML = ICON_FOLDER;
    const text = document.createElement('span');
    text.className = 'app-tree-root__text';
    const main = document.createElement('span');
    main.textContent = label;
    text.appendChild(main);
    if (subtitle) {
      const small = document.createElement('small');
      small.textContent = subtitle;
      text.appendChild(small);
    }
    const badge = document.createElement('span');
    badge.className = 'app-tree-count';
    badge.textContent = String(count);
    button.append(caret, folder, text, badge);
    return button;
  }

  // ── 文档搜索：最近文档、关键词与桌面端本地语义检索 ──
  function semanticSearchApi() {
    const api = window.guanyiDesktop?.semantic;
    return api && typeof api.status === 'function' && typeof api.indexDocuments === 'function' && typeof api.search === 'function'
      ? api
      : null;
  }

  function searchPathForDoc(doc) {
    if (isDirectoryDoc(doc)) {
      const directory = directoryForDoc(doc);
      return [directory?.name || '本地目录', doc.relativePath || doc.localFileName || doc.name].filter(Boolean).join('/');
    }
    if (isLocalFileDoc(doc)) return doc.localFileName || doc.name;
    return '我的文档';
  }

  function searchTokens(query) {
    return [...new Set(String(query || '').trim().toLowerCase().split(/[\s,，。；;、/\\：:]+/).filter(Boolean))];
  }

  const SEMANTIC_QUERY_STOP_TERMS = new Set([
    '什么', '怎么', '如何', '为何', '为什么', '哪里', '哪儿', '哪个', '哪些',
    '是谁', '谁的', '是否', '是不是', '有没有', '请问', '一下'
  ]);

  function semanticQueryFragments(query) {
    const value = String(query || '').trim().toLowerCase();
    const terms = new Set(searchTokens(value));
    for (const sequence of value.match(/[\u3400-\u9fff]+/g) || []) {
      const maximum = Math.min(6, sequence.length);
      for (let length = maximum; length >= 2; length -= 1) {
        for (let start = 0; start + length <= sequence.length; start += 1) {
          terms.add(sequence.slice(start, start + length));
        }
      }
    }
    return [...terms].filter((term) => term.length >= 2 && !SEMANTIC_QUERY_STOP_TERMS.has(term));
  }

  function resultHighlightTerms(query, result) {
    const literalTerms = searchTokens(query);
    if (!result?.fields?.includes('semantic')) return literalTerms;
    const visibleText = [result.title, result.path, result.section, result.snippet].filter(Boolean).join('\n').toLowerCase();
    const semanticTerms = [
      ...(Array.isArray(result.highlightTerms) ? result.highlightTerms : []),
      ...semanticQueryFragments(query).filter((term) => visibleText.includes(term))
    ];
    return [...new Set([...literalTerms, ...semanticTerms].filter(Boolean))];
  }

  function searchSnippet(content, start, end) {
    if (!content || start < 0) return '';
    const left = Math.max(0, start - 68);
    const right = Math.min(content.length, Math.max(end + 110, start + 150));
    return `${left ? '…' : ''}${content.slice(left, right).replace(/\s+/g, ' ').trim()}${right < content.length ? '…' : ''}`;
  }

  function searchSentenceBounds(content, matchStart, matchEnd) {
    if (!content || matchStart < 0) return { start: -1, end: -1 };
    const exact = sentenceRangesForSearch(content).find((range) => range.start <= matchStart && range.end >= matchEnd);
    if (exact) return exact;
    const lineStart = Math.max(0, content.lastIndexOf('\n', matchStart - 1) + 1);
    const nextNewline = content.indexOf('\n', matchEnd);
    return { start: lineStart, end: nextNewline < 0 ? content.length : nextNewline };
  }

  function formatSearchRecency(timestamp) {
    const time = Number(timestamp) || 0;
    if (!time) return '尚未打开';
    const distance = Date.now() - time;
    if (distance < 60 * 1000) return '刚刚打开';
    if (distance < 60 * 60 * 1000) return `${Math.max(1, Math.floor(distance / 60000))} 分钟前打开`;
    if (distance < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.floor(distance / 3600000))} 小时前打开`;
    try { return `${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(time))} 打开`; }
    catch (_error) { return '最近打开'; }
  }

  function appendHighlightedText(parent, text, tokens) {
    const value = String(text || '');
    const terms = [...new Set((tokens || []).filter(Boolean))].sort((a, b) => b.length - a.length);
    if (!terms.length) { parent.textContent = value; return; }
    const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const expression = new RegExp(escaped.join('|'), 'ig');
    let cursor = 0, match;
    while ((match = expression.exec(value))) {
      if (match.index > cursor) parent.appendChild(document.createTextNode(value.slice(cursor, match.index)));
      const mark = document.createElement('mark');
      mark.textContent = match[0];
      parent.appendChild(mark);
      cursor = match.index + match[0].length;
    }
    if (cursor < value.length) parent.appendChild(document.createTextNode(value.slice(cursor)));
  }

  async function contentForSearch(doc) {
    if (doc.contentLoaded !== false) return typeof doc.content === 'string' ? doc.content : '';
    if (!isDirectoryDoc(doc) || !doc.fileHandle) return typeof doc.content === 'string' ? doc.content : '';
    const directory = directoryForDoc(doc);
    if (!directory?.handle || await queryReadWritePermission(directory.handle) !== 'granted') return '';
    try {
      const file = await doc.fileHandle.getFile();
      if (file.size > DIRECTORY_MAX_FILE_SIZE) return '';
      const content = await readFileAsText(file);
      doc.content = content;
      doc.lastSavedContent = content;
      doc.contentLoaded = true;
      doc.externalModifiedAt = file.lastModified;
      doc.externalSize = file.size;
      histories.set(doc.id, { entries: [content], index: 0, lastInputAt: 0, lastInputSource: null });
      markSemanticIndexDirty(doc.id);
      return content;
    } catch (_error) {
      return '';
    }
  }

  function recentSearchResults() {
    return [...state.docs]
      .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
      .slice(0, 10)
      .map((doc) => ({
        docId: doc.id,
        title: doc.name,
        path: searchPathForDoc(doc),
        snippet: formatSearchRecency(doc.lastOpenedAt),
        fields: ['recent'],
        start: -1,
        end: -1,
        score: Number(doc.lastOpenedAt) || 0
      }));
  }

  async function keywordSearchDocuments(query, token) {
    const normalizedQuery = query.trim().toLowerCase();
    const tokens = searchTokens(query);
    const results = [];
    let loadedContent = false;
    for (let index = 0; index < state.docs.length; index += 1) {
      if (token !== searchRunToken) return null;
      const doc = state.docs[index];
      const title = String(doc.name || '');
      const docPath = searchPathForDoc(doc);
      const titleLower = title.toLowerCase();
      const pathLower = docPath.toLowerCase();
      const wasLoaded = doc.contentLoaded !== false;
      const content = await contentForSearch(doc);
      if (!wasLoaded && doc.contentLoaded !== false) loadedContent = true;
      const contentLower = content.toLowerCase();
      const combined = `${titleLower}\n${pathLower}\n${contentLower}`;
      if (!tokens.length || !tokens.every((term) => combined.includes(term))) continue;

      const titleMatch = tokens.some((term) => titleLower.includes(term));
      const pathMatch = tokens.some((term) => pathLower.includes(term));
      const contentMatch = tokens.some((term) => contentLower.includes(term));
      const phraseInTitle = normalizedQuery && titleLower.includes(normalizedQuery);
      const phraseInPath = normalizedQuery && pathLower.includes(normalizedQuery);
      const phraseInContent = normalizedQuery && contentLower.includes(normalizedQuery);
      const matchedTerm = phraseInContent ? normalizedQuery : tokens.find((term) => contentLower.includes(term));
      const matchedStart = matchedTerm ? contentLower.indexOf(matchedTerm) : -1;
      const matchedEnd = matchedStart >= 0 ? matchedStart + matchedTerm.length : -1;
      const sentenceBounds = searchSentenceBounds(content, matchedStart, matchedEnd);
      const start = sentenceBounds.start;
      const end = sentenceBounds.end;
      const fields = [];
      if (titleMatch) fields.push('name');
      if (pathMatch) fields.push('path');
      if (contentMatch) fields.push('content');
      const score = (phraseInTitle ? 140 : titleMatch ? 80 : 0)
        + (phraseInPath ? 90 : pathMatch ? 45 : 0)
        + (phraseInContent ? 65 : contentMatch ? 30 : 0)
        + Math.min(12, (Number(doc.lastOpenedAt) || 0) / Math.max(1, Date.now()) * 12);
      results.push({
        docId: doc.id,
        title,
        path: docPath,
        snippet: start >= 0 ? content.slice(start, end).replace(/\s+/g, ' ').trim() : '',
        quote: start >= 0 ? content.slice(start, end) : '',
        fields,
        start,
        end,
        score
      });
      if (index % 18 === 17) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (loadedContent) saveState({ silent: true });
    return results.sort((a, b) => b.score - a.score).slice(0, SEARCH_RESULT_LIMIT);
  }

  function plainTextSectionHeading(line) {
    const value = String(line || '').trim();
    if (!value || value.length > 96) return '';
    if (/^第[〇零一二三四五六七八九十百千万两\d]+(?:回|章|节|卷|篇)(?:[\s　:：.-]*.*)?$/.test(value)) return value;
    if (/^卷[〇零一二三四五六七八九十百千万两\d]+(?:[\s　:：.-]+.*)?$/.test(value)) return value;
    if (/^[上中下]卷(?:[\s　:：.-]+.*)?$/.test(value)) return value;
    return '';
  }

  function plainTextHeadingKind(line) {
    const heading = plainTextSectionHeading(line);
    if (!heading) return '';
    return /^第[〇零一二三四五六七八九十百千万两\d]+节/.test(heading) ? 'section' : 'chapter';
  }

  function sentenceRangesForSearch(text) {
    const source = String(text || '');
    const ranges = [];
    const expression = /[^。！？!?；;\n]+(?:[。！？!?；;]+[”’」』》）】〕〗〙〛〞〟"']*)?/g;
    let match;
    while ((match = expression.exec(source))) {
      const leading = match[0].search(/\S/);
      if (leading < 0) continue;
      const trailing = match[0].match(/\s*$/)?.[0].length || 0;
      const start = match.index + leading;
      const end = match.index + match[0].length - trailing;
      for (let pieceStart = start; pieceStart < end; pieceStart += SEMANTIC_SENTENCE_MAX_LENGTH) {
        ranges.push({ start: pieceStart, end: Math.min(end, pieceStart + SEMANTIC_SENTENCE_MAX_LENGTH) });
      }
    }
    return ranges;
  }

  function chunkMarkdownForSearch(markdown) {
    const content = String(markdown || '').replace(/\r\n?/g, '\n');
    if (!content.trim()) return [];
    const headings = [];
    const paragraphs = [];
    const chapterDefinitions = new Map();
    const sectionDefinitions = new Map();
    let currentChapter = { id: 'chapter-root', title: '', start: 0 };
    let currentSection = null;
    let chapterSequence = 0, sectionSequence = 0, paragraphSequence = 0, sentenceSequence = 0;
    let paragraphStart = -1, paragraphEnd = -1, offset = 0;

    function headingPath() {
      return [currentChapter.title, currentSection?.title].filter(Boolean).join(' / ');
    }

    function flushParagraph() {
      if (paragraphStart < 0) return;
      const raw = content.slice(paragraphStart, paragraphEnd);
      const leading = raw.search(/\S/);
      const trailing = raw.match(/\s*$/)?.[0].length || 0;
      if (leading >= 0) {
        const start = paragraphStart + leading;
        const end = paragraphEnd - trailing;
        const body = content.slice(start, end);
        if (body) paragraphs.push({
          id: `paragraph-${++paragraphSequence}`,
          body,
          start,
          end,
          heading: headingPath(),
          chapter: currentChapter.title,
          section: currentSection?.title || '',
          chapterId: currentChapter.id,
          sectionId: currentSection?.id || ''
        });
      }
      paragraphStart = -1;
      paragraphEnd = -1;
    }

    function beginChapter(title, start) {
      const chapter = { id: `chapter-${++chapterSequence}`, title, start };
      chapterDefinitions.set(chapter.id, chapter);
      currentChapter = chapter;
      currentSection = null;
    }

    function beginSection(title, start) {
      const section = {
        id: `section-${++sectionSequence}`,
        title,
        start,
        chapterId: currentChapter.id,
        chapter: currentChapter.title
      };
      sectionDefinitions.set(section.id, section);
      currentSection = section;
    }

    content.split('\n').forEach((line) => {
      const lineStart = offset;
      const lineEnd = lineStart + line.length;
      offset = lineEnd + 1;
      const markdownHeading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      const textHeading = markdownHeading ? '' : plainTextSectionHeading(line);
      const textHeadingKind = textHeading ? plainTextHeadingKind(textHeading) : '';
      if (markdownHeading || textHeading) {
        flushParagraph();
        if (markdownHeading) {
          const level = markdownHeading[1].length;
          headings.length = level - 1;
          headings[level - 1] = markdownHeading[2].replace(/\s+#+\s*$/, '');
          if (level === 1) beginChapter(headings[0], lineStart);
          else beginSection(headings.slice(1).filter(Boolean).join(' / '), lineStart);
        } else if (textHeadingKind === 'chapter') {
          headings.length = 0;
          headings[0] = textHeading;
          beginChapter(textHeading, lineStart);
        } else {
          headings.length = 1;
          headings[1] = textHeading;
          beginSection(textHeading, lineStart);
        }
        return;
      }
      if (!line.trim()) { flushParagraph(); return; }
      if (paragraphStart < 0) paragraphStart = lineStart;
      paragraphEnd = lineEnd;
    });
    flushParagraph();
    if (!paragraphs.length) return [];

    const sentenceUnits = [];
    const paragraphUnits = [];
    for (const paragraph of paragraphs) {
      const ranges = sentenceRangesForSearch(paragraph.body);
      const sentences = ranges.map((range) => ({
        id: `sentence-${++sentenceSequence}`,
        start: paragraph.start + range.start,
        end: paragraph.start + range.end,
        text: paragraph.body.slice(range.start, range.end)
      }));
      if (!sentences.length) continue;
      sentences.forEach((sentence, index) => {
        const context = [sentences[index - 1]?.text, sentence.text, sentences[index + 1]?.text].filter(Boolean).join('\n');
        sentenceUnits.push({
          unitId: sentence.id,
          sentenceId: sentence.id,
          paragraphId: paragraph.id,
          sectionId: paragraph.sectionId,
          chapterId: paragraph.chapterId,
          granularity: 'sentence',
          start: sentence.start,
          end: sentence.end,
          text: sentence.text,
          semanticText: [paragraph.heading, context].filter(Boolean).join('\n'),
          snippet: sentence.text,
          heading: paragraph.heading,
          chapter: paragraph.chapter,
          section: paragraph.section ? [paragraph.chapter, paragraph.section].filter(Boolean).join(' / ') : ''
        });
      });
      paragraphUnits.push({
        unitId: paragraph.id,
        sentenceId: '',
        paragraphId: paragraph.id,
        sectionId: paragraph.sectionId,
        chapterId: paragraph.chapterId,
        granularity: 'paragraph',
        start: paragraph.start,
        end: paragraph.end,
        text: paragraph.body,
        semanticText: [paragraph.heading, paragraph.body].filter(Boolean).join('\n'),
        snippet: paragraph.body,
        heading: paragraph.heading,
        chapter: paragraph.chapter,
        section: paragraph.section ? [paragraph.chapter, paragraph.section].filter(Boolean).join(' / ') : ''
      });
    }

    const parentUnit = (definition, granularity, groupedParagraphs) => {
      const start = Math.min(...groupedParagraphs.map((paragraph) => paragraph.start));
      const end = Math.max(...groupedParagraphs.map((paragraph) => paragraph.end));
      const chapter = granularity === 'chapter' ? definition.title : definition.chapter;
      const section = granularity === 'section' ? [definition.chapter, definition.title].filter(Boolean).join(' / ') : '';
      const heading = granularity === 'chapter' ? definition.title : section;
      return {
        unitId: definition.id,
        sentenceId: '',
        paragraphId: '',
        sectionId: granularity === 'section' ? definition.id : '',
        chapterId: granularity === 'chapter' ? definition.id : definition.chapterId,
        granularity,
        start,
        end,
        text: definition.title || heading || '正文',
        semanticText: heading,
        snippet: groupedParagraphs.map((paragraph) => paragraph.body).join(' ').slice(0, 1200),
        heading,
        chapter,
        section
      };
    };
    const sectionUnits = [...sectionDefinitions.values()].flatMap((definition) => {
      const grouped = paragraphs.filter((paragraph) => paragraph.sectionId === definition.id);
      return grouped.length ? [parentUnit(definition, 'section', grouped)] : [];
    });
    const chapterIds = new Set(paragraphs.map((paragraph) => paragraph.chapterId));
    if (chapterIds.has('chapter-root')) chapterDefinitions.set('chapter-root', currentChapter.id === 'chapter-root' ? currentChapter : { id: 'chapter-root', title: '', start: 0 });
    const chapterUnits = [...chapterDefinitions.values()].flatMap((definition) => {
      const grouped = paragraphs.filter((paragraph) => paragraph.chapterId === definition.id);
      return grouped.length ? [parentUnit(definition, 'chapter', grouped)] : [];
    });
    return [...sentenceUnits, ...paragraphUnits, ...sectionUnits, ...chapterUnits].slice(0, SEMANTIC_MAX_UNITS_PER_DOCUMENT);
  }

  function markSemanticIndexDirty(docId) {
    if (docId) semanticDocumentCache.delete(docId);
    semanticIndexRevision += 1;
    scheduleSemanticIndexSync();
  }

  function buildSemanticDocument(doc, content) {
    const docPath = searchPathForDoc(doc);
    const fingerprint = contentFingerprint(`${doc.id}\n${doc.name}\n${docPath}\n${content}`);
    const cached = semanticDocumentCache.get(doc.id);
    if (cached?.fingerprint === fingerprint) return cached.document;
    const units = chunkMarkdownForSearch(content).map((unit) => ({
      ...unit,
      semanticText: `${doc.name}\n${docPath}\n${unit.semanticText}`.slice(0, 1600)
    }));
    if (!units.length) return null;
    const document = { id: doc.id, fingerprint, title: doc.name, path: docPath, units };
    semanticDocumentCache.set(doc.id, { fingerprint, document });
    return document;
  }

  async function directorySearchPermissionMissing(doc) {
    if (!isDirectoryDoc(doc) || doc.contentLoaded !== false) return false;
    const directory = directoryForDoc(doc);
    return !directory?.handle || await queryReadWritePermission(directory.handle) !== 'granted';
  }

  async function semanticDocumentsForIndex(token) {
    const documents = [];
    let loadedContent = false;
    for (let index = 0; index < state.docs.length; index += 1) {
      if (token !== undefined && token !== searchRunToken) return null;
      const doc = state.docs[index];
      if (doc.syncState === 'missing' || await directorySearchPermissionMissing(doc)) continue;
      const wasLoaded = doc.contentLoaded !== false;
      const content = await contentForSearch(doc);
      if (!wasLoaded && doc.contentLoaded !== false) loadedContent = true;
      if (!content.trim()) continue;
      const document = buildSemanticDocument(doc, content);
      if (document) documents.push(document);
      if (index % 12 === 11) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (loadedContent) saveState({ silent: true });
    return documents;
  }

  async function synchronizeSemanticIndexOnce(api) {
    const initialStatus = await api.status();
    if (!initialStatus?.available) throw new Error(initialStatus?.unavailableReason || '本地语义搜索组件不可用');
    const indexedFingerprints = initialStatus.indexedDocumentFingerprints || {};
    const activeDocumentIds = [];
    const permissionDirectoryIds = new Set();
    let indexed = 0, reused = 0, loadedContent = false;

    for (let index = 0; index < state.docs.length; index += 1) {
      const doc = state.docs[index];
      if (doc.syncState === 'missing') continue;
      if (await directorySearchPermissionMissing(doc)) {
        if (indexedFingerprints[doc.id]) activeDocumentIds.push(doc.id);
        if (doc.directoryId) permissionDirectoryIds.add(doc.directoryId);
        continue;
      }
      const wasLoaded = doc.contentLoaded !== false;
      const content = await contentForSearch(doc);
      if (!wasLoaded && doc.contentLoaded !== false) loadedContent = true;
      if (!content.trim()) continue;
      const docPath = searchPathForDoc(doc);
      const fingerprint = contentFingerprint(`${doc.id}\n${doc.name}\n${docPath}\n${content}`);
      activeDocumentIds.push(doc.id);
      if (indexedFingerprints[doc.id] === fingerprint) {
        reused += 1;
        continue;
      }
      const document = buildSemanticDocument(doc, content);
      if (!document) continue;
      await api.indexDocuments([document], { force: false, prune: false });
      indexed += 1;
      if (index % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const status = await api.indexDocuments([], { activeDocumentIds, prune: true });
    if (loadedContent) saveState({ silent: true });
    return {
      status,
      indexed,
      reused,
      permissionDirectoryCount: permissionDirectoryIds.size
    };
  }

  function ensureSemanticIndexSynced() {
    const api = semanticSearchApi();
    if (!api) return Promise.reject(new Error('当前环境未连接桌面语义搜索服务'));
    if (semanticIndexSyncPromise) return semanticIndexSyncPromise;
    if (semanticIndexSyncSummary && semanticIndexSyncedRevision === semanticIndexRevision) {
      return Promise.resolve(semanticIndexSyncSummary);
    }
    const revision = semanticIndexRevision;
    semanticIndexSyncPromise = synchronizeSemanticIndexOnce(api).then((summary) => {
      semanticIndexSyncSummary = summary;
      semanticIndexSyncedRevision = revision;
      return summary;
    }).finally(() => {
      semanticIndexSyncPromise = null;
    });
    return semanticIndexSyncPromise;
  }

  function scheduleSemanticIndexSync(delay = 2400) {
    clearTimeout(semanticIndexSyncTimer);
    if (!semanticSearchApi()) return;
    semanticIndexSyncTimer = setTimeout(() => {
      let synchronized = false;
      ensureSemanticIndexSynced().then(() => {
        synchronized = true;
      }).catch((error) => {
        console.warn('后台同步本地语义索引失败', error);
      }).finally(() => {
        if (synchronized && semanticIndexSyncedRevision !== semanticIndexRevision) scheduleSemanticIndexSync(400);
      });
    }, delay);
  }

  function searchFieldLabel(field, result) {
    if (field === 'recent') return '最近';
    if (field === 'name') return '文件名';
    if (field === 'path') return '目录';
    if (field === 'content') return '正文';
    if (field === 'semantic') return '相关';
    return field;
  }

  function semanticGranularityLabel(granularity) {
    const labels = {
      sentence: '句子',
      paragraph: '段落',
      passage: '多段',
      section: '小节',
      chapter: '章节',
      document: '整书'
    };
    return labels[granularity] || '';
  }

  function renderSearchResults(results, options = {}) {
    activeSearchResults = Array.isArray(results) ? results : [];
    activeSearchResultIndex = activeSearchResults.length ? 0 : -1;
    activeSearchQuery = options.query || '';
    els.searchSummaryTitle.textContent = options.title || (options.query ? '搜索结果' : '最近文档');
    els.searchSummaryStatus.textContent = options.status || (activeSearchResults.length ? `${activeSearchResults.length} 项` : '');
    els.searchResults.replaceChildren();
    if (!activeSearchResults.length) {
      const empty = document.createElement('div');
      empty.className = 'app-search-empty';
      empty.textContent = options.empty || (options.query ? '没有找到匹配的文档' : '暂无最近文档');
      els.searchResults.appendChild(empty);
      return;
    }
    activeSearchResults.forEach((result, index) => {
      const tokens = resultHighlightTerms(options.query || '', result);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `app-search-result${index === activeSearchResultIndex ? ' is-active' : ''}`;
      button.dataset.searchResultIndex = String(index);
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === activeSearchResultIndex));
      const main = document.createElement('span');
      main.className = 'app-search-result__main';
      const title = document.createElement('span');
      title.className = 'app-search-result__title';
      appendHighlightedText(title, result.title, tokens);
      const path = document.createElement('span');
      path.className = 'app-search-result__path';
      appendHighlightedText(path, result.path, tokens);
      main.append(title, path);
      if (result.section) {
        const section = document.createElement('span');
        section.className = 'app-search-result__section';
        appendHighlightedText(section, result.section, tokens);
        main.appendChild(section);
      }
      if (result.snippet) {
        const snippet = document.createElement('span');
        const semanticOnly = result.fields?.includes('semantic') && !(result.highlightTerms || []).length;
        snippet.className = `app-search-result__snippet${semanticOnly ? ' is-semantic-evidence' : ''}`;
        appendHighlightedText(snippet, result.snippet, tokens);
        main.appendChild(snippet);
      }
      const meta = document.createElement('span');
      meta.className = 'app-search-result__meta';
      (result.fields || []).slice(0, 3).forEach((field) => {
        const tag = document.createElement('span');
        tag.className = `app-search-result__tag${field === 'semantic' ? ' is-semantic' : ''}`;
        tag.textContent = searchFieldLabel(field, result);
        meta.appendChild(tag);
      });
      const granularity = semanticGranularityLabel(result.matchedGranularity || result.granularity);
      if (granularity) {
        const tag = document.createElement('span');
        tag.className = 'app-search-result__tag app-search-result__tag--granularity';
        tag.textContent = granularity;
        meta.appendChild(tag);
      }
      button.append(main, meta);
      els.searchResults.appendChild(button);
    });
  }

  function selectSearchResult(index, focus) {
    const buttons = [...els.searchResults.querySelectorAll('.app-search-result')];
    if (!buttons.length) return;
    activeSearchResultIndex = (index + buttons.length) % buttons.length;
    buttons.forEach((button, buttonIndex) => {
      const selected = buttonIndex === activeSearchResultIndex;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-selected', String(selected));
      if (selected) button.scrollIntoView({ block: 'nearest' });
    });
    if (focus) buttons[activeSearchResultIndex].focus();
  }

  function handleSemanticProgress(progress) {
    if (!els.searchModal || els.searchModal.hidden || !els.searchInput.value.trim()) return;
    if (progress?.phase === 'ready') return;
    els.semanticSearchStatus.textContent = progress?.message || '正在补充相关内容…';
  }

  function semanticSearchFailureText(error) {
    let message = String(error?.message || error || '').trim();
    message = message.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '');
    if (!message) return '语义搜索暂不可用，普通搜索仍可使用';
    if (/尚未建立本地语义索引/.test(message)) return '语义索引尚未建立，请刷新目录后重试';
    if (/permission|权限|授权/i.test(message)) return '部分目录需要重新授权，当前仅搜索可读取内容';
    if (/Meilisearch.*启动|listen|ECONNREFUSED|搜索服务缺失/i.test(message)) return '本地搜索服务启动失败，普通搜索仍可使用';
    if (/模型.*缺失|模型校验失败|语义模型.*不可用/i.test(message)) return '本地语义模型不可用，请重新安装观绎 MD';
    return `语义搜索暂不可用：${message.slice(0, 72)}`;
  }

  function mergeSearchResults(keywordResults, semanticResults) {
    const merged = new Map();
    [...keywordResults, ...semanticResults].forEach((result) => {
      const key = `${result.docId}:${Number(result.start) || 0}:${Number(result.end) || 0}`;
      const previous = merged.get(key);
      if (!previous) {
        merged.set(key, result);
        return;
      }
      merged.set(key, {
        ...previous,
        ...result,
        fields: [...new Set([...(previous.fields || []), ...(result.fields || [])])],
        highlightTerms: [...new Set([...(previous.highlightTerms || []), ...(result.highlightTerms || [])])],
        score: Math.max(Number(previous.score) || 0, Number(result.score) || 0)
      });
    });
    return [...merged.values()].slice(0, SEARCH_RESULT_LIMIT);
  }

  async function runUnifiedSearch(query, token) {
    els.searchSummaryTitle.textContent = '搜索结果';
    els.searchSummaryStatus.textContent = '正在匹配文件与正文…';
    const keywordResults = await keywordSearchDocuments(query, token);
    if (!keywordResults || token !== searchRunToken) return;
    renderSearchResults(keywordResults, {
      title: '搜索结果',
      status: `${keywordResults.length} 项`,
      query,
      empty: semanticSearchApi() ? '正在查找相关内容…' : '没有找到相关文档或内容'
    });
    const api = semanticSearchApi();
    if (!api) {
      els.semanticSearchStatus.textContent = '普通搜索已完成；桌面版可补充本地语义结果';
      return;
    }
    els.semanticSearchStatus.textContent = '正在同步本地语义索引…';
    try {
      const syncSummary = await ensureSemanticIndexSynced();
      if (token !== searchRunToken) return;
      const matches = await api.search(query, SEMANTIC_RESULT_LIMIT);
      if (token !== searchRunToken) return;
      const semanticResults = matches.map((match) => {
        const doc = state.docs.find((item) => item.id === match.docId);
        return doc ? {
          docId: doc.id,
          title: doc.name,
          path: searchPathForDoc(doc),
          snippet: match.snippet || '',
          section: match.heading || '',
          quote: '',
          highlightTerms: Array.isArray(match.highlightTerms) ? match.highlightTerms : [],
          granularity: match.granularity || 'passage',
          matchedGranularity: match.matchedGranularity || match.granularity || 'passage',
          fields: Array.isArray(match.fields) && match.fields.length ? match.fields : ['semantic'],
          start: Number(match.start) || 0,
          end: Number(match.end) || 0,
          score: Number(match.score) || 0
        } : null;
      }).filter(Boolean);
      const results = mergeSearchResults(keywordResults, semanticResults);
      renderSearchResults(results, {
        title: '搜索结果',
        status: `${results.length} 项`,
        query,
        empty: '没有找到相关文档或内容'
      });
      els.semanticSearchStatus.textContent = syncSummary.permissionDirectoryCount
        ? `已完成本地搜索 · ${syncSummary.permissionDirectoryCount} 个目录需授权后更新索引`
        : '已完成本地搜索';
    } catch (error) {
      console.warn('本地相关内容检索暂不可用，保留精确匹配结果', error);
      if (token !== searchRunToken) return;
      els.semanticSearchStatus.textContent = semanticSearchFailureText(error);
      if (!keywordResults.length) {
        renderSearchResults([], { title: '搜索结果', status: '0 项', query, empty: '没有找到相关文档或内容' });
      }
    }
  }

  function runDocumentSearch() {
    clearTimeout(searchTimer);
    const token = ++searchRunToken;
    const query = els.searchInput.value.trim();
    if (!query) {
      const recent = recentSearchResults();
      renderSearchResults(recent, { title: '最近文档', status: recent.length ? `${recent.length} 项` : '' });
      els.semanticSearchStatus.textContent = '搜索范围：已添加文档';
      return;
    }
    runUnifiedSearch(query, token);
  }

  function scheduleDocumentSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runDocumentSearch, SEARCH_DEBOUNCE);
  }

  function openSearchModal() {
    searchModalPreviousFocus = document.activeElement;
    els.searchInput.value = '';
    setModalOpen(els.searchModal, true);
    els.btnSearchDocs.setAttribute('aria-expanded', 'true');
    runDocumentSearch();
    requestAnimationFrame(() => els.searchInput.focus());
  }

  function closeSearchModal() {
    clearTimeout(searchTimer);
    searchRunToken += 1;
    setModalOpen(els.searchModal, false);
    els.btnSearchDocs.setAttribute('aria-expanded', 'false');
    if (searchModalPreviousFocus?.focus) searchModalPreviousFocus.focus();
  }

  function normalizedSearchTerms(terms) {
    const seen = new Set();
    return (Array.isArray(terms) ? terms : [])
      .map((term) => String(term || '').trim())
      .filter((term) => {
        const key = term.toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.length - a.length);
  }

  function resolveSearchSourceRange(markdown, rawStart, rawEnd, terms) {
    const content = String(markdown || '');
    const anchorStart = Math.max(0, Math.min(content.length, Number(rawStart) || 0));
    const anchorEnd = Math.max(anchorStart, Math.min(content.length, Number(rawEnd) || anchorStart));
    const scanEnd = Math.min(content.length, Math.max(anchorEnd, anchorStart + 240));
    const scanText = content.slice(anchorStart, scanEnd).toLowerCase();
    let best = null;
    normalizedSearchTerms(terms).forEach((term) => {
      const relativeStart = scanText.indexOf(term.toLowerCase());
      if (relativeStart < 0) return;
      const candidate = {
        start: anchorStart + relativeStart,
        end: anchorStart + relativeStart + term.length,
        matchedTerm: term
      };
      if (!best || candidate.start < best.start || (candidate.start === best.start && term.length > best.matchedTerm.length)) best = candidate;
    });
    if (best) return { anchorStart, anchorEnd, ...best };
    return {
      anchorStart,
      anchorEnd,
      start: anchorStart,
      end: Math.min(content.length, Math.max(anchorStart + 1, anchorEnd)),
      matchedTerm: ''
    };
  }

  function searchNavigationForResult(result, query) {
    if (!result || Number(result.start) < 0) return null;
    const doc = state.docs.find((item) => item.id === result.docId);
    const markdown = String(doc?.content || '');
    const terms = normalizedSearchTerms(resultHighlightTerms(query, result));
    const range = resolveSearchSourceRange(markdown, result.start, result.end, terms);
    return {
      docId: result.docId,
      query,
      terms,
      section: result.section || '',
      quote: result.quote || markdown.slice(range.anchorStart, range.anchorEnd),
      ...range
    };
  }

  function clearPreviewSearchHighlights() {
    if (!els.previewEditor) return;
    els.previewEditor.querySelectorAll('mark.app-search-match').forEach((mark) => mark.replaceWith(...mark.childNodes));
    els.previewEditor.querySelectorAll('.app-search-target').forEach((target) => target.classList.remove('app-search-target'));
    els.previewEditor.normalize();
  }

  function wrapPreviewSearchTerms(terms) {
    const normalizedTerms = normalizedSearchTerms(terms);
    if (!normalizedTerms.length) return [];
    const escaped = normalizedTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const expression = new RegExp(escaped.join('|'), 'ig');
    const walker = document.createTreeWalker(els.previewEditor, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || node.parentElement?.closest('script, style, textarea, mark.app-search-match, [data-md-preview-caret]')) continue;
      expression.lastIndex = 0;
      if (expression.test(node.nodeValue)) textNodes.push(node);
    }
    const marks = [];
    let remaining = 400;
    textNodes.forEach((textNode) => {
      if (remaining <= 0 || !textNode.isConnected) return;
      const value = textNode.nodeValue;
      const fragment = document.createDocumentFragment();
      expression.lastIndex = 0;
      let cursor = 0, match;
      while (remaining > 0 && (match = expression.exec(value))) {
        if (match.index > cursor) fragment.appendChild(document.createTextNode(value.slice(cursor, match.index)));
        const mark = document.createElement('mark');
        mark.className = 'app-search-match';
        mark.textContent = match[0];
        fragment.appendChild(mark);
        marks.push(mark);
        remaining -= 1;
        cursor = match.index + match[0].length;
      }
      if (!cursor) return;
      if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)));
      textNode.replaceWith(fragment);
    });
    return marks;
  }

  function searchNavigationTarget(navigation) {
    const quoteTarget = navigation.quote && findPreviewTargetForQuote(navigation.quote);
    if (quoteTarget) return quoteTarget;
    const markdown = getCurrentMarkdown();
    const sectionCandidates = [
      navigation.section,
      ...String(navigation.section || '').split(/\s*\/\s*/),
      ...headingPathAt(markdown, navigation.anchorStart).reverse()
    ].map((item) => String(item || '').trim()).filter(Boolean);
    for (const candidate of sectionCandidates) {
      const target = findPreviewTargetForQuote(candidate);
      if (target) return target;
    }
    return null;
  }

  function applySearchNavigationHighlight(options = {}) {
    clearPreviewSearchHighlights();
    const navigation = activeSearchNavigation;
    if (!navigation || navigation.docId !== state.currentDocId || state.viewMode === 'source') return null;
    const target = searchNavigationTarget(navigation);
    const marks = wrapPreviewSearchTerms(navigation.terms);
    let primary = target ? marks.find((mark) => target.contains(mark)) : null;
    if (!primary && navigation.matchedTerm) {
      primary = marks.find((mark) => mark.textContent.toLowerCase() === navigation.matchedTerm.toLowerCase()) || null;
    }
    if (!primary && target) {
      primary = marks.find((mark) => !!(target.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING)) || null;
    }
    if (!primary) primary = marks[0] || null;
    if (target) target.classList.add('app-search-target');
    if (primary) primary.classList.add('is-primary');
    const location = primary || target;
    if (options.scroll && location) location.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    return location;
  }

  function locateSearchResult(navigation) {
    if (!navigation || navigation.docId !== state.currentDocId) return;
    const markdown = getCurrentMarkdown();
    const previewLocation = applySearchNavigationHighlight({ scroll: state.viewMode !== 'source' });
    if (state.viewMode !== 'preview') {
      requestAnimationFrame(() => {
        els.sourceEditor.focus();
        setProgrammaticSourceSelection(navigation.start, navigation.end);
        const lineHeight = parseFloat(getComputedStyle(els.sourceEditor).lineHeight) || 22;
        const line = markdown.slice(0, navigation.start).split('\n').length - 1;
        els.sourceEditor.scrollTop = Math.max(0, line * lineHeight - els.sourceEditor.clientHeight / 3);
        els.sourceEditor.classList.add('is-search-locating');
        setTimeout(() => els.sourceEditor.classList.remove('is-search-locating'), 1250);
      });
    }
    if (state.viewMode === 'preview' && !previewLocation) tip('已打开文档，但当前预览未能精确定位命中内容');
  }

  async function openSearchResult(index) {
    const result = activeSearchResults[index];
    if (!result) return;
    const query = activeSearchQuery || els.searchInput.value.trim();
    const navigation = searchNavigationForResult(result, query);
    activeSearchNavigation = navigation;
    closeSearchModal();
    await switchDoc(result.docId, { restoreReadingScroll: !navigation });
    if (state.currentDocId !== result.docId) {
      activeSearchNavigation = null;
      return;
    }
    if (navigation) requestAnimationFrame(() => locateSearchResult(navigation));
  }

  function bindDocumentSearch() {
    els.btnSearchDocs.addEventListener('click', openSearchModal);
    els.btnSearchClose.addEventListener('click', closeSearchModal);
    els.searchModal.addEventListener('click', (event) => {
      if (event.target === els.searchModal) closeSearchModal();
    });
    els.searchInput.addEventListener('input', scheduleDocumentSearch);
    els.searchResults.addEventListener('click', (event) => {
      const button = event.target.closest('[data-search-result-index]');
      if (button) openSearchResult(Number(button.dataset.searchResultIndex));
    });
    els.searchResults.addEventListener('focusin', (event) => {
      const button = event.target.closest('[data-search-result-index]');
      if (button) selectSearchResult(Number(button.dataset.searchResultIndex), false);
    });
    els.searchModal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeSearchModal(); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); selectSearchResult(activeSearchResultIndex + 1, true); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); selectSearchResult(activeSearchResultIndex - 1, true); return; }
      if (event.key === 'Enter' && document.activeElement === els.searchInput && activeSearchResultIndex >= 0) {
        event.preventDefault(); openSearchResult(activeSearchResultIndex);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (isImeCompositionEvent(event) || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      if (els.searchModal.hidden) openSearchModal();
      else els.searchInput.focus();
    });
    const api = semanticSearchApi();
    if (api?.onProgress) removeSemanticProgressListener = api.onProgress(handleSemanticProgress);
    window.addEventListener('beforeunload', () => removeSemanticProgressListener?.());
  }

  function docStatus(doc) {
    if (!isDirectoryDoc(doc)) return null;
    const labels = {
      conflict: ['冲突', 'is-conflict'],
      'permission-required': ['需授权', 'is-warning'],
      missing: ['缺失', 'is-muted'],
      updated: ['更新', 'is-updated']
    };
    if (labels[doc.syncState]) return labels[doc.syncState];
    return doc.unread ? ['未读', 'is-muted'] : null;
  }

  function createDocumentItem(doc, renamingId, depth) {
    const li = document.createElement('li');
    const active = doc.id === state.currentDocId;
    const renaming = doc.id === renamingId;
    const confirming = doc.id === confirmDocActionId;
    const diskFile = isDiskFileDoc(doc);
    const directoryDoc = isDirectoryDoc(doc);
    li.className = `app-doc-item${active ? ' is-active' : ''}${diskFile ? ' is-local-file' : ''}${directoryDoc ? ' is-directory-file' : ''}${renaming ? ' is-renaming' : ''}${confirming ? ' is-confirming' : ''}`;
    li.dataset.docId = doc.id;
    li.style.setProperty('--tree-depth', String(depth || 0));

    if (renaming) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'app-doc-item__input';
      input.value = doc.name;
      input.setAttribute('aria-label', '重命名文档');
      li.appendChild(input);
      bindRenameInput(input, doc);
      requestAnimationFrame(() => { input.focus(); input.select(); });
      return li;
    }

    const name = document.createElement('span');
    name.className = 'app-doc-item__name';
    name.textContent = confirming
      ? (diskFile ? '从列表移除？文件保留' : '确认删除文档？')
      : (directoryDoc ? `${doc.name}${fileExtension(doc.localFileName)}` : doc.name);
    name.title = confirming
      ? (diskFile ? '仅移除浏览器中的列表记录，不删除本地文件' : `确认删除「${doc.name}」`)
      : (directoryDoc ? doc.relativePath : (diskFile ? `本地文件：${doc.localFileName || doc.name}` : doc.name));
    li.appendChild(name);

    const status = !confirming && docStatus(doc);
    if (status) {
      const badge = document.createElement('span');
      badge.className = `app-doc-status ${status[1]}`;
      badge.textContent = status[0];
      li.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.className = 'app-doc-item__actions';
    if (confirming) {
      actions.innerHTML =
        `<button type="button" class="app-doc-item__action${diskFile ? '' : ' app-doc-item__action--danger'}" data-action="confirm-remove" title="${diskFile ? '确认从列表移除（不删除本地文件）' : '确认删除文档'}" aria-label="${diskFile ? '确认从列表移除' : '确认删除'} ${doc.name}">${ICON_CONFIRM}</button>` +
        `<button type="button" class="app-doc-item__action" data-action="cancel-remove" title="取消" aria-label="取消">${ICON_CANCEL}</button>`;
    } else {
      const canRename = !diskFile || (doc.fileHandle && doc.syncState !== 'missing' && doc.syncState !== 'permission-required');
      const renameAction = canRename
        ? `<button type="button" class="app-doc-item__action" data-action="rename" title="${diskFile ? '重命名本地文件' : '重命名文档'}" aria-label="${diskFile ? '重命名本地文件' : '重命名文档'} ${doc.name}">${ICON_RENAME}</button>`
        : '';
      const removableDirectoryMirror = directoryDoc && doc.syncState === 'missing';
      const removeAction = !directoryDoc || removableDirectoryMirror
        ? (diskFile
          ? `<button type="button" class="app-doc-item__action" data-action="remove" title="从列表移除（不删除本地文件）" aria-label="从列表移除 ${doc.name}">${ICON_CANCEL}</button>`
          : `<button type="button" class="app-doc-item__action app-doc-item__action--danger" data-action="remove" title="删除文档" aria-label="删除文档 ${doc.name}">${ICON_DELETE}</button>`)
        : '';
      actions.innerHTML = renameAction + removeAction;
    }
    li.appendChild(actions);
    return li;
  }

  function buildDirectoryTree(docs) {
    const root = { path: '', folders: new Map(), files: [] };
    docs.forEach((doc) => {
      const parts = normalizeRelativePath(doc.relativePath).split('/');
      parts.pop();
      let node = root;
      parts.forEach((part) => {
        const path = normalizeRelativePath(`${node.path}/${part}`);
        if (!node.folders.has(part)) node.folders.set(part, { path, folders: new Map(), files: [] });
        node = node.folders.get(part);
      });
      node.files.push(doc);
    });
    return root;
  }

  function directoryNodeFileCount(node) {
    let count = node.files.length;
    node.folders.forEach((child) => { count += directoryNodeFileCount(child); });
    return count;
  }

  function directoryFolderPaths(docs) {
    const paths = new Set();
    docs.forEach((doc) => {
      const parts = normalizeRelativePath(doc.relativePath).split('/').filter(Boolean);
      parts.pop();
      let path = '';
      parts.forEach((part) => {
        path = normalizeRelativePath(`${path}/${part}`);
        paths.add(path);
      });
    });
    return [...paths];
  }

  function documentTreeFullyCollapsed() {
    return state.myDocsCollapsed && state.directories.every((directory) => directory.collapsed);
  }

  function updateDocumentTreeToggle() {
    if (!els.btnToggleAllDocs) return;
    const fullyCollapsed = documentTreeFullyCollapsed();
    const label = fullyCollapsed ? '展开全部目录' : '折叠全部目录';
    const icon = fullyCollapsed ? 'expand-all' : 'collapse-all';
    els.btnToggleAllDocs.title = label;
    els.btnToggleAllDocs.setAttribute('aria-label', label);
    els.btnToggleAllDocs.setAttribute('aria-expanded', fullyCollapsed ? 'false' : 'true');
    const iconNode = els.btnToggleAllDocs.querySelector('.ui-icon');
    if (iconNode) iconNode.innerHTML = iconSvg(icon);
  }

  function setDocumentTreeCollapsed(collapsed) {
    state.myDocsCollapsed = collapsed;
    state.directories.forEach((directory) => {
      directory.collapsed = collapsed;
      directory.collapsedPaths = collapsed
        ? directoryFolderPaths(state.docs.filter((doc) => doc.directoryId === directory.id))
        : [];
    });
    saveState({ silent: true });
    renderDocList();
  }

  function appendDirectoryNode(parent, node, directory, renamingId, depth) {
    [...node.folders.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).forEach(([name, child]) => {
      const li = document.createElement('li');
      li.className = 'app-tree-subgroup';
      const collapsed = directory.collapsedPaths.includes(child.path);
      const button = createTreeRoot(name, directoryNodeFileCount(child), collapsed, 'toggle-path', {
        directoryId: directory.id,
        path: child.path
      });
      button.classList.add('app-tree-root--nested');
      button.style.setProperty('--tree-depth', String(depth));
      li.appendChild(button);
      const children = document.createElement('ul');
      children.className = 'app-tree-children';
      children.hidden = collapsed;
      appendDirectoryNode(children, child, directory, renamingId, depth + 1);
      li.appendChild(children);
      parent.appendChild(li);
    });
    node.files.sort((a, b) => (a.localFileName || a.name).localeCompare(b.localFileName || b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
      || normalizeRelativePath(a.relativePath).localeCompare(normalizeRelativePath(b.relativePath), 'zh-CN'))
      .forEach((doc) => parent.appendChild(createDocumentItem(doc, renamingId, depth)));
  }

  function renderDocList(renamingId) {
    els.docList.replaceChildren();

    const browserDocs = state.docs.filter((doc) => !isDirectoryDoc(doc));
    const myGroup = document.createElement('li');
    myGroup.className = 'app-tree-group';
    myGroup.appendChild(createTreeRoot('我的文档', browserDocs.length, state.myDocsCollapsed, 'toggle-my-docs'));
    const myChildren = document.createElement('ul');
    myChildren.className = 'app-tree-children';
    myChildren.hidden = state.myDocsCollapsed;
    browserDocs.forEach((doc) => myChildren.appendChild(createDocumentItem(doc, renamingId, 0)));
    myGroup.appendChild(myChildren);
    els.docList.appendChild(myGroup);

    [...state.directories].sort((a, b) => a.order - b.order).forEach((directory) => {
      const docs = state.docs.filter((doc) => doc.directoryId === directory.id);
      const group = document.createElement('li');
      group.className = 'app-tree-group app-tree-group--directory';
      const subtitle = directory.lastScanStatus === 'scanning'
        ? '正在扫描…'
        : (directory.permissionState !== 'granted' ? '需要授权' : directory.handleName);
      group.appendChild(createTreeRoot(directory.name, docs.length, directory.collapsed, 'toggle-directory', { directoryId: directory.id }, subtitle));
      const children = document.createElement('ul');
      children.className = 'app-tree-children';
      children.hidden = directory.collapsed;
      if (!docs.length) {
        const empty = document.createElement('li');
        empty.className = 'app-tree-empty';
        empty.textContent = directory.lastScanStatus === 'scanning' ? '正在查找 Markdown / TXT…' : '暂无 Markdown / TXT 文档';
        children.appendChild(empty);
      } else {
        appendDirectoryNode(children, buildDirectoryTree(docs), directory, renamingId, 0);
      }
      group.appendChild(children);
      els.docList.appendChild(group);
    });
    updateDocumentTreeToggle();
    updateDirectoryRefreshButton();
    if (state.currentDocId) revealDoc(state.currentDocId);
  }

  async function switchDoc(id, options = {}) {
    flushPendingPreviewCommit();
    const doc = state.docs.find((d) => d.id === id);
    if (!doc) return;
    if (activeSearchNavigation?.docId !== id) activeSearchNavigation = null;
    if (isDirectoryDoc(doc)) {
      const readable = await readDirectoryDocument(doc, true);
      if (!readable && !doc.contentLoaded) return;
    }
    if (id === state.currentDocId) {
      syncSourceToDOM();
      render();
      updateConflictBar();
      return;
    }
    draftCommentAnchor = null;
    selectedPreviewBlock = null;
    activeCommentId = null;
    closeCommentComposer();
    state.currentDocId = id;
    touchDoc(doc);
    ensureHistory(doc);
    resetHistoryCoalescing(ensureHistory(doc));
    confirmDocActionId = null;
    syncSourceToDOM();
    saveState();
    renderDocList();
    revealDoc(doc.id);
    render();
    if (options.restoreReadingScroll !== false) restoreReadingScroll();
    updateEditChrome();
    updateConflictBar();
  }

  function formatScanTime(timestamp) {
    if (!timestamp) return '尚未扫描';
    try { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp)); }
    catch (error) { return '已扫描'; }
  }

  function directoryStatusText(directory) {
    if (directory.permissionState !== 'granted') return '需要重新授权';
    if (directory.lastScanStatus === 'scanning') return '正在扫描 Markdown / TXT 文档…';
    if (directory.lastScanStatus === 'error') return directory.lastScanSummary?.error || '扫描失败';
    const summary = directory.lastScanSummary;
    if (!summary) return formatScanTime(directory.lastScannedAt);
    const suffix = summary.truncated
      ? ` · 已达 ${DIRECTORY_MAX_FILES} 个上限`
      : (summary.depthLimited ? ` · 仅扫描 ${DIRECTORY_MAX_DEPTH} 层` : (summary.errors ? ` · 跳过 ${summary.errors} 个文件` : ''));
    return `${summary.total || 0} 个文档 · ${formatScanTime(directory.lastScannedAt)}${suffix}`;
  }

  function renderDirectoryModal() {
    if (!els.directoryList) return;
    const supported = typeof window.showDirectoryPicker === 'function';
    els.directoryUnsupported.hidden = supported;
    els.btnDirectoryAdd.disabled = !supported;
    els.directoryList.replaceChildren();
    els.directoryEmpty.hidden = state.directories.length > 0;

    [...state.directories].sort((a, b) => a.order - b.order).forEach((directory) => {
      const item = document.createElement('article');
      item.className = 'app-directory-item';
      item.dataset.directoryId = directory.id;
      const main = document.createElement('div');
      main.className = 'app-directory-item__main';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'app-directory-item__name';
      input.value = directory.name;
      input.dataset.action = 'rename-directory';
      input.setAttribute('aria-label', `目录显示名称：${directory.name}`);
      const meta = document.createElement('div');
      meta.className = 'app-directory-item__meta';
      meta.textContent = directory.handleName || '本地文件夹';
      const status = document.createElement('div');
      status.className = `app-directory-item__status is-${directory.lastScanStatus || 'idle'}`;
      status.textContent = directoryStatusText(directory);
      main.append(input, meta, status);
      const errorDetails = directory.lastScanSummary?.errorDetails;
      if (Array.isArray(errorDetails) && errorDetails.length) {
        const scanWarning = document.createElement('div');
        scanWarning.className = 'app-directory-item__scan-warning';
        scanWarning.textContent = errorDetails.map((item) => `${item.path}：${item.reason}`).join('；');
        scanWarning.title = scanWarning.textContent;
        main.appendChild(scanWarning);
      }

      const actions = document.createElement('div');
      actions.className = 'app-directory-item__actions';
      if (confirmDirectoryRemoveId === directory.id) {
        const warning = document.createElement('span');
        warning.className = 'app-directory-item__warning';
        warning.textContent = '仅从列表移除，本地文件不会删除';
        actions.innerHTML =
          `<button type="button" class="app-button app-button--danger" data-action="confirm-remove-directory">确认移除</button>` +
          `<button type="button" class="app-button app-button--secondary" data-action="cancel-remove-directory">取消</button>`;
        main.appendChild(warning);
      } else {
        if (directory.permissionState !== 'granted') {
          actions.innerHTML += `<button type="button" class="app-button app-button--secondary" data-action="authorize-directory">重新授权</button>`;
        }
        actions.innerHTML += `<button type="button" class="app-button app-button--secondary" data-action="scan-directory">${ICON_REFRESH}<span>立即扫描</span></button>`;
        actions.innerHTML += `<button type="button" class="app-icon-button" data-action="remove-directory" title="移除目录（不删除本地文件）" aria-label="移除目录 ${directory.name}">${ICON_DELETE}</button>`;
      }
      item.append(main, actions);
      els.directoryList.appendChild(item);
    });
  }

  function openDirectoryModal() {
    if (!els.directoryModal) return;
    directoryModalPreviousFocus = document.activeElement;
    renderDirectoryModal();
    els.directoryModal.hidden = false;
    els.directoryModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('has-modal');
    requestAnimationFrame(() => els.btnDirectoryAdd.focus());
  }

  function closeDirectoryModal() {
    if (!els.directoryModal) return;
    confirmDirectoryRemoveId = null;
    els.directoryModal.hidden = true;
    els.directoryModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('has-modal');
    if (directoryModalPreviousFocus && directoryModalPreviousFocus.focus) directoryModalPreviousFocus.focus();
  }

  function uniqueDirectoryName(baseName) {
    const names = new Set(state.directories.map((directory) => directory.name));
    const base = String(baseName || '智能体目录').trim() || '智能体目录';
    if (!names.has(base)) return base;
    let index = 2;
    while (names.has(`${base} ${index}`)) index += 1;
    return `${base} ${index}`;
  }

  async function sameDirectoryHandle(handle) {
    for (const directory of state.directories) {
      if (!directory.handle || !handle.isSameEntry) continue;
      try { if (await handle.isSameEntry(directory.handle)) return directory; }
      catch (error) { /* 失效句柄按不同目录处理 */ }
    }
    return null;
  }

  async function addDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') {
      tip('当前浏览器不支持添加目录，请使用最新版 Chrome 或 Edge');
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (!await ensureReadWritePermission(handle)) throw new Error('未获得目录读写权限');
      const duplicate = await sameDirectoryHandle(handle);
      if (duplicate) {
        tip(`「${duplicate.name}」已经添加`);
        renderDirectoryModal();
        return;
      }
      const directory = {
        id: `directory-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`,
        name: uniqueDirectoryName(handle.name),
        handleName: handle.name,
        handle,
        permissionState: 'granted',
        scanMode: 'interval',
        lastScannedAt: 0,
        lastScanStatus: 'idle',
        lastScanSummary: null,
        order: state.directories.length,
        collapsed: false,
        collapsedPaths: [],
        createdAt: Date.now()
      };
      state.directories.push(directory);
      await persistDirectoryHandle(directory);
      saveState({ silent: true });
      renderDirectoryModal();
      renderDocList();
      await scanDirectory(directory, { interactive: true, announce: true });
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      tip(`添加目录失败：${error.message || '未知错误'}`);
    }
  }

  async function removeDirectory(directory) {
    if (!directory) return;
    const removedDocs = state.docs.filter((doc) => doc.directoryId === directory.id);
    const removedIds = new Set(removedDocs.map((doc) => doc.id));
    removedDocs.forEach((doc) => {
      histories.delete(doc.id);
      markSemanticIndexDirty(doc.id);
    });
    state.docs = state.docs.filter((doc) => doc.directoryId !== directory.id);
    state.directories = state.directories.filter((item) => item.id !== directory.id)
      .map((item, index) => ({ ...item, order: index }));
    if (removedIds.has(state.currentDocId)) {
      const next = state.docs.find((doc) => !isDirectoryDoc(doc)) || state.docs[0];
      state.currentDocId = next ? next.id : null;
      if (next) { touchDoc(next); syncSourceToDOM(); render(); }
    }
    confirmDirectoryRemoveId = null;
    await removePersistedDirectory(directory.id);
    saveState({ silent: true });
    renderDirectoryModal();
    renderDocList();
    updateConflictBar();
    tip(`已移除「${directory.name}」，本地文件未删除`);
  }

  function bindDirectoryManager() {
    if (els.btnAddDirectory) els.btnAddDirectory.addEventListener('click', openDirectoryModal);
    if (els.btnRefreshDirectories) els.btnRefreshDirectories.addEventListener('click', refreshAllDirectories);
    els.btnDirectoryAdd.addEventListener('click', addDirectory);
    els.btnDirectoryClose.addEventListener('click', closeDirectoryModal);
    els.btnDirectoryDone.addEventListener('click', closeDirectoryModal);
    els.directoryModal.addEventListener('click', (event) => {
      if (event.target === els.directoryModal) { closeDirectoryModal(); return; }
      const item = event.target.closest('.app-directory-item');
      const directory = item && state.directories.find((entry) => entry.id === item.dataset.directoryId);
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!directory || !action) return;
      if (action === 'scan-directory' || action === 'authorize-directory') scanDirectory(directory, { interactive: true, announce: true });
      else if (action === 'remove-directory') { confirmDirectoryRemoveId = directory.id; renderDirectoryModal(); }
      else if (action === 'cancel-remove-directory') { confirmDirectoryRemoveId = null; renderDirectoryModal(); }
      else if (action === 'confirm-remove-directory') removeDirectory(directory);
    });
    els.directoryList.addEventListener('change', (event) => {
      if (event.target.dataset.action !== 'rename-directory') return;
      const item = event.target.closest('.app-directory-item');
      const directory = item && state.directories.find((entry) => entry.id === item.dataset.directoryId);
      if (!directory) return;
      const nextName = String(event.target.value || '').trim();
      if (!nextName) { event.target.value = directory.name; tip('目录显示名称不能为空'); return; }
      directory.name = nextName;
      state.docs.filter((doc) => doc.directoryId === directory.id).forEach((doc) => markSemanticIndexDirty(doc.id));
      saveState({ silent: true });
      renderDocList();
      tip(`目录显示名称已更新为「${nextName}」`);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !els.directoryModal.hidden) closeDirectoryModal();
    });
  }

  function updateConflictBar() {
    if (!els.conflictBar) return;
    const doc = currentDoc();
    const visible = isDirectoryDoc(doc) && doc.syncState === 'conflict';
    els.conflictBar.hidden = !visible;
    if (visible) els.conflictText.textContent = `「${doc.name}」的磁盘版本已更新，当前编辑尚未覆盖`;
  }

  function openConflictModal() {
    const doc = currentDoc();
    if (!doc || doc.syncState !== 'conflict' || !els.conflictModal) return;
    els.conflictCurrent.textContent = doc.content;
    els.conflictDisk.textContent = typeof doc.externalContent === 'string' ? doc.externalContent : '磁盘版本暂不可读取';
    els.conflictModal.hidden = false;
    els.conflictModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('has-modal');
    requestAnimationFrame(() => els.btnConflictClose.focus());
  }

  function closeConflictModal() {
    if (!els.conflictModal) return;
    els.conflictModal.hidden = true;
    els.conflictModal.setAttribute('aria-hidden', 'true');
    if (els.directoryModal.hidden) document.body.classList.remove('has-modal');
  }

  function reloadConflictFromDisk() {
    const doc = currentDoc();
    if (!doc || doc.syncState !== 'conflict' || typeof doc.externalContent !== 'string') return;
    doc.content = doc.externalContent;
    doc.lastSavedContent = doc.externalContent;
    doc.externalContent = null;
    doc.contentLoaded = true;
    doc.syncState = 'synced';
    doc.unread = false;
    histories.set(doc.id, { entries: [doc.content], index: 0, lastInputAt: 0, lastInputSource: null });
    syncSourceToDOM();
    saveState({ silent: true });
    renderDocList();
    render();
    closeConflictModal();
    tip('已重新载入磁盘版本');
  }

  function keepConflictCurrent() {
    const doc = currentDoc();
    if (!doc || doc.syncState !== 'conflict') return;
    doc.syncState = 'synced';
    doc.externalContent = null;
    saveState({ silent: true });
    renderDocList();
    updateStatus();
    closeConflictModal();
    els.sourceEditor.focus();
    tip('已保留当前编辑；点击保存可写回原文件');
  }

  function bindConflictControls() {
    els.btnConflictView.addEventListener('click', openConflictModal);
    els.btnConflictKeep.addEventListener('click', keepConflictCurrent);
    els.btnConflictReload.addEventListener('click', openConflictModal);
    els.btnConflictClose.addEventListener('click', closeConflictModal);
    els.btnConflictCancel.addEventListener('click', keepConflictCurrent);
    els.btnConflictConfirmReload.addEventListener('click', reloadConflictFromDisk);
    els.conflictModal.addEventListener('click', (event) => { if (event.target === els.conflictModal) closeConflictModal(); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !els.conflictModal.hidden) closeConflictModal();
    });
  }

  function startDirectoryScanning() {
    clearInterval(directoryScanTimer);
    directoryScanTimer = setInterval(() => {
      if (document.visibilityState === 'visible') scanAllDirectories({ interactive: false, announce: false });
    }, DIRECTORY_SCAN_INTERVAL);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const stale = state.directories.some((directory) => Date.now() - (directory.lastScannedAt || 0) >= DIRECTORY_SCAN_INTERVAL);
      if (stale) scanAllDirectories({ interactive: false, announce: false });
    });
  }

  function bindModalFocusTrap() {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const modal = [...document.querySelectorAll('.app-modal-backdrop:not([hidden])')].at(-1) || null;
      if (!modal) return;
      const focusable = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hidden && element.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }

  function nextUntitledName() {
    const names = new Set(state.docs.map((d) => d.name));
    if (!names.has('未命名文档')) return '未命名文档';
    let i = 2;
    while (names.has(`未命名文档 ${i}`)) i += 1;
    return `未命名文档 ${i}`;
  }

  function uniqueDocName(baseName) {
    const names = new Set(state.docs.map((d) => d.name));
    const base = (baseName || '未命名文档').trim() || '未命名文档';
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i += 1;
    return `${base} ${i}`;
  }

  function createDoc() {
    const doc = {
      id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: nextUntitledName(),
      content: '',
      lastSavedContent: '',
      fileHandle: null,
      directoryHandle: null,
      localFileName: null,
      openedWithoutHandle: false,
      sourceKind: 'browser',
      lastOpenedAt: 0
    };
    state.docs.push(doc);
    markSemanticIndexDirty(doc.id);
    touchDoc(doc);
    ensureHistory(doc);
    state.currentDocId = doc.id;
    resetHistoryCoalescing(ensureHistory(doc));
    confirmDocActionId = null;
    syncSourceToDOM();
    saveState();
    renderDocList();
    revealDoc(doc.id);
    render();
    updateEditChrome();
    els.sourceEditor.focus();
    tip(`已新建「${doc.name}」`);
  }

  // ── 打开本地文档（文件选择器 + 拖拽） ──
  function isOpenableFile(file) {
    if (!file) return false;
    const name = (file.name || '').toLowerCase();
    if (OPEN_EXTS.some((ext) => name.endsWith(ext))) return true;
    const type = (file.type || '').toLowerCase();
    return type === 'text/markdown' || type === 'text/plain' || type === 'text/x-markdown';
  }

  function nameFromFile(file) {
    const raw = (file && file.name) || '未命名文档';
    return uniqueDocName(raw.replace(/\.(md|markdown|txt)$/i, ''));
  }

  function decodeTextBytes(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    if (!bytes.length) return '';

    const decode = (encoding, offset, options) => new TextDecoder(encoding, options).decode(bytes.subarray(offset || 0));
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return decode('utf-8', 3);
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return decode('utf-16le', 2);
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return decode('utf-16be', 2);

    // BOM-less UTF-16 is common in text exported by older desktop software.
    const sampleLength = Math.min(bytes.length - (bytes.length % 2), 4096);
    let evenNulls = 0, oddNulls = 0;
    for (let index = 0; index < sampleLength; index += 2) {
      if (bytes[index] === 0) evenNulls += 1;
      if (bytes[index + 1] === 0) oddNulls += 1;
    }
    const nullThreshold = Math.max(2, sampleLength / 8);
    if (oddNulls >= nullThreshold && oddNulls > evenNulls * 4) return decode('utf-16le');
    if (evenNulls >= nullThreshold && evenNulls > oddNulls * 4) return decode('utf-16be');

    try {
      return decode('utf-8', 0, { fatal: true });
    } catch (utf8Error) {
      try {
        return decode('gb18030', 0, { fatal: true });
      } catch (legacyError) {
        console.warn('文本编码无法完全识别，已使用宽松 UTF-8 解码', { utf8Error, legacyError });
        return decode('utf-8');
      }
    }
  }

  async function readFileAsText(file) {
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('读取失败：无效文件');
    return decodeTextBytes(await file.arrayBuffer());
  }

  function addImportedDoc({ name, content, fileHandle, localFileName }) {
    const doc = {
      id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: uniqueDocName(name || '未命名文档'),
      content: content || '',
      lastSavedContent: content || '',
      fileHandle: fileHandle || null,
      localFileName: localFileName || (fileHandle && fileHandle.name) || null,
      openedWithoutHandle: !fileHandle,
      sourceKind: 'local-file',
      lastOpenedAt: 0
    };
    state.docs.push(doc);
    markSemanticIndexDirty(doc.id);
    ensureHistory(doc);
    return doc;
  }

  async function importLocalFiles(fileList) {
    const files = [...(fileList || [])].filter(isOpenableFile);
    if (!files.length) { tip('请选择 .md / .markdown / .txt 文件'); return; }
    const imported = [];
    for (const file of files) {
      try {
        const content = await readFileAsText(file);
        imported.push(addImportedDoc({ name: nameFromFile(file), content, fileHandle: null, localFileName: file.name || null }));
      } catch (e) { console.warn('打开本地文件失败', file && file.name, e); }
    }
    if (!imported.length) { tip('未能打开所选文件'); return; }
    activateImportedDocs(imported);
  }

  async function importFileHandles(handles) {
    const imported = [];
    for (const handle of handles || []) {
      try {
        if (handle.kind && handle.kind !== 'file') continue;
        const file = await handle.getFile();
        if (!isOpenableFile(file)) continue;
        const content = await readFileAsText(file);
        const base = (handle.name || file.name || '未命名文档').replace(/\.(md|markdown|txt)$/i, '');
        imported.push(addImportedDoc({ name: base, content, fileHandle: handle, localFileName: handle.name || file.name || null }));
      } catch (e) { console.warn('打开本地文件失败', handle && handle.name, e); }
    }
    if (!imported.length) { tip('未能打开所选文件'); return; }
    activateImportedDocs(imported);
  }

  function activateImportedDocs(imported) {
    const last = imported[imported.length - 1];
    imported.forEach(touchDoc);
    state.currentDocId = last.id;
    resetHistoryCoalescing(ensureHistory(last));
    confirmDocActionId = null;
    syncSourceToDOM();
    saveState();
    renderDocList();
    revealDoc(last.id);
    render();
    updateEditChrome();
    imported.forEach(persistDocHandles);
    els.sourceEditor.focus();
    tip(imported.length === 1 ? `已打开「${last.name}」` : `已打开 ${imported.length} 个文档`);
  }

  async function openLocalDocuments() {
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          types: TEXT_FILE_PICKER_TYPES
        });
        await importFileHandles(handles);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.warn('showOpenFilePicker 失败，回退 input', e);
      }
    }
    els.fileOpen.value = '';
    els.fileOpen.click();
  }

  function bindFileOpen() {
    els.btnOpenDoc.addEventListener('click', () => { openLocalDocuments(); });
    els.fileOpen.addEventListener('change', () => { importLocalFiles(els.fileOpen.files); els.fileOpen.value = ''; });
    bindOpenDocTip();
  }

  function hideOpenDocTip() {
    clearTimeout(showOpenDocTip._t);
    if (els.openDocTip) els.openDocTip.hidden = true;
  }

  function showOpenDocTip() {
    if (!els.openDocTip || !els.openDocInfo) return;
    clearTimeout(showOpenDocTip._t);
    els.openDocTip.hidden = false;
  }

  function bindOpenDocTip() {
    if (!els.openDocInfo) return;
    const lockBtn = () => els.btnOpenDoc && els.btnOpenDoc.classList.add('is-info-hover');
    const unlockBtn = () => els.btnOpenDoc && els.btnOpenDoc.classList.remove('is-info-hover');
    const show = () => { showOpenDocTip(); lockBtn(); };
    const hide = () => { unlockBtn(); clearTimeout(showOpenDocTip._t); showOpenDocTip._t = setTimeout(hideOpenDocTip, 120); };
    els.openDocInfo.addEventListener('mouseenter', show);
    els.openDocInfo.addEventListener('focus', show);
    els.openDocInfo.addEventListener('mouseleave', hide);
    els.openDocInfo.addEventListener('blur', hide);
    els.openDocInfo.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideOpenDocTip(); unlockBtn(); } });
    els.openDocInfo.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
  }

  let dragDepth = 0;
  function hasFilesInDataTransfer(dt) {
    if (!dt) return false;
    if (dt.types && [...dt.types].includes('Files')) return true;
    return !!(dt.files && dt.files.length);
  }
  function imageFilesFromTransfer(transfer) {
    const direct = [...(transfer?.files || [])].filter((file) => isSupportedImageFile(file));
    if (direct.length) return direct;
    return [...(transfer?.items || [])]
      .filter((item) => item.kind === 'file' && String(item.type || '').startsWith('image/'))
      .map((item) => item.getAsFile()).filter((file) => isSupportedImageFile(file));
  }
  function transferMayContainImages(transfer) {
    return [...(transfer?.items || [])].some((item) => item.kind === 'file' && String(item.type || '').startsWith('image/'))
      || imageFilesFromTransfer(transfer).length > 0;
  }
  function editorSurfaceAtPoint(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY);
    if (target === els.sourceEditor) return 'source';
    if (target && (target === els.previewWrap || els.previewEditor.contains(target))) return 'preview';
    return null;
  }
  function showDropMask(show, imageMode) {
    document.body.classList.toggle('is-dragging-files', show);
    if (els.dropMask) els.dropMask.hidden = !show;
    if (els.dropMaskPanel) els.dropMaskPanel.textContent = imageMode
      ? '松开以在当前位置插入图片'
      : '松开以打开本地 Markdown / TXT 文档';
  }
  function bindDragDrop() {
    window.addEventListener('dragenter', (e) => {
      if (!hasFilesInDataTransfer(e.dataTransfer)) return;
      e.preventDefault(); dragDepth += 1;
      const imageMode = transferMayContainImages(e.dataTransfer) && !!editorSurfaceAtPoint(e.clientX, e.clientY);
      showDropMask(true, imageMode);
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFilesInDataTransfer(e.dataTransfer)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      const imageMode = transferMayContainImages(e.dataTransfer) && !!editorSurfaceAtPoint(e.clientX, e.clientY);
      showDropMask(true, imageMode);
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFilesInDataTransfer(e.dataTransfer)) return;
      e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) showDropMask(false, false);
    });
    window.addEventListener('drop', (e) => {
      if (!hasFilesInDataTransfer(e.dataTransfer)) return;
      e.preventDefault();
      const surface = editorSurfaceAtPoint(e.clientX, e.clientY);
      const images = imageFilesFromTransfer(e.dataTransfer);
      dragDepth = 0; showDropMask(false, false);
      if (surface && images.length) {
        const range = surface === 'preview' ? previewRangeAtPoint(e.clientX, e.clientY) : null;
        insertImageFiles(images, captureImageInsertion({ surface, range }));
        return;
      }
      importLocalFiles(e.dataTransfer.files);
    });
    window.addEventListener('dragend', () => { dragDepth = 0; showDropMask(false, false); });
  }

  function beginRename(doc) { renderDocList(doc.id); }

  async function commitRename(doc, rawName, input, opts) {
    const onEmpty = (opts && opts.onEmpty) || 'keep';
    const typedName = String(rawName || '').trim();
    const name = isDiskFileDoc(doc)
      ? typedName.replace(/\.(md|markdown|txt)$/i, '')
      : typedName;
    const invalidName = validateFileBaseName(name);
    if (invalidName) {
      tip(invalidName);
      if (onEmpty === 'cancel') { renderDocList(); return true; }
      if (input) { input.classList.add('is-invalid'); input.value = doc.name; input.select(); }
      return false;
    }
    const duplicateName = isDirectoryDoc(doc)
      ? state.docs.some((item) => {
        if (item.id === doc.id || item.directoryId !== doc.directoryId) return false;
        const currentParts = normalizeRelativePath(doc.relativePath).split('/');
        const itemParts = normalizeRelativePath(item.relativePath).split('/');
        currentParts.pop();
        itemParts.pop();
        return currentParts.join('/') === itemParts.join('/') && item.name === name;
      })
      : state.docs.some((d) => d.id !== doc.id && d.name === name);
    if (duplicateName) {
      tip('已有同名文档，请换一个名称');
      if (input) { input.classList.add('is-invalid'); input.select(); }
      return false;
    }
    if (doc.name !== name && isDiskFileDoc(doc)) {
      if (!doc.fileHandle) {
        tip('无法同步重命名：请使用 Chrome/Edge 的「打开文档」重新打开原文件');
        if (input) { input.classList.add('is-invalid'); input.select(); }
        return false;
      }
      try {
        if (isDirectoryDoc(doc)) {
          await renameDirectoryDocument(doc, name);
        } else {
          const renamed = await renameLocalFile(doc, name);
          doc.fileHandle = renamed.fileHandle;
          doc.directoryHandle = renamed.directoryHandle || doc.directoryHandle;
          doc.localFileName = renamed.fileName;
        }
        doc.openedWithoutHandle = false;
        markDocSaved(doc, doc.content);
        await persistDocHandles(doc);
      } catch (error) {
        if (error && error.name === 'AbortError') tip('已取消重命名');
        else tip(`重命名失败：${error.message || '未知错误'}`);
        if (input && input.isConnected) { input.classList.add('is-invalid'); input.focus(); input.select(); }
        return false;
      }
    }
    if (doc.name !== name) {
      doc.name = name;
      markSemanticIndexDirty(doc.id);
      saveState();
      tip(`已重命名为「${name}」`);
    }
    renderDocList();
    updateStatus();
    return true;
  }

  function bindRenameInput(input, doc) {
    let cancelled = false, settled = false, ignoringBlur = false, committing = false;
    const releaseBlurGuard = () => { setTimeout(() => { ignoringBlur = false; }, 0); };
    const submit = async (onEmpty) => {
      if (cancelled || settled || committing) return;
      committing = true;
      ignoringBlur = true;
      const ok = await commitRename(doc, input.value, input, { onEmpty });
      if (ok) settled = true;
      committing = false;
      releaseBlurGuard();
    };
    input.addEventListener('keydown', (e) => {
      if (isImeCompositionEvent(e)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        submit('keep');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelled = true; settled = true; ignoringBlur = true;
        renderDocList();
      }
    });
    input.addEventListener('blur', async () => {
      if (cancelled || settled || ignoringBlur || committing) return;
      await submit('cancel');
    });
  }

  function removeDoc(doc) {
    if (state.docs.length === 1) { tip('至少保留一个文档'); confirmDocActionId = null; renderDocList(); return; }
    const localFile = isDiskFileDoc(doc);
    const index = state.docs.findIndex((d) => d.id === doc.id);
    state.docs.splice(index, 1);
    markSemanticIndexDirty(doc.id);
    delete reviewStore.documents[doc.id];
    persistReviewStore();
    histories.delete(doc.id);
    removePersistedHandles(doc.id);
    if (state.currentDocId === doc.id) {
      const next = state.docs[Math.min(index, state.docs.length - 1)];
      state.currentDocId = next.id;
      touchDoc(next);
      syncSourceToDOM();
    }
    confirmDocActionId = null;
    saveState();
    renderDocList();
    if (state.currentDocId) revealDoc(state.currentDocId);
    render();
    tip(localFile ? `已从列表移除「${doc.name}」，本地文件未删除` : `已删除「${doc.name}」`);
  }

  function bindDocList() {
    els.btnNewDoc.addEventListener('click', createDoc);
    if (els.btnToggleAllDocs) {
      els.btnToggleAllDocs.addEventListener('click', () => {
        setDocumentTreeCollapsed(!documentTreeFullyCollapsed());
      });
    }
    els.docList.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'toggle-my-docs') {
        state.myDocsCollapsed = !state.myDocsCollapsed;
        saveState({ silent: true });
        renderDocList();
        return;
      }
      if (action === 'toggle-directory') {
        const root = event.target.closest('[data-directory-id]');
        const directory = root && state.directories.find((item) => item.id === root.dataset.directoryId);
        if (directory) {
          directory.collapsed = !directory.collapsed;
          saveState({ silent: true });
          renderDocList();
        }
        return;
      }
      if (action === 'toggle-path') {
        const root = event.target.closest('[data-directory-id][data-path]');
        const directory = root && state.directories.find((item) => item.id === root.dataset.directoryId);
        if (directory) {
          const paths = new Set(directory.collapsedPaths || []);
          if (paths.has(root.dataset.path)) paths.delete(root.dataset.path);
          else paths.add(root.dataset.path);
          directory.collapsedPaths = [...paths];
          saveState({ silent: true });
          renderDocList();
        }
        return;
      }
      const item = event.target.closest('.app-doc-item');
      if (!item || item.classList.contains('is-renaming')) return;
      const doc = state.docs.find((d) => d.id === item.dataset.docId);
      if (!doc) return;
      if (action === 'rename') { event.stopPropagation(); beginRename(doc); return; }
      if (action === 'remove') {
        event.stopPropagation(); confirmDocActionId = doc.id; renderDocList();
        if (isDiskFileDoc(doc)) tip('仅从列表移除，不会删除本地文件');
        return;
      }
      if (action === 'confirm-remove') { event.stopPropagation(); removeDoc(doc); return; }
      if (action === 'cancel-remove') { event.stopPropagation(); confirmDocActionId = null; renderDocList(); return; }
      switchDoc(doc.id);
    });
  }

  // ── 快捷键（与工具栏同一 format 引擎，三视图一致） ──
  function applyShortcutToPreview(action, level) {
    applyFormatToPreview(action, level);
  }

  function bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (isImeCompositionEvent(e)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      const isPreview = els.previewEditor.contains(document.activeElement) || document.activeElement === els.previewEditor;
      const isSource = document.activeElement === els.sourceEditor;
      // 保存可在全局触发；其余编辑快捷键仍限定编辑区
      if (k === 's' && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        saveCurrentDocument();
        return;
      }
      if (!isPreview && !isSource) return;

      if (k === 'z' && !e.altKey) {
        e.preventDefault();
        applyHistory(e.shiftKey ? 1 : -1);
        return;
      }
      if (!e.metaKey && k === 'y' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        applyHistory(1);
        return;
      }
      if (k === 'b') { e.preventDefault(); isSource ? format('bold') : applyShortcutToPreview('bold'); return; }
      if (k === 'i') { e.preventDefault(); isSource ? format('italic') : applyShortcutToPreview('italic'); return; }
      if (k === 'k') { e.preventDefault(); isSource ? format('link') : applyShortcutToPreview('link'); return; }
      const code = e.code || '';
      let action = null;
      if (e.shiftKey && (k === '*' || k === '8' || code === 'Digit8')) action = 'ul';
      else if (e.shiftKey && (k === '&' || k === '7' || code === 'Digit7')) action = 'ol';
      else if (e.shiftKey && (k === '>' || k === '.' || code === 'Period')) action = 'quote';
      else if (e.shiftKey && (k === '~' || k === '`' || code === 'Backquote')) action = 'codeblock';
      else if (!e.shiftKey && (k === '`' || code === 'Backquote')) action = 'inlinecode';
      if (action) {
        e.preventDefault();
        isSource ? format(action) : applyShortcutToPreview(action);
        return;
      }
      if (/^[1-6]$/.test(e.key)) {
        e.preventDefault();
        const level = e.key;
        isSource ? format('heading', level) : applyShortcutToPreview('heading', level);
      }
    });
  }

  // ── 文档协作：批注、伴随文件与辅助阅读 ──
  const MODEL_PROVIDER_DEFAULTS = {
    'openai-compatible': 'https://api.openai.com/v1',
    openai: 'https://api.openai.com/v1',
    bailian: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    deepseek: 'https://api.deepseek.com/v1',
    custom: ''
  };
  const MODEL_PROVIDER_MODELS = {
    'openai-compatible': ['gpt-4.1-mini'],
    openai: ['gpt-4.1-mini'],
    bailian: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-flash', 'deepseek-v4-pro', 'glm-5.2'],
    deepseek: ['deepseek-chat']
  };
  const LEGACY_BAILIAN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

  function parseJsonStorage(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value && typeof value === 'object' ? value : fallback;
    } catch (error) { return fallback; }
  }

  function loadReviewStore() {
    const saved = parseJsonStorage(REVIEW_STORAGE_KEY, null);
    reviewStore = saved && saved.schemaVersion === 1 && saved.documents
      ? saved
      : { schemaVersion: 1, documents: {} };
  }

  function persistReviewStore() {
    try { localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(reviewStore)); }
    catch (error) { console.warn('批注数据保存失败', error); }
  }

  function reviewStateFor(docId) {
    if (!docId) return { comments: [], readingProgress: 0, sidecar: { status: 'local' }, ai: null };
    if (!reviewStore.documents[docId]) {
      reviewStore.documents[docId] = { comments: [], readingProgress: 0, sidecar: { status: 'local' }, ai: null };
    }
    const review = reviewStore.documents[docId];
    if (!Array.isArray(review.comments)) review.comments = [];
    if (!review.sidecar || typeof review.sidecar !== 'object') review.sidecar = { status: 'local' };
    return review;
  }

  function currentReviewState() { return reviewStateFor(state.currentDocId); }
  function currentComments() { return currentReviewState().comments; }

  function migrateReviewDocumentId(oldId, nextId) {
    if (!oldId || !nextId || oldId === nextId || !reviewStore.documents[oldId]) return;
    if (!reviewStore.documents[nextId]) reviewStore.documents[nextId] = reviewStore.documents[oldId];
    delete reviewStore.documents[oldId];
    persistReviewStore();
  }

  function normalizeCommentText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function reviewHash(value) {
    let hash = 0x811c9dc5;
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function headingPathAt(markdown, offset) {
    const stack = [];
    const before = String(markdown || '').slice(0, Math.max(0, offset));
    let inFence = false;
    before.split('\n').forEach((line) => {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
      if (inFence) return;
      const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (!match) return;
      const level = match[1].length;
      stack.length = level - 1;
      stack[level - 1] = match[2].trim();
    });
    return stack.filter(Boolean);
  }

  function markdownToPlain(markdown) {
    const source = String(markdown || '');
    if (typeof marked === 'undefined') return normalizeCommentText(source.replace(/[#*_~`>\[\]()-]/g, ' '));
    const holder = document.createElement('div');
    holder.innerHTML = marked.parse(source);
    return normalizeCommentText(holder.textContent);
  }

  function sourceBlockBounds(markdown, start, end) {
    const text = String(markdown || '');
    let blockStart = text.lastIndexOf('\n\n', Math.max(0, start - 1));
    blockStart = blockStart < 0 ? 0 : blockStart + 2;
    let blockEnd = text.indexOf('\n\n', Math.max(end, blockStart));
    if (blockEnd < 0) blockEnd = text.length;
    return { start: blockStart, end: blockEnd };
  }

  function findTextRange(markdown, selectedText, anchor) {
    const text = String(markdown || '');
    const needle = String(selectedText || '');
    if (!needle) return null;
    const saved = anchor && anchor.sourceRange;
    if (saved && saved.start >= 0 && saved.end <= text.length) {
      const savedRaw = text.slice(saved.start, saved.end);
      if (savedRaw === anchor.selectedMarkdown || normalizeCommentText(savedRaw) === normalizeCommentText(needle)) {
        return { start: saved.start, end: saved.end, strategy: 'saved-range' };
      }
    }
    const occurrences = [];
    let from = 0;
    while (from <= text.length) {
      const index = text.indexOf(needle, from);
      if (index < 0) break;
      occurrences.push(index);
      from = index + Math.max(1, needle.length);
    }
    if (!occurrences.length) return null;
    let best = occurrences[0], score = -1;
    occurrences.forEach((index) => {
      let candidate = 0;
      if (anchor?.prefix && normalizeCommentText(text.slice(Math.max(0, index - 100), index)).endsWith(anchor.prefix)) candidate += 2;
      if (anchor?.suffix && normalizeCommentText(text.slice(index + needle.length, index + needle.length + 100)).startsWith(anchor.suffix)) candidate += 2;
      if (anchor?.headingPath?.length && headingPathAt(text, index).join('>') === anchor.headingPath.join('>')) candidate += 3;
      if (candidate > score) { best = index; score = candidate; }
    });
    return { start: best, end: best + needle.length, strategy: score > 0 ? 'exact-context' : 'exact-text' };
  }

  function topPreviewBlock(node) {
    let element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (element && element.parentElement !== els.previewEditor) element = element.parentElement;
    return element && element.parentElement === els.previewEditor ? element : null;
  }

  function previewBlocks() { return [...els.previewEditor.children]; }

  function sourceSelectionAnchorPure(markdown, start, end) {
    if (start === end) return null;
    const source = String(markdown || '');
    const safeStart = Math.max(0, Math.min(source.length, Number(start) || 0));
    const safeEnd = Math.max(safeStart, Math.min(source.length, Number(end) || 0));
    const selectedMarkdown = source.slice(safeStart, safeEnd);
    if (!selectedMarkdown.trim()) return null;
    const bounds = sourceBlockBounds(source, safeStart, safeEnd);
    if (/\n\s*\n/.test(selectedMarkdown) || safeStart < bounds.start || safeEnd > bounds.end) return null;
    const selectedText = markdownToPlain(selectedMarkdown);
    if (!selectedText) return null;
    const blockMarkdown = source.slice(bounds.start, bounds.end);
    return {
      mode: 'selection', selectedText, selectedMarkdown,
      prefix: normalizeCommentText(source.slice(Math.max(bounds.start, safeStart - 80), safeStart)),
      suffix: normalizeCommentText(source.slice(safeEnd, Math.min(bounds.end, safeEnd + 80))),
      headingPath: headingPathAt(source, safeStart),
      blockText: markdownToPlain(blockMarkdown),
      sourceRange: { start: safeStart, end: safeEnd }, blockRange: bounds
    };
  }

  function buildSourceSelectionAnchor() {
    const start = els.sourceEditor.selectionStart;
    const end = els.sourceEditor.selectionEnd;
    const anchor = sourceSelectionAnchorPure(getCurrentMarkdown(), start, end);
    if (!anchor && start !== end) tip('一次批注请选择同一内容块中的文字');
    return anchor;
  }

  function buildPreviewSelectionAnchor(range) {
    if (!range || range.collapsed) return null;
    const startBlock = topPreviewBlock(range.startContainer);
    const endBlock = topPreviewBlock(range.endContainer);
    if (!startBlock || startBlock !== endBlock) {
      tip('一次批注请选择同一段落、列表或内容块中的文字');
      return null;
    }
    const selectedText = normalizeCommentText(range.toString());
    if (!selectedText) return null;
    const blockText = normalizeCommentText(startBlock.textContent);
    const index = blockText.indexOf(selectedText);
    const markdown = getCurrentMarkdown();
    const found = findTextRange(markdown, selectedText, null);
    return {
      mode: 'selection', selectedText, selectedMarkdown: selectedText,
      prefix: index >= 0 ? normalizeCommentText(blockText.slice(Math.max(0, index - 80), index)) : '',
      suffix: index >= 0 ? normalizeCommentText(blockText.slice(index + selectedText.length, index + selectedText.length + 80)) : '',
      headingPath: headingPathAt(markdown, found?.start || 0),
      blockText,
      blockIndex: previewBlocks().indexOf(startBlock),
      sourceRange: found ? { start: found.start, end: found.end } : null
    };
  }

  function buildBlockAnchor(block) {
    if (!block) return null;
    const blockText = normalizeCommentText(block.textContent);
    const markdown = getCurrentMarkdown();
    const found = findTextRange(markdown, blockText, null);
    return {
      mode: 'block', selectedText: blockText, selectedMarkdown: '', prefix: '', suffix: '',
      headingPath: headingPathAt(markdown, found?.start || 0), blockText,
      blockIndex: previewBlocks().indexOf(block),
      sourceRange: found ? { start: found.start, end: found.end } : null
    };
  }

  function resolvePreviewBlock(anchor) {
    const blocks = previewBlocks();
    if (Number.isInteger(anchor?.blockIndex)) {
      const indexed = blocks[anchor.blockIndex];
      if (indexed && normalizeCommentText(indexed.textContent).includes(anchor.selectedText)) return indexed;
    }
    const exactBlock = blocks.find((block) => normalizeCommentText(block.textContent) === anchor?.blockText);
    if (exactBlock) return exactBlock;
    return blocks.find((block) => normalizeCommentText(block.textContent).includes(anchor?.selectedText || '')) || null;
  }

  function wrapTextMatch(root, selectedText, className, commentIds) {
    if (!root || !selectedText) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let combined = '', node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue) continue;
      nodes.push({ node, start: combined.length, end: combined.length + node.nodeValue.length });
      combined += node.nodeValue;
    }
    const startIndex = combined.indexOf(selectedText);
    if (startIndex < 0) return null;
    const endIndex = startIndex + selectedText.length;
    const startEntry = nodes.find((entry) => startIndex >= entry.start && startIndex < entry.end);
    const endEntry = nodes.find((entry) => endIndex > entry.start && endIndex <= entry.end);
    if (!startEntry || !endEntry) return null;
    const range = document.createRange();
    range.setStart(startEntry.node, startIndex - startEntry.start);
    range.setEnd(endEntry.node, endIndex - endEntry.start);
    const wrapper = document.createElement('span');
    wrapper.className = className;
    if (commentIds?.length) wrapper.dataset.commentIds = commentIds.join(' ');
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
    return wrapper;
  }

  function renderCommentAnnotations() {
    if (!els.previewEditor) return;
    const comments = currentComments();
    const selectionGroups = new Map();
    comments.forEach((comment) => {
      const block = resolvePreviewBlock(comment.anchor);
      if (!block) {
        comment.relocation = { state: 'orphaned', strategy: 'not-found' };
        return;
      }
      comment.relocation = { state: 'matched', strategy: comment.anchor.sourceRange ? 'saved-range' : 'exact-text' };
      if (comment.anchor.mode === 'block') {
        block.classList.add('app-block-comment-anchor');
        const ids = (block.dataset.commentIds || '').split(' ').filter(Boolean);
        ids.push(comment.id);
        block.dataset.commentIds = [...new Set(ids)].join(' ');
        return;
      }
      const key = `${previewBlocks().indexOf(block)}\n${comment.anchor.selectedText}`;
      if (!selectionGroups.has(key)) selectionGroups.set(key, { block, text: comment.anchor.selectedText, ids: [] });
      selectionGroups.get(key).ids.push(comment.id);
    });
    selectionGroups.forEach((group) => wrapTextMatch(group.block, group.text, 'app-comment-anchor', group.ids));
    els.previewEditor.querySelectorAll('.app-comment-anchor, .app-block-comment-anchor').forEach((anchor) => {
      anchor.setAttribute('role', 'button');
      anchor.tabIndex = 0;
      anchor.setAttribute('aria-label', '查看批注');
      const ids = (anchor.dataset.commentIds || '').split(' ').filter(Boolean);
      if (ids.includes(activeCommentId)) anchor.classList.add('is-active');
    });
    if (draftCommentAnchor && !editingCommentId) {
      const block = resolvePreviewBlock(draftCommentAnchor);
      if (block) {
        if (draftCommentAnchor.mode === 'block') block.classList.add('app-comment-block-target');
        else wrapTextMatch(block, draftCommentAnchor.selectedText, 'app-comment-draft');
      }
    } else if (selectedPreviewBlock && selectedPreviewBlock.isConnected && els.collabDrawer.classList.contains('is-open')) {
      selectedPreviewBlock.classList.add('app-comment-block-target');
    }
  }

  function formatReviewTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '刚刚' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function focusComment(commentId) {
    const comment = currentComments().find((item) => item.id === commentId);
    if (!comment) return;
    activeCommentId = commentId;
    openCollabDrawer('comments');
    renderPreview();
    renderCommentList();
    const anchor = els.previewEditor.querySelector(`[data-comment-ids~="${commentId}"]`);
    if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
    els.commentList.querySelector(`[data-comment-id="${commentId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderCommentList() {
    if (!els.commentList) return;
    const comments = currentComments();
    els.commentList.replaceChildren();
    if (!comments.length) {
      const empty = document.createElement('div');
      empty.className = 'app-comment-empty';
      empty.textContent = '暂无批注。选择文字或在预览中点击内容块后添加。';
      els.commentList.appendChild(empty);
    }
    comments.forEach((comment) => {
      const card = document.createElement('article');
      card.className = 'app-comment-card';
      card.dataset.commentId = comment.id;
      if (comment.id === activeCommentId) card.classList.add('is-focused');
      if (comment.relocation?.state === 'orphaned') card.classList.add('is-orphaned');
      const head = document.createElement('div');
      head.className = 'app-comment-card__head';
      const quote = document.createElement('button');
      quote.type = 'button';
      quote.className = 'app-comment-card__quote';
      quote.textContent = `“${comment.anchor.selectedText}”`;
      quote.title = comment.anchor.selectedText;
      quote.addEventListener('click', () => focusComment(comment.id));
      const actions = document.createElement('div');
      actions.className = 'app-comment-card__actions';
      const edit = document.createElement('button');
      edit.type = 'button'; edit.title = '编辑批注'; edit.setAttribute('aria-label', '编辑批注'); edit.innerHTML = ICON_RENAME;
      edit.addEventListener('click', () => openCommentEditor(comment.id));
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'is-delete'; remove.title = '删除批注'; remove.setAttribute('aria-label', '删除批注'); remove.innerHTML = ICON_DELETE;
      remove.addEventListener('click', () => openDeleteComment(comment.id));
      actions.append(edit, remove);
      head.append(quote, actions);
      const instruction = document.createElement('p');
      instruction.textContent = comment.instruction;
      const meta = document.createElement('small');
      const scope = comment.anchor.mode === 'block' ? '整块' : '所选文字';
      const relocation = comment.relocation?.state === 'orphaned' ? ' · 原文已变化，待重新关联' : '';
      meta.textContent = `${scope} · ${formatReviewTime(comment.updatedAt)}${relocation}`;
      card.append(head, instruction, meta);
      els.commentList.appendChild(card);
    });
    const count = comments.filter((comment) => comment.status !== 'resolved').length;
    els.commentCount.textContent = String(count);
    els.commentCount.hidden = count === 0;
    $('drawer-comment-count').textContent = String(count);
  }

  function openCollabDrawer(panel) {
    els.collabDrawer.classList.add('is-open');
    els.collabDrawer.setAttribute('aria-hidden', 'false');
    document.querySelector('.app-shell').classList.add('collab-open');
    els.btnComments.classList.add('is-active');
    els.btnComments.setAttribute('aria-expanded', 'true');
    els.drawerMask.hidden = window.innerWidth >= 1180;
    showCollabPanel(panel || 'comments');
  }

  function closeCollabDrawer() {
    els.collabDrawer.classList.remove('is-open');
    els.collabDrawer.setAttribute('aria-hidden', 'true');
    document.querySelector('.app-shell').classList.remove('collab-open');
    els.btnComments.classList.remove('is-active');
    els.btnComments.setAttribute('aria-expanded', 'false');
    els.drawerMask.hidden = true;
    activeCommentId = null;
    selectedPreviewBlock = null;
    closeCommentComposer();
    renderPreview();
  }

  function showCollabPanel(name) {
    document.querySelectorAll('[data-collab-panel]').forEach((button) => {
      const active = button.dataset.collabPanel === name;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-collab-content]').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.collabContent === name));
  }

  function openCommentComposer() {
    if (!draftCommentAnchor) {
      if (selectedPreviewBlock?.isConnected) draftCommentAnchor = buildBlockAnchor(selectedPreviewBlock);
      else { openCollabDrawer('comments'); tip('请先选择文字，或在预览中点击需要批注的内容块'); return; }
    }
    openCollabDrawer('comments');
    const editing = editingCommentId && currentComments().find((comment) => comment.id === editingCommentId);
    els.composerTitle.textContent = editing ? '编辑批注' : '新建批注';
    els.composerScope.textContent = draftCommentAnchor.mode === 'block' ? '整块' : '所选文字';
    els.composerQuote.textContent = draftCommentAnchor.selectedText;
    els.commentInput.value = editing ? editing.instruction : '';
    els.btnSubmitComment.textContent = editing ? '保存' : '添加';
    els.commentComposer.hidden = false;
    renderPreview();
    els.commentInput.focus();
  }

  function closeCommentComposer() {
    if (!els.commentComposer) return;
    els.commentComposer.hidden = true;
    els.commentInput.value = '';
    draftCommentAnchor = null;
    editingCommentId = null;
  }

  function openCommentEditor(commentId) {
    const comment = currentComments().find((item) => item.id === commentId);
    if (!comment) return;
    editingCommentId = commentId;
    activeCommentId = commentId;
    draftCommentAnchor = JSON.parse(JSON.stringify(comment.anchor));
    openCommentComposer();
  }

  function setModalOpen(modal, open) {
    modal.hidden = !open;
    modal.setAttribute('aria-hidden', String(!open));
    document.body.classList.toggle('has-modal', open || [...document.querySelectorAll('.app-modal-backdrop')].some((item) => item !== modal && !item.hidden));
  }

  function openDeleteComment(commentId) {
    const comment = currentComments().find((item) => item.id === commentId);
    if (!comment) return;
    deletingCommentId = commentId;
    els.deleteCommentPreview.textContent = comment.instruction;
    setModalOpen(els.deleteCommentModal, true);
  }

  function closeDeleteComment() {
    deletingCommentId = null;
    setModalOpen(els.deleteCommentModal, false);
  }

  function documentFileName(doc) {
    return doc?.localFileName || `${safeFileName(doc?.name || '未命名文档')}.md`;
  }

  function reviewFileNames(doc) {
    const fileName = documentFileName(doc);
    const base = fileName.replace(/\.(md|markdown|txt)$/i, '');
    return { json: `${base}.review.json`, markdown: `${base}.REVIEW.md` };
  }

  function reviewPayload(doc) {
    const review = reviewStateFor(doc.id);
    return {
      schemaVersion: '1.0',
      document: {
        id: doc.id,
        title: documentFileName(doc),
        path: doc.relativePath || documentFileName(doc),
        sourceKind: doc.sourceKind || 'browser',
        version: { algorithm: 'fnv1a-32', value: reviewHash(doc.content) }
      },
      comments: review.comments.map((comment) => ({
        id: comment.id,
        instruction: comment.instruction,
        status: comment.status,
        anchor: comment.anchor,
        relocation: comment.relocation,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt
      })),
      exportedAt: new Date().toISOString()
    };
  }

  function reviewMarkdown(doc) {
    const review = reviewStateFor(doc.id);
    const lines = [
      '# 文档协作任务', '',
      `- 目标文件：${documentFileName(doc)}`,
      `- 文档标识：${doc.id}`,
      `- 文档版本：${reviewHash(doc.content)}`, '',
      '## 待处理批注', ''
    ];
    const comments = review.comments.filter((comment) => comment.status !== 'resolved');
    if (!comments.length) lines.push('当前没有待处理批注。', '');
    comments.forEach((comment, index) => {
      lines.push(
        `### ${index + 1}. ${comment.anchor.headingPath?.join(' > ') || '未命名位置'}`,
        `- ID：${comment.id}`,
        `- 原文：${comment.anchor.selectedText.replace(/\n/g, ' ')}`,
        `- 批注：${comment.instruction.replace(/\n/g, ' ')}`,
        `- 状态：${comment.status}`, ''
      );
    });
    lines.push('请结合批注处理目标 Markdown 文件；无法判断是否需要修改时保留批注并说明原因，不要把批注内容写入 Markdown 正文。');
    return lines.join('\n');
  }

  function updateSidecarState(status, message) {
    const review = currentReviewState();
    review.sidecar.status = status;
    review.sidecar.message = message || '';
    if (!els.reviewSyncState) return;
    const labels = {
      syncing: '同步中…', synced: '已同步到目录', local: '仅本地',
      'authorization-required': '待授权目录', error: '同步失败', conflict: '同步冲突'
    };
    els.reviewSyncState.textContent = message || labels[status] || '仅本地';
    els.reviewSyncState.className = `app-sync-state is-${status}`;
  }

  async function sidecarDirectoryForDoc(doc, interactive) {
    if (isDirectoryDoc(doc)) {
      const directory = directoryForDoc(doc);
      if (!directory?.handle || !await ensureReadWritePermission(directory.handle)) return null;
      const parts = normalizeRelativePath(doc.relativePath).split('/');
      parts.pop();
      return directoryHandleAtPath(directory.handle, parts);
    }
    if (isLocalFileDoc(doc) && doc.fileHandle) {
      if (doc.directoryHandle) {
        try {
          if (await ensureReadWritePermission(doc.directoryHandle) && await matchingFileInDirectory(doc.directoryHandle, doc.fileHandle)) return doc.directoryHandle;
        } catch (error) { doc.directoryHandle = null; }
      }
      if (!interactive) return null;
      const directory = await selectParentDirectory(doc);
      await persistDocHandles(doc);
      return directory;
    }
    return null;
  }

  async function existingSidecar(directory, name) {
    try {
      const handle = await directory.getFileHandle(name);
      return { handle, content: await readFileAsText(await handle.getFile()) };
    } catch (error) {
      if (error?.name === 'NotFoundError') return null;
      throw error;
    }
  }

  async function syncReviewSidecars(options) {
    const opts = options || {};
    const doc = currentDoc();
    if (!doc) return false;
    if (!isDiskFileDoc(doc)) {
      updateSidecarState('local');
      persistReviewStore();
      return false;
    }
    updateSidecarState('syncing');
    try {
      const directory = await sidecarDirectoryForDoc(doc, !!opts.interactive);
      if (!directory) {
        updateSidecarState('authorization-required');
        persistReviewStore();
        return false;
      }
      const names = reviewFileNames(doc);
      const json = JSON.stringify(reviewPayload(doc), null, 2);
      const markdown = reviewMarkdown(doc);
      const review = reviewStateFor(doc.id);
      const targets = [
        { key: 'json', name: names.json, content: json },
        { key: 'markdown', name: names.markdown, content: markdown }
      ];
      for (const target of targets) {
        const existing = await existingSidecar(directory, target.name);
        const expected = review.sidecar[`${target.key}Hash`];
        if (existing && existing.content !== target.content) {
          const existingHash = reviewHash(existing.content);
          if (!expected || existingHash !== expected) {
            updateSidecarState('conflict', `${target.name} 已被外部修改`);
            persistReviewStore();
            return false;
          }
        }
        target.handle = existing?.handle || null;
      }
      for (const target of targets) {
        if (!target.handle) target.handle = await directory.getFileHandle(target.name, { create: true });
        await writeToFileHandle(target.handle, target.content);
        review.sidecar[`${target.key}Hash`] = reviewHash(target.content);
      }
      review.sidecar.lastSyncedAt = new Date().toISOString();
      updateSidecarState('synced');
      persistReviewStore();
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') updateSidecarState('authorization-required');
      else updateSidecarState('error', error?.message || '同步失败');
      persistReviewStore();
      if (opts.interactive && error?.name !== 'AbortError') tip(`伴随文件同步失败：${error?.message || '未知错误'}`);
      return false;
    }
  }

  function scheduleReviewSidecarSync() {
    clearTimeout(reviewSyncTimer);
    const doc = currentDoc();
    if (!doc || !isDiskFileDoc(doc)) {
      updateSidecarState('local');
      return;
    }
    if (isLocalFileDoc(doc) && !doc.directoryHandle) {
      updateSidecarState('authorization-required');
      return;
    }
    updateSidecarState('syncing');
    reviewSyncTimer = setTimeout(() => syncReviewSidecars({ interactive: false }), REVIEW_SYNC_DEBOUNCE);
  }

  function updateSidecarPreview() {
    const doc = currentDoc();
    if (!doc) return;
    els.sidecarContent.textContent = sidecarFormat === 'json'
      ? JSON.stringify(reviewPayload(doc), null, 2)
      : reviewMarkdown(doc);
    document.querySelectorAll('[data-sidecar-format]').forEach((button) => button.classList.toggle('is-active', button.dataset.sidecarFormat === sidecarFormat));
    els.btnSidecarSync.hidden = !isDiskFileDoc(doc);
    els.btnSidecarSync.textContent = isLocalFileDoc(doc) && !doc.directoryHandle ? '授权目录并同步' : '同步到文档目录';
  }

  function downloadReview(format) {
    const doc = currentDoc();
    if (!doc) return;
    const names = reviewFileNames(doc);
    const content = format === 'json' ? JSON.stringify(reviewPayload(doc), null, 2) : reviewMarkdown(doc);
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = format === 'json' ? names.json : names.markdown;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  }

  function loadModelConfig() {
    const metadata = parseJsonStorage(MODEL_CONFIG_KEY, {});
    const apiKey = sessionStorage.getItem(MODEL_SESSION_KEY) || localStorage.getItem(MODEL_PERSISTENT_KEY) || '';
    const provider = metadata.provider || 'openai-compatible';
    const usedLegacyBailianDefault = provider === 'bailian' && metadata.baseUrl === LEGACY_BAILIAN_BASE_URL;
    modelConfig = {
      provider,
      baseUrl: usedLegacyBailianDefault
        ? MODEL_PROVIDER_DEFAULTS.bailian
        : (metadata.baseUrl || MODEL_PROVIDER_DEFAULTS[provider] || MODEL_PROVIDER_DEFAULTS['openai-compatible']),
      model: usedLegacyBailianDefault && metadata.model === 'qwen-plus'
        ? MODEL_PROVIDER_MODELS.bailian[0]
        : (metadata.model || ''),
      apiKey,
      remember: Boolean(localStorage.getItem(MODEL_PERSISTENT_KEY))
    };
  }

  function modelReady() { return Boolean(modelConfig?.baseUrl && modelConfig?.model && modelConfig?.apiKey); }

  function updateModelUI() {
    const ready = modelReady();
    els.modelState.textContent = ready ? `${modelConfig.model} 已配置` : '未配置模型';
    els.modelState.classList.toggle('is-ready', ready);
    els.btnGenerateSummary.disabled = !ready || !!activeReadingRequest;
  }

  function updateModelControl(provider, currentModel = '') {
    const candidates = MODEL_PROVIDER_MODELS[provider] || [];
    const useCustomInput = provider === 'custom' || !candidates.length;
    els.modelName.hidden = useCustomInput;
    els.modelNameCustom.hidden = !useCustomInput;
    if (useCustomInput) {
      els.modelName.replaceChildren();
      els.modelNameCustom.value = currentModel;
      return;
    }

    const selectedModel = currentModel || candidates[0];
    const options = candidates.map((model) => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      return option;
    });
    if (selectedModel && !candidates.includes(selectedModel)) {
      const option = document.createElement('option');
      option.value = selectedModel;
      option.textContent = `${selectedModel}（当前配置）`;
      options.unshift(option);
    }
    els.modelName.replaceChildren(...options);
    els.modelName.value = selectedModel;
    els.modelNameCustom.value = '';
  }

  function fillModelForm() {
    els.modelProvider.value = modelConfig.provider;
    updateModelControl(modelConfig.provider, modelConfig.model);
    els.modelBaseUrl.value = modelConfig.baseUrl;
    els.modelApiKey.value = modelConfig.apiKey;
    els.rememberApiKey.checked = modelConfig.remember;
  }

  function readModelForm() {
    return {
      provider: els.modelProvider.value,
      baseUrl: els.modelBaseUrl.value.trim().replace(/\/+$/, ''),
      model: (els.modelProvider.value === 'custom' ? els.modelNameCustom.value : els.modelName.value).trim(),
      apiKey: els.modelApiKey.value.trim(),
      remember: els.rememberApiKey.checked
    };
  }

  function saveModelConfig(next) {
    modelConfig = next;
    localStorage.setItem(MODEL_CONFIG_KEY, JSON.stringify({ provider: next.provider, baseUrl: next.baseUrl, model: next.model }));
    if (next.apiKey) sessionStorage.setItem(MODEL_SESSION_KEY, next.apiKey);
    else sessionStorage.removeItem(MODEL_SESSION_KEY);
    if (next.remember && next.apiKey) localStorage.setItem(MODEL_PERSISTENT_KEY, next.apiKey);
    else localStorage.removeItem(MODEL_PERSISTENT_KEY);
    updateModelUI();
  }

  function chatCompletionUrl(baseUrl) {
    const normalized = String(baseUrl || '').replace(/\/+$/, '');
    let url;
    try { url = new URL(/\/chat\/completions$/i.test(normalized) ? normalized : `${normalized}/chat/completions`); }
    catch (error) { throw new Error('服务地址格式不正确，请填写完整的 http:// 或 https:// 地址'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务地址仅支持 http:// 或 https://');
    return url.href;
  }

  function modelCatalogUrl(baseUrl) {
    const completionUrl = new URL(chatCompletionUrl(baseUrl));
    completionUrl.pathname = completionUrl.pathname.replace(/\/chat\/completions$/i, '/models');
    completionUrl.search = '';
    completionUrl.hash = '';
    return completionUrl.href;
  }

  function isBailianConfig(config) {
    if (config?.provider === 'bailian') return true;
    try {
      return /(^|\.)dashscope(?:-intl)?\.aliyuncs\.com$/i.test(new URL(config?.baseUrl || '').hostname)
        || /(^|\.)maas\.aliyuncs\.com$/i.test(new URL(config?.baseUrl || '').hostname);
    }
    catch (error) { return false; }
  }

  function canUseLocalModelProxy() {
    return window.location.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname);
  }

  async function detectLocalModelProxy() {
    if (!canUseLocalModelProxy()) return false;
    if (localModelProxyAvailable) return true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(AI_PROXY_HEALTH_PATH, { cache: 'no-store', signal: controller.signal });
      localModelProxyAvailable = response.ok && response.headers.get(AI_PROXY_HEADER) === '1';
      return localModelProxyAvailable;
    } catch (error) {
      return false;
    } finally { clearTimeout(timer); }
  }

  async function localProxyFetch(targetUrl, payload, apiKey, signal) {
    const response = await fetch(AI_PROXY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ targetUrl, payload }),
      signal
    });
    if (response.headers.get(AI_PROXY_HEADER) !== '1') {
      localModelProxyAvailable = false;
      throw new Error('本机模型转发服务响应异常，请刷新页面后重试');
    }
    return { response, transport: 'local-proxy' };
  }

  async function localProxyCatalogFetch(targetUrl, apiKey, signal) {
    const response = await fetch(AI_PROXY_MODELS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ targetUrl }),
      signal
    });
    if (response.headers.get(AI_PROXY_HEADER) !== '1') {
      localModelProxyAvailable = false;
      throw new Error('本机模型转发服务响应异常，请刷新页面后重试');
    }
    return { response, transport: 'local-proxy' };
  }

  async function modelFetch(targetUrl, payload, apiKey, signal) {
    modelFetch.lastTransport = null;
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal
    };
    if (await detectLocalModelProxy()) {
      modelFetch.lastTransport = 'local-proxy';
      return localProxyFetch(targetUrl, payload, apiKey, signal);
    }
    try {
      modelFetch.lastTransport = 'direct';
      return { response: await fetch(targetUrl, request), transport: 'direct' };
    } catch (error) {
      if (!(error instanceof TypeError) || !canUseLocalModelProxy()) throw error;
    }

    try {
      if (await detectLocalModelProxy()) {
        modelFetch.lastTransport = 'local-proxy';
        return await localProxyFetch(targetUrl, payload, apiKey, signal);
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new Error('浏览器直连失败，且无法连接本机模型转发服务；请使用项目提供的本地启动脚本重新打开');
    }
    throw new Error('浏览器直连失败；当前本地服务未启用模型转发，请使用项目提供的本地启动脚本重新打开');
  }

  async function requestModel(messages, config, timeout, options = {}) {
    const controller = new AbortController();
    const timeoutMs = timeout || AI_GENERATION_TIMEOUT;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    requestModel.lastTransport = null;
    try {
      const payload = { model: config.model, temperature: 0.2, messages };
      if (options.maxTokens) payload.max_tokens = options.maxTokens;
      const { response, transport } = await modelFetch(chatCompletionUrl(config.baseUrl), payload, config.apiKey, controller.signal);
      requestModel.lastTransport = transport;
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json())?.error?.message || ''; } catch (error) { /* 非 JSON 错误响应 */ }
        throw new Error(detail || `请求失败（HTTP ${response.status}）`);
      }
      const responsePayload = await response.json();
      const content = responsePayload?.choices?.[0]?.message?.content;
      if (!content) throw new Error('模型未返回可读取内容');
      return content;
    } catch (error) {
      requestModel.lastTransport ||= modelFetch.lastTransport;
      if (error?.name === 'AbortError') {
        const service = isBailianConfig(config) ? '阿里百炼云Token Plan' : '模型服务';
        const route = requestModel.lastTransport === 'local-proxy' ? '本机转发已连通，但' : '';
        throw new Error(`${route}${service}在 ${Math.ceil(timeoutMs / 1000)} 秒内未返回，请检查模型名称、额度或限流状态`);
      }
      if (error instanceof TypeError) throw new Error('浏览器未能建立模型请求，请检查服务地址、代理、证书、DNS 或浏览器扩展');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function testModelConnection(config) {
    if (!isBailianConfig(config)) {
      await requestModel([{ role: 'user', content: '只回复 OK。' }], config, AI_CONNECTION_TIMEOUT, { maxTokens: 8 });
      return requestModel.lastTransport;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_CONNECTION_TIMEOUT);
    let transport = null;
    try {
      let response;
      const targetUrl = modelCatalogUrl(config.baseUrl);
      if (await detectLocalModelProxy()) {
        transport = 'local-proxy';
        ({ response } = await localProxyCatalogFetch(targetUrl, config.apiKey, controller.signal));
      } else {
        transport = 'direct';
        response = await fetch(targetUrl, {
          headers: { Authorization: `Bearer ${config.apiKey}` },
          signal: controller.signal
        });
      }
      requestModel.lastTransport = transport;
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json())?.error?.message || ''; } catch (error) { /* 非 JSON 错误响应 */ }
        throw new Error(detail || `请求失败（HTTP ${response.status}）`);
      }
      await response.json();
      return transport;
    } catch (error) {
      requestModel.lastTransport = transport;
      if (error?.name === 'AbortError') {
        const route = transport === 'local-proxy' ? '本机转发已连通，但' : '';
        throw new Error(`${route}阿里百炼云Token Plan 鉴权接口在 ${AI_CONNECTION_TIMEOUT / 1000} 秒内未返回`);
      }
      if (error instanceof TypeError) throw new Error('浏览器未能连接阿里百炼云Token Plan，请检查代理、证书、DNS 或浏览器扩展');
      throw error;
    } finally { clearTimeout(timer); }
  }

  function parseAiReadingResponse(content, markdown) {
    let raw = content;
    if (typeof raw === 'string') raw = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (error) { throw new Error('模型返回的结果不是有效 JSON，请重试'); }
    const normalizeItems = (items) => (Array.isArray(items) ? items : []).slice(0, 8).map((item, index) => {
      const value = typeof item === 'string' ? { text: item } : (item || {});
      const text = String(value.text || value.content || '').trim();
      if (!text) return null;
      const quote = String(value.quote || '').trim();
      return {
        title: String(value.title || `第 ${index + 1} 项`).trim(), text,
        quote: quote && String(markdown || '').includes(quote) ? quote : '',
        severity: String(value.severity || '').trim()
      };
    }).filter(Boolean);
    const result = {
      summary: normalizeItems(parsed?.summary || parsed?.overview),
      details: normalizeItems(parsed?.details || parsed?.keyDetails),
      risks: normalizeItems(parsed?.risks || parsed?.warnings)
    };
    if (!result.summary.length && !result.details.length && !result.risks.length) throw new Error('模型返回的结果为空或结构不符合要求');
    return result;
  }

  function readingQuotePlainCandidates(quote) {
    const source = String(quote || '').trim();
    if (!source) return [];
    return [...new Set([source, ...source.split(/\n+/)]
      .map((part) => normalizeCommentText(markdownToPlain(part)))
      .filter(Boolean))];
  }

  function findPreviewTargetForQuote(quote) {
    const candidates = readingQuotePlainCandidates(quote);
    if (!candidates.length) return null;
    const targets = [...els.previewEditor.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, table')];
    let best = null;
    let bestScore = 0;
    targets.forEach((target) => {
      const targetText = normalizeCommentText(target.textContent);
      if (!targetText) return;
      candidates.forEach((candidate) => {
        let score = 0;
        if (targetText === candidate) score = 10000 + candidate.length;
        else if (targetText.includes(candidate)) score = candidate.length * 2;
        else if (targetText.length >= 8 && candidate.includes(targetText)) score = targetText.length;
        if (score > bestScore) { best = target; bestScore = score; }
      });
    });
    return best;
  }

  function flashReadingLocation(target) {
    if (!target) return false;
    els.previewEditor.querySelectorAll('.app-comment-locate').forEach((item) => item.classList.remove('app-comment-locate'));
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('app-comment-locate');
    setTimeout(() => target.classList.remove('app-comment-locate'), 1250);
    return true;
  }

  function locateReadingQuote(quote) {
    if (!quote) return false;
    selectedPreviewBlock = null;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
    const markdown = getCurrentMarkdown();
    const index = markdown.indexOf(quote);

    if (state.viewMode !== 'source') {
      const exactTarget = findPreviewTargetForQuote(quote);
      if (flashReadingLocation(exactTarget)) return true;
      if (index >= 0) {
        const heading = headingPathAt(markdown, index).at(-1);
        const headingTarget = heading && [...els.previewEditor.querySelectorAll('h1, h2, h3, h4, h5, h6')]
          .find((item) => normalizeCommentText(item.textContent) === normalizeCommentText(heading));
        if (flashReadingLocation(headingTarget)) return true;
      }
    }

    if (index >= 0 && state.viewMode !== 'preview') {
      els.sourceEditor.focus();
      setProgrammaticSourceSelection(index, index + quote.length);
      els.sourceEditor.scrollTop = Math.max(0, markdown.slice(0, index).split('\n').length * 22 - els.sourceEditor.clientHeight / 3);
      return true;
    }
    if (index >= 0) tip('原文仍存在，但当前预览未能精确定位');
    return false;
  }

  function renderAiReading() {
    const review = currentReviewState();
    const ai = review.ai;
    els.summaryResults.replaceChildren();
    if (!ai?.result) {
      els.summaryResults.hidden = true;
      els.summaryHint.textContent = '生成重点概览、关键表述与细节，以及文档内部的易错和冲突提醒。';
      return;
    }
    els.summaryResults.hidden = false;
    const stale = ai.stale || ai.documentHash !== reviewHash(getCurrentMarkdown());
    if (stale) {
      const note = document.createElement('div');
      note.className = 'app-reading-stale';
      note.textContent = '正文已变化，以下结果可能过期；重新生成后更新。';
      els.summaryResults.appendChild(note);
    }
    const groups = [
      ['重点概览', 'summary'], ['关键表述与细节', 'details'], ['易错与冲突提醒', 'risks']
    ];
    groups.forEach(([title, key]) => {
      const items = ai.result[key] || [];
      const section = document.createElement('section');
      section.className = 'app-analysis-group';
      const head = document.createElement('div');
      head.className = 'app-analysis-group__head';
      const label = document.createElement('span'); label.textContent = title;
      const count = document.createElement('small'); count.textContent = `${items.length} 项`;
      head.append(label, count); section.appendChild(head);
      if (!items.length) {
        const empty = document.createElement('article');
        empty.className = 'app-summary-item'; empty.textContent = '当前文档未识别到此类内容。'; section.appendChild(empty);
      }
      items.forEach((item) => {
        const article = document.createElement('article');
        article.className = `app-summary-item${key === 'risks' ? ' is-warning' : ''}`;
        const strong = document.createElement('strong'); strong.textContent = item.title;
        const paragraph = document.createElement('p'); paragraph.textContent = item.text;
        article.append(strong, paragraph);
        if (item.quote) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = '定位原文';
          button.addEventListener('click', () => locateReadingQuote(item.quote)); article.appendChild(button);
        }
        section.appendChild(article);
      });
      els.summaryResults.appendChild(section);
    });
    els.summaryHint.textContent = `已依据当前文档生成 ${groups.reduce((sum, [, key]) => sum + (ai.result[key]?.length || 0), 0)} 项结果。`;
  }

  function renderReadingError(message) {
    els.summaryResults.replaceChildren();
    els.summaryResults.hidden = false;
    const error = document.createElement('div');
    error.className = 'app-reading-error'; error.textContent = message;
    els.summaryResults.appendChild(error);
  }

  async function generateAiReading() {
    if (!modelReady() || activeReadingRequest) return;
    const doc = currentDoc();
    const docId = doc.id;
    const markdown = doc.content;
    const documentHash = reviewHash(markdown);
    els.btnGenerateSummary.disabled = true;
    els.btnGenerateSummary.textContent = '正在生成…';
    els.summaryHint.textContent = '正在分析当前文档，生成期间可以继续阅读。';
    const requestToken = { docId, documentHash };
    activeReadingRequest = requestToken;
    try {
      const system = '你是 Markdown 阅读助手。只分析用户提供的当前文档，不引入外部事实，不替用户修改正文。必须只返回 JSON 对象：{"summary":[{"title":"","text":"","quote":""}],"details":[{"title":"","text":"","quote":"原文逐字引用"}],"risks":[{"title":"","text":"","quote":"原文逐字引用","severity":"low|medium|high"}]}。summary 可不含 quote；details 和 risks 在有依据时必须逐字引用原文。没有对应内容就返回空数组。';
      const content = await requestModel([{ role: 'system', content: system }, { role: 'user', content: `请分析以下 Markdown：\n\n${markdown}` }], modelConfig, AI_GENERATION_TIMEOUT);
      const parsed = parseAiReadingResponse(content, markdown);
      if (state.currentDocId !== docId || reviewHash(state.docs.find((item) => item.id === docId)?.content || '') !== documentHash) {
        tip('文档已变化，本次辅助阅读结果未覆盖当前内容');
        return;
      }
      const review = reviewStateFor(docId);
      review.ai = { result: parsed, documentHash, generatedAt: new Date().toISOString(), model: modelConfig.model, stale: false };
      persistReviewStore();
      renderAiReading();
      tip('AI 辅助阅读已生成');
    } catch (error) {
      renderReadingError(error?.message || 'AI 辅助阅读生成失败，请重试');
    } finally {
      if (activeReadingRequest === requestToken) activeReadingRequest = null;
      els.btnGenerateSummary.textContent = '生成 AI 辅助阅读';
      updateModelUI();
    }
  }

  function markCurrentAnalysisStale() {
    const review = currentReviewState();
    if (!review.ai?.result || review.ai.stale) return;
    review.ai.stale = true;
    persistReviewStore();
    if (els.summaryResults) renderAiReading();
  }

  function updateReadingProgress() {
    const max = Math.max(0, els.previewWrap.scrollHeight - els.previewWrap.clientHeight);
    const progress = max > 0 ? Math.max(0, Math.min(100, Math.round((els.previewWrap.scrollTop / max) * 100))) : 100;
    const review = currentReviewState();
    review.readingProgress = progress;
    els.readingProgressLabel.textContent = `已读 ${progress}%`;
    els.readingProgress.setAttribute('aria-valuenow', String(progress));
    els.readingProgress.querySelector('span').style.width = `${progress}%`;
    clearTimeout(readingProgressTimer);
    readingProgressTimer = setTimeout(persistReviewStore, 300);
  }

  function restoreReadingScroll() {
    const progress = Number(currentReviewState().readingProgress) || 0;
    requestAnimationFrame(() => {
      const max = Math.max(0, els.previewWrap.scrollHeight - els.previewWrap.clientHeight);
      els.previewWrap.scrollTop = max * Math.max(0, Math.min(100, progress)) / 100;
    });
  }

  function refreshCollaborationUI() {
    if (!els.collabDrawer) return;
    renderCommentAnnotations();
    renderCommentList();
    const review = currentReviewState();
    const doc = currentDoc();
    const fallbackStatus = isDirectoryDoc(doc) || (isLocalFileDoc(doc) && doc?.fileHandle) ? 'authorization-required' : 'local';
    const effectiveStatus = review.sidecar.status === 'local' && fallbackStatus !== 'local' ? fallbackStatus : (review.sidecar.status || fallbackStatus);
    updateSidecarState(effectiveStatus, effectiveStatus === review.sidecar.status ? (review.sidecar.message || '') : '');
    const progress = Number(review.readingProgress) || 0;
    els.readingProgressLabel.textContent = `已读 ${progress}%`;
    els.readingProgress.setAttribute('aria-valuenow', String(progress));
    els.readingProgress.querySelector('span').style.width = `${progress}%`;
    renderAiReading();
    updateModelUI();
  }

  function bindCollaboration() {
    els.btnComments.addEventListener('click', () => {
      if (!draftCommentAnchor && lastEditSurface === 'source'
        && els.sourceEditor.selectionStart !== els.sourceEditor.selectionEnd) {
        draftCommentAnchor = buildSourceSelectionAnchor();
      }
      if (!draftCommentAnchor && lastEditSurface === 'preview') {
        const previewRange = currentPreviewRange();
        if (previewRange && !previewRange.collapsed) draftCommentAnchor = buildPreviewSelectionAnchor(previewRange);
      }
      if (!draftCommentAnchor && selectedPreviewBlock?.isConnected) draftCommentAnchor = buildBlockAnchor(selectedPreviewBlock);
      if (draftCommentAnchor) { openCommentComposer(); return; }
      els.collabDrawer.classList.contains('is-open') ? closeCollabDrawer() : openCollabDrawer('comments');
    });
    els.btnCloseDrawer.addEventListener('click', closeCollabDrawer);
    els.drawerMask.addEventListener('click', closeCollabDrawer);
    document.querySelectorAll('[data-collab-panel]').forEach((button) => button.addEventListener('click', () => showCollabPanel(button.dataset.collabPanel)));
    els.btnCancelComment.addEventListener('click', closeCommentComposer);
    els.btnSubmitComment.addEventListener('click', () => {
      const instruction = els.commentInput.value.trim();
      if (!instruction) { tip('请输入批注内容'); els.commentInput.focus(); return; }
      const comments = currentComments();
      const now = new Date().toISOString();
      const wasEditing = Boolean(editingCommentId);
      if (editingCommentId) {
        const comment = comments.find((item) => item.id === editingCommentId);
        if (comment) { comment.instruction = instruction; comment.updatedAt = now; activeCommentId = comment.id; }
      } else {
        const comment = {
          id: `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          instruction, status: 'open', anchor: JSON.parse(JSON.stringify(draftCommentAnchor)),
          relocation: { state: 'matched', strategy: 'saved-range' }, createdAt: now, updatedAt: now
        };
        comments.push(comment); activeCommentId = comment.id;
      }
      persistReviewStore();
      closeCommentComposer();
      selectedPreviewBlock = null;
      renderPreview();
      scheduleReviewSidecarSync();
      tip(wasEditing ? '批注已更新' : '批注已添加');
    });
    els.previewEditor.addEventListener('click', (event) => {
      const commentAnchor = event.target.closest('.app-comment-anchor, .app-block-comment-anchor');
      if (commentAnchor) {
        event.preventDefault(); event.stopPropagation();
        const id = (commentAnchor.dataset.commentIds || '').split(' ').filter(Boolean)[0];
        if (id) focusComment(id);
        return;
      }
      if (event.target.closest('a, button, input')) return;
      const block = topPreviewBlock(event.target);
      if (!block) return;
      els.previewEditor.querySelectorAll('.app-comment-block-target').forEach((item) => item.classList.remove('app-comment-block-target'));
      selectedPreviewBlock = block;
      if (els.collabDrawer.classList.contains('is-open')) block.classList.add('app-comment-block-target');
    });
    els.previewEditor.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const anchor = event.target.closest('.app-comment-anchor, .app-block-comment-anchor');
      if (!anchor) return;
      event.preventDefault();
      const id = (anchor.dataset.commentIds || '').split(' ').filter(Boolean)[0];
      if (id) focusComment(id);
    });
    $('btn-delete-comment-close').addEventListener('click', closeDeleteComment);
    $('btn-delete-comment-cancel').addEventListener('click', closeDeleteComment);
    $('btn-delete-comment-confirm').addEventListener('click', () => {
      if (!deletingCommentId) return;
      const deletingId = deletingCommentId;
      currentReviewState().comments = currentComments().filter((comment) => comment.id !== deletingId);
      if (activeCommentId === deletingId) activeCommentId = null;
      closeDeleteComment();
      persistReviewStore(); renderPreview(); scheduleReviewSidecarSync();
      tip('批注已删除，正文内容未改变');
    });
    els.deleteCommentModal.addEventListener('click', (event) => { if (event.target === els.deleteCommentModal) closeDeleteComment(); });
    $('btn-view-sidecars').addEventListener('click', () => { sidecarFormat = 'markdown'; updateSidecarPreview(); setModalOpen(els.sidecarModal, true); });
    $('btn-sidecar-close').addEventListener('click', () => setModalOpen(els.sidecarModal, false));
    els.sidecarModal.addEventListener('click', (event) => { if (event.target === els.sidecarModal) setModalOpen(els.sidecarModal, false); });
    document.querySelectorAll('[data-sidecar-format]').forEach((button) => button.addEventListener('click', () => { sidecarFormat = button.dataset.sidecarFormat; updateSidecarPreview(); }));
    els.btnSidecarSync.addEventListener('click', async () => { await syncReviewSidecars({ interactive: true }); updateSidecarPreview(); });
    $('btn-download-review-json').addEventListener('click', () => downloadReview('json'));
    $('btn-download-review-md').addEventListener('click', () => downloadReview('markdown'));
    $('btn-model-settings').addEventListener('click', () => { fillModelForm(); setModalOpen(els.modelModal, true); });
    $('btn-model-close').addEventListener('click', () => setModalOpen(els.modelModal, false));
    els.modelModal.addEventListener('click', (event) => { if (event.target === els.modelModal) setModalOpen(els.modelModal, false); });
    els.modelProvider.addEventListener('change', () => {
      const provider = els.modelProvider.value;
      els.modelBaseUrl.value = MODEL_PROVIDER_DEFAULTS[provider] || '';
      updateModelControl(provider, MODEL_PROVIDER_MODELS[provider]?.[0] || '');
    });
    els.modelForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const next = readModelForm();
      if (!next.baseUrl || !next.model || !next.apiKey) { tip('请完整填写服务地址、模型和 API Key'); return; }
      saveModelConfig(next); setModalOpen(els.modelModal, false); tip('模型配置已保存');
    });
    $('btn-model-clear').addEventListener('click', () => {
      localStorage.removeItem(MODEL_CONFIG_KEY); localStorage.removeItem(MODEL_PERSISTENT_KEY); sessionStorage.removeItem(MODEL_SESSION_KEY);
      loadModelConfig(); fillModelForm(); updateModelUI(); tip('模型配置已清除');
    });
    $('btn-model-test').addEventListener('click', async () => {
      const draft = readModelForm();
      if (!draft.baseUrl || !draft.model || !draft.apiKey) { tip('请先完整填写模型配置'); return; }
      const button = $('btn-model-test'); button.disabled = true; button.textContent = '测试中…';
      try {
        await testModelConnection(draft);
        tip(requestModel.lastTransport === 'local-proxy' ? '模型连接成功（经本机安全转发）' : '模型连接成功');
      }
      catch (error) {
        const route = requestModel.lastTransport === 'local-proxy' ? '（经本机安全转发）' : '';
        tip(`连接失败${route}：${error?.message || '未知错误'}`);
      }
      finally { button.disabled = false; button.textContent = '测试连接'; }
    });
    els.btnGenerateSummary.addEventListener('click', generateAiReading);
    els.previewWrap.addEventListener('scroll', updateReadingProgress);
    window.addEventListener('resize', () => {
      if (els.collabDrawer.classList.contains('is-open')) els.drawerMask.hidden = window.innerWidth >= 1180;
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || document.querySelector('.app-modal-backdrop:not([hidden])')) return;
      if (!els.commentComposer.hidden) { closeCommentComposer(); renderPreview(); return; }
      if (els.collabDrawer.classList.contains('is-open')) closeCollabDrawer();
    });
  }

  function bindSourceEdit() {
    els.sourceEditor.addEventListener('focus', () => { lastEditSurface = 'source'; });
    els.sourceEditor.addEventListener('paste', (event) => {
      const images = imageFilesFromTransfer(event.clipboardData);
      if (!images.length) return;
      event.preventDefault();
      insertImageFiles(images, captureImageInsertion({ surface: 'source' }));
    });
    els.sourceEditor.addEventListener('keydown', (e) => {
      if (isImeCompositionEvent(e)) return;
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const result = continueListPure(els.sourceEditor.value, els.sourceEditor.selectionStart, els.sourceEditor.selectionEnd);
        if (result) { e.preventDefault(); applySourceTransform(result); }
        return;
      }
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        applySourceTransform(indentLinesPure(
          els.sourceEditor.value,
          els.sourceEditor.selectionStart,
          els.sourceEditor.selectionEnd,
          e.shiftKey
        ));
      }
    });
    els.sourceEditor.addEventListener('input', () => {
      activeSearchNavigation = null;
      pendingInputStarted = typeof performance !== 'undefined' ? performance.now() : null;
      setCurrentMarkdown(els.sourceEditor.value, { inputSource: 'source' });
    });
  }

  function commitPreviewEditorMarkdown(options) {
    if (!turndownService) return false;
    const opts = options || {};
    if (previewInputTimer !== null) {
      clearTimeout(previewInputTimer);
      previewInputTimer = null;
    }
    previewEditing = true;
    try {
      promotePreviewCaretParagraphs();
      let md = turndownService.turndown(els.previewEditor.innerHTML);
      if (opts.collapseEmptyBlock) md = normalizePreviewStructuralMarkdown(md);
      const inputSource = Object.prototype.hasOwnProperty.call(opts, 'inputSource')
        ? opts.inputSource
        : 'preview';
      setCurrentMarkdown(md, { skipRender: true, inputSource, historyUi: opts.historyUi });
      prepareTaskCheckboxes();
      return true;
    } finally {
      previewEditing = false;
    }
  }

  function normalizePreviewStructuralMarkdown(markdown) {
    return String(markdown || '')
      .replace(/\n\n[ \t]*\n\n/g, '\n\n')
      .replace(/^[ \t]+(?:\r?\n){2}(?=\S)/, '')
      .replace(/(?:\r?\n){2}[ \t]+$/, '');
  }

  function flushPendingPreviewCommit() {
    if (previewInputTimer === null) return false;
    clearTimeout(previewInputTimer);
    previewInputTimer = null;
    return commitPreviewEditorMarkdown();
  }

  function placePreviewCaret(node, offset) {
    const selection = window.getSelection();
    if (!selection) return;
    try { els.previewEditor.focus({ preventScroll: true }); }
    catch (_error) { els.previewEditor.focus(); }
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    lastPreviewRange = range.cloneRange();
  }

  function restorePreviewHistoryUi(historyUi) {
    if (historyUi?.type !== 'empty-paragraph') return false;
    const paragraph = document.createElement('p');
    paragraph.appendChild(document.createElement('br'));
    const blockIndex = Math.max(0, Math.min(els.previewEditor.children.length, Number(historyUi.blockIndex) || 0));
    els.previewEditor.insertBefore(paragraph, els.previewEditor.children[blockIndex] || null);
    placePreviewCaret(paragraph, 0);
    return true;
  }

  function previewListKind(item, list) {
    const directCheckbox = Array.from(item.children || [])
      .find((child) => child.matches?.('input[type="checkbox"]'));
    if (directCheckbox) return 'task';
    return list.tagName === 'OL' ? 'ol' : 'ul';
  }

  function previewDirectNestedList(item) {
    return Array.from(item.children || []).find((child) => /^(UL|OL)$/.test(child.tagName)) || null;
  }

  function previewListItemHasContent(item) {
    const clone = item.cloneNode(true);
    clone.querySelectorAll('input[type="checkbox"]').forEach((node) => node.remove());
    if (String(clone.textContent || '').replace(/[\s\u200B\uFEFF]/g, '')) return true;
    return !!clone.querySelector('img, table, hr, video, audio, iframe, canvas, ul > li, ol > li');
  }

  function previewNodeHasContent(node) {
    if (String(node?.textContent || '').replace(/[\s\u200B\uFEFF]/g, '')) return true;
    return !!node?.querySelector?.('img, table, hr, video, audio, iframe, canvas');
  }

  function appendPreviewListPlaceholder(container, kind) {
    if (kind === 'task') {
      const text = document.createTextNode('\u200B');
      container.appendChild(text);
      return { node: text, offset: text.length };
    }
    container.appendChild(document.createElement('br'));
    return { node: container, offset: 0 };
  }

  function previewCaretAtContentStart(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (text) {
      const onlyPlaceholder = !String(container.textContent || '').replace(/[\s\u200B\uFEFF]/g, '');
      return { node: text, offset: onlyPlaceholder ? text.length : 0 };
    }
    return { node: container, offset: 0 };
  }

  function createPreviewListItem(kind, fragment) {
    const item = document.createElement('li');
    let content = item;
    if (kind === 'task') {
      item.className = 'task-list-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.disabled = true;
      content = document.createElement('span');
      content.className = 'app-task-content';
      item.append(checkbox, content);
    }
    if (fragment) content.appendChild(fragment);
    const caret = previewNodeHasContent(content)
      ? previewCaretAtContentStart(content)
      : appendPreviewListPlaceholder(content, kind);
    return { item, content, caret };
  }

  function commitPreviewStructuralEdit(caret, options) {
    if (!commitPreviewEditorMarkdown({ ...(options || {}), inputSource: null })) return false;
    placePreviewCaret(caret.node, caret.offset);
    return true;
  }

  function splitPreviewListItem(item, list, kind, range) {
    let content = item;
    if (kind === 'task') {
      const checkbox = Array.from(item.children || [])
        .find((child) => child.matches?.('input[type="checkbox"]'));
      content = checkbox ? ensureTaskContent(item, checkbox) : null;
      if (!content || !content.contains(range.startContainer) || !content.contains(range.endContainer)) return false;
    }

    if (!range.collapsed) {
      range.deleteContents();
      range.collapse(true);
    }

    const tailRange = document.createRange();
    tailRange.setStart(range.startContainer, range.startOffset);
    if (kind === 'task') {
      tailRange.setEnd(content, content.childNodes.length);
    } else {
      const nestedList = previewDirectNestedList(item);
      if (nestedList) tailRange.setEndBefore(nestedList);
      else tailRange.setEnd(item, item.childNodes.length);
    }
    const trailingContent = tailRange.extractContents();
    if (!previewNodeHasContent(content)) appendPreviewListPlaceholder(content, kind);

    const next = createPreviewListItem(kind, trailingContent);
    item.after(next.item);
    if (kind === 'task') list.classList.add('contains-task-list');
    return commitPreviewStructuralEdit(next.caret);
  }

  function exitNestedPreviewList(item, list) {
    const parentItem = list.parentElement?.closest?.('li');
    const outerList = parentItem?.parentElement;
    if (!parentItem || !outerList || !/^(UL|OL)$/.test(outerList.tagName)) return false;
    const outerKind = previewListKind(parentItem, outerList);
    const lifted = createPreviewListItem(outerKind);
    parentItem.after(lifted.item);
    item.remove();
    if (!list.children.length) list.remove();
    if (outerKind === 'task') outerList.classList.add('contains-task-list');
    return commitPreviewStructuralEdit(lifted.caret, { collapseEmptyBlock: true });
  }

  function exitPreviewList(item, list) {
    if (exitNestedPreviewList(item, list)) return true;
    const itemIndex = Array.prototype.indexOf.call(list.children, item);
    const trailingList = item.nextElementSibling ? list.cloneNode(false) : null;
    while (item.nextElementSibling) trailingList.appendChild(item.nextElementSibling);
    if (trailingList?.tagName === 'OL') {
      const start = Number(list.getAttribute('start')) || 1;
      trailingList.setAttribute('start', String(start + itemIndex + 1));
    }
    const paragraph = document.createElement('p');
    paragraph.appendChild(document.createElement('br'));
    item.remove();
    if (list.children.length) list.after(paragraph);
    else list.replaceWith(paragraph);
    if (trailingList?.children.length) paragraph.after(trailingList);
    const blockIndex = Array.prototype.indexOf.call(els.previewEditor.children, paragraph);
    return commitPreviewStructuralEdit({ node: paragraph, offset: 0 }, {
      collapseEmptyBlock: true,
      historyUi: { type: 'empty-paragraph', blockIndex }
    });
  }

  function isPlainBackspace(event) {
    return event.key === 'Backspace'
      && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  }

  function previewListContext(range) {
    if (!range) return null;
    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
    const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer
      : range.endContainer.parentElement;
    const item = startElement?.closest?.('li');
    if (!item || item !== endElement?.closest?.('li') || !els.previewEditor.contains(item)) return null;
    const list = item.parentElement;
    if (!list || !/^(UL|OL)$/.test(list.tagName)) return null;
    const kind = previewListKind(item, list);
    if (kind === 'task') {
      const taskContent = Array.from(item.children || [])
        .find((child) => child.classList?.contains('app-task-content'));
      if (!taskContent || !taskContent.contains(range.startContainer) || !taskContent.contains(range.endContainer)) {
        return null;
      }
    }
    return { item, list, kind };
  }

  function backspacePreviewEmptyList(event) {
    if (!isPlainBackspace(event)) return false;
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false;
    const context = previewListContext(selection.getRangeAt(0));
    if (!context || previewListItemHasContent(context.item)) return false;
    event.preventDefault();
    event.stopPropagation();
    return exitPreviewList(context.item, context.list);
  }

  function previewEmptyFormattedBlock(range) {
    if (!range?.collapsed) return null;
    const element = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
    const block = element?.closest?.('h1, h2, h3, h4, h5, h6, blockquote, pre');
    if (!block || !els.previewEditor.contains(block)) return null;
    if (String(block.textContent || '').replace(/[\s\u200B\uFEFF]/g, '')) return null;
    if (block.querySelector('img, table, hr, video, audio, iframe, canvas, li')) return null;
    return block;
  }

  function backspacePreviewEmptyFormattedBlock(event) {
    if (!isPlainBackspace(event)) return false;
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false;
    const block = previewEmptyFormattedBlock(selection.getRangeAt(0));
    if (!block) return false;
    event.preventDefault();
    event.stopPropagation();
    const paragraph = document.createElement('p');
    paragraph.appendChild(document.createElement('br'));
    block.replaceWith(paragraph);
    const blockIndex = Array.prototype.indexOf.call(els.previewEditor.children, paragraph);
    return commitPreviewStructuralEdit({ node: paragraph, offset: 0 }, {
      collapseEmptyBlock: true,
      historyUi: { type: 'empty-paragraph', blockIndex }
    });
  }

  function continuePreviewList(event) {
    if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    const context = previewListContext(range);
    if (!context) return false;
    const { item, list, kind } = context;

    const hadContent = previewListItemHasContent(item);
    event.preventDefault();
    event.stopPropagation();
    if (!hadContent && range.collapsed) return exitPreviewList(item, list);
    return splitPreviewListItem(item, list, kind, range);
  }

  function continuePreviewTaskList(event) {
    return continuePreviewList(event);
  }

  function bindPreviewEdit() {
    els.previewEditor.addEventListener('focus', () => { lastEditSurface = 'preview'; });
    els.previewEditor.addEventListener('pointerdown', (event) => {
      previewPointerDown = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    });
    els.previewEditor.addEventListener('pointerup', (event) => {
      if (event.button !== 0 || event.target.closest?.('input, a, img')) return;
      const origin = previewPointerDown;
      previewPointerDown = null;
      if (!origin || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const pointRange = previewRangeAtPoint(event.clientX, event.clientY);
      if (!pointRange) return;
      placePreviewCaret(pointRange.startContainer, pointRange.startOffset);
      lastEditSurface = 'preview';
    });
    els.previewEditor.addEventListener('keydown', (event) => {
      if (isImeCompositionEvent(event)) return;
      if (backspacePreviewEmptyList(event)) return;
      if (backspacePreviewEmptyFormattedBlock(event)) return;
      continuePreviewList(event);
    });
    els.previewEditor.addEventListener('paste', (event) => {
      const images = imageFilesFromTransfer(event.clipboardData);
      if (!images.length) return;
      event.preventDefault();
      event.stopPropagation();
      insertImageFiles(images, captureImageInsertion({ surface: 'preview', range: currentPreviewRange() }));
    });
    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!els.previewEditor.contains(range.startContainer) || !els.previewEditor.contains(range.endContainer)) return;
      lastEditSurface = 'preview';
      lastPreviewRange = range.cloneRange();
    });
    els.previewEditor.addEventListener('change', (event) => {
      const checkbox = event.target.closest('input[type="checkbox"][data-md-task-index]');
      if (!checkbox || !els.previewEditor.contains(checkbox)) return;
      event.stopPropagation();
      toggleTaskByIndex(Number(checkbox.dataset.mdTaskIndex), checkbox.checked);
    });
    els.previewEditor.addEventListener('input', (event) => {
      if (previewEditing) return;
      if (event.target.closest && event.target.closest('input[type="checkbox"][data-md-task-index]')) return;
      activeSearchNavigation = null;
      clearTimeout(renderTimer);
      renderTimer = null;
      clearTimeout(previewInputTimer);
      previewInputTimer = setTimeout(() => {
        previewInputTimer = null;
        commitPreviewEditorMarkdown();
      }, 500);
    });
  }

  function bindPreviewLinks() {
    els.previewEditor.addEventListener('click', (event) => {
      const anchor = event.target.closest && event.target.closest('a[href]');
      if (!anchor || !els.previewEditor.contains(anchor)) return;
      // 可编辑预览：单击只落光标；Ctrl/Cmd+单击新标签打开
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) openPreviewLink(anchor.getAttribute('href'));
    });
    els.previewEditor.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      const anchor = event.target.closest && event.target.closest('a[href]');
      if (!anchor || !els.previewEditor.contains(anchor)) return;
      event.preventDefault();
      openPreviewLink(anchor.getAttribute('href'));
    });
    els.previewEditor.addEventListener('contextmenu', (event) => {
      const anchor = event.target.closest && event.target.closest('a[href]');
      if (!anchor || !els.previewEditor.contains(anchor)) return;
      const href = anchor.getAttribute('href');
      if (!isSafeExternalUrl(href)) return;
      event.preventDefault();
      showLinkMenu(event.clientX, event.clientY, href);
    });
    if (els.linkMenuOpen) {
      els.linkMenuOpen.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPreviewLink(els.linkMenu.dataset.href || '');
        hideLinkMenu();
      });
    }
    document.addEventListener('click', (event) => {
      if (!els.linkMenu || els.linkMenu.hidden) return;
      if (els.linkMenu.contains(event.target)) return;
      hideLinkMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideLinkMenu();
    });
    window.addEventListener('blur', hideLinkMenu);
    window.addEventListener('resize', hideLinkMenu);
  }

  function bindSyncScroll() {
    els.sourceEditor.addEventListener('scroll', () => {
      if (syncScrollLock || state.viewMode !== 'split') return;
      syncScrollLock = true;
      const src = els.sourceEditor, tgt = els.previewWrap;
      const ratio = src.scrollTop / Math.max(1, src.scrollHeight - src.clientHeight);
      tgt.scrollTop = ratio * (tgt.scrollHeight - tgt.clientHeight);
      requestAnimationFrame(() => { syncScrollLock = false; });
    });
    els.previewWrap.addEventListener('scroll', () => {
      if (syncScrollLock || state.viewMode !== 'split') return;
      syncScrollLock = true;
      const src = els.previewWrap, tgt = els.sourceEditor;
      const ratio = src.scrollTop / Math.max(1, src.scrollHeight - src.clientHeight);
      tgt.scrollTop = ratio * (tgt.scrollHeight - tgt.clientHeight);
      requestAnimationFrame(() => { syncScrollLock = false; });
    });
  }

  function tip(msg) {
    clearTimeout(tip._t);
    els.tip.textContent = msg;
    els.tip.hidden = false;
    els.tip.classList.add('is-flash');
    tip._t = setTimeout(() => {
      els.tip.classList.remove('is-flash');
      els.tip.hidden = true;
      els.tip.textContent = '';
    }, 2500);
  }

  async function installDirectoryAcceptanceFixture(scenario) {
    if (!navigator.storage || !navigator.storage.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry('md-editor-acceptance', { recursive: true }); } catch (error) { /* 首次运行无测试目录 */ }
    const handle = await root.getDirectoryHandle('md-editor-acceptance', { create: true });
    const reports = await handle.getDirectoryHandle('reports', { create: true });
    const writeFile = async (directory, name, content) => {
      const fileHandle = await directory.getFileHandle(name, { create: true });
      await writeToFileHandle(fileHandle, content);
      return fileHandle;
    };
    const reportHandle = await writeFile(handle, 'agent-report.md', '# Agent Report\n\nInitial output.');
    await writeFile(reports, 'weekly.markdown', '# Weekly\n\n- Finding A');
    await writeFile(handle, 'notes.txt', '目录中的 TXT 文本');
    await writeFile(handle, 'ignored.json', '{"ignored":true}');
    await writeFile(handle, 'agent-report.REVIEW.md', 'ignored review task');

    const fixtureId = 'directory-acceptance-fixture';
    state.docs = state.docs.filter((doc) => doc.directoryId !== fixtureId);
    state.directories = state.directories.filter((directory) => directory.id !== fixtureId);
    const directory = {
      id: fixtureId,
      name: '研究智能体',
      handleName: handle.name,
      handle,
      permissionState: 'granted',
      scanMode: 'manual',
      lastScannedAt: 0,
      lastScanStatus: 'idle',
      lastScanSummary: null,
      order: state.directories.length,
      collapsed: false,
      collapsedPaths: [],
      createdAt: Date.now()
    };
    state.directories.push(directory);
    await scanDirectory(directory, { interactive: false, announce: false });
    const report = state.docs.find((doc) => doc.directoryId === fixtureId && doc.localFileName === 'agent-report.md');
    if (report) await switchDoc(report.id);

    let writeback = null;
    if (scenario === 'basic' && report) {
      setCurrentMarkdown(`${report.content}\n\nEdited in fixture.`);
      await saveCurrentDocument();
      writeback = (await readFileAsText(await reportHandle.getFile())).includes('Edited in fixture.');
    } else if (scenario === 'conflict' && report) {
      setCurrentMarkdown(`${report.content}\n\nUnsaved local edit.`);
      await writeToFileHandle(reportHandle, '# Agent Report\n\nUpdated by agent.');
      await scanDirectory(directory, { interactive: false, announce: false });
    } else if (scenario === 'missing' && report) {
      await handle.removeEntry('agent-report.md');
      await scanDirectory(directory, { interactive: false, announce: false });
    }

    const result = {
      scenario,
      docs: state.docs.filter((doc) => doc.directoryId === fixtureId).length,
      paths: state.docs.filter((doc) => doc.directoryId === fixtureId).map((doc) => doc.relativePath).sort(),
      currentState: report ? report.syncState : null,
      writeback
    };
    document.documentElement.dataset.directoryFixture = JSON.stringify(result);
    return result;
  }

  async function boot() {
    initDOM();
    installFunctionalIcons();
    initMarked();
    initTurndown();
    loadState();
    loadReviewStore();
    loadModelConfig();
    await restoreDirectoryHandles();
    await restoreDocHandles();
    for (const directory of state.directories) {
      directory.permissionState = directory.handle ? await queryReadWritePermission(directory.handle) : 'prompt';
    }
    state.docs.forEach(ensureHistory);
    renderDocList();
    syncSourceToDOM();
    renderPreview();
    applyTheme(state.theme);
    setViewMode(state.viewMode);
    bindFmtbar();
    bindTablePicker();
    bindImageInsert();
    bindPreviewImageReorder();
    bindViewSeg();
    bindSplitResizer();
    bindDocList();
    bindDocumentSearch();
    bindDirectoryManager();
    bindConflictControls();
    bindModalFocusTrap();
    bindFileOpen();
    bindDragDrop();
    bindSourceEdit();
    bindPreviewEdit();
    bindPreviewLinks();
    bindSyncScroll();
    bindShortcuts();
    bindCollaboration();
    restoreReadingScroll();
    els.themeBtn.addEventListener('click', toggleTheme);
    updateStatus();
    updateEditChrome();
    startDirectoryScanning();
    scanAllDirectories({ interactive: false, announce: false }).finally(() => scheduleSemanticIndexSync(800));
    window.addEventListener('beforeunload', releasePreviewImageUrls);
    window.__MD_EDITOR_TEST__ = {
      computeFormat,
      insertTablePure,
      insertTable,
      markdownImageSyntax,
      normalizedHttpImageUrl,
      isSupportedImageFile,
      normalizeImageInsertion,
      insertImageBlocks,
      preparePreviewImageRows,
      captureImageInsertion,
      insertImageUrl,
      insertImageFiles,
      resolvePreviewImages,
      continueListPure,
      backspacePreviewEmptyList,
      backspacePreviewEmptyFormattedBlock,
      continuePreviewList,
      continuePreviewTaskList,
      indentLinesPure,
      isImeCompositionEvent,
      contentFingerprint,
      normalizeRelativePath,
      directoryDocId,
      shouldIgnoreDirectoryEntry,
      diffDirectoryIndex,
      searchTokens,
      semanticQueryFragments,
      resultHighlightTerms,
      searchSnippet,
      searchSentenceBounds,
      plainTextSectionHeading,
      plainTextHeadingKind,
      sentenceRangesForSearch,
      chunkMarkdownForSearch,
      recentSearchResults,
      keywordSearchDocuments,
      semanticDocumentsForIndex,
      runDocumentSearch,
      migratePresetDocs,
      taskMarkers,
      safeFileName,
      decodeTextBytes,
      exportMarkdown,
      saveCurrentDocument,
      generatePdfBlob,
      getState: () => state,
      getCurrentMarkdown,
      setCurrentMarkdown,
      renderPreview,
      isSafeExternalUrl,
      openPreviewLink,
      canUndo,
      canRedo,
      scanDirectory,
      scanAllDirectories,
      addDirectory,
      isDocDirty: () => isDocDirty(currentDoc()),
      getHistory: () => {
        const history = ensureHistory(currentDoc());
        return history ? { index: history.index, length: history.entries.length, limit: HISTORY_LIMIT } : null;
      },
      undo: () => applyHistory(-1),
      redo: () => applyHistory(1),
      reviewHash,
      reviewPayload: () => reviewPayload(currentDoc()),
      reviewMarkdown: () => reviewMarkdown(currentDoc()),
      parseAiReadingResponse,
      readingQuotePlainCandidates,
      findPreviewTargetForQuote,
      locateReadingQuote,
      splitRatioBounds,
      setSplitRatio,
      chatCompletionUrl,
      modelCatalogUrl,
      isBailianConfig,
      canUseLocalModelProxy,
      detectLocalModelProxy,
      testModelConnection,
      sourceSelectionAnchorPure,
      getReviewState: () => reviewStore,
      syncReviewSidecars
    };
    const fixtureScenario = new URLSearchParams(window.location.search).get('directoryFixture');
    if (fixtureScenario) await installDirectoryAcceptanceFixture(fixtureScenario);
  }

  function reportBootError(error) {
    console.error('应用初始化失败', error);
    window.__MD_EDITOR_BOOT_ERROR__ = error && (error.stack || error.message) ? String(error.stack || error.message) : String(error);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { boot().catch(reportBootError); });
  else boot().catch(reportBootError);
})();
