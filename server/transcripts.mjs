import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { getModelInfo } from "./models.mjs";

const SUBAGENT_CREATED_RE = /Created the following subagent:\s*\{[\s\S]*?"conversationId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;
const SENDER_UUID_RE = /\bsender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const BRAIN_UUID_RE = /\bbrain\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const HOME_DIR = os.homedir();
const WORKSPACE_PATH_RE = new RegExp(
  HOME_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
    "/(?:Desktop|Documents|Developer|Repos|Code|Work)/(?:(Projects)/(?:Apps/)?([^/\"\\\\\\s]+)|([^/\"\\\\\\s]+)(?:/([^/\"\\\\\\s]+))?)",
  "g"
);
const IGNORED_DIRS = new Set([".DS_Store", ".agents", ".claude", "docs", "Journal", "scratch", "tmp"]);

function detectProjectFromText(text, counts) {
  if (!text) return;
  WORKSPACE_PATH_RE.lastIndex = 0;
  let m;
  while ((m = WORKSPACE_PATH_RE.exec(text)) !== null) {
    let label = null;
    if (m[1] === "Projects" && m[2] && !IGNORED_DIRS.has(m[2])) {
      label = m[2];
    } else if (m[3] && !IGNORED_DIRS.has(m[3])) {
      if (m[3] === "WF" && m[4] && /^\d{4}$/.test(m[4])) {
        label = `WF/${m[4]}`;
      } else {
        label = m[3];
      }
    }
    if (label && label.length <= 36) {
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
}

function pickTopProject(counts) {
  if (!counts || counts.size === 0) return null;
  // Prefer specific WF/NNNN over generic WF if present
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const specificWf = entries.find(([k]) => /^WF\/\d{4}$/.test(k));
  if (specificWf && entries[0][0] === "WF") return specificWf[0];
  return entries[0][0];
}

export function getBrainDir() {
  if (process.env.ANTIGRAVITY_BRAIN_DIR && process.env.ANTIGRAVITY_BRAIN_DIR.trim()) {
    return process.env.ANTIGRAVITY_BRAIN_DIR.trim();
  }
  return path.join(os.homedir(), ".gemini", "antigravity", "brain");
}

function cleanUserTitle(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw
    .replace(/<\/?USER_REQUEST>/gi, " ")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.startsWith('"') && s.length > 2) s = s.slice(1).trim();
  if (s.length > 110) s = s.slice(0, 109).trimEnd() + "…";
  return s;
}

function stripQuotes(val) {
  if (typeof val !== "string") return "";
  let s = val.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === "string") return parsed.trim();
    } catch {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Downsample step history while always preserving first, last, and compaction points.
 */
function downsampleHistory(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const keep = new Set([0, points.length - 1]);
  for (let i = 0; i < points.length; i++) {
    if (points[i].isCompaction || (i > 0 && points[i - 1].isCompaction)) {
      keep.add(i);
    }
  }
  const remaining = Math.max(2, maxPoints - keep.size);
  const step = (points.length - 1) / remaining;
  for (let k = 0; k < remaining; k++) {
    keep.add(Math.min(points.length - 1, Math.round(k * step)));
  }
  return Array.from(keep)
    .sort((a, b) => a - b)
    .map((idx) => points[idx]);
}

/**
 * Stream-parse a single transcript.jsonl file without loading it all into memory.
 */
async function parseTranscriptFile(cid, filePath, stat) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let firstUserTitle = "";
  let firstSystemHint = "";
  let userTurns = 0;
  let plannerSteps = 0;
  let lastPlanner = null;
  let prevTotalInput = 0;
  let pendingCompaction = null;
  let totalSessionInput = 0;
  let totalSessionCacheRead = 0;
  let totalSessionOutput = 0;
  let lastStepType = null;
  let lastStepStatus = null;
  let lastStepHasToolCalls = false;
  let lastCreatedAt = null;
  let createdAt = null;
  let lineIndex = 0;

  // Subagent linking
  const pendingSubagentMeta = [];
  const spawnedChildren = []; // [{ childId, role, typeName, at }]
  let inferredParentId = null;
  let inferredLinkKind = null; // "sender" | "btw" | "brain_ref"

  const compactions = [];
  const history = [];
  const projectCounts = new Map();

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lineIndex++;

      if (lineIndex <= 120 && trimmed.includes(HOME_DIR)) {
        detectProjectFromText(trimmed, projectCounts);
      }

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const type = obj.type || null;
      const status = obj.status || null;
      const at = obj.created_at || null;
      if (!createdAt && at) createdAt = at;
      if (at) lastCreatedAt = at;

      lastStepType = type;
      lastStepStatus = status;
      lastStepHasToolCalls = Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0;

      // Early parent detection from child's own opening steps (sender=... or /btw brain/<uuid>)
      if (lineIndex <= 8 && !inferredParentId && (type === "SYSTEM_MESSAGE" || type === "USER_INPUT")) {
        const contentStr = typeof obj.content === "string" ? obj.content : "";
        if (contentStr) {
          const senderMatch = SENDER_UUID_RE.exec(contentStr);
          if (senderMatch && senderMatch[1].toLowerCase() !== cid.toLowerCase()) {
            inferredParentId = senderMatch[1].toLowerCase();
            inferredLinkKind = "sender";
          } else {
            const brainMatch = BRAIN_UUID_RE.exec(contentStr);
            if (brainMatch && brainMatch[1].toLowerCase() !== cid.toLowerCase()) {
              inferredParentId = brainMatch[1].toLowerCase();
              inferredLinkKind = /\/btw\b|side question|branch/i.test(contentStr) ? "btw" : "brain_ref";
            }
          }
          if (!firstSystemHint && type === "SYSTEM_MESSAGE") {
            const roleLine = contentStr.match(/Role:\s*([^\n]+)/i);
            if (roleLine) firstSystemHint = roleLine[1].trim().slice(0, 80);
          }
        }
      }

      if (type === "USER_INPUT") {
        userTurns++;
        if (!firstUserTitle && typeof obj.content === "string") {
          firstUserTitle = cleanUserTitle(obj.content);
        }
        continue;
      }

      if (type === "CHECKPOINT") {
        const ckIn = toNum(obj.input_tokens) + toNum(obj.cache_read_tokens);
        const beforeTokens = ckIn > 0 ? ckIn : prevTotalInput;
        const event = {
          stepIndex: Number(obj.step_index ?? lineIndex),
          at: at || null,
          beforeTokens,
          afterTokens: null,
          kind: "checkpoint",
        };
        compactions.push(event);
        pendingCompaction = event;
        continue;
      }

      if (type === "PLANNER_RESPONSE") {
        // Track invoke_subagent calls to attach role/typeName to spawned child IDs
        if (Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls) {
            if (tc && tc.name === "invoke_subagent") {
              const args = tc.args || {};
              pendingSubagentMeta.push({
                role: stripQuotes(args.Role || args.role || ""),
                typeName: stripQuotes(args.TypeName || args.typeName || ""),
                at: at || null,
              });
            }
          }
        }

        if (status === "DONE") {
          plannerSteps++;
          const inputTokens = toNum(obj.input_tokens);
          const cacheReadTokens = toNum(obj.cache_read_tokens);
          const outputTokens = toNum(obj.output_tokens);
          const totalInput = inputTokens + cacheReadTokens;
          const contextTokens = totalInput + outputTokens;
          const cacheHitRatio = totalInput > 0 ? cacheReadTokens / totalInput : 0;
          const stepIndex = Number(obj.step_index ?? lineIndex);

          totalSessionInput += inputTokens;
          totalSessionCacheRead += cacheReadTokens;
          totalSessionOutput += outputTokens;

          let isCompactionStep = false;
          if (pendingCompaction) {
            pendingCompaction.afterTokens = totalInput;
            pendingCompaction = null;
            isCompactionStep = true;
          } else if (prevTotalInput >= 40_000 && totalInput > 0 && totalInput < prevTotalInput * 0.55) {
            compactions.push({
              stepIndex,
              at: at || null,
              beforeTokens: prevTotalInput,
              afterTokens: totalInput,
              kind: "drop",
            });
            isCompactionStep = true;
          }

          prevTotalInput = totalInput;

          lastPlanner = {
            stepIndex,
            model: obj.model || null,
            inputTokens,
            cacheReadTokens,
            outputTokens,
            totalInput,
            contextTokens,
            cacheHitRatio,
            createdAt: at || null,
          };

          history.push({
            s: stepIndex,
            t: contextTokens,
            i: inputTokens,
            c: cacheReadTokens,
            o: outputTokens,
            at: at || null,
            isCompaction: isCompactionStep,
          });
        }
        continue;
      }

      if (type === "GENERIC" && typeof obj.content === "string") {
        if (obj.content.includes("Created the following subagent")) {
          const match = SUBAGENT_CREATED_RE.exec(obj.content);
          if (match) {
            const childId = match[1].toLowerCase();
            if (childId !== cid.toLowerCase()) {
              const meta = pendingSubagentMeta.shift() || {};
              spawnedChildren.push({
                childId,
                role: meta.role || "",
                typeName: meta.typeName || "",
                at: at || meta.at || null,
              });
            }
          }
        }
      }
    }
  } finally {
    rl.close();
  }

  const modelInfo = getModelInfo(lastPlanner?.model);
  const nowMs = Date.now();
  const ageSinceMtimeMs = nowMs - stat.mtimeMs;
  // Heuristic running detection for local-logs fallback
  const looksRunning =
    (lastStepStatus && lastStepStatus !== "DONE") ||
    (ageSinceMtimeMs < 15_000 && (lastStepHasToolCalls || lastStepType === "USER_INPUT" || lastStepType === "GENERIC"));

  return {
    id: cid,
    filePath,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    createdAt: createdAt || new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    updatedAt: lastCreatedAt || new Date(stat.mtimeMs).toISOString(),
    localTitle: firstUserTitle || firstSystemHint || `Чат ${cid.slice(0, 8)}`,
    detectedProject: pickTopProject(projectCounts),
    userTurns,
    plannerSteps,
    model: modelInfo,
    lastStep: lastPlanner,
    sessionTotals: {
      inputTokens: totalSessionInput,
      cacheReadTokens: totalSessionCacheRead,
      outputTokens: totalSessionOutput,
      totalTokens: totalSessionInput + totalSessionCacheRead + totalSessionOutput,
    },
    compactions,
    compactionCount: compactions.length,
    lastCompactionAt: compactions.length > 0 ? compactions[compactions.length - 1].at : null,
    sparkline: downsampleHistory(history, 40).map((p) => ({
      s: p.s,
      t: p.t,
      cp: p.isCompaction ? 1 : 0,
    })),
    fullHistory: downsampleHistory(history, 160),
    spawnedChildren,
    inferredParentId,
    inferredLinkKind,
    localRunState: looksRunning ? "RUNNING" : "IDLE",
  };
}

export class TranscriptScanner {
  constructor(brainDir = getBrainDir()) {
    this.brainDir = brainDir;
    /** @type {Map<string, { mtimeMs: number, size: number, data: any }>} */
    this.cache = new Map();
  }

  async scanAll() {
    let entries;
    try {
      entries = await fsp.readdir(this.brainDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const seenIds = new Set();
    const candidates = [];

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const cid = ent.name;
      // Only consider conversation folders (UUID or non-hidden folders with transcript.jsonl)
      if (cid.startsWith(".")) continue;
      const filePath = path.join(this.brainDir, cid, ".system_generated", "logs", "transcript.jsonl");
      candidates.push({ cid, filePath });
    }

    const results = [];
    // Stat in small concurrent batches
    const BATCH = 16;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const slice = candidates.slice(i, i + BATCH);
      const batchRes = await Promise.all(
        slice.map(async ({ cid, filePath }) => {
          let st;
          try {
            st = await fsp.stat(filePath);
          } catch {
            return null;
          }
          if (!st.isFile() || st.size === 0) return null;
          seenIds.add(cid);

          const cached = this.cache.get(cid);
          if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            // Re-evaluate time-sensitive running heuristic cheaply
            const age = Date.now() - st.mtimeMs;
            if (cached.data.localRunState === "RUNNING" && age > 20_000) {
              cached.data.localRunState = "IDLE";
            }
            return cached.data;
          }

          try {
            const parsed = await parseTranscriptFile(cid, filePath, st);
            this.cache.set(cid, { mtimeMs: st.mtimeMs, size: st.size, data: parsed });
            return parsed;
          } catch {
            return null;
          }
        })
      );
      for (const item of batchRes) {
        if (item) results.push(item);
      }
    }

    // Evict removed conversations from cache so memory never leaks
    for (const cid of this.cache.keys()) {
      if (!seenIds.has(cid)) {
        this.cache.delete(cid);
      }
    }

    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return results;
  }

  async getById(cid) {
    if (!cid) return null;
    const all = await this.scanAll();
    return all.find((x) => x.id === cid) || null;
  }
}
