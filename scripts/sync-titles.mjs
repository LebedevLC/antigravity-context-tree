#!/usr/bin/env node
/**
 * Syncs official Antigravity sidebar titles & project labels from the documented
 * ConversationService (ListConversations + GetConversation) into PLUGIN_DATA/titles-cache.json.
 * Run from an Antigravity shell where ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN are set.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TranscriptScanner } from "../server/transcripts.mjs";

const address = (process.env.ANTIGRAVITY_LS_ADDRESS || "").trim();
const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || "").trim();

if (!address || !csrf) {
  console.error("ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN are required.");
  process.exit(1);
}

const dataDir =
  process.argv.find((a) => a.startsWith("--data_dir="))?.slice("--data_dir=".length) ||
  path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "context-tree");

async function rpc(method, body) {
  const res = await fetch(`http://${address}/product.v1.ConversationService/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "x-antigravity-csrf-token": csrf,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  return await res.json();
}

async function main() {
  const scanner = new TranscriptScanner();
  const transcripts = await scanner.scanAll();
  const trById = new Map(transcripts.map((t) => [t.id, t]));

  const conversations = {};
  const projectVotes = new Map(); // projectId -> Map<projectLabel, count>

  // 1. List all conversations (including archived)
  let pageToken = "";
  const listedIds = new Set();
  for (let p = 0; p < 5; p++) {
    const resp = await rpc("ListConversations", {
      pageSize: 100,
      includeArchived: true,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const c of resp.conversations || []) {
      if (!c?.id) continue;
      listedIds.add(c.id);
      const pid = c.metadata?.projectId || null;
      const tr = trById.get(c.id);
      if (pid && tr?.detectedProject) {
        const baseProj = tr.detectedProject.split("/")[0];
        if (!projectVotes.has(pid)) projectVotes.set(pid, new Map());
        const m = projectVotes.get(pid);
        m.set(baseProj, (m.get(baseProj) || 0) + 1);
      }
      conversations[c.id] = {
        title: (c.annotations?.title || "").trim(),
        projectId: pid,
        parentId: c.metadata?.parentConversationId || null,
        archived: Boolean(c.annotations?.archived),
        pinned: Boolean(c.annotations?.pinned),
      };
    }
    pageToken = resp.nextPageToken || "";
    if (!pageToken) break;
  }

  // 2. Fetch missing brain IDs (subagents) via GetConversation
  const missing = transcripts.map((t) => t.id).filter((id) => !listedIds.has(id));
  for (let i = 0; i < missing.length; i += 8) {
    await Promise.all(
      missing.slice(i, i + 8).map(async (id) => {
        try {
          const resp = await rpc("GetConversation", { conversationId: id });
          const c = resp.conversation || resp;
          if (!c?.id) return;
          conversations[c.id] = {
            title: (c.annotations?.title || "").trim(),
            projectId: c.metadata?.projectId || null,
            parentId: c.metadata?.parentConversationId || null,
            archived: Boolean(c.annotations?.archived),
            pinned: Boolean(c.annotations?.pinned),
          };
        } catch {
          // ignore
        }
      })
    );
  }

  // Resolve human-readable project names from transcript workspace paths
  const projects = {};
  for (const [pid, voteMap] of projectVotes.entries()) {
    const top = Array.from(voteMap.entries()).sort((a, b) => b[1] - a[1])[0];
    if (top) projects[pid] = top[0];
  }

  await fs.mkdir(dataDir, { recursive: true });
  const outPath = path.join(dataDir, "titles-cache.json");
  const payload = {
    syncedAt: new Date().toISOString(),
    projects,
    conversations,
  };
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(
    `Synced ${Object.keys(conversations).length} titles and ${Object.keys(projects).length} projects -> ${outPath}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
