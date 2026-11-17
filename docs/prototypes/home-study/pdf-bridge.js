'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
  const bookmarkKey = 'guanyi.home-study.bookmarks.v1';
  let bookmarks;
  try { bookmarks = JSON.parse(localStorage.getItem(bookmarkKey) || '{}'); } catch (_) { bookmarks = {}; }
  let lastLocation = '';
  const snapshot = () => window.__PDF_STUDY_PROTOTYPE__?.getState();
  function renderBookmarks() {
    const state = snapshot();
    if (!state) return;
    const items = bookmarks[state.document] || [];
    $('bookmark-current').textContent = items.some(item => item.page === state.page) ? '− 移除当前页书签' : '＋ 添加当前页书签';
    $('document-bookmarks').innerHTML = items.length ? [...items].sort((a,b) => a.page - b.page).map(item => `<div class="document-bookmark"><button data-page="${Number(item.page)}">${escape(item.title)}<small>第 ${Number(item.page)} 页</small></button><button class="icon-button" data-remove-bookmark="${Number(item.page)}" aria-label="移除第 ${Number(item.page)} 页书签"><svg><use href="#i-close"/></svg></button></div>`).join('') : '<p class="bookmark-empty">还没有书签。<br>把想回来再读的页面留在这里。</p>';
  }
  function notify() {
    const state = snapshot();
    if (!state) return;
    const currentLocation = `${state.document}:${state.page}`;
    if (currentLocation !== lastLocation) { lastLocation = currentLocation; renderBookmarks(); }
    window.parent.postMessage({ type: 'guanyi-pdf-state', document: state.document, page: state.page, panel: state.panel, studyOpen: !$('study-panel').classList.contains('is-hidden') }, location.origin === 'null' ? '*' : location.origin);
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'guanyi-pdf-open') return;
    const { document: documentId, panel, question, theme, page, block, studyOpen } = event.data;
    if ((studyOpen || question) && $('library').classList.contains('is-open')) $('library-toggle').click();
    if (['textbook','paper'].includes(documentId) && snapshot()?.document !== documentId) document.querySelector(`.document-tab[data-document="${documentId}"]`).click();
    if (theme && document.documentElement.dataset.theme !== theme) document.getElementById('theme-button').click();
    if (['guide','ask','cards','notes'].includes(panel) && studyOpen) document.querySelector(`[data-panel="${panel}"]`).click();
    if (page && Number(page) !== snapshot()?.page) {
      const input = document.getElementById('page-input');
      input.value = page;
      input.dispatchEvent(new Event('change', { bubbles:true }));
      if (block) document.querySelector(`[data-block-id="${block}"]`)?.scrollIntoView({block:'center'});
    }
    if (question) {
      document.querySelector('[data-panel="ask"]').click();
      const input = document.getElementById('question-input');
      if (!input.value.trim()) {
        input.value = question;
        input.dispatchEvent(new Event('input', { bubbles:true }));
        input.focus();
      }
    }
    if (studyOpen === false) $('study-panel').classList.add('is-hidden');
    if (studyOpen === true) $('study-panel').classList.remove('is-hidden');
    notify();
  });
  function selectNavigation(mode) {
    document.querySelectorAll('[data-navigation]').forEach(button => { const selected = button.dataset.navigation === mode; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
    $('outline-navigation').hidden = mode !== 'outline';
    $('bookmark-navigation').hidden = mode !== 'bookmarks';
    renderBookmarks();
  }
  $('document-nav-close').addEventListener('click', () => $('library-toggle').click());
  document.querySelectorAll('[data-navigation]').forEach(button => {
    button.addEventListener('click', () => selectNavigation(button.dataset.navigation));
    button.addEventListener('keydown', event => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const mode = event.key === 'Home' ? 'outline' : event.key === 'End' ? 'bookmarks' : button.dataset.navigation === 'outline' ? 'bookmarks' : 'outline'; selectNavigation(mode); document.querySelector(`[data-navigation="${mode}"]`).focus(); });
  });
  document.addEventListener('click', event => {
    const remove = event.target.closest('[data-remove-bookmark]');
    if (event.target.closest('#bookmark-current') || remove) {
      const state = snapshot();
      const page = remove ? Number(remove.dataset.removeBookmark) : state.page;
      const items = bookmarks[state.document] || [];
      const exists = items.some(item => item.page === page);
      bookmarks[state.document] = exists ? items.filter(item => item.page !== page) : [...items, { page, title:$('pdf-page').querySelector('h2')?.textContent || `第 ${page} 页` }];
      try { localStorage.setItem(bookmarkKey, JSON.stringify(bookmarks)); } catch (_) { /* Keep the current session usable. */ }
      renderBookmarks();
    }
  });
  // Capture the navigation intent before the reader re-renders its outline.
  document.addEventListener('click', event => {
    if (event.target.closest('#outline [data-page], #document-bookmarks [data-page]') && innerWidth <= 760) queueMicrotask(() => { if ($('library').classList.contains('is-open')) $('library-toggle').click(); });
  }, true);
  document.addEventListener('click', () => setTimeout(notify, 20));
  document.addEventListener('change', () => setTimeout(notify, 20));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || $('modal').open) return;
    if ($('library').classList.contains('is-open')) $('library-toggle').click();
    else if (!$('study-panel').classList.contains('is-hidden')) $('study-close').click();
    notify();
  });
  $('study-panel').classList.add('is-hidden');
  notify();
  window.parent.postMessage({ type:'guanyi-pdf-ready' }, location.origin === 'null' ? '*' : location.origin);
})();
