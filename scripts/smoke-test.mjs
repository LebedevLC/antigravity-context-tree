#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

    for (const appOnly of ["get_monitor_snapshot", "get_conversation_detail", "update_monitor_settings", "create_project_chat", "rename_conversation"]) {
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

async function main() {
  // Always test clean Local Logs mode (no LS env vars)
  await runSuite("Local Logs (no env)", {
    ANTIGRAVITY_LS_ADDRESS: undefined,
    ANTIGRAVITY_CSRF_TOKEN: undefined,
    ANTIGRAVITY_CONVERSATION_ID: undefined,
    ANTIGRAVITY_PROJECT_ID: undefined,
  });

  // Also test Full API mode if current shell has LS env vars
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    await runSuite("Full API (with LS env)", {});
  } else {
    console.log("[INFO] Skipping Full API test: no ANTIGRAVITY_LS_ADDRESS in shell");
  }
}

main().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});
