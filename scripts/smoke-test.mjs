#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TranscriptScanner } from "../server/transcripts.mjs";
import { buildMonitorSnapshot } from "../server/tree.mjs";
import { DEFAULT_SETTINGS } from "../server/settings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function runSuite(label, envOverrides) {
  const tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-tree-test-"));
  const env = { ...process.env, ...envOverrides };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete env[k];
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "server", "index.mjs"), `--data_dir=${tmpDataDir}`],
    env,
  });

  const client = new Client({ name: "smoke-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    // 1. Check tools & metadata
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.ok(byName.has("open_context_monitor"), "open_context_monitor must exist");

    const openTool = byName.get("open_context_monitor");
    assert.equal(openTool._meta?.ui?.resourceUri, "ui://context-tree/app.html");
    const entrypoints = openTool._meta?.["com.google.antigravity/ui"]?.entrypoints || [];
    const epTypes = entrypoints.map((e) => e.type).sort();
    assert.deepEqual(epTypes, ["aux_pane", "global"], "Must declare both aux_pane and global entrypoints");

    for (const appOnly of ["get_monitor_snapshot", "get_conversation_detail", "update_monitor_settings", "create_project_chat", "rename_conversation", "check_plugin_updates"]) {
      const t = byName.get(appOnly);
      assert.ok(t, `${appOnly} must exist`);
      assert.deepEqual(t._meta?.ui?.visibility, ["app"], `${appOnly} must be app-only`);
    }

    // 2. Check UI resource
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "ui://context-tree/app.html"), "UI resource must be listed");
    const readRes = await client.readResource({ uri: "ui://context-tree/app.html" });
    const item = readRes.contents?.[0];
    assert.equal(item?.mimeType, "text/html;profile=mcp-app");
    assert.ok(item?.text && item.text.includes("<!DOCTYPE html>"), "HTML must be non-empty");
    assert.ok(Buffer.byteLength(item.text, "utf8") < 10 * 1024 * 1024, "HTML < 10 MiB");
    assert.ok(!/<script[^>]+src=/i.test(item.text), "No external script src (CSP default-src none)");
    assert.ok(!/<link[^>]+href=["']https?:/i.test(item.text), "No external stylesheet links");

    // 3. Call open_context_monitor with empty {}
    const openRes = await client.callTool({ name: "open_context_monitor", arguments: {} });
    assert.ok(openRes.content?.[0]?.text, "content text required for model");
    const sc = openRes.structuredContent;
    assert.ok(sc, "structuredContent required for app");
    const scBytes = Buffer.byteLength(JSON.stringify(sc), "utf8");
    assert.ok(scBytes < 900 * 1024, `structuredContent (${scBytes} B) must stay well under 1 MiB`);
    assert.ok(["full_api", "local_logs"].includes(sc.mode));

    // 4. App-only snapshot
    const snapRes = await client.callTool({ name: "get_monitor_snapshot", arguments: {} });
    assert.ok(snapRes.structuredContent?.stats?.totalConversations >= 0);

    // 5. App-only detail (if any conversation exists)
    let detailSummary = "none";
    const targetId = sc.active?.id || sc.tree?.[0]?.id;
    if (targetId) {
      const detRes = await client.callTool({
        name: "get_conversation_detail",
        arguments: { conversationId: targetId },
      });
      assert.equal(detRes.structuredContent?.found, true);
      detailSummary = `history=${detRes.structuredContent.history.length}, compactions=${detRes.structuredContent.compactions.length}`;
    }

    // 6. App-only settings persistence (including default viewMode="simple", groupBy="project", collapsedGroups)
    assert.equal(sc.settings?.viewMode, "simple", "Default viewMode must be simple");
    assert.equal(sc.settings?.groupBy, "project", "Default groupBy must be project");
    const setRes = await client.callTool({
      name: "update_monitor_settings",
      arguments: {
        viewMode: "detailed",
        groupBy: "context",
        collapsedGroups: ["proj:Без проекта"],
        refreshIntervalSec: 10,
        thresholdMode: "custom_k",
        customThresholdK: 135,
      },
    });
    assert.equal(setRes.structuredContent?.settings?.viewMode, "detailed");
    assert.equal(setRes.structuredContent?.settings?.groupBy, "context");
    assert.deepEqual(setRes.structuredContent?.settings?.collapsedGroups, ["proj:Без проекта"]);
    assert.equal(setRes.structuredContent?.settings?.refreshIntervalSec, 10);
    assert.equal(setRes.structuredContent?.settings?.customThresholdK, 135);
    const persisted = JSON.parse(await fs.readFile(path.join(tmpDataDir, "settings.json"), "utf8"));
    assert.equal(persisted.viewMode, "detailed");
    assert.equal(persisted.customThresholdK, 135);

    // 7. Explicit selectedId detection
    if (targetId) {
      const selRes = await client.callTool({
        name: "open_context_monitor",
        arguments: { selectedId: targetId },
      });
      assert.equal(selRes.structuredContent?.detectedConversationId, targetId.toLowerCase());
      assert.equal(selRes.structuredContent?.detectedSource, "arg");
    }

    // 8. App-only GitHub update check (mocked remote manifest for deterministic offline test)
    const updRes = await client.callTool({
      name: "check_plugin_updates",
      arguments: { force: true },
    });
    const updInfo = updRes.structuredContent?.updateInfo;
    assert.ok(updInfo, "updateInfo must be returned");
    assert.equal(updInfo.currentVersion, "1.1.0");
    if (envOverrides.CONTEXT_TREE_MOCK_REMOTE_MANIFEST) {
      assert.equal(updInfo.status, "ok");
      assert.equal(updInfo.latestVersion, "9.9.9");
      assert.equal(updInfo.updateAvailable, true);
    }

    console.log(
      `[PASS] ${label}: mode=${sc.modeLabel}, convs=${sc.stats.totalConversations}, roots=${sc.stats.rootConversations}, subchats=${sc.stats.subchats}, compactions=${sc.stats.compactions}, payload=${(
        scBytes / 1024
      ).toFixed(1)}KiB, html=${(Buffer.byteLength(item.text, "utf8") / 1024).toFixed(1)}KiB, detail(${detailSummary})`
    );
  } finally {
    await client.close();
    await fs.rm(tmpDataDir, { recursive: true, force: true });
  }
}

async function runSwarmBranchFixtureTest() {
  const tmpBrain = await fs.mkdtemp(path.join(os.tmpdir(), "context-tree-swarm-"));
  const coordId = "11111111-1111-1111-1111-111111111111";
  const w1Id = "22222222-2222-2222-2222-222222222222";
  const w2Id = "33333333-3333-3333-3333-333333333333";

  async function writeTranscript(cid, lines) {
    const dir = path.join(tmpBrain, cid, ".system_generated", "logs");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "transcript.jsonl"),
      lines.map((o) => JSON.stringify(o)).join("\n") + "\n",
      "utf8"
    );
  }

  try {
    await writeTranscript(coordId, [
      { type: "USER_INPUT", content: "<USER_REQUEST>Fix Apple Pencil issues</USER_REQUEST>", created_at: "2026-11-27T19:00:00Z" },
      {
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-neon-high",
        input_tokens: 5000,
        cache_read_tokens: 68000,
        output_tokens: 2000,
        step_index: 1,
        created_at: "2026-11-27T19:01:00Z",
        tool_calls: [{ name: "swarm", args: { action: '"title"', title: '"Dr2 Swarm"' } }],
      },
      {
        type: "GENERIC",
        content: `{"status":"added","name":"pencil-fix","model":"gemini-4-neon-xhigh","conversation_id":"${w1Id}"}`,
        created_at: "2026-11-27T19:01:05Z",
      },
      {
        type: "GENERIC",
        content: `{"status":"added","name":"guide-fix","model":"gemini-4-neon-xhigh","conversation_id":"${w2Id}"}`,
        created_at: "2026-11-27T19:01:10Z",
      },
    ]);

    await writeTranscript(w1Id, [
      {
        type: "SYSTEM_MESSAGE",
        content: `[Message] sender=${coordId} content=[swarm] new board message #1`,
        created_at: "2026-11-27T19:01:05Z",
      },
      {
        type: "SYSTEM_MESSAGE",
        content: `[Message] sender=${coordId} content=You have just started. Your assignment is on the board.`,
        created_at: "2026-11-27T19:01:05Z",
      },
      {
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-neon-xhigh",
        input_tokens: 8000,
        cache_read_tokens: 178000,
        output_tokens: 2000,
        step_index: 2,
        created_at: "2026-11-27T19:02:00Z",
      },
    ]);

    await writeTranscript(w2Id, [
      {
        // Board notification from peer worker w1 — must NOT cause staircase nesting!
        type: "SYSTEM_MESSAGE",
        content: `[Message] sender=${w1Id} content=[swarm] new board message #2`,
        created_at: "2026-11-27T19:01:10Z",
      },
      {
        type: "SYSTEM_MESSAGE",
        content: `[Message] sender=${coordId} content=You have just started. Your assignment is on the board.`,
        created_at: "2026-11-27T19:01:10Z",
      },
      {
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-neon-xhigh",
        input_tokens: 8000,
        cache_read_tokens: 498000,
        output_tokens: 2000,
        step_index: 3,
        created_at: "2026-11-27T19:03:00Z",
      },
    ]);

    const scanner = new TranscriptScanner(tmpBrain);
    const transcripts = await scanner.scanAll();
    const snap = buildMonitorSnapshot({
      transcripts,
      apiResult: { mode: "local_logs", conversationsById: new Map(), currentConversationId: null },
      settings: DEFAULT_SETTINGS,
    });

    assert.equal(snap.tree.length, 1, "Swarm workers must attach to coordinator as single root");
    const root = snap.tree[0];
    assert.equal(root.id, coordId);
    assert.equal(root.isSwarmCoordinator, true);
    assert.equal(root.children.length, 2, "Both swarm workers must be direct children (no staircase)");
    assert.equal(root.descendantCount, 2);

    const names = root.children.map((c) => c.title).sort();
    assert.deepEqual(names, ["guide-fix", "pencil-fix"]);
    assert.ok(root.children.every((c) => c.isSwarmWorker === true));

    assert.ok(root.branch, "Coordinator must include branch aggregate");
    assert.equal(root.branch.totalContextTokens, 75000 + 188000 + 508000);
    assert.equal(root.branch.maxChildTitle, "guide-fix");
    assert.equal(root.branch.maxChildContextTokens, 508000);
    assert.equal(root.branch.maxChildSeverity, "red");
    assert.equal(root.branch.worstSeverity, "red");
    assert.equal(root.branch.overThresholdChildren, 1);
    assert.equal(root.branch.hasSwarmChildren, true);

    console.log(
      `[PASS] Swarm & Branch fixture: children=${names.join(",")}, branchTotal=${root.branch.totalContextTokens}, peak=${root.branch.maxChildTitle}(${root.branch.maxChildContextTokens})`
    );
  } finally {
    await fs.rm(tmpBrain, { recursive: true, force: true });
  }
}

async function main() {
  await runSwarmBranchFixtureTest();

  // Always test clean Local Logs mode (no LS env vars) + mocked update check
  await runSuite("Local Logs (no env)", {
    ANTIGRAVITY_LS_ADDRESS: undefined,
    ANTIGRAVITY_CSRF_TOKEN: undefined,
    ANTIGRAVITY_CONVERSATION_ID: undefined,
    ANTIGRAVITY_PROJECT_ID: undefined,
    AGY_DISABLE_AUTO_POLL: "1",
    CONTEXT_TREE_MOCK_REMOTE_MANIFEST: JSON.stringify({ version: "9.9.9" }),
  });

  // Also test Full API mode if current shell has LS env vars
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    await runSuite("Full API (with LS env)", {
      AGY_DISABLE_AUTO_POLL: "1",
      CONTEXT_TREE_MOCK_REMOTE_MANIFEST: JSON.stringify({ version: "9.9.9" }),
    });
  } else {
    console.log("[INFO] Skipping Full API test: no ANTIGRAVITY_LS_ADDRESS in shell");
  }
}

main().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});
