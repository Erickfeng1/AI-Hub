# ai-hub · 企业 AI 中台 MVP

**中台即 MCP，Agent 即部署通道。** 员工把两段 Prompt 发给自己的 Agent（Claude / Codex / 任意 MCP 客户端），即可把 VibeCoding 项目发布到公司中台：自动识别类型、隔离运行、分配子域名、绑定权限。

本仓库是方案的可运行垂直切片：用最薄的技术栈端到端验证「Agent 通过 MCP 发布应用」这一核心假设，并已补齐**身份层、权限强制、Python 运行时、HTTP 接入**。

## 快速开始

环境要求：Node.js ≥ 20 + Python 3（无需 Docker；Docker 为可选的生产运行时）。

```bash
# 1. 一键演示：两名用户登录 → Agent 绑定身份发布 → 权限强制 → Python 应用 → HTTP 接入
node scripts/agent-client.mjs

# 2. Skill 管理演示：发布 → 版本检查 → 升级 → 更新提醒 → 权限 → 下线（11 项断言）
node scripts/skill-e2e.mjs

# 3. Skill 分发闭环演示：整包导出（base64/下载）→ 权限 → 留痕 → 三触点更新提醒（21 项断言）
node scripts/skill-dist-e2e.mjs

# 4. 播种演示数据（两个应用 + 一个 Skill），供门户浏览
node scripts/seed-demo.mjs

# 5. HTTP 端闭环：发布 → 访问 → 下线（通过 /mcp）
node scripts/http-e2e.mjs

# 6. 常驻启动中台（门户 + 子域名路由 + 权限强制 + 应用恢复）
node scripts/dev-server.mjs

# 7. 下架（删除）端到端验证：按钮可见性 → 越权/匿名/CSRF 拒绝 → 正常下架 → 目录与数据清理（22 项断言）
node scripts/unpublish-e2e.mjs
```

演示脚本的关键断言（全部通过才算成功）：

```
✅ 匿名访问被拦截 — HTTP 401
✅ 其他用户访问被拒绝 — HTTP 403
✅ 发布者本人可访问 — HTTP 200
✅ 全员可见后其他用户可访问 — HTTP 200
✅ 白名单同事（方科）可访问 — HTTP 200 · flask PID …
✅ HTTP 传输可用且身份一致 — whoami → 方科
```

## 使用方式

启动后访问门户 **http://localhost:8080**。未登录时展示开发登录表单（输入姓名/部门即可，生产环境此处为「飞书登录」按钮），登录后页面显示当前身份与用户令牌，应用广场只显示**权限范围内**的应用。

两段 Prompt 在门户页面内可直接复制：

1. **第一段（连接中台）**：`connect`（stdio 或 HTTP `/mcp`），传入 `userToken` 把 Agent 绑定到你的身份；
2. **第二段（发布应用）**：`publish_app`，传入 `projectPath` 与 token；应用名与权限范围（self / department / users / all）由 Agent 询问用户后传入。

### 接入真实 Agent

stdio（本地 Agent，如 Claude Code / Codex）：

```json
{
  "mcpServers": {
    "ai-hub": {
      "command": "node",
      "args": ["/绝对路径/ai-hub/src/mcp-server.js"]
    }
  }
}
```

Streamable HTTP（远程 Agent，任意支持 MCP 的客户端）：

```json
{
  "mcpServers": {
    "ai-hub": { "type": "http", "url": "http://localhost:8080/mcp" }
  }
}
```

HTTP 端无会话状态（stateless），每次请求独立传输，状态全部落 `data/store.json`，可横向扩展。

### 真实 Agent 验收（2026-10-18，本机 Claude Code CLI 2.1.178 实测通过）

已用真实 Claude Agent 跑通两段 Prompt 全流程：

```bash
# 注册（stdio 与 HTTP 两种方式都验证过连通）
claude mcp add ai-hub -s user -- node /绝对路径/ai-hub/src/mcp-server.js
claude mcp add ai-hub-http -s user --transport http http://localhost:8080/mcp

# 第一段 Prompt（发给 Agent）
# 请连接企业 AI 中台：调用 ai-hub MCP 的 connect 工具，agentName 传「我的Agent」。

# 第二段 Prompt（在 VibeCoding 项目文件夹下发给 Agent）
# 请调用 publish_app，projectPath = <项目绝对路径>，agentToken = connect 返回的 token。
# 应用名和权限范围（self/department/users/all）先问我，不要擅自决定。
```

实测结果：Agent 自动识别静态项目类型、从 HTML title 提取应用名「会议室预约看板」、自动分配子域名 `http://<slug>.localhost:8080`，发布者带 token 访问 200、匿名访问 302 登录页；Skill 链路同样通过——`check_skill_version` 留痕、平台升级后 `list_skills` 标注 `有更新: true`、`export_skill` 导出整包（含附属脚本）解压可用。

### MCP 工具集（14 个）

| 工具 | 作用 |
|---|---|
| `connect` | 注册 Agent、绑定用户身份（userToken）、返回访问令牌 |
| `whoami` | 查询当前令牌绑定的身份与部门 |
| `publish_app` | 发布应用：类型识别 → 依赖锁审查 → 隔离运行 → 子域名 → 权限落库 |
| `list_apps` | 列出**当前身份可见**的应用 |
| `get_app` | 查看应用详情（越权即拒） |
| `set_app_permission` | 改权限（仅发布者） |
| `unpublish_app` | 下线并清理（仅发布者，跨进程杀进程） |
| `publish_skill` | 发布 Skill（同名再发布=版本更新，旧版归档，版本必须递增） |
| `list_skills` | 列出**当前身份可见**的 Skill |
| `get_skill` | Skill 详情：版本历史、文件清单、SKILL.md 全文（越权即拒） |
| `check_skill_version` | 本地 vs 平台版本比对：up-to-date / platform-newer（提醒更新）/ local-newer / not-published；同时把「本地已装版本」留痕 |
| `set_skill_permission` | 改 Skill 权限（仅发布者） |
| `unpublish_skill` | 下线 Skill（仅发布者） |
| `export_skill` | 导出 Skill 完整整包（tar.gz）：小包返回 base64 内容（Agent 解压即用），大包返回带令牌的下载链接 |

## Skill 管理

中台同时是 Skill 的分发中心（对应文章里「应用与 Skill 两大 Tab」）：

- **Skill 格式**：一个含 `SKILL.md` 的目录，frontmatter 需有 `name` / `description` / `version`（见 `fixtures/skill-demo/`）；
- **版本规则**：同一发布者的同名 Skill 再发布即版本更新——显式版本必须高于平台当前版本；省略 `version` 时自动递增补丁号；旧版本自动归档到 `data/skills/<id>/archive/<version>/`，历史可在 `get_skill` 查看。升级发布时**未显式传权限则继承原权限**，不会把已设为「全员可见」的 Skill 打回 private；
- **更新提醒**：`check_skill_version` 对比本地目录与平台收录版本，平台较新时明确提示「建议更新」；
- **权限**：与应用同一套 `canView` 模型（self / department / users / all），`get_skill` 越权即拒。

### Skill 分发（导出 + 主动更新提醒）

上传只是上半场，下载使用与保持同步才是下半场：

- **整包导出**：`export_skill` 把 Skill 完整目录（SKILL.md + scripts/ 等附属文件）打包为 tar.gz——1MB 以内直接返回 base64 内容，Agent 解压即用；更大的包返回下载链接 `http://<hub>/__hub__/skills/<id>/export?ah_token=<用户令牌>`（带 Content-Disposition，可直接 `curl -O`）。导出走完整的鉴权链路：匿名 401、越权 403。打包时会把整包内 SKILL.md 的 `version` 字段改写为平台版本号，确保用户安装后本地版本号与平台一致（否则会死循环收到更新提醒）；
- **版本留痕**：用户（或 Agent）调用 `check_skill_version` 时，平台记录「该用户本地已装版本」，作为后续比对基准；
- **主动提醒的三个触点**：
  1. `list_skills` 每条带 `本地已装版本` 与 `有更新` 字段；
  2. `connect` 返回 `待更新Skill` 清单——Agent 一连上中台就知道要提醒用户更新；
  3. 门户「Skill 库」卡片显示「有新版本 · 本地 vX」徽标，卡片附「下载」按钮。
- 无留痕的用户不会误报（王五场景：可见但 `有更新=false`）。

门户「Skill 库」分区按身份过滤展示，并提供「发布 / 检查 / 导出 Skill」Prompt 片段。

## 身份与权限模型

身份层是可插拔的 Provider（`src/identity.js`），生产切换只改环境变量：

| 环境变量 | 说明 |
|---|---|
| `HUB_IDENTITY_PROVIDER=dev` | 默认。门户开发登录表单，无需真实 OAuth，便于本地多用户测试 |
| `HUB_IDENTITY_PROVIDER=feishu` | 飞书 OAuth。需配 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_REDIRECT_URI`，自动拉取用户信息与部门 |
| `HUB_COOKIE_DOMAIN=.corp.net` | 生产域名下设置，使 Cookie 透传所有子域名应用（localhost 下 Cookie 不透传，门户链接自动带 `?ah_token=` 兜底） |
| `HUB_PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/` | Python 应用的 pip 镜像源。官方 PyPI 不可达时（受限网络/内网）走镜像，避免 pip 重试到超时；留空则用官方源 |

飞书 OAuth 联调步骤（平台配置、权限清单、逐项检查清单、常见坑）见 `outputs/飞书OAuth联调指南.md`；环境变量模板 `ai-hub/.env.feishu.example`（复制为 `.env.feishu` 填入真实值，已被 gitignore）。

权限规则（`canView`）：`all`=任何登录用户；`self`=仅发布者；`department`=同部门；`users`=白名单（姓名或用户 ID）。发布者可随时改权限，立即生效。

访问应用子域名时的鉴权链路：解析身份（Cookie / Bearer 用户令牌或 Agent 令牌 / `?ah_token=`）→ 匿名：HTML 请求 302 登录页、API 请求 401 → 越权：403 → 放行：静态托管或反代到应用进程。

**下架（删除）**：门户「应用广场」与「Skill 库」的卡片上，**仅发布者**能看到「下架」按钮（与后端 `canManage` 判定一致），点击后弹出确认框，确认即停止运行 + 清理文件 + 从 store 移除。也可由 Agent 调用 MCP 工具 `unpublish_app` / `unpublish_skill`。破坏性操作有 CSRF 防护：Cookie 会话必须携带与该会话匹配的 csrf 令牌（跨站提交会被 403 拒绝）；Bearer / `?ah_token=` 属显式携带凭据，天然免疫 CSRF，服务端不再要求令牌。

## 架构

```
员工 Agent ──stdio──> MCP Server（src/mcp-server.js → mcp-core.js）
   │                      │ publish_app / connect / set_app_permission / …
   └──HTTP /mcp──> Router 挂载 StreamableHTTPTransport（src/router.js）
                          ▼
                   Deployer 流水线（src/deployer.js）
                   识别类型 → 依赖锁审查 → 暂存 → 执行器启动 → 子域名 → 权限落库
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
      LocalExecutor（MVP）      DockerExecutor（生产）
      静态：路由直接托管        docker build + run + Traefik labels
      Node：npm start 子进程     一应用一容器，资源配额，网络隔离
      Python：venv + pip，
        Flask/FastAPI/Django
                          ▼
                Router（src/router.js）
                Host 头路由 <slug>.localhost:8080
                门户页（登录 / 应用广场 / Skill 库 / Prompt 指引 / Agent 列表）
                权限强制（401 / 403）
                Skill 整包导出端点（/__hub__/skills/<id>/export）
                下架端点（/__hub__/apps/<id>/unpublish、/__hub__/skills/<id>/unpublish）
```

状态存于 `data/store.json`（应用、Agent、用户、会话、权限、Skill、Skill 安装留痕），应用源码暂存于 `data/apps/<app_id>/source`，venv 在 `data/apps/<app_id>/venv`，Skill 源在 `data/skills/<skill_id>/source`，进程日志在 `data/logs/`。

## 当前 Mock 与生产路径对照

| 维度 | MVP（本仓库） | 生产路径 |
|---|---|---|
| 身份 | dev 登录表单 | 飞书 OAuth（`HUB_IDENTITY_PROVIDER=feishu`），部门实时同步 |
| MCP 传输 | stdio + HTTP `/mcp`（均已实现） | HTTPS + 公司域名 + 网关鉴权 |
| 运行时 | 本地进程 / 静态托管 | Docker 容器（`HUB_EXECUTOR=docker`） |
| 子域名路由 | 内置 Router（Host 头） | Traefik（见 docker-compose.yml） |
| 域名 | `*.localhost` | `*.corp.net`（设 `HUB_DOMAIN=corp.net`） |
| 门户 | 单页（登录 + 应用广场 + Prompt） | 完整门户（Skill / 资料库 / 千人千面首页） |
| 权限 | JSON + Provider 判定 | 同左 + 飞书组织架构实时校验 |
| 依赖审查 | 锁文件检查 + 警告 | 构建沙箱 + 哈希强制 + 漏洞扫描 |

切换到 Docker 运行时：`HUB_EXECUTOR=docker HUB_DOMAIN=corp.net node scripts/dev-server.mjs`（需 Docker 守护进程与 `hub-net` 网络）。

**部署到 Linux 服务器**（一键脚本，含环境体检、配置生成、Traefik 启动、systemd 守护）：

```bash
cd infra && sudo ./deploy.sh --domain hub.example.com --email ops@example.com
```

`--dry-run` 可先预览它要做什么。完整说明、排障手册与安全边界见 `outputs/生产部署指南.md`。

## 目录结构

```
ai-hub/
├── src/
│   ├── mcp-core.js           # MCP 工具定义 + 处理器（stdio/HTTP 共用，产品核心 IP）
│   ├── mcp-server.js         # stdio 入口（本地 Agent spawn）
│   ├── identity.js           # 身份层：Provider 接口 + dev/飞书 + 会话 + canView
│   ├── deployer.js           # 发布流水线 + 依赖锁审查
│   ├── skills.js             # Skill 管理器：解析/版本比对/发布更新/归档
│   ├── router.js             # Host 头路由 + 门户 + 登录 + 权限强制 + /mcp 挂载
│   ├── executors/            # local.js（MVP）/ docker.js（生产）
│   ├── detect.js             # 项目类型与入口识别（Node/Python 框架）
│   ├── store.js              # JSON 持久化
│   └── config.js             # 域名/端口/URL 规则
├── fixtures/                 # 演示应用（静态 + Node + Python/Flask）+ Skill 夹具
├── scripts/
│   ├── agent-client.mjs      # 端到端演示（身份/权限/Python/HTTP，9 项断言）
│   ├── skill-e2e.mjs         # Skill 管理端到端演示（11 项断言）
│   ├── skill-dist-e2e.mjs    # Skill 分发闭环演示（导出/留痕/更新提醒，21 项断言）
│   ├── seed-demo.mjs         # 播种演示数据（2 应用 + 1 Skill）
│   ├── http-e2e.mjs          # HTTP 端发布→访问→下线闭环
│   └── dev-server.mjs        # 常驻启动 + 应用恢复
├── docker-compose.yml        # 生产拓扑（Traefik + hub）
└── Dockerfile
```

## 部署到自己的服务器

代码本体只有 **88KB**（压缩包），一条命令打包：

```bash
./infra/pack.sh                       # → ai-hub-deploy-<时间戳>.tar.gz
./infra/pack.sh --with-data           # 连历史用户/应用/Skill 一起带走（迁移场景）
```

上传并在服务器上部署：

```bash
scp ai-hub-deploy-*.tar.gz user@your-server:/tmp/
# 服务器上
tar xzf /tmp/ai-hub-deploy-*.tar.gz -C /opt && cd /opt/ai-hub
npm install --omit=dev
cd infra && sudo ./deploy.sh --domain hub.example.com --email ops@example.com
```

`deploy.sh` 幂等，依次做 6 件事：环境体检 → 生成 `infra/.env`（含 Cookie 域 / forwardAuth 地址）→ 生成 Traefik 门户路由 → 拉起网关 → 装 systemd 守护 → 打印验收清单。

**8080 被别的应用占了怎么办**：换端口即可，中台端口从不对公网开放，用户侧 URL 完全无感。

```bash
./deploy.sh --domain hub.example.com --port 8099     # 手工指定
./deploy.sh --domain hub.example.com --auto-port     # 自动挑空闲端口
```

打包脚本**故意排除**：`node_modules/`（本机软链，服务器上现装）、`.env*`（含飞书 App Secret，绝不能进包）、`data/`（默认不带，51M 构建产物）。完整说明与排障手册见 `outputs/生产部署指南.md`。

## 已知限制（MVP 边界）

- 飞书 OAuth 路径已实现但未做真实联调（需企业自建应用凭证）；dev Provider 全流程可测；
- Python 应用需自行读取 `PORT` 环境变量（Flask 夹具已示范）；Django 自动 `runserver`；
- 中文名的子域名/slug 退化为确定性哈希后缀（同名永远同 slug；生产用拼音/LLM 命名补齐）；
- MCP Server 退出后，由其拉起的子进程随之结束；重新运行 `dev-server.mjs` 会自动恢复（端口不变）；
- 无构建沙箱与强制哈希（生产必做，当前依赖审查仅锁文件检查与警告）。

## 下一步（按优先级）

1. 接入真实 MCP 客户端（Claude Code / Codex）实测两段 Prompt 体验；
2. 飞书 OAuth 真实联调 + 组织架构同步（代码已就位，缺凭证）；
3. 资料库（品牌 VI / 组件规范结构化）+ 千人千面首页；
4. 构建沙箱 + 依赖哈希强制 + 容器资源配额，Docker 执行器 + Traefik 落地；
5. Skill 导出增强：平台侧推送通道（如飞书机器人通知待更新）、按用户维度的安装统计。
