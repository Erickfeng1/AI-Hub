import path from "node:path";
import { fileURLToPath } from "node:url";

export const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.HUB_DATA_DIR || path.join(HUB_ROOT, "data");
export const HUB_PORT = Number(process.env.HUB_PORT || 8080);
export const HUB_DOMAIN = process.env.HUB_DOMAIN || "localhost";

/** 当前运行时模式：local=宿主机进程（演示）/ docker=容器+Traefik（生产） */
export function isDockerMode() {
  return (process.env.HUB_EXECUTOR || "local") === "docker";
}

/**
 * 对外访问协议。生产走 Traefik 443（80 入口跳 443），门户与应用的对外 URL 必须用 https，
 * 否则浏览器按混合内容降级或跳转，直接 404/跳飞。
 * localhost 单机演示保持 http，避免自签证书干扰。可用 HUB_EXTERNAL_SCHEME 强制覆盖。
 */
export const HUB_SCHEME = process.env.HUB_EXTERNAL_SCHEME || (HUB_DOMAIN === "localhost" ? "http" : "https");

/**
 * 门户对外 origin。生产（docker 运行时）由 Traefik 对外，不带 :8080；
 * 本地 local 演示直连中台端口，带端口。
 */
export const HUB_ORIGIN = `${HUB_SCHEME}://${HUB_DOMAIN}${isDockerMode() ? "" : `:${HUB_PORT}`}`;

export function appUrl(slug) {
  const dockerMode = isDockerMode();
  // docker 模式下应用由 Traefik（80/443）直接路由，localhost 测试也不带端口
  if (HUB_DOMAIN === "localhost") {
    return dockerMode ? `${HUB_SCHEME}://${slug}.${HUB_DOMAIN}` : `http://${slug}.${HUB_DOMAIN}:${HUB_PORT}`;
  }
  return `${HUB_SCHEME}://${slug}.${HUB_DOMAIN}`;
}

/** 是否由 Traefik 对外提供服务（docker 运行时） */
export function behindProxy() {
  return isDockerMode();
}

export const VISIBILITY_LABELS = {
  self: "仅自己",
  department: "部门可见",
  users: "指定同事",
  all: "全员",
};

export const TYPE_LABELS = {
  static: "静态",
  node: "Node",
  python: "Python",
  docker: "Docker",
};
