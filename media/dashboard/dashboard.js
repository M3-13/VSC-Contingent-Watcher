// Copilot Contingent dashboard webview. Plain JS, no build step.
// Renders entirely from the DashboardModel posted by the extension.
// @ts-check
(function () {
  'use strict';

  /* global acquireVsCodeApi */
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /** @type {any} */
  let model = null;
  let introPending = true;
  let addingThreshold = false;
  let addingModel = false;
  /** @type {ResizeObserver | undefined} */
  let chartObserver;
  let chartWidth = 0;

  const TABS = ['overview', 'history', 'tips', 'settings'];
  const saved = safe(() => vscode.getState()) || {};
  const ui = {
    tab: TABS.includes(saved.tab) ? saved.tab : 'overview',
  };

  function persist() {
    safe(() => vscode.setState({ tab: ui.tab }));
  }

  /** Mirrors ACCENT_PRESETS in src/core/appearance.ts. */
  const PRESETS = { teal: '#14b8a6', violet: '#8b5cf6', blue: '#3b82f6', green: '#22c55e', orange: '#f97316', pink: '#ec4899' };
  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  /** Codepoint of the level-4 (full) glyph per status bar icon style; level n is base + (4 - n). */
  const GLYPH_BASE = { gauge: 0xe001, battery: 0xe006, ring: 0xe00b, bars: 0xe010 };

  // Icon font for the status bar style previews (URI handed over by the extension).
  const fontUri = document.body.getAttribute('data-icon-font');
  if (fontUri && typeof FontFace !== 'undefined') {
    safe(() =>
      new FontFace('contingent-icons', `url("${fontUri}")`)
        .load()
        .then((f) => document.fonts.add(f))
        .catch(() => undefined),
    );
  }

  /** @template T @param {() => T} fn @returns {T | undefined} */
  function safe(fn) {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------- helpers

  /** @param {unknown} s */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
  }

  /** Translated string with {0}… placeholders, HTML-escaped. */
  function t(id, ...args) {
    return esc(raw(id, ...args));
  }

  /** Translated string, not escaped (for use inside esc() or attributes built later). */
  function raw(id, ...args) {
    const s = (model && model.strings && model.strings[id]) || id;
    return s.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? String(args[i]) : ''));
  }

  const nfCache = new Map();
  function nf(digits, sign) {
    const loc = (model && model.locale) || undefined;
    const key = `${loc}|${digits}|${sign ? 1 : 0}`;
    if (!nfCache.has(key)) {
      nfCache.set(
        key,
        safe(() => new Intl.NumberFormat(loc, { maximumFractionDigits: digits, minimumFractionDigits: 0, signDisplay: sign ? 'exceptZero' : 'auto' })) ||
          new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }),
      );
    }
    return nfCache.get(key);
  }

  /** Formats like the status bar: integers / >=100 without decimals, else one. */
  function fmt(n, sign = false) {
    if (n === undefined || n === null || Number.isNaN(n)) {
      return '–';
    }
    if (!Number.isFinite(n)) {
      return '∞';
    }
    const digits = Math.abs(n) >= 100 || Number.isInteger(n) ? 0 : 1;
    return nf(digits, sign).format(n).replace('-', '−');
  }

  function pct(n) {
    const f = safe(() => new Intl.NumberFormat(loc(), { style: 'percent', maximumFractionDigits: 0 }));
    return f ? f.format(Math.round(n) / 100) : `${Math.round(n)}%`;
  }

  function loc() {
    return (model && model.locale) || undefined;
  }

  /** @param {string | number | Date} d */
  function fmtDate(d, opts = { day: 'numeric', month: 'short' }) {
    const date = d instanceof Date ? d : new Date(d);
    return safe(() => date.toLocaleDateString(loc(), opts)) || date.toDateString();
  }

  /** Parses YYYY-MM-DD as a local date. */
  function parseDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function rtf() {
    return safe(() => new Intl.RelativeTimeFormat(loc(), { numeric: 'auto', style: 'short' }));
  }

  function relativePast(ms) {
    const diff = Math.max(0, Date.now() - ms) / 1000;
    const f = rtf();
    if (diff < 45 || !f) {
      return raw('justNow');
    }
    if (diff < 3600) {
      return f.format(-Math.round(diff / 60), 'minute');
    }
    if (diff < 86400) {
      return f.format(-Math.round(diff / 3600), 'hour');
    }
    return f.format(-Math.round(diff / 86400), 'day');
  }

  function resetText(iso) {
    const reset = new Date(iso);
    const f = rtf();
    const hours = (reset.getTime() - Date.now()) / 3600000;
    let when;
    if (!f) {
      when = '';
    } else if (hours < 24) {
      when = f.format(Math.max(1, Math.round(hours)), 'hour');
    } else {
      const days = Math.round((startOfDay(reset).getTime() - startOfDay(new Date()).getTime()) / 86400000);
      when = f.format(days, 'day');
    }
    return `${raw('resets', when)} · ${fmtDate(reset)}`;
  }

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // ---------------------------------------------------------------- icons

  const S = (body, cls = '') =>
    `<svg class="i ${cls}" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const SPARK_PATH = 'M8 1.5Q8.9 7.1 14.5 8Q8.9 8.9 8 14.5Q7.1 8.9 1.5 8Q7.1 7.1 8 1.5Z';
  const icon = {
    refresh: S('<path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M13.25 2.5v3h-3"/>'),
    sliders: S('<path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7"/><circle cx="11" cy="4.5" r="1.5"/><circle cx="5" cy="11.5" r="1.5"/>'),
    log: S('<rect x="2" y="2.75" width="12" height="10.5" rx="2"/><path d="M5 6.5l2 1.5-2 1.5M8.5 10h2.5"/>'),
    external: S('<path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>'),
    chevron: S('<path d="M6 3.75 10.25 8 6 12.25"/>', 'chev'),
    bulb: S('<path d="M6 12.25h4M6.5 14.25h3M8 1.75a4.25 4.25 0 0 0-2.5 7.7c.4.3.75.85.75 1.35v.2h3.5v-.2c0-.5.35-1.05.75-1.35A4.25 4.25 0 0 0 8 1.75z"/>'),
    spark: `<svg class="i spark" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="${SPARK_PATH}"/></svg>`,
    account: S('<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 14c.6-2.6 2.7-4 5.25-4s4.65 1.4 5.25 4"/>'),
    warning: S('<path d="M8 2.25 14.25 13.5H1.75z"/><path d="M8 6.5v3M8 11.6v.01"/>'),
    history: S('<circle cx="8" cy="8" r="6"/><path d="M8 4.75V8l2.25 1.5"/>'),
    close: S('<path d="M5 5l6 6M11 5l-6 6"/>'),
    plus: S('<path d="M8 3.75v8.5M3.75 8h8.5"/>'),
    card: S('<rect x="1.75" y="3.5" width="12.5" height="9" rx="1.75"/><path d="M1.75 6.5h12.5M4.25 10h2.5"/>'),
    calendar: S('<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>'),
    chat: S('<path d="M2.5 3.5h11v7.5H7.5l-3 2.5V11h-2z"/>'),
    book: S('<path d="M2 3.25c2.1-.85 4.1-.6 6 .7 1.9-1.3 3.9-1.55 6-.7v9.75c-2.1-.85-4.1-.6-6 .7-1.9-1.3-3.9-1.55-6-.7zM8 3.95v9.75"/>'),
    bellOff: S('<path d="M4.5 11.5V7.5A3.5 3.5 0 0 1 10.6 5.1M11.5 7.5v4M2.5 11.5h11M6.5 13.75h3M2.5 2.5l11 11"/>'),
    bell: S('<path d="M4.5 11.5v-4a3.5 3.5 0 0 1 7 0v4M2.5 11.5h11M6.5 13.75h3"/>'),
    sun: S('<circle cx="8" cy="8" r="2.75"/><path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"/>'),
    target: S('<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r=".6" fill="currentColor"/>'),
    speed: S('<path d="M2.25 12a5.75 5.75 0 1 1 11.5 0"/><path d="M8 12l2.75-3.5"/>'),
    shield: S('<path d="M8 1.75 13 3.75v4c0 3-2.2 5.4-5 6.5-2.8-1.1-5-3.5-5-6.5v-4z"/>'),
    flag: S('<path d="M3.5 14.5v-12M3.5 2.75h8.25L10 5.75l1.75 3H3.5"/>'),
    flame: S('<path d="M8 14.5c2.8 0 4.5-1.9 4.5-4.4 0-2.6-2-4.1-2.8-6.6-.5 1.6-1.4 2.5-2.2 2.9C7.5 4.6 7 2.9 5.9 1.5 5.6 4.6 3.5 6.4 3.5 10.1c0 2.5 1.7 4.4 4.5 4.4z"/>'),
    bars: S('<path d="M3 13.5v-4M6.33 13.5v-7M9.67 13.5v-5M13 13.5v-10"/>'),
    trend: S('<path d="M2 12 6 8l3 2.5 5-6"/><path d="M10.5 4.5H14V8"/>'),
    gift: S('<rect x="2.25" y="6" width="11.5" height="3" rx=".75"/><path d="M3.25 9v4.25h9.5V9M8 6v7.25M8 6C6.5 6 4.75 5.6 4.75 4.1c0-1.9 2.5-1.6 3.25 1.9.75-3.5 3.25-3.8 3.25-1.9C11.25 5.6 9.5 6 8 6z"/>'),
    branch: S('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-2 3-7 4"/>'),
    cpu: S('<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 1.75V4M9.5 1.75V4M6.5 12v2.25M9.5 12v2.25M1.75 6.5H4M1.75 9.5H4M12 6.5h2.25M12 9.5h2.25"/>'),
    key: S('<circle cx="5.25" cy="10.75" r="2.75"/><path d="M7.25 8.75 13.5 2.5M11 5l1.75 1.75M9.5 6.5l1.25 1.25"/>'),
    palette: S('<path d="M8 1.75a6.25 6.25 0 1 0 0 12.5c1 0 1.4-.6 1.4-1.25 0-.9-.75-1.15-.75-2 0-.7.55-1.25 1.25-1.25h1.6a2.75 2.75 0 0 0 2.75-2.75C14.25 4.2 11.45 1.75 8 1.75z"/><circle cx="4.75" cy="8" r=".8" fill="currentColor"/><circle cx="6.25" cy="4.9" r=".8" fill="currentColor"/><circle cx="9.75" cy="4.9" r=".8" fill="currentColor"/>'),
    monitor: S('<rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11.25V14"/>'),
    trash: S('<path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4 4.25l.6 9h6.8l.6-9"/>'),
    check: S('<path d="M3.25 8.5 6.5 11.5l6.25-7"/>'),
    aside: S('<path d="M2.5 3.5h7.5v5H6l-2.5 2v-2h-1z"/><path d="M12 6.5h1.5v5.25h-1v1.75l-2.25-1.75H7.5V10.5"/>'),
    pause: S('<circle cx="8" cy="8" r="6"/><path d="M6.5 5.75v4.5M9.5 5.75v4.5"/>'),
  };

  // ---------------------------------------------------------------- gauge

  const G = { cx: 110, cy: 110, r: 88, sw: 18, gap: 3.2 };

  function polar(deg, r = G.r) {
    const a = (deg * Math.PI) / 180;
    return [G.cx + r * Math.cos(a), G.cy + r * Math.sin(a)];
  }

  function segRange(i) {
    return [180 + i * 45 + G.gap / 2, 180 + (i + 1) * 45 - G.gap / 2];
  }

  function arc(a0, a1) {
    const [x0, y0] = polar(a0);
    const [x1, y1] = polar(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${G.r} ${G.r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  /** Maps a 0..1 share onto the segmented arc (respecting the gaps). */
  function shareAngle(share) {
    const s = clamp(share, 0, 1) * 4;
    const i = Math.min(3, Math.floor(s));
    const [a0, a1] = segRange(i);
    return a0 + (s - i) * (a1 - a0);
  }

  function gaugeSvg(share, planShare) {
    let segs = '';
    for (let i = 0; i < 4; i++) {
      const d = arc(...segRange(i));
      const f = clamp(share * 4 - i, 0, 1);
      segs += `<path class="g-track" d="${d}"/>`;
      if (f > 0) {
        segs += `<path class="g-fill" data-seg="${i}" data-f="${f.toFixed(4)}" d="${d}" pathLength="1" stroke-dasharray="${f.toFixed(4)} 2"/>`;
      }
    }
    let marker = '';
    if (planShare !== undefined) {
      const a = shareAngle(planShare);
      const [x0, y0] = polar(a, G.r - G.sw / 2 - 4);
      const [x1, y1] = polar(a, G.r + G.sw / 2 + 4);
      const [xd, yd] = polar(a, G.r + G.sw / 2 + 8);
      marker = `<g class="g-plan"><title>${esc(raw('planMarker', fmt(planShare * (model.quota.entitlement || 0))))}</title>
        <line x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>
        <circle cx="${xd.toFixed(2)}" cy="${yd.toFixed(2)}" r="2.6"/></g>`;
    }
    return `<svg class="g-svg" viewBox="0 0 220 122" aria-hidden="true" focusable="false">
      <defs><linearGradient id="g-grad" x1="22" y1="0" x2="198" y2="0" gradientUnits="userSpaceOnUse">
        <stop class="g-stop0" offset="0"/><stop class="g-stop1" offset="1"/></linearGradient></defs>
      <g class="g-segs">${segs}</g>${marker}</svg>`;
  }

  // ---------------------------------------------------------------- sections

  function header() {
    const q = model.quota;
    const plan = q && q.plan ? `<span class="badge" title="${t('plan')}">${esc(q.plan.charAt(0).toUpperCase() + q.plan.slice(1))}</span>` : '';
    const updated = q ? `<span class="updated" id="updated">${esc(raw('updated', relativePast(q.fetchedAt)))}</span>` : '';
    const stale = model.stale ? `<span class="badge badge-warn" title="${t('offlineHint')}">${icon.history}${t('offline')}</span>` : '';
    return `<header class="topbar">
      <div class="topbar-meta">${updated}${stale}${plan}</div>
      <button class="icon-btn" data-cmd="refresh" data-k="refresh-top" title="${t('refresh')}" aria-label="${t('refresh')}">${icon.refresh}</button>
    </header>`;
  }

  function staleBanner() {
    if (!model.stale) {
      return '';
    }
    return `<div class="banner" role="status">${icon.history}
      <div class="banner-text"><strong>${t('offline')}</strong> · ${t('offlineHint')}${model.errorMessage ? `<span class="banner-detail">${esc(model.errorMessage)}</span>` : ''}</div></div>`;
  }

  function hero() {
    const q = model.quota;
    const f = model.forecast || {};
    const status = f.status || (q.unlimited ? 'unlimited' : 'onTrack');
    const chip = `<span class="chip"><span class="chip-dot"></span>${esc(f.statusLabel || raw('unlimited'))}</span>`;
    const reset = `<span class="reset">${icon.calendar}<span>${esc(resetText(q.resetDate))}</span></span>`;

    if (q.unlimited) {
      return `<section class="card hero st-unlimited" aria-label="${t('title')}">
        <div class="gauge" role="img" aria-label="${t('unlimited')}">${gaugeSvg(1)}
          <div class="gauge-center"><span class="gauge-spark">${icon.spark}</span><span class="gauge-value">∞</span>
          <span class="gauge-unit">${t('usedThisCycle', fmt(q.used), q.unitLabel)}</span></div></div>
        <div class="hero-meta">${chip}${reset}</div>
        <p class="hero-note">${t('unlimitedHint')}</p></section>`;
    }

    const ent = Math.max(q.entitlement, 0);
    const share = ent > 0 ? q.remaining / ent : 0;
    const planShare = f.cycleElapsed !== undefined ? 1 - f.cycleElapsed : undefined;
    const elapsed = clamp((f.cycleElapsed || 0) * 100, 0, 100);
    const used = clamp(q.usedPercent, 0, 100);
    const label = raw('gaugeLabel', fmt(q.remaining), fmt(ent), q.unitLabel, Math.round(q.usedPercent));

    return `<section class="card hero st-${esc(status)}" aria-label="${t('title')}">
      <div class="gauge" role="img" aria-label="${esc(label)}">${gaugeSvg(share, planShare)}
        <span class="g-end g-end-l" aria-hidden="true">0</span><span class="g-end g-end-r" aria-hidden="true">${fmt(ent)}</span>
        <div class="gauge-center"><span class="gauge-spark">${icon.spark}</span>
          <span class="gauge-value">${fmt(q.remaining)}</span>
          <span class="gauge-unit">${t('leftOf', fmt(ent), q.unitLabel)}</span></div>
      </div>
      <div class="hero-meta">${chip}${reset}</div>
      <div class="compare">
        <div class="cmp-row"><span class="cmp-label">${t('monthElapsed')}</span><span class="cmp-val">${pct(elapsed)}</span>
          <div class="meter meter-time"><span class="meter-fill" data-w="${elapsed}"></span></div></div>
        <div class="cmp-row"><span class="cmp-label">${t('allowanceUsed')}</span><span class="cmp-val">${pct(q.usedPercent)}</span>
          <div class="meter meter-used ${used > elapsed + 2 ? 'over' : ''}"><span class="meter-fill" data-w="${used}"></span>
          <span class="meter-mark" data-l="${elapsed}" title="${t('monthElapsed')}: ${pct(elapsed)}"></span></div></div>
      </div>
    </section>`;
  }

  function tile(o) {
    return `<div class="tile ${o.tone ? `tone-${o.tone}` : ''}" ${o.title ? `title="${esc(o.title)}"` : ''}>
      <div class="tile-label">${o.icon || ''}<span>${o.label}</span></div>
      <div class="tile-value">${o.value}${o.unit ? `<span class="tile-unit">${o.unit}</span>` : ''}</div>
      ${o.bar !== undefined ? `<div class="meter meter-mini"><span class="meter-fill" data-w="${clamp(o.bar * 100, 0, 100)}"></span></div>` : ''}
      ${(Array.isArray(o.sub) ? o.sub : [o.sub || '']).map((x) => `<div class="tile-sub">${x}</div>`).join('')}</div>`;
  }

  function tiles() {
    const q = model.quota;
    const f = model.forecast;
    const m = model.metrics;
    if (!m) {
      return '';
    }
    const perDayUnit = esc(raw('perDay', '').trim());
    const list = [];
    const budget = f ? f.dailyBudget : 0;
    list.push(
      tile({
        icon: icon.sun,
        label: t('today'),
        value: fmt(m.today),
        sub: q.unlimited || !f ? '' : !(q.remaining > 0) ? t('legendEmpty') : t('ofBudget', fmt(budget)),
        bar: q.unlimited || !f || budget <= 0 ? undefined : m.today / budget,
        tone: q.unlimited || !f || !(q.remaining > 0) ? '' : m.today > budget ? 'bad' : 'good',
      }),
    );
    if (!q.unlimited && f) {
      list.push(tile({ icon: icon.target, label: t('dailyBudget'), value: fmt(budget), unit: perDayUnit, sub: t('budgetDaysLeft', fmt(f.daysLeft)) }));
      const paceTone = f.burnRate > Math.max(budget, m.planPerDay) * 1.05 ? 'bad' : f.burnRate > m.planPerDay * 1.05 ? 'warn' : 'good';
      list.push(tile({ icon: icon.speed, label: t('pace'), value: fmt(f.burnRate), unit: perDayUnit, sub: t('planPerDay', fmt(m.planPerDay)), tone: paceTone }));
      const ahead = m.buffer >= 0;
      list.push(
        tile({
          icon: icon.shield,
          label: t('buffer'),
          value: fmt(Math.round(m.buffer), true),
          sub: t(ahead ? 'bufferAhead' : 'bufferBehind', fmt(Math.abs(m.bufferDays))),
          tone: ahead ? 'good' : 'bad',
        }),
      );
      list.push(needTile());
      // The streak ends when the allowance runs out; say why instead of "within budget".
      const d = m.daily || [];
      const ended = d.length > 0 && (d[d.length - 1].exhausted || (d.length > 1 && d[d.length - 2].exhausted));
      list.push(
        tile({
          icon: icon.flame,
          label: t('streak'),
          value: m.streakDays === 1 ? t('streakOne') : t('streakMany', fmt(m.streakDays)),
          sub: ended && m.streakDays === 0 ? t('streakEnded') : t('withinBudget'),
          tone: m.streakDays > 0 ? 'good' : '',
        }),
      );
    } else {
      // Unlimited / no forecast: nothing to budget, show recent volume instead.
      list.push(tile({ icon: icon.bars, label: t('last7'), value: fmt(m.last7Days), sub: t('avgPerDay', fmt(m.last7Days / 7)) }));
      list.push(tile({ icon: icon.trend, label: t('cycleAverage'), value: fmt(m.cycleAverage), unit: perDayUnit, sub: t('perBudgetDay') }));
    }
    return `<section class="tiles-wrap" aria-label="${t('pace')}"><div class="tiles">${list.join('')}</div></section>`;
  }

  /** "How much would this month need?" — estimated demand vs. the allowance. */
  function needTile() {
    const q = model.quota;
    const m = model.metrics;
    const dm = m.demand;
    const base = { icon: icon.flag, label: t('need'), title: raw('needTitle') };
    if (!dm) {
      return tile({ ...base, value: '–', sub: t('needNoData') });
    }
    const subs = [];
    let tone;
    if (dm.overBy > 0) {
      tone = dm.exhaustedOn ? 'bad' : 'warn';
      subs.push(t('needOver', fmt(Math.round(dm.overBy))));
      if (dm.exhaustedOn) {
        subs.push(`${icon.warning}${t('emptySince', fmtDate(parseDay(dm.exhaustedOn)))}`);
      }
    } else {
      tone = 'good';
      subs.push(t('needFits'));
      subs.push(t('needSpare', fmt(Math.round(-dm.overBy))));
    }
    return tile({ ...base, value: `~${fmt(Math.round(dm.estimate))}`, unit: `/${fmt(q.entitlement)}`, sub: subs, tone });
  }

  function chartCard() {
    const m = model.metrics;
    if (!m || !m.daily || m.daily.length === 0) {
      return '';
    }
    const anyEst = m.daily.some((d) => d.estimated);
    const anyEmpty = m.daily.some((d) => d.exhausted);
    const showPlan = !model.quota.unlimited && m.planPerDay > 0;
    const showBudget = !model.quota.unlimited && model.forecast && model.forecast.dailyBudget > 0;
    const legend = [
      showPlan ? `<span class="lg"><span class="sw sw-plan"></span>${t('legendPlan')} <b>${fmt(m.planPerDay)}</b></span>` : '',
      `<span class="lg"><span class="sw sw-today"></span>${t('legendToday')}</span>`,
      showBudget ? `<span class="lg"><span class="sw sw-ghost"></span>${t('dailyBudget')}</span>` : '',
      anyEst ? `<span class="lg"><span class="sw sw-est"></span>${t('legendEstimated')}</span>` : '',
      anyEmpty ? `<span class="lg"><span class="sw sw-empty"></span>${t('legendEmpty')}</span>` : '',
      `<span class="lg"><span class="sw sw-weekend"></span>${t('legendWeekend')}</span>`,
    ].join('');
    return `<section class="card chart-card st-${esc((model.forecast && model.forecast.status) || 'onTrack')}" aria-labelledby="chart-title">
      <div class="card-head"><h2 id="chart-title">${icon.bars}${t('dailyUsage')}</h2></div>
      <div class="chart-host" id="chart-host" role="img" aria-label="${t('chartLabel', fmt(m.planPerDay))}"></div>
      <div class="legend">${legend}</div></section>`;
  }

  function drawChart() {
    const host = document.getElementById('chart-host');
    if (!host || !model || !model.metrics) {
      return;
    }
    const w = Math.max(160, Math.floor(host.clientWidth));
    chartWidth = w;
    const m = model.metrics;
    const q = model.quota;
    const f = model.forecast;
    const settings = model.settings || {};
    const days = m.daily.map((d) => ({ ...d, day: parseDay(d.date), future: false }));
    // Future calendar days until the reset, shown as ghosts at today's daily budget.
    const last = days[days.length - 1].day;
    const resetDay = startOfDay(new Date(q.resetDate));
    // Once the allowance is empty, the rest of the cycle stays empty too.
    const emptyNow = !q.unlimited && q.remaining <= 0 && m.daily.some((d) => d.exhausted);
    for (let d = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1); d < resetDay && days.length < 42; d.setDate(d.getDate() + 1)) {
      const wk = d.getDay() === 0 || d.getDay() === 6;
      days.push({ date: '', used: 0, weekend: wk, estimated: false, exhausted: emptyNow, day: new Date(d), future: true });
    }
    const budget = !q.unlimited && f ? f.dailyBudget : 0;
    const todayIdx = m.daily.length - 1;
    const maxUsed = Math.max(1, ...m.daily.map((d) => d.used), q.unlimited ? 0 : m.planPerDay, budget);
    const yMax = maxUsed * 1.12;
    const H = 132;
    const top = 8;
    const bottom = 18;
    const plotH = H - top - bottom;
    const n = days.length;
    const col = w / n;
    const bw = Math.max(2, Math.min(18, col * 0.64));
    const y = (v) => top + plotH - (v / yMax) * plotH;
    const base = top + plotH;

    let shade = '';
    let bars = '';
    let hits = '';
    let labels = '';
    const fullFmt = { weekday: 'short', day: 'numeric', month: 'short' };
    days.forEach((d, i) => {
      const x0 = i * col;
      const cx = x0 + col / 2;
      if (d.weekend) {
        shade += `<rect class="c-weekend" x="${x0.toFixed(2)}" y="${top}" width="${col.toFixed(2)}" height="${plotH}"/>`;
      }
      if (d.exhausted) {
        shade += `<rect class="c-empty" x="${x0.toFixed(2)}" y="${top}" width="${col.toFixed(2)}" height="${plotH}"/>`;
      }
      let tip;
      if (d.future) {
        const b = d.weekend && !settings.countWeekends ? 0 : budget;
        if (b > 0) {
          const h = Math.max(2, base - y(b));
          bars += `<rect class="c-ghost" x="${(cx - bw / 2).toFixed(2)}" y="${(base - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="2"/>`;
        }
        tip = d.exhausted ? `${fmtDate(d.day, fullFmt)} · ${raw('emptyNote')}` : `${fmtDate(d.day, fullFmt)} · ${raw('dailyBudget')}: ${fmt(b)}`;
      } else {
        const h = d.used > 0 ? Math.max(2, base - y(d.used)) : 0;
        const cls = ['c-bar', i === todayIdx ? 'today' : '', d.weekend ? 'weekend' : '', d.estimated ? 'est' : '']
          .filter(Boolean)
          .join(' ');
        if (h > 0) {
          bars += `<rect class="${cls}" x="${(cx - bw / 2).toFixed(2)}" y="${(base - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="2"/>`;
        } else {
          bars += `<rect class="c-zero" x="${(cx - bw / 2).toFixed(2)}" y="${base - 1.5}" width="${bw.toFixed(2)}" height="1.5" rx=".75"/>`;
        }
        const notes = [
          i === todayIdx ? raw('legendToday') : '',
          d.weekend ? raw('weekendNote') : '',
          d.estimated ? raw('estimatedNote') : '',
          d.exhausted ? raw('emptyNote') : '',
        ]
          .filter(Boolean)
          .join(', ');
        tip = `${fmtDate(d.day, fullFmt)}: ${fmt(d.used)} ${q.unitLabel}${notes ? ` (${notes})` : ''}`;
      }
      hits += `<rect class="c-hit" x="${x0.toFixed(2)}" y="0" width="${col.toFixed(2)}" height="${H}"><title>${esc(tip)}</title></rect>`;

      const isToday = i === todayIdx;
      const minGap = Math.ceil(18 / col);
      const regular = i % 7 === 0 && Math.abs(i - todayIdx) >= minGap && n - 1 - i >= Math.min(minGap, 2);
      if (isToday || regular) {
        const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
        const lx = i === 0 ? x0 + 1 : i === n - 1 ? x0 + col - 1 : cx;
        labels += `<text class="c-label ${isToday ? 'today' : ''}" x="${lx.toFixed(2)}" y="${H - 4}" text-anchor="${anchor}">${d.day.getDate()}</text>`;
      }
    });

    let plan = '';
    if (!q.unlimited && m.planPerDay > 0) {
      const py = y(m.planPerDay).toFixed(2);
      plan = `<line class="c-plan" x1="0" x2="${w}" y1="${py}" y2="${py}"><title>${esc(raw('legendPlan'))}: ${esc(fmt(m.planPerDay))}</title></line>`;
    }
    const todayX = todayIdx * col + col / 2;
    const now = `<line class="c-now" x1="${todayX.toFixed(2)}" x2="${todayX.toFixed(2)}" y1="${top}" y2="${base}"/>`;

    host.innerHTML = `<svg class="c-svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" focusable="false">
      <defs><pattern id="c-hatch" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
        <rect class="c-hatch-bg" width="4" height="4"/><line class="c-hatch-line" x1="0" y1="0" x2="0" y2="4"/></pattern>
        <pattern id="c-empty-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(-45)">
        <line class="c-empty-line" x1="0" y1="0" x2="0" y2="6"/></pattern></defs>
      ${shade}<line class="c-base" x1="0" x2="${w}" y1="${base + 0.5}" y2="${base + 0.5}"/>${now}${bars}${plan}${labels}${hits}</svg>`;
  }

  function overage() {
    const q = model.quota;
    if (!q || q.unlimited || !(q.overageCount > 0 || q.overagePermitted)) {
      return '';
    }
    return `<section class="card overage ${q.overageCount > 0 ? 'has-overage' : ''}" aria-labelledby="ov-title">
      <div class="card-head"><h2 id="ov-title">${icon.card}${t('overage')}</h2>
      ${q.overageCount > 0 ? `<span class="badge badge-bad">${fmt(q.overageCount)} ${esc(q.unitLabel)}</span>` : ''}</div>
      <p class="muted">${q.overageCount > 0 ? `${t('overageCount', fmt(q.overageCount))}. ` : ''}${t('overageEnabled')}</p>
      <button class="btn secondary" data-cmd="openBilling" data-k="ov-billing">${icon.external}${t('openBilling')}</button></section>`;
  }

  /** Tips tab: only the tips relevant right now (the extension pre-filters and sorts them). */
  function tipsNow() {
    const tips = model.tips || [];
    const f = model.forecast;
    // Context: the surplus hint near reset wins over the pace status.
    const ctx = model.surplus
      ? `<span class="chip st-ahead">${icon.gift}${t('surplusChip')}</span>`
      : f && f.statusLabel
        ? `<span class="chip st-${esc(f.status)}"><span class="chip-dot"></span>${esc(f.statusLabel)}</span>`
        : '';
    const body =
      tips.length === 0
        ? `<p class="tips-none muted">${icon.check}${t('tipsNone')}</p>`
        : `<ul class="tip-cards">${tips
            .map((x) => `<li class="card tip-item"><span class="tip-icon">${icon.bulb}</span><p class="tip-text">${esc(x.text)}</p></li>`)
            .join('')}</ul>`;
    return `<section class="tips-now" aria-labelledby="tips-now-title">
      <div class="tips-head"><h2 id="tips-now-title">${t('tipsNow')}</h2>${ctx}</div>${body}</section>`;
  }

  /** Tips tab: what btw is and which model answers. */
  function btwCard() {
    const free = model.settings.btwModel === 'included';
    return `<section class="card btw-card" aria-labelledby="btw-title">
      <div class="card-head"><h2 id="btw-title">${icon.aside}${t('btwTitle')}</h2>${free ? '<span class="badge badge-good">0×</span>' : ''}</div>
      <p class="btw-text">${t('btwText')}</p>
      <p class="btw-text muted">${t(free ? 'btwModelInfoFree' : 'btwModelInfoChat')}</p>
      <button class="btn primary" data-cmd="btw" data-k="btw-ask">${icon.aside}${t('askBtw')}</button></section>`;
  }

  /** Slim pointer to btw on the overview. */
  function btwStrip() {
    return `<nav class="strips" aria-label="${t('btwGroup')}"><button class="strip" data-cmd="btw" data-k="strip-btw"><span class="strip-icon">${icon.aside}</span>
      <span class="strip-text"><strong>${t('askBtw')}</strong><span>${t('btwStrip')}</span></span>${icon.chevron}</button></nav>`;
  }

  function surplusBanner() {
    const s = model.surplus;
    if (!s || !s.message) {
      return '';
    }
    return `<div class="surplus" role="status">
      <span class="surplus-icon">${icon.gift}</span>
      <div class="surplus-text"><strong>${esc(s.message)}</strong><span>${t('surplusBannerHint')}</span></div></div>`;
  }

  // ---------------------------------------------------------------- history

  function duration(min) {
    const m = Math.max(0, Math.round(min));
    if (m < 60) {
      return raw('durM', fmt(Math.max(1, m)));
    }
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? raw('durHM', fmt(h), fmt(r)) : raw('durH', fmt(h));
  }

  function dateRange(start, end) {
    const opts = { day: 'numeric', month: 'short' };
    const a = new Date(start);
    const b = new Date(end);
    if (startOfDay(a).getTime() === startOfDay(b).getTime()) {
      return fmtDate(a, opts);
    }
    const f = safe(() => new Intl.DateTimeFormat(loc(), opts));
    // @ts-ignore formatRange is available in current Chromium.
    const r = f && typeof f.formatRange === 'function' ? safe(() => f.formatRange(a, b)) : undefined;
    return r || `${fmtDate(a, opts)} – ${fmtDate(b, opts)}`;
  }

  function unit() {
    return (model.quota && model.quota.unitLabel) || '';
  }

  function activityCard() {
    const a = model.activity || { enabled: false, items: [] };
    const items = a.items || [];
    const clear =
      items.length > 0 ? `<button class="link subtle" data-cmd="clearActivity" data-k="act-clear">${icon.trash}${t('clear')}</button>` : '';
    let body;
    if (!a.enabled && items.length === 0) {
      body = `<div class="empty-inline"><p><strong>${t('activityOffTitle')}</strong></p><p class="muted">${t('activityOffText')}</p>
        <button class="btn primary small" data-action="enableActivity" data-k="act-on">${t('turnOn')}</button></div>`;
    } else if (items.length === 0) {
      body = `<div class="empty-inline"><p><strong>${t('activityEmpty')}</strong></p><p class="muted">${t('activityEmptyText')}</p></div>`;
    } else {
      const multiRepo = new Set(items.map((x) => x.repo)).size > 1;
      body = `<ul class="act-list">${items
        .map(
          (x) => `<li class="act ${x.active ? 'is-active' : ''}">
          <div class="act-main">
            <div class="act-title"><span class="act-name" title="${esc(x.title)}">${esc(x.title)}</span>${
              x.active ? `<span class="badge badge-live"><span class="live-dot"></span>${t('activeNow')}</span>` : ''
            }</div>
            ${x.detail ? `<div class="act-detail" title="${esc(x.detail)}">${esc(x.detail)}</div>` : ''}
            <div class="act-date">${multiRepo ? `${esc(x.repo)} · ` : ''}${esc(dateRange(x.start, x.end))}</div>
          </div>
          <div class="act-nums"><span class="act-time">${esc(duration(x.activeMinutes))}</span><span class="act-used">${esc(fmt(x.used))} ${esc(unit())}</span></div>
        </li>`,
        )
        .join('')}</ul>`;
      if (!a.enabled) {
        body += `<div class="act-off muted">${t('activityPaused')} <button class="link" data-action="enableActivity" data-k="act-on2">${t('turnOn')}</button></div>`;
      }
    }
    return `<section class="card" aria-labelledby="act-title">
      <div class="card-head"><h2 id="act-title">${icon.branch}${t('activity')}</h2>${clear}</div>${body}</section>`;
  }

  function reviewCard() {
    const cycles = (model.review && model.review.cycles) || [];
    let body;
    if (cycles.length === 0) {
      body = `<p class="muted small">${t('reviewEmpty')}</p>`;
    } else {
      body = `<ul class="rev-list">${cycles
        .map((c) => {
          const share = c.entitlement > 0 ? c.used / c.entitlement : 0;
          const over = share > 1;
          const facts = [
            c.peakDay ? raw('peakDay', fmt(c.peakDay.used), fmtDate(parseDay(c.peakDay.date))) : '',
            c.activeDays > 0 ? raw('avgActiveDay', fmt(c.avgPerActiveDay)) : '',
          ]
            .filter(Boolean)
            .map(esc);
          if (c.demand !== undefined && c.demand > c.entitlement) {
            // The insight: how much more this month would have needed.
            facts.unshift(`<span class="rev-need" title="${t('reviewNeedTitle')}">${t('reviewNeed', fmt(Math.round(c.demand)))}</span>`);
          }
          return `<li class="rev ${c.current ? 'current' : ''} ${over ? 'over' : ''}">
            <div class="rev-head"><span class="rev-label">${esc(c.label)}${
              c.current ? ` <span class="badge badge-live">${t('running')}</span>` : ''
            }</span><span class="rev-val"><b>${fmt(c.used)}</b><span class="muted"> / ${fmt(c.entitlement)}</span></span></div>
            <div class="meter rev-meter"><span class="meter-fill" data-w="${clamp(share * 100, 0, 100)}"></span></div>
            ${facts.length ? `<div class="rev-facts">${facts.join(' · ')}</div>` : ''}</li>`;
        })
        .join('')}</ul>`;
    }
    return `<section class="card" aria-labelledby="rev-title">
      <div class="card-head"><h2 id="rev-title">${icon.calendar}${t('review')}</h2></div>${body}</section>`;
  }

  /** Credits when the report has them (share is by credits then), else request counts. */
  function modelAmount(x, long) {
    if (model.models.showCredits && x.credits !== undefined) {
      return raw('creditsAmount', fmt(x.credits));
    }
    return long ? raw('requestsAmount', fmt(x.quantity)) : fmt(x.quantity);
  }

  function modelsCard() {
    const m = model.models || { state: 'notConfigured', items: [] };
    let body;
    let side = '';
    if (m.state === 'notConfigured') {
      body = `<div class="empty-inline"><p class="muted">${t('modelsNeedToken')}</p>
        <button class="btn primary small" data-cmd="configureBillingToken" data-k="tok-add">${icon.key}${t('addToken')}</button></div>`;
    } else if (m.state === 'loading') {
      body = `<div class="sk-rows" aria-hidden="true"><span class="sk-line w80"></span><span class="sk-line w60"></span><span class="sk-line w40"></span></div>
        <p class="sr-only" role="status">${t('modelsLoading')}</p>`;
    } else if (m.state === 'error') {
      body = `<div class="empty-inline"><p><strong>${t('modelsError')}</strong></p>${m.errorMessage ? `<p class="err-msg">${esc(m.errorMessage)}</p>` : ''}
        <div class="btn-row"><button class="btn secondary small" data-cmd="refresh" data-k="mod-retry">${icon.refresh}${t('retry')}</button>
        <button class="btn secondary small" data-cmd="configureBillingToken" data-k="mod-conf">${icon.key}${t('configureToken')}</button></div></div>`;
    } else {
      const items = m.items || [];
      side = m.periodLabel ? `<span class="card-sub">${esc(m.periodLabel)}</span>` : '';
      body =
        items.length === 0
          ? `<p class="muted small">${t('modelsEmpty')}</p>`
          : `<ul class="mod-list">${items
              .map(
                (x, i) => `<li class="mod ${i === 0 ? 'top' : ''}" title="${esc(`${x.model}: ${modelAmount(x, true)}`)}">
            <div class="mod-head"><span class="mod-name">${esc(x.model)}</span><span class="mod-val"><span class="muted">${esc(modelAmount(x, false))}</span> <b>${pct(
              x.share * 100,
            )}</b></span></div>
            <div class="meter mod-meter"><span class="meter-fill" data-w="${clamp(x.share * 100, 0, 100)}"></span></div></li>`,
              )
              .join('')}</ul>`;
      body += `<div class="card-foot"><button class="link subtle" data-cmd="clearBillingToken" data-k="tok-rm">${t('removeToken')}</button></div>`;
    }
    return `<section class="card" aria-labelledby="mod-title">
      <div class="card-head"><h2 id="mod-title">${icon.cpu}${t('perModel')}</h2>${side}</div>${body}</section>`;
  }

  // ---------------------------------------------------------------- settings controls

  function sw(key, on, labelId, disabled = false) {
    return `<button class="switch" role="switch" aria-checked="${!!on}" aria-labelledby="${labelId}" data-set="${key}" data-k="sw-${key}" ${
      disabled ? 'disabled' : ''
    }><span class="knob"></span></button>`;
  }

  function row(key, on, label, hint) {
    const id = `lbl-${key}`;
    return `<div class="row"><div class="row-text"><span class="row-label" id="${id}">${label}</span>${
      hint ? `<span class="row-hint">${hint}</span>` : ''
    }</div>${sw(key, on, id)}</div>`;
  }

  /** Radio group; options are [value, label, extraHtml?]. Keeps exactly one tab stop. */
  function segmented(key, value, options, labelId, cls = '') {
    const anyChecked = options.some(([v]) => v === value);
    return `<div class="segmented ${cls}" role="radiogroup" aria-labelledby="${labelId}" data-count="${options.length}">${options
      .map(([v, l, extra], i) => {
        const on = v === value;
        return `<button role="radio" aria-checked="${on}" tabindex="${on || (!anyChecked && i === 0) ? 0 : -1}" data-set="${key}" data-value="${esc(
          v,
        )}" data-k="seg-${key}-${esc(v)}" title="${l}">${extra || ''}<span>${l}</span></button>`;
      })
      .join('')}</div>`;
  }

  function providerControl() {
    const s = model.settings;
    return `<div class="field"><span class="field-label" id="lbl-provider">${t('signInProvider')}</span>${segmented(
      'authProvider',
      s.authProvider,
      [
        ['auto', t('providerAuto')],
        ['github', t('providerGitHub')],
        ['github-enterprise', t('providerEnterprise')],
      ],
      'lbl-provider',
    )}</div>`;
  }

  function hex6(v) {
    const s = String(v || '').trim().toLowerCase();
    return /^#[0-9a-f]{3}$/.test(s) ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
  }

  /** Colour picker: auto + presets + custom. Accent stores preset ids, the status bar colour stores hex. */
  function swatches(key, value, labelId) {
    const byId = key === 'accent';
    const v = hex6(value);
    const isAuto = !v || v === 'auto';
    const match = Object.entries(PRESETS).find(([id, hex]) => v === id || v === hex);
    const custom = !isAuto && !match && HEX.test(v);
    const radios = [['auto', t('colorDefault'), '']]
      .concat(Object.entries(PRESETS).map(([id, hex]) => [byId ? id : hex, t(`color_${id}`), hex]))
      .map(([val, label, hex], i) => {
        const on = isAuto ? i === 0 : match ? (byId ? val === match[0] : val === match[1]) : false;
        const tab = on || (custom && i === 0) ? 0 : -1;
        return `<button class="swatch ${hex ? '' : 'swatch-auto'}" role="radio" aria-checked="${on}" tabindex="${tab}" data-set="${key}" data-value="${esc(
          val,
        )}" data-k="sw-${key}-${esc(val)}" title="${label}" aria-label="${label}">${hex ? `<span class="swatch-dot" data-bg="${hex}"></span>` : `<span>${label}</span>`}</button>`;
      })
      .join('');
    const customVal = custom ? v : '#888888';
    return `<div class="swatches"><div class="swatch-group" role="radiogroup" aria-labelledby="${labelId}">${radios}</div>
      <label class="swatch swatch-custom ${custom ? 'on' : ''}" title="${t('customColor')}">
        <span class="swatch-dot" ${custom ? `data-bg="${customVal}"` : ''}></span>
        <input type="color" value="${esc(customVal)}" data-color="${key}" data-k="color-${key}" aria-label="${t('customColor')}${custom ? ` (${esc(customVal)})` : ''}">
      </label></div>`;
  }

  function level() {
    const q = model.quota;
    if (!q || q.unlimited || !(q.entitlement > 0)) {
      return 4;
    }
    return clamp(Math.ceil((q.remaining / q.entitlement) * 4), 0, 4);
  }

  function glyph(style, lvl) {
    const base = GLYPH_BASE[style];
    return base ? `<span class="glyph" aria-hidden="true">${String.fromCodePoint(base + (4 - lvl))}</span>` : '<span class="glyph none" aria-hidden="true">–</span>';
  }

  /** Mimics the status bar item text (see statusBar.ts). */
  function statusBarText() {
    const q = model.quota;
    const f = model.forecast;
    const s = model.settings;
    if (!q) {
      return '';
    }
    if (q.unlimited) {
      return '∞';
    }
    switch (s.display) {
      case 'used':
        return `${fmt(q.used)}/${fmt(q.entitlement)}`;
      case 'percent':
        return `${Math.round(q.usedPercent)}%`;
      case 'dailyBudget':
        return raw('perDay', fmt(f ? f.dailyBudget : 0));
      default:
        return fmt(q.remaining);
    }
  }

  /** Live preview of the status bar item, shown in the Display group's heading. */
  function statusBarPreview() {
    const s = model.settings;
    const c = s.statusBarColor && s.statusBarColor !== 'auto' ? resolveColor(s.statusBarColor) : '';
    return `<span class="sb-item" aria-hidden="true" ${c ? `data-fg="${esc(c)}"` : ''}>${
      s.statusBarIcon === 'none' ? '' : glyph(s.statusBarIcon, level())
    }<span>${esc(statusBarText())}</span></span>`;
  }

  function group(iconSvg, title, body, note = '', side = '') {
    return `<section class="card group"><div class="group-top"><h2 class="group-h">${iconSvg}<span>${title}</span></h2>${
      note ? `<span class="group-note">${note}</span>` : ''
    }${side}</div>${body}</section>`;
  }

  const REFRESH_OPTIONS = [2, 5, 10, 15, 30, 60];

  function refreshIntervalRow() {
    const cur = Number(model.settings.refreshIntervalMinutes) || 10;
    const opts = REFRESH_OPTIONS.includes(cur) ? REFRESH_OPTIONS : REFRESH_OPTIONS.concat(cur).sort((a, b) => a - b);
    return `<div class="row"><label class="row-label" for="refresh-interval">${t('refreshInterval')}</label>
      <select class="sel" id="refresh-interval" data-k="refresh-interval">${opts
        .map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t('durM', fmt(v))}</option>`)
        .join('')}</select></div>`;
  }

  /** Copilot's eagerness; known values are translated, others capitalised. */
  function eagernessField(e) {
    const label = (v) => (model.strings[`eager_${v}`] ? t(`eager_${v}`) : esc(v.charAt(0).toUpperCase() + v.slice(1)));
    return `<div class="field"><span class="field-label" id="lbl-eager">${t('copilotEagerness')}</span>${segmented(
      'copilotEagerness',
      e.value,
      e.options.map((v) => [v, label(v)]),
      'lbl-eager',
    )}</div>`;
  }

  function settingsPanel() {
    const s = model.settings;
    const thresholds = (s.thresholds || []).slice().sort((a, b) => a - b);
    const chips = thresholds
      .map(
        (v) =>
          `<span class="tchip">${pct(v)}<button class="tchip-x" data-action="removeThreshold" data-value="${v}" data-k="th-${v}" title="${t(
            'removeThreshold',
            v,
          )}" aria-label="${t('removeThreshold', v)}">${icon.close}</button></span>`,
      )
      .join('');
    const add = addingThreshold
      ? `<span class="tchip tchip-input"><input type="number" min="1" max="100" step="1" inputmode="numeric" data-k="th-new" id="th-new" aria-label="${t(
          'addThreshold',
        )}" placeholder="%"></span>`
      : `<button class="tchip tchip-add" data-action="addThreshold" data-k="th-add" title="${t('addThreshold')}" aria-label="${t('addThreshold')}">${icon.plus}</button>`;

    const snoozed = s.snoozedUntil && s.snoozedUntil > Date.now();
    const until = snoozed ? safe(() => new Date(s.snoozedUntil).toLocaleString(loc(), { weekday: 'short', hour: '2-digit', minute: '2-digit' })) : '';
    const snooze = snoozed
      ? `<div class="snooze on">${icon.bellOff}<span>${t('snoozedUntil', until)}</span><button class="link" data-cmd="unsnooze" data-k="unsnooze">${t('unsnooze')}</button></div>`
      : `<button class="btn secondary small" data-cmd="snooze" data-k="snooze" ${s.warningsEnabled ? '' : 'disabled'}>${icon.bellOff}${t('snooze')}</button>`;

    const lvl = level();
    const display = group(
      icon.monitor,
      t('displayGroup'),
      `<div class="field"><span class="field-label" id="lbl-unit">${t('unitShow')}</span>${segmented(
        'unit',
        s.unit || 'auto',
        ['auto', 'credits', 'requests'].map((v) => [v, t(`unit_${v}`)]),
        'lbl-unit',
      )}<span class="row-hint">${t('unitHint')}</span></div>
      <div class="field"><span class="field-label" id="lbl-display">${t('statusBarShows')}</span>${segmented(
        'display',
        s.display,
        [
          ['remaining', t('displayRemaining')],
          ['used', t('displayUsed')],
          ['percent', t('displayPercent')],
          ['dailyBudget', t('displayDailyBudget')],
        ],
        'lbl-display',
      )}</div>
      <div class="field"><span class="field-label" id="lbl-sbicon">${t('statusBarIcon')}</span>${segmented(
        'statusBarIcon',
        s.statusBarIcon,
        ['gauge', 'battery', 'ring', 'bars', 'none'].map((v) => [v, t(`icon_${v}`), glyph(v, lvl)]),
        'lbl-sbicon',
        'seg-glyphs',
      )}</div>
      <div class="field"><span class="field-label" id="lbl-sbcolor">${t('statusBarColor')}</span>${swatches('statusBarColor', s.statusBarColor, 'lbl-sbcolor')}</div>
      <div class="row"><span class="row-label" id="lbl-align">${t('statusBarPosition')}</span>${segmented(
        'alignment',
        s.alignment,
        [
          ['left', t('alignLeft')],
          ['right', t('alignRight')],
        ],
        'lbl-align',
        'seg-compact',
      )}</div>
      ${refreshIntervalRow()}`,
      '',
      statusBarPreview(),
    );

    const appearance = group(
      icon.palette,
      t('appearanceGroup'),
      `<div class="field"><span class="field-label" id="lbl-accent">${t('accentColor')}</span>${swatches('accent', s.accent, 'lbl-accent')}</div>
      ${row('tipsEnabled', s.tipsEnabled, t('showTips'))}`,
    );

    const budget = group(
      icon.target,
      t('budgetGroup'),
      `${row('countWeekends', s.countWeekends, t('countWeekends'), t('countWeekendsHint'))}
      <div class="row"><div class="row-text"><label class="row-label" for="reserve">${t('reserve')}</label><span class="row-hint">${t('reserveHint')}</span></div>
        <input class="num" id="reserve" type="number" min="0" step="1" inputmode="numeric" value="${esc(s.reserve)}" data-k="reserve"></div>`,
    );

    const warnings = group(
      icon.bell,
      t('warningsGroup'),
      `${row('warningsEnabled', s.warningsEnabled, t('warnings'))}
      <div class="field ${s.warningsEnabled ? '' : 'dim'}"><span class="field-label">${t('thresholds')}</span><div class="chips">${chips}${add}</div></div>
      ${row('paceWarning', s.paceWarning, t('paceWarning'), t('paceWarningHint'))}
      ${row('surplusHint', s.surplusHint, t('surplusHintSetting'), t('surplusHintHint'))}
      <div class="snooze-row">${snooze}</div>`,
    );

    const lang = s.copilotLanguage;
    const eager = s.copilotEagerness;
    const hasCopilot = s.copilotCompletions !== undefined || s.copilotNextEdit !== undefined || !!lang;
    const copilot = group(
      icon.spark,
      t('copilotGroup'),
      `${s.copilotCompletions !== undefined ? row('copilotCompletions', s.copilotCompletions, t('copilotCompletions')) : ''}
      ${lang ? row('copilotLanguage', lang.enabled, t('copilotLanguage', lang.label || lang.id)) : ''}
      ${s.copilotNextEdit !== undefined ? row('copilotNextEdit', s.copilotNextEdit, t('copilotNextEdit')) : ''}
      ${eager && eager.options && eager.options.length > 1 ? eagernessField(eager) : ''}
      <div class="btn-row">${
        s.copilotSnoozeAvailable
          ? `<button class="btn secondary small" data-cmd="snoozeCompletions" data-k="snooze-compl">${icon.pause}${t('snoozeCompletions')}</button>`
          : ''
      }<button class="btn secondary small" data-cmd="manageCopilot" data-k="manage">${icon.sliders}${t('manageCopilot')}</button>
      <button class="btn secondary small" data-cmd="openChat" data-k="chat">${icon.chat}${t('openChat')}</button></div>`,
      hasCopilot ? t('freeHint') : '',
    );

    const modelChips = (s.preferredModels || [])
      .map(
        (m) =>
          `<span class="tchip tchip-text">${esc(m)}<button class="tchip-x" data-action="removeModel" data-value="${esc(m)}" data-k="pm-${esc(m)}" title="${t(
            'removeModel',
            m,
          )}" aria-label="${t('removeModel', m)}">${icon.close}</button></span>`,
      )
      .join('');
    const addModel = addingModel
      ? `<span class="tchip tchip-input tchip-input-text"><input type="text" spellcheck="false" autocomplete="off" data-k="model-new" id="model-new" aria-label="${t(
          'addModel',
        )}" placeholder="gpt-4.1"></span>`
      : `<button class="tchip tchip-add" data-action="addModel" data-k="model-add" title="${t('addModel')}" aria-label="${t('addModel')}">${icon.plus}</button>`;
    const freeModels = s.btwModel === 'included';
    const chat = group(
      icon.aside,
      t('btwGroup'),
      `<div class="field"><span class="field-label" id="lbl-btwmodel">${t('btwModel')}</span>${segmented(
        'btwModel',
        freeModels ? 'included' : 'chat',
        [
          ['chat', t('btwModelChat')],
          ['included', t('btwModelFree')],
        ],
        'lbl-btwmodel',
      )}<span class="row-hint">${t(freeModels ? 'btwModelInfoFree' : 'btwModelInfoChat')}</span></div>
      <div class="field"><span class="field-label" id="lbl-btwopen">${t('btwOpenIn')}</span>${segmented(
        'btwOpenIn',
        s.btwOpenIn === 'window' ? 'window' : 'side',
        [
          ['side', t('btwOpenSide')],
          ['window', t('btwOpenWindow')],
        ],
        'lbl-btwopen',
      )}</div>
      ${
        freeModels
          ? `<div class="field"><span class="field-label" id="lbl-models">${t('preferredModels')}<span class="field-hint"> · ${t(
              'preferredModelsHint',
            )}</span></span><div class="chips" role="group" aria-labelledby="lbl-models">${modelChips}${addModel}</div></div>`
          : ''
      }
      ${row('btwIncludeChat', s.btwIncludeChat, t('btwIncludeChat'))}
      <div class="btn-row"><button class="btn secondary small" data-cmd="btw" data-k="set-btw">${icon.aside}${t('askBtw')}</button></div>`,
    );

    const tokenRow = `<div class="row"><div class="row-text"><span class="row-label">${t('billingToken')}</span><span class="row-hint">${
      s.billingTokenSet ? `${icon.check}${t('tokenStored')}` : t('billingTokenHint')
    }</span></div>${
      s.billingTokenSet
        ? `<button class="link subtle" data-cmd="clearBillingToken" data-k="tok-rm2">${t('removeToken')}</button>`
        : `<button class="btn secondary small" data-cmd="configureBillingToken" data-k="tok-add2">${t('addToken')}</button>`
    }</div>`;
    const account = group(
      icon.account,
      t('accountGroup'),
      `${providerControl()}
      ${tokenRow}
      ${row('activityTracking', s.activityTracking, t('activityTracking'), t('activityTrackingHint'))}
      <div class="field"><label class="field-label" for="api-url">${t('apiUrl')}</label>
        <input class="text" id="api-url" type="url" spellcheck="false" autocomplete="off" data-k="api-url" value="${esc(s.apiUrl || '')}" placeholder="${t(
          'apiUrlPlaceholder',
        )}"></div>
      <div class="actions">
        <button class="btn secondary small" data-cmd="openBilling" data-k="act-billing">${icon.external}${t('openBilling')}</button>
        <button class="btn secondary small" data-cmd="openSettings" data-k="act-settings">${icon.sliders}${t('allSettings')}</button>
        <button class="btn secondary small" data-cmd="showLog" data-k="act-log">${icon.log}${t('showLog')}</button>
      </div>`,
    );

    return `<div class="grid">${display}${appearance}${budget}${warnings}${copilot}${chat}${account}</div>`;
  }

  // ---------------------------------------------------------------- accent

  function resolveColor(v) {
    if (!v || v === 'auto') {
      return undefined;
    }
    if (PRESETS[v]) {
      return PRESETS[v];
    }
    return HEX.test(v) ? hex6(v) : undefined;
  }

  function rgb(hex) {
    const h = hex6(hex);
    return /^#[0-9a-f]{6}$/.test(h) ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) : undefined;
  }

  function lum(c) {
    const [r, g, b] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrast(a, b) {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }

  /** Mixes c towards `to` until it reaches the given contrast against bg. */
  function ensureContrast(c, bg, to, min) {
    for (let t = 0; t <= 1; t += 0.05) {
      const m = c.map((v, i) => Math.round(v + (to[i] - v) * t));
      if (contrast(m, bg) >= min) {
        return m;
      }
    }
    return to;
  }

  const css = (c) => `rgb(${c.join(' ')})`;

  /** Applies model.appearance.accentColor as CSS variables (tuned for contrast on the current theme). */
  function applyAccent() {
    const raw = model && model.appearance && model.appearance.accentColor;
    const c = raw ? rgb(raw) : undefined;
    const hc = document.body.classList.contains('vscode-high-contrast') || document.body.classList.contains('vscode-high-contrast-light');
    const light = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
    app.classList.toggle('has-accent', !!(raw && !hc));
    if (!raw || hc) {
      ['--accent', '--accent-solid', '--accent-fg'].forEach((p) => app.style.removeProperty(p));
      return;
    }
    if (!c) {
      app.style.setProperty('--accent', raw);
      app.style.setProperty('--accent-solid', raw);
      app.style.setProperty('--accent-fg', '#ffffff');
      return;
    }
    const bg = light ? [255, 255, 255] : [30, 30, 30];
    // Graphics need 3:1 against the panel; buttons need 4.5:1 for white text.
    app.style.setProperty('--accent', css(ensureContrast(c, bg, light ? [0, 0, 0] : [255, 255, 255], 3)));
    app.style.setProperty('--accent-solid', css(ensureContrast(c, [255, 255, 255], [0, 0, 0], 4.5)));
    app.style.setProperty('--accent-fg', '#ffffff');
  }

  // ---------------------------------------------------------------- tabs

  function tabsBar() {
    const labels = { overview: t('tabOverview'), history: t('tabHistory'), tips: t('tabTips'), settings: t('tabSettings') };
    return `<div class="tabs" role="tablist" aria-label="${t('title')}">${TABS.map((id) => {
      const on = id === ui.tab;
      return `<button class="tab" role="tab" id="tab-${id}" aria-selected="${on}" aria-controls="panel" tabindex="${on ? 0 : -1}" data-tab="${id}" data-k="tab-${id}">${labels[id]}</button>`;
    }).join('')}</div>`;
  }

  function overviewPanel() {
    const urgentOverage = model.quota.overageCount > 0;
    return `${surplusBanner()}<div class="layout">
      <div class="col col-a">${hero()}${urgentOverage ? overage() : ''}</div>
      <div class="col col-b">${tiles()}${chartCard()}${btwStrip()}</div></div>`;
  }

  function historyPanel() {
    return `<div class="grid">${activityCard()}${reviewCard()}${modelsCard()}</div>`;
  }

  function tipsPanel() {
    return `<div class="grid">${tipsNow()}${btwCard()}</div>
      <div class="tip-foot"><button class="link subtle" data-cmd="openWalkthrough" data-k="guide">${icon.book}${t('openGuide')}</button></div>`;
  }

  function panel() {
    switch (ui.tab) {
      case 'history':
        return historyPanel();
      case 'tips':
        return tipsPanel();
      case 'settings':
        return settingsPanel();
      default:
        return overviewPanel();
    }
  }

  // ---------------------------------------------------------------- states

  function emptyGlyph(cls) {
    let segs = '';
    for (let i = 0; i < 4; i++) {
      segs += `<path class="g-track" d="${arc(...segRange(i))}"/>`;
    }
    return `<div class="empty-glyph ${cls}" aria-hidden="true"><svg viewBox="0 0 220 122">${
      cls === 'brand'
        ? '<defs><linearGradient id="e-grad" x1="22" y1="0" x2="198" y2="0" gradientUnits="userSpaceOnUse"><stop class="e-stop0" offset="0"/><stop class="e-stop1" offset=".5"/><stop class="e-stop2" offset="1"/></linearGradient></defs>'
        : ''
    }${segs}</svg><span class="gauge-spark">${icon.spark}</span></div>`;
  }

  function emptyState(kind) {
    const s = model.settings || {};
    const links = `<div class="empty-links">
      <button class="link" data-cmd="showLog" data-k="e-log">${icon.log}${t('showLog')}</button>
      <button class="link" data-cmd="openSettings" data-k="e-settings">${icon.sliders}${t('allSettings')}</button></div>`;
    if (kind === 'signedOut') {
      const ent = model.provider === 'github-enterprise' || s.authProvider === 'github-enterprise';
      return `<section class="card empty">${emptyGlyph('brand')}
        <h2>${t('signedOutTitle')}</h2><p class="muted">${t('signedOutText')}</p>
        <button class="btn primary wide" data-cmd="signIn" data-k="signin">${icon.account}${t(ent ? 'signInEnterprise' : 'signIn')}</button>
        <div class="hint">${icon.bulb}<span>${t('enterpriseHint')}</span></div>
        ${s.authProvider ? providerControl() : ''}${links}</section>`;
    }
    if (kind === 'noCopilot') {
      return `<section class="card empty">${emptyGlyph('dim')}
        <h2>${t('noCopilotTitle')}</h2><p class="muted">${t('noCopilotText')}</p>
        <div class="btn-row center"><button class="btn primary" data-cmd="refresh" data-k="e-refresh">${icon.refresh}${t('retry')}</button>
        <button class="btn secondary" data-cmd="manageCopilot" data-k="e-manage">${icon.external}${t('manageCopilot')}</button></div>
        ${s.authProvider ? providerControl() : ''}${links}</section>`;
    }
    return `<section class="card empty error">${emptyGlyph('bad')}
      <h2>${icon.warning}${t('errorTitle')}</h2>
      ${model.errorMessage ? `<p class="err-msg">${esc(model.errorMessage)}</p>` : ''}
      <div class="btn-row center"><button class="btn primary" data-cmd="refresh" data-k="e-retry">${icon.refresh}${t('retry')}</button>
      <button class="btn secondary" data-cmd="showLog" data-k="e-log2">${icon.log}${t('showLog')}</button></div></section>`;
  }

  function skeleton() {
    const tile = '<div class="tile sk"><span class="sk-line w40"></span><span class="sk-line w60 tall"></span><span class="sk-line w80"></span></div>';
    return `<div class="skeleton" aria-hidden="true">
      <div class="topbar"><span class="sk-line w40"></span></div>
      <div class="card hero sk-hero">${emptyGlyph('sk-glyph')}<span class="sk-line w40 center"></span><span class="sk-line w60 center"></span></div>
      <div class="tiles">${tile.repeat(6)}</div>
      <div class="card"><span class="sk-line w40"></span><span class="sk-block"></span></div></div>
      <p class="sr-only" role="status">${t('loading')}</p>`;
  }

  // ---------------------------------------------------------------- render

  function render() {
    if (!model) {
      return;
    }
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const key = active && active.getAttribute ? active.getAttribute('data-k') : null;
    const inputState =
      active && active instanceof HTMLInputElement ? { value: active.value, start: safe(() => active.selectionStart), end: safe(() => active.selectionEnd) } : null;
    const scrollY = window.scrollY;

    let html;
    if (model.state === 'loading') {
      html = skeleton();
    } else if (model.state === 'ok' && model.quota) {
      html = `${header()}${staleBanner()}${tabsBar()}
        <div class="panel panel-${ui.tab}" id="panel" role="tabpanel" aria-labelledby="tab-${ui.tab}" tabindex="0">${panel()}</div>`;
    } else {
      html = `<div class="state-wrap">${emptyState(model.state === 'ok' ? 'error' : model.state)}</div>`;
    }

    const intro = introPending && model.state === 'ok' && !reducedMotion();
    app.classList.toggle('intro', intro);
    app.setAttribute('aria-busy', String(model.state === 'loading'));
    app.innerHTML = html;
    applyAccent();
    applyGeometry();
    drawChart();
    observeChart();
    if (model.state === 'ok') {
      if (introPending) {
        introPending = false;
        setTimeout(() => app.classList.remove('intro'), 1400);
      }
    }

    if (key) {
      const el = /** @type {HTMLElement | null} */ (app.querySelector(`[data-k="${CSS.escape(key)}"]`));
      if (el) {
        el.focus({ preventScroll: true });
        if (inputState && el instanceof HTMLInputElement && key !== 'th-new') {
          el.value = inputState.value;
          safe(() => el.setSelectionRange(inputState.start, inputState.end));
        }
      }
    }
    for (const [on, id] of [
      [addingThreshold, 'th-new'],
      [addingModel, 'model-new'],
    ]) {
      const inp = on ? /** @type {HTMLInputElement | null} */ (document.getElementById(id)) : null;
      if (inp && document.activeElement !== inp) {
        inp.focus();
      }
    }
    window.scrollTo(0, scrollY);
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** CSP forbids inline style attributes; set geometry through the CSSOM instead. */
  function applyGeometry() {
    app.querySelectorAll('[data-w]').forEach((el) => {
      /** @type {HTMLElement} */ (el).style.width = `${clamp(Number(el.getAttribute('data-w')) || 0, 0, 100)}%`;
    });
    app.querySelectorAll('[data-l]').forEach((el) => {
      /** @type {HTMLElement} */ (el).style.left = `${clamp(Number(el.getAttribute('data-l')) || 0, 0, 100)}%`;
    });
    app.querySelectorAll('.g-fill').forEach((el) => {
      const e = /** @type {SVGElement} */ (/** @type {unknown} */ (el));
      e.style.setProperty('--f', el.getAttribute('data-f'));
      e.style.setProperty('--d', `${Number(el.getAttribute('data-seg')) * 140}ms`);
    });
    app.querySelectorAll('[data-bg]').forEach((el) => {
      /** @type {HTMLElement} */ (el).style.background = el.getAttribute('data-bg') || '';
    });
    app.querySelectorAll('[data-fg]').forEach((el) => {
      /** @type {HTMLElement} */ (el).style.color = el.getAttribute('data-fg') || '';
    });
  }

  function observeChart() {
    const host = document.getElementById('chart-host');
    if (chartObserver) {
      chartObserver.disconnect();
    }
    if (!host || typeof ResizeObserver === 'undefined') {
      return;
    }
    chartObserver = new ResizeObserver(() => {
      if (Math.abs(Math.floor(host.clientWidth) - chartWidth) >= 2) {
        drawChart();
      }
    });
    chartObserver.observe(host);
  }

  // ---------------------------------------------------------------- events

  function post(msg) {
    vscode.postMessage(msg);
  }

  function setSetting(key, value) {
    if (model && model.settings) {
      const cur = model.settings[key];
      if (key === 'copilotLanguage' && cur) {
        cur.enabled = value;
      } else if (key === 'copilotEagerness' && cur) {
        cur.value = value;
      } else {
        model.settings[key] = value;
      }
      if (key === 'accent' && model.appearance) {
        // Optimistic: the extension sends the resolved colour with the next model.
        model.appearance.accentColor = resolveColor(String(value));
      }
    }
    post({ type: 'setSetting', key, value });
    render();
  }

  function commitThreshold(input) {
    const v = Math.round(Number(input.value));
    addingThreshold = false;
    if (v >= 1 && v <= 100) {
      const list = Array.from(new Set([...(model.settings.thresholds || []), v])).sort((a, b) => a - b);
      setSetting('thresholds', list);
    } else {
      render();
    }
    const add = app.querySelector('[data-k="th-add"]');
    if (add) {
      /** @type {HTMLElement} */ (add).focus();
    }
  }

  function commitModel(input) {
    const v = input.value.trim();
    addingModel = false;
    const list = model.settings.preferredModels || [];
    if (v && !list.includes(v)) {
      setSetting('preferredModels', list.concat(v));
    } else {
      render();
    }
    focusKey('model-add');
  }

  function focusKey(k) {
    const el = app.querySelector(`[data-k="${k}"]`);
    if (el) {
      /** @type {HTMLElement} */ (el).focus();
    }
  }

  app.addEventListener('click', (ev) => {
    const target = /** @type {HTMLElement} */ (ev.target);
    const el = /** @type {HTMLElement | null} */ (target.closest('[data-tab],[data-cmd],[data-set],[data-action]'));
    if (!el || !model || /** @type {HTMLButtonElement} */ (el).disabled) {
      return;
    }
    const tab = el.getAttribute('data-tab');
    if (tab) {
      selectTab(tab, false);
      return;
    }
    const cmd = el.getAttribute('data-cmd');
    if (cmd) {
      post({ type: 'command', command: cmd });
      return;
    }
    const set = el.getAttribute('data-set');
    if (set) {
      if (el.getAttribute('role') === 'switch') {
        setSetting(set, el.getAttribute('aria-checked') !== 'true');
      } else if (el.getAttribute('role') === 'radio') {
        const v = el.getAttribute('data-value');
        const cur = model.settings[set];
        if ((cur && typeof cur === 'object' ? cur.value : cur) !== v) {
          setSetting(set, v);
        }
      }
      return;
    }
    const action = el.getAttribute('data-action');
    switch (action) {
      case 'enableActivity':
        setSetting('activityTracking', true);
        break;
      case 'addThreshold':
        addingThreshold = true;
        render();
        break;
      case 'addModel':
        addingModel = true;
        render();
        break;
      case 'removeModel': {
        const v = el.getAttribute('data-value');
        setSetting(
          'preferredModels',
          (model.settings.preferredModels || []).filter((x) => x !== v),
        );
        focusKey('model-add');
        break;
      }
      case 'removeThreshold': {
        const v = Number(el.getAttribute('data-value'));
        setSetting(
          'thresholds',
          (model.settings.thresholds || []).filter((x) => x !== v),
        );
        const add = app.querySelector('[data-k="th-add"]');
        if (add) {
          /** @type {HTMLElement} */ (add).focus();
        }
        break;
      }
    }
  });

  function selectTab(id, focus) {
    if (!TABS.includes(id)) {
      return;
    }
    const changed = id !== ui.tab;
    ui.tab = id;
    addingThreshold = false;
    addingModel = false;
    persist();
    if (changed) {
      render();
      window.scrollTo(0, 0);
    }
    if (focus) {
      const el = /** @type {HTMLElement | null} */ (app.querySelector(`[data-tab="${id}"]`));
      if (el) {
        el.focus();
      }
    }
  }

  app.addEventListener('change', (ev) => {
    const el = /** @type {HTMLInputElement} */ (ev.target);
    const colorKey = el.getAttribute && el.getAttribute('data-color');
    if (colorKey && HEX.test(el.value)) {
      setSetting(colorKey, el.value.toLowerCase());
      return;
    }
    if (el.id === 'refresh-interval') {
      const v = Number(el.value);
      if (v > 0 && v !== model.settings.refreshIntervalMinutes) {
        setSetting('refreshIntervalMinutes', v);
      }
      return;
    }
    if (el.id === 'api-url') {
      const v = el.value.trim();
      el.value = v;
      if (v !== (model.settings.apiUrl || '')) {
        setSetting('apiUrl', v);
      }
      return;
    }
    if (el.id === 'reserve') {
      const v = Math.max(0, Math.round(Number(el.value) || 0));
      el.value = String(v);
      if (v !== model.settings.reserve) {
        setSetting('reserve', v);
      }
    }
  });

  app.addEventListener('keydown', (ev) => {
    const el = /** @type {HTMLElement} */ (ev.target);
    if (el.id === 'th-new') {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commitThreshold(el);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        addingThreshold = false;
        render();
        const add = app.querySelector('[data-k="th-add"]');
        if (add) {
          /** @type {HTMLElement} */ (add).focus();
        }
      }
      return;
    }
    if (el.id === 'model-new') {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commitModel(el);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        addingModel = false;
        render();
        focusKey('model-add');
      }
      return;
    }
    if ((el.id === 'reserve' || el.id === 'api-url') && ev.key === 'Enter') {
      el.blur();
      return;
    }
    if (el.id === 'api-url' && ev.key === 'Escape') {
      /** @type {HTMLInputElement} */ (el).value = model.settings.apiUrl || '';
      el.blur();
      return;
    }
    if (el.getAttribute('role') === 'tab') {
      const i = TABS.indexOf(ui.tab);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[ev.key];
      if (next !== undefined) {
        ev.preventDefault();
        selectTab(TABS[(next + TABS.length) % TABS.length], true);
      }
      return;
    }
    if (el.getAttribute('role') === 'radio') {
      const group = /** @type {HTMLElement} */ (el.parentElement);
      const radios = /** @type {HTMLElement[]} */ (Array.from(group.querySelectorAll('[role="radio"]')));
      const i = radios.indexOf(el);
      let j = -1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
        j = (i + 1) % radios.length;
      } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
        j = (i - 1 + radios.length) % radios.length;
      } else if (ev.key === 'Home') {
        j = 0;
      } else if (ev.key === 'End') {
        j = radios.length - 1;
      }
      if (j >= 0) {
        ev.preventDefault();
        radios[j].focus();
        radios[j].click();
      }
    }
  });

  app.addEventListener(
    'blur',
    (ev) => {
      const el = /** @type {HTMLElement} */ (ev.target);
      if (el && el.id === 'th-new' && addingThreshold) {
        commitThreshold(el);
      } else if (el && el.id === 'model-new' && addingModel) {
        commitModel(el);
      }
    },
    true,
  );

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg && msg.type === 'model' && msg.model) {
      model = msg.model;
      nfCache.clear();
      render();
    }
  });

  // Keep the relative "updated" time fresh without a full re-render.
  setInterval(() => {
    const el = document.getElementById('updated');
    if (el && model && model.quota) {
      el.textContent = raw('updated', relativePast(model.quota.fetchedAt));
    }
  }, 30000);

  post({ type: 'ready' });
})();
