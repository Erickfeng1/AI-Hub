'use strict';
/**
 * 服务器端轻量性能探针（无浏览器依赖）
 * 背景：Lighthouse 需要 headless Chrome（生产容器没有），Google PSI API 在生产网络不可达。
 * 原理：直接实测 TTFB、页面重量、外链 CSS/JS 体积、图片加载策略、压缩与缓存头、阻塞脚本，
 *      组合为"服务器视角加载性能"代理评分。
 * 局限：无法测 LCP/CLS/TBT 等渲染期指标（需真实浏览器），报告会注明并用 PSI 复核指引。
 */
const http = require('http');
const https = require('https');
const http2 = require('http2');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (compatible; SiteAuditProbe/1.0)';
const letter = (s) => (s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 50 ? 'D' : 'F');

/** 真实 HTTP 测量：TTFB（response 头到达）、content-length、content-encoding、cache 头 */
function fetchMeasured(urlStr, { timeout = 12000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ error: 'bad-url' }); }
    if (!/^https?:$/.test(u.protocol)) return resolve({ error: 'bad-protocol' });
    const mod = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const req = mod.get(
      u,
      { timeout, headers: { 'User-Agent': UA, Accept: '*/*' }, rejectUnauthorized: false },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchMeasured(new URL(res.headers.location, u).toString(), { timeout, maxBytes }));
        }
        const ttfbMs = Date.now() - t0; // 响应头到达 ≈ 首字节
        let bytes = 0;
        let truncated = false;
        res.on('data', (c) => {
          bytes += c.length;
          if (maxBytes && bytes > maxBytes) { truncated = true; req.destroy(); }
        });
        res.on('end', () => resolve({
          status: res.statusCode,
          ttfbMs,
          bytes,
          truncated,
          bytesFromHeader: res.headers['content-length'] != null ? Number(res.headers['content-length']) : null,
          headers: res.headers,
        }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ error: String((e && e.message) || e) }));
  });
}

/** HTTP/2 真实探测 */
function probeHttp2(urlStr, timeout = 5000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve(false); }
    if (u.protocol !== 'https:') return resolve(false);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { s.close(); } catch (e) {} resolve(v); } };
    const t = setTimeout(() => done(false), timeout);
    let s;
    try { s = http2.connect(u.origin); } catch (e) { clearTimeout(t); return resolve(false); }
    s.on('connect', () => { clearTimeout(t); done(true); });
    s.on('error', () => { clearTimeout(t); done(false); });
  });
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const tier = (v, rows, fallback) => {
  for (const [max, sc] of rows) if (v != null && v <= max) return sc;
  return fallback;
};

async function runPerfProbe(homeUrl, homeHtml, onProgress = () => {}) {
  const $ = cheerio.load(homeHtml || '');
  const abs = (h) => { try { return new URL(h, homeUrl).toString(); } catch (e) { return null; } };

  const cssUrls = [];
  const jsUrls = [];
  $('link[rel="stylesheet"][href]').each((_, el) => {
    const u = abs(($(el).attr('href') || '').trim());
    if (u && !u.startsWith('data:')) cssUrls.push(u);
  });
  $('script[src]').each((_, el) => {
    const u = abs(($(el).attr('src') || '').trim());
    if (u && !u.startsWith('data:')) jsUrls.push(u);
  });
  const imgTotal = $('img').length;
  const imgLazy = $('img[loading="lazy"]').length;
  const imgNoDims = $('img').filter((_, el) => !$(el).attr('width') || !$(el).attr('height')).length;
  const syncHeadScripts = $('head script[src]:not([async]):not([defer])').length;

  onProgress({ stage: 'perf', pct: 84, detail: '性能探针：测量首页 TTFB 与传输体积…' });
  const home = await fetchMeasured(homeUrl, { timeout: 20000, maxBytes: 4 * 1024 * 1024 });
  if (home.error) {
    return { score: null, grade: '—', source: 'server-probe', error: home.error, note: '性能探针无法访问目标站点' };
  }
  const ttfbMs = home.ttfbMs;
  const htmlBytes = home.bytesFromHeader != null ? home.bytesFromHeader : home.bytes;
  const compression = String(home.headers['content-encoding'] || 'none').toLowerCase();

  onProgress({ stage: 'perf', pct: 86, detail: `性能探针：测量外链资源（CSS ${cssUrls.length} / JS ${jsUrls.length}）…` });
  const targets = [
    ...cssUrls.slice(0, 12).map((u) => ({ u, type: 'css' })),
    ...jsUrls.slice(0, 12).map((u) => ({ u, type: 'js' })),
  ];
  const measured = await pool(targets, 5, (t) =>
    fetchMeasured(t.u, { timeout: 12000, maxBytes: 3 * 1024 * 1024 }).then((m) => ({ type: t.type, m }))
  );
  let cssBytes = 0;
  let jsBytes = 0;
  let cacheOk = 0;
  let cacheMeasured = 0;
  measured.forEach(({ type, m }) => {
    if (m.error) return;
    const size = m.bytesFromHeader != null ? m.bytesFromHeader : m.bytes;
    if (type === 'css') cssBytes += size; else jsBytes += size;
    cacheMeasured += 1;
    const cc = m.headers['cache-control'] || '';
    if (m.headers.expires || /max-age|s-maxage/i.test(cc)) cacheOk += 1;
  });

  onProgress({ stage: 'perf', pct: 89, detail: '性能探针：检测 HTTP/2 与图片加载策略…' });
  const http2Ok = await probeHttp2(homeUrl);

  // ---- 评分（0-100，服务器可测代理指标）----
  const ttfbScore = tier(ttfbMs, [[200, 35], [400, 30], [800, 24], [1500, 16]], ttfbMs == null ? 0 : 8);
  const htmlScore = tier(htmlBytes, [[100 * 1024, 20], [300 * 1024, 17], [600 * 1024, 14], [1024 * 1024, 10]], 6);
  const assetB = cssBytes + jsBytes;
  const assetScore = tier(assetB, [[300 * 1024, 20], [600 * 1024, 17], [1024 * 1024, 14], [2 * 1024 * 1024, 10]], assetB > 0 ? 5 : 14);
  const noDimsPct = imgTotal ? (imgNoDims / imgTotal) * 100 : 0;
  const lazyPct = imgTotal ? imgLazy / imgTotal : 0;
  let imgScore = noDimsPct <= 20 ? 10 : noDimsPct <= 50 ? 7 : 4;
  if (lazyPct >= 0.5) imgScore = Math.min(10, imgScore + 2);
  const compScore = compression === 'br' ? 5 : compression === 'gzip' ? 4 : 0;
  const cacheScore = cacheMeasured === 0 ? 3 : cacheOk / cacheMeasured >= 0.6 ? 5 : cacheOk / cacheMeasured >= 0.3 ? 3 : 1;
  const blockScore = syncHeadScripts === 0 ? 5 : syncHeadScripts <= 2 ? 3 : 0;
  const score = Math.round(ttfbScore + htmlScore + assetScore + imgScore + compScore + cacheScore + blockScore);

  return {
    score,
    grade: letter(score),
    source: 'server-probe',
    metrics: {
      ttfbMs,
      htmlBytes,
      cssCount: cssUrls.length,
      jsCount: jsUrls.length,
      cssBytes: cssBytes || null,
      jsBytes: jsBytes || null,
      totalMeasuredBytes: (htmlBytes || 0) + cssBytes + jsBytes || null,
      imgTotal,
      imgLazy,
      imgNoDims,
      noDimsPct: Math.round(noDimsPct),
      lazyPct: Math.round(lazyPct * 100),
      compression,
      http2: http2Ok,
      syncHeadScripts,
      cacheRatio: cacheMeasured ? Math.round((cacheOk / cacheMeasured) * 100) : null,
    },
    note:
      '服务器端实测加载指标（无需浏览器）。不含 LCP/CLS/TBT 等渲染期指标，完整 Core Web Vitals 建议用 PageSpeed Insights 复核',
  };
}

module.exports = { runPerfProbe };
