import fs from "node:fs";
import path from "node:path";
import { load, save, nextId } from "./store.js";
import { detectProject, detectName } from "./detect.js";
import { slugify, nowIso } from "./util.js";
import { DATA_DIR, appUrl } from "./config.js";

/** 依赖锁审查（安全红线之一）：没有锁文件 = 每次安装可能拉到不同版本，且无法审计。 */
export function reviewDependencies(sourceDir, type) {
  const warnings = [];
  let lockFile = null;
  if (type === "node") {
    for (const f of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]) {
      if (fs.existsSync(path.join(sourceDir, f))) {
        lockFile = f;
        break;
      }
    }
    if (!lockFile) warnings.push("Node 项目无锁文件，安装结果不可复现");
  } else if (type === "python") {
    for (const f of ["poetry.lock", "Pipfile.lock", "uv.lock"]) {
      if (fs.existsSync(path.join(sourceDir, f))) {
        lockFile = f;
        break;
      }
    }
    if (!lockFile && fs.existsSync(path.join(sourceDir, "requirements.txt"))) {
      const text = fs.readFileSync(path.join(sourceDir, "requirements.txt"), "utf8");
      if (!/--hash/.test(text)) warnings.push("requirements.txt 未固定哈希，供应链不可审计");
    } else if (!lockFile) {
      warnings.push("Python 项目未发现锁文件");
    }
  }
  return { lockFile, warnings };
}

export class Deployer {
  constructor({ executor }) {
    this.executor = executor;
  }

  async publish({ projectPath, appName, visibility = "self", user = null, extra = {} }) {
    const abs = path.resolve(projectPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`项目路径不存在或不是目录: ${abs}`);
    }
    const store = load();
    const { type, evidence } = detectProject(abs);
    const name = (appName && String(appName).trim()) || detectName(abs);

    let candidate = slugify(name);
    let n = 2;
    while (store.apps.some((a) => a.slug === candidate)) {
      candidate = `${slugify(name)}-${n++}`;
    }

    const id = nextId(store, "app");
    const sourceDir = path.join(DATA_DIR, "apps", id, "source");
    fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
    fs.cpSync(abs, sourceDir, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`) && !src.includes(`${path.sep}.git${path.sep}`),
    });

    const deps = reviewDependencies(abs, type);

    const app = {
      id,
      name,
      slug: candidate,
      type,
      evidence,
      ownerId: user?.id || null,
      owner: user?.name || "anonymous",
      visibility,
      extra,
      deps,
      status: "starting",
      createdAt: nowIso(),
      sourceDir,
      url: appUrl(candidate),
      runtime: null,
    };

    try {
      app.runtime = await this.executor.start(app);
    } catch (e) {
      app.status = "failed";
      app.error = e.message;
      store.apps.push(app);
      save(store);
      throw e;
    }

    app.status = "running";
    store.apps.push(app);
    save(store);
    return app;
  }

  list() {
    return load().apps;
  }

  get(appId) {
    return load().apps.find((a) => a.id === appId) || null;
  }

  setPermission(appId, { visibility, department, users }) {
    const store = load();
    const app = store.apps.find((a) => a.id === appId);
    if (!app) throw new Error(`应用不存在: ${appId}`);
    if (visibility) app.visibility = visibility;
    if (department) app.extra = { ...app.extra, department };
    if (users) app.extra = { ...app.extra, users };
    save(store);
    return app;
  }

  async unpublish(appId) {
    const store = load();
    const app = store.apps.find((a) => a.id === appId);
    if (!app) throw new Error(`应用不存在: ${appId}`);
    await this.executor.stop(app);
    fs.rmSync(path.dirname(app.sourceDir), { recursive: true, force: true });
    store.apps = store.apps.filter((a) => a.id !== appId);
    // 清理使用记录，避免留下指向已删除应用的孤儿数据（与 library.unpublish 一致）
    store.usage = (store.usage || []).filter((u) => !(u.kind === "app" && u.refId === appId));
    save(store);
    return { removed: appId };
  }
}
