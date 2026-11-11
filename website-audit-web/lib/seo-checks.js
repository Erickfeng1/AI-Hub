'use strict';
/**
 * 页面 SEO 与技术性 SEO 检查（基于 fetch + cheerio）
 */
const cheerio = require('cheerio');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = 30000;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT);
  try {
    return await fetch(url, {
      redirect: opts.redirect || 'follow',
      headers: Object.assign(
        { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        opts.headers || {}
      ),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function toUrl(input) {
  return new URL(input.startsWith('http') ? input : 'https://' + input);
}

/** 解析单个页面 HTML，输出 SEO 相关字段 */
function auditHtml(html, url) {
  const $ = cheerio.load(html);
  const title = ($('title').first().text() || '').trim();
  const metaDescription = ($('meta[name="description"]').attr('content') || '').trim();
  const h1Count = $('h1').length;
  const h1Texts = $('h1')
    .map((i, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  const canonical = $('link[rel="canonical"]').attr('href') || null;
  const viewport = $('meta[name="viewport"]').attr('content') || null;
  const lang = $('html').attr('lang') || null;
  const hreflang = $('link[rel="alternate"][hreflang]')
    .map((i, el) => $(el).attr('hreflang'))
    .get();
  const images = $('img').length;
  const imagesNoAlt = $('img')
    .filter((i, el) => {
      const a = $(el).attr('alt');
      return a === undefined || String(a).trim() === '';
    })
    .length;
  const jsonLdTypes = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const items = Array.isArray(data) ? data : [data];
      items.forEach((d) => {
        if (!d || typeof d !== 'object') return;
        if (d['@type']) jsonLdTypes.push(d['@type']);
        if (Array.isArray(d['@graph'])) {
          d['@graph'].forEach((g) => {
            if (g && typeof g === 'object' && g['@type']) jsonLdTypes.push(g['@type']);
          });
        }
      });
    } catch (e) {
      jsonLdTypes.push('__invalid__');
    }
  });
  const bodyText = $('body').text().replace(/\s+/g, ' ').toLowerCase();
  // v16：买家词统计全部改由 AI 动态行业词承担（见 geo-test.js inferIndustryWords），页面级不再固定计数
  const buyerWordCounts = {};
  return {
    url,
    title,
    titleLength: title.length,
    metaDescription,
    metaDescriptionLength: metaDescription.length,
    h1Count,
    h1Texts,
    canonical,
    viewport,
    lang,
    hreflang,
    images,
    imagesNoAlt,
    jsonLdTypes,
    buyerWordCounts,
    htmlBytes: Buffer.byteLength(html),
    rawHtml: html,
  };
}

/** 从首页导航中发现产品/关于/联系页链接 */
function discoverPages(html, baseUrl) {
  const $ = cheerio.load(html);
  const found = { productList: null, about: null, contact: null };
  const base = new URL(baseUrl);
  $('a[href]').each((i, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    let abs;
    try {
      abs = new URL(href, base).toString();
    } catch (e) {
      return;
    }
    const u = new URL(abs);
    if (u.hostname !== base.hostname) return;
    if (/\.(pdf|jpg|jpeg|png|gif|zip|doc|docx)$/i.test(u.pathname)) return;
    const lower = abs.toLowerCase();
    if (!found.productList && /product|goods/i.test(lower)) found.productList = abs;
    if (!found.about && /about/i.test(lower)) found.about = abs;
    if (!found.contact && /contact/i.test(lower)) found.contact = abs;
  });
  return found;
}

/** 从产品列表页里挑一个产品详情页（若 HTML 中可见） */
function pickProductDetail(listHtml, listUrl, baseUrl) {
  const $ = cheerio.load(listHtml);
  const base = new URL(baseUrl);
  const listPath = new URL(listUrl).pathname.replace(/\/+$/, '');
  const candidates = [];
  $('a[href]').each((i, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    let abs;
    try {
      abs = new URL(href, listUrl).toString();
    } catch (e) {
      return;
    }
    const u = new URL(abs);
    if (u.hostname !== base.hostname) return;
    if (abs === listUrl) return;
    if (abs.replace(/\/+$/, '') === listPath) return;
    const p = u.pathname.replace(/\/+$/, '');
    if (/product/i.test(p) && p.split('/').filter(Boolean).length > listPath.split('/').filter(Boolean).length) {
      candidates.push(abs);
    } else if (u.search && /product|id|code/i.test(abs.toLowerCase())) {
      candidates.push(abs);
    }
  });
  return candidates.length ? candidates[0] : null;
}

/** 技术性检查：robots / sitemap / 软404 / HTTP跳转 / www规范化 */
async function technicalChecks(base) {
  const origin = base.origin;
  const out = {};

  try {
    const r = await fetchWithTimeout(origin + '/robots.txt');
    const txt = r.status === 200 ? await r.text() : '';
    out.robots = {
      status: r.status,
      exists: r.status === 200 && /user-agent|sitemap|disallow/i.test(txt),
      hasSitemapDirective: /sitemap:/i.test(txt),
      looksLikeHtmlErrorPage: /<!doctype html|<html/i.test(txt.slice(0, 500)),
      bytes: txt.length,
    };
  } catch (e) {
    out.robots = { error: String((e && e.message) || e) };
  }

  try {
    const r = await fetchWithTimeout(origin + '/sitemap.xml');
    const txt = r.status === 200 ? await r.text() : '';
    out.sitemap = {
      status: r.status,
      exists: r.status === 200 && /<urlset|<sitemapindex/i.test(txt),
      locCount: (txt.match(/<loc>/gi) || []).length,
    };
  } catch (e) {
    out.sitemap = { error: String((e && e.message) || e) };
  }

  try {
    const r = await fetchWithTimeout(origin + '/__audit_nonexist_' + Date.now() + '.html');
    out.soft404 = { testUrlStatus: r.status, returnsReal404: r.status === 404 };
  } catch (e) {
    out.soft404 = { error: String((e && e.message) || e) };
  }

  try {
    const r = await fetchWithTimeout('http://' + base.hostname + '/', { timeout: 20000 });
    out.httpRedirect = { finalProtocol: new URL(r.url).protocol, status: r.status };
  } catch (e) {
    out.httpRedirect = { error: String((e && e.message) || e) };
  }

  const host = base.hostname;
  const isWww = host.startsWith('www.');
  const other = isWww ? 'https://' + host.slice(4) + '/' : 'https://www.' + host + '/';
  try {
    const r = await fetchWithTimeout(other, { timeout: 20000 });
    out.apexWww = { tested: other, finalUrl: r.url };
  } catch (e) {
    out.apexWww = { tested: other, error: String((e && e.message) || e) };
  }

  return out;
}

module.exports = {
  fetchWithTimeout,
  toUrl,
  auditHtml,
  discoverPages,
  pickProductDetail,
  technicalChecks,
};
