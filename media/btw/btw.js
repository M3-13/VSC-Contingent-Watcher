// btw window: one quick side question about the current Copilot session.
// Plain JS, no build step. State lives in the extension; only the draft is kept via setState.
// @ts-check
(function () {
  'use strict';

  /* global acquireVsCodeApi */
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /** @type {Record<string, string>} */
  let S = {};
  /** @type {{ title?: string, model?: string, modelNote?: string }} */
  let header = {};
  /** @type {any} */
  let card = null;
  let built = false;
  let frame = 0;
  /** @type {HTMLTextAreaElement} */ let input;
  /** @type {HTMLElement} */ let live;

  const saved = safe(() => vscode.getState()) || {};
  let draft = typeof saved.draft === 'string' ? saved.draft : '';

  /** @template T @param {() => T} fn @returns {T | undefined} */
  function safe(fn) {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  function persist() {
    safe(() => vscode.setState({ draft }));
  }

  /** @param {unknown} s */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
  }

  /** @param {string} id @param {...unknown} args */
  function t(id, ...args) {
    const s = S[id] || id;
    return esc(s.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? String(args[i]) : '')));
  }

  // ---------------------------------------------------------------- icons

  const I = (body) =>
    `<svg class="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const icon = {
    send: I('<path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25"/>'),
    stop: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>`,
    copy: I('<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.75"/><path d="M10.75 5.25V3.75a1.5 1.5 0 0 0-1.5-1.5h-5.5a1.5 1.5 0 0 0-1.5 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5h1.5"/>'),
    check: I('<path d="M3.25 8.5 6.5 11.75 12.75 4.5"/>'),
    chat: I('<path d="M2.5 3.5h11v7.5H7.5l-3 2.5V11h-2z"/>'),
    retry: I('<path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M13.25 2.5v3h-3"/>'),
    gear: I('<circle cx="8" cy="8" r="2.25"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"/>'),
    model: I('<path d="M8 1.75 13.5 4.9v6.2L8 14.25 2.5 11.1V4.9z"/><path d="M2.75 5 8 8l5.25-3M8 8v6"/>'),
    close: I('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
    clear: I('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.25c.05.7.6 1.25 1.3 1.25h3.2c.7 0 1.25-.55 1.3-1.25l.6-8.25"/>'),
    aside: I('<path d="M2.5 4.5h7M2.5 8h5M2.5 11.5h4"/><path d="M10.5 7.25a2.75 2.75 0 1 1 1.6 2.5L10.5 11z"/>'),
    warn: I('<path d="M8 2.25 14.25 13.5H1.75z"/><path d="M8 6.5v3M8 11.6v.01"/>'),
  };

  // ---------------------------------------------------------------- markdown (safe subset)

  /**
   * Inline Markdown on raw text: everything is HTML-escaped first; only fixed
   * tags are introduced afterwards (code, strong, em, link label + url as text).
   * @param {string} raw
   */
  function inline(raw) {
    /** @type {string[]} */
    const codes = [];
    let s = esc(raw);
    s = s.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    // Links as plain text: label followed by the (non-clickable) address.
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label, url) =>
      label === url ? `<span class="url">${url}</span>` : `${label} <span class="url">(${url})</span>`,
    );
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  }

  /** @param {string} lang @param {string} code @param {boolean} open */
  function codeBlock(lang, code, open) {
    const l = lang ? `<span class="lang">${esc(lang)}</span>` : '<span class="lang"></span>';
    const copy = open
      ? ''
      : `<button type="button" class="tool code-copy" data-act="copyCode" title="${t('copyCode')}" aria-label="${t('copyCode')}">${icon.copy}<span>${t('copy')}</span></button>`;
    return `<div class="code"><div class="code-head">${l}${copy}</div><pre><code>${esc(code)}</code></pre></div>`;
  }

  /** @param {string} src */
  function markdown(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    let para = [];
    /** @type {{ tag: string, start: number, items: { text: string, depth: number }[] } | null} */
    let list = null;

    const flushPara = () => {
      if (para.length) {
        out.push(`<p>${para.map(inline).join('<br>')}</p>`);
        para = [];
      }
    };
    const flushList = () => {
      if (list) {
        const start = list.tag === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
        out.push(
          `<${list.tag}${start}>${list.items.map((it) => `<li${it.depth ? ` class="d${Math.min(it.depth, 3)}"` : ''}>${inline(it.text)}</li>`).join('')}</${list.tag}>`,
        );
        list = null;
      }
    };
    const flush = () => {
      flushPara();
      flushList();
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
      if (fence) {
        flush();
        const marker = fence[1];
        const close = new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
        const body = [];
        let closed = false;
        for (i++; i < lines.length; i++) {
          if (close.test(lines[i])) {
            closed = true;
            break;
          }
          body.push(lines[i]);
        }
        out.push(codeBlock(fence[2], body.join('\n'), !closed));
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        flush();
        const level = Math.min(6, h[1].length + 2); // h3..h6: compact panel headings
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        out.push('<hr>');
        continue;
      }
      const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      const ol = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        const indent = (ul || ol)[1].replace(/\t/g, '    ').length;
        const depth = Math.floor(indent / 2);
        if (!list || (list.tag !== tag && depth === 0)) {
          flushList();
          list = { tag, start: ol ? Number(ol[2]) : 1, items: [] };
        }
        list.items.push({ text: ul ? ul[2] : ol[3], depth });
        continue;
      }
      const q = /^\s{0,3}>\s?(.*)$/.exec(line);
      if (q) {
        flush();
        out.push(`<blockquote>${inline(q[1])}</blockquote>`);
        continue;
      }
      if (list && /^\s+\S/.test(line)) {
        list.items[list.items.length - 1].text += ' ' + line.trim();
        continue;
      }
      flushList();
      para.push(line.trim());
    }
    flush();
    return out.join('');
  }



  // ---------------------------------------------------------------- rendering

  const busy = () => !!card && (card.status === 'thinking' || card.status === 'streaming');

  function build() {
    built = true;
    app.innerHTML = `
      <header class="top">
        <span class="tag" aria-hidden="true">btw</span>
        <span class="title" id="title"></span>
        <button type="button" class="model" id="model"></button>
        <button type="button" class="icon-btn" id="close" title="${t('close')}" aria-label="${t('close')}">${icon.close}</button>
      </header>
      <form class="ask" id="ask" novalidate>
        <label class="sr-only" for="input">${t('inputLabel')}</label>
        <div class="box">
          <textarea id="input" rows="1" placeholder="${t('placeholder')}" aria-describedby="hint" spellcheck="true"></textarea>
          <button type="submit" class="send" id="send" title="${t('send')}" aria-label="${t('send')}">${icon.send}</button>
        </div>
        <span class="sr-only" id="hint">${t('hint')}</span>
      </form>
      <main class="body" id="body"></main>
      <div class="sr-only" id="live" aria-live="polite"></div>`;
    app.removeAttribute('aria-busy');
    input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
    live = /** @type {HTMLElement} */ (document.getElementById('live'));
    input.value = draft;
    autosize();
    document.getElementById('ask')?.addEventListener('submit', (e) => {
      e.preventDefault();
      send();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        send();
      }
    });
    input.addEventListener('input', () => {
      draft = input.value;
      persist();
      autosize();
      updateSend();
    });
    document.getElementById('close')?.addEventListener('click', () => vscode.postMessage({ type: 'close' }));
    document.getElementById('model')?.addEventListener('click', () => vscode.postMessage({ type: 'chooseModel' }));
    document.getElementById('body')?.addEventListener('click', onBodyClick);
    // Esc anywhere closes the window (and returns to the chat).
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        vscode.postMessage({ type: 'close' });
      }
    });
  }

  function autosize() {
    input.style.height = '';
    if (input.value) {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    }
  }

  function updateSend() {
    const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('send'));
    if (!btn) {
      return;
    }
    if (busy()) {
      btn.innerHTML = icon.stop;
      btn.title = S.stop || 'Stop';
      btn.setAttribute('aria-label', btn.title);
      btn.classList.add('stop');
      btn.disabled = false;
    } else {
      btn.innerHTML = icon.send;
      btn.title = S.send || 'Send';
      btn.setAttribute('aria-label', btn.title);
      btn.classList.remove('stop');
      btn.disabled = !input.value.trim();
    }
  }

  function send() {
    if (busy() && !input.value.trim()) {
      vscode.postMessage({ type: 'stop' });
      return;
    }
    const q = input.value.trim();
    if (!q) {
      return;
    }
    vscode.postMessage({ type: 'ask', question: q });
    input.value = '';
    draft = '';
    persist();
    autosize();
  }

  /** @param {string} [prefill] */
  function focusInput(prefill) {
    if (typeof prefill === 'string' && prefill) {
      input.value = prefill;
      draft = prefill;
      persist();
      autosize();
      updateSend();
    }
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }

  function renderHeader() {
    const title = document.getElementById('title');
    if (title) {
      title.textContent = header.title || S.noSession || '';
      title.title = header.title || '';
      title.classList.toggle('none', !header.title);
    }
    const model = document.getElementById('model');
    if (model) {
      model.innerHTML = `${icon.model}<span>${esc(header.model || S.chooseModel || '')}</span>`;
      model.title = `${header.modelNote ? header.modelNote + ' · ' : ''}${S.modelTitle || ''}`;
      model.classList.toggle('unset', !header.model);
    }
  }

  function renderEmpty() {
    return `<div class="empty">
      <div class="empty-icon" aria-hidden="true">${icon.aside}</div>
      <p class="empty-title">${t('emptyTitle')}</p>
      <p class="empty-body">${t('emptyBody')}</p>
    </div>`;
  }

  function answerHtml() {
    const c = card;
    if (c.status === 'thinking' || (c.status === 'streaming' && !c.answer)) {
      return `<p class="thinking">${t('thinking')}<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></p>`;
    }
    let h = c.answer ? markdown(c.answer) : '';
    if (c.status === 'streaming') {
      const caret = '<span class="caret" aria-hidden="true"></span>';
      const m = /<\/(?:p|li|h\d|blockquote)>(?:<\/(?:ul|ol)>)?$/.exec(h);
      h = m ? h.slice(0, m.index) + caret + h.slice(m.index) : h + caret;
    }
    if (c.status === 'cancelled') {
      h += `<p class="note">${t('stopped')}</p>`;
    }
    if (c.status === 'error') {
      h += `<p class="note error">${icon.warn}<span>${esc(c.error || '')}</span></p>`;
    }
    return h;
  }

  function footHtml() {
    const c = card;
    const parts = [];
    if (c.context) {
      parts.push(t('context', c.context));
    }
    if (c.model) {
      parts.push(esc(c.model));
    }
    const copy =
      c.answer && !busy()
        ? `<button type="button" class="tool" data-act="copy" title="${t('copyAnswer')}" aria-label="${t('copyAnswer')}">${icon.copy}<span>${t('copy')}</span></button>`
        : '';
    return `<p class="meta">${parts.join(' <span class="sep" aria-hidden="true">·</span> ')}</p>${copy}`;
  }

  function renderBody() {
    const body = document.getElementById('body');
    if (!body) {
      return;
    }
    if (!card) {
      body.innerHTML = renderEmpty();
      updateSend();
      return;
    }
    let el = document.getElementById('card');
    if (!el || el.getAttribute('data-id') !== card.id) {
      body.innerHTML = `<article class="card" id="card" data-id="${esc(card.id)}" aria-labelledby="q">
        <h2 class="q" id="q"></h2>
        <div class="a md" id="answer"></div>
        <div class="foot" id="foot"></div>
      </article>`;
      el = document.getElementById('card');
      const q = document.getElementById('q');
      if (q) {
        q.textContent = card.question;
      }
    }
    const a = document.getElementById('answer');
    if (a) {
      a.innerHTML = answerHtml();
      a.setAttribute('aria-busy', String(busy()));
    }
    const foot = document.getElementById('foot');
    if (foot) {
      foot.innerHTML = footHtml();
      foot.hidden = !(card.context || card.model || card.answer);
    }
    el?.classList.toggle('busy', busy());
    updateSend();
  }

  function schedule() {
    if (frame) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderBody();
    });
  }

  /** @param {MouseEvent} e */
  function onBodyClick(e) {
    const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-act]'));
    if (!btn || !card) {
      return;
    }
    switch (btn.getAttribute('data-act')) {
      case 'copyCode': {
        const code = btn.closest('.code')?.querySelector('pre code');
        if (code) {
          vscode.postMessage({ type: 'copy', text: code.textContent || '' });
          flashCopied(btn);
        }
        return;
      }
      case 'copy':
        vscode.postMessage({ type: 'copy', text: card.answer });
        flashCopied(btn);
        return;
    }
  }

  /** @param {HTMLElement} btn */
  function flashCopied(btn) {
    const label = btn.querySelector('span');
    const svg = btn.querySelector('svg');
    if (!label || !svg) {
      return;
    }
    const old = label.textContent;
    const oldIcon = svg.outerHTML;
    label.textContent = S.copied || 'Copied';
    svg.outerHTML = icon.check;
    btn.classList.add('done');
    live.textContent = S.copied || 'Copied';
    setTimeout(() => {
      if (!btn.isConnected) {
        return;
      }
      label.textContent = old;
      const now = btn.querySelector('svg');
      if (now) {
        now.outerHTML = oldIcon;
      }
      btn.classList.remove('done');
    }, 1400);
  }

  // ---------------------------------------------------------------- messages

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') {
      return;
    }
    switch (msg.type) {
      case 'init':
        S = msg.strings || {};
        header = msg.header || {};
        card = msg.card || null;
        if (!built) {
          build();
        }
        renderHeader();
        renderBody();
        if (msg.focus) {
          focusInput(msg.focus.prefill);
        }
        return;
      case 'header':
        header = msg.header || {};
        if (built) {
          renderHeader();
        }
        return;
      case 'focus':
        if (built) {
          focusInput(msg.prefill);
        }
        return;
      case 'card': {
        const was = card && card.id === msg.card.id ? card.status : undefined;
        card = msg.card;
        if (built) {
          schedule();
          if (was && was !== 'done' && card.status === 'done') {
            live.textContent = S.answerReady || '';
          }
        }
        return;
      }
      case 'delta': {
        const at = Number(msg.at);
        if (card && card.id === msg.id && Number.isInteger(at) && at >= 0 && at <= (card.answer || '').length) {
          card.answer = (card.answer || '').slice(0, at) + msg.text;
          if (card.status === 'thinking') {
            card.status = 'streaming';
          }
          schedule();
        }
        return;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
