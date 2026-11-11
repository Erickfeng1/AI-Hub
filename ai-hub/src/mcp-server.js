import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-core.js";
import { HUB_ROOT, HUB_PORT, HUB_DOMAIN } from "./config.js";

/* stdio 入口：Claude Code / Codex 等本地 Agent 通过 spawn 本文件接入。
 * 远程 Agent 走 HTTP：POST http://<hub>/mcp（见 router.js）。 */

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[ai-hub] MCP Server 已启动（stdio）· 根目录 ${HUB_ROOT}`);
console.error(`[ai-hub] HTTP 接入地址: http://${HUB_DOMAIN}:${HUB_PORT}/mcp`);
