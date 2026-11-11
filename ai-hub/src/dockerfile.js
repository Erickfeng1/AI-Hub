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

function nginxDockerfile() {
  return {
    effectiveType: "static",
    files: { "nginx.conf": NGINX_CONF },
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
    files: {},
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

  return {
    effectiveType: "python",
    files: {},
    dockerfile: `# 由企业 AI 中台生成 · Python 应用（venv + 非 root 运行）
FROM python:${PYTHON_VERSION}-slim
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PATH="/opt/venv/bin:$PATH"
ENV PORT=8000
WORKDIR /app
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
    const exposes = [...text.matchAll(/^\s*EXPOSE\s+(\d+)/gm)].map((m) => Number(m[1]));
    return { effectiveType: "docker", files: {}, dockerfile: text, port: exposes.at(-1) || 80 };
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
 * 把生成的 Dockerfile（及附属文件）写入应用目录，返回 { effectiveType, port, userProvided }。
 * 用户自带 Dockerfile 时不覆盖。
 */
export function writeDockerfile(app) {
  const userProvided = fs.existsSync(path.join(app.sourceDir, "Dockerfile"));
  const generated = generateDockerfile({ type: app.type, sourceDir: app.sourceDir });
  if (userProvided) {
    return { effectiveType: "docker", port: generated.port, userProvided: true };
  }
  fs.writeFileSync(path.join(app.sourceDir, "Dockerfile"), generated.dockerfile, "utf8");
  for (const [name, content] of Object.entries(generated.files)) {
    fs.writeFileSync(path.join(app.sourceDir, name), content, "utf8");
  }
  return { effectiveType: generated.effectiveType, port: DOCKER_PORTS[generated.effectiveType], userProvided: false };
}
