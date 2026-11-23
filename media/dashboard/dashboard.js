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
  /** @type {ResizeObserver | undefined} */
  let chartObserver;
  let chartWidth = 0;

  const saved = safe(() => vscode.getState()) || {};
  const ui = {
    open: Object.assign({ allTips: false, settings: false }, saved.open || {}),
    tipId: /** @type {string | undefined} */ (saved.tipId),
    tipAt: Number(saved.tipAt) || 0,
  };

  function persist() {
    safe(() => vscode.setState({ open: ui.open, tipId: ui.tipId, tipAt: ui.tipAt }));
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
    left: S('<path d="M10 3.75 5.75 8 10 12.25"/>'),
    right: S('<path d="M6 3.75 10.25 8 6 12.25"/>'),
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
      <div class="banner-text"><strong>${t('offline')}</strong> · ${t('offlineHint')}${model.errorMessage ? `<span class="banner-detail">${esc(model.errorMessage)}</span>` : ''}</div>
      <button class="link" data-cmd="refresh" data-k="refresh-banner">${t('retry')}</button></div>`;
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
      <div class="tile-sub">${o.sub || ''}</div></div>`;
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
        sub: q.unlimited || !f ? '' : t('ofBudget', fmt(budget)),
        bar: q.unlimited || !f || budget <= 0 ? undefined : m.today / budget,
        tone: !q.unlimited && f && m.today > budget ? 'bad' : !q.unlimited && f ? 'good' : '',
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
          sub: ahead ? t('aheadOfPlan', fmt(Math.abs(m.bufferDays))) : t('overPlan', fmt(Math.abs(m.bufferDays))),
          tone: ahead ? 'good' : 'bad',
        }),
      );
      const over = f.projectedUsed > q.entitlement;
      list.push(
        tile({
          icon: icon.flag,
          label: t('atReset'),
          value: fmt(f.projectedUsed),
          unit: `/${fmt(q.entitlement)}`,
          sub: f.exhaustionDate ? `${icon.warning}${t('emptyOn', fmtDate(f.exhaustionDate))}` : t('projectedOf', fmt(q.entitlement)),
          tone: over ? 'bad' : 'good',
        }),
      );
      list.push(
        tile({
          icon: icon.flame,
          label: t('streak'),
          value: m.streakDays === 1 ? t('streakOne') : t('streakMany', fmt(m.streakDays)),
          sub: t('withinBudget'),
          tone: m.streakDays > 0 ? 'good' : '',
        }),
      );
    }
    list.push(tile({ icon: icon.bars, label: t('last7'), value: fmt(m.last7Days), sub: t('avgPerDay', fmt(m.last7Days / 7)) }));
    list.push(tile({ icon: icon.trend, label: t('cycleAverage'), value: fmt(m.cycleAverage), unit: perDayUnit, sub: t('perBudgetDay') }));
    return `<section class="tiles-wrap" aria-label="${t('pace')}"><div class="tiles">${list.join('')}</div></section>`;
  }

  function chartCard() {
    const m = model.metrics;
    if (!m || !m.daily || m.daily.length === 0) {
      return '';
    }
    const anyEst = m.daily.some((d) => d.estimated);
    const showPlan = !model.quota.unlimited && m.planPerDay > 0;
    const showBudget = !model.quota.unlimited && model.forecast && model.forecast.dailyBudget > 0;
    const legend = [
      showPlan ? `<span class="lg"><span class="sw sw-plan"></span>${t('legendPlan')} <b>${fmt(m.planPerDay)}</b></span>` : '',
      `<span class="lg"><span class="sw sw-today"></span>${t('legendToday')}</span>`,
      showBudget ? `<span class="lg"><span class="sw sw-ghost"></span>${t('dailyBudget')}</span>` : '',
      anyEst ? `<span class="lg"><span class="sw sw-est"></span>${t('legendEstimated')}</span>` : '',
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
    for (let d = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1); d < resetDay && days.length < 42; d.setDate(d.getDate() + 1)) {
      const wk = d.getDay() === 0 || d.getDay() === 6;
      days.push({ date: '', used: 0, weekend: wk, estimated: false, day: new Date(d), future: true });
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
      let tip;
      if (d.future) {
        const b = d.weekend && !settings.countWeekends ? 0 : budget;
        if (b > 0) {
          const h = Math.max(2, base - y(b));
          bars += `<rect class="c-ghost" x="${(cx - bw / 2).toFixed(2)}" y="${(base - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="2"/>`;
        }
        tip = `${fmtDate(d.day, fullFmt)} · ${raw('dailyBudget')}: ${fmt(b)}`;
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
        const notes = [i === todayIdx ? raw('legendToday') : '', d.weekend ? raw('weekendNote') : '', d.estimated ? raw('estimatedNote') : '']
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
        <rect class="c-hatch-bg" width="4" height="4"/><line class="c-hatch-line" x1="0" y1="0" x2="0" y2="4"/></pattern></defs>
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

  function orderedTips() {
    const tips = (model.tips || []).slice();
    return tips.filter((x) => x.relevant).concat(tips.filter((x) => !x.relevant));
  }

  function currentTipIndex(tips) {
    const fresh = Date.now() - ui.tipAt < 6 * 3600 * 1000;
    const i = fresh && ui.tipId ? tips.findIndex((x) => x.id === ui.tipId) : -1;
    return i >= 0 ? i : 0;
  }

  function tipsCard() {
    const tips = orderedTips();
    if (tips.length === 0 || !model.settings.tipsEnabled) {
      return '';
    }
    const i = currentTipIndex(tips);
    const tip = tips[i];
    return `<section class="card tip-card ${tip.relevant ? 'relevant' : ''}" aria-labelledby="tip-title">
      <div class="card-head"><h2 id="tip-title">${icon.bulb}${t('tips')}</h2>
        <div class="tip-nav">
          <span class="tip-count" aria-hidden="true">${t('tipCounter', i + 1, tips.length)}</span>
          <button class="icon-btn" data-action="tipPrev" data-k="tip-prev" title="${t('prevTip')}" aria-label="${t('prevTip')}">${icon.left}</button>
          <button class="icon-btn" data-action="tipNext" data-k="tip-next" title="${t('nextTip')}" aria-label="${t('nextTip')}">${icon.right}</button>
        </div></div>
      <div class="tip-body" aria-live="polite">
        ${tip.relevant ? `<span class="badge badge-accent">${icon.spark}${t('relevantNow')}</span>` : ''}
        <p class="tip-text"><span class="sr-only">${t('tipCounter', i + 1, tips.length)}: </span>${esc(tip.text)}</p>
      </div>
      <div class="tip-foot"><button class="link" data-cmd="openWalkthrough" data-k="guide">${icon.book}${t('openGuide')}</button></div>
    </section>`;
  }

  function collapsible(id, title, iconSvg, body, extra = '') {
    const open = !!ui.open[id];
    return `<section class="card collapsible ${open ? 'open' : ''}">
      <h2 class="disc-h"><button class="disclosure" data-action="toggle" data-section="${id}" data-k="disc-${id}" aria-expanded="${open}" aria-controls="sec-${id}">
        ${iconSvg}<span class="disc-title">${title}</span>${extra}${icon.chevron}</button></h2>
      <div class="disc-body" id="sec-${id}" ${open ? '' : 'hidden'}>${body}</div></section>`;
  }

  function allTips() {
    const tips = orderedTips();
    if (tips.length === 0) {
      return '';
    }
    const cur = model.settings.tipsEnabled ? tips[currentTipIndex(tips)].id : '';
    const items = tips
      .map(
        (x) => `<li class="${x.relevant ? 'relevant' : ''} ${x.id === cur ? 'current' : ''}">
        <span class="li-mark">${x.relevant ? icon.spark : '<span class="dot"></span>'}</span><span>${esc(x.text)}${
          x.relevant ? ` <span class="sr-only">(${t('relevantNow')})</span>` : ''
        }</span></li>`,
      )
      .join('');
    const count = `<span class="count">${tips.length}</span>`;
    const body = `<ul class="tip-list">${items}</ul>
      <div class="tip-foot"><button class="link" data-cmd="openWalkthrough" data-k="guide2">${icon.book}${t('openGuide')}</button></div>`;
    return collapsible('allTips', t(model.settings.tipsEnabled ? 'allTips' : 'tips'), icon.bulb, body, count);
  }

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

  function segmented(key, value, options, labelId) {
    return `<div class="segmented" role="radiogroup" aria-labelledby="${labelId}" data-count="${options.length}">${options
      .map(
        ([v, l]) =>
          `<button role="radio" aria-checked="${v === value}" tabindex="${v === value ? 0 : -1}" data-set="${key}" data-value="${esc(v)}" data-k="seg-${key}-${esc(
            v,
          )}" title="${l}"><span>${l}</span></button>`,
      )
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

  function settingsSection() {
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

    const hasCopilot = s.copilotCompletions !== undefined || s.copilotNextEdit !== undefined;
    const copilot = hasCopilot
      ? `<div class="group"><h3 class="group-h">${icon.spark}${t('copilotGroup')}<span class="group-note">${t('freeHint')}</span></h3>
        ${s.copilotCompletions !== undefined ? row('copilotCompletions', s.copilotCompletions, t('copilotCompletions')) : ''}
        ${s.copilotNextEdit !== undefined ? row('copilotNextEdit', s.copilotNextEdit, t('copilotNextEdit')) : ''}
        <div class="btn-row"><button class="btn secondary small" data-cmd="manageCopilot" data-k="manage">${icon.sliders}${t('manageCopilot')}</button>
        <button class="btn secondary small" data-cmd="openChat" data-k="chat">${icon.chat}${t('openChat')}</button></div></div>`
      : `<div class="group"><div class="btn-row"><button class="btn secondary small" data-cmd="manageCopilot" data-k="manage">${icon.sliders}${t(
          'manageCopilot',
        )}</button><button class="btn secondary small" data-cmd="openChat" data-k="chat">${icon.chat}${t('openChat')}</button></div></div>`;

    const body = `
      <div class="group">
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
      </div>
      <div class="group"><h3 class="group-h">${icon.target}${t('budgetGroup')}</h3>
        ${row('countWeekends', s.countWeekends, t('countWeekends'), t('countWeekendsHint'))}
        <div class="row"><div class="row-text"><label class="row-label" for="reserve">${t('reserve')}</label><span class="row-hint">${t('reserveHint')}</span></div>
          <input class="num" id="reserve" type="number" min="0" step="1" inputmode="numeric" value="${esc(s.reserve)}" data-k="reserve"></div>
      </div>
      <div class="group"><h3 class="group-h">${icon.bell}${t('warningsGroup')}</h3>
        ${row('warningsEnabled', s.warningsEnabled, t('warnings'))}
        <div class="field ${s.warningsEnabled ? '' : 'dim'}"><span class="field-label">${t('thresholds')}</span><div class="chips">${chips}${add}</div></div>
        ${row('paceWarning', s.paceWarning, t('paceWarning'), t('paceWarningHint'))}
        <div class="snooze-row">${snooze}</div>
      </div>
      <div class="group">
        ${row('tipsEnabled', s.tipsEnabled, t('showTips'))}
        ${providerControl()}
      </div>
      ${copilot}
      <div class="group actions">
        <button class="btn secondary small" data-cmd="refresh" data-k="act-refresh">${icon.refresh}${t('refresh')}</button>
        <button class="btn secondary small" data-cmd="openBilling" data-k="act-billing">${icon.external}${t('openBilling')}</button>
        <button class="btn secondary small" data-cmd="openSettings" data-k="act-settings">${icon.sliders}${t('allSettings')}</button>
        <button class="btn secondary small" data-cmd="showLog" data-k="act-log">${icon.log}${t('showLog')}</button>
      </div>`;
    return collapsible('settings', t('quickSettings'), icon.sliders, body);
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
      <div class="tiles">${tile.repeat(4)}</div>
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
      const urgentOverage = model.quota.overageCount > 0;
      html = `${header()}${staleBanner()}<div class="layout">
        <div class="col col-a">${hero()}${urgentOverage ? overage() : ''}</div>
        <div class="col col-b">${tiles()}${chartCard()}</div>
        <div class="col col-c"><div class="stack">${tipsCard()}${urgentOverage ? '' : overage()}${allTips()}</div>
        <div class="stack">${settingsSection()}</div></div></div>`;
    } else {
      html = `<div class="state-wrap">${emptyState(model.state === 'ok' ? 'error' : model.state)}</div>`;
    }

    const intro = introPending && model.state === 'ok' && !reducedMotion();
    app.classList.toggle('intro', intro);
    app.setAttribute('aria-busy', String(model.state === 'loading'));
    app.innerHTML = html;
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
    if (addingThreshold) {
      const inp = /** @type {HTMLInputElement | null} */ (document.getElementById('th-new'));
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
      model.settings[key] = value;
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

  app.addEventListener('click', (ev) => {
    const target = /** @type {HTMLElement} */ (ev.target);
    const el = /** @type {HTMLElement | null} */ (target.closest('[data-cmd],[data-set],[data-action]'));
    if (!el || !model || /** @type {HTMLButtonElement} */ (el).disabled) {
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
        if (model.settings[set] !== v) {
          setSetting(set, v);
        }
      }
      return;
    }
    const action = el.getAttribute('data-action');
    switch (action) {
      case 'toggle': {
        const id = /** @type {string} */ (el.getAttribute('data-section'));
        ui.open[id] = !ui.open[id];
        persist();
        render();
        break;
      }
      case 'tipPrev':
      case 'tipNext': {
        const tips = orderedTips();
        const i = currentTipIndex(tips);
        const next = (i + (action === 'tipNext' ? 1 : -1) + tips.length) % tips.length;
        ui.tipId = tips[next].id;
        ui.tipAt = Date.now();
        persist();
        render();
        break;
      }
      case 'addThreshold':
        addingThreshold = true;
        render();
        break;
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

  app.addEventListener('change', (ev) => {
    const el = /** @type {HTMLInputElement} */ (ev.target);
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
    if (el.id === 'reserve' && ev.key === 'Enter') {
      el.blur();
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
