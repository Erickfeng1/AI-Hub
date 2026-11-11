import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const STORE_FILE = path.join(DATA_DIR, "store.json");

const DEFAULT_STORE = { apps: [], agents: [], users: [], sessions: [], skills: [], installedSkills: [], library: [], usage: [], seq: 0 };

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function load() {
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) return structuredClone(DEFAULT_STORE);
  try {
    return { ...structuredClone(DEFAULT_STORE), ...JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) };
  } catch {
    return structuredClone(DEFAULT_STORE);
  }
}

export function save(store) {
  ensureDir();
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

export function nextId(store, prefix) {
  store.seq = (store.seq || 0) + 1;
  return `${prefix}_${String(store.seq).padStart(4, "0")}`;
}
