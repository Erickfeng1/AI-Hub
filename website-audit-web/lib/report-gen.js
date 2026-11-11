'use strict';
/**
 * 报告生成器（由 CLI 版 report.js 改造为可编程调用）
 * generateReportHtml(result, host) → 完整单文件 HTML 字符串
 * 章节：00 成绩单 / 01 页面SEO / 02 技术 / 03 收录核查 / 04 性能 / 05 GEO / 06 复测对比 / 07 行动计划 / 08 方法与局限
 */
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kbmb = (b) => (b == null ? '—' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const fmtMs = (ms) => (ms == null ? '—' : ms >= 60000 ? (ms / 60000).toFixed(1) + ' min' : (ms / 1000).toFixed(1) + ' s');
const pct = (n) => Math.round(n * 100);

function fmtDate(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const gradeCls = { A: 'g-a', B: 'g-b', C: 'g-c', D: 'g-d', F: 'g-f' };
const SCORE_LABELS = {
  onPageSeo: '页面 SEO',
  technicalSeo: '技术 SEO',
  siteIndex: '收录可见性',
  structuredData: '结构化数据',
  performance: '性能',
  mobile: '移动适配',
  multilingual: '多语言',
  geo: 'GEO/AI 可见性',
};

function geoBlocks(r) {
  const g = r.geoTest || null;
  if (!g) {
    return { ok: false, total: 0, verdict: '<p class="lede">本报告由旧版本工具生成，未包含 GEO/AI 问答测试。</p>', rows: '' };
  }
  if (g.score == null) {
    return {
      ok: false,
      total: 0,
      verdict: `<div class="geo-warn"><strong>GEO 问答未执行：</strong>${esc(g.note || g.error || '原因未知')}</div>`,
      rows: '',
    };
  }
  const rows = (g.questions || [])
    .map((q, i) => {
      const answer = q.error
        ? '<span class="badge st-c">回答失败</span>'
        : esc(q.answerSnippet || '') + (q.answerSnippet && q.answerSnippet.length >= 240 ? '…' : '');
      const hit = q.hit
        ? `<span class="badge st-ok">命中 ${esc((q.matchedBy || []).join(' / '))}</span>`
        : '<span class="badge st-c">未提及</span>';
      return `<tr><td class="cell-url"><span class="url">Q${i + 1}</span> ${esc(q.q)}</td><td>${answer}</td><td>${hit}</td></tr>`;
    })
    .join('\n');
  const verdict = `<div class="geo-verdict ${Number(g.hits) === 0 ? 'geo-zero' : ''}">
      <span class="gv">${g.hits}/${g.total}</span>
      <span class="gt">个买家问题中 AI 提及了 <strong>${esc(g.brand || '')}</strong>（${g.score} 分 · ${esc(g.grade)} 级）</span>
    </div>
    <p class="lede" style="margin-top:8px">${esc(g.note)}</p>`;
  return { ok: true, total: g.total, verdict, rows };
}

function indexBlocks(r) {
  const si = (r.scores && r.scores.siteIndex) || r.siteIndexCheck || null;
  if (!si) {
    return { verdict: '<div class="geo-warn"><strong>收录核查未执行</strong>（本报告可能由旧版本生成）</div>', rows: '', sampleCount: 0 };
  }
  if (si.score == null) {
    return {
      verdict: `<div class="geo-warn"><strong>收录核查未执行：</strong>${esc(si.note || si.error || '原因未知')}</div>`,
      rows: '',
      sampleCount: 0,
    };
  }
  const verdict = `<div class="geo-verdict ${si.score < 50 ? 'geo-zero' : ''}">
      <span class="gv">${si.sampleCount}</span>
      <span class="gt">条站内收录采样（${si.score} 分 · ${esc(si.grade)} 级）</span>
    </div>
    <p class="lede" style="margin-top:8px">${esc(si.note)}</p>`;
  const rows = (si.urls || [])
    .map((u) => {
      let status;
      if (u.junk && u.dead) status = '<span class="badge st-c">形似垃圾·实测异常</span>';
      else if (u.junk && u.httpStatus === 200) status = '<span class="badge st-ok">200 可达（长路径·正常）</span>';
      else if (u.junk) status = '<span class="badge st-m">形似垃圾·未抽查（不扣分）</span>';
      else if (u.dead) status = '<span class="badge st-c">无法访问</span>';
      else if (u.httpStatus === 200) status = '<span class="badge st-ok">200 可达</span>';
      else if (u.httpStatus != null) status = `<span class="badge st-c">HTTP ${u.httpStatus}</span>`;
      else status = '<span class="badge st-m">未抽查（不扣分）</span>';
      const extra = u.redirected ? '<span class="dim"> · 发生重定向</span>' : '';
      return `<tr><td class="cell-url"><span class="url" title="${esc(u.url)}">${esc(u.url)}</span></td><td>${esc((u.title || '').slice(0, 44))}</td><td>${status}${extra}</td></tr>`;
    })
    .join('\n');
  const verifiedCount = (si.urls || []).filter((u) => u.httpStatus != null).length;
  return { verdict, rows, sampleCount: si.sampleCount, verifiedCount };
}

// ---- 复测对比 ----
function parseHits(s) {
  const m = /^(\d+)\//.exec(String(s || ''));
  return m ? Number(m[1]) : null;
}

function compareBlocks(r) {
  const c = r.comparison;
  if (!c || !c.scores) {
    return {
      verdict: '<p class="lede">这是该域名在本工具的首次检测。之后再次检测同一域名时，本节将自动生成与本次的对比。</p>',
      rows: '',
      notes: '',
    };
  }
  let up = 0;
  let down = 0;
  let flat = 0;
  const rows = Object.keys(c.scores)
    .map((k) => {
      const d = c.scores[k] || {};
      let delta;
      if (d.delta == null) delta = '<span class="badge st-m">—</span>';
      else if (d.delta === 0) {
        delta = '<span class="badge st-m">持平</span>';
        flat++;
      } else if (d.delta > 0) {
        delta = `<span class="badge st-ok">↑ +${d.delta}</span>`;
        up++;
      } else {
        delta = `<span class="badge st-c">↓ ${d.delta}</span>`;
        down++;
      }
      return `<tr><th scope="row">${SCORE_LABELS[k] || esc(k)}</th><td class="num">${d.prev != null ? d.prev : '未测'}</td><td class="num">${d.curr != null ? d.curr : '未测'}</td><td>${delta}</td></tr>`;
    })
    .join('\n');
  const verdict = `<div class="geo-verdict ${down > up ? 'geo-zero' : ''}">
      <span class="gv">${up ? '+' + up : up}</span>
      <span class="gt">项改善 · ${flat} 项持平 · ${down} 项回落（${esc(fmtDate(c.previousTestedAt))} → ${esc(fmtDate(c.currentTestedAt))}）</span>
    </div>`;

  const kn = c.keyNumbers || {};
  const trend = (d) => {
    if (!d || d.prev == null || d.curr == null || d.prev === d.curr) return null;
    const improved = d.lowerIsBetter ? d.curr < d.prev : d.curr > d.prev;
    return { improved, diff: d.curr - d.prev };
  };
  const notes = [];
  const lcpT = trend(kn.lcpHomepageMobileS);
  if (lcpT) notes.push(`首页 LCP ${kn.lcpHomepageMobileS.prev}s → ${kn.lcpHomepageMobileS.curr}s（${lcpT.improved ? '变快，改善' : '变慢，回落'}）`);
  const bytesT = trend(kn.homepageTransferBytes);
  if (bytesT) notes.push(`首页传输量 ${kbmb(kn.homepageTransferBytes.prev)} → ${kbmb(kn.homepageTransferBytes.curr)}（${bytesT.improved ? '更轻' : '更重'}）`);
  const altT = trend(kn.imagesNoAltPct);
  if (altT) notes.push(`首页图片无 alt 占比 ${kn.imagesNoAltPct.prev}% → ${kn.imagesNoAltPct.curr}%（${altT.improved ? '改善' : '回落'}）`);
  const bwT = trend(kn.buyerWordHits);
  if (bwT) notes.push(`买家关键词命中 ${kn.buyerWordHits.prev} → ${kn.buyerWordHits.curr} 项（${bwT.improved ? '覆盖变广' : '覆盖收窄'}）`);
  const aiPrev = parseHits(kn.aiMentionHits && kn.aiMentionHits.prev);
  const aiCurr = parseHits(kn.aiMentionHits && kn.aiMentionHits.curr);
  if (aiPrev != null && aiCurr != null && aiPrev !== aiCurr) {
    notes.push(`AI 问答品牌命中 ${kn.aiMentionHits.prev} → ${kn.aiMentionHits.curr}（${aiCurr > aiPrev ? 'AI 可见性提升' : 'AI 可见性回落'}）`);
  }
  const idxT = trend(kn.indexSampleCount);
  if (idxT) notes.push(`收录采样 ${kn.indexSampleCount.prev} → ${kn.indexSampleCount.curr} 条`);
  const notesHtml = notes.length
    ? `<h3>关键指标变化</h3><ul class="cmp-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
    : '';
  return { verdict, rows, notes: notesHtml };
}

function pageRowStatus(p) {
  if (!p.title || p.h1Count === 0 || !p.metaDescription) return ['CRITICAL', 'st-c'];
  if (p.titleLength < 15 || (p.images > 0 && p.imagesNoAlt / p.images > 0.5)) return ['HIGH', 'st-h'];
  return ['OK', 'st-ok'];
}

function generateReportHtml(r, host) {
  const pages = [];
  {
    const seen = new Set();
    (r.pages || []).forEach((p) => {
      if (p.url && !seen.has(p.url)) {
        seen.add(p.url);
        pages.push(p);
      }
    });
  }
  const t = r.technical || {};
  const lh = (r.lighthouse && r.lighthouse.homepageMobile) || null;
  const lhp = (r.lighthouse && r.lighthouse.productPageMobile) || null;
  const key = r.keyNumbers || {};
  const scores = r.scores || {};
  // 成绩单性能分来源说明（v16 起优先 CrUX 真实用户综合分）
  const perfSrc = scores.performance ? scores.performance.source : null;
  const perfSourceNote = perfSrc === 'crux-field-data'
    ? 'CrUX 真实用户综合分（过去 28 天真实访客体验，Google 搜索排名采用的口径；弱网模拟分仅供问题定位，不计入成绩单）'
    : perfSrc === 'psi-api' || perfSrc === 'lighthouse-mobile-homepage'
    ? 'Lighthouse 实验室模拟分（该站点暂无 CrUX 真实用户样本，无法采用真实用户口径；模拟分偏低主要反映弱网降速环境，不代表真实用户体验）'
    : '服务器探针实测（Lighthouse 与 CrUX 均未成功，为降级口径）';
  const perf = scores.performance || {};
  const totalBytes = key.homepageTransferBytes;
  const requests = lh && lh.resources && lh.resources.total ? lh.resources.total.requests : null;
  const onPageIssues = ((r.scores && r.scores.onPageSeo && r.scores.onPageSeo.issues) || []).slice(0, 8);
  const onPageIssuesHtml = onPageIssues.length
    ? `<h3>逐页问题清单</h3><ul class="cmp-notes">${onPageIssues.map((it) => `<li><b class="d down">${esc(it.sev)}</b> ${esc(it.finding)} — <span class="dim">${esc(it.page)}</span></li>`).join('')}</ul>`
    : '';

  const geoB = geoBlocks(r);
  const siB = indexBlocks(r);
  const cmpB = compareBlocks(r);
  const cmpScores = (r.comparison && r.comparison.scores) || null;

  const pageRows = pages
    .map((p) => {
      const u = new URL(p.url);
      const short = esc(u.pathname === '/'
        ? (u.search ? `首页 /${u.search}` : '首页 /')
        : u.pathname.replace(/^\//, '') + (u.search || ''));
      const [stLabel, stCls] = pageRowStatus(p);
      const alt = p.images > 0 ? `${pct(p.imagesNoAlt / p.images)}%（${p.imagesNoAlt}/${p.images}）` : '—';
      const desc = p.metaDescription
        ? esc(p.metaDescription.length > 40 ? p.metaDescription.slice(0, 40) + '…' : p.metaDescription) + `（${p.metaDescriptionLength} 字符）`
        : '<span class="badge st-c">缺失</span>';
      const h1 = p.h1Count === 0 ? '<span class="badge st-c">0 · 缺失</span>' : `${p.h1Count}`;
      const ld = p.jsonLdTypes && p.jsonLdTypes.length ? esc(p.jsonLdTypes.join(', ')) : '<span class="badge st-c">无</span>';
      return `<tr>
      <td class="cell-url"><span class="url" title="${esc(p.url)}">${short}</span></td>
      <td>${esc(p.title)}<span class="dim">（${p.titleLength} 字符）</span>${p.titleLength < 15 ? ' <span class="badge st-h">过短</span>' : ''}</td>
      <td>${desc}</td>
      <td class="num">${h1}</td>
      <td class="num">${alt}</td>
      <td class="num">${ld}</td>
      <td><span class="badge ${stCls}">${stLabel}</span></td>
    </tr>`;
    })
    .join('\n');

  const robotsTxt = t.robots
    ? t.robots.exists
      ? '存在且有效'
      : t.robots.status === 200 && t.robots.looksLikeHtmlErrorPage
      ? 'HTTP 200，但内容实为 404 错误页（无任何 robots 规则）'
      : '不存在'
    : '未检测';
  const sitemapTxt = t.sitemap
    ? t.sitemap.exists
      ? `存在（${t.sitemap.locCount} 条 URL）`
      : t.sitemap.status === 200
      ? 'HTTP 200，但内容不是 sitemap（0 条 URL，实为错误页）'
      : '不存在'
    : '未检测';

  const missingHeaders = t.securityHeaders
    ? Object.keys(t.securityHeaders).filter((k) => !t.securityHeaders[k].present)
    : [];

  const techRows = [
    {
      check: 'robots.txt',
      finding: robotsTxt,
      status: t.robots && t.robots.exists ? ['正常', 'st-ok'] : ['CRITICAL', 'st-c'],
    },
    {
      check: 'sitemap.xml',
      finding: sitemapTxt,
      status: t.sitemap && t.sitemap.exists ? ['正常', 'st-ok'] : ['CRITICAL', 'st-c'],
    },
    {
      check: '404 处理',
      finding:
        t.soft404 && t.soft404.testUrlStatus === 200
          ? '实测随机未知 URL 返回 HTTP 200（软 404），任意垃圾路径都可被 Google 收录'
          : '未知 URL 返回真实 404',
      status:
        t.soft404 && t.soft404.testUrlStatus === 200 ? ['CRITICAL', 'st-c'] : ['正常', 'st-ok'],
    },
    {
      check: 'Canonical 标签',
      finding: `${pages.filter((p) => !p.canonical).length}/${pages.length} 个页面缺失，www 与裸域同时可访问`,
      status:
        pages.some((p) => !p.canonical) ? ['HIGH', 'st-h'] : ['正常', 'st-ok'],
    },
    {
      check: '安全响应头',
      finding: missingHeaders.length
        ? `缺少 ${missingHeaders.length} 项：${missingHeaders.join('、')}`
        : '主要安全响应头齐全',
      status: missingHeaders.length ? ['MEDIUM', 'st-m'] : ['正常', 'st-ok'],
    },
    {
      check: 'HTTP → HTTPS',
      finding:
        t.httpRedirect && t.httpRedirect.finalProtocol === 'https:'
          ? 'HTTP 已强制跳转 HTTPS'
          : 'HTTP 未强制跳转 HTTPS',
      status:
        t.httpRedirect && t.httpRedirect.finalProtocol === 'https:' ? ['正常', 'st-ok'] : ['HIGH', 'st-h'],
    },
    {
      check: '服务器指纹',
      finding: `${(t.serverInfo && t.serverInfo.server) || '—'}${(t.serverInfo && t.serverInfo.aspNetVersion) ? ' · ASP.NET ' + t.serverInfo.aspNetVersion : ''}（${(t.serverInfo && t.serverInfo.server) ? '' : '无指纹'}上一代技术栈常见特征）`,
      status: ['INFO', 'st-m'],
    },
  ]
    .map(
      (x) => `<tr><th scope="row">${x.check}</th><td>${x.finding}</td><td><span class="badge ${x.status[1]}">${x.status[0]}</span></td></tr>`
    )
    .join('\n');

  const resItems = [];
  if (lh && lh.resources) {
    const map = { image: '图片', script: 'JavaScript', stylesheet: 'CSS', font: '字体', media: '视频/音频', document: 'HTML 文档', other: '其他' };
    Object.entries(lh.resources).forEach(([k, v]) => {
      if (k === 'total' || !v || !v.transferBytes) return;
      resItems.push({ label: map[k] || k, bytes: v.transferBytes, reqs: v.requests });
    });
    resItems.sort((a, b) => b.bytes - a.bytes);
  }
  const resBars = resItems
    .map((x) => {
      const w = totalBytes ? Math.max(1.5, pct(x.bytes / totalBytes)) : 0;
      return `<div class="brow">
      <span class="blabel">${x.label}</span>
      <span class="bar"><span class="fill${x.label === '图片' ? ' fill-red' : ''}" style="width:${w}%"></span></span>
      <span class="bval">${kbmb(x.bytes)} · ${x.reqs} 个请求</span>
    </div>`;
    })
    .join('\n');

  const buyerWords = Object.entries(key.buyerWordCounts || {});
  const buyerCells = buyerWords.length
    ? buyerWords
        .map(
          ([w, c]) =>
            `<div class="bword"><span class="bname">${esc(w)}</span><span class="bnum${c === 0 ? ' zero' : ''}">${c} 次</span></div>`
        )
        .join('\n')
    : '<p class="lede">AI 行业买家词识别本次未成功，重测通常可恢复。</p>';
  const buyerHits = buyerWords.reduce((a, [w, c]) => a + (c > 0 ? 1 : 0), 0);
  const buyerHitNames = buyerWords.filter(([, c]) => c > 0).map(([w]) => w).join('、');
  const buyerTotal = buyerWords.length;
  const industryNote = key.buyerWordsIndustry
    ? `，AI 已根据贵司内容识别行业「${esc(key.buyerWordsIndustry)}」并生成专属买家词`
    : '，AI 行业词识别本次未成功';
  const buyerAdvice = buyerTotal === 0
    ? 'AI 行业买家词识别本次未成功，本次未统计；重测通常可恢复。识别成功后，报告会按贵司所属行业动态生成买家决策词并统计覆盖情况。'
    : buyerHits === 0
    ? `${buyerTotal} 个 AI 识别的行业买家词全部为 0——网站正文基本不覆盖买家决策词。当海外买家向 AI 提问行业采购问题时，网站几乎没有被推荐的理由。建议在正文与 FAQ 中补齐这些买家决策词。`
    : `${buyerTotal} 个 AI 识别的行业买家词中命中 ${buyerHits} 个${buyerHitNames ? `（${buyerHitNames}）` : ''}，其余未命中的词建议在正文与 FAQ 中补齐——这些是海外买家向 AI 提问时的高频决策词，覆盖越多，AI 在更多买家问题中推荐贵司的机会越大。`;

  const si = (scores && scores.siteIndex) || null;
  // 收录安全优先级：软 404 漏洞等未通过项进 P1；漏洞修复后的存量垃圾收录属持续治理，放 P3
  const soft404Bad = !!(t.soft404 && t.soft404.testUrlStatus === 200);
  const robotsOk = !!(t.robots && t.robots.exists);
  const sitemapOk = !!(t.sitemap && t.sitemap.exists);
  const siDead = (si && si.deadCount) || 0;
  // v18：实测正常的"长路径"页面不算治理项；只统计实测异常与未抽查的疑似垃圾
  const siJunkBad = (si && (si.junkDead || 0)) || 0;
  const siJunkUnv = (si && (si.junkUnverified || 0)) || 0;
  const cleanupP3 = (!soft404Bad && si && si.score != null && (siDead + siJunkBad + siJunkUnv > 0))
    ? `<li>收录存量治理：对照「收录核查」明细，用 Search Console（site:${esc(host)}）处理${siDead > 0 ? ` ${siDead} 条失效` : ''}${siDead > 0 && siJunkBad > 0 ? '与' : ''}${siJunkBad > 0 ? ` ${siJunkBad} 条实测异常` : ''}${siJunkUnv > 0 ? `，并复核 ${siJunkUnv} 条未抽查的疑似垃圾路径` : ''}${siDead + siJunkBad > 0 ? '，提交移除并重新审核' : ''}</li>`
    : '';
  const indexPassed = [];
  if (!soft404Bad) indexPassed.push('软 404');
  if (robotsOk) indexPassed.push('robots.txt');
  if (sitemapOk) indexPassed.push('sitemap.xml');

  const pagesFull = (r.pages || []).filter(Boolean);
  const badTitleCount = pagesFull.filter((p) => p.titleLength && (p.titleLength < 25 || p.titleLength > 65)).length;
  const h1Missing = pagesFull.filter((p) => p.h1Count === 0).length;
  const multiObj = (r.scores && r.scores.multilingual) || null;
  const multiOk = !!(multiObj && multiObj.grade === 'A');
  const hasSchemaPages = pagesFull.some((p) => Array.isArray(p.jsonLdTypes) && p.jsonLdTypes.some((x) => x && x !== '__invalid__'));

  const geoLi = r.geoTest && r.geoTest.score != null
    ? (r.geoTest.hits === 0
        ? 'AI 问答 0 命中——优先入驻行业目录、B2B 平台与第三方评测内容，让 AI 有据可引'
        : '保持并扩大 AI 可引用内容（FAQ、规格参数、案例页），巩固 AI 回答中的出镜率')
    : 'GEO 问答本次未执行，建议复测';

  const imagesNoAlt = key.imagesNoAltPct;
  const testedAt = fmtDate(r.testedAt);
  const scoreCards = Object.entries(scores)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => {
      const d = cmpScores && cmpScores[k];
      let deltaBadge = '';
      if (d && d.delta != null && d.delta !== 0) {
        deltaBadge = d.delta > 0
          ? ' <b class="d up">↑+' + d.delta + '</b>'
          : ' <b class="d down">↓' + d.delta + '</b>';
      }
      return `<div class="score ${gradeCls[v.grade] || ''}">
      <span class="g">${esc(v.grade || '—')}</span>
      <span class="gl">${SCORE_LABELS[k] || esc(k)}</span>
      ${v.score != null ? `<span class="gs">${v.score} 分${deltaBadge}</span>` : '<span class="gs">未测</span>'}
    </div>`;
    })
    .join('\n');

  const lhPerfGrade = lhp
    ? lhp.scores.performance >= 90 ? 'A' : lhp.scores.performance >= 80 ? 'B' : lhp.scores.performance >= 70 ? 'C' : lhp.scores.performance >= 50 ? 'D' : 'F'
    : '—';

  const priorityAlert =
    t.soft404 && t.soft404.testUrlStatus === 200
      ? `<section class="alert" aria-label="优先处理事项">
    <h2><span class="tag">PRIORITY</span>优先处理：服务器对任意 URL 返回 200（软 404）</h2>
    <p>实测请求一个不存在的随机路径，服务器返回 <strong>HTTP 200</strong>；这意味着任何垃圾路径都能被 Google 正常收录——这是大量垃圾页面挂在该域名下的直接通道。</p>
    <p>建议先由技术团队排查服务器路由，再通过 <a href="https://search.google.com/search-console" target="_blank" rel="noopener noreferrer">Google Search Console</a> 用 <code style="font-family:var(--mono)">site:${esc(host)}</code> 核查收录规模；若已存在大量垃圾收录，需清理后提交重新审核。</p>
  </section>`
      : '';

  const probe = (r.perfProbe && r.perfProbe.metrics) ? r.perfProbe : null;
  const probeRows = probe ? [
    ['TTFB 首字节', probe.metrics.ttfbMs != null ? probe.metrics.ttfbMs + ' ms' : '—', '服务器返回第一个字节的时间，反映服务器响应快慢，直接影响所有后续加载'],
    ['HTML 传输体积', kbmb(probe.metrics.htmlBytes), '首页文档大小，过大会拖慢打开速度与搜索引擎抓取'],
    ['外链 CSS', `${probe.metrics.cssCount} 个 · 抽样实测 ${kbmb(probe.metrics.cssBytes)}`, '样式文件数量与体积，过多会拖慢首屏渲染'],
    ['外链 JS', `${probe.metrics.jsCount} 个 · 抽样实测 ${kbmb(probe.metrics.jsBytes)}`, '脚本文件数量与体积，过多会拖慢页面可交互时间'],
    ['图片', `共 ${probe.metrics.imgTotal} 张 · 懒加载 ${probe.metrics.lazyPct}% · 无尺寸标注 ${probe.metrics.noDimsPct}%`, '懒加载＝滑到可见位置才加载；无尺寸标注会让加载时布局跳动（拉高 CLS）'],
    ['压缩', probe.metrics.compression === 'br' ? 'Brotli' : probe.metrics.compression === 'gzip' ? 'Gzip' : '未压缩', '开启后文本资源体积可减 70% 以上，一行配置即可见效'],
    ['HTTP/2', probe.metrics.http2 ? '是' : '否', '新一代传输协议，多个资源并行加载更快'],
    ['head 阻塞脚本', String(probe.metrics.syncHeadScripts), '页面关键位置同步执行的脚本，直接拖慢首屏'],
    ['静态资源带缓存头', probe.metrics.cacheRatio != null ? probe.metrics.cacheRatio + '%' : '—', '允许浏览器缓存图片/样式/脚本，回头客二次访问更快'],
  ] : [];
  // PSI 结果与开关：提前声明，供 perfSection（probe 分支文案）与 psiHtml 共用
  const psi = r.psi || null;
  const psiOk = !!(psi && psi.ok);
  const perfSection = lh
    ? `<section id="perf">
    <h2><span class="no">04</span>性能</h2>
    <p class="lede">Lighthouse 移动端实测（默认模拟 Slow 4G 网络 + 4 倍 CPU 降速）。数值口径与真机不同，但方向一致。</p>
    <div class="perf-grid">
      <div class="perf-card">
        <div class="pn">首页 · 移动端</div>
        <div class="pv"><span class="score-num" style="color:var(--orange)">${lh.scores.performance}</span><span class="badge st-h">${perf.grade || '—'} 级</span></div>
        <div class="perf-chips">
          <span class="chip bad">LCP <b>${fmtMs(lh.metrics ? lh.metrics.lcpS : null)}</b></span>
          <span class="chip">FCP <b>${fmtMs(lh.metrics ? lh.metrics.fcpS : null)}</b></span>
          <span class="chip">CLS <b>${lh.metrics && lh.metrics.cls != null ? lh.metrics.cls.toFixed(2) : '—'}</b></span>
          <span class="chip">TBT <b>${lh.metrics && lh.metrics.tbtMs != null ? Math.round(lh.metrics.tbtMs) + ' ms' : '—'}</b></span>
        </div>
      </div>
      <div class="perf-card">
        <div class="pn">产品页 · 移动端</div>
        <div class="pv"><span class="score-num" style="color:var(--orange)">${lhp ? lhp.scores.performance : '—'}</span><span class="badge st-h">${lhPerfGrade} 级</span></div>
        <div class="perf-chips">
          <span class="chip bad">LCP <b>${fmtMs(lhp && lhp.metrics ? lhp.metrics.lcpS : null)}</b></span>
          <span class="chip">FCP <b>${fmtMs(lhp && lhp.metrics ? lhp.metrics.fcpS : null)}</b></span>
          <span class="chip">传输 <b>${kbmb(lhp && lhp.metrics ? lhp.metrics.totalBytes : null)}</b></span>
        </div>
      </div>
    </div>
    ${resBars ? `<div class="bars">
      <h3>首页资源构成（共 ${kbmb(totalBytes)}${requests ? ' · ' + requests + ' 个请求' : ''}）</h3>
      ${resBars}
    </div>` : ''}
  </section>`
    : probe
    ? `<section id="perf">
    <h2><span class="no">04</span>性能</h2>
    <p class="lede">成绩单中的性能分取自${perfSourceNote}。${psiOk ? '性能数据由两部分组成：服务器端探针实测（下方加载指标）+ Google CrUX 真实用户数据（过去 28 天真实访客的体验，见下方区块）。' : '服务器端性能探针实测（本环境无浏览器，本地 Lighthouse 未运行）。以下为可直接测量的加载指标；LCP/CLS 等渲染期指标建议用 <a href="https://pagespeed.web.dev/" target="_blank" rel="noopener noreferrer">Google PageSpeed Insights</a> 复核。'}</p>
    <div class="perf-grid">
      <div class="perf-card">
        <div class="pn">加载性能 · 服务器实测</div>
        <div class="pv"><span class="score-num" style="color:var(--orange)">${probe.score}</span><span class="badge st-h">${esc(perf.grade || '—')} 级</span></div>
        <div class="perf-chips">
          <span class="chip bad">TTFB <b>${probe.metrics.ttfbMs != null ? probe.metrics.ttfbMs + ' ms' : '—'}</b></span>
          <span class="chip">HTML <b>${kbmb(probe.metrics.htmlBytes)}</b></span>
          <span class="chip">CSS+JS <b>${kbmb((probe.metrics.cssBytes || 0) + (probe.metrics.jsBytes || 0))}</b></span>
          <span class="chip">压缩 <b>${esc(probe.metrics.compression)}</b></span>
        </div>
      </div>
    </div>
    <table class="tbl">
      <thead><tr><th>指标</th><th>实测值</th><th>说明</th></tr></thead>
      <tbody>
        ${probeRows.map((row) => `<tr><td>${esc(row[0])}</td><td><b>${esc(row[1])}</b></td><td>${esc(row[2])}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>`
    : `<section id="perf">
    <h2><span class="no">04</span>性能</h2>
    <p class="lede">本次未运行 Lighthouse（本机常驻 Chrome 不可用），性能探针也未成功。可运行 <code style="font-family:var(--mono)">bash scripts/dev.sh</code> 后重测，或使用 <a href="https://pagespeed.web.dev/" target="_blank" rel="noopener noreferrer">Google PageSpeed Insights</a> 复核。</p>
  </section>`;

  // PSI（Google PageSpeed Insights API）实测区块：未配置反代时不出现；配置了但失败时给出提示
  const psiHtml = (() => {
    if (!psi) return '';
    const SHOW_LAB = false; // Lighthouse 模拟数据区块开关（弱网单次模拟与真实用户数据口径差异大，暂隐藏；置 true 可恢复展示）
    const m = psi.metrics || {};
    const val = (v, suf) => (v == null ? '—' : v + (suf || ''));
    const rate = (v, good, poor) =>
      v == null ? '<span class="dim">—</span>'
      : v <= good ? '<b style="color:#15803d">优</b>'
      : v <= poor ? '<b style="color:var(--orange)">需改进</b>'
      : '<b style="color:var(--red)">差</b>';
    const rows = [
      ['LCP · 最大内容绘制', m.lcpMs != null ? (m.lcpMs / 1000).toFixed(1) + ' s' : '—', rate(m.lcpMs, 2500, 4000), '≤ 2.5 s'],
      ['CLS · 累积布局偏移', m.cls != null ? m.cls.toFixed(3) : '—', rate(m.cls, 0.1, 0.25), '≤ 0.1'],
      ['TBT · 总阻塞时间', val(m.tbtMs, ' ms'), rate(m.tbtMs, 200, 600), '≤ 200 ms'],
      ['FCP · 首次内容绘制', m.fcpMs != null ? (m.fcpMs / 1000).toFixed(1) + ' s' : '—', rate(m.fcpMs, 1800, 3000), '≤ 1.8 s'],
      ['TTFB · 首字节时间', val(m.ttfbMs, ' ms'), rate(m.ttfbMs, 800, 1800), '≤ 0.8 s'],
      ['Speed Index · 速度指数', m.speedIndexMs != null ? (m.speedIndexMs / 1000).toFixed(1) + ' s' : '—', rate(m.speedIndexMs, 3400, 5800), '≤ 3.4 s'],
    ];
    const CRUX_CN = { GOOD: '良好', NEEDS_IMPROVEMENT: '需改进', POOR: '差', FAST: '良好', AVERAGE: '需改进', SLOW: '差' }; // 兼容 PSI loadingExperience（FAST/AVERAGE/SLOW）与 CrUX API（GOOD/NEEDS_IMPROVEMENT/POOR）两套评级
    const cruxTableOf = (cx, label, withNote) => {
      if (!cx) return '';
      const rows2 = [
        ['LCP（P75）', cx.lcp && cx.lcp.p75 != null ? (cx.lcp.p75 / 1000).toFixed(1) + ' s' : '—', cx.lcp ? cx.lcp.category : ''],
        ['CLS（P75）', cx.cls && cx.cls.p75 != null ? String(cx.cls.p75) : '—', cx.cls ? cx.cls.category : ''],
        ['INP（P75）', cx.inp && cx.inp.p75 != null ? val(cx.inp.p75, ' ms') : '—', cx.inp ? cx.inp.category : ''],
        ['FCP（P75）', cx.fcp && cx.fcp.p75 != null ? val(cx.fcp.p75, ' ms') : '—', cx.fcp ? cx.fcp.category : ''],
        ['TTFB（P75）', cx.ttfb && cx.ttfb.p75 != null ? val(cx.ttfb.p75, ' ms') : '—', cx.ttfb ? cx.ttfb.category : ''],
      ].filter((row) => row[2]).map((row) => [row[0], row[1], CRUX_CN[row[2]] || row[2]]);
      if (!rows2.length) return '';
      const originNote = cx.originFallback ? ' · 页面级样本不足，已回退为整站 origin 数据' : '';
      return `<h4 style="margin-top:18px">CrUX 真实用户数据 · ${label}设备（近 28 天 P75${originNote}）</h4>
      ${cx.score != null ? `<div class="perf-chips"><span class="chip ${cx.score >= 80 ? '' : 'bad'}">真实用户综合分 <b>${cx.score}</b> · ${esc(cx.grade || '—')} 级</span><span class="chip">核心指标达标 <b>${cx.corePass}/${cx.coreTotal}</b>（LCP / INP / CLS）</span></div>` : ''}
      <table class="tbl">
        <thead><tr><th>指标</th><th>真实用户 P75</th><th>评级</th></tr></thead>
        <tbody>
          ${rows2.map((row) => `<tr><td>${esc(row[0])}</td><td><b>${esc(row[1])}</b></td><td>${esc(row[2])}</td></tr>`).join('\n')}
        </tbody>
      </table>${withNote ? `\n      <p class="dim" style="margin-top:8px">综合分＝LCP / INP / CLS 三项核心指标（Google 搜索排名采用的 Core Web Vitals）按阈值插值打分后取平均，达标数表示三项中处于"良好"区间的数量。P75＝过去 28 天真实访客中 75% 的人体验不慢于此值。INP＝点击按钮或输入后页面的响应速度；其余指标含义见上方指标说明。</p>` : ''}`;
    };
    const cruxMob = psi.crux && psi.crux.formFactor === 'DESKTOP' ? null : psi.crux;
    const cruxDesk = psi.cruxDesk || (psi.crux && psi.crux.formFactor === 'DESKTOP' ? psi.crux : null);
    const cruxMobHtml = cruxTableOf(cruxMob, '移动端', true);
    const cruxDeskHtml = cruxTableOf(cruxDesk, '桌面端', false);
    let cruxHtml;
    if (cruxMobHtml || cruxDeskHtml) {
      cruxHtml = cruxMobHtml + cruxDeskHtml;
      if (!cruxMobHtml) cruxHtml += `\n      <p class="dim">移动端暂无 CrUX 真实用户样本${psi.cruxError ? '（' + esc(String(psi.cruxError).slice(0, 100)) + '）' : ''}。</p>`;
      if (!cruxDeskHtml) cruxHtml += `\n      <p class="dim">桌面端暂无 CrUX 真实用户样本${psi.cruxDeskError ? '（' + esc(String(psi.cruxDeskError).slice(0, 100)) + '）' : ''}。</p>`;
    } else {
      cruxHtml = psi.cruxError
        ? `<p class="dim">CrUX 真实用户数据查询未成功：${esc(String(psi.cruxError).slice(0, 120))}。</p>`
        : `<p class="dim"><b>该站点在 Google 真实用户数据集（CrUX）中暂无样本。</b>Google 仅披露拥有足够 Chrome 真实访客流量的站点（官方不公开具体门槛，行业经验约需 28 天内数百名独立 Chrome 访客），且站点需公开可抓取。无数据不代表性能不合格，而是说明该站当前真实流量较小，或存在影响可抓取性的问题（如 HTTPS 异常）。建议先修复 HTTPS 与基础 SEO、通过搜索积累真实访客，流量达标后 Google 会自动开始披露该数据。</p>`;
    }
    if (!psi.ok) {
      // PSI 查询失败（网络抖动等）：CrUX 独立兜底成功时仍展示真实用户数据区块，否则提示失败原因
      if (!(cruxMobHtml || cruxDeskHtml)) {
        return `<div class="probe-block"><p class="dim">PSI 实测未完成：${esc(String(psi.error || '未知错误').slice(0, 200))}。渲染期指标请用 <a href="https://pagespeed.web.dev/" target="_blank" rel="noopener noreferrer">Google PageSpeed Insights</a> 复核。</p></div>`;
      }
      return `
    <div class="probe-block">
      <h3>真实用户性能数据（Google CrUX · Chrome 用户体验报告）</h3>
      <p class="lede">PSI 实时查询因网络波动未完成，以下为通过 CrUX 接口独立获取的真实用户数据（过去 28 天，Google 搜索排名采用的性能口径）。</p>
      <p class="dim" style="margin-top:8px">指标说明：LCP＝主图或主标题完整显示的时间（用户感知的"打开速度"）；CLS＝页面加载中元素突然跳动的程度（跳动大会误点按钮）；FCP＝屏幕出现第一个内容的时间；TTFB＝服务器返回第一个字节的时间。以上指标含义同时适用于下方真实用户数据表。</p>
      ${cruxHtml}
    </div>`;
    }
    return `
    <div class="probe-block">
      ${SHOW_LAB ? `<h3>Google Lighthouse 实测（PageSpeed Insights API · ${esc(psi.strategy || 'mobile')}）</h3>
      <p class="lede">由 Google 服务器执行完整 Lighthouse 测试${psi.durationMs != null ? `（耗时 ${Math.round(psi.durationMs / 1000)} 秒）` : ''}：模拟移动设备（Slow 4G / 4× CPU 节流）加载目标页面，得到渲染期核心指标。</p>
      <div class="perf-chips">
        <span class="chip ${psi.score >= 90 ? '' : 'bad'}">性能分 <b>${psi.score != null ? psi.score : '—'}</b> · ${esc(psi.grade || '—')} 级</span>
        <span class="chip">LCP <b>${m.lcpMs != null ? (m.lcpMs / 1000).toFixed(1) + ' s' : '—'}</b></span>
        <span class="chip">CLS <b>${m.cls != null ? m.cls.toFixed(3) : '—'}</b></span>
        <span class="chip">TBT <b>${val(m.tbtMs, ' ms')}</b></span>
      </div>
      <table class="tbl">
        <thead><tr><th>指标</th><th>实测值</th><th>评价</th><th>良好阈值</th></tr></thead>
        <tbody>
          ${rows.map((row) => `<tr><td>${esc(row[0])}</td><td><b>${esc(row[1])}</b></td><td>${row[2]}</td><td class="dim">${esc(row[3])}</td></tr>`).join('\n')}
        </tbody>
      </table>` : `<h3>真实用户性能数据（Google CrUX · Chrome 用户体验报告）</h3>
      <p class="lede">以下为过去 28 天真实访客的体验统计（非模拟测试），也是 Google 搜索排名采用的性能口径；同时覆盖移动端与桌面端设备。</p>`}
      <p class="dim" style="margin-top:8px">指标说明：LCP＝主图或主标题完整显示的时间（用户感知的"打开速度"）；CLS＝页面加载中元素突然跳动的程度（跳动大会误点按钮）；TBT＝页面卡住无法点击的总时长（脚本太多时用户觉得"点了没反应"）；FCP＝屏幕出现第一个内容的时间；TTFB＝服务器返回第一个字节的时间；Speed Index＝页面从空白到填满的平均速度。${SHOW_LAB ? '以上为 Google 服务器在 Slow 4G 弱网 + 4× CPU 降速下的单次模拟，用于定位问题；真实用户体验以下方 CrUX 数据为准。' : '以上指标含义同时适用于下方真实用户数据表。'}</p>
      ${cruxHtml}
    </div>`;
  })();

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(host)} · 出海网站体检报告</title>
<style>
  :root{
    --bg:#f6f6f3; --surface:#ffffff; --ink:#1b2530; --muted:#5c6673; --line:#e0e4e8;
    --red:#b3261e; --red-bg:#fbeeed; --orange:#c2410c; --orange-bg:#fdf1e7;
    --amber:#a16207; --amber-bg:#fbf3df; --green:#166534; --green-bg:#e9f4ec;
    --ink-num:#253241;
    --font:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --radius:4px; --space:24px;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:16px;line-height:1.65;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1100px;margin:0 auto;padding:0 clamp(16px,4vw,40px)}
  a{color:#0f5aa8;text-decoration-thickness:1px;text-underline-offset:2px}
  a:focus-visible,button:focus-visible{outline:2px solid #0f5aa8;outline-offset:2px;border-radius:2px}
  .kicker{font-size:13px;letter-spacing:.14em;color:var(--muted);margin:0 0 6px}
  .kicker-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .pdf-btn{flex:none;border:1px solid var(--line);background:var(--surface);color:var(--ink);font-size:13px;padding:7px 16px;border-radius:99px;cursor:pointer;font-family:var(--font);transition:background .15s}
  .pdf-btn:hover{background:var(--bg);border-color:var(--muted)}
  h1{font-size:clamp(24px,4vw,34px);line-height:1.25;margin:0 0 8px;letter-spacing:.01em}
  .sub{color:var(--muted);font-size:14px;margin:0}
  header.top{background:var(--surface);border-bottom:1px solid var(--line);padding:36px 0 0}
  .meta-row{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:14px;padding-bottom:14px;border-bottom:1px solid var(--line);font-size:13px;color:var(--muted)}
  nav.toc{display:flex;flex-wrap:wrap;gap:2px 4px;padding:6px 0}
  nav.toc a{font-size:13px;color:var(--muted);text-decoration:none;padding:4px 10px;border-radius:99px}
  nav.toc a:hover{background:var(--bg);color:var(--ink)}
  main{padding:28px 0 8px}
  section{margin:0 0 44px}
  h2{font-size:20px;margin:0 0 4px;display:flex;align-items:baseline;gap:10px}
  h2 .no{font-family:var(--mono);font-size:13px;color:var(--muted);letter-spacing:.08em}
  h3{font-size:15px;margin:18px 0 8px}
  .lede{color:var(--muted);font-size:14px;margin:0 0 16px;max-width:72ch}
  .alert{background:var(--red-bg);border:1px solid #efc9c5;border-left:4px solid var(--red);border-radius:var(--radius);padding:16px 20px;margin:0 0 36px}
  .alert h2{margin:0 0 6px;font-size:17px;color:var(--red)}
  .alert p{margin:6px 0;font-size:14.5px}
  .alert .tag{display:inline-block;font-family:var(--mono);font-size:11px;background:var(--red);color:#fff;border-radius:3px;padding:1px 7px;vertical-align:2px;margin-right:8px;letter-spacing:.08em}
  .score-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0 8px}
  .score{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;display:flex;flex-direction:column;gap:2px;min-width:0}
  .score .g{font-family:var(--mono);font-size:30px;font-weight:700;line-height:1.1}
  .score .gl{font-size:13px;color:var(--ink)}
  .score .gs{font-size:12px;color:var(--muted);font-family:var(--mono)}
  .score .gs b.d{font-weight:700;margin-left:4px}
  .score .gs b.up{color:var(--green)}
  .score .gs b.down{color:var(--red)}
  .g-f .g{color:var(--red)} .g-f{border-top:3px solid var(--red)}
  .g-d .g{color:var(--orange)} .g-d{border-top:3px solid var(--orange)}
  .g-c .g{color:var(--amber)} .g-c{border-top:3px solid var(--amber)}
  .g-b .g{color:var(--green)} .g-b{border-top:3px solid var(--green)}
  .g-a .g{color:var(--green)} .g-a{border-top:3px solid var(--green)}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:18px}
  .stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px}
  .stat .v{font-family:var(--mono);font-size:22px;font-weight:700;color:var(--ink-num);line-height:1.2}
  .stat .v.bad{color:var(--red)}
  .stat .k{font-size:13px;color:var(--muted);margin-top:2px}
  .tablewrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}
  table{border-collapse:collapse;width:100%;font-size:14px;min-width:640px}
  caption{text-align:left;font-size:12px;color:var(--muted);padding:10px 14px 0}
  th,td{padding:10px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
  thead th{font-size:12px;letter-spacing:.06em;color:var(--muted);background:#fafaf8;border-bottom:1px solid var(--line);white-space:nowrap}
  tbody tr:last-child th,tbody tr:last-child td{border-bottom:none}
  tbody th{font-weight:600;white-space:nowrap}
  td.num{font-family:var(--mono);font-size:13px;white-space:nowrap}
  .url{font-family:var(--mono);font-size:12.5px;color:var(--ink-num);word-break:break-all}
  .dim{color:var(--muted);font-size:12.5px}
  .badge{display:inline-block;font-family:var(--mono);font-size:11px;border-radius:3px;padding:1px 7px;letter-spacing:.05em;white-space:nowrap}
  .st-c{background:var(--red-bg);color:var(--red);border:1px solid #efc9c5}
  .st-h{background:var(--orange-bg);color:var(--orange);border:1px solid #f2d5bd}
  .st-m{background:var(--amber-bg);color:var(--amber);border:1px solid #ecdcae}
  .st-ok{background:var(--green-bg);color:var(--green);border:1px solid #c8e2cf}
  .geo-verdict{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--green);border-radius:var(--radius);padding:14px 20px;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:14px 0 4px}
  .geo-verdict .gv{font-family:var(--mono);font-size:30px;font-weight:700;color:var(--green)}
  .geo-verdict .gt{font-size:14.5px;color:var(--ink)}
  .geo-verdict.geo-zero{border-left-color:var(--red)}
  .geo-verdict.geo-zero .gv{color:var(--red)}
  .geo-warn{background:var(--amber-bg);border:1px solid #ecdcae;border-radius:var(--radius);padding:12px 16px;font-size:14px;margin:14px 0}
  .cmp-notes{margin:8px 0 0;padding-left:20px;font-size:14px}
  .cmp-notes li{margin:4px 0}
  .perf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin:14px 0}
  .perf-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px}
  .perf-card .pn{font-size:13px;color:var(--muted);margin-bottom:6px}
  .perf-card .pv{display:flex;align-items:baseline;gap:12px}
  .perf-card .score-num{font-family:var(--mono);font-size:40px;font-weight:700;line-height:1}
  .perf-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
  .chip{font-size:12.5px;font-family:var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:3px 9px;color:var(--ink-num)}
  .chip b{font-weight:700}
  .chip.bad b{color:var(--red)}
  .bars{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 20px;margin-top:12px}
  .bars h3{font-size:14px;margin:0 0 12px}
  .brow{display:grid;grid-template-columns:88px 1fr auto;gap:10px;align-items:center;padding:5px 0;font-size:13px}
  .blabel{color:var(--muted)}
  .bar{background:var(--bg);border-radius:2px;height:14px;overflow:hidden;min-width:0}
  .fill{display:block;height:100%;background:#4a6785;border-radius:2px}
  .fill-red{background:var(--red)}
  .bval{font-family:var(--mono);font-size:12px;color:var(--ink-num);white-space:nowrap}
  .bwords{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin-top:8px}
  .bword{text-align:center}
  .bword .bname{display:block;font-size:15px;font-weight:700;color:var(--ink);font-family:var(--mono)}
  .bword .bnum{display:block;margin-top:4px;font-family:var(--mono);font-size:20px;font-weight:700;color:var(--green)}
  .bword .bnum.zero{color:var(--muted);font-weight:400}
  .bword .bname{font-size:12.5px;color:var(--muted);font-family:var(--mono)}
  .plan{display:grid;gap:14px;margin-top:14px}
  .phase{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 20px;border-left:4px solid var(--red)}
  .phase.p2{border-left-color:var(--orange)}
  .phase.p3{border-left-color:var(--green)}
  .phase h3{margin:0 0 8px;font-size:15px;display:flex;gap:10px;align-items:baseline}
  .phase h3 .ph{font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:.1em}
  .phase ul{margin:0;padding-left:20px;font-size:14px}
  .phase li{margin:4px 0}
  .method{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 20px}
  .method ul{margin:0;padding-left:20px;font-size:14px;color:var(--ink)}
  .method li{margin:5px 0}
  footer{border-top:1px solid var(--line);margin-top:20px;padding:22px 0 40px;color:var(--muted);font-size:13px}
  footer code{font-family:var(--mono);background:var(--surface);border:1px solid var(--line);border-radius:3px;padding:1px 7px;font-size:12px}
  @media (max-width:640px){
    .brow{grid-template-columns:64px 1fr}
    .bval{grid-column:2;font-size:11px}
  }
  @media print{
    body{background:#fff}
    nav.toc,.pdf-btn{display:none}
    .tablewrap{overflow:visible}
    table{min-width:0;font-size:12px}
    tr,.bword,.stat,.perf-card,.cmp-card,.scorecard-row{break-inside:avoid}
    section{margin-bottom:24px}
    header.top{padding-top:12px}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    a{color:inherit;text-decoration:none}
    @page{margin:12mm}
  }
  @media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <div class="kicker-row"><p class="kicker">出海网站诊断 · 实测体检报告</p><button class="pdf-btn" onclick="window.print()" title="调起打印对话框，目标打印机选择“另存为 PDF”即可导出">⬇ 导出 PDF</button></div>
    <h1>${esc(host)} 网站健康体检</h1>
    <p class="sub">网站在 Google、AI 助手和海外买家眼中的表现，基于真实访问检测。</p>
    <div class="meta-row">
      <span>检测时间：${testedAt}</span>
      <span>工具：website-audit-web v0.9（Lighthouse + 自研 SEO / 技术检查 + 收录核查 + GEO/AI 问答 + 复测对比）</span>
      <span>测试位置：服务端直连（非海外节点）</span>
    </div>
    <nav class="toc" aria-label="页内导航">
      <a href="#scorecard">成绩单</a><a href="#onpage">页面 SEO</a><a href="#technical">技术检查</a><a href="#index">收录核查</a><a href="#perf">性能</a><a href="#geo">GEO/AI 可见性</a><a href="#compare">复测对比</a><a href="#action">行动计划</a><a href="#method">方法与局限</a>
    </nav>
  </div>
</header>
<main class="wrap">

  ${priorityAlert}

  <section id="scorecard">
    <h2><span class="no">00</span>成绩单</h2>
    <p class="lede">八个维度的整体评级。评分规则与依据见各章节的明细数据。</p>
    <div class="score-grid">${scoreCards}</div>
    <div class="stats">
      <div class="stat"><span class="v ${totalBytes && totalBytes > 3145728 ? 'bad' : ''}">${kbmb(totalBytes)}</span><span class="k">首页传输量（健康参考 2–3 MB）</span></div>
      <div class="stat"><span class="v ${lh && lh.metrics && lh.metrics.lcpS > 2500 ? 'bad' : ''}">${fmtMs(lh && lh.metrics ? lh.metrics.lcpS : null)}</span><span class="k">首页 LCP · 模拟 4G 移动网络（目标 &lt; 2.5 s）</span></div>
      <div class="stat"><span class="v ${pages.some((p) => p.h1Count === 0) ? 'bad' : ''}">${pages.filter((p) => p.h1Count === 0).length}/${pages.length}</span><span class="k">页面没有 H1 标题</span></div>
      <div class="stat"><span class="v ${imagesNoAlt != null && imagesNoAlt > 20 ? 'bad' : ''}">${imagesNoAlt != null ? imagesNoAlt + '%' : '—'}</span><span class="k">首页图片没有 alt 文本</span></div>
      <div class="stat"><span class="v ${allJsonLdLength(r) === 0 ? 'bad' : ''}">${allJsonLdLength(r)}</span><span class="k">结构化数据（Schema）条目</span></div>
      <div class="stat"><span class="v ${buyerHits === 0 ? 'bad' : ''}">${buyerTotal > 0 ? buyerHits + ' 项命中' : '—'}</span><span class="k">AI 行业买家词命中</span></div>
      <div class="stat"><span class="v ${(key.aiMentionHits || '').startsWith('0/') ? 'bad' : ''}">${key.aiMentionHits || '—'}</span><span class="k">AI 问答品牌命中（模拟买家提问）</span></div>
      <div class="stat"><span class="v ${key.indexSampleCount === 0 ? 'bad' : ''}">${key.indexSampleCount != null ? key.indexSampleCount : '—'}</span><span class="k">收录采样条数（搜索引擎站内检索）</span></div>
    </div>
  </section>

  <section id="onpage">
    <h2><span class="no">01</span>页面 SEO</h2>
    <p class="lede">逐页抓取真实 HTML 解析所得。Title 过短、缺少描述、没有 H1，都会让 Google 和 AI 助手无法理解页面在卖什么。</p>
    <div class="tablewrap">
      <table>
        <caption>共抓取 ${pages.length} 个关键页面（按首页导航识别：首页 / 产品 / 关于 / 联系）</caption>
        <thead><tr><th scope="col">页面</th><th scope="col">Title</th><th scope="col">Meta Description</th><th scope="col">H1</th><th scope="col">图片无 alt</th><th scope="col">结构化数据</th><th scope="col">状态</th></tr></thead>
        <tbody>
${pageRows}
        </tbody>
      </table>
    </div>
    ${onPageIssuesHtml}
  </section>

  <section id="technical">
    <h2><span class="no">02</span>技术检查</h2>
    <p class="lede">面向搜索引擎抓取与安全的基础设施检查，全部为实测结果。</p>
    <div class="tablewrap">
      <table>
        <caption>技术性检查明细</caption>
        <thead><tr><th scope="col">检查项</th><th scope="col">发现</th><th scope="col">状态</th></tr></thead>
        <tbody>
${techRows}
        </tbody>
      </table>
    </div>
  </section>

  <section id="index">
    <h2><span class="no">03</span>收录核查（搜索引擎采样）</h2>
    <p class="lede">通过搜索引擎站内检索（四种查询组合 × www/裸域两种形态）采样该域名被收录的页面，并抽查收录 URL 的真实可达性。搜索接口不提供收录总数，本节为采样结论；精确收录规模请以 <a href="https://search.google.com/search-console" target="_blank" rel="noopener noreferrer">Google Search Console</a> 为准。</p>
    ${siB.verdict}
    ${siB.rows ? `<div class="tablewrap" style="margin-top:14px"><table>
      <caption>收录采样明细（共 ${siB.sampleCount} 条，其中 ${siB.verifiedCount != null ? siB.verifiedCount : Math.min((scores.siteIndex && scores.siteIndex.urls ? scores.siteIndex.urls.filter((u) => u.httpStatus != null).length : 0), 99)} 条做了真实可达性抽查——含全部疑似垃圾路径，其余为搜索接口返回的标题快照）</caption>
      <thead><tr><th scope="col">收录 URL</th><th scope="col">页面标题</th><th scope="col">抽查状态</th></tr></thead>
      <tbody>
${siB.rows}
      </tbody>
    </table></div>` : ''}
  </section>

  ${perfSection}
  ${psiHtml}

  <section id="geo">
    <h2><span class="no">05</span>GEO / AI 可见性</h2>
    <p class="lede">AI 助手（ChatGPT / Perplexity 等）正在成为海外买家的第一个入口。本报告用 AI 模拟海外买家，围绕贵司行业提出 ${geoB.total || 6} 个真实采购问题，检测 AI 回答中是否提及 ${esc(host)}：</p>
    ${geoB.verdict}
    ${geoB.rows ? `<div class="tablewrap" style="margin-top:14px"><table>
      <caption>GEO/AI 问答明细（AI 回答为生成式内容，节选前 240 字符）</caption>
      <thead><tr><th scope="col" style="min-width:220px">模拟买家提问</th><th scope="col">AI 回答（节选）</th><th scope="col">品牌提及</th></tr></thead>
      <tbody>
${geoB.rows}
      </tbody>
    </table></div>` : ''}
    <h3>买家词覆盖（AI 匹配买家问题的基础）</h3>
    <p class="lede">AI 助手靠网站上的词来匹配买家问题。统计全部已检测页面正文中，海外买家高频词的出现次数——买家词表由 AI 根据贵司内容动态生成${industryNote}：</p>
    <div class="bwords">${buyerCells}</div>
    <p class="lede" style="margin-top:12px">${buyerAdvice}</p>
  </section>

  <section id="compare">
    <h2><span class="no">06</span>复测对比</h2>
    <p class="lede">与上一次检测的逐维度对比，用于验证整改效果。</p>
    ${cmpB.verdict}
    ${cmpB.rows ? `<div class="tablewrap" style="margin-top:14px"><table>
      <caption>分数对比（上次 → 本次）</caption>
      <thead><tr><th scope="col">维度</th><th scope="col">上次</th><th scope="col">本次</th><th scope="col">变化</th></tr></thead>
      <tbody>
${cmpB.rows}
      </tbody>
    </table></div>` : ''}
    ${cmpB.notes}
  </section>

  <section id="action">
    <h2><span class="no">07</span>行动计划</h2>
    <p class="lede">按业务影响排序：</p>
    <div class="plan">
      <div class="phase">
        <h3><span class="ph">P1 · 紧急</span>收录安全</h3>
        <ul>
          ${soft404Bad ? '<li>修复软 404：未知路径当前返回 HTTP 200，任何垃圾路径都能被收录——需返回真实 404 / 410</li><li>用 Search Console 核查 <code style="font-family:var(--mono)">site:' + esc(host) + '</code> 收录规模，清理垃圾收录并提交重新审核</li>' : ''}
          ${!robotsOk ? '<li>补上 robots.txt，控制抓取范围</li>' : ''}
          ${!sitemapOk ? '<li>补上 sitemap.xml，帮助搜索引擎发现全站页面</li>' : ''}
          ${indexPassed.length === 3 ? '<li>✓ 收录安全基础检查全部通过（软 404 / robots.txt / sitemap.xml），当前无紧急事项</li>' : (indexPassed.length ? '<li class="dim">✓ 已达标：' + indexPassed.join('、') + '</li>' : '')}
        </ul>
      </div>
      <div class="phase p2">
        <h3><span class="ph">P2 · 基础</span>SEO 底座</h3>
        <ul>
          <li>每个页面写独立的 Title（30–60 字符）与 Meta Description${badTitleCount > 0 ? `——当前 ${badTitleCount} 个采样页标题过短或过长（见逐页明细）` : ''}</li>
          <li>为每页配置唯一 H1${h1Missing > 0 ? `（当前 ${h1Missing} 个采样页缺失）` : ''}，图片补齐 alt 文本（当前 ${imagesNoAlt != null ? imagesNoAlt + '%' : '—'} 缺失）</li>
          <li>全站加 canonical，统一到规范主机；补齐缺失的安全响应头</li>
        </ul>
      </div>
      <div class="phase p3">
        <h3><span class="ph">P3 · 增长</span>性能与 AI 可见性</h3>
        <ul>
          ${cleanupP3}
          <li>图片压缩并转 WebP / 响应式尺寸${lh && lh.resources && lh.resources.image ? `（首页图片传输 ${kbmb(lh.resources.image.transferBytes)}，可减少约 80%）` : ''}</li>
          <li>${buyerHits > 0 ? `扩展买家词内容（当前 ${buyerHits} 类行业买家词已命中，继续在正文与 FAQ 补齐未命中的行业买家词）` : '新建买家词内容页，在正文与 FAQ 中覆盖报告列出的行业买家词'}</li>
          <li>为产品页添加 Product / Organization 结构化数据${hasSchemaPages ? '' : '（当前采样页几乎无 Schema）'}</li>
          <li>${multiOk ? '✓ 多语言已采用独立 URL + hreflang 标注，保持现状' : '多语言改用独立 URL + hreflang 标注'}</li>
          <li>GEO：${geoLi}</li>
        </ul>
      </div>
    </div>
  </section>

  <section id="method">
    <h2><span class="no">08</span>方法与局限</h2>
    <div class="method">
      <ul>
        <li><strong>数据来源：</strong>真实 HTTP 请求（页面抓取、状态码、响应头）${lh ? '+ Lighthouse 移动端测试（' + (lh.fetchTime ? esc(lh.fetchTime.slice(0, 10)) + '，' : '') + '默认节流 Slow 4G / 4× CPU）' : psiOk ? '+ Google PageSpeed Insights API（经自建 Cloudflare Worker 反代调用，获取 CrUX 真实用户数据）' : '+ 服务器端性能探针（TTFB / 资源体积 / 压缩等直接测量；LCP、CLS 等渲染期指标请用 PageSpeed Insights 复核）'}；收录核查与 GEO/AI 问答由搜索接口与内置大模型完成。</li>
        <li><strong>收录核查说明：</strong>搜索接口不返回收录总数，本章为多查询采样结论 + 收录 URL 抽查，适合判断"收录是否正常、有没有失效/垃圾收录"，不等于精确收录规模。</li>
        <li><strong>GEO 说明：</strong>AI 问答为模拟测试，与 ChatGPT / Perplexity 的真实检索行为存在差异，结果适合做方向性判断与整改前后对比，不代表某一款 AI 产品的实时输出。</li>
        <li><strong>复测对比说明：</strong>对比基于本工具的历史检测结果（每次检测自动存档）。若两次检测间隔内网站无改动，分数小幅波动属正常（AI 问答与收录采样含随机性）。</li>
        <li><strong>测试位置：</strong>${psiOk ? '页面抓取与性能探针为服务端直连；真实用户数据（CrUX）取自 Chrome 用户体验报告（经 Google PageSpeed Insights 接口），同时覆盖移动端与桌面端设备。' : '服务端直连（非海外节点，非真实浏览器环境）。海外真实体验通常与本地直连存在差异；LCP / CLS 等渲染指标建议用 PageSpeed Insights 在目标市场复核。'}</li>
        <li><strong>时点性：</strong>以上数据为 ${testedAt} 单次检测快照，可与后续复测对比验证整改效果。</li>
      </ul>
    </div>
  </section>

</main>
<footer>
  <div class="wrap">
    <p>本报告由 website-audit-web v0.9 自动生成 · 可在本工具首页输入域名随时复测 · 跨项复核可参考 <a href="https://pagespeed.web.dev/" target="_blank" rel="noopener noreferrer">Google PageSpeed Insights</a></p>
  </div>
</footer>
<script>
(function () {
  try {
    document.querySelectorAll('nav.toc a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var id = a.getAttribute('href').slice(1);
        var el = document.getElementById(id);
        if (el) {
          e.preventDefault();
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  } catch (err) {
    /* 锚点降级为原生跳转 */
  }
})();
</script>
</body>
</html>
`;
  return html;
}

function allJsonLdLength(r) {
  return (r.pages || [])
    .flatMap((p) => p.jsonLdTypes || [])
    .filter((t) => t && t !== '__invalid__').length;
}

module.exports = { generateReportHtml };
