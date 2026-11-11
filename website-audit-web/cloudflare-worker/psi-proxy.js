/**
 * PSI / CrUX 反向代理 — Cloudflare Worker
 * ============================================================
 * 作用：让部署在中国大陆出口环境的服务（如 website-audit-web）
 *       能调用 Google PageSpeed Insights API 与 CrUX API。
 *       Worker 部署在 Cloudflare 海外节点上，代为请求 googleapis.com。
 *
 * 部署后环境变量（Worker → Settings → Variables）：
 *   PROXY_TOKEN  必填。调用方鉴权 token（自定义随机字符串，防止被滥用）
 *   PSI_API_KEY  可选。Google API key；配置后 Worker 自动为请求附加 key 参数
 *
 * 调用方式（base 为 Worker 的自定义域名）：
 *   GET  https://<base>/psi/v5/runPagespeed?url=https://example.com&strategy=mobile&token=<PROXY_TOKEN>
 *   POST https://<base>/crux/v4/records:queryRecord?token=<PROXY_TOKEN>   body: {"origin":"https://example.com"}
 *
 * 重要提示：
 *   - workers.dev 免费子域在中国大陆普遍不可达，请务必绑定自定义域名
 *     （Worker → Settings → Domains & Routes → Add Custom Domain）
 *   - PSI 单次调用通常 20-60 秒，Worker 免费版等待上游不计 CPU 时间，可正常使用
 * ============================================================
 */

const HOSTS = {
  psi: 'www.googleapis.com',
  crux: 'chromeuxreport.googleapis.com',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request, env) {
    // 1. 鉴权
    const url = new URL(request.url);
    const token = url.searchParams.get('token') || request.headers.get('x-proxy-token');
    if (!env || !env.PROXY_TOKEN) {
      return json({ error: 'proxy misconfigured: set PROXY_TOKEN in Worker environment variables' }, 503);
    }
    if (token !== env.PROXY_TOKEN) {
      return json({ error: 'unauthorized: missing or wrong token' }, 403);
    }
    url.searchParams.delete('token'); // 不把鉴权 token 转发给 Google

    // 2. 路径映射：/psi/v5/runPagespeed -> www.googleapis.com/pagespeedonline/v5/runPagespeed
    //             /crux/v4/records:queryRecord -> chromeuxreport.googleapis.com/v4/records:queryRecord
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) {
      return json({ error: "usage: /psi/v5/runPagespeed?url=... or /crux/v4/records:queryRecord" }, 400);
    }
    const api = parts[0];
    const host = HOSTS[api];
    if (!host) return json({ error: `unknown api '${api}', expect 'psi' or 'crux'` }, 404);

    const upstream = new URL(`https://${host}${api === 'psi' ? '/pagespeedonline/' : '/'}${parts.slice(1).join('/')}`);
    upstream.search = url.search;

    // 3. 自动注入 API key（未配置 key 时依赖 Google 免费 IP 配额，量大易 429）
    if (env.PSI_API_KEY && !upstream.searchParams.has('key')) {
      upstream.searchParams.set('key', env.PSI_API_KEY);
    }

    // 4. 转发
    let resp;
    try {
      resp = await fetch(upstream.toString(), {
        method: request.method,
        headers: { 'content-type': request.headers.get('content-type') || 'application/json' },
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
        redirect: 'follow',
      });
    } catch (e) {
      return json({ error: 'upstream fetch failed: ' + String((e && e.message) || e) }, 502);
    }

    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: {
        'content-type': resp.headers.get('content-type') || 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
    });
  },
};
