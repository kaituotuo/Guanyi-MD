/* Local PDF/EPUB evidence extraction. No model or network service is called here. */
(function () {
  'use strict';

  const PARSER_VERSION = 'pdfjs-native-v1';
  let pdfRuntime;

  function checkAbort(signal) {
    if (!signal?.aborted) return;
    const error = new Error('文字准备已停止，已完成的内容仍保留');
    error.name = 'AbortError';
    throw error;
  }

  async function hashBytes(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持文档来源校验，请使用桌面版或本机服务');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function normalizedText(value) {
    return String(value || '').normalize('NFKC').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
  }

  function itemRect(item, styles = {}) {
    const t = item.transform;
    if (!Array.isArray(t) || t.length < 6 || !t.every(Number.isFinite)) return null;
    const height = Math.max(0.1, Math.hypot(t[2], t[3]) || Number(item.height) || Math.hypot(t[0], t[1]));
    const along = Math.hypot(t[0], t[1]) || 1;
    const horizontal = [t[0] / along, t[1] / along];
    const vertical = [t[2] / height, t[3] / height];
    const style = styles[item.fontName] || {};
    const ascent = Number.isFinite(style.ascent) ? style.ascent : 0.8;
    const descent = Number.isFinite(style.descent) ? style.descent : -0.2;
    const width = Math.max(0.1, Math.abs(Number(item.width) || 0));
    const corners = [];
    for (const x of [0, width]) for (const y of [descent * height, ascent * height]) {
      corners.push([t[4] + horizontal[0] * x + vertical[0] * y, t[5] + horizontal[1] * x + vertical[1] * y]);
    }
    return [Math.min(...corners.map(point => point[0])), Math.min(...corners.map(point => point[1])),
      Math.max(...corners.map(point => point[0])), Math.max(...corners.map(point => point[1]))];
  }

  // Keep the native item order and retain item ranges. Never sort a two-column
  // page into a fabricated sentence or let the model recreate an exact quote.
  function blocksFromTextContent(content, { page, pageLabel, sourceHash, pageWidth = 612 } = {}) {
    const items = Array.isArray(content?.items) ? content.items : [];
    const blocks = [];
    let current = null;
    const finish = () => {
      if (!current) return;
      const text = current.text.trim();
      if (text) blocks.push({
        id: `pdf:${sourceHash}:p${page}:i${current.start}-${current.end}`,
        page, pageLabel: pageLabel || String(page), text, rects: current.rects,
        itemStart: current.start, itemEnd: current.end, sourceHash,
        precise: current.rects.length > 0, extractionStatus: 'native'
      });
      current = null;
    };
    items.forEach((item, index) => {
      if (typeof item?.str !== 'string') return;
      const text = item.str.replace(/\u0000/g, '');
      const rect = itemRect(item, content.styles);
      const height = rect ? Math.max(1, rect[3] - rect[1]) : 10;
      const previous = current?.rects.at(-1);
      const newLine = previous && rect && (Math.abs(previous[1] - rect[1]) > Math.max(height, previous[3] - previous[1]) * 0.65
        || rect[0] < previous[0] - height || rect[0] - previous[2] > Math.max(pageWidth * 0.16, height * 5));
      if (current && (newLine || current.text.length + text.length > 1200)) finish();
      if (!current) current = { start: index, end: index + 1, text: '', rects: [] };
      const lastRect = current.rects.at(-1);
      const space = current.text && text && !/\s$/.test(current.text) && !/^\s/.test(text)
        && lastRect && rect && rect[0] - lastRect[2] > height * 0.16;
      current.text += `${space ? ' ' : ''}${text}`;
      current.end = index + 1;
      if (rect && text.trim()) current.rects.push(rect);
      if (item.hasEOL) finish();
    });
    finish();
    let multipleColumns = false;
    const sample = blocks.slice(0, 240);
    for (let i = 0; i < sample.length && !multipleColumns; i += 1) {
      const left = sample[i].rects[0];
      if (!left) continue;
      for (let j = i + 1; j < Math.min(sample.length, i + 25); j += 1) {
        const right = sample[j].rects[0];
        if (right && Math.abs(left[1] - right[1]) < Math.max(4, (left[3] - left[1]) * 0.6)
          && Math.abs(left[0] - right[0]) > pageWidth * 0.3) { multipleColumns = true; break; }
      }
    }
    const text = blocks.map(block => block.text).join('\n');
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    const warning = multipleColumns ? '本页可能含多栏或并排内容，已按原始文字层分块，请核对阅读顺序。'
      : replacementCount > Math.max(2, text.length * 0.02) ? '本页文字层存在无法识别的字符，请对照原文核验。' : '';
    if (warning) blocks.forEach(block => { block.extractionStatus = 'needs_review'; });
    return { blocks, scanned: !text.trim(), warning };
  }

  async function extractPage(pdf, pageNumber, { sourceHash, signal, pageLabel } = {}) {
    checkAbort(signal);
    const number = Math.max(1, Math.min(pdf.numPages, Math.round(Number(pageNumber) || 1)));
    const page = await pdf.getPage(number);
    checkAbort(signal);
    const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
    checkAbort(signal);
    const result = blocksFromTextContent(content, { page: number, pageLabel, sourceHash, pageWidth: page.view[2] - page.view[0] });
    return { page: number, label: pageLabel || String(number), ...result, parserVersion: PARSER_VERSION };
  }

  async function runtime() {
    if (!pdfRuntime) {
      const moduleUrl = new URL('vendor/pdfjs/build/pdf.mjs', document.baseURI).href;
      pdfRuntime = import(moduleUrl).then(library => {
        library.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/build/pdf.worker.mjs', document.baseURI).href;
        return library;
      }).catch(error => { pdfRuntime = null; throw error; });
    }
    return pdfRuntime;
  }

  function sourceBudgets(options) {
    return {
      maxPages: Math.max(1, Math.min(100, Math.floor(Number(options.maxPages) || 50))),
      maxChars: Math.max(1000, Math.min(120000, Math.floor(Number(options.maxChars) || 60000)))
    };
  }

  async function collectPdf(pdf, options = {}) {
    const { maxPages, maxChars } = sourceBudgets(options);
    const permissions = await pdf.getPermissions?.();
    if (Array.isArray(permissions) && !permissions.includes(16)) throw new Error('这份 PDF 限制复制文字，不能准备智能研读；原版阅读和允许的批注仍可使用');
    const labels = await pdf.getPageLabels().catch(() => null);
    const evidence = [];
    const processedPages = [];
    const scannedPages = [];
    const warnings = [];
    let characters = 0;
    let truncated = false;
    for (let page = 1; page <= Math.min(pdf.numPages, maxPages); page += 1) {
      checkAbort(options.signal);
      const record = await extractPage(pdf, page, { ...options, pageLabel: labels?.[page - 1] });
      processedPages.push(page);
      if (record.scanned) scannedPages.push(page);
      if (record.warning) warnings.push({ page, message: record.warning });
      for (const block of record.blocks) {
        if (characters + block.text.length > maxChars) {
          if (!evidence.length) evidence.push({ ...block, text: block.text.slice(0, maxChars), truncated: true });
          truncated = true;
          break;
        }
        evidence.push(block);
        characters += block.text.length;
      }
      if (truncated) break;
    }
    return { evidence, coverage: { format: 'pdf', sourceHash: options.sourceHash, totalPages: pdf.numPages,
      processedPages, indexedPages: processedPages.length, scannedPages, warnings, complete: processedPages.length === pdf.numPages && !truncated,
      truncated, maxPages, maxChars, parserVersion: PARSER_VERSION } };
  }

  async function readPdf(bytes, options = {}) {
    checkAbort(options.signal);
    const library = await runtime();
    checkAbort(options.signal);
    const task = library.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true,
      cMapUrl: new URL('vendor/pdfjs/web/cmaps/', document.baseURI).href, cMapPacked: true,
      standardFontDataUrl: new URL('vendor/pdfjs/web/standard_fonts/', document.baseURI).href });
    const stop = () => { task.destroy().catch(() => {}); };
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) { stop(); checkAbort(options.signal); }
    task.onPassword = () => { stop(); };
    try {
      const pdf = await task.promise;
      return await collectPdf(pdf, options);
    } catch (error) {
      checkAbort(options.signal);
      if (/password|worker.*destroy/i.test(error?.message || '')) throw new Error('这份 PDF 需要密码，请先在阅读器中解锁后再选择它');
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', stop);
      await task.destroy().catch(() => {});
    }
  }

  function parseXml(value) {
    const xml = new DOMParser().parseFromString(value, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('电子书结构无法读取');
    return xml;
  }

  async function readEpub(bytes, options = {}) {
    checkAbort(options.signal);
    if (!window.JSZip) throw new Error('电子书解析资源尚未就绪，请先打开文档');
    const zip = await window.JSZip.loadAsync(bytes);
    const entries = Object.values(zip.files).filter(entry => !entry.dir);
    if (entries.length > 10000 || entries.reduce((sum, entry) => sum + (entry._data?.uncompressedSize || 0), 0) > 200 * 1024 * 1024
      || entries.some(entry => entry._data?.uncompressedSize > 40 * 1024 * 1024)) throw new Error('电子书解压后的资源过大，未读取正文');
    const encryption = zip.file('META-INF/encryption.xml');
    if (encryption) {
      const xml = parseXml(await encryption.async('string'));
      const methods = [...xml.getElementsByTagNameNS('*', 'EncryptionMethod')];
      if (!methods.length || methods.some(element => !['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'].includes(element.getAttribute('Algorithm')))) {
        throw new Error('此书含不支持的加密资源，不能读取正文');
      }
    }
    const container = zip.file('META-INF/container.xml');
    if (!container) throw new Error('电子书缺少书籍描述文件');
    const packagePath = parseXml(await container.async('string')).getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
    const packageFile = packagePath && zip.file(packagePath);
    if (!packageFile) throw new Error('电子书正文清单不可用');
    const opf = parseXml(await packageFile.async('string'));
    const manifest = new Map([...opf.getElementsByTagNameNS('*', 'item')].map(item => [item.getAttribute('id'), item.getAttribute('href')]));
    const spine = [...opf.getElementsByTagNameNS('*', 'itemref')].map((item, index) => ({ item, index }))
      .filter(({ item }) => item.getAttribute('linear') !== 'no');
    const { maxPages: maxSections, maxChars } = sourceBudgets(options);
    const evidence = [];
    let characters = 0;
    let processedSections = 0;
    let truncated = false;
    const selectedSections = Array.isArray(options.sectionIndexes)
      ? spine.filter(({ index }) => options.sectionIndexes.includes(index)) : spine;
    for (const { item, index } of selectedSections.slice(0, maxSections)) {
      checkAbort(options.signal);
      const href = manifest.get(item.getAttribute('idref'));
      if (!href || /^[a-z][a-z\d+.-]*:/i.test(href)) continue;
      const resolved = new URL(href, `https://epub.local/${packagePath}`);
      const filePath = decodeURIComponent(resolved.pathname.slice(1));
      const entry = zip.file(filePath) || zip.file(resolved.pathname.slice(1));
      if (!entry) continue;
      // EPUB spine documents are XHTML. XML parsing keeps remote images and
      // frames inert; no chapter markup is inserted into the application DOM.
      const html = parseXml(await entry.async('string'));
      html.querySelectorAll('script,style,nav,iframe,object').forEach(element => element.remove());
      const title = normalizedText(html.querySelector('h1,h2,title')?.textContent) || `第 ${index + 1} 章`;
      const chunks = [...html.querySelectorAll('p,h1,h2,h3,h4,li,blockquote,pre')].filter(element => !element.parentElement?.closest('p,li,blockquote,pre'));
      const texts = (chunks.length ? chunks.map(element => normalizedText(element.textContent)) : [normalizedText((html.querySelector('body') || html.documentElement).textContent)]).filter(Boolean);
      for (let block = 0; block < texts.length; block += 1) {
        if (characters + texts[block].length > maxChars) { truncated = true; break; }
        evidence.push({ id: `epub:${options.sourceHash}:s${index}:b${block}`, page: null, pageLabel: `第 ${index + 1} 章`,
          section: title, sectionIndex: index, blockIndex: block, text: texts[block], sourceHash: options.sourceHash, rects: [], precise: false, locationType: 'chapter' });
        characters += texts[block].length;
      }
      processedSections += 1;
      if (truncated) break;
    }
    return { evidence, coverage: { format: 'epub', sourceHash: options.sourceHash, totalSections: spine.length, processedSections,
      complete: processedSections === spine.length && !truncated, truncated, maxSections, maxChars,
      selectedSections: selectedSections.map(({ index }) => index), parserVersion: 'epub-spine-v1' } };
  }

  const api = { PARSER_VERSION, checkAbort, hashBytes, normalizedText, itemRect, blocksFromTextContent, extractPage, collectPdf, readPdf, readEpub };
  if (typeof window !== 'undefined') window.GuanyiPdfEvidence = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
