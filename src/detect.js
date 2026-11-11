import fs from "node:fs";
import path from "node:path";

function has(projectPath, f) {
  return fs.existsSync(path.join(projectPath, f));
}

export function detectProject(projectPath) {
  if (has(projectPath, "Dockerfile")) return { type: "docker", evidence: ["Dockerfile"] };
  if (has(projectPath, "package.json")) return { type: "node", evidence: ["package.json"] };
  if (has(projectPath, "requirements.txt")) return { type: "python", evidence: ["requirements.txt"] };
  if (has(projectPath, "pyproject.toml")) return { type: "python", evidence: ["pyproject.toml"] };
  if (has(projectPath, "index.html")) return { type: "static", evidence: ["index.html"] };
  throw new Error("无法识别项目类型：目录中未找到 index.html / package.json / requirements.txt / Dockerfile");
}

export function detectName(projectPath) {
  const pkgPath = path.join(projectPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.name) return String(pkg.name);
    } catch {
      /* ignore */
    }
  }
  const indexPath = path.join(projectPath, "index.html");
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, "utf8");
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m && m[1].trim()) return m[1].trim();
  }
  return path.basename(path.resolve(projectPath));
}

export function readPkg(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Python 项目入口识别：Django > FastAPI/Starlette(uvicorn) > Flask。读不出框架时返回 null（降级静态服务）。 */
export function detectPythonEntry(projectPath) {
  const reqPath = path.join(projectPath, "requirements.txt");
  const reqs = fs.existsSync(reqPath) ? fs.readFileSync(reqPath, "utf8") : "";
  const pyproject = path.join(projectPath, "pyproject.toml");
  const pyprojectText = fs.existsSync(pyproject) ? fs.readFileSync(pyproject, "utf8") : "";
  const depsText = reqs + "\n" + pyprojectText;

  if (has(projectPath, "manage.py")) {
    return { kind: "django", via: "manage.py runserver", needsUvicorn: false };
  }
  for (const f of ["app.py", "main.py", "server.py", "application.py", "asgi.py"]) {
    if (!has(projectPath, f)) continue;
    const code = fs.readFileSync(path.join(projectPath, f), "utf8");
    const mod = f.replace(/\.py$/, "");
    if (/from\s+fastapi|import\s+fastapi|FastAPI\s*\(/.test(code) || /\bfastapi\b/.test(depsText)) {
      return { kind: "uvicorn", module: mod, via: `uvicorn ${mod}:app`, needsUvicorn: !/\buvicorn\b/.test(depsText) };
    }
    if (/from\s+starlette|import\s+starlette/.test(code) || /\bstarlette\b/.test(depsText)) {
      return { kind: "uvicorn", module: mod, via: `uvicorn ${mod}:app`, needsUvicorn: !/\buvicorn\b/.test(depsText) };
    }
    if (/from\s+flask|import\s+flask|Flask\s*\(/.test(code) || /\bflask\b/.test(depsText)) {
      return { kind: "flask", file: f, via: `python ${f}`, needsUvicorn: false };
    }
  }
  return null;
}

export function detectNodeEntry(projectPath, pkg) {
  if (pkg?.scripts?.start) return { cmd: ["npm", ["start"]], via: "npm start" };
  if (pkg?.main && has(projectPath, pkg.main)) return { cmd: ["node", [pkg.main]], via: `node ${pkg.main}` };
  for (const f of ["server.js", "app.js", "index.js"]) {
    if (has(projectPath, f)) return { cmd: ["node", [f]], via: `node ${f}` };
  }
  return null;
}
