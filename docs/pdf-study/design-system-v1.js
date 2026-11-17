'use strict';

(() => {
  const documentTabs = [...document.querySelectorAll('.document-tab')];
  const panelTabs = [...document.querySelectorAll('.panel-tabs [role="tab"]')];
  const studyPanel = document.getElementById('study-panel');
  const studyToggle = document.getElementById('study-toggle');
  const studyClose = document.getElementById('study-close');
  const library = document.getElementById('library');
  const libraryToggle = document.getElementById('library-toggle');
  const themeButton = document.getElementById('theme-button');
  const scrim = document.getElementById('workspace-scrim');

  const isCompact = () => window.matchMedia('(max-width: 760px)').matches;
  const isOverlayStudy = () => window.matchMedia('(max-width: 1179px)').matches;

  function syncDocumentTabs() {
    const active = documentTabs.find(tab => tab.classList.contains('active')) || documentTabs[0];
    documentTabs.forEach(tab => {
      const selected = tab === active;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
  }

  function syncPanelTabs() {
    panelTabs.forEach(tab => {
      const selected = tab.getAttribute('aria-selected') === 'true';
      tab.tabIndex = selected ? 0 : -1;
    });
  }

  function syncTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeButton.setAttribute('aria-pressed', String(dark));
    themeButton.setAttribute('aria-label', dark ? '切换为浅色主题' : '切换为深色主题');
    themeButton.title = dark ? '切换为浅色主题' : '切换为深色主题';
  }

  function syncStudy() {
    const open = !studyPanel.classList.contains('is-hidden');
    studyToggle.setAttribute('aria-expanded', String(open));
    studyToggle.setAttribute('aria-label', open ? '收起智能研读面板' : '打开智能研读面板');
    studyPanel.setAttribute('aria-hidden', String(!open));
    if (isOverlayStudy()) {
      studyPanel.setAttribute('role', 'dialog');
      studyPanel.setAttribute('aria-modal', open ? 'true' : 'false');
    } else {
      studyPanel.setAttribute('role', 'complementary');
      studyPanel.removeAttribute('aria-modal');
    }
    document.body.classList.toggle('study-drawer-open', open && isOverlayStudy());
  }

  function syncLibrary() {
    const compact = isCompact();
    const open = compact ? library.classList.contains('is-open') : !library.classList.contains('is-hidden');
    libraryToggle.setAttribute('aria-expanded', String(open));
    libraryToggle.setAttribute('aria-label', open ? '收起文档目录' : '展开文档目录');
    library.setAttribute('aria-hidden', String(!open));
    if (compact) {
      library.setAttribute('role', 'dialog');
      library.setAttribute('aria-modal', open ? 'true' : 'false');
    } else {
      library.removeAttribute('role');
      library.removeAttribute('aria-modal');
    }
    document.body.classList.toggle('library-drawer-open', compact && open);
  }

  function syncAll() {
    syncDocumentTabs();
    syncPanelTabs();
    syncTheme();
    syncStudy();
    syncLibrary();
  }

  libraryToggle.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (isCompact()) {
      const opening = !library.classList.contains('is-open');
      if (opening && !studyPanel.classList.contains('is-hidden')) studyClose.click();
      library.classList.remove('is-hidden');
      library.classList.toggle('is-open', opening);
    } else {
      library.classList.remove('is-open');
      library.classList.toggle('is-hidden');
    }
    syncLibrary();
  }, true);

  studyToggle.addEventListener('click', () => {
    if (library.classList.contains('is-open')) library.classList.remove('is-open');
    queueMicrotask(syncAll);
  }, true);

  scrim.addEventListener('click', () => {
    if (library.classList.contains('is-open')) {
      library.classList.remove('is-open');
      libraryToggle.focus({ preventScroll: true });
      syncLibrary();
      return;
    }
    if (!studyPanel.classList.contains('is-hidden')) studyClose.click();
  });

  documentTabs.forEach((tab, index) => {
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? documentTabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : documentTabs.length - 1)) % documentTabs.length;
      documentTabs[nextIndex].click();
      documentTabs[nextIndex].focus();
    });
  });

  document.addEventListener('click', event => {
    if (isCompact() && event.target.closest('.library-document')) library.classList.remove('is-open');
    queueMicrotask(syncAll);
  });

  window.addEventListener('resize', () => {
    if (!isCompact()) library.classList.remove('is-open');
    syncAll();
  });

  new MutationObserver(syncDocumentTabs).observe(document.querySelector('.document-tabs'), {
    attributes: true,
    attributeFilter: ['class'],
    subtree: true
  });
  new MutationObserver(syncPanelTabs).observe(document.querySelector('.panel-tabs'), {
    attributes: true,
    attributeFilter: ['aria-selected'],
    subtree: true
  });
  new MutationObserver(syncStudy).observe(studyPanel, {
    attributes: true,
    attributeFilter: ['class']
  });
  new MutationObserver(syncLibrary).observe(library, {
    attributes: true,
    attributeFilter: ['class']
  });
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  });

  document.documentElement.dataset.prototypeVersion = 'v0.3-ds-v1';
  syncAll();
})();
