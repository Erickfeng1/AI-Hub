import { randomBytes, createHash } from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function randomToken() {
  return "ah_" + randomBytes(24).toString("base64url");
}

export function slugify(name) {
  const base = String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  // 非 ASCII 名称（如纯中文）回退为确定性哈希：同一名称永远得到同一 slug，
  // 否则随机后缀会导致「同名 Skill 版本比对」这类按名匹配的逻辑失效
  if (!base) return "app-" + createHash("sha1").update(String(name || "")).digest("hex").slice(0, 8);
  return base;
}

export function resolveBin(name) {
  const beside = path.join(path.dirname(process.execPath), name);
  if (fs.existsSync(beside)) return beside;
  return name;
}

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function waitPort(port, timeout = 10000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect({ host: "127.0.0.1", port });
      sock.on("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        if (Date.now() - started > timeout) return resolve(false);
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

export function portBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
  });
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
