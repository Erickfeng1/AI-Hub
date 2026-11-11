'use strict';
/**
 * website-audit-web 控制台服务
 * - GET  /                 前端界面
 * - GET  /styles/main.css  样式
 * - GET  /output/<file>    检测产物（JSON / HTML 报告）
 * - GET  /api/health       健康检查（含常驻 Chrome 可用性）
 * - POST /api/audit        创建检测任务 {url}
 * - GET  /api/task/<id>    任务状态与结果
 * - GET  /api/tasks        最近任务列表
 * - GET  /api/report/<id>  完整 HTML 报告（内存缓存）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runAudit, chromeReady, OUT_DIR } = require('./lib/audit-core');

const PORT = Number(process.env.DEPLOY_RUN_PORT || process.env.PORT || 8000);
const ROOT = __dirname;
const CHROME_PORT = Number(process.env.AUDIT_CHROME_PORT || 9222);
const MAX_CONCURRENT = 1; // Lighthouse 资源重，单并发 + 排队

/** @type {Map<string, string>} taskId -> report HTML（内存缓存，最多 50 份，服务重启即清空） */
const reportCache = new Map();
function cacheReport(id, html) {
  reportCache.set(id, html);
  if (reportCache.size > 50) reportCache.delete(reportCache.keys().next().value);
}

/** @type {Map<string, any>} */
const tasks = new Map();
const queue = [];
let running = 0;

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      body += c;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ---- PSI 反代配置（持久化到输出目录，重启不丢；环境变量作为兜底） ----
const PSI_CONFIG_FILE = path.join(OUT_DIR, 'psi-config.json');
function readPsiConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(PSI_CONFIG_FILE, 'utf8'));
    if (c && c.base) return c;
  } catch (e) {
    /* 未配置或读取失败 */
  }
  if (process.env.PSI_PROXY_BASE) {
    return { base: process.env.PSI_PROXY_BASE, token: process.env.PSI_PROXY_TOKEN || '' };
  }
  // 容器重启会清空 output/ 目录（psi-config.json 易失），最终兜底为内置默认配置，保证 PSI 能力永不静默失效
  return { base: 'https://psi.unilink.icu', token: 'bac513724347c6fcee2343d44066ded2' };
}
function writePsiConfig(cfg) {
  fs.mkdirSync(path.dirname(PSI_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(PSI_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function safeStatic(baseDir, relName, res) {
  const full = path.resolve(baseDir, relName);
  if (!full.startsWith(path.resolve(baseDir) + path.sep) && full !== path.resolve(baseDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(full).toLowerCase();
    const type =
      ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.json' ? 'application/json; charset=utf-8'
      : ext === '.pdf' ? 'application/pdf'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function normalizeTarget(raw) {
  let u = String(raw || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try {
    parsed = new URL(u);
  } catch (e) {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
  return parsed.toString();
}

function startNext() {
  if (running >= MAX_CONCURRENT || queue.length === 0) return;
  const task = queue.shift();
  running += 1;
  task.status = 'running';
  const onProgress = (p) => {
    task.stages.push(Object.assign({ at: Date.now() }, p));
  };
  runAudit(task.url, { onProgress, previous: task.previous, psi: readPsiConfig() })
    .then((result) => {
      if (result.reportHtml) {
        cacheReport(task.id, result.reportHtml);
        delete result.reportHtml; // 体积较大，不随任务状态接口重复下发
      }
      result.reportUrl = `/api/report/${task.id}`;
      task.status = 'done';
      task.result = result;
      task.endedAt = Date.now();
    })
    .catch((e) => {
      task.status = 'error';
      task.error = String((e && e.message) || e);
      task.endedAt = Date.now();
    })
    .finally(() => {
      running -= 1;
      startNext();
    });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = u.pathname;

  try {
    if (pathname === '/' && req.method === 'GET') {
      return safeStatic(ROOT, 'index.html', res);
    }
    if (pathname === '/styles/main.css' && req.method === 'GET') {
      return safeStatic(path.join(ROOT, 'styles'), 'main.css', res);
    }
    if (pathname.startsWith('/output/') && req.method === 'GET') {
      return safeStatic(OUT_DIR, decodeURIComponent(pathname.slice('/output/'.length)), res);
    }
    if (pathname === '/api/health' && req.method === 'GET') {
      const chrome = await chromeReady(CHROME_PORT);
      return json(res, 200, { ok: true, chrome, running, queued: queue.length });
    }
    if (pathname === '/api/config' && req.method === 'GET') {
      const c = readPsiConfig();
      return json(res, 200, { psiProxyBase: (c && c.base) || null, hasToken: !!(c && c.token) });
    }
    if (pathname === '/api/config' && req.method === 'POST') {
      let parsed = {};
      try {
        parsed = JSON.parse((await readBody(req)) || '{}');
      } catch (e) {
        return json(res, 400, { error: '请求体必须是 JSON' });
      }
      let base = String(parsed.psiProxyBase != null ? parsed.psiProxyBase : '').trim();
      const token = String(parsed.psiProxyToken != null ? parsed.psiProxyToken : '').trim();
      if (base) {
        try {
          const u = new URL(base);
          if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
        } catch (e) {
          return json(res, 400, { error: 'psiProxyBase 必须是合法的 http(s) URL' });
        }
      } else {
        const cur = readPsiConfig();
        base = (cur && cur.base) || '';
      }
      if (!base) return json(res, 400, { error: 'psiProxyBase 不能为空' });
      writePsiConfig({ base, token });
      return json(res, 200, { ok: true, psiProxyBase: base, hasToken: !!token });
    }
    if (pathname === '/api/audit' && req.method === 'POST') {
      const body = await readBody(req);
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch (e) {
        return json(res, 400, { error: '请求体必须是 JSON' });
      }
      const target = normalizeTarget(parsed.url);
      if (!target) {
        return json(res, 400, { error: '请输入有效的网站地址，例如 https://www.example.com' });
      }
      const host = new URL(target).hostname;
      // 浏览器本地带来的上次结果（瘦身格式），用于复测对比
      const prev = parsed.previous && typeof parsed.previous === 'object' ? parsed.previous : null;
      const carryPrevious =
        prev && prev.scores && prev.testedAt
          ? {
              testedAt: prev.testedAt,
              scores: prev.scores,
              keyNumbers: prev.keyNumbers || {},
              pages: Array.isArray(prev.pages) ? prev.pages.map((p) => ({ url: (p && p.url) || '' })) : [],
            }
          : null;
      const id = crypto.randomUUID();
      const task = {
        id,
        url: target,
        host,
        status: 'queued',
        stages: [],
        previous: carryPrevious,
        createdAt: Date.now(),
      };
      tasks.set(id, task);
      queue.push(task);
      startNext();
      return json(res, 200, { taskId: id, host });
    }
    if (pathname.startsWith('/api/task/') && req.method === 'GET') {
      const id = pathname.slice('/api/task/'.length);
      const task = tasks.get(id);
      if (!task) return json(res, 404, { error: '任务不存在' });
      return json(res, 200, {
        id: task.id,
        url: task.url,
        host: task.host,
        status: task.status,
        stages: task.stages,
        result: task.result || null,
        error: task.error || null,
        createdAt: task.createdAt,
        endedAt: task.endedAt || null,
      });
    }
    if (pathname.startsWith('/api/report/') && req.method === 'GET') {
      const id = pathname.slice('/api/report/'.length);
      const html = reportCache.get(id);
      if (!html) return json(res, 404, { error: '报告不存在或已过期（报告保存在服务内存中，服务重启后失效）' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (pathname === '/api/tasks' && req.method === 'GET') {
      const list = [...tasks.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10)
        .map((t) => ({
          id: t.id,
          host: t.host,
          status: t.status,
          createdAt: t.createdAt,
          reportUrl: t.result ? t.result.reportUrl : null,
        }));
      return json(res, 200, { tasks: list });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    if (!res.headersSent) {
      json(res, 500, { error: String((e && e.message) || e) });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[website-audit-web] listening on http://127.0.0.1:${PORT}`);
});
