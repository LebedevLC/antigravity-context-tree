#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

import { TranscriptScanner } from "./transcripts.mjs";
import { ConversationApiClient } from "./conversations-api.mjs";
import { SettingsStore, resolveDataDir } from "./settings.mjs";
import { TitlesStore } from "./titles.mjs";
import { buildMonitorSnapshot } from "./tree.mjs";
import { resolveCompactionThreshold } from "./models.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const APP_URI = "ui://context-tree/app.html";

function parseCliArgs(argv) {
  let dataDir = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--data_dir=")) {
      dataDir = arg.slice("--data_dir=".length);
    } else if (arg === "--data_dir" && argv[i + 1]) {
      dataDir = argv[++i];
    }
  }
  return { dataDir };
}

const cli = parseCliArgs(process.argv.slice(2));
const dataDir = resolveDataDir(cli.dataDir);
const settingsStore = new SettingsStore(dataDir);
const titlesStore = new TitlesStore(dataDir);
const scanner = new TranscriptScanner();
const apiClient = new ConversationApiClient();

function formatTokensShort(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const UUID_EXACT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function extractUuidsFromValue(val, out = new Set(), depth = 0) {
  if (depth > 4 || val == null) return out;
  if (typeof val === "string") {
    const matches = val.match(UUID_EXACT_RE);
    if (matches) {
      for (const m of matches) out.add(m.toLowerCase());
    }
    return out;
  }
  if (Array.isArray(val)) {
    for (const item of val) extractUuidsFromValue(item, out, depth + 1);
    return out;
  }
  if (typeof val === "object") {
    for (const v of Object.values(val)) extractUuidsFromValue(v, out, depth + 1);
  }
  return out;
}

function detectConversationIdFromExtra(extra, knownIds) {
  if (!extra || typeof extra !== "object") return null;
  const candidates = extractUuidsFromValue({
    _meta: extra._meta,
    sessionId: extra.sessionId,
  });
  for (const cand of candidates) {
    if (knownIds.has(cand)) return cand;
  }
  return null;
}

async function recordCallMetaDiagnostic(toolName, extra, matchedId) {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const metaKeys = extra?._meta && typeof extra._meta === "object" ? Object.keys(extra._meta) : [];
    const extraKeys = extra && typeof extra === "object" ? Object.keys(extra) : [];
    await fs.writeFile(
      path.join(dataDir, "last-call-meta.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          toolName,
          extraKeys,
          metaKeys,
          hasSessionId: Boolean(extra?.sessionId),
          matchedConversationId: Boolean(matchedId),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  } catch {
    // non-fatal
  }
}

async function computeSnapshot(filter = {}, extra = null, explicitSelectedId = null) {
  const [settings, titlesData, transcripts] = await Promise.all([
    settingsStore.load(),
    titlesStore.loadAll(),
    scanner.scanAll(),
  ]);
  const brainIds = transcripts.map((t) => t.id);
  const includeArchived = filter.includeArchived ?? settings.showArchived ?? false;
  const apiResult = await apiClient.fetchMetadata(brainIds, { includeArchived });
  const snapshot = buildMonitorSnapshot({ transcripts, apiResult, settings, titlesData, filter });

  const knownIds = new Set(brainIds.map((id) => id.toLowerCase()));
  for (const id of apiResult.conversationsById.keys()) {
    knownIds.add(id.toLowerCase());
  }

  let detectedConversationId = null;
  let detectedSource = null;

  if (explicitSelectedId && knownIds.has(explicitSelectedId.toLowerCase())) {
    detectedConversationId = explicitSelectedId.toLowerCase();
    detectedSource = "arg";
  } else {
    const fromExtra = detectConversationIdFromExtra(extra, knownIds);
    if (fromExtra) {
      detectedConversationId = fromExtra;
      detectedSource = "meta";
    } else if (apiResult.currentConversationId && knownIds.has(apiResult.currentConversationId.toLowerCase())) {
      detectedConversationId = apiResult.currentConversationId.toLowerCase();
      detectedSource = "env";
    }
  }

  return {
    ...snapshot,
    detectedConversationId,
    detectedSource,
  };
}

async function loadAppHtml() {
  const overridePath = process.env.CONTEXT_TREE_APP_HTML;
  const htmlPath = overridePath && overridePath.trim()
    ? overridePath.trim()
    : path.join(PLUGIN_ROOT, "dist", "app.html");
  return await fs.readFile(htmlPath, "utf8");
}

const server = new McpServer(
  {
    name: "context-tree-monitor",
    version: "1.0.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// 1. UI Resource (self-contained single HTML bundle)
registerAppResource(
  server,
  "Контекст и подчаты UI",
  APP_URI,
  {
    description: "Интерактивная панель мониторинга контекста (токенов) и дерева чатов/подчатов Antigravity.",
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
  async () => {
    const html = await loadAppHtml();
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    };
  }
);

// 2. Primary model-visible + entrypoint tool (all arguments optional; handles {} cleanly)
registerAppTool(
  server,
  "open_context_monitor",
  {
    title: "Контекст и подчаты",
    description:
      "Открывает интерактивную панель мониторинга занятого контекста (токены, кэш, автокомпакции CHECKPOINT) и дерева чатов/подчатов. Если вызываешь инструмент из чата, обязательно передай текущий Conversation ID в selectedId, чтобы сразу выбрался именно этот чат.",
    inputSchema: {
      selectedId: z
        .string()
        .optional()
        .describe("UUID текущего или нужного чата (если вызвано агентом из чата — передай Conversation ID текущей беседы)."),
      search: z
        .string()
        .optional()
        .describe("Опциональный поисковый фильтр по названию, модели или ID."),
    },
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
      "com.google.antigravity/ui": {
        entrypoints: [
          { type: "aux_pane", title: "Контекст и подчаты" },
          { type: "global", title: "Контекст и подчаты" },
        ],
      },
    },
  },
  async (args, extra) => {
    const snapshot = await computeSnapshot({ search: args?.search }, extra, args?.selectedId || null);
    await recordCallMetaDiagnostic("open_context_monitor", extra, snapshot.detectedConversationId);
    const selectedId = snapshot.detectedConversationId || args?.selectedId || null;
    const active = snapshot.active;
    const summaryText = active
      ? `Монитор контекста (${snapshot.modeLabel}): активный чат «${active.title}» — ${formatTokensShort(
          active.contextTokens
        )} / ${formatTokensShort(active.contextLimit)} (${active.percentOfLimit}%), кэш ${
          active.cacheHitRatio
        }%, сжатий: ${active.compactionCount}. Всего чатов: ${snapshot.stats.totalConversations} (подчатов: ${
          snapshot.stats.subchats
        }).`
      : `Монитор контекста (${snapshot.modeLabel}): чатов найдено ${snapshot.stats.totalConversations}.`;

    return {
      content: [{ type: "text", text: summaryText }],
      structuredContent: {
        ...snapshot,
        initialSelectedId: selectedId,
      },
    };
  }
);

// 3. App-only tool: background snapshot polling (hidden from model)
registerAppTool(
  server,
  "get_monitor_snapshot",
  {
    title: "Обновить снимок контекста",
    description: "App-only: возвращает актуальное дерево чатов, токены и настройки.",
    inputSchema: {
      search: z.string().optional(),
      includeArchived: z.boolean().optional(),
      maxAgeDays: z.number().optional(),
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  async (args, extra) => {
    const snapshot = await computeSnapshot(
      {
        search: args?.search,
        includeArchived: args?.includeArchived,
        maxAgeDays: args?.maxAgeDays,
      },
      extra
    );
    return {
      content: [{ type: "text", text: "ok" }],
      structuredContent: snapshot,
    };
  }
);

// 4. App-only tool: full conversation detail (step history + compactions + subchats)
registerAppTool(
  server,
  "get_conversation_detail",
  {
    title: "Детализация чата",
    description: "App-only: подробная история шагов, события CHECKPOINT и подчаты выбранной беседы.",
    inputSchema: {
      conversationId: z.string().min(1),
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  async ({ conversationId }) => {
    const settings = await settingsStore.load();
    const transcripts = await scanner.scanAll();
    const tr = transcripts.find((t) => t.id === conversationId) || null;

    if (!tr) {
      return {
        content: [{ type: "text", text: "not_found" }],
        structuredContent: { found: false, conversationId },
      };
    }

    const compactionThreshold = resolveCompactionThreshold(tr.model, settings);
    const directChildren = transcripts
      .filter((other) => {
        if (other.id === conversationId) return false;
        if (other.inferredParentId === conversationId) return true;
        return (tr.spawnedChildren || []).some((ch) => ch.childId === other.id);
      })
      .map((ch) => ({
        id: ch.id,
        title:
          (tr.spawnedChildren || []).find((x) => x.childId === ch.id)?.role ||
          ch.localTitle,
        modelShort: ch.model.shortName,
        contextTokens: ch.lastStep?.contextTokens || 0,
        contextLimit: ch.model.contextLimit,
        runState: ch.localRunState === "RUNNING" ? "running" : "idle",
        updatedAt: ch.updatedAt,
      }));

    return {
      content: [{ type: "text", text: "ok" }],
      structuredContent: {
        found: true,
        id: tr.id,
        filePath: tr.filePath,
        sizeBytes: tr.sizeBytes,
        modelName: tr.model.displayName,
        modelRaw: tr.model.raw,
        contextLimit: tr.model.contextLimit,
        compactionThreshold,
        lastStep: tr.lastStep,
        sessionTotals: tr.sessionTotals,
        userTurns: tr.userTurns,
        plannerSteps: tr.plannerSteps,
        compactions: tr.compactions,
        history: tr.fullHistory,
        children: directChildren,
      },
    };
  }
);

// 5. App-only tool: persist user preferences into ${PLUGIN_DATA}/settings.json
registerAppTool(
  server,
  "update_monitor_settings",
  {
    title: "Сохранить настройки монитора",
    description: "App-only: сохраняет настройки интервала, порогов и фильтров в PLUGIN_DATA.",
    inputSchema: {
      viewMode: z.enum(["simple", "detailed"]).optional(),
      groupBy: z.enum(["project", "context", "date"]).optional(),
      collapsedGroups: z.array(z.string()).optional(),
      autoRefresh: z.boolean().optional(),
      refreshIntervalSec: z.number().optional(),
      thresholdMode: z.enum(["adaptive", "custom_k", "percent"]).optional(),
      customThresholdK: z.number().optional(),
      customThresholdPercent: z.number().optional(),
      warnRatio: z.number().optional(),
      showArchived: z.boolean().optional(),
      maxAgeDays: z.number().optional(),
      pinnedConversationId: z.string().nullable().optional(),
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  async (patch) => {
    const saved = await settingsStore.update(patch);
    const snapshot = await computeSnapshot({});
    return {
      content: [{ type: "text", text: "saved" }],
      structuredContent: {
        settings: saved,
        snapshot,
      },
    };
  }
);

// 6. App-only tool: create a new conversation via ConversationService (only when Full API is active)
registerAppTool(
  server,
  "create_project_chat",
  {
    title: "Создать чат через ConversationService",
    description: "App-only: создаёт новый чат в текущем проекте через ConversationService (если API доступен).",
    inputSchema: {
      title: z.string().optional(),
      prompt: z.string().optional(),
      projectId: z.string().optional(),
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  async ({ title, prompt, projectId }) => {
    try {
      const conv = await apiClient.createConversation({ title, prompt, projectId });
      return {
        content: [{ type: "text", text: "created" }],
        structuredContent: {
          ok: true,
          conversationId: conv?.id || null,
        },
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `error: ${err?.message || "failed"}` }],
        structuredContent: {
          ok: false,
          error: err?.message || "ConversationService недоступен",
        },
      };
    }
  }
);

// 7. App-only tool: set or clear a custom display title for a conversation
registerAppTool(
  server,
  "rename_conversation",
  {
    title: "Переименовать чат в мониторе",
    description: "App-only: сохраняет пользовательское название чата в PLUGIN_DATA/custom-titles.json.",
    inputSchema: {
      conversationId: z.string().min(1),
      title: z.string(),
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  async ({ conversationId, title }) => {
    await titlesStore.setCustomTitle(conversationId, title);
    const snapshot = await computeSnapshot({});
    return {
      content: [{ type: "text", text: "renamed" }],
      structuredContent: {
        ok: true,
        snapshot,
      },
    };
  }
);

async function recordStartupDiagnostic() {
  try {
    const env = apiClient.getEnvConfig();
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "last-startup.json"),
      JSON.stringify(
        {
          startedAt: new Date().toISOString(),
          nodeVersion: process.version,
          hasLsAddress: Boolean(env.address),
          hasCsrfToken: Boolean(env.csrfToken),
          hasConversationId: Boolean(env.conversationId),
          hasProjectId: Boolean(env.projectId),
          expectedMode: env.hasEnv ? "full_api" : "local_logs",
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  } catch {
    // non-fatal
  }
}

async function main() {
  await recordStartupDiagnostic();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[context-tree-monitor] fatal:", err);
  process.exit(1);
});
