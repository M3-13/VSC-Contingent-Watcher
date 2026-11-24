// btw side-question panel. Plain JS, no build step.
// State lives in the extension (session only); this keeps just the draft via setState.
// @ts-check
(function () {
  'use strict';

  /* global acquireVsCodeApi */
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /** @type {Record<string, string>} */
  let S = {};
  /** @type {any[]} */
  let cards = [];
  let built = false;
  /** @type {HTMLElement} */ let list;
  /** @type {HTMLElement} */ let scroller;
  /** @type {HTMLTextAreaElement} */ let input;
  /** @type {HTMLElement} */ let live;
  /** @type {Set<string>} */
  const dirty = new Set();
  let frame = 0;

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

  function build() {
    built = true;
    app.innerHTML = `
      <div class="scroller" id="scroller">
        <div class="list" id="list"></div>
      </div>
      <form class="composer" id="composer" novalidate>
        <div class="box">
          <label class="sr-only" for="input">${t('inputLabel')}</label>
          <textarea id="input" rows="1" placeholder="${t('placeholder')}" aria-describedby="hint" spellcheck="true"></textarea>
          <span class="hint" id="hint">${t('hint')}</span>
          <button type="submit" class="send" id="send" title="${t('send')}" aria-label="${t('send')}">${icon.send}</button>
        </div>
      </form>
      <div class="sr-only" id="live" aria-live="polite"></div>`;
    app.removeAttribute('aria-busy');
    list = /** @type {HTMLElement} */ (document.getElementById('list'));
    scroller = /** @type {HTMLElement} */ (document.getElementById('scroller'));
    input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
    live = /** @type {HTMLElement} */ (document.getElementById('live'));
    input.value = draft;
    autosize();
    updateSend();

    const form = /** @type {HTMLFormElement} */ (document.getElementById('composer'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      send();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        send();
      } else if (e.key === 'Escape') {
        const run = [...cards].reverse().find((c) => c.status === 'thinking' || c.status === 'streaming');
        if (run) {
          e.preventDefault();
          vscode.postMessage({ type: 'cancel', id: run.id });
        }
      }
    });
    input.addEventListener('input', () => {
      draft = input.value;
      persist();
      autosize();
      updateSend();
    });
    list.addEventListener('click', onListClick);
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }

  function updateSend() {
    const btn = document.getElementById('send');
    if (btn) {
      btn.toggleAttribute('disabled', !input.value.trim());
    }
    document.body.classList.toggle('has-text', input.value.length > 0);
  }

  function send() {
    const q = input.value.trim();
    if (!q) {
      return;
    }
    vscode.postMessage({ type: 'ask', question: q });
    input.value = '';
    draft = '';
    persist();
    autosize();
    updateSend();
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

  function renderEmpty() {
    return `<div class="empty">
      <div class="empty-icon" aria-hidden="true">${icon.aside}</div>
      <div><p class="empty-title"><span class="tag">btw</span> ${t('emptyTitle')}</p>
      <p class="empty-body">${t('emptyBody')}</p></div>
    </div>`;
  }

  /** @param {any} c */
  function answerHtml(c) {
    if (c.status === 'thinking' || (c.status === 'streaming' && !c.answer)) {
      return `<p class="thinking">${t('thinking')}<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></p>`;
    }
    let h = c.answer ? markdown(c.answer) : '';
    if (c.status === 'streaming') {
      // Caret at the end of the last text block (not on a line of its own).
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

  /** @param {any} c */
  function metaHtml(c) {
    const meta = [];
    if (c.context) {
      meta.push(t('context', c.context));
    }
    if (c.model) {
      meta.push(t('includedModel', c.model));
    }
    meta.push(t('notAdded'));
    return meta.join(' <span class="sep" aria-hidden="true">·</span> ');
  }

  /** @param {any} c */
  function actionsHtml(c) {
    const busy = c.status === 'thinking' || c.status === 'streaming';
    const acts = [];
    if (busy) {
      acts.push(`<button type="button" class="tool" data-act="cancel">${icon.stop}<span>${t('stop')}</span></button>`);
    } else {
      if (c.status === 'noModel') {
        acts.push(`<button type="button" class="tool primary" data-act="openSettings">${icon.gear}<span>${t('openSettings')}</span></button>`);
      }
      if (c.status === 'error' || c.status === 'cancelled' || c.status === 'noModel') {
        acts.push(`<button type="button" class="tool" data-act="retry">${icon.retry}<span>${t('retry')}</span></button>`);
      }
      if (c.answer && c.status !== 'noModel') {
        acts.push(`<button type="button" class="tool" data-act="copy" title="${t('copyAnswer')}" aria-label="${t('copyAnswer')}">${icon.copy}<span>${t('copy')}</span></button>`);
      }
      acts.push(`<button type="button" class="tool" data-act="continue" title="${t('continueTitle')}">${icon.chat}<span>${t('continueInChat')}</span></button>`);
    }
    return acts.join('');
  }

  /** @param {any} c */
  function cardHtml(c) {
    const busy = c.status === 'thinking' || c.status === 'streaming';
    return `<article class="card st-${esc(c.status)}" id="c-${esc(c.id)}" data-id="${esc(c.id)}" aria-labelledby="q-${esc(c.id)}">
      <div class="head">
        <h2 class="q" id="q-${esc(c.id)}"><span class="tag" aria-hidden="true">btw</span><span class="sr-only">${t('question')}: </span>${esc(c.question)}</h2>
        <div class="actions">${actionsHtml(c)}</div>
      </div>
      <div class="a md" aria-busy="${busy}">${answerHtml(c)}</div>
      <p class="meta"${c.context ? '' : ' hidden'}>${metaHtml(c)}</p>
    </article>`;
  }

  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }

  function scrollToBottom() {
    scroller.scrollTop = scroller.scrollHeight;
  }

  function renderAll() {
    list.innerHTML = cards.length ? cards.map(cardHtml).join('') : renderEmpty();
    document.body.classList.toggle('is-empty', cards.length === 0);
    scrollToBottom();
  }

  /** @param {any} c */
  function renderCard(c) {
    const stick = nearBottom();
    const el = document.getElementById(`c-${c.id}`);
    if (!el) {
      if (!list.querySelector('.card')) {
        list.innerHTML = '';
        document.body.classList.remove('is-empty');
      }
      list.insertAdjacentHTML('beforeend', cardHtml(c));
      scrollToBottom();
      return;
    }
    const a = el.querySelector('.a');
    const acts = el.querySelector('.actions');
    const meta = el.querySelector('.meta');
    el.className = `card st-${c.status}`;
    if (a) {
      a.innerHTML = answerHtml(c);
      a.setAttribute('aria-busy', String(c.status === 'thinking' || c.status === 'streaming'));
    }
    if (meta) {
      meta.innerHTML = metaHtml(c);
      meta.toggleAttribute('hidden', !c.context);
    }
    if (acts) {
      const html = actionsHtml(c);
      if (acts.getAttribute('data-html') !== html) {
        // Keep keyboard focus on the same action (or the input) after re-rendering.
        const focused = acts.contains(document.activeElement)
          ? /** @type {HTMLElement} */ (document.activeElement).getAttribute('data-act')
          : null;
        acts.innerHTML = html;
        acts.setAttribute('data-html', html);
        if (focused) {
          const again = /** @type {HTMLElement | null} */ (acts.querySelector(`[data-act="${focused}"]`));
          (again || input).focus();
        }
      }
    }
    if (stick) {
      scrollToBottom();
    }
  }

  function scheduleDirty() {
    if (frame) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const id of dirty) {
        const c = cards.find((x) => x.id === id);
        if (c) {
          renderCard(c);
        }
      }
      dirty.clear();
    });
  }

  /** @param {MouseEvent} e */
  function onListClick(e) {
    const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-act]'));
    if (!btn) {
      return;
    }
    const cardEl = btn.closest('.card');
    const id = cardEl ? cardEl.getAttribute('data-id') : null;
    const c = cards.find((x) => x.id === id);
    const act = btn.getAttribute('data-act');
    switch (act) {
      case 'copyCode': {
        const code = btn.closest('.code')?.querySelector('pre code');
        if (code) {
          vscode.postMessage({ type: 'copy', text: code.textContent || '' });
          flashCopied(btn);
        }
        return;
      }
      case 'copy':
        if (c) {
          vscode.postMessage({ type: 'copy', text: c.answer });
          flashCopied(btn);
        }
        return;
      case 'cancel':
      case 'retry':
      case 'continue':
        if (c) {
          vscode.postMessage({ type: act, id: c.id });
        }
        return;
      case 'openSettings':
        vscode.postMessage({ type: 'openSettings' });
        return;
    }
  }

  /** @param {HTMLElement} btn */
  function flashCopied(btn) {
    const label = btn.querySelector('span');
    const prevIcon = btn.querySelector('svg');
    if (!label || !prevIcon) {
      return;
    }
    const old = label.textContent;
    const oldIcon = prevIcon.outerHTML;
    label.textContent = S.copied || 'Copied';
    prevIcon.outerHTML = icon.check;
    btn.classList.add('done');
    live.textContent = S.copied || 'Copied';
    setTimeout(() => {
      if (!btn.isConnected) {
        return;
      }
      label.textContent = old;
      const svg = btn.querySelector('svg');
      if (svg) {
        svg.outerHTML = oldIcon;
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
        cards = Array.isArray(msg.cards) ? msg.cards : [];
        if (!built) {
          build();
        }
        renderAll();
        if (msg.focus) {
          focusInput(msg.focus.prefill);
        }
        return;
      case 'card': {
        const i = cards.findIndex((c) => c.id === msg.card.id);
        const prev = i >= 0 ? cards[i] : undefined;
        if (i >= 0) {
          cards[i] = msg.card;
        } else {
          cards.push(msg.card);
        }
        if (built) {
          dirty.add(msg.card.id);
          scheduleDirty();
          if (prev && prev.status !== msg.card.status && msg.card.status === 'done') {
            live.textContent = S.answerReady || '';
          }
        }
        return;
      }
      case 'delta': {
        const c = cards.find((x) => x.id === msg.id);
        const at = Number(msg.at);
        if (c && Number.isInteger(at) && at >= 0 && at <= (c.answer || '').length) {
          c.answer = (c.answer || '').slice(0, at) + msg.text;
          if (c.status === 'thinking') {
            c.status = 'streaming';
          }
          dirty.add(c.id);
          scheduleDirty();
        }
        return;
      }
      case 'focus':
        if (built) {
          focusInput(msg.prefill);
        }
        return;
      case 'clear':
        cards = [];
        if (built) {
          renderAll();
          input.focus();
        }
        return;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
