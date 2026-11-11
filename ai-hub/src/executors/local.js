import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { readPkg, detectNodeEntry, detectPythonEntry } from "../detect.js";
import { findFreePort, waitPort, portBusy, isAlive, resolveBin, nowIso } from "../util.js";

function logFile(appId) {
  const dir = path.join(DATA_DIR, "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${appId}.log`);
}

function runCmd(bin, args, { cwd, timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${path.basename(bin)} ${args.join(" ")} 失败: ${(stderr || stdout || err.message).toString().slice(0, 500)}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/* 进程表模块级共享：publish 可能来自 MCP Server 进程（stdio/HTTP），
 * revive/stop 来自 dev-server 进程，两边必须看到同一张表，否则下线会漏杀进程。 */
const children = new Map();

export class LocalExecutor {
  constructor() {
    this.children = children;
  }

  async start(app) {
    switch (app.type) {
      case "static":
        return { kind: "static", dir: app.sourceDir };
      case "node":
        return this.startNode(app);
      case "python":
        return this.startPython(app);
      case "docker":
        throw new Error("Docker 执行器需要 Docker 守护进程，当前环境不可用。请在装有 Docker 的服务器上运行，或使用本地执行器。");
      default:
        throw new Error(`未知应用类型: ${app.type}`);
    }
  }

  async startNode(app) {
    const pkg = readPkg(app.sourceDir);
    const entry = detectNodeEntry(app.sourceDir, pkg);
    if (!entry) {
      return { kind: "static", dir: app.sourceDir, downgraded: true };
    }
    if (this.needsInstall(app.sourceDir, pkg)) {
      await this.installDeps(app.sourceDir);
    }
    return this.launch(app, entry, await findFreePort());
  }

  needsInstall(sourceDir, pkg) {
    if (!pkg?.dependencies || Object.keys(pkg.dependencies).length === 0) return false;
    return !fs.existsSync(path.join(sourceDir, "node_modules"));
  }

  installDeps(sourceDir) {
    return runCmd(resolveBin("npm"), ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: sourceDir, timeout: 180000 });
  }

  /**
   * Python 应用：venv 隔离 + 按框架启动。
   * - FastAPI/Starlette → uvicorn module:app
   * - Flask → python app.py（应用需读取 PORT 环境变量）
   * - Django → manage.py runserver --noreload
   * - 识别不出框架 → 降级为静态服务（并在日志中说明）
   */
  async startPython(app, preferredPort) {
    const sourceDir = app.sourceDir;
    const entry = detectPythonEntry(sourceDir);
    if (!entry) {
      const logPath = logFile(app.id);
      fs.appendFileSync(logPath, `[hub] 未识别出 Python Web 框架，降级为静态目录服务 (${nowIso()})\n`);
      return this.serveStaticDir(app, "python3 -m http.server（降级）");
    }

    const venvDir = path.join(path.dirname(sourceDir), "venv");
    const venvPython = path.join(venvDir, "bin", "python");
    const pythonBin = process.env.HUB_PYTHON || "python3";
    const marker = path.join(venvDir, ".hub-installed");

    if (!fs.existsSync(venvPython)) {
      await runCmd(pythonBin, ["-m", "venv", venvDir], { timeout: 120000 });
    }
    if (!fs.existsSync(marker)) {
      const pipBase = [venvPython, "-m", "pip", "install", "--disable-pip-version-check", "--no-input"];
      // 镜像源：官方 PyPI 不可达时（如内网/受限网络）走镜像，避免 pip 重试到超时。
      // 可用 HUB_PIP_INDEX_URL 覆盖；默认给一个国内可达的镜像。
      const indexUrl = process.env.HUB_PIP_INDEX_URL || "https://mirrors.aliyun.com/pypi/simple/";
      const reqs = path.join(sourceDir, "requirements.txt");
      const pyproject = path.join(sourceDir, "pyproject.toml");
      const args = [...pipBase, "-i", indexUrl];
      if (fs.existsSync(reqs)) args.push("-r", "requirements.txt");
      else if (fs.existsSync(pyproject)) args.push(".");
      if (entry.needsUvicorn) args.push("uvicorn");
      if (args.length > pipBase.length) await runCmd(args[0], args.slice(1), { cwd: sourceDir, timeout: 300000 });
      fs.writeFileSync(marker, nowIso());
    }

    const port = preferredPort || (await findFreePort());
    const logPath = logFile(app.id);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    let cmd;
    let cmdArgs;
    const env = {
      ...process.env,
      PORT: String(port),
      HUB_APP_ID: app.id,
      PYTHONUNBUFFERED: "1",
      VIRTUAL_ENV: venvDir,
    };
    if (entry.kind === "uvicorn") {
      cmd = venvPython;
      cmdArgs = ["-m", "uvicorn", `${entry.module}:app`, "--host", "0.0.0.0", "--port", String(port)];
    } else if (entry.kind === "flask") {
      cmd = venvPython;
      cmdArgs = [entry.file];
      env.FLASK_APP = entry.file;
      env.FLASK_RUN_PORT = String(port);
    } else {
      cmd = venvPython;
      cmdArgs = ["manage.py", "runserver", `0.0.0.0:${port}`, "--noreload"];
    }

    const child = spawn(cmd, cmdArgs, { cwd: sourceDir, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.on("exit", (code) => {
      logStream.write(`\n[hub] process exited code=${code} at ${nowIso()}\n`);
      children.delete(app.id);
    });
    children.set(app.id, child);
    const ready = await waitPort(port, 15000);
    return { kind: "process", port, pid: child.pid, via: entry.via, ready, venv: venvDir };
  }

  async serveStaticDir(app, via) {
    const port = await findFreePort();
    const logPath = logFile(app.id);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const child = spawn("python3", ["-m", "http.server", String(port), "--directory", app.sourceDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.on("exit", () => children.delete(app.id));
    children.set(app.id, child);
    const ready = await waitPort(port, 10000);
    return { kind: "process", port, pid: child.pid, via, ready };
  }

  launch(app, entry, port) {
    const [bin, args] = entry.cmd;
    const logPath = logFile(app.id);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const child = spawn(resolveBin(bin), args, {
      cwd: app.sourceDir,
      env: {
        ...process.env,
        PORT: String(port),
        HUB_APP_ID: app.id,
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.on("exit", (code) => {
      logStream.write(`\n[hub] process exited code=${code} at ${nowIso()}\n`);
      children.delete(app.id);
    });
    children.set(app.id, child);
    return waitPort(port, 10000).then((ok) => ({
      kind: "process",
      port,
      pid: child.pid,
      via: entry.via,
      ready: ok,
    }));
  }

  async revive(app) {
    if (app.runtime?.kind !== "process") return app;
    if (isAlive(app.runtime.pid)) return app;
    let port = app.runtime.port;
    if (await portBusy(port)) port = await findFreePort();
    if (app.type === "python") {
      Object.assign(app.runtime, await this.startPython({ ...app, runtime: null }, port));
      return app;
    }
    const pkg = readPkg(app.sourceDir);
    const entry = detectNodeEntry(app.sourceDir, pkg);
    if (!entry) return app;
    Object.assign(app.runtime, await this.launch(app, entry, port));
    return app;
  }

  stop(app) {
    const child = children.get(app.id);
    if (child) {
      child.kill("SIGTERM");
      children.delete(app.id);
      return;
    }
    // 跨进程兜底：记录里的 pid 还活着也一并杀掉（例如发布来自 MCP 进程、下线来自 dev-server）
    if (app.runtime?.kind === "process" && isAlive(app.runtime.pid)) {
      try {
        process.kill(app.runtime.pid, "SIGTERM");
      } catch {
        /* 已退出 */
      }
    }
  }
}
