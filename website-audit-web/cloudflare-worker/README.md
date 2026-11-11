# Cloudflare Worker 反代部署（PSI / CrUX）

目的：让 website-audit-web（部署在大陆出口环境）能调用 Google PageSpeed Insights API，
自动实测 LCP / CLS 等渲染期指标，替代报告中"请手动复核"的提示。

## 为什么需要 Worker

实测确认：Coze 云端容器直连 `googleapis.com` 全部超时（TCP 层不可达）；
且 `*.workers.dev` 免费子域在大陆同样被污染不可达，因此 Worker **必须绑定自定义域名**。

## 部署步骤（约 5 分钟，Dashboard 操作，无需本地工具）

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Create Worker**，名称随意（如 `psi-proxy`）→ Deploy。
2. 点 **Edit code**，把本目录 `psi-proxy.js` 的全部内容粘贴进去，替换示例代码 → **Deploy**。
3. 配置环境变量：Worker → **Settings** → **Variables and Secrets**：
   - `PROXY_TOKEN`：自定义随机字符串（如 `openssl rand -hex 16` 生成），调用方鉴权用，**必填**
   - `PSI_API_KEY`：Google API key（[获取入口](https://console.cloud.google.com/apis/credentials)，
     需先在 Cloud Console 启用 **PageSpeed Insights API**），配置后 Worker 自动附加，避免 IP 配额 429，**建议填写**
4. 绑定自定义域名：Worker → **Settings** → **Domains & Routes** → **Add** → **Custom Domain**，
   填一个你 Cloudflare 托管域名下的子域（如 `psi.你的域名.com`）→ 绑定（DNS 自动生效）。
5. 验证（本地或云端均可）：
   ```bash
   curl -s "https://psi.你的域名.com/psi/v5/runPagespeed?url=https://www.mugroup.com&strategy=mobile&token=<PROXY_TOKEN>" | head -c 300
   ```
   返回含 `"lighthouseResult"` 即成功（约 20-60 秒）。

## 部署完成后

把两个值配置到 website-audit-web：

```bash
curl -s -X POST https://b8rtbqk5qv.coze.site/api/config \
  -H 'content-type: application/json' \
  -d '{"psiProxyBase":"https://psi.你的域名.com","psiProxyToken":"<PROXY_TOKEN>"}'
```

之后每次审计自动调用 PSI：报告性能章节会出现 **Google Lighthouse 实测（PSI API）** 区块
（LCP / CLS / TBT / FCP / TTFB / Speed Index + CrUX 28 天真实用户数据）。

## API 配置接口

- `GET  /api/config` → 查看当前配置（token 不回显）
- `POST /api/config` `{"psiProxyBase":"...","psiProxyToken":"..."}` → 保存（持久化，重启不丢）
- 不配置或调用失败时，报告自动回退为服务器端探针结果，并在 08 方法章节注明
