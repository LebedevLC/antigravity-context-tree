import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const DEFAULT_SETTINGS = {
  viewMode: "simple", // "simple" | "detailed"
  groupBy: "project", // "project" | "context" | "date"
  collapsedGroups: [],
  autoRefresh: true,
  refreshIntervalSec: 5,
  thresholdMode: "adaptive", // "adaptive" | "custom_k" | "percent"
  customThresholdK: 135,
  customThresholdPercent: 45,
  warnRatio: 0.75, // yellow at 75% of threshold, red at 95%
  showArchived: false,
  maxAgeDays: 0, // 0 = all
  pinnedConversationId: null,
};

export function resolveDataDir(cliDataDir) {
  if (cliDataDir && cliDataDir.trim()) {
    return cliDataDir.trim();
  }
  if (process.env.PLUGIN_DATA && process.env.PLUGIN_DATA.trim()) {
    return process.env.PLUGIN_DATA.trim();
  }
  return path.join(os.homedir(), ".gemini", "config", "plugin-data", "context-tree");
}

function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return s;

  if (raw.viewMode === "simple" || raw.viewMode === "detailed") {
    s.viewMode = raw.viewMode;
  }

  if (["project", "context", "date"].includes(raw.groupBy)) {
    s.groupBy = raw.groupBy;
  }

  if (Array.isArray(raw.collapsedGroups)) {
    s.collapsedGroups = raw.collapsedGroups
      .filter((x) => typeof x === "string" && x.length > 0 && x.length <= 120)
      .slice(0, 100);
  }

  if (typeof raw.autoRefresh === "boolean") s.autoRefresh = raw.autoRefresh;

  const interval = Number(raw.refreshIntervalSec);
  if (Number.isFinite(interval)) {
    s.refreshIntervalSec = Math.max(3, Math.min(60, Math.round(interval)));
  }

  if (["adaptive", "custom_k", "percent"].includes(raw.thresholdMode)) {
    s.thresholdMode = raw.thresholdMode;
  }

  const customK = Number(raw.customThresholdK);
  if (Number.isFinite(customK)) {
    s.customThresholdK = Math.max(20, Math.min(1000, Math.round(customK)));
  }

  const customPct = Number(raw.customThresholdPercent);
  if (Number.isFinite(customPct)) {
    s.customThresholdPercent = Math.max(5, Math.min(95, Math.round(customPct)));
  }

  const warnRatio = Number(raw.warnRatio);
  if (Number.isFinite(warnRatio)) {
    s.warnRatio = Math.max(0.3, Math.min(0.95, Number(warnRatio.toFixed(2))));
  }

  if (typeof raw.showArchived === "boolean") s.showArchived = raw.showArchived;

  const maxAgeDays = Number(raw.maxAgeDays);
  if (Number.isFinite(maxAgeDays) && maxAgeDays >= 0) {
    s.maxAgeDays = Math.min(365, Math.round(maxAgeDays));
  }

  if (raw.pinnedConversationId === null || raw.pinnedConversationId === "") {
    s.pinnedConversationId = null;
  } else if (typeof raw.pinnedConversationId === "string" && raw.pinnedConversationId.length <= 128) {
    s.pinnedConversationId = raw.pinnedConversationId;
  }

  return s;
}

export class SettingsStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "settings.json");
    this.cache = null;
  }

  async load() {
    if (this.cache) return { ...this.cache };
    try {
      const txt = await fs.readFile(this.filePath, "utf8");
      this.cache = sanitizeSettings(JSON.parse(txt));
    } catch {
      this.cache = { ...DEFAULT_SETTINGS };
    }
    return { ...this.cache };
  }

  async update(patch) {
    const current = await this.load();
    const merged = sanitizeSettings({ ...current, ...(patch || {}) });
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${process.pid}`;
    await fs.writeFile(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    await fs.rename(tmpPath, this.filePath);
    this.cache = merged;
    return { ...merged };
  }
}
