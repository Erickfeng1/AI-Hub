'use strict';
/**
 * 检测核心（由 CLI 版 audit.js 改造为可编程调用）
 * runAudit(target, { onProgress }) → 完整结果 JSON，并落盘 JSON + HTML 报告
 * 性能测试：通过 --port 挂接常驻 headless Chrome（scripts/dev.sh 拉起）
 * 收录核查：lib/site-index.js（搜索引擎采样 + URL 抽查）
 * GEO/AI 问答：lib/geo-test.js（LLM 模拟买家提问检测品牌 AI 可见性）
 * 收录核查与 GEO 并行执行（互不依赖的外部 API）
 * 复测对比：写盘前读取上一次 latest-<host>.json，生成 scores/keyNumbers 维度的 comparison
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const {
  auditHtml,
  discoverPages,
  pickProductDetail,
  technicalChecks,
  fetchWithTimeout,
  toUrl,
} = require('./seo-checks');
const summarize = require('./summarize');
const { runGeoTest, inferIndustryWords } = require('./geo-test');
const { runSiteIndexCheck } = require('./site-index');
const { runPerfProbe } = require('./perf-probe');
const { checkPsi, checkCrux } = require('./psi-checks');

// 产物目录：生产容器文件系统只读（EROFS），默认落到 /tmp；本地开发仍用项目 output/
const OUT_DIR = process.env.AUDIT_OUTPUT_DIR
  || (process.env.DEPLOY_RUN_PORT ? '/tmp/website-audit-output' : path.join(__dirname, '..', 'output'));
const LH_BIN = path.join(__dirname, '..', 'node_modules', '.bin', 'lighthouse');
const CHROME_PORT = Number(process.env.AUDIT_CHROME_PORT || 9222);

function letter(s) {
  return s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 50 ? 'D' : 'F';
}
const clamp = (s) => Math.max(0, Math.min(100, Math.round(s)));

function chromeReady(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// 通过 Lighthouse CLI 挂接常驻 Chrome（绝不在 Node 进程树内启动 Chrome）
function runLhCli(url, port, timeoutMs) {
  return new Promise((resolve) => {
    const out = path.join(OUT_DIR, `tmp-lh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
    const args = [
      url,
      `--port=${port}`,
      '--output=json',
      `--output-path=${out}`,
      '--only-categories=performance,seo,accessibility,best-practices',
      '--max-wait-for-load=90000',
      '--quiet',
    ];
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        fs.unlinkSync(out);
      } catch (e) {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch (e) {
        /* ignore */
      }
      finish(null);
    }, timeoutMs);
    let p;
    try {
      p = spawn(LH_BIN, args, { stdio: 'ignore' });
    } catch (e) {
      finish(null);
      return;
    }
    p.on('error', () => finish(null));
    p.on('exit', () => {
      try {
        const lhr = JSON.parse(fs.readFileSync(out, 'utf8'));
        finish(summarize(lhr));
      } catch (e) {
        finish(null);
      }
    });
  });
}

async function auditUrl(u) {
  try {
    const r = await fetchWithTimeout(u, { timeout: 60000 });
    const html = await r.text();
    const p = auditHtml(html, u);
    p.httpStatus = r.status;
    return p;
  } catch (e) {
    return { url: u, error: String((e && e.message) || e) };
  }
}

/** 非 200 页面不算正常页面：不参与逐页评分，转为死链 issue */
function splitBrokenPages(pages) {
  const issues = [];
  const ok = [];
  for (const p of pages) {
    if (!p.error && p.httpStatus && p.httpStatus !== 200) {
      issues.push({ page: p.url, sev: p.httpStatus >= 400 ? 'HIGH' : 'MEDIUM', finding: `导航链接指向 HTTP ${p.httpStatus} 页面（死链或异常跳转）` });
    } else {
      ok.push(p);
    }
  }
  return { ok, issues };
}

function scoreOnPage(pages) {
  let score = 100;
  const issues = [];
  pages.forEach((p) => {
    if (p.error) {
      issues.push({ page: p.url, sev: 'HIGH', finding: '页面抓取失败: ' + p.error });
      return;
    }
    if (!p.title) {
      score -= 25;
      issues.push({ page: p.url, sev: 'CRITICAL', finding: '缺少 <title>' });
    } else if (p.titleLength < 15) {
      score -= 10;
      issues.push({ page: p.url, sev: 'HIGH', finding: `title 过短（${p.titleLength} 字符）` });
    }
    if (!p.metaDescription) {
      score -= 15;
      issues.push({ page: p.url, sev: 'CRITICAL', finding: '缺少 meta description' });
    }
    if (p.h1Count === 0) {
      score -= 20;
      issues.push({ page: p.url, sev: 'CRITICAL', finding: '页面没有 H1 标题' });
    }
    if (p.images > 0) {
      const pct = Math.round((p.imagesNoAlt / p.images) * 100);
      if (pct > 50) {
        score -= 10;
        issues.push({ page: p.url, sev: 'HIGH', finding: `${pct}% 的图片没有 alt 文本` });
      }
    }
  });
  score = clamp(score);
  return { score, grade: letter(score), issues };
}

function scoreTechnical(tech, pages) {
  let score = 100;
  const issues = [];
  if (!tech.robots || !tech.robots.exists) {
    score -= 20;
    issues.push({ sev: 'CRITICAL', finding: '缺少 robots.txt' });
  }
  if (!tech.sitemap || !tech.sitemap.exists) {
    score -= 15;
    issues.push({ sev: 'CRITICAL', finding: '缺少 sitemap.xml' });
  }
  if (tech.soft404 && tech.soft404.testUrlStatus === 200) {
    score -= 25;
    issues.push({ sev: 'CRITICAL', finding: '任意未知 URL 返回 200（软 404），垃圾页面可被 Google 收录' });
  }
  const ok = pages.filter((p) => !p.error);
  const noCanon = ok.filter((p) => !p.canonical).length;
  if (noCanon) {
    score -= Math.min(20, noCanon * 5);
    issues.push({ sev: 'HIGH', finding: `${noCanon}/${ok.length} 个页面缺少 canonical 标签` });
  }
  if (tech.httpRedirect && tech.httpRedirect.finalProtocol !== 'https:') {
    score -= 10;
    issues.push({ sev: 'HIGH', finding: 'HTTP 访问未强制跳转 HTTPS' });
  }
  if (tech.securityHeaders) {
    const missing = Object.keys(tech.securityHeaders).filter((k) => !tech.securityHeaders[k].present);
    if (missing) {
      score -= Math.min(15, missing.length * 4);
      issues.push({ sev: 'MEDIUM', finding: '缺少安全响应头：' + missing.join(', ') });
    }
  }
  if (tech.apexWww && tech.apexWww.finalUrl) {
    try {
      if (new URL(tech.apexWww.finalUrl).hostname !== tech.canonicalHost) {
        score -= 10;
        issues.push({ sev: 'MEDIUM', finding: 'www 与裸域同时可访问，未统一到规范主机' });
      }
    } catch (e) {
      /* ignore */
    }
  }
  score = clamp(score);
  return { score, grade: letter(score), issues };
}

// ---- 复测对比：读取上一次结果并构建各维度 delta ----
function dim(prevObj, currObj) {
  const prev = prevObj && prevObj.score != null ? prevObj.score : null;
  const curr = currObj && currObj.score != null ? currObj.score : null;
  return { prev, curr, delta: prev != null && curr != null ? curr - prev : null };
}

function buildComparison(previous, result, okPagesCount) {
  if (!previous) return null;
  const ps = previous.scores || {};
  const cs = result.scores;
  const scoreDims = {};
  Object.keys(cs).forEach((k) => {
    scoreDims[k] = dim(ps[k], cs[k]);
  });
  const pk = previous.keyNumbers || {};
  const ck = result.keyNumbers;
  const buyerHitsPrev = Object.values(pk.buyerWordCounts || {}).filter((c) => c > 0).length;
  const buyerHitsCurr = Object.values(ck.buyerWordCounts || {}).filter((c) => c > 0).length;
  return {
    previousTestedAt: previous.testedAt || null,
    currentTestedAt: result.testedAt,
    scores: scoreDims,
    keyNumbers: {
      homepageTransferBytes: { prev: pk.homepageTransferBytes != null ? pk.homepageTransferBytes : null, curr: ck.homepageTransferBytes != null ? ck.homepageTransferBytes : null, lowerIsBetter: true },
      lcpHomepageMobileS: { prev: pk.lcpHomepageMobileS != null ? pk.lcpHomepageMobileS : null, curr: ck.lcpHomepageMobileS != null ? ck.lcpHomepageMobileS : null, lowerIsBetter: true },
      imagesNoAltPct: { prev: pk.imagesNoAltPct != null ? pk.imagesNoAltPct : null, curr: ck.imagesNoAltPct != null ? ck.imagesNoAltPct : null, lowerIsBetter: true },
      buyerWordHits: { prev: buyerHitsPrev, curr: buyerHitsCurr, lowerIsBetter: false },
      aiMentionHits: { prev: pk.aiMentionHits || null, curr: ck.aiMentionHits || null, lowerIsBetter: false },
      indexSampleCount: { prev: pk.indexSampleCount != null ? pk.indexSampleCount : null, curr: ck.indexSampleCount != null ? ck.indexSampleCount : null, lowerIsBetter: false },
      pageCount: { prev: (previous.pages || []).length, curr: okPagesCount, lowerIsBetter: false },
    },
  };
}

async function runAudit(target, { onProgress = () => {}, previous: callerPrevious = null, psi: psiCfg = null } = {}) {
  const base = toUrl(target);
  const host = base.hostname;

  // 复测对比数据源：优先用调用方（浏览器本地保存）带来的上次结果，其次读磁盘存档
  let previous = null;
  if (callerPrevious && callerPrevious.scores && callerPrevious.testedAt) {
    previous = callerPrevious;
  } else {
    try {
      const prevPath = path.join(OUT_DIR, `latest-${host}.json`);
      if (fs.existsSync(prevPath)) {
        const p = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
        if (p && p.scores && p.testedAt) previous = p;
      }
    } catch (e) {
      /* 无历史或解析失败 → 视为首次检测 */
    }
  }

  onProgress({ stage: 'crawl', pct: 5, detail: '抓取首页并解析 SEO…' });
  const homeRes = await fetchWithTimeout(base.toString(), { timeout: 60000 });
  const homeHtml = await homeRes.text();
  const home = auditHtml(homeHtml, base.toString());
  home.httpStatus = homeRes.status;

  const hh = homeRes.headers;
  const securityHeaders = {
    'Strict-Transport-Security': { present: !!hh.get('strict-transport-security') },
    'Content-Security-Policy': { present: !!hh.get('content-security-policy') },
    'X-Frame-Options': { present: !!hh.get('x-frame-options') },
    'X-Content-Type-Options': { present: !!hh.get('x-content-type-options') },
  };
  const serverInfo = {
    server: hh.get('server') || null,
    aspNetVersion: hh.get('x-aspnet-version') || null,
    poweredBy: hh.get('x-powered-by') || null,
  };

  let pages = [home];
  const links = discoverPages(homeHtml, base.toString());
  if (links.productList) {
    onProgress({ stage: 'crawl', pct: 15, detail: '抓取产品列表页…' });
    const list = await auditUrl(links.productList);
    pages.push(list);
    if (!list.error) {
      const detail = pickProductDetail(list.rawHtml, links.productList, base.toString());
      if (detail) {
        onProgress({ stage: 'crawl', pct: 25, detail: '抓取产品详情页…' });
        pages.push(await auditUrl(detail));
      } else {
        list.productLinksVisible = 0;
      }
    }
  }
  if (links.about) {
    onProgress({ stage: 'crawl', pct: 32, detail: '抓取关于页…' });
    pages.push(await auditUrl(links.about));
  }
  if (links.contact) {
    onProgress({ stage: 'crawl', pct: 38, detail: '抓取联系页…' });
    pages.push(await auditUrl(links.contact));
  }
  const crawlSplit = splitBrokenPages(pages);
  const crawlIssues = crawlSplit.issues;
  pages = crawlSplit.ok;
  onProgress({ stage: 'crawl', pct: 40, detail: `已抓取 ${pages.length} 个有效页面${crawlIssues.length ? `，另有 ${crawlIssues.length} 个死链` : ''}` });

  onProgress({ stage: 'tech', pct: 44, detail: 'robots / sitemap / 软 404 / 安全头检查…' });
  const tech = await technicalChecks(base);
  tech.securityHeaders = securityHeaders;
  tech.serverInfo = serverInfo;
  tech.canonicalHost = host;

  // ---- 收录核查 + GEO/AI 问答（并行，均为外部 API 调用）----
  const brand = host.replace(/^www\./, '').split('.')[0];
  onProgress({ stage: 'siteIndex', pct: 50, detail: '收录核查：启动搜索引擎采样…' });
  onProgress({ stage: 'geo', pct: 52, detail: 'GEO/AI 问答：模拟买家提问…' });
  // 外层超时兜底：SDK 加载或外部 API 异常阻塞时降级，保证检测总能出结果
  const raceTimeout = (promise, ms, fallback) => {
    let t;
    const timeoutP = new Promise((resolve) => { t = setTimeout(() => resolve(fallback), ms); });
    if (t && t.unref) t.unref();
    return Promise.race([promise, timeoutP]);
  };
  const [geo, siteIndex] = await Promise.all([
    raceTimeout(
      runGeoTest(homeHtml, { brand, domain: host }, onProgress).catch((e) => ({
        score: null, grade: '—', total: 0, hits: 0, error: 'geo-exception',
        note: 'GEO 测试异常：' + String((e && e.message) || e),
      })),
      150000,
      { score: null, grade: '—', total: 0, hits: 0, error: 'geo-timeout', note: 'GEO 测试超时，已跳过' }
    ),
    raceTimeout(
      runSiteIndexCheck(
        { host, brand, homeTitle: home.title || '', metaDescription: home.metaDescription || '' },
        onProgress
      ).catch((e) => ({
        score: null, grade: '—', sampleCount: 0, error: 'site-index-exception',
        note: '收录核查异常：' + String((e && e.message) || e),
      })),
      120000,
      { score: null, grade: '—', sampleCount: 0, error: 'site-index-timeout', note: '收录核查超时，已跳过' }
    ),
  ]);
  onProgress({ stage: 'siteIndex', pct: 60, detail: '收录核查完成' });
  onProgress({ stage: 'geo', pct: 74, detail: 'GEO/AI 问答完成' });

  let lh = null;
  let lhErr = null;
  let lhDetail = null;
  let lhDetailErr = null;
  let probe = null;
  onProgress({ stage: 'perf', pct: 80, detail: '检查性能测试环境…' });
  // PSI API（Google Lighthouse 云端实测）与本地性能检测并行；未配置反代时为 null
  let psiPromise = null;
  let psiDeskPromise = null;
  if (psiCfg && psiCfg.base) {
    onProgress({ stage: 'perf', pct: 81, detail: 'PSI 检测已启动（移动端+桌面端并行执行）…' });
    // 偶发网络抖动（如 fetch failed）自动重试一次，避免整个性能维度缺失
    const psiRetry = async (cfg) => {
      let last = null;
      // 最多 3 次尝试，失败后等 10 秒再试：跨过短时网络抖动窗口（立即重试会落在同一故障窗口内）
      // 成功但缺 CrUX（Google 端偶发不返回 loadingExperience）同样重试：真实用户数据是核心产出
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((res) => setTimeout(res, 10000));
        last = await checkPsi(base.toString(), cfg, onProgress).catch((e) => ({ ok: false, error: 'psi-exception: ' + String((e && e.message) || e) }));
        if (last.ok && last.crux) return last;
      }
      return last;
    };
    psiPromise = psiRetry(psiCfg);
    // 桌面端查询错峰 5 秒启动：同一域名瞬时并发建立连接会被对端重置（fetch failed），实测错峰后稳定成功；总耗时几乎不变
    psiDeskPromise = new Promise((res) => setTimeout(res, 5000)).then(() => psiRetry(Object.assign({}, psiCfg, { strategy: 'desktop', timeoutMs: 180000 })));
  }
  const chromeOk = await chromeReady(CHROME_PORT);
  if (!chromeOk) {
    lhErr = 'chrome-not-available';
    // 无浏览器环境 → 服务器端性能探针（TTFB / 页面重量 / 资源体积等真实测量）
    onProgress({ stage: 'perf', pct: 82, detail: '无 Chrome，启动服务器端性能探针…' });
    probe = await runPerfProbe(base.toString(), homeHtml, onProgress);
    onProgress({ stage: 'perf', pct: 92, detail: probe && probe.score != null ? '性能探针完成' : '性能探针失败，性能项未测' });
  } else {
    onProgress({ stage: 'perf', pct: 82, detail: 'Lighthouse 移动端测试：首页（约 1-3 分钟）…' });
    lh = await runLhCli(base.toString(), CHROME_PORT, 180000);
    if (!lh) {
      lhErr = 'lighthouse-run-failed';
      // Lighthouse 失败时同样降级到探针
      onProgress({ stage: 'perf', pct: 86, detail: 'Lighthouse 失败，降级到服务器端性能探针…' });
      probe = await runPerfProbe(base.toString(), homeHtml, onProgress).catch(() => null);
    }
    const detailPage = pages.find(
      (p) => !p.error && p.url !== base.toString() && /product/i.test(p.url || '')
    );
    if (lh && detailPage) {
      onProgress({ stage: 'perf', pct: 88, detail: 'Lighthouse 移动端测试：产品页…' });
      lhDetail = await runLhCli(detailPage.url, CHROME_PORT, 150000);
      if (!lhDetail) lhDetailErr = 'lighthouse-run-failed';
    }
    onProgress({ stage: 'perf', pct: 92, detail: '性能测试完成' });
  }

  const psi = psiPromise ? await psiPromise : null;
  const psiDesk = psiDeskPromise ? await psiDeskPromise : null;
  // 桌面端真实用户数据：直接取自并行桌面 PSI 查询的 loadingExperience
  if (psi && psiDesk && psiDesk.ok && psiDesk.crux) psi.cruxDesk = psiDesk.crux;
  // 移动端 CrUX 回退：移动端无样本时，先试 CrUX API（快），再复用并行桌面查询结果
  if (psi && psi.ok && !psi.crux && psiCfg && psiCfg.base) {
    const cruxRes = await checkCrux(base.toString(), psiCfg).catch(() => ({ ok: false, error: 'crux-exception', apiDown: true }));
    if (cruxRes && cruxRes.ok) {
      psi.crux = cruxRes.crux;
      if (!psi.cruxDesk) psi.cruxDesk = cruxRes.crux;
    } else if (psiDesk && psiDesk.ok && psiDesk.crux) {
      psi.crux = psiDesk.crux;
    } else {
      const detail = cruxRes && cruxRes.error ? String(cruxRes.error).slice(0, 80) : 'CrUX 查询未成功';
      psi.cruxError = `PSI 本次未返回真实用户数据（Google 端偶发波动，建议重测）；CrUX 独立接口兜底也未成功（${detail}）`;
    }
  }
  if (psi && psi.ok && !psi.cruxDesk && !psi.cruxError) {
    psi.cruxDeskError = psiDesk && psiDesk.ok ? '桌面端无 CrUX 真实用户样本' : '桌面端查询未成功';
  }
  // PSI 查询完全失败时的 CrUX 独立兜底：真实用户数据不与 PSI 查询成败绑定（PSI 网络抖动时 CrUX 仍可经接口直查获得）
  if (psi && !psi.ok && !psi.crux && psiCfg && psiCfg.base) {
    const cruxRes = await checkCrux(base.toString(), psiCfg).catch(() => ({ ok: false, error: 'crux-exception' }));
    if (cruxRes && cruxRes.ok && cruxRes.crux) {
      psi.crux = cruxRes.crux;
    } else {
      const detail = cruxRes && cruxRes.error ? String(cruxRes.error).slice(0, 80) : 'CrUX 查询未成功';
      psi.cruxError = `CrUX 独立接口兜底未成功（${detail}），且 PSI 查询未完成`;
    }
  }
  if (psi && !psi.ok && psi.error) {
    onProgress({ stage: 'perf', pct: 93, detail: `PSI 实测未完成：${String(psi.error).slice(0, 60)}` });
  }

  onProgress({ stage: 'report', pct: 94, detail: '评分与汇总…' });
  const okPages = pages.filter((p) => !p.error);
  const onPage = scoreOnPage(okPages);
  onPage.issues.unshift(...crawlIssues);
  const lhPerf = lh && lh.scores ? lh.scores.performance : null;
  // 性能维度评分优先采用 CrUX 真实用户综合分（Google 搜索排名口径）；无样本时降级 lab 模拟分，再降级探针
  const cruxPerf = psi && psi.crux && psi.crux.score != null
    ? { score: psi.crux.score, grade: psi.crux.grade || letter(psi.crux.score) }
    : psi && psi.cruxDesk && psi.cruxDesk.score != null
    ? { score: psi.cruxDesk.score, grade: psi.cruxDesk.grade || letter(psi.cruxDesk.score) }
    : null;
  const performance = cruxPerf
    ? {
        score: cruxPerf.score,
        grade: cruxPerf.grade,
        source: 'crux-field-data',
        note: 'Google CrUX 真实用户数据综合分（过去 28 天真实访客，LCP / INP / CLS 三项按阈值插值取平均；Google 搜索排名采用的口径）',
      }
    : lhPerf !== null
    ? {
        score: lhPerf,
        grade: letter(lhPerf),
        source: 'lighthouse-mobile-homepage',
        lcpS: lh.metrics.lcpS,
        runtimeError: lh.runtimeError,
      }
    : psi && psi.ok && psi.score != null
    ? {
        score: psi.score,
        grade: psi.grade,
        source: 'psi-api',
        note: 'Google PageSpeed Insights API 实测（Lighthouse 移动端，Google 服务器执行）',
      }
    : probe && probe.score != null
    ? {
        score: probe.score,
        grade: probe.grade,
        source: 'server-probe',
        note: probe.note,
      }
    : {
        score: null,
        grade: 'F',
        source: 'lighthouse-skipped',
        error: lhErr,
        note: '本次未运行 Lighthouse（常驻 Chrome 不可用），性能项未测',
      };

  const allJsonLd = okPages.flatMap((p) => p.jsonLdTypes || []).filter((t) => t && t !== '__invalid__');
  const structured = allJsonLd.length
    ? { score: 80, grade: 'B', types: allJsonLd }
    : { score: 0, grade: 'F', types: [] };

  const hasHreflang = okPages.some((p) => (p.hreflang || []).length > 0);
  const multilingual = hasHreflang
    ? { score: 90, grade: 'A' }
    : {
        score: 55,
        grade: 'D',
        note: '未检测到 hreflang；若语言切换仅由 JS 实现，搜索引擎和 AI 无法发现多语言版本',
      };

  const hasViewport = okPages.length > 0 && okPages.every((p) => p.viewport);
  const mobile = hasViewport
    ? { score: 85, grade: 'B', note: '存在 viewport，基础移动适配可用；具体体验见 Lighthouse 结果' }
    : { score: 40, grade: 'F', note: '缺少 viewport meta 标签' };

  const technical = scoreTechnical(tech, okPages);

  // 买家词表完全由 AI 动态生成；识别失败时词表为空，报告按降级文案展示
  const buyerWordsAgg = {};
  let industryInfo = null;
  try {
    const homePage = okPages.find((p) => p.rawHtml);
    if (homePage) {
      const ch = require('cheerio');
      const $h = ch.load(homePage.rawHtml);
      $h('script,style,noscript').remove();
      const ctxHome = {
        title: homePage.title || '',
        keywords: '',
        desc: homePage.metaDescription || '',
        bodyText: $h('body').text().replace(/\s+/g, ' ').trim().slice(0, 600),
      };
      onProgress({ stage: 'geo', pct: 52, detail: 'AI 正在根据网站内容识别行业买家词…' });
      industryInfo = await inferIndustryWords(ctxHome);
      if (industryInfo && Array.isArray(industryInfo.words) && industryInfo.words.length) {
        // 行业词统计：对每个已抓页面正文重新计数（页面级 buyerWordCounts 只含通用词表）
        const pageTexts = okPages
          .filter((p) => p.rawHtml)
          .map((p) => {
            const $p = ch.load(p.rawHtml);
            $p('script,style,noscript').remove();
            return $p('body').text().replace(/\s+/g, ' ').toLowerCase();
          });
        industryInfo.words.forEach((w) => {
          if (w in buyerWordsAgg) return;
          let c = 0;
          pageTexts.forEach((t) => { c += t.split(w).length - 1; });
          buyerWordsAgg[w] = c;
        });
      }
    }
  } catch (e) {
    industryInfo = null;
  }

  const result = {
    target: base.toString(),
    testedAt: new Date().toISOString(),
    testLocation: 'local-machine',
    techStack: tech.serverInfo,
    pages: okPages.map((p) => {
      const c = Object.assign({}, p);
      delete c.rawHtml;
      return c;
    }),
    failedPages: pages.filter((p) => p.error),
    navigation: links,
    technical: tech,
    lighthouse: {
      homepageMobile: lh,
      productPageMobile: lhDetail,
      homepageError: lhErr,
      productPageError: lhDetailErr,
    },
    perfProbe: probe,
    psi,
    geoTest: geo,
    siteIndexCheck: siteIndex,
    scores: { onPageSeo: onPage, technicalSeo: technical, siteIndex, structuredData: structured, performance, mobile, multilingual, geo },
    keyNumbers: {
      homepageHtmlBytes: home.htmlBytes,
      homepageTransferBytes: lh && lh.metrics ? lh.metrics.totalBytes : probe && probe.metrics ? probe.metrics.totalMeasuredBytes : null,
      lcpHomepageMobileS: lh && lh.metrics ? lh.metrics.lcpS : null,
      psiScore: psi && psi.ok ? psi.score : null,
      psiLcpMs: psi && psi.ok && psi.metrics ? psi.metrics.lcpMs : null,
      psiCls: psi && psi.ok && psi.metrics ? psi.metrics.cls : null,
      lcpProductMobileS: lhDetail && lhDetail.metrics ? lhDetail.metrics.lcpS : null,
      imagesNoAltPct: home.images ? Math.round((home.imagesNoAlt / home.images) * 100) : null,
      buyerWordCounts: buyerWordsAgg,
      buyerWordsIndustry: industryInfo ? industryInfo.industry : null,
      aiMentionHits: geo && geo.total ? `${geo.hits}/${geo.total}` : null,
      indexSampleCount: siteIndex && siteIndex.sampleCount != null ? siteIndex.sampleCount : null,
    },
    manualChecksPending: [],
  };

  result.comparison = buildComparison(previous, result, okPages.length);

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

  // 磁盘存档为可选增强：生产容器文件系统只读（EROFS），写失败时降级，不影响检测本身
  let savedToDisk = false;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, `${host}-${stamp}.json`), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, `latest-${host}.json`), JSON.stringify(result, null, 2));
    savedToDisk = true;
  } catch (e) {
    console.warn(`[audit] skip disk archive: ${e.message}`);
  }

  onProgress({ stage: 'report', pct: 98, detail: '生成 HTML 报告…' });
  const { generateReportHtml } = require('./report-gen');
  const html = generateReportHtml(result, host);
  if (savedToDisk) {
    try {
      fs.writeFileSync(path.join(OUT_DIR, `${host}-report.html`), html);
    } catch (e) {
      console.warn(`[audit] skip report file: ${e.message}`);
    }
  }

  onProgress({ stage: 'report', pct: 100, detail: '完成' });

  return {
    host,
    target: base.toString(),
    testedAt: result.testedAt,
    scores: result.scores,
    keyNumbers: result.keyNumbers,
    comparison: result.comparison,
    buyerWordHits: Object.values(result.keyNumbers.buyerWordCounts).filter((c) => c > 0).length,
    pageCount: okPages.length,
    pages: okPages.map((p) => ({ url: p.url })),
    reportHtml: html, // 由 server 缓存，经 /api/report/<taskId> 提供
    savedToDisk,
    jsonFile: savedToDisk ? path.join(OUT_DIR, `latest-${host}.json`) : null,
  };
}

module.exports = { runAudit, chromeReady, OUT_DIR };
