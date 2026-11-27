import fsp from "node:fs/promises";
import path from "node:path";

const REMOTE_MANIFEST_URL =
  "https://raw.githubusercontent.com/LebedevLC/antigravity-context-tree/main/plugin.json";
const REPO_URL = "https://github.com/LebedevLC/antigravity-context-tree";
const UPDATE_CMD = "cd ~/.gemini/config/plugins/context-tree && git pull";
const CACHE_TTL_MS = 12 * 3_600_000; // 12 hours
const FETCH_TIMEOUT_MS = 10_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const STRICT_SEMVER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export function compareSemver(a, b) {
  const pa = String(a || "0.0.0")
    .replace(/^v/i, "")
    .split(".")
    .map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0.0.0")
    .replace(/^v/i, "")
    .split(".")
    .map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

export class UpdateChecker {
  constructor({ pluginRoot, dataDir }) {
    this.pluginRoot = pluginRoot;
    this.dataDir = dataDir;
    this.cachePath = path.join(dataDir, "update-check.json");
    this.currentVersion = "1.1.0";
    this.state = null;
    this.inFlight = null;
    this.loaded = false;
  }

  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const manifestRaw = await fsp.readFile(path.join(this.pluginRoot, "plugin.json"), "utf8");
      const manifest = JSON.parse(manifestRaw);
      if (manifest?.version) this.currentVersion = String(manifest.version);
    } catch {
      // keep fallback
    }

    try {
      const cacheRaw = await fsp.readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(cacheRaw);
      if (parsed && typeof parsed === "object") {
        this.state = {
          ...parsed,
          currentVersion: this.currentVersion,
          updateAvailable:
            Boolean(parsed.latestVersion) &&
            compareSemver(parsed.latestVersion, this.currentVersion) > 0,
        };
      }
    } catch {
      this.state = null;
    }
  }

  getInfo() {
    return {
      currentVersion: this.currentVersion,
      latestVersion: this.state?.latestVersion || null,
      updateAvailable: Boolean(
        this.state?.latestVersion &&
          compareSemver(this.state.latestVersion, this.currentVersion) > 0
      ),
      checkedAt: this.state?.checkedAt || null,
      status: this.state?.status || "never", // "ok" | "offline" | "error" | "never"
      error: this.state?.error || null,
      inFlight: Boolean(this.inFlight),
      repoUrl: REPO_URL,
      updateCommand: UPDATE_CMD,
    };
  }

  async checkNow({ force = false } = {}) {
    await this.ensureLoaded();

    if (!force && this.state?.checkedAt) {
      const age = Date.now() - Date.parse(this.state.checkedAt);
      if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS && this.state.status === "ok") {
        return this.getInfo();
      }
    }

    if (this.inFlight) return await this.inFlight;

    const run = async () => {
      const nowIso = new Date().toISOString();
      try {
        let remoteManifest;
        if (process.env.CONTEXT_TREE_MOCK_REMOTE_MANIFEST) {
          remoteManifest = JSON.parse(process.env.CONTEXT_TREE_MOCK_REMOTE_MANIFEST);
        } else {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          try {
            const res = await fetch(REMOTE_MANIFEST_URL, {
              headers: { "Cache-Control": "no-cache" },
              referrerPolicy: "no-referrer",
              signal: controller.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            if (buf.byteLength > MAX_MANIFEST_BYTES) {
              throw new Error("Слишком большой удалённый plugin.json");
            }
            remoteManifest = JSON.parse(new TextDecoder("utf-8").decode(buf));
          } finally {
            clearTimeout(timer);
          }
        }

        const latestVersion = String(remoteManifest?.version || "").trim();
        if (!STRICT_SEMVER_RE.test(latestVersion)) {
          throw new Error("Некорректный формат версии в удалённом plugin.json");
        }

        this.state = {
          currentVersion: this.currentVersion,
          latestVersion,
          updateAvailable: compareSemver(latestVersion, this.currentVersion) > 0,
          checkedAt: nowIso,
          status: "ok",
          error: null,
        };
        await fsp.mkdir(this.dataDir, { recursive: true });
        await fsp.writeFile(this.cachePath, JSON.stringify(this.state, null, 2) + "\n", "utf8");
      } catch (err) {
        const msg = String(err?.message || err || "Ошибка сети");
        const isAbort =
          err?.name === "AbortError" || /fetch failed|enotfound|econn|network|timeout/i.test(msg);
        this.state = {
          ...(this.state || {}),
          currentVersion: this.currentVersion,
          checkedAt: this.state?.checkedAt || nowIso,
          status: isAbort ? "offline" : "error",
          error: isAbort ? "Нет сети или таймаут GitHub" : msg.slice(0, 140),
        };
      } finally {
        this.inFlight = null;
      }
      return this.getInfo();
    };

    this.inFlight = run();
    return await this.inFlight;
  }

  startAutoCheck() {
    if (process.env.AGY_DISABLE_AUTO_POLL === "1") return;
    const t = setTimeout(() => {
      this.checkNow({ force: false }).catch(() => {});
    }, 3_500);
    t.unref?.();
  }
}
