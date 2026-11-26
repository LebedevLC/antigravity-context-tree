import fs from "node:fs/promises";
import path from "node:path";

/**
 * Manages cached Antigravity sidebar titles (synced via documented ConversationService)
 * and user custom titles saved from the MCP App UI inside ${PLUGIN_DATA}.
 */
export class TitlesStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.cachePath = path.join(dataDir, "titles-cache.json");
    this.customPath = path.join(dataDir, "custom-titles.json");
    this.cacheMtime = 0;
    this.cachedTitles = {};
    this.customMtime = 0;
    this.customTitles = {};
  }

  async _loadJsonIfChanged(filePath, currentMtime, currentData) {
    try {
      const st = await fs.stat(filePath);
      if (st.mtimeMs === currentMtime) {
        return { mtime: currentMtime, data: currentData };
      }
      const txt = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(txt);
      return {
        mtime: st.mtimeMs,
        data: parsed && typeof parsed === "object" ? parsed : {},
      };
    } catch {
      return { mtime: 0, data: {} };
    }
  }

  async loadAll() {
    const [c1, c2] = await Promise.all([
      this._loadJsonIfChanged(this.cachePath, this.cacheMtime, this.cachedTitles),
      this._loadJsonIfChanged(this.customPath, this.customMtime, this.customTitles),
    ]);
    this.cacheMtime = c1.mtime;
    this.cachedTitles = c1.data;
    this.customMtime = c2.mtime;
    this.customTitles = c2.data;
    return {
      syncedById: this.cachedTitles.conversations || this.cachedTitles || {},
      projectNames: this.cachedTitles.projects || {},
      customById: this.customTitles || {},
    };
  }

  async setCustomTitle(conversationId, title) {
    if (!conversationId) return {};
    await this.loadAll();
    const next = { ...this.customTitles };
    const clean = (title || "").trim().slice(0, 120);
    if (!clean) {
      delete next[conversationId];
    } else {
      next[conversationId] = clean;
    }
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmp = `${this.customPath}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fs.rename(tmp, this.customPath);
    const st = await fs.stat(this.customPath);
    this.customMtime = st.mtimeMs;
    this.customTitles = next;
    return next;
  }
}
