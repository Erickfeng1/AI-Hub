import path from "node:path";
import { startRouter } from "../src/router.js";
import { createExecutor } from "../src/executors/index.js";
import { load, save } from "../src/store.js";
import { HUB_ROOT, HUB_PORT, HUB_DOMAIN } from "../src/config.js";

// 运行时由 HUB_EXECUTOR 决定：local（默认，宿主机进程）/ docker（容器 + Traefik，生产）
const executor = createExecutor();

const store = load();
for (const app of store.apps) {
  if (app.status === "running" && (app.runtime?.kind === "process" || app.runtime?.kind === "container")) {
    try {
      await executor.revive(app);
      console.log(`[hub] 已恢复应用: ${app.slug} → ${app.url}`);
    } catch (e) {
      console.warn(`[hub] 恢复应用 ${app.slug} 失败: ${e.message}`);
    }
  }
}
if (store.apps.some((a) => a.status === "running")) save(store);

startRouter();

const mcpPath = path.join(HUB_ROOT, "src", "mcp-server.js");
console.log(`
企业 AI 中台（MVP）已启动。

第一段 Prompt（连接中台）—— 发给你的 Agent：
  请连接企业 AI 中台 MCP：node ${mcpPath}（或 HTTP 地址 http://${HUB_DOMAIN}:${HUB_PORT}/mcp），
  然后调用 connect 工具，agentName 设为你的名称，userToken 设为网页登录后获得的用户令牌。

第二段 Prompt（发布应用）—— 在 VibeCoding 项目文件夹下发给你的 Agent：
  请调用 publish_app，projectPath = 我的项目绝对路径，agentToken = connect 返回的 token。
  应用名和权限范围（self / department / users / all）先问我，不要擅自决定。
`);
