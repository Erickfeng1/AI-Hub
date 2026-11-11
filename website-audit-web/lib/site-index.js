'use strict';
/**
 * 收录核查（搜索引擎采样）：通过 SDK web search 的站点过滤能力，
 * 采样搜索引擎对该域名收录的 URL，结合路径模式与真实 HTTP 探测，
 * 评估"收录可见性"与"垃圾/失效收录占比"。
 * 说明：搜索 API 不返回收录总数，本模块为采样抽查而非精确收录量。
 */
const { fetchWithTimeout } = require('./seo-checks');

const QUERY_COUNT = 4;
const VERIFY_LIMIT = 8;

function junkUrl(u) {
  try {
    const p = new URL(u).pathname;
    if (p.length > 120) return true; // 超长路径，典型垃圾收录（WP 长 slug 文章可到 100+ 字符，阈值放宽避免误伤）
    if (/[a-f0-9]{16,}/i.test(p)) return true; // 长 hex 串
    const LANG_PREFIX = /^(zh|en|ja|ko|de|fr|es|pt|it|nl|pl|ru|tr|ar|vi|th|id|ms|hi|tw|cn|br)(-[_a-z]{2,4})?$/i;
    const CONTENT_SEG = /^(category|tag|tags|product|products|news|blog|articles?|about|canton-fair|latest-news-and-insights|our-strategy|what-we-do|who-we-are|supply-chain|sourcing-agent|services?|solutions?|case-stud(y|ies)|client-cases?|uncategorized)$/i;
    // 多语言站合法翻译页（/zh-CN/... 等）不计入片段堆砌；日期归档路径同样合法
    let segs = p.split('/').filter(Boolean);
    if (segs.length && LANG_PREFIX.test(segs[0])) segs = segs.slice(1);
    segs = segs.filter((sg) => !/^\d{4}(\/\d{2}){0,2}\/?$/.test(sg) && !CONTENT_SEG.test(sg));
    if (segs.length >= 10 && segs.every((sg) => sg.length <= 2)) return true; // 短段堆砌
    if (segs.length >= 4) {
      const s = segs.join('/');
      for (const g of segs) {
        if (g.length > 3 && s.split(g).length - 1 >= 4) return true; // 同一片段重复堆砌
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

function extractIndustry(homeTitle, metaDescription, brand) {
  const text = ((homeTitle || '') + ' ' + (metaDescription || '')).toLowerCase();
  const stop = new Set([
    'the', 'and', 'for', 'with', 'from', 'china', 'chinese', 'supplier', 'suppliers',
    'manufacture', 'manufacturer', 'manufacturers', 'home', 'page', 'welcome',
    'www', 'http', 'https', 'com', 'ltd', 'co', 'export', 'quality',
  ]);
  const words = (text.match(/[a-z]{4,}/g) || []).filter((w) => !stop.has(w) && !w.includes(brand));
  return words[0] || 'supplier';
}

/**
 * @param {{host:string, brand:string, homeTitle:string, metaDescription:string}} ctx
 * @param {(p:{stage:string,pct:number,detail:string})=>void} onProgress
 */
async function runSiteIndexCheck(ctx, onProgress) {
  const { host, brand } = ctx;
  const bare = host.replace(/^www\./, '');
  const industry = extractIndustry(ctx.homeTitle, ctx.metaDescription, brand);
  const queries = [brand, brand + ' ' + industry, industry + ' supplier catalog', 'a'];
  onProgress({ stage: 'siteIndex', pct: 50, detail: '收录核查：正在采样搜索引擎收录…' });

  let client;
  try {
    // 懒加载：避免服务启动期强依赖 SDK
    const { SearchClient: SC, Config: CFG } = require('coze-coding-dev-sdk');
    client = new SC(new CFG({ timeout: 30000 }));
  } catch (e) {
    return { score: null, grade: '—', sampleCount: 0, error: 'search-init-failed', note: '搜索初始化失败：' + String((e && e.message) || e) };
  }

  // 站点过滤：两种 host 形态都查（搜索引擎可能分别索引 www 与裸域）
  const siteFilters = [bare, host !== bare ? host : bare + ' AND ' + host].filter(Boolean);
  const merged = new Map(); // url -> {url,title}
  let searchErr = null;
  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    for (const sf of siteFilters) {
      if (sf.includes(' AND ')) {
        // bare 与 www 各查一次
        for (const one of sf.split(' AND ')) {
          try {
            const r = await client.advancedSearch(q, { sites: one, count: 15, needUrl: true, needSummary: false });
            ((r && r.web_items) || []).forEach((it) => {
              if (it.url && !merged.has(it.url)) merged.set(it.url, { url: it.url, title: (it.title || '').trim() });
            });
          } catch (e) {
            searchErr = e;
          }
        }
      } else {
        try {
          const r = await client.advancedSearch(q, { sites: sf, count: 15, needUrl: true, needSummary: false });
          ((r && r.web_items) || []).forEach((it) => {
            if (it.url && !merged.has(it.url)) merged.set(it.url, { url: it.url, title: (it.title || '').trim() });
          });
        } catch (e) {
          searchErr = e;
        }
      }
    }
    onProgress({ stage: 'siteIndex', pct: 50 + Math.round(((qi + 1) / queries.length) * 6), detail: `收录核查：采样 ${merged.size} 条（查询 ${qi + 1}/${queries.length}）…` });
  }

  // 剔除域外 URL：搜索接口偶发返回第三方页面（whois/聚合站等），不属于该域名收录
  const bareHost = bare;
  const offsite = [];
  const items = Array.from(merged.values()).filter((it) => {
    try {
      const hn = new URL(it.url).hostname.replace(/^www\./, '');
      if (hn === bareHost) return true;
      offsite.push(it.url);
      return false;
    } catch (e) { return false; }
  });
  if (!items.length) {
    if (searchErr) {
      return { score: null, grade: '—', sampleCount: 0, error: 'search-failed', note: '搜索接口失败，收录核查未执行：' + String((searchErr && searchErr.message) || searchErr).slice(0, 120) };
    }
    return {
      score: 30, grade: 'F', sampleCount: 0, urls: [], junkCount: 0, deadCount: 0,
      note: '搜索引擎采样未发现任何站内页面——收录可见性极差（新站、被惩罚或被 robots 屏蔽）',
    };
  }

  // ---- 真实 HTTP 探测（抽样：前 VERIFY_LIMIT 条 + 全部疑似垃圾路径，并发执行）----
  const junkArr = items.map((it) => junkUrl(it.url));
  let junkCount = junkArr.filter(Boolean).length;
  const verifySet = new Set(items.slice(0, VERIFY_LIMIT).map((it) => it.url));
  items.forEach((it, i) => { if (junkArr[i]) verifySet.add(it.url); }); // 形似垃圾的 URL 必须实测验证
  const verifyCount = Math.min(verifySet.size, VERIFY_LIMIT + 12);
  onProgress({ stage: 'siteIndex', pct: 57, detail: `收录核查：抽查 ${verifyCount}/${items.length} 条收录 URL 可达性（含全部疑似垃圾路径）…` });
  let deadCount = 0;
  let redirected = 0;
  const results = items.map((it, i) => ({ url: it.url, title: it.title, junk: junkArr[i], verified: verifySet.has(it.url) }));
  // 简易并发池（5 并发）
  const queue = results.filter((r) => r.verified);
  await Promise.all(Array.from({ length: 5 }, async () => {
    let rec;
    while ((rec = queue.shift())) {
      try {
        const r = await fetchWithTimeout(rec.url, { timeout: 10000 });
        rec.httpStatus = r.status;
        rec.finalUrl = r.url || rec.url;
        if (rec.finalUrl && rec.finalUrl !== rec.url) {
          rec.redirected = true;
          redirected++;
        }
        if (r.status !== 200) {
          rec.dead = true;
          deadCount++;
        }
      } catch (e) {
        rec.httpStatus = null;
        rec.dead = true;
        rec.error = String((e && e.message) || e).slice(0, 80);
        deadCount++;
      }
    }
  }));

  const hostCounts = {};
  const schemes = new Set();
  items.forEach((it) => {
    try {
      const u = new URL(it.url);
      hostCounts[u.hostname] = (hostCounts[u.hostname] || 0) + 1; // 保留 www 前缀，用于检测 www/裸域混收
      schemes.add(u.protocol);
    } catch (e) { /* ignore */ }
  });
  const wwwCount = hostCounts['www.' + bare] || 0;
  const bareCount = hostCounts[bare] || 0;
  const otherHostCount = items.length - wwwCount - bareCount;
  const minorityCount = items.length - Math.max(wwwCount, bareCount, otherHostCount);
  const minorityShare = items.length ? minorityCount / items.length : 0;
  const mixedHost = minorityCount > 0;
  const mixedScheme = schemes.has('http:') && schemes.has('https:');

  // ---- 评分（v18：扣分只基于实测事实与确定性结构问题；启发式"形似垃圾"仅作抽查线索，实测正常不计异常，未抽查也不代表收录不可见） ----
  const n = items.length;
  let score = n >= 20 ? 92 : n >= 12 ? 85 : n >= 5 ? 75 : 55;
  score -= deadCount * 8;
  if (mixedScheme) score -= 5;
  if (mixedHost && minorityShare >= 0.1) score -= 5; // 非主形态占比 ≥10% 才视为混收分散权重；极少量不扣分
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 50 ? 'D' : 'F';

  // 疑似垃圾路径的实测结论分类：实测正常不算异常，未抽查仅提示不扣分
  const junkResults = results.filter((r) => r.junk);
  const junkAlive = junkResults.filter((r) => r.httpStatus === 200).length;
  const junkDead = junkResults.filter((r) => r.dead).length;
  const junkUnverified = junkResults.length - junkAlive - junkDead;

  const probs = [];
  if (n < 5) probs.push(`仅采样到 ${n} 条站内收录（正常外贸站通常有几十条以上）`);
  if (deadCount) probs.push(`${deadCount} 条收录页面实测无法正常访问`);
  if (junkAlive) probs.push(`${junkAlive} 条长路径页面经实测均正常访问（路径较长但为正常页面，不计异常）`);
  if (junkUnverified) probs.push(`${junkUnverified} 条形似垃圾路径未抽查（仅供参考不扣分，可在 Search Console 复核）`);
  if (mixedScheme) probs.push('收录中 http 与 https 页面并存');
  if (mixedHost) probs.push(minorityShare >= 0.1 ? `收录中 ${Math.round(minorityShare * 100)}% 为非主域名形态（www/裸域混收分散权重，建议 301 统一）` : `存在 ${minorityCount} 条非主域名形态收录（占比 ${Math.round(minorityShare * 100)}%，极少量，不影响收录健康）`);
  if (offsite.length) probs.push(`搜索接口返回 ${offsite.length} 条第三方页面已剔除（非本域名收录）`);
  const note = probs.length ? probs.join('；') : `采样到 ${n} 条收录页面，抽查均可达，未见明显异常`;

  return {
    score, grade, sampleCount: n, queries, urls: results,
    junkCount, junkAlive, junkDead, junkUnverified, deadCount, redirected,
    wwwCount, bareCount, minorityCount, minorityShare, mixedHost, mixedScheme,
    note, industry,
  };
}

module.exports = { runSiteIndexCheck };
