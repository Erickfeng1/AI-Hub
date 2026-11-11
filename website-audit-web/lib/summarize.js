'use strict';
/** 从 Lighthouse LHR JSON 提取报告所需的摘要 */
function summarize(lhr) {
  const a = lhr.audits || {};
  const cat = lhr.categories || {};
  const items =
    (a['resource-summary'] && a['resource-summary'].details && a['resource-summary'].details.items) || [];
  const resources = {};
  items.forEach((r) => {
    if (r.resourceType && r.resourceType !== 'Total') {
      resources[r.resourceType] = { transferBytes: r.transferSize, requests: r.requestCount };
    }
  });
  const scoreOf = (name) => Math.round(((cat[name] && cat[name].score) || 0) * 100);
  return {
    scores: {
      performance: scoreOf('performance'),
      seo: scoreOf('seo'),
      accessibility: scoreOf('accessibility'),
      bestPractices: scoreOf('best-practices'),
    },
    metrics: {
      lcpS: a['largest-contentful-paint'] ? a['largest-contentful-paint'].numericValue : null,
      fcpS: a['first-contentful-paint'] ? a['first-contentful-paint'].numericValue : null,
      cls: a['cumulative-layout-shift'] ? a['cumulative-layout-shift'].numericValue : null,
      tbtMs: a['total-blocking-time'] ? a['total-blocking-time'].numericValue : null,
      totalBytes: a['total-byte-weight'] ? a['total-byte-weight'].numericValue : null,
    },
    resources,
    runtimeError: (lhr.runtimeError && lhr.runtimeError.message) || null,
    fetchTime: lhr.fetchTime || null,
  };
}

module.exports = summarize;
