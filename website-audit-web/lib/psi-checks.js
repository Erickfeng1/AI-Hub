'use strict';
/**
 * PageSpeed Insights API 集成（经 Cloudflare Worker 反代）
 *
 * 配置来源（server.js 读 psi-config.json / 环境变量后经 opts.psi 传入）：
 *   { base: 'https://psi.xxx.com', token: '...', strategy: 'mobile', timeoutMs: 150000 }
 *
 * 调用：GET {base}/psi/v5/runPagespeed?url=<enc>&strategy=<s>&token=<t>
 * 返回统一形态：
 *   成功 { ok:true, source:'psi-api', score, grade, metrics:{lcpMs,cls,tbtMs,fcpMs,ttfbMs,speedIndexMs},
 *          crux:{overallCategory,originFallback,lcpP75,clsP75,inpP75,fcpP75,ttfbP75,...categories},
 *          strategy, lighthouseVersion, fetchTime, durationMs, fetchedAt }
 *   失败 { ok:false, error:'...' }
 */

function letter(score) {
  if (score == null || Number.isNaN(score)) return '—';
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 50 ? 'D' : 'F';
}

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function msRound(v) {
  const n = num(v);
  return n == null ? null : Math.round(n);
}

/** 解析 PSI API 原始 JSON（独立导出，便于单测） */
function parsePsi(json) {
  const lr = json && json.lighthouseResult;
  const le = (json && json.loadingExperience) || null;
  if (!lr || typeof lr !== 'object') {
    return { ok: false, error: 'PSI 响应中缺少 lighthouseResult' };
  }
  const cat = (lr.categories && lr.categories.performance) || {};
  const audits = lr.audits || {};
  const pick = (id) => audits[id] || null;

  const metrics = {
    lcpMs: msRound(pick('largest-contentful-paint') && pick('largest-contentful-paint').numericValue),
    cls:
      pick('cumulative-layout-shift') && pick('cumulative-layout-shift').numericValue != null
        ? Math.round(num(pick('cumulative-layout-shift').numericValue) * 1000) / 1000
        : null,
    tbtMs: msRound(pick('total-blocking-time') && pick('total-blocking-time').numericValue),
    fcpMs: msRound(pick('first-contentful-paint') && pick('first-contentful-paint').numericValue),
    ttfbMs: msRound(pick('server-response-time') && pick('server-response-time').numericValue),
    speedIndexMs: msRound(pick('speed-index') && pick('speed-index').numericValue),
  };
  const score = cat.score != null ? Math.round(num(cat.score) * 100) : null;

  // CrUX 真实用户数据（页面/origin 无足够样本时缺省）
  let crux = null;
  if (le && le.metrics && Object.keys(le.metrics).length) {
    // PSI API 实际返回大写键（LARGEST_CONTENTFUL_PAINT_MS 等），兼容小写旧格式
    const PSI_UPPER = { largest_contentful_paint: 'LARGEST_CONTENTFUL_PAINT_MS', cumulative_layout_shift: 'CUMULATIVE_LAYOUT_SHIFT_SCORE', interaction_to_next_paint: 'INTERACTION_TO_NEXT_PAINT', first_contentful_paint: 'FIRST_CONTENTFUL_PAINT_MS', experimental_time_to_first_byte: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE' };
    const g = (id) => (le.metrics[id] || (PSI_UPPER[id] && le.metrics[PSI_UPPER[id]]) || null);
    const build = (id) => {
      const m = g(id);
      if (!m) return null;
      let p75 = num(m.percentile);
      if (p75 == null) return null;
      if (id === 'cumulative_layout_shift') p75 = Math.round(p75) / 100; // CrUX CLS p75 单位为 1/100
      return { p75, category: m.category || null };
    };
    crux = {
      overallCategory: le.overall_category || null,
      originFallback: le.origin_fallback === true,
      formFactor: String((lr.configSettings && lr.configSettings.emulatedFormFactor) || 'mobile').toUpperCase(),
      lcp: build('largest_contentful_paint'),
      cls: build('cumulative_layout_shift'),
      inp: build('interaction_to_next_paint'),
      fcp: build('first_contentful_paint'),
      ttfb: build('experimental_time_to_first_byte'),
    };
    crux = annotateCrux(crux);
  }

  return {
    ok: true,
    source: 'psi-api',
    strategy: (lr.configSettings && lr.configSettings.emulatedFormFactor) || 'mobile',
    score,
    grade: letter(score),
    metrics,
    crux,
    lighthouseVersion: lr.lighthouseVersion || null,
    fetchTime: lr.fetchTime || null,
    runtimeError: lr.runtimeError ? String(lr.runtimeError.message || lr.runtimeError) : null,
  };
}

async function checkPsi(targetUrl, cfg, onProgress) {
  const started = Date.now();
  const base = String((cfg && cfg.base) || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'psi-not-configured' };

  try {
    const qs = new URLSearchParams({ url: targetUrl, strategy: (cfg && cfg.strategy) || 'mobile' });
    if (cfg && cfg.token) qs.set('token', cfg.token);
    const url = `${base}/psi/v5/runPagespeed?${qs.toString()}`;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), (cfg && cfg.timeoutMs) || 150000);
    let resp;
    try {
      resp = await fetch(url, {
        signal: ctl.signal,
        headers: { 'user-agent': 'website-audit-web/0.5 (+psi-check)' },
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await resp.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      /* 非 JSON，走错误分支 */
    }
    if (!resp.ok || !data) {
      const msg = data && data.error && data.error.message ? data.error.message : text.slice(0, 160);
      return { ok: false, error: `PSI HTTP ${resp.status}: ${msg}`, durationMs: Date.now() - started };
    }

    const parsed = parsePsi(data);
    parsed.durationMs = Date.now() - started;
    parsed.fetchedAt = new Date().toISOString();
    if (onProgress && parsed.ok && parsed.score != null) {
      const lcpS = parsed.metrics.lcpMs != null ? (parsed.metrics.lcpMs / 1000).toFixed(1) + 's' : '—';
      onProgress({
        stage: 'perf',
        pct: 90,
        detail: `PSI 完成：性能分 ${parsed.score} · LCP ${lcpS} · 耗时 ${Math.round(parsed.durationMs / 1000)}s`,
      });
    }
    return parsed;
  } catch (e) {
    const msg = String((e && e.message) || e);
    return {
      ok: false,
      error: /abort/i.test(msg) ? 'PSI 请求超时（>150s）' : 'psi-exception: ' + msg,
      durationMs: Date.now() - started,
    };
  }
}

// ---- CrUX API（真实用户数据）：独立查询，桌面端，页面级→整站 origin 回退 ----
const CRUX_KEYS = { lcp: 'LARGEST_CONTENTFUL_PAINT_MS', cls: 'CUMULATIVE_LAYOUT_SHIFT_SCORE', inp: 'INTERACTION_TO_NEXT_PAINT', fcp: 'FIRST_CONTENTFUL_PAINT_MS', ttfb: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE' };
const CRUX_GOOD = { lcp: 2500, cls: 0.1, inp: 200, fcp: 1800, ttfb: 800 };
const CRUX_POOR = { lcp: 4000, cls: 0.25, inp: 500, fcp: 3000, ttfb: 1800 };

// CrUX 综合分：核心三项（LCP/INP/CLS，Google Core Web Vitals 排名口径）按阈值插值打分后取平均
function cruxMetricScore(key, p75) {
  const good = CRUX_GOOD[key], poor = CRUX_POOR[key];
  if (p75 <= good) return 100;
  if (p75 <= poor) return Math.round(100 - ((p75 - good) / (poor - good)) * 70);
  return Math.max(0, Math.round(30 - ((p75 - poor) / poor) * 60));
}
function annotateCrux(cx) {
  if (!cx) return cx;
  const core = ['lcp', 'cls', 'inp'];
  const scores = [];
  let pass = 0, counted = 0;
  core.forEach((k) => {
    const v = cx[k] && cx[k].p75;
    if (v == null) return;
    counted++;
    if (v <= CRUX_GOOD[k]) pass++;
    scores.push(cruxMetricScore(k, v));
  });
  if (!counted) return cx;
  cx.score = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  cx.corePass = pass;
  cx.coreTotal = counted;
  cx.grade = letter(cx.score);
  return cx;
}
function cruxCategory(key, v) {
  if (v == null) return null;
  return v <= CRUX_GOOD[key] ? 'GOOD' : v <= CRUX_POOR[key] ? 'AVERAGE' : 'POOR';
}
function parseCruxRecord(record, scope) {
  if (!record || !record.metrics) return null;
  const build = (key) => {
    const m = record.metrics[CRUX_KEYS[key]];
    if (!m || !m.percentiles) return null;
    let p75 = num(m.percentiles.p75);
    if (p75 == null) return null;
    if (key === 'cls') p75 = Math.round(p75) / 100; // CrUX CLS p75 单位为 1/100
    return { p75, category: cruxCategory(key, p75) };
  };
  return annotateCrux({
    source: 'crux-api', formFactor: 'DESKTOP', scope,
    originFallback: scope === 'origin',
    overallCategory: null,
    lcp: build('lcp'), cls: build('cls'), inp: build('inp'), fcp: build('fcp'), ttfb: build('ttfb'),
  });
}
async function checkCrux(targetUrl, cfg) {
  const started = Date.now();
  const base = String((cfg && cfg.base) || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'crux-not-configured' };
  let u;
  try { u = new URL(targetUrl); } catch (e) { return { ok: false, error: 'bad-url' }; }
  const call = async (bodyObj) => {
    const qs = new URLSearchParams();
    if (cfg && cfg.token) qs.set('token', cfg.token);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), (cfg && cfg.cruxTimeoutMs) || 20000);
    try {
      const resp = await fetch(`${base}/crux/v4/records:queryRecord?${qs.toString()}`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyObj) });
      const text = await resp.text();
      let data = null; try { data = JSON.parse(text); } catch (e) {}
      return { status: resp.status, data, text };
    } finally { clearTimeout(timer); }
  };
  try {
    let r = await call({ url: u.toString(), formFactor: 'DESKTOP' });
    let parsed = r.data && r.data.record ? parseCruxRecord(r.data.record, 'url') : null;
    if (!parsed) {
      r = await call({ origin: u.origin, formFactor: 'DESKTOP' });
      parsed = r.data && r.data.record ? parseCruxRecord(r.data.record, 'origin') : null;
    }
    if (!parsed) {
      const apiDown = r.status !== 200 || !r.data;
      const msg = r.data && r.data.error && r.data.error.message ? String(r.data.error.message).slice(0, 120) : ('HTTP ' + r.status);
      return { ok: false, error: apiDown ? `CrUX API 不可用（${msg}）` : '桌面端页面与整站均无 CrUX 样本', apiDown, durationMs: Date.now() - started };
    }
    return { ok: true, crux: parsed, durationMs: Date.now() - started };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, error: /abort/i.test(msg) ? 'CrUX 请求超时' : 'crux-exception: ' + msg, apiDown: true, durationMs: Date.now() - started };
  }
}
module.exports = { checkPsi, parsePsi, checkCrux, annotateCrux, letter };
