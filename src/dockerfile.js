import fs from "node:fs";
import path from "node:path";
import { readPkg, detectNodeEntry, detectPythonEntry } from "./detect.js";

/**
 * Dockerfile 生成器（生产运行时的核心）。
 *
 * 设计原则：
 * 1. 项目自带 Dockerfile 时尊重原样（detectProject 已将其识别为 docker 类型）；
 * 2. 否则按类型生成「加固版」Dockerfile：非 root 运行、无构建缓存、锁文件感知安装；
 * 3. 与 local 执行器的降级规则保持一致：Node 无入口 / Python 无框架 → nginx 静态镜像；
 * 4. 容器内监听端口固定（Traefik 按容器端口转发，不再需要宿主端口分配）。
 */

export const DOCKER_PORTS = { static: 8080, node: 3000, python: 8000, docker: 80 };

const NGINX_VERSION = "1.27";
const NODE_VERSION = "22";
const PYTHON_VERSION = "3.12";

/**
 * 平台自己生成的 Dockerfile 都带这个标记。
 * 用途：区分「用户手写的 Dockerfile」（尊重原样）与「平台早期版本生成的 Dockerfile」。
 * 后者必须随加固模板升级重新生成——旧版是 root 运行 + EXPOSE 80，
 * 与当前运行时（--cap-drop ALL + 非 root + 8080）不兼容，容器会起不来。
 */
const PLATFORM_GENERATED_RE = /^#\s*由企业 AI 中台生成/m;

/** pip 安装源：默认走国内镜像（与 local 执行器一致），可用 HUB_PIP_INDEX_URL 覆盖；设为空串则用官方源。 */
function pipIndexUrl() {
  const v = process.env.HUB_PIP_INDEX_URL;
  if (v === undefined) return "https://mirrors.aliyun.com/pypi/simple/";
  return v.trim();
}

// 静态应用监听 8080（非特权端口）并以 nginx 用户直接运行：
// 这样容器无需 CAP_NET_BIND_SERVICE / CAP_CHOWN，配合 --cap-drop ALL 全量降权。
// 代价是构建时要替 nginx 用户准备好缓存/日志/pid（官方镜像靠 entrypoint 以 root 做这些）。
// 注意：conf.d 下的文件处于 http 上下文，pid 等主上下文指令不能放这里。
const NGINX_CONF = `server {
  listen 8080;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
  access_log /dev/stdout;
  error_log /dev/stderr warn;
  location / {
    try_files $uri $uri/ /index.html;
  }
}
`;

function has(sourceDir, f) {
  return fs.existsSync(path.join(sourceDir, f));
}

/**
 * 构建上下文清理清单。
 * 重点排除 macOS AppleDouble 残留（._*）——从 Mac 打包上传的源码里普遍存在，
 * 会被 COPY 进镜像，既增大体积又在 Python 应用里干扰模块扫描。
 * 同时排除本地 venv / node_modules / 构建缓存，避免把开发机产物带进生产镜像。
 */
const DOCKERIGNORE = `# 由企业 AI 中台生成 · 构建上下文清理
**/._*
**/.DS_Store
**/Thumbs.db
**/.git
**/.gitignore
**/node_modules
**/venv
**/.venv
**/__pycache__
**/*.pyc
**/.pytest_cache
**/.mypy_cache
**/dist
**/build
**/.next
**/coverage
**/.env
**/.env.*
**/*.log
`;

function nginxDockerfile() {
  return {
    effectiveType: "static",
    files: { "nginx.conf": NGINX_CONF, ".dockerignore": DOCKERIGNORE },
    dockerfile: `# 由企业 AI 中台生成 · 静态应用（nginx，非 root 运行）
FROM nginx:${NGINX_VERSION}-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
# 官方镜像的缓存/日志/pid 属 root（原本由 entrypoint chown）；非 root 运行前先准备好
RUN mkdir -p /var/cache/nginx \\
    && chown -R nginx:nginx /var/cache/nginx /var/log/nginx \\
    && touch /var/run/nginx.pid \\
    && chown nginx:nginx /var/run/nginx.pid
USER nginx
EXPOSE 8080
`,
  };
}

function nodeDockerfile(sourceDir, entry) {
  // 锁文件感知：有锁用确定性安装，无锁退化为 install（依赖审查已在发布时告警）
  let install;
  let copyFirst;
  if (has(sourceDir, "package-lock.json") || has(sourceDir, "npm-shrinkwrap.json")) {
    install = "npm ci --omit=dev --no-audit --no-fund && npm cache clean --force";
    copyFirst = "package.json package-lock.json npm-shrinkwrap.json";
  } else if (has(sourceDir, "yarn.lock")) {
    install = "yarn install --production --frozen-lockfile && yarn cache clean";
    copyFirst = "package.json yarn.lock";
  } else if (has(sourceDir, "pnpm-lock.yaml")) {
    install = "corepack enable && pnpm install --prod --frozen-lockfile";
    copyFirst = "package.json pnpm-lock.yaml";
  } else {
    install = "npm install --omit=dev --no-audit --no-fund && npm cache clean --force";
    copyFirst = "package.json";
  }
  const cmd = entry.cmd[0] === "npm" ? `CMD ["npm", "start"]` : `CMD ${JSON.stringify(entry.cmd)}`;
  return {
    effectiveType: "node",
    files: { ".dockerignore": DOCKERIGNORE },
    dockerfile: `# 由企业 AI 中台生成 · Node 应用（非 root 运行）
FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
# 先拷依赖清单，利用构建缓存：依赖不变则跳过安装层
COPY ${copyFirst} ./
RUN ${install}
COPY --chown=node:node . .
USER node
EXPOSE 3000
${cmd}
`,
  };
}

function pythonDockerfile(sourceDir, entry) {
  const pipLines = ["python -m venv /opt/venv", "/opt/venv/bin/pip install --no-cache-dir --upgrade pip"];
  if (has(sourceDir, "requirements.txt")) pipLines.push("/opt/venv/bin/pip install --no-cache-dir -r requirements.txt");
  if (has(sourceDir, "pyproject.toml")) pipLines.push("/opt/venv/bin/pip install --no-cache-dir .");
  if (entry.needsUvicorn) pipLines.push("/opt/venv/bin/pip install --no-cache-dir uvicorn");

  let cmd;
  if (entry.kind === "uvicorn") {
    cmd = `CMD ["/opt/venv/bin/uvicorn", "${entry.module}:app", "--host", "0.0.0.0", "--port", "8000"]`;
  } else if (entry.kind === "flask") {
    cmd = `CMD ["/opt/venv/bin/python", "${entry.file}"]`;
  } else {
    cmd = `CMD ["/opt/venv/bin/python", "manage.py", "runserver", "0.0.0.0:8000", "--noreload"]`;
  }

  // pip 源用环境变量声明（不塞进命令行）：命令保持标准形态，便于审计与复现；
  // 国内服务器走镜像源，官方源下载慢导致构建超时的问题就此消除。
  const index = pipIndexUrl();
  const indexEnv = index ? `ENV PIP_INDEX_URL=${index}\n` : "";

  return {
    effectiveType: "python",
    files: { ".dockerignore": DOCKERIGNORE },
    dockerfile: `# 由企业 AI 中台生成 · Python 应用（venv + 非 root 运行）
FROM python:${PYTHON_VERSION}-slim
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PATH="/opt/venv/bin:$PATH"
ENV PORT=8000
${indexEnv}WORKDIR /app
RUN useradd --create-home --uid 10001 appuser
COPY --chown=appuser:appuser . /app
RUN ${pipLines.join(" \\\n    && ")}
USER appuser
EXPOSE 8000
${cmd}
`,
  };
}

/**
 * 生成（但不落盘）Dockerfile。返回 { effectiveType, files, dockerfile }；
 * effectiveType 可能与应用类型不同（降级场景），决定容器端口。
 */
export function generateDockerfile({ type, sourceDir }) {
  if (type === "docker") {
    // 项目自带 Dockerfile：容器端口从 EXPOSE 推断，识别不出按 80
    const text = fs.readFileSync(path.join(sourceDir, "Dockerfile"), "utf8");
    return { effectiveType: "docker", files: {}, dockerfile: text, port: inferPortFromDockerfile(text) };
  }
  if (type === "node") {
    const pkg = readPkg(sourceDir);
    const entry = detectNodeEntry(sourceDir, pkg);
    if (!entry) return nginxDockerfile(); // 与 local 执行器一致的降级
    return nodeDockerfile(sourceDir, entry);
  }
  if (type === "python") {
    const entry = detectPythonEntry(sourceDir);
    if (!entry) return nginxDockerfile();
    return pythonDockerfile(sourceDir, entry);
  }
  return nginxDockerfile();
}

/**
 * 从 Dockerfile 文本里推断容器监听端口：取最后一个 EXPOSE，识别不出按 80。
 */
export function inferPortFromDockerfile(text) {
  const exposes = [...text.matchAll(/^\s*EXPOSE\s+(\d+)/gm)].map((m) => Number(m[1]));
  return exposes.at(-1) || 80;
}

/**
 * 判断 Dockerfile 是否由平台生成（而非用户手写）。
 * 平台生成的会随加固模板升级重新生成，避免旧镜像与当前降权运行时冲突。
 */
export function isPlatformGenerated(text) {
  return PLATFORM_GENERATED_RE.test(text);
}

/**
 * 把生成的 Dockerfile（及附属文件）写入应用目录，返回 { effectiveType, port, userProvided }。
 *
 * 三种情况：
 * 1. 用户手写 Dockerfile —— 尊重原样，端口从其 EXPOSE 推断；
 * 2. 平台旧版生成的 Dockerfile —— 按当前加固模板重新生成（否则与 --cap-drop ALL 不兼容）；
 * 3. 全新应用 —— 按类型生成加固版。
 */
export function writeDockerfile(app) {
  const dfPath = path.join(app.sourceDir, "Dockerfile");
  const existing = fs.existsSync(dfPath) ? fs.readFileSync(dfPath, "utf8") : null;

  // 用户手写：尊重原样。端口必须从它自己的 EXPOSE 推断（不能沿用 DOCKER_PORTS[type]，
  // 否则 type 与实际暴露端口不一致时 Traefik 会转发到错误端口）。
  if (existing !== null && !isPlatformGenerated(existing)) {
    return { effectiveType: "docker", port: inferPortFromDockerfile(existing), userProvided: true };
  }

  // 平台生成（含旧版）：按当前模板重新生成，走类型对应的标准端口。
  const generated = generateDockerfile({ type: app.type, sourceDir: app.sourceDir });
  fs.writeFileSync(dfPath, generated.dockerfile, "utf8");
  for (const [name, content] of Object.entries(generated.files)) {
    // 用户自己的 .dockerignore 不覆盖，只在缺失时补平台清理清单
    const target = path.join(app.sourceDir, name);
    if (name === ".dockerignore" && fs.existsSync(target)) continue;
    fs.writeFileSync(target, content, "utf8");
  }
  return { effectiveType: generated.effectiveType, port: DOCKER_PORTS[generated.effectiveType], userProvided: false };
}
