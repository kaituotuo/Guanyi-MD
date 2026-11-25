/* PDF.js GENERIC viewer adapter. Rendering and annotations belong to upstream. */
(function () {
  'use strict';

  const VIEWER_URL = 'vendor/pdfjs/web/viewer.html?file=';
  const bytesView = (bytes) => bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copyBytes = (bytes) => bytesView(bytes).slice();

  async function createStudyBridge({ viewer, frame, sourceHash, title, onCitationPositionChange }) {
    const childDocument = frame.contentDocument;
    const eventBus = viewer.eventBus;
    const pdfViewer = viewer.pdfViewer;
    const pageCache = new Map();
    const selectionSources = new Map();
    const subscribers = new Set();
    const annotationSubscribers = new Set();
    const controller = new AbortController();
    const labels = await viewer.pdfDocument.getPageLabels().catch(() => null);
    const permissions = await viewer.pdfDocument.getPermissions().catch(() => []);
    const textExtractionAllowed = !Array.isArray(permissions) || permissions.includes(16);
    let disposed = false;
    let lastSelection = null;
    let returnPosition = null;
    let citationPosition = null;
    let activeEvidence = null;
    let highlightTimer;
    let selectionTimer;
    let annotationTimer;
    const annotationStorage = viewer.pdfDocument.annotationStorage;
    let annotationHash = annotationStorage.serializable.hash;
    // This is an invalidation signal only. Native PDF.js storage/editors remain
    // the sole annotation source, including comment edits and undo/redo.
    const emitAnnotationsChanged = () => {
      clearTimeout(annotationTimer);
      annotationTimer = setTimeout(() => {
        if (disposed) return;
        const hash = annotationStorage.serializable.hash;
        if (hash === annotationHash) return;
        annotationHash = hash;
        for (const callback of annotationSubscribers) {
          try { callback(); } catch (_) { /* A consumer cannot break native editing. */ }
        }
      }, 0);
    };
    const nativeMethods = [];
    const observeMethods = (owner, names) => {
      if (!owner) return;
      for (const name of names) {
        const original = owner[name];
        if (typeof original !== 'function') continue;
        const wrapped = function (...args) {
          const result = original.apply(this, args);
          emitAnnotationsChanged();
          return result;
        };
        nativeMethods.push({ owner, name, original, wrapped });
        owner[name] = wrapped;
      }
    };
    observeMethods(annotationStorage, ['setValue', 'remove', 'updateEditor']);
    // Repeated native commands can leave editing-state booleans unchanged, so
    // PDF.js does not always dispatch editingstateschanged after a mutation.
    observeMethods(viewer.pdfViewer._layerProperties.annotationEditorUIManager, ['addCommands', 'undo', 'redo']);
    // Existing editor instances mutate their own serialized content. Observe
    // completed native actions as well as storage writes, without polling.
    for (const event of ['input', 'change', 'click', 'keyup', 'pointerup', 'focusout']) {
      childDocument.addEventListener(event, emitAnnotationsChanged, { capture: true, signal: controller.signal });
    }
    const annotationEvents = ['editingstateschanged', 'annotationeditorparamschanged', 'editorsrendered'];
    for (const event of annotationEvents) eventBus.on(event, emitAnnotationsChanged);
    const evidenceTools = () => {
      if (!window.GuanyiPdfEvidence) throw new Error('研读文字解析资源未就绪，请重新打开文档');
      return window.GuanyiPdfEvidence;
    };
    const assertOpen = () => { if (disposed) throw new Error('这份 PDF 阅读会话已关闭，请重新打开'); };
    const afterLayout = () => new Promise(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(finish, 100);
      frame.contentWindow.requestAnimationFrame(() => frame.contentWindow.requestAnimationFrame(finish));
    });
    const validRects = rects => Array.isArray(rects) ? rects.filter(rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite)) : [];
    const smallHash = text => { let value = 2166136261; for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619); return (value >>> 0).toString(16); };

    async function page(pageNumber, options = {}) {
      assertOpen();
      if (!textExtractionAllowed) throw new Error('这份 PDF 限制复制文字，不能准备智能研读；原版阅读和允许的批注仍可使用');
      const tools = evidenceTools();
      tools.checkAbort(options.signal);
      const number = Math.round(Number(pageNumber));
      if (!Number.isFinite(number) || number < 1 || number > viewer.pdfDocument.numPages) throw new Error('PDF 页码超出范围');
      if (!pageCache.has(number)) {
        const record = await tools.extractPage(viewer.pdfDocument, number, { sourceHash, pageLabel: labels?.[number - 1], signal: options.signal });
        assertOpen();
        tools.checkAbort(options.signal);
        pageCache.set(number, record);
        if (pageCache.size > 100) pageCache.delete(pageCache.keys().next().value);
      }
      tools.checkAbort(options.signal);
      return pageCache.get(number);
    }

    async function renderVisual(visualOrPage, options = {}) {
      assertOpen();
      if (!textExtractionAllowed) throw new Error('这份 PDF 限制复制内容，不能发送页面图像研读；原版阅读和允许的批注仍可使用');
      const number = Number(typeof visualOrPage === 'object' ? visualOrPage?.page : visualOrPage);
      if (!Number.isInteger(number) || number < 1 || number > viewer.pdfDocument.numPages) throw new Error('PDF 图像页码超出范围');
      if (typeof visualOrPage === 'object' && visualOrPage?.sourceHash && visualOrPage.sourceHash !== sourceHash) throw new Error('页面图像属于旧文件版本，请重新研读当前 PDF');
      const canvas = childDocument.createElement('canvas');
      let renderTask;
      const aborted = () => controller.signal.aborted || options.signal?.aborted;
      const check = () => { if (aborted()) throw new DOMException('页面图像读取已停止', 'AbortError'); assertOpen(); };
      const cancel = () => renderTask?.cancel();
      controller.signal.addEventListener('abort', cancel, { once: true });
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        check();
        const pdfPage = await viewer.pdfDocument.getPage(number);
        check();
        const originalViewport = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(2000 / Math.max(originalViewport.width, originalViewport.height), Math.sqrt(2800000 / (originalViewport.width * originalViewport.height)));
        if (!Number.isFinite(scale) || scale <= 0) throw new Error('页面尺寸无效');
        const viewport = pdfPage.getViewport({ scale });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('页面图像画布不可用');
        // A separate original-page render never changes the visible PDF canvas,
        // reading position or PDF.js annotation storage.
        renderTask = pdfPage.render({ canvasContext: context, canvas, viewport, background: 'rgb(255,255,255)', annotationMode: 0 });
        await renderTask.promise;
        check();
        for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5]) {
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          check();
          if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('页面图像编码失败');
          const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
          const bytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
          if (bytes <= 2 * 1024 * 1024) return { dataUrl, width: canvas.width, height: canvas.height, mimeType: 'image/jpeg' };
        }
        throw new Error('页面图像在清晰度要求下超过大小限制，请换用更清晰或更简洁的 PDF 后重试');
      } catch (error) {
        if (aborted() || error?.name === 'AbortError') throw new DOMException('页面图像读取已停止', 'AbortError');
        throw new Error(`文件第 ${number} 页图像无法读取：${error.message || '请重新打开 PDF 后重试'}。本次研读未跳过这一页。`);
      } finally {
        options.signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', cancel);
        canvas.width = 0;
        canvas.height = 0;
      }
    }

    function viewerPosition() {
      const scroll = pdfViewer.container;
      return { page: pdfViewer.currentPageNumber, zoom: pdfViewer.currentScaleValue, rotation: pdfViewer.pagesRotation,
        scrollLeft: scroll.scrollLeft, scrollTop: scroll.scrollTop };
    }

    function atCitationPosition(current) {
      return citationPosition && citationPosition.zoom === current.zoom && citationPosition.rotation === current.rotation &&
        Math.abs(citationPosition.scrollLeft - current.scrollLeft) < 1 && Math.abs(citationPosition.scrollTop - current.scrollTop) < 1;
    }

    function position() {
      const current = viewerPosition();
      // PDF.js can report the following page when more of it is visible than
      // the cited page. Keep scope on the citation until the reader moves.
      if (atCitationPosition(current)) current.page = citationPosition.page;
      return current;
    }

    function clearCitationPosition() {
      if (!citationPosition) return;
      citationPosition = null;
      onCitationPositionChange();
    }

    function releaseMovedCitation() {
      if (citationPosition && !atCitationPosition(viewerPosition())) clearCitationPosition();
    }
    eventBus.on('updateviewarea', releaseMovedCitation);

    function clearHighlight() {
      clearTimeout(highlightTimer);
      activeEvidence = null;
      childDocument.querySelectorAll('.guanyi-evidence-layer').forEach(element => element.remove());
    }

    function drawHighlight(focus = false) {
      childDocument.querySelectorAll('.guanyi-evidence-layer').forEach(element => element.remove());
      if (!activeEvidence || disposed) return;
      const pageView = viewer.pdfViewer.getPageView(activeEvidence.page - 1);
      if (!pageView?.viewport || !pageView.div) return;
      const viewport = pageView.viewport;
      const layer = childDocument.createElement('div');
      layer.className = 'guanyi-evidence-layer';
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:40;overflow:hidden;';
      layer.setAttribute('aria-label', `原文来源，文件第 ${activeEvidence.page} 页`);
      layer.tabIndex = -1;
      for (const rect of activeEvidence.rects) {
        const a = viewport.convertToViewportPoint(rect[0], rect[1]);
        const b = viewport.convertToViewportPoint(rect[2], rect[3]);
        const converted = [a[0], a[1], b[0], b[1]];
        const x = Math.min(converted[0], converted[2]);
        const y = Math.min(converted[1], converted[3]);
        const box = childDocument.createElement('span');
        box.style.cssText = `position:absolute;left:${x / viewport.width * 100}%;top:${y / viewport.height * 100}%;width:${Math.abs(converted[2] - converted[0]) / viewport.width * 100}%;height:${Math.abs(converted[3] - converted[1]) / viewport.height * 100}%;background:rgba(223,75,37,.18);outline:1.5px solid #df4b25;border-radius:2px;`;
        layer.append(box);
      }
      pageView.div.append(layer);
      if (focus) layer.focus({ preventScroll: true });
    }

    async function locate(evidence) {
      assertOpen();
      if (!evidence || evidence.sourceHash !== sourceHash) throw new Error('来源版本已变化，请保留原文快照并重新核验');
      await afterLayout();
      const record = await page(evidence.page);
      const block = record.blocks.find(item => item.id === evidence.id);
      let contiguousGroup = null;
      if (block && Array.isArray(evidence.blockIds) && evidence.blockIds.length > 1) {
        const ids = [...new Set(evidence.blockIds)];
        const first = record.blocks.findIndex(item => item.id === ids[0]);
        const members = first < 0 ? [] : record.blocks.slice(first, first + ids.length);
        if (members.length === ids.length && members.every((item, index) => item.id === ids[index])
          && evidenceTools().normalizedText(members.map(item => item.text).join('\n')) === evidenceTools().normalizedText(evidence.text)) {
          // Recompute every highlight rectangle from the current PDF. The
          // excerpt preview cannot supply coordinates or invent group members.
          contiguousGroup = { rects: members.flatMap(item => item.rects || []) };
        }
      }
      const selected = selectionSources.get(evidence.id);
      const frozenSelection = String(evidence.id || '').startsWith(`pdf:${sourceHash}:selection:p${record.page}:`)
        && evidenceTools().normalizedText(record.blocks.map(item => item.text).join('')).replace(/\s/g, '')
          .includes(evidenceTools().normalizedText(evidence.text).replace(/\s/g, ''));
      const trusted = contiguousGroup || block || selected || (frozenSelection && evidence.text?.trim() ? evidence : null);
      const rects = validRects(trusted?.rects);
      const target = pdfViewer.getPageView(record.page - 1);
      if (!target.pdfPage) {
        const pdfPage = await viewer.pdfDocument.getPage(record.page);
        assertOpen();
        if (!target.pdfPage) target.setPdfPage(pdfPage);
      }
      const previousPosition = position();
      if (!returnPosition) returnPosition = previousPosition;
      citationPosition = null;
      clearHighlight();
      const top = rects.length ? Math.max(...rects.map(rect => rect[3])) : null;
      const left = rects.length ? Math.min(...rects.map(rect => rect[0])) : null;
      pdfViewer.scrollPageIntoView({ pageNumber: record.page,
        ...(rects.length ? { destArray: [null, { name: 'XYZ' }, left, top, null], ignoreDestinationZoom: true, center: 'vertical' } : {}) });
      await afterLayout();
      assertOpen();
      citationPosition = { ...viewerPosition(), page: record.page };
      onCitationPositionChange();
      if (rects.length) {
        activeEvidence = { page: record.page, rects };
        drawHighlight(true);
        highlightTimer = setTimeout(clearHighlight, 9000);
      }
      return { precise: rects.length > 0, previousPosition };
    }

    async function restore(saved = returnPosition) {
      assertOpen();
      if (!saved) return;
      clearCitationPosition();
      clearHighlight();
      if (Number.isFinite(Number(saved.rotation))) pdfViewer.pagesRotation = ((Math.round(Number(saved.rotation) / 90) * 90 % 360) + 360) % 360;
      if (saved.zoom) pdfViewer.currentScaleValue = saved.zoom;
      pdfViewer.currentPageNumber = Math.max(1, Math.min(viewer.pdfDocument.numPages, Number(saved.page) || 1));
      await afterLayout();
      pdfViewer.container.scrollLeft = Math.max(0, Number(saved.scrollLeft) || 0);
      pdfViewer.container.scrollTop = Math.max(0, Number(saved.scrollTop) || 0);
      returnPosition = null;
    }

    async function captureSelection() {
      assertOpen();
      const selection = childDocument.getSelection();
      if (!selection?.rangeCount || !selection.toString().trim()) return lastSelection;
      const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
      const sources = [];
      for (const pageElement of childDocument.querySelectorAll('.page[data-page-number]')) {
        const number = Number(pageElement.dataset.pageNumber);
        const pageView = viewer.pdfViewer.getPageView(number - 1);
        const textLayer = pageElement.querySelector('.textLayer');
        if (!textLayer || !pageView?.viewport) continue;
        const canvasArea = pageElement.querySelector('.canvasWrapper') || pageElement;
        const bounds = canvasArea.getBoundingClientRect();
        const texts = [];
        const rects = [];
        for (const range of ranges) {
          if (!range.intersectsNode(textLayer)) continue;
          const local = childDocument.createRange();
          local.selectNodeContents(textLayer);
          if (range.compareBoundaryPoints(frame.contentWindow.Range.START_TO_START, local) > 0) local.setStart(range.startContainer, range.startOffset);
          if (range.compareBoundaryPoints(frame.contentWindow.Range.END_TO_END, local) < 0) local.setEnd(range.endContainer, range.endOffset);
          const text = local.toString().trim();
          if (!text) continue;
          texts.push(text);
          for (const rect of local.getClientRects()) {
            const left = Math.max(rect.left, bounds.left); const right = Math.min(rect.right, bounds.right);
            const top = Math.max(rect.top, bounds.top); const bottom = Math.min(rect.bottom, bounds.bottom);
            if (right - left < 0.5 || bottom - top < 0.5 || !bounds.width || !bounds.height) continue;
            const a = pageView.viewport.convertToPdfPoint((left - bounds.left) * pageView.viewport.width / bounds.width, (top - bounds.top) * pageView.viewport.height / bounds.height);
            const b = pageView.viewport.convertToPdfPoint((right - bounds.left) * pageView.viewport.width / bounds.width, (bottom - bounds.top) * pageView.viewport.height / bounds.height);
            const pdfRect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
            if (!rects.some(existing => existing.every((value, index) => Math.abs(value - pdfRect[index]) < 0.5))) rects.push(pdfRect);
          }
        }
        if (!texts.length) continue;
        const text = texts.join('\n');
        const record = await page(number);
        const overlaps = (a, b) => Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
        const covered = record.blocks.filter(block => block.rects.some(rect => rects.some(selected => overlaps(rect, selected))));
        const id = `pdf:${sourceHash}:selection:p${number}:${smallHash(text + JSON.stringify(rects))}`;
        const evidence = { id, page: number, pageLabel: labels?.[number - 1] || String(number), text, rects,
          itemStart: covered.length ? Math.min(...covered.map(block => block.itemStart)) : -1,
          itemEnd: covered.length ? Math.max(...covered.map(block => block.itemEnd)) : -1,
          blockIds: covered.map(block => block.id), sourceHash, precise: rects.length > 0, extractionStatus: 'selection' };
        sources.push(evidence);
        selectionSources.set(id, evidence);
        if (selectionSources.size > 300) selectionSources.delete(selectionSources.keys().next().value);
      }
      if (!sources.length) return lastSelection;
      lastSelection = { text: sources.map(source => source.text).join('\n\n'), sources };
      return lastSelection;
    }

    const emitSelection = () => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        captureSelection().then(snapshot => { if (!disposed && snapshot) subscribers.forEach(callback => callback(snapshot)); }).catch(() => {});
      }, 80);
    };
    childDocument.addEventListener('selectionchange', emitSelection, { signal: controller.signal });
    childDocument.addEventListener('pointerup', event => {
      if (!childDocument.getSelection()?.toString().trim() && event.target.closest?.('.textLayer, .canvasWrapper')) {
        lastSelection = null;
        subscribers.forEach(callback => callback(null));
      } else emitSelection();
    }, { signal: controller.signal });
    const redraw = () => { if (activeEvidence) frame.contentWindow.requestAnimationFrame(() => drawHighlight()); };
    for (const event of ['scalechanging', 'rotationchanging', 'pagerendered']) eventBus.on(event, redraw);

    async function outline() {
      assertOpen();
      const items = await viewer.pdfDocument.getOutline();
      const result = [];
      async function visit(entries) {
        for (const item of entries || []) {
          const destination = typeof item.dest === 'string' ? await viewer.pdfDocument.getDestination(item.dest) : item.dest;
          if (Array.isArray(destination) && destination[0] != null) {
            try {
              const index = Number.isInteger(destination[0]) ? destination[0] : await viewer.pdfDocument.getPageIndex(destination[0]);
              result.push({ title: String(item.title || '').trim(), page: index + 1 });
            } catch (_) { /* Invalid native destinations remain unavailable. */ }
          }
          await visit(item.items);
        }
      }
      await visit(items);
      return result.filter(item => item.page >= 1 && item.page <= viewer.pdfDocument.numPages);
    }

    async function annotations() {
      assertOpen();
      const items = new Map();
      const subtypes = { 1:'Text', 3:'FreeText', 9:'Highlight', 10:'Underline', 11:'Squiggly', 12:'StrikeOut', 13:'Stamp', 15:'Ink' };
      const kinds = { Text:'comment', FreeText:'text', Highlight:'highlight', Underline:'underline', StrikeOut:'strikeout', Squiggly:'squiggly', Ink:'ink', Stamp:'stamp' };
      const fallback = { Text:'PDF 评论', FreeText:'文字笔记', Highlight:'高亮批注', Underline:'下划线批注', StrikeOut:'删除线批注', Squiggly:'波浪线批注', Ink:'手绘批注', Stamp:'图像批注' };
      const nativeColor = value => {
        const color = Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value) : null;
        return color?.length === 3 && color.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255)
          ? `#${color.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}` : null;
      };
      const nativeTime = value => {
        if (!value) return null;
        let parsed;
        if (typeof value === 'string' && value.startsWith('D:')) {
          parsed = frame.contentWindow.pdfjsLib?.PDFDateString?.toDateObject(value)?.getTime();
        } else parsed = new Date(value).getTime();
        return Number.isFinite(parsed) ? parsed : null;
      };
      const metadata = (record, value) => {
        const color = nativeColor(value.color);
        if (color) record.color = color;
        const created = nativeTime(value.creationDate);
        const updated = nativeTime(value.modificationDate);
        if (created !== null) record.createdAt = created;
        if (updated !== null) record.updatedAt = updated;
      };
      for (let number = 1; number <= viewer.pdfDocument.numPages; number += 1) {
        assertOpen();
        const pdfPage = await viewer.pdfDocument.getPage(number);
        const original = await pdfPage.getAnnotations({ intent: 'display' });
        for (const annotation of original) {
          if (!kinds[annotation.subtype]) continue;
          const content = String(annotation.contentsObj?.str || '').trim();
          const value = annotation.subtype === 'FreeText' ? String(annotation.textContent?.join('\n') || content).trim() : '';
          const item = { id: annotation.id, page: number, subtype:annotation.subtype, kind:kinds[annotation.subtype],
            value, comment:content, rects:validRects([annotation.rect]), sourceHash };
          metadata(item, annotation);
          items.set(annotation.id, item);
        }
      }
      const storage = viewer.pdfDocument.annotationStorage.serializable.map;
      for (const [key, value] of storage || []) {
        const id = value.id || value.annotationElementId || key;
        if (value.deleted) { items.delete(id); continue; }
        const previous = items.get(id);
        const subtype = previous?.subtype || subtypes[value.annotationType];
        const number = Number.isInteger(value.pageIndex) ? value.pageIndex + 1 : previous?.page;
        if (!kinds[subtype] || !number || number > viewer.pdfDocument.numPages) continue;
        const rects = validRects([value.rect]);
        const item = { ...previous, id, page:number, subtype, kind:kinds[subtype], sourceHash,
          value:typeof value.value === 'string' ? value.value.trim() : previous?.value || '',
          comment:previous?.comment || '', rects:rects.length ? rects : previous?.rects || [] };
        // Native comments are serialized under popup.contents. An empty or
        // deleted popup must clear the imported comment rather than revive it.
        if (value.popup) item.comment = value.popup.deleted ? '' : String(value.popup.contents || '').trim();
        else if (typeof value.comment === 'string' || value.contentsObj) item.comment = String(value.comment || value.contentsObj?.str || '').trim();
        metadata(item, value);
        items.set(id, item);
      }
      const manager = viewer.pdfViewer._layerProperties.annotationEditorUIManager;
      const editors = new Map();
      for (const number of new Set([...items.values()].map(item => item.page))) {
        for (const editor of manager?.getEditors(number - 1) || []) {
          editors.set(editor.id, editor);
          if (editor.annotationElementId) editors.set(editor.annotationElementId, editor);
        }
      }
      for (const item of items.values()) {
        const editor = editors.get(item.id);
        if (editor && !editor.deleted) {
          // The native editor owns dates for newly created comments; these are
          // not included in its serialized change record until PDF export.
          metadata(item, { creationDate:editor.creationDate, modificationDate:editor.comment?.date || editor.modificationDate });
        }
      }
      for (const item of items.values()) {
        if (item.subtype === 'Text' && !item.comment) { items.delete(item.id); continue; }
        item.text = item.value || item.comment || fallback[item.subtype];
        delete item.value;
        const record = textExtractionAllowed ? await page(item.page) : { blocks: [] };
        const overlaps = (a, b) => Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
        item.quote = record.blocks.filter(block => block.rects.some(rect => item.rects.some(annotation => overlaps(rect, annotation)))).map(block => block.text).join('\n').slice(0, 1600);
        const id = `pdf:${sourceHash}:annotation:p${item.page}:${item.id}`;
        selectionSources.set(id, { ...item, id });
        item.nativeId = item.id;
        item.id = id;
      }
      return [...items.values()].sort((a, b) => a.page - b.page);
    }

    return {
      info: { sourceHash, numPages: viewer.pdfDocument.numPages, title: String(title || '').trim(), textExtractionAllowed },
      page, renderVisual, outline, captureSelection, position, locate, restore, annotations,
      clearCitationPosition,
      onSelection(callback) { if (typeof callback !== 'function') return () => {}; subscribers.add(callback); return () => subscribers.delete(callback); },
      onAnnotationsChanged(callback) { if (typeof callback !== 'function') return () => {}; annotationSubscribers.add(callback); return () => annotationSubscribers.delete(callback); },
      hideNavigation() { viewer.viewsManager?.close(); viewer.findBar?.close(); },
      setStudyOpen(open) { if (open) { viewer.viewsManager?.close(); viewer.findBar?.close(); } },
      dispose() {
        if (disposed) return;
        disposed = true;
        controller.abort();
        clearTimeout(selectionTimer);
        clearTimeout(annotationTimer);
        clearHighlight();
        subscribers.clear(); annotationSubscribers.clear(); pageCache.clear(); selectionSources.clear();
        for (const { owner, name, original, wrapped } of nativeMethods) if (owner[name] === wrapped) owner[name] = original;
        for (const event of annotationEvents) eventBus.off(event, emitAnnotationsChanged);
        eventBus.off('updateviewarea', releaseMovedCitation);
        for (const event of ['scalechanging', 'rotationchanging', 'pagerendered']) eventBus.off(event, redraw);
      }
    };
  }

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
    let revision = String(options.edits?.revision || 'original');
    let savedRevision = revision;
    let zoomPreset = '';
    // The host already owns this buffer. Keep it as the clean revision and give
    // PDF.js a separate copy, avoiding an extra full-document allocation.
    let savedBytes = bytesView(options.bytes);
    let checkpointQueue = Promise.resolve();
    let themeObserver;
    let study;
    let storageHash;
    const listeners = new AbortController();
    const controls = [];

    function button(label, symbol, action, parent = toolbar) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'fmt-btn guanyi-pdf-tool';
      element.setAttribute('aria-label', label);
      element.title = label;
      element.innerHTML = icon(symbol);
      element.addEventListener('mousedown', event => event.preventDefault());
      element.addEventListener('click', action, { signal: listeners.signal });
      parent.append(element);
      controls.push(element);
      return element;
    }

    function scheduleCheckpoint() {
      clearTimeout(checkpointTimer);
      checkpointTimer = setTimeout(() => {
        // Keep the user's insertion point until their current text edit commits.
        const focused = frame.contentDocument?.activeElement;
        if (focused?.isContentEditable || /^(INPUT|TEXTAREA)$/.test(focused?.tagName || '')) return;
        checkpoint(false, false).catch(error => notify(`PDF 草稿保存失败：${error.message}`));
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
      const manager = viewer.pdfViewer._layerProperties.annotationEditorUIManager;
      manager?.endCurrentEditing();
      // PDF.js may clear its active-editor pointer on blur before a tab click
      // reaches us. Commit any FreeText editor still in edit mode explicitly.
      if (manager) {
        for (let page = 0; page < viewer.pdfViewer.pagesCount; page += 1) {
          const editors = manager.getEditors?.(page);
          if (!editors) continue;
          for (const editor of editors) {
            if (editor.div?.classList.contains('freeTextEditor') && editor.isInEditMode()) editor.commitOrRemove();
          }
        }
      }
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

    function checkpoint(commit = false, copyResult = true) {
      if (commit && !disposed) endEditing();
      // Flush native undo/delete/commit synchronously before the host takes its
      // saved revision, rather than depending on a later pointer/key event.
      syncStorageRevision();
      clearTimeout(checkpointTimer);
      const job = checkpointQueue.catch(() => {}).then(async () => {
        if (disposed || savedRevision === revision) {
          return { bytes: copyResult ? copyBytes(savedBytes) : savedBytes, revision: savedRevision };
        }
        const capturedRevision = revision;
        const documentProxy = viewer.pdfDocument;
        const bytes = documentProxy.annotationStorage.size
          ? await documentProxy.saveDocument()
          : await documentProxy.getData();
        savedBytes = copyBytes(bytes);
        if (onSnapshot) await onSnapshot(savedBytes, capturedRevision);
        savedRevision = capturedRevision;
        return { bytes: copyResult ? copyBytes(savedBytes) : savedBytes, revision: capturedRevision };
      });
      checkpointQueue = job;
      return job;
    }

    function reportPosition() {
      if (disposed || !viewer?.pdfViewer) return;
      // The host already debounces persistence. Update its in-memory position
      // synchronously so an immediate tab switch cannot cancel the latest page
      // or zoom before hide() performs its final persist.
      onPosition?.({ page: currentPageNumber(), zoom: zoomPreset || viewer.pdfViewer.currentScaleValue });
    }

    const currentPageNumber = () => study?.position().page ?? viewer.pdfViewer.currentPageNumber;

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
          // The host owns the saved page and zoom. PDF.js viewOnLoad 1 starts
          // with the document's initial view instead of replaying its history.
          defaultUrl: '', disablePreferences: true, disableHistory: true, viewOnLoad: 1,
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
      const dispatch = (name, detail = {}) => {
        if (study && (name === 'previouspage' || name === 'nextpage')) {
          const page = currentPageNumber();
          const target = page + (name === 'previouspage' ? -1 : 1);
          if (target < 1 || target > viewer.pdfDocument.numPages) return;
          study.clearCitationPosition();
          if (page !== viewer.pdfViewer.currentPageNumber) {
            viewer.pdfViewer.currentPageNumber = target;
            return;
          }
        }
        eventBus.dispatch(name, { source: frame.contentWindow, ...detail });
      };
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

      const zoomControls = document.createElement('div');
      zoomControls.className = 'guanyi-pdf-control-group guanyi-pdf-zoom-controls';
      zoomControls.setAttribute('role', 'group');
      zoomControls.setAttribute('aria-label', 'PDF 显示比例');
      toolbar.append(zoomControls);
      controls.push(zoomControls);
      const zoomOut = button('缩小', 'zoom-out', () => {
        zoomPreset = '';
        dispatch('zoomout');
      }, zoomControls);
      const zoomSelect = document.createElement('select');
      zoomSelect.className = 'guanyi-pdf-zoom-select';
      zoomSelect.setAttribute('aria-label', 'PDF 显示比例');
      const currentZoomOption = document.createElement('option');
      currentZoomOption.value = '__current';
      currentZoomOption.hidden = true;
      zoomSelect.append(currentZoomOption);
      const zoomOptions = [
        ['0.5', '50%'], ['0.75', '75%'], ['1', '100%'], ['1.25', '125%'],
        ['1.5', '150%'], ['2', '200%'], ['page-fit', '整页'], ['page-width', '页宽']
      ];
      const zoomOptionByValue = new Map();
      for (const [value, label] of zoomOptions) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.dataset.baseLabel = label;
        zoomSelect.append(option);
        zoomOptionByValue.set(value, option);
      }
      zoomSelect.addEventListener('change', () => {
        if (zoomSelect.value === '__current') return;
        zoomPreset = zoomSelect.value === 'page-fit' || zoomSelect.value === 'page-width' ? zoomSelect.value : '';
        viewer.pdfViewer.currentScaleValue = zoomSelect.value;
        updateZoom();
      }, { signal: listeners.signal });
      zoomControls.append(zoomSelect);
      controls.push(zoomSelect);
      const zoomIn = button('放大', 'zoom-in', () => {
        zoomPreset = '';
        dispatch('zoomin');
      }, zoomControls);
      const fit = button('适合页宽', 'description', () => {
        zoomPreset = 'page-width';
        viewer.pdfViewer.currentScaleValue = 'page-width';
        updateZoom();
      }, zoomControls);
      fit.classList.add('guanyi-pdf-fit-width');
      fit.insertAdjacentHTML('beforeend', '<span>页宽</span>');

      const pageControls = document.createElement('div');
      pageControls.className = 'guanyi-pdf-control-group guanyi-pdf-page-controls';
      pageControls.setAttribute('role', 'group');
      pageControls.setAttribute('aria-label', 'PDF 翻页');
      toolbar.append(pageControls);
      controls.push(pageControls);
      const previous = button('上一页', 'chevron-right', () => dispatch('previouspage'), pageControls);
      previous.classList.add('guanyi-pdf-previous');
      const pagePrefix = document.createElement('span');
      pagePrefix.className = 'guanyi-pdf-page-prefix';
      pagePrefix.textContent = '第';
      const pageInput = document.createElement('input');
      pageInput.className = 'guanyi-pdf-page-number';
      pageInput.type = 'number';
      pageInput.min = '1';
      pageInput.max = String(viewer.pdfDocument.numPages);
      pageInput.setAttribute('aria-label', `PDF 页码，共 ${viewer.pdfDocument.numPages} 页`);
      const commitPageInput = () => {
        const parsed = Math.round(Number(pageInput.value));
        const number = Math.max(1, Math.min(viewer.pdfDocument.numPages, Number.isFinite(parsed) ? parsed : 1));
        study?.clearCitationPosition();
        viewer.pdfViewer.currentPageNumber = number;
        pageInput.value = String(number);
      };
      pageInput.addEventListener('change', commitPageInput, { signal: listeners.signal });
      pageInput.addEventListener('focus', () => pageInput.select(), { signal: listeners.signal });
      pageInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitPageInput();
          pageInput.select();
        } else if (event.key === 'Escape') {
          pageInput.value = String(currentPageNumber());
          pageInput.blur();
        }
      }, { signal: listeners.signal });
      const pageCount = document.createElement('span');
      pageCount.className = 'guanyi-pdf-page-count';
      pageCount.textContent = `页 / 共 ${viewer.pdfDocument.numPages} 页`;
      pageControls.append(pagePrefix, pageInput, pageCount);
      controls.push(pagePrefix, pageInput, pageCount);
      const next = button('下一页', 'chevron-right', () => dispatch('nextpage'), pageControls);

      const isEditingTarget = target => Boolean(target?.isContentEditable || target?.closest?.(
        'input, textarea, select, [contenteditable="true"], [role="textbox"], dialog[open]'
      ));
      childDocument.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        if (isEditingTarget(event.target) || viewer.pdfViewer.annotationEditorMode !== 0) return;
        if (!childDocument.getSelection()?.isCollapsed) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        dispatch(event.key === 'ArrowLeft' ? 'previouspage' : 'nextpage');
      }, { capture: true, signal: listeners.signal });

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
      function updateZoom({ scale, presetValue } = {}) {
        const numericScale = Number(scale) || Number(viewer.pdfViewer.currentScale) || 1;
        const percentage = Math.max(1, Math.round(numericScale * 100));
        for (const option of zoomOptionByValue.values()) option.textContent = option.dataset.baseLabel;
        if (presetValue === 'page-fit' || presetValue === 'page-width') zoomPreset = presetValue;
        else if (presetValue === undefined && Number.isFinite(Number(viewer.pdfViewer.currentScaleValue))) {
          // PDF.js emits presetValue for page-fit/page-width recalculation on
          // resize, but omits it for numeric shortcut/gesture zoom. Clear a
          // stale preset only in the latter case so the displayed mode and the
          // restored zoom match what the user actually chose.
          zoomPreset = '';
        }
        const scaleValue = String(zoomPreset || presetValue || viewer.pdfViewer.currentScaleValue || '');
        let selected = zoomOptionByValue.get(scaleValue);
        if (!selected && Number.isFinite(Number(scaleValue))) {
          selected = zoomOptions
            .map(([value]) => zoomOptionByValue.get(value))
            .find(option => Number.isFinite(Number(option.value)) && Math.abs(Number(option.value) - numericScale) < 0.001);
        }
        if (selected) {
          if (selected.value === 'page-fit' || selected.value === 'page-width') {
            selected.textContent = `${selected.dataset.baseLabel} · ${percentage}%`;
          }
          zoomSelect.value = selected.value;
        } else {
          currentZoomOption.textContent = `${percentage}%`;
          zoomSelect.value = currentZoomOption.value;
        }
        zoomSelect.title = `当前显示比例 ${percentage}%`;
        zoomSelect.setAttribute('aria-label', `PDF 显示比例，当前 ${percentage}%`);
        zoomOut.disabled = numericScale <= 0.1;
        zoomIn.disabled = numericScale >= 10;
        reportPosition();
      }
      function updatePage() {
        const page = currentPageNumber();
        pageInput.value = page;
        pageInput.setAttribute('aria-label', `PDF 页码，当前第 ${page} 页，共 ${viewer.pdfDocument.numPages} 页`);
        previous.disabled = page <= 1;
        next.disabled = page >= viewer.pdfDocument.numPages;
        reportPosition();
      }
      eventBus.on('pagechanging', updatePage);
      eventBus.on('scalechanging', updateZoom);
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
      let committingFreeTextBlur = false;
      childDocument.addEventListener('blur', event => {
        if (committingFreeTextBlur || !event.target.matches?.('.freeTextEditor [contenteditable=true]')) return;
        // A tab click blurs the native editor before dispose() can flush it.
        // Commit while PDF.js still tracks this editor as active.
        committingFreeTextBlur = true;
        try {
          viewer.pdfViewer._layerProperties.annotationEditorUIManager?.endCurrentEditing();
          syncStorageRevision();
        } finally { committingFreeTextBlur = false; }
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
        const initialZoom = initial.zoom || 'page-width';
        zoomPreset = initialZoom === 'page-fit' || initialZoom === 'page-width' ? initialZoom : '';
        viewer.pdfViewer.currentScaleValue = initialZoom;
        viewer.pdfViewer.currentPageNumber = Math.max(1, Math.min(viewer.pdfDocument.numPages, Number(initial.page) || 1));
        updatePage();
        updateZoom();
      };
      const initialViewReady = viewer.isInitialViewSet ? Promise.resolve() : new Promise(resolve => {
        eventBus.on('documentinit', resolve, { once: true, signal: listeners.signal });
      });
      updatePage();
      updateZoom();
      try {
        // Publish the study bridge only after the host's reading position is
        // restored, so source jumps and detached previews see a settled view.
        await Promise.all([initialViewReady, viewer.pdfViewer.pagesPromise]);
        restorePosition();
        let sourceHash = options.sourceHash;
        if (!sourceHash) {
          const digest = await crypto.subtle.digest('SHA-256', bytesView(options.bytes));
          sourceHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        }
        study = await createStudyBridge({ viewer, frame, sourceHash, title: options.title, onCitationPositionChange: updatePage });
      } catch (error) {
        notify?.(`智能研读暂不可用，PDF 阅读仍可继续：${error.message || error}`);
      }
      return {
        study,
        async serialize() { return (await checkpoint(true)).bytes; },
        async serializeSnapshot() { return checkpoint(true); },
        async flush() { return (await checkpoint(true, false)).bytes; },
        async dispose() {
          if (disposed) return;
          endEditing();
          await checkpoint(false, false);
          reportPosition();
          closing = true;
          disposed = true;
          study?.dispose();
          clearTimeout(checkpointTimer);
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
      study?.dispose();
      await viewer?.pdfLoadingTask?.destroy().catch(() => {});
      frame.remove();
      controls.forEach(control => control.remove());
      throw error;
    }
  }
  window.GuanyiPdfReader = { open };
})();
