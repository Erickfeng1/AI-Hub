import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startRouter } from "../src/router.js";
import { HUB_ROOT, HUB_PORT } from "../src/config.js";
import { hubLogin } from "./e2e-login.mjs";

const MCP_SERVER = path.join(HUB_ROOT, "src", "mcp-server.js");
const HUB = `http://localhost:${HUB_PORT}`;
const SRC_MD = "/tmp/ah-lib-src.md"; // 模拟「Agent 生成的一份报告」

function section(title) {
  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
}

function toolText(res) {
  const first = res?.content?.[0];
  return first?.type === "text" ? first.text : JSON.stringify(res);
}

/** 调用工具；expectError=true 时断言返回 isError 并返回错误文本 */
async function call(client, name, args, { expectError = false } = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (expectError) {
    if (!res.isError) throw new Error(`工具 ${name} 应当报错但没有`);
    return toolText(res);
  }
  if (res.isError) throw new Error(`工具 ${name} 返回错误: ${toolText(res)}`);
  const text = toolText(res);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function devLogin(name, department) {
  const { user, cookie } = await hubLogin(name, department);
  return { ...user, cookie };
}

let passed = 0;
function check(label, cond, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed++;
}

async function connectAgent(name, userToken) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_SERVER], env: { ...process.env } });
  const client = new Client({ name: `${name}-demo`, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const conn = await call(client, "connect", { agentName: name, userToken });
  return { client, token: conn.token, conn };
}

/** 门户页面（dev 模式带 cookie，其他 Provider 用 Bearer） */
async function hubPage(user) {
  const headers = user.cookie ? { cookie: user.cookie } : { Authorization: `Bearer ${user.token}` };
  return (await fetch(`${HUB}/`, { headers })).text();
}

async function main() {
  section("第 0 步 · 启动中台（若已在运行则自动复用）");
  startRouter();

  section("第 1 步 · 两名同事登录");
  const fang = await devLogin("方科", "商务部");
  const li = await devLogin("小李", "广告执行部");
  console.log(`方科=${fang.id} 小李=${li.id}`);

  section("第 2 步 · 方科的 Agent 归档一份报告（sourcePath 模式，self 权限）");
  // 自洽重置：清空本方账号历史遗留的资料，保证「小李不可见」等权限断言从干净状态开始
  const fangAgent = await connectAgent("Claude", fang.token);
  const existingLibs = await call(fangAgent.client, "list_library", { agentToken: fangAgent.token });
  for (const x of Array.isArray(existingLibs) ? existingLibs.filter((y) => y.我是发布者) : []) {
    await call(fangAgent.client, "unpublish_library", { libId: x.libId, agentToken: fangAgent.token });
    console.log(`（重置：已清理历史遗留资料 ${x.名称}）`);
  }
  fs.writeFileSync(SRC_MD, "# Q3 广告复盘\n\n本季度消耗 120 万，线索 3400 条，CVR 2.8%。\n");
  const pub = await call(fangAgent.client, "publish_library", {
    sourcePath: SRC_MD,
    fileName: "Q3广告复盘.md",
    visibility: "self",
    agentToken: fangAgent.token,
  });
  const libId = pub.libId;
  console.log(`归档: ${pub.名称} · ${pub.分类} · ${pub.大小} · ${pub.权限范围}`);
  check("归档成功", pub.归档成功 === true && !!libId, `libId=${libId}`);
  check("分类识别为文档", pub.分类.startsWith("doc"), pub.分类);
  check("返回带令牌下载链接", typeof pub.下载链接 === "string" && pub.下载链接.includes(libId));

  section("第 3 步 · 权限：小李不可见、越权下载被拒");
  const liAgent = await connectAgent("Codex", li.token);
  const liList1 = await call(liAgent.client, "list_library", { agentToken: liAgent.token });
  check("小李 list_library 为空（self 权限）", typeof liList1 === "string", liList1.slice(0, 30));
  const anonDl = await fetch(`${HUB}/__hub__/library/${libId}/download`);
  check("匿名下载 401", anonDl.status === 401, `HTTP ${anonDl.status}`);
  const denyDl = await fetch(`${HUB}/__hub__/library/${libId}/download?ah_token=${encodeURIComponent(li.token)}`);
  check("越权下载 403", denyDl.status === 403, `HTTP ${denyDl.status}`);

  section("第 4 步 · contentBase64 模式归档（表格分类）");
  const fakeXlsx = Buffer.from("PK\u0003\u0004fake-xlsx-bytes-for-e2e");
  const pub2 = await call(fangAgent.client, "publish_library", {
    contentBase64: fakeXlsx.toString("base64"),
    fileName: "Q3销售数据.xlsx",
    visibility: "self",
    agentToken: fangAgent.token,
  });
  const libId2 = pub2.libId;
  check("base64 归档成功", pub2.归档成功 === true && !!libId2, `libId=${libId2}`);
  check("分类识别为表格", pub2.分类.startsWith("sheet"), pub2.分类);

  section("第 5 步 · 方科改权限为全员 → 小李可发现可下载");
  await call(fangAgent.client, "set_library_permission", { libId, visibility: "all", agentToken: fangAgent.token });
  await call(fangAgent.client, "set_library_permission", { libId: libId2, visibility: "all", agentToken: fangAgent.token });
  const liList2 = await call(liAgent.client, "list_library", { agentToken: liAgent.token });
  check("小李可见 2 份资料", Array.isArray(liList2) && liList2.length === 2, liList2.map((x) => x.名称).join(" / "));

  const liDl = await fetch(`${HUB}/__hub__/library/${libId}/download?ah_token=${encodeURIComponent(li.token)}`);
  check("小李下载 200", liDl.status === 200, `HTTP ${liDl.status}`);
  const dlBuf = Buffer.from(await liDl.arrayBuffer());
  check("下载内容与源文件一致", dlBuf.toString("utf8") === fs.readFileSync(SRC_MD, "utf8"));
  check("Content-Disposition 带中文文件名", /filename="Q3/.test(decodeURIComponent(liDl.headers.get("content-disposition") || "")), liDl.headers.get("content-disposition"));
  const dlCount = await call(fangAgent.client, "list_library", { agentToken: fangAgent.token });
  const dlRow = dlCount.find((x) => x.libId === libId);
  check("下载计入使用记录", dlRow.下载次数 === 1, `下载次数=${dlRow.下载次数}`);

  section("第 6 步 · 千人千面：方科打开一个应用 → 首页「最近使用」置顶、常用应用排前");
  // 先发一个「不打开」的对照应用，再发「要打开」的：若按创建序排列，对照应用应在前面；
  // 只有按个人使用频次排序（千人千面），打开过的应用才会排到前面。
  const pubCtl = await call(fangAgent.client, "publish_app", {
    projectPath: path.join(HUB_ROOT, "fixtures", "demo-app"),
    appName: "未打开的应用",
    visibility: "all",
    agentToken: fangAgent.token,
  });
  const pubApp = await call(fangAgent.client, "publish_app", {
    projectPath: path.join(HUB_ROOT, "fixtures", "demo-app"),
    appName: "团队数据看板",
    visibility: "all",
    agentToken: fangAgent.token,
  });
  console.log(`对照应用: ${pubCtl.子域名} · 目标应用: ${pubApp.子域名}`);
  const appRes = await fetch(pubApp.子域名, { headers: { Authorization: `Bearer ${fang.token}` } });
  check("应用可打开（首页 200）", appRes.status === 200, `HTTP ${appRes.status}`);
  await appRes.text();

  const fangPage = await hubPage(fang);
  check("方科门户有「最近使用」区块", /<h2>最近使用<\/h2>/.test(fangPage));
  check("最近使用含刚打开的应用", /使用 1 次/.test(fangPage) && fangPage.includes("团队数据看板"));
  check("门户有资料库分区", /<h2>资料库/.test(fangPage) && fangPage.includes("Q3广告复盘.md"));
  check(
    "常用置顶：打开过的应用排在未打开的应用之前",
    fangPage.indexOf("团队数据看板") < fangPage.indexOf("未打开的应用"),
    `看板@${fangPage.indexOf("团队数据看板")} < 对照@${fangPage.indexOf("未打开的应用")}`,
  );

  const liPage = await hubPage(li);
  check("小李门户最近使用含下载的资料", /下载 1 次/.test(liPage) && liPage.includes("Q3广告复盘.md"));

  section("第 7 步 · 门户直接上传（multipart）→ 立即可见");
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("# 周报模板\n- 本周进展\n- 下周计划\n")], { type: "text/markdown" }), "团队周报模板.md");
  form.append("name", "团队周报模板");
  form.append("visibility", "all");
  const upRes = await fetch(`${HUB}/__hub__/library/upload`, {
    method: "POST",
    headers: fang.cookie ? { cookie: fang.cookie } : { Authorization: `Bearer ${fang.token}` },
    body: form,
    redirect: "manual",
  });
  check("上传后重定向门户", upRes.status === 302 && (upRes.headers.get("location") || "") === "/", `HTTP ${upRes.status}`);
  const afterUp = await hubPage(fang);
  check("上传的资料出现在门户", afterUp.includes("团队周报模板"));
  const liList3 = await call(liAgent.client, "list_library", { agentToken: liAgent.token });
  check("小李可见上传的资料（全员）", Array.isArray(liList3) && liList3.length === 3, `${liList3.length} 份`);

  section("第 8 步 · 清理：unpublish 删除资料与文件");
  const removed = await call(fangAgent.client, "unpublish_library", { libId, agentToken: fangAgent.token });
  check("删除成功", removed.removed === libId, JSON.stringify(removed));
  const liList4 = await call(liAgent.client, "list_library", { agentToken: liAgent.token });
  check("删除后小李不可见", Array.isArray(liList4) && !liList4.some((x) => x.libId === libId));
  check("磁盘文件已清理", !fs.existsSync(path.join(HUB_ROOT, "data", "library", libId)));
  const denyAfter = await fetch(`${HUB}/__hub__/library/${libId}/download?ah_token=${encodeURIComponent(li.token)}`);
  check("删除后下载 404", denyAfter.status === 404, `HTTP ${denyAfter.status}`);

  section(`资料库 + 千人千面端到端验证通过 · ${passed} 项断言`);
  await fangAgent.client.close();
  await liAgent.client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("演示失败:", e);
  process.exit(1);
});
