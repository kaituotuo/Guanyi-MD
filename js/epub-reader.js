(function () {
  'use strict';

  const COLORS = { yellow: '#f2cd55', green: '#7cce9c', blue: '#80b8eb', pink: '#eba6be' };
  const COLOR_NAMES = { yellow: '黄色', green: '绿色', blue: '蓝色', pink: '粉色' };
  const MAX_ANNOTATIONS = 1000;

  async function withTimeout(promise, label) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时，请检查书籍是否完整`)), 20000);
      })]);
    } finally { clearTimeout(timer); }
  }

  async function inspectArchive(bytes) {
    const zip = await window.JSZip.loadAsync(bytes);
    const files = Object.values(zip.files).filter((entry) => !entry.dir);
    if (files.length > 10000) throw new Error('书籍包含过多资源');
    // JSZip reads these sizes from the central directory without inflating entries.
    const expandedSize = files.reduce((sum, entry) => sum + (entry._data?.uncompressedSize || 0), 0);
    if (expandedSize > 200 * 1024 * 1024 || files.some((entry) => entry._data?.uncompressedSize > 40 * 1024 * 1024)) {
      throw new Error('书籍解压后的资源过大');
    }
    if (!zip.file('META-INF/container.xml')) throw new Error('缺少 EPUB 书籍描述文件');
    const encryption = zip.file('META-INF/encryption.xml');
    if (encryption) {
      const xml = new DOMParser().parseFromString(await encryption.async('string'), 'application/xml');
      const supported = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];
      const methods = [...xml.getElementsByTagNameNS('*', 'EncryptionMethod')];
      if (!methods.length || methods.some((element) => !supported.includes(element.getAttribute('Algorithm')))) {
        throw new Error('此书含 DRM 加密资源，请使用未加密的 EPUB');
      }
    }
  }

  function normalizeAnnotations(edits) {
    const result = [];
    const seen = new Set();
    for (const item of Array.isArray(edits?.annotations) ? edits.annotations.slice(0, MAX_ANNOTATIONS) : []) {
      if (!item || typeof item.cfi !== 'string' || item.cfi.length > 4096 || !item.cfi.startsWith('epubcfi(') || seen.has(item.cfi)) continue;
      try { new window.ePub.CFI(item.cfi); } catch (_) { continue; }
      seen.add(item.cfi);
      result.push({
        id: typeof item.id === 'string' ? item.id.slice(0, 100) : crypto.randomUUID(),
        cfi: item.cfi,
        quote: String(item.quote || '').slice(0, 20000),
        note: String(item.note || '').slice(0, 20000),
        color: Object.hasOwn(COLORS, item.color) ? item.color : 'yellow',
        chapter: String(item.chapter || '').slice(0, 500),
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
      });
    }
    return result;
  }

  // The content hook runs before epub.js serializes a chapter into its sandboxed view.
  // Keep publication scripts and network requests disabled independently of the host page.
  function protectChapter(document, section) {
    document.querySelectorAll('script,iframe,frame,frameset,object,embed,form,input,button,textarea,select,base').forEach((node) => node.remove());
    document.querySelectorAll('meta[http-equiv]').forEach((node) => node.remove());
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.replace(/[\u0000-\u0020]/g, '').toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction'
          || ((name === 'href' || name === 'src' || name === 'xlink:href') && /^(?:javascript|vbscript):/.test(value))) {
          element.removeAttribute(attribute.name);
        }
      }
    }
    const policy = document.createElement('meta');
    policy.setAttribute('http-equiv', 'Content-Security-Policy');
    policy.setAttribute('content', "default-src 'none'; script-src 'none'; connect-src 'none'; img-src blob: data:; media-src blob: data:; style-src 'unsafe-inline' blob: data:; font-src blob: data:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'");
    document.head.prepend(policy);
    const base = document.createElement('base');
    base.setAttribute('href', section.url);
    document.head.append(base);
  }

  async function open(options) {
    if (typeof window.ePub !== 'function') throw new Error('EPUB 阅读组件未加载');
    const { container, toolbar, icon, onChange, onPosition } = options;
    const notify = options.notify || (() => {});
    const original = new Uint8Array(options.bytes).slice();
    await inspectArchive(original);
    const buffer = original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength);
    const book = window.ePub({ replacements: 'blobUrl', requestMethod: () => Promise.reject(new Error('书籍外部资源已停用')) });
    let rendition;
    let disposed = false;
    let selected = null;
    let currentChapter = '';
    let currentCfi = '';
    let fontSize = Math.max(80, Math.min(180, Number(options.position?.fontSize) || 100));
    const annotations = normalizeAnnotations(options.edits);
    const controls = [];
    const painted = new Set();
    const chapterLabels = new Map();
    const shell = document.createElement('div');
    shell.className = 'epub-reader';
    const viewer = document.createElement('div');
    viewer.className = 'epub-reader__viewer';
    viewer.setAttribute('aria-label', 'EPUB 正文');
    const notesPanel = document.createElement('aside');
    notesPanel.className = 'epub-reader__notes';
    notesPanel.setAttribute('aria-label', 'EPUB 高亮与笔记');
    notesPanel.hidden = true;
    shell.append(viewer, notesPanel);
    container.replaceChildren(shell);

    function button(action, label, glyph, handler) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'fmt-btn';
      element.dataset.epubAction = action;
      element.title = label;
      element.setAttribute('aria-label', label);
      element.innerHTML = icon(glyph);
      element.addEventListener('click', () => Promise.resolve(handler()).catch((error) => notify(error.message || String(error))));
      toolbar.append(element);
      controls.push(element);
      return element;
    }

    function emitChange() {
      onChange?.({ version: 1, annotations: annotations.map((item) => ({ ...item })) });
    }

    function emitPosition() {
      if (!disposed) onPosition?.({ cfi: currentCfi, fontSize });
    }

    function updateSelection(value) {
      selected = value;
      highlightButton.disabled = !value;
      noteButton.disabled = !value;
      copyButton.disabled = !value;
    }

    function paint(item) {
      try {
        rendition.annotations.highlight(item.cfi, { id: item.id }, () => {
          showNotes(true);
          notesPanel.querySelector(`[data-annotation-id="${CSS.escape(item.id)}"]`)?.scrollIntoView({ block: 'nearest' });
        }, 'guanyi-epub-highlight', { fill: COLORS[item.color], 'fill-opacity': '0.35', 'mix-blend-mode': 'multiply' });
        painted.add(item.cfi);
      } catch (_) { /* A stored annotation can outlive a changed publication. Keep its note available. */ }
    }

    function repaint(item) {
      if (painted.has(item.cfi)) rendition.annotations.remove(item.cfi, 'highlight');
      paint(item);
    }

    async function navigate(target) {
      if (disposed) return;
      updateSelection(null);
      await rendition.display(target);
    }

    const previous = button('previous', '上一页', 'chevron-right', async () => { updateSelection(null); await rendition.prev(); });
    previous.classList.add('epub-reader__previous');
    const next = button('next', '下一页', 'chevron-right', async () => { updateSelection(null); await rendition.next(); });
    const chapters = document.createElement('select');
    chapters.className = 'epub-reader__chapters';
    chapters.setAttribute('aria-label', 'EPUB 章节目录');
    chapters.addEventListener('change', () => navigate(chapters.value).catch((error) => notify(error.message)));
    toolbar.append(chapters);
    controls.push(chapters);
    const location = document.createElement('output');
    location.className = 'epub-reader__location';
    location.setAttribute('aria-label', '阅读进度');
    toolbar.append(location);
    controls.push(location);
    const font = document.createElement('select');
    font.setAttribute('aria-label', 'EPUB 字号');
    for (const size of [80, 90, 100, 110, 125, 150, 180]) {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = `${size}%`;
      font.append(option);
    }
    if (![80, 90, 100, 110, 125, 150, 180].includes(fontSize)) fontSize = 100;
    font.value = String(fontSize);
    font.addEventListener('change', () => {
      fontSize = Number(font.value);
      rendition.themes.fontSize(`${fontSize}%`);
      emitPosition();
    });
    toolbar.append(font);
    controls.push(font);
    const highlightButton = button('highlight', '高亮选中文字', 'rename', () => addAnnotation(false));
    const noteButton = button('note', '为选中文字添加笔记', 'comment-add', () => addAnnotation(true));
    const copyButton = button('copy', '复制选中文字', 'copy', async () => {
      if (!selected) return;
      await navigator.clipboard.writeText(selected.quote);
      notify('已复制选中文字');
    });
    const notesButton = button('notes', '高亮与笔记', 'review', () => showNotes(notesPanel.hidden));
    notesButton.setAttribute('aria-expanded', 'false');
    updateSelection(null);

    function showNotes(visible) {
      notesPanel.hidden = !visible;
      notesButton.setAttribute('aria-expanded', String(visible));
      if (visible) renderNotes();
    }

    function addAnnotation(withNote) {
      if (!selected) return;
      let item = annotations.find((entry) => entry.cfi === selected.cfi);
      if (!item) {
        if (annotations.length >= MAX_ANNOTATIONS) { notify('本书最多保存 1000 条标注，请先导出或整理笔记'); return; }
        item = { id: crypto.randomUUID(), ...selected, note: '', color: 'yellow', chapter: currentChapter, createdAt: Date.now() };
        annotations.push(item);
        paint(item);
        emitChange();
      }
      if (withNote) {
        showNotes(true);
        notesPanel.querySelector(`[data-annotation-id="${CSS.escape(item.id)}"] textarea`)?.focus();
      } else {
        if (!notesPanel.hidden) renderNotes();
        notify('已高亮，标注自动保存');
      }
    }

    function renderNotes() {
      notesPanel.replaceChildren();
      const header = document.createElement('div');
      header.className = 'epub-reader__notes-header';
      const heading = document.createElement('h2');
      heading.textContent = `高亮与笔记 · ${annotations.length}`;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'fmt-btn';
      close.setAttribute('aria-label', '关闭高亮与笔记');
      close.innerHTML = icon('close');
      close.addEventListener('click', () => showNotes(false));
      header.append(heading, close);
      notesPanel.append(header);
      const storageNote = document.createElement('p');
      storageNote.className = 'epub-reader__storage-note';
      storageNote.textContent = '自动保存在观绎 MD，可导出为 Markdown 笔记。';
      notesPanel.append(storageNote);
      if (!annotations.length) {
        const empty = document.createElement('p');
        empty.textContent = '选中文字后，点击工具栏的高亮或笔记按钮。';
        notesPanel.append(empty);
      }
      for (const item of annotations) {
        const card = document.createElement('article');
        card.className = 'epub-reader__note';
        card.dataset.annotationId = item.id;
        card.style.setProperty('--epub-mark-color', COLORS[item.color]);
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'epub-reader__quote';
        jump.title = '跳转到原文';
        jump.textContent = item.quote || '跳转到标注位置';
        jump.addEventListener('click', () => navigate(item.cfi).catch(() => notify('原文位置暂时无法定位，笔记仍已保留')));
        const chapter = document.createElement('small');
        chapter.textContent = item.chapter;
        const textarea = document.createElement('textarea');
        textarea.setAttribute('aria-label', '标注笔记');
        textarea.placeholder = '添加阅读笔记…';
        textarea.maxLength = 20000;
        textarea.value = item.note;
        textarea.addEventListener('input', () => { item.note = textarea.value; emitChange(); });
        const actions = document.createElement('div');
        actions.className = 'epub-reader__note-actions';
        const color = document.createElement('select');
        color.setAttribute('aria-label', '高亮颜色');
        for (const key of Object.keys(COLORS)) {
          const option = document.createElement('option');
          option.value = key;
          option.textContent = COLOR_NAMES[key];
          color.append(option);
        }
        color.value = item.color;
        color.addEventListener('change', () => {
          item.color = color.value;
          card.style.setProperty('--epub-mark-color', COLORS[item.color]);
          repaint(item);
          emitChange();
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'fmt-btn';
        remove.setAttribute('aria-label', '移除此标注');
        remove.title = '移除此标注';
        remove.innerHTML = icon('delete');
        remove.addEventListener('click', () => {
          if (painted.has(item.cfi)) rendition.annotations.remove(item.cfi, 'highlight');
          painted.delete(item.cfi);
          annotations.splice(annotations.indexOf(item), 1);
          emitChange();
          renderNotes();
        });
        actions.append(color, remove);
        card.append(chapter, jump, textarea, actions);
        notesPanel.append(card);
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      if (rendition && !disposed && viewer.clientWidth && viewer.clientHeight) rendition.resize(viewer.clientWidth, viewer.clientHeight);
    });
    const themeObserver = new MutationObserver(() => applyTheme());

    function applyTheme() {
      if (!rendition || disposed) return;
      const dark = document.documentElement.dataset.theme === 'dark';
      rendition.themes.override('color', dark ? '#e7e1db' : '#302b27', true);
      rendition.themes.override('background', dark ? '#24211f' : '#fffdf9', true);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      rendition?.destroy();
      book.destroy();
      controls.forEach((control) => control.remove());
      shell.remove();
    }

    try {
      await withTimeout(book.open(buffer), '解析 EPUB ');
      await withTimeout(Promise.all([book.ready, book.opened]), '准备 EPUB ');
      if (disposed) return { dispose, serialize: async () => original.slice(), exportNotes: () => '' };
      book.spine.hooks.content.register(protectChapter);
      const navigation = await book.loaded.navigation;
      function addChapters(items, level = 0) {
        for (const item of items) {
          if (!item.href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(item.href)) continue;
          const option = document.createElement('option');
          option.value = item.href;
          option.textContent = `${'　'.repeat(Math.min(level, 4))}${item.label.trim() || '章节'}`;
          chapters.append(option);
          chapterLabels.set(item.href.split('#')[0], item.label.trim());
          if (item.subitems?.length) addChapters(item.subitems, level + 1);
        }
      }
      addChapters(navigation.toc || []);
      if (!chapters.options.length) book.spine.each((section) => {
        const option = document.createElement('option');
        option.value = section.href;
        option.textContent = `第 ${section.index + 1} 节`;
        chapters.append(option);
      });
      rendition = book.renderTo(viewer, {
        width: '100%', height: '100%', flow: 'paginated', spread: 'none',
        allowScriptedContent: false, allowPopups: false
      });
      rendition.themes.fontSize(`${fontSize}%`);
      rendition.hooks.content.register((contents) => {
        const doc = contents.document;
        doc.addEventListener('click', (event) => {
          const link = event.target.closest?.('a[href]');
          if (link && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link.getAttribute('href') || '')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            notify('外部链接已停用，请复制链接后在浏览器打开');
          }
        }, true);
        doc.addEventListener('keydown', (event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key === 'ArrowRight') { event.preventDefault(); next.click(); }
          if (event.key === 'ArrowLeft') { event.preventDefault(); previous.click(); }
        });
      });
      rendition.on('selected', async (cfi, contents) => {
        try {
          const range = contents.range(cfi);
          const quote = range.toString().trim().slice(0, 20000);
          if (!disposed && quote) updateSelection({ cfi, quote });
        } catch (_) { updateSelection(null); }
      });
      rendition.on('relocated', (value) => {
        if (disposed || !value?.start) return;
        currentCfi = value.start.cfi;
        currentChapter = chapterLabels.get(value.start.href) || `第 ${value.start.index + 1} 节`;
        const match = [...chapters.options].find((option) => option.value.split('#')[0] === value.start.href);
        if (match) chapters.value = match.value;
        const shown = value.start.displayed;
        location.textContent = shown ? `${shown.page} / ${shown.total}` : '';
        previous.disabled = !!value.atStart;
        next.disabled = !!value.atEnd;
        emitPosition();
      });
      for (const item of annotations) paint(item);
      applyTheme();
      const firstLocation = new Promise((resolve) => rendition.once('relocated', resolve));
      const savedCfi = typeof options.position?.cfi === 'string' && options.position.cfi.startsWith('epubcfi(') ? options.position.cfi : undefined;
      try { await rendition.display(savedCfi); }
      catch (error) {
        if (!savedCfi) throw error;
        await rendition.display();
        notify('原阅读位置无法恢复，已打开书籍开头');
      }
      // A resize before epub.js establishes its first CFI clears the view without
      // a location to redisplay. Observe the container only after that location exists.
      await withTimeout(firstLocation, '显示 EPUB ');
      resizeObserver.observe(viewer);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return {
        dispose,
        serialize: async () => original.slice(),
        exportNotes() {
          const title = String(book.package?.metadata?.title || 'EPUB 阅读笔记').replace(/[\r\n]/g, ' ');
          const lines = [`# ${title} · 阅读笔记`, '', '标注保存在观绎 MD。本文件包含摘录与笔记。', ''];
          for (const item of annotations) {
            lines.push(`## ${item.chapter || '阅读标注'}`, '', item.quote.split('\n').map((line) => `> ${line}`).join('\n'), '');
            if (item.note) lines.push(item.note, '');
            lines.push(`位置：\`${item.cfi}\``, '');
          }
          if (!annotations.length) lines.push('暂无标注。', '');
          return lines.join('\n');
        }
      };
    } catch (error) {
      dispose();
      throw new Error(`EPUB 加载失败：${error.message || error}`);
    }
  }

  window.GuanyiEpubReader = { open };
})();
