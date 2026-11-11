import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { load, save, nextId } from "./store.js";
import { slugify, nowIso } from "./util.js";
import { DATA_DIR } from "./config.js";
import { canView, canManage } from "./identity.js";

const execFileAsync = promisify(execFile);

/**
 * Skill 管理器：中台作为 Skill 的分发中心。
 * - 一个合法 Skill = 含 SKILL.md 的目录（YAML frontmatter: name/description/version）
 * - 同一发布者的同名 Skill 再发布 = 版本更新（旧版归档，版本必须递增）
 * - check_skill_version 对比本地与平台版本，驱动「平台提醒更新」场景
 */

export function parseSkill(dir) {
  const file = path.join(dir, "SKILL.md");
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  const frontmatter = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
      if (key) frontmatter[key] = value;
    }
  }
  return {
    frontmatter,
    body: m ? text.slice(m[0].length).trim() : text.trim(),
    skillMd: text,
    file,
  };
}

/** 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等 0 */
export function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function bumpPatch(version) {
  const parts = String(version || "1.0.0").split(".").map((x) => parseInt(x, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[parts.length - 1] += 1;
  return parts.join(".");
}

function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.push({ path: path.relative(base, full), size: fs.statSync(full).size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export class SkillManager {
  constructor() {
    this.root = path.join(DATA_DIR, "skills");
  }

  _sourceDir(skillId) {
    return path.join(this.root, skillId, "source");
  }

  publish({ projectPath, user, skillName, version, visibility, extra = {} }) {
    const abs = path.resolve(projectPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`Skill 路径不存在或不是目录: ${abs}`);
    }
    const parsed = parseSkill(abs);
    if (!parsed) {
      throw new Error("不是有效的 Skill 目录：未找到 SKILL.md（Skill 必须包含带 frontmatter 的 SKILL.md）");
    }

    const store = load();
    const name = (skillName && String(skillName).trim()) || parsed.frontmatter.name || path.basename(abs);
    const slug = slugify(name);
    // 同一发布者的同名 Skill = 版本更新（slug 与 name 双路匹配，兼容中文名）
    const existing =
      store.skills.find(
        (s) => (s.ownerId ? s.ownerId === user.id : s.owner === user.name) && (s.slug === slug || s.name === name),
      ) || null;

    // 版本优先级：显式传入 > 已存在时自动递增补丁号 > frontmatter > 1.0.0
    let nextVersion;
    if (version) nextVersion = version;
    else if (existing) nextVersion = bumpPatch(existing.version);
    else nextVersion = parsed.frontmatter.version || "1.0.0";
    if (existing && compareVersions(nextVersion, existing.version) <= 0) {
      throw new Error(`版本号必须高于平台当前版本 ${existing.version}（当前传入 ${nextVersion}）。省略 version 时自动递增补丁号。`);
    }

    // 权限：显式传入 > 升级发布时继承原权限 > self
    const vis = visibility || existing?.visibility || "self";

    const id = existing ? existing.id : nextId(store, "skill");
    const sourceDir = this._sourceDir(id);
    fs.mkdirSync(sourceDir, { recursive: true });

    if (existing) {
      // 归档旧版本
      const archiveDir = path.join(this.root, id, "archive", existing.version);
      fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
      fs.cpSync(sourceDir, archiveDir, { recursive: true });
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
    fs.cpSync(abs, sourceDir, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`) && !src.includes(`${path.sep}.git${path.sep}`),
    });

    // 把整包内 SKILL.md 的 version 同步为平台版本：
    // 否则用户安装导出包后本地永远显示旧版本号，check_skill_version 会死循环提醒更新
    const skillMdPath = path.join(sourceDir, "SKILL.md");
    if (fs.existsSync(skillMdPath)) {
      const raw = fs.readFileSync(skillMdPath, "utf8");
      const patched = raw.replace(/^(\s*version\s*:\s*).*$/m, `$1${nextVersion}`);
      if (patched !== raw) fs.writeFileSync(skillMdPath, patched, "utf8");
    }

    const record = {
      id,
      name,
      slug,
      description: parsed.frontmatter.description || "",
      version: nextVersion,
      ownerId: user.id,
      owner: user.name,
      visibility: vis,
      extra,
      status: "published",
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
      sourceDir,
      files: listFiles(sourceDir),
      history: [...(existing?.history || []), { version: existing?.version, at: existing?.updatedAt, by: existing?.owner }].filter((h) => h.version),
    };

    if (existing) Object.assign(existing, record);
    else store.skills.push(record);
    save(store);
    return record;
  }

  list(user) {
    return load().skills.filter((s) => canView(s, user));
  }

  get(skillId, user) {
    const skill = load().skills.find((s) => s.id === skillId);
    if (!skill) return null;
    if (!canView(skill, user)) throw new Error("无权查看该 Skill（不在权限范围内）。");
    return skill;
  }

  /** 对比本地 Skill 与平台最新版本；同时把「该用户本地已装版本」留痕，驱动主动更新提醒 */
  checkVersion({ projectPath, user }) {
    const abs = path.resolve(projectPath);
    const parsed = parseSkill(abs);
    if (!parsed) throw new Error("不是有效的 Skill 目录：未找到 SKILL.md");
    const name = parsed.frontmatter.name || path.basename(abs);
    const slug = slugify(name);
    const localVersion = parsed.frontmatter.version || "0.0.0";

    const store = load();
    const sameNameAll = store.skills.filter((s) => s.slug === slug || s.name === name);
    const platform = sameNameAll.find((s) => canView(s, user));
    if (!platform) {
      const invisible = sameNameAll.length > 0;
      return {
        skill: name,
        localVersion,
        platformVersion: null,
        status: "not-published",
        message: invisible
          ? `平台存在同名 Skill「${name}」但你无权查看，无法比对版本。`
          : `平台尚未收录 Skill「${name}」，可调用 publish_skill 发布。`,
      };
    }
    const cmp = compareVersions(localVersion, platform.version);
    const status = cmp === 0 ? "up-to-date" : cmp < 0 ? "platform-newer" : "local-newer";
    const message =
      status === "up-to-date"
        ? `已是最新（v${localVersion}）。`
        : status === "platform-newer"
          ? `平台有更新：本地 v${localVersion} → 平台 v${platform.version}，建议更新后使用。`
          : `本地版本较新（v${localVersion} > 平台 v${platform.version}），可调用 publish_skill 发布到平台。`;
    // 留痕：该用户本地已安装的版本（用于 list_skills / connect / 门户的主动提醒）
    store.installedSkills = (store.installedSkills || []).filter(
      (r) => !(r.userId === user.id && r.skillId === platform.id),
    );
    store.installedSkills.push({ userId: user.id, skillId: platform.id, skillName: name, localVersion, checkedAt: nowIso() });
    save(store);
    return { skill: name, localVersion, platformVersion: platform.version, status, message, skillId: platform.id };
  }

  /** 某用户对某 Skill 的本地已装版本（无留痕返回 null） */
  installedVersion(skillId, user) {
    const rec = (load().installedSkills || []).find((r) => r.userId === user.id && r.skillId === skillId);
    return rec?.localVersion || null;
  }

  /** 该用户可见的 Skill 中，平台版本高于本地留痕的（待更新清单） */
  pendingUpdates(user) {
    return this.list(user)
      .map((s) => ({ skill: s, local: this.installedVersion(s.id, user) }))
      .filter((x) => x.local && compareVersions(x.skill.version, x.local) > 0)
      .map((x) => ({
        skillId: x.skill.id,
        名称: x.skill.name,
        本地版本: x.local,
        平台版本: x.skill.version,
        提示: `平台有更新：本地 v${x.local} → 平台 v${x.skill.version}，可调用 export_skill 导出最新整包。`,
      }));
  }

  /** 把 Skill 整包打包为 tar.gz（含全部附属文件），返回打包文件路径 */
  async pack(skillId, user) {
    const skill = this.get(skillId, user);
    if (!fs.existsSync(skill.sourceDir)) throw new Error("Skill 源文件缺失（可能已被清理）。");
    const exportDir = path.join(this.root, skillId, "export");
    fs.mkdirSync(exportDir, { recursive: true });
    const fileName = `${slugify(skill.name)}-v${skill.version}.tar.gz`;
    const outFile = path.join(exportDir, fileName);
    await execFileAsync("tar", ["-czf", outFile, "-C", path.join(this.root, skillId, "source"), "."]);
    return { file: outFile, fileName, size: fs.statSync(outFile).size, skill };
  }

  setPermission(skillId, { visibility, department, users }) {
    const store = load();
    const skill = store.skills.find((s) => s.id === skillId);
    if (!skill) throw new Error(`Skill 不存在: ${skillId}`);
    if (visibility) skill.visibility = visibility;
    if (department) skill.extra = { ...skill.extra, department };
    if (users) skill.extra = { ...skill.extra, users };
    skill.updatedAt = nowIso();
    save(store);
    return skill;
  }

  unpublish(skillId) {
    const store = load();
    const skill = store.skills.find((s) => s.id === skillId);
    if (!skill) throw new Error(`Skill 不存在: ${skillId}`);
    fs.rmSync(path.join(this.root, skillId), { recursive: true, force: true });
    store.skills = store.skills.filter((s) => s.id !== skillId);
    store.installedSkills = (store.installedSkills || []).filter((r) => r.skillId !== skillId);
    // 清理使用记录，避免留下指向已删除 Skill 的孤儿数据
    store.usage = (store.usage || []).filter((u) => !(u.kind === "skill" && u.refId === skillId));
    save(store);
    return { removed: skillId };
  }
}
