#!/usr/bin/env node
/**
 * 定时对账：把真实运行状态固化进 store。
 *
 * 背景：门户展示的是实时探测结果（见 reconcile.js），但 store 里的 status
 * 仍是发布时的快照。两者分离会导致——外部工具直接读 store.json 时看到的是假状态。
 * 本脚本把探测结果写回 store，让 store 也变成真相。
 *
 * 与门户实时探测的分工：
 *   - 门户实时探测：给用户看，TTL 5 秒，永远近实时
 *   - 本脚本：给机器读（备份、巡检、外部系统），按 systemd timer 周期跑
 *
 * 用法：
 *   node scripts/reconcile.mjs            # 对账并写回 store
 *   node scripts/reconcile.mjs --dry-run  # 只打印将要变更的内容
 */

import { reconcileStatuses } from "../src/reconcile.js";
import { createExecutor } from "../src/executors/index.js";

const DRY = process.argv.includes("--dry-run");

async function main() {
  const executor = createExecutor();
  const { changes, checked } = await reconcileStatuses(executor, { persist: !DRY });

  console.log(`[reconcile] 检查 ${checked} 个应用，状态变更 ${changes.length} 个${DRY ? "（dry-run，未写库）" : ""}`);
  for (const c of changes) {
    console.log(`  ${c.from} → ${c.to}  ${c.appId} ${c.name}${c.detail ? ` · ${c.detail}` : ""}`);
  }
  if (!changes.length) console.log("  状态与运行时一致，无需变更");
}

main().catch((e) => {
  console.error(`[reconcile] 对账失败：${e.message}`);
  process.exit(1);
});
