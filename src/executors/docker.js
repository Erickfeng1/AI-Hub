import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HUB_DOMAIN, DATA_DIR } from "../config.js";
import { writeDockerfile } from "../dockerfile.js";

/**
 * Docker 执行器（生产运行时）。
 *
 * 与 local 执行器的分工：
 *   local  —— 单机演示：应用跑在宿主机进程，中台自己按 Host 头路由并强制鉴权；
 *   docker —— 生产：应用跑在容器，Traefik 按容器 label 自动路由，鉴权经
 *             Traefik forwardAuth 中间件回调中台 /__hub__/authz（权限模型不变）。
 *
 * 因此本执行器不做宿主端口分配（Traefik 直接按容器端口转发），
 * 也不做进程 revive（docker restart 策略 + hub 重启时 docker start 双保险）。
 */

const NETWORK = process.env.HUB_NETWORK || "hub-net";
/** forwardAuth 回调地址：中台对 Traefik 容器可达的内部地址（见 infra/.env.example） */
const AUTHZ_URL = process.env.HUB_INTERNAL_URL || "http://hub:8080";
const APP_CPUS = process.env.HUB_APP_CPUS || "1";
const APP_MEMORY = process.env.HUB_APP_MEMORY || "512m";
const APP_PIDS_LIMIT = process.env.HUB_APP_PIDS_LIMIT || "256";
/** 设了 HUB_TLS_CERT_RESOLVER（如 le）时，应用路由自动挂证书解析器并 80 跳 443 */
const TLS_CERT_RESOLVER = process.env.HUB_TLS_CERT_RESOLVER || "";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).toString().slice(0, 800)));
      resolve(stdout);
    });
  });
}

function logFile(appId) {
  const dir = path.join(DATA_DIR, "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${appId}.log`);
}

export class DockerExecutor {
  constructor() {}

  /** 确保应用网络存在（Traefik 与应用都挂这张网，跨应用默认不能互访的实现基础）。
   *  每次发布都实际检查（不缓存）：compose 可能重建 hub-net，缓存的「已就绪」会害死容器。 */
  async ensureNetwork() {
    const exists = await run("docker", ["network", "inspect", NETWORK]).then(
      () => true,
      () => false,
    );
    if (!exists) await run("docker", ["network", "create", NETWORK]);
  }

  async start(app) {
    const logPath = logFile(app.id);
    const log = (line) => fs.appendFileSync(logPath, `[hub] ${line}\n`);

    // 1. Dockerfile：项目自带则尊重；否则按类型生成加固版
    const { port, userProvided } = writeDockerfile(app);
    const image = `hub-app-${app.slug}:${app.id}`;
    const container = `hub-${app.slug}`;
    const host = `${app.slug}.${HUB_DOMAIN}`;

    // 2. 网络（每次实查，防止 Traefik/compose 侧重建网络后缓存失效）
    await this.ensureNetwork();

    // 3. 清理同名残留容器后构建镜像（镜像 tag 带 appId，重复发布不冲突）
    await run("docker", ["rm", "-f", container]).catch(() => {});
    log(`docker build -t ${image} ${app.sourceDir}`);
    try {
      await run("docker", ["build", "-t", image, app.sourceDir], { timeout: 600000 });
    } catch (e) {
      log(`docker build 失败: ${e.message}`);
      throw new Error(`镜像构建失败: ${e.message}`);
    }

    // 4. 运行：Traefik label（路由 + forwardAuth 鉴权）+ 资源配额 + 降权
    const labels = [
      "traefik.enable=true",
      `traefik.http.routers.${app.slug}.rule=Host(\`${host}\`)`,
      `traefik.http.services.${app.slug}.loadbalancer.server.port=${port}`,
      // 每个应用路由都挂中台鉴权中间件：未登录/越权在网关层就被拦下
      `traefik.http.routers.${app.slug}.middlewares=${app.slug}-auth${TLS_CERT_RESOLVER ? `,${app.slug}-https` : ""}`,
      `traefik.http.middlewares.${app.slug}-auth.forwardauth.address=${AUTHZ_URL}/__hub__/authz?host=${host}`,
      `traefik.http.middlewares.${app.slug}-auth.forwardauth.authResponseHeaders=X-Forwarded-User`,
    ];
    if (TLS_CERT_RESOLVER) {
      labels.push(
        `traefik.http.routers.${app.slug}.tls.certresolver=${TLS_CERT_RESOLVER}`,
        `traefik.http.middlewares.${app.slug}-https.redirectscheme.scheme=https`,
      );
    }
    log(`docker run ${container} (port=${port}, labels=${labels.length})`);
    try {
      await this._runContainer(container, image, labels);
    } catch (e) {
      // 网络在构建期间被外部（compose down/up）重建：补建后重试一次
      if (/network/.test(e.message)) {
        log(`docker run 因网络失败，重建 ${NETWORK} 后重试: ${e.message}`);
        await run("docker", ["network", "create", NETWORK]).catch(() => {});
        try {
          await this._runContainer(container, image, labels);
        } catch (e2) {
          log(`docker run 重试仍失败: ${e2.message}`);
          throw new Error(`容器启动失败: ${e2.message}`);
        }
      } else {
        log(`docker run 失败: ${e.message}`);
        throw new Error(`容器启动失败: ${e.message}`);
      }
    }

    return {
      kind: "container",
      container,
      image,
      port,
      via: userProvided ? "docker run（项目自带 Dockerfile）" : `docker run（生成 Dockerfile · ${app.type}）`,
    };
  }

  /** docker run：固定降权与配额参数（应用容器安全边界） */
  async _runContainer(container, image, labels) {
    return run("docker", [
      "run", "-d",
      "--name", container,
      "--restart", "unless-stopped",
      "--network", NETWORK,
      "--cpus", APP_CPUS,
      "--memory", APP_MEMORY,
      "--pids-limit", APP_PIDS_LIMIT,
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      ...labels.flatMap((l) => ["--label", l]),
      image,
    ]);
  }

  async stop(app) {
    if (app.runtime?.container) {
      await run("docker", ["rm", "-f", app.runtime.container]).catch(() => {});
    }
  }

  /** hub 重启后恢复：容器还在就 docker start（另有 restart:unless-stopped 双保险） */
  async revive(app) {
    if (app.runtime?.kind !== "container" || !app.runtime.container) return app;
    const running = await run("docker", ["inspect", "-f", "{{.State.Running}}", app.runtime.container]).then(
      (s) => s.trim() === "true",
      () => false,
    );
    if (!running) await run("docker", ["start", app.runtime.container]).catch(() => {});
    return app;
  }

  /** 容器是否在运行（门户状态展示用） */
  async status(app) {
    if (app.runtime?.kind !== "container" || !app.runtime.container) return null;
    return run("docker", ["inspect", "-f", "{{.State.Running}}", app.runtime.container]).then(
      (s) => s.trim() === "true",
      () => false,
    );
  }

  /**
   * 批量查容器状态：一次 `docker ps` 拿全量，比逐个 inspect 快一个数量级。
   * 返回 Map，key 形如 `c:<容器名>`，值为是否在运行。
   * 查不到容器名的，视为不在运行（false）。
   *
   * 对账场景要扫全部应用，逐个 inspect 会产生 N 次进程调用；
   * 这里用一次 `docker ps -a --format` 拿全部容器的状态。
   */
  async statusBatch(apps) {
    const wanted = new Set(
      apps.map((a) => a.runtime?.container).filter((c) => typeof c === "string" && c),
    );
    const result = new Map();
    if (!wanted.size) return result;

    let out = "";
    try {
      out = await run("docker", ["ps", "-a", "--format", "{{.Names}}\t{{.State}}"]);
    } catch {
      // docker 命令失败：全部判为不可知（返回 null，让调用方保守处理）
      for (const name of wanted) result.set(`c:${name}`, null);
      return result;
    }
    const running = new Set();
    for (const line of out.split("\n")) {
      const [name, state] = line.trim().split("\t");
      if (!name) continue;
      if (state === "running") running.add(name);
    }
    for (const name of wanted) result.set(`c:${name}`, running.has(name));
    return result;
  }
}
