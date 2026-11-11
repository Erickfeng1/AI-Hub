import fs from "node:fs";
import path from "node:path";
import { load, save, nextId } from "./store.js";
import { nowIso } from "./util.js";
import { canView } from "./identity.js";
import { DATA_DIR } from "./config.js";

/**
 * 资料库管理器：中台的统一资料入口。
 *
 * 混合架构（见 outputs/飞书OAuth联调指南.md 的架构决策）：
 *   - 本地上传区：Agent 通过 publish_library 归档的产出物（报告、导出包等），
 *     文件存 data/library/<id>/，元数据入 store.library，权限复用 canView 四档模型；
 *   - 飞书知识库索引区：等 wiki:wiki:readonly 权限审批后接入（索引模式，不存文件）。
 */

export const MAX_LIBRARY_SIZE = 50 * 1024 * 1024; // 50MB

const CATEGORIES = {
  doc: { label: "文档", ext: [".md", ".txt", ".doc", ".docx", ".pdf", ".rtf"] },
  sheet: { label: "表格", ext: [".xls", ".xlsx", ".csv", ".tsv"] },
  slides: { label: "演示", ext: [".ppt", ".pptx", ".key"] },
  image: { label: "图片", ext: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"] },
  archive: { label: "压缩包", ext: [".zip", ".tar", ".gz", ".tgz", ".7z"] },
};

/** 按扩展名识别资料分类 */
export function detectCategory(fileName) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  for (const [key, c] of Object.entries(CATEGORIES)) {
    if (c.ext.includes(ext)) return key;
  }
  return "other";
}

export function categoryLabel(cat) {
  return CATEGORIES[cat]?.label || "其他";
}

/** 过滤文件名中的危险字符，保留中文与常用符号 */
function safeFileName(name) {
  const base = path.basename(String(name || "file")).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
  return base || "file";
}

export class LibraryManager {
  constructor() {
    this.root = path.join(DATA_DIR, "library");
  }

  _dir(libId) {
    return path.join(this.root, libId);
  }

  /** 上传一份资料：buffer 落盘 + 元数据入库。visibility 缺省 self（与 Skill 发布一致） */
  upload({ user, fileName, buffer, visibility, extra = {}, name }) {
    if (!buffer?.length) throw new Error("文件内容为空");
    if (buffer.length > MAX_LIBRARY_SIZE) {
      throw new Error(`文件超过大小上限（${MAX_LIBRARY_SIZE / 1024 / 1024}MB）`);
    }
    const safeName = safeFileName(fileName);
    const store = load();
    const id = nextId(store, "lib");
    fs.mkdirSync(this._dir(id), { recursive: true });
    // 落盘文件名带 ID 前缀，避免不同资料同名互相覆盖
    const storedName = `${id}-${safeName}`;
    fs.writeFileSync(path.join(this._dir(id), storedName), buffer);
    const record = {
      id,
      name: (name && String(name).trim()) || safeName,
      category: detectCategory(safeName),
      size: buffer.length,
      fileName: safeName,
      storedName,
      ownerId: user.id,
      owner: user.name,
      visibility: visibility || "self",
      extra,
      status: "published",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.library.push(record);
    save(store);
    return record;
  }

  list(user) {
    return load()
      .library.filter((x) => canView(x, user))
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  get(libId, user) {
    const item = load().library.find((x) => x.id === libId);
    if (!item) return null;
    if (!canView(item, user)) throw new Error("无权查看该资料（不在权限范围内）。");
    return item;
  }

  /** 资料文件在磁盘上的路径 */
  fileOf(item) {
    const file = path.join(this._dir(item.id), item.storedName);
    if (!fs.existsSync(file)) throw new Error("资料文件缺失（可能已被清理）。");
    return file;
  }

  /** 全站下载次数（跨用户汇总，门户展示用） */
  downloadCount(libId) {
    return (load().usage || [])
      .filter((u) => u.kind === "library" && u.refId === libId)
      .reduce((sum, u) => sum + (u.count || 0), 0);
  }

  setPermission(libId, { visibility, department, users }) {
    const store = load();
    const item = store.library.find((x) => x.id === libId);
    if (!item) throw new Error(`资料不存在: ${libId}`);
    if (visibility) item.visibility = visibility;
    if (department) item.extra = { ...item.extra, department };
    if (users) item.extra = { ...item.extra, users };
    item.updatedAt = nowIso();
    save(store);
    return item;
  }

  unpublish(libId) {
    const store = load();
    const item = store.library.find((x) => x.id === libId);
    if (!item) throw new Error(`资料不存在: ${libId}`);
    fs.rmSync(this._dir(libId), { recursive: true, force: true });
    store.library = store.library.filter((x) => x.id !== libId);
    store.usage = (store.usage || []).filter((u) => !(u.kind === "library" && u.refId === libId));
    save(store);
    return { removed: libId };
  }
}
