import { resolveCompactionThreshold } from "./models.mjs";

function normalizeRunState(apiRunState, localRunState) {
  if (apiRunState === "RUN_STATE_RUNNING") return "running";
  if (apiRunState === "RUN_STATE_CANCELLING") return "running";
  if (apiRunState === "RUN_STATE_IDLE") return "idle";
  return localRunState === "RUNNING" ? "running" : "idle";
}

function computeSeverity(contextTokens, contextLimit, compactionThreshold, warnRatio) {
  if (!contextTokens) return "green";
  const pctOfLimit = contextLimit > 0 ? contextTokens / contextLimit : 0;
  const pctOfThreshold = compactionThreshold > 0 ? contextTokens / compactionThreshold : 0;
  if (pctOfLimit >= 0.85 || pctOfThreshold >= 0.95) return "red";
  if (pctOfLimit >= 0.65 || pctOfThreshold >= (warnRatio || 0.75)) return "yellow";
  return "green";
}

/**
 * Combine local transcripts + optional ConversationService metadata into a unified
 * flat map and hierarchical parent -> children tree.
 */
export function buildMonitorSnapshot({ transcripts, apiResult, settings, titlesData = null, filter = {} }) {
  const apiById = apiResult.conversationsById || new Map();
  const syncedById = titlesData?.syncedById || {};
  const projectNames = titlesData?.projectNames || {};
  const customById = titlesData?.customById || {};

  // Collect explicit parent->child role annotations from invoke_subagent in transcripts
  const spawnedParentByChild = new Map();
  for (const tr of transcripts) {
    for (const ch of tr.spawnedChildren || []) {
      if (!spawnedParentByChild.has(ch.childId)) {
        spawnedParentByChild.set(ch.childId, {
          parentId: tr.id,
          role: ch.role || "",
          typeName: ch.typeName || "",
          linkSource: "invoke_subagent",
        });
      }
    }
  }

  const allNodes = new Map();
  const transcriptById = new Map();

  for (const tr of transcripts) {
    transcriptById.set(tr.id, tr);
  }

  // Build nodes for all transcripts
  for (const tr of transcripts) {
    const api = apiById.get(tr.id) || null;
    const synced = syncedById[tr.id] || null;
    const customTitle = (customById[tr.id] || "").trim();
    const spawned = spawnedParentByChild.get(tr.id) || null;

    const apiParent = api?.metadata?.parentConversationId || synced?.parentId || null;
    const apiRoot = api?.metadata?.rootConversationId || null;

    let parentId = null;
    let linkSource = null;
    if (apiParent && apiParent !== tr.id) {
      parentId = apiParent;
      linkSource = api ? "api" : "synced";
    } else if (spawned && spawned.parentId !== tr.id) {
      parentId = spawned.parentId;
      linkSource = spawned.linkSource;
    } else if (tr.inferredParentId && tr.inferredParentId !== tr.id) {
      parentId = tr.inferredParentId;
      linkSource = tr.inferredLinkKind || "transcript";
    }

    const apiTitle = (api?.annotations?.title || "").trim();
    const syncedTitle = (synced?.title || "").trim();
    const apiSummary = (api?.state?.summary || "").trim();
    const roleTitle = spawned?.role
      ? `${spawned.role}${spawned.typeName ? ` (${spawned.typeName})` : ""}`
      : "";

    const title = customTitle || apiTitle || syncedTitle || roleTitle || apiSummary || tr.localTitle;
    const projectId = api?.metadata?.projectId || synced?.projectId || null;
    const projectLabel =
      (projectId && projectNames[projectId]) ||
      synced?.projectLabel ||
      tr.detectedProject ||
      null;
    const archived = Boolean(api ? api?.annotations?.archived : synced?.archived);
    const pinned = Boolean(api ? api?.annotations?.pinned : synced?.pinned);
    const runState = normalizeRunState(api?.state?.runState, tr.localRunState);

    const last = tr.lastStep;
    const contextTokens = last?.contextTokens || 0;
    const contextLimit = tr.model.contextLimit;
    const compactionThreshold = resolveCompactionThreshold(tr.model, settings);
    const percentOfLimit = contextLimit > 0 ? Number(((contextTokens / contextLimit) * 100).toFixed(2)) : 0;
    const percentOfThreshold =
      compactionThreshold > 0 ? Number(((contextTokens / compactionThreshold) * 100).toFixed(1)) : 0;
    const severity = computeSeverity(contextTokens, contextLimit, compactionThreshold, settings.warnRatio);

    const updatedMs = api?.state?.updateTime
      ? Math.max(tr.mtimeMs, Date.parse(api.state.updateTime) || 0)
      : tr.mtimeMs;

    allNodes.set(tr.id, {
      id: tr.id,
      title,
      role: spawned?.role || null,
      subagentType: spawned?.typeName || null,
      parentId,
      rootId: apiRoot || null,
      linkSource,
      projectId,
      projectLabel,
      hasCustomTitle: Boolean(customTitle),
      archived,
      pinned,
      runState,
      updatedAt: new Date(updatedMs).toISOString(),
      updatedMs,
      createdAt: api?.metadata?.createTime || tr.createdAt,
      model: tr.model,
      contextTokens,
      contextLimit,
      compactionThreshold,
      percentOfLimit,
      percentOfThreshold,
      severity,
      inputTokens: last?.inputTokens || 0,
      cacheReadTokens: last?.cacheReadTokens || 0,
      outputTokens: last?.outputTokens || 0,
      cacheHitRatio: last ? Number((last.cacheHitRatio * 100).toFixed(1)) : 0,
      lastStepAt: last?.createdAt || null,
      userTurns: tr.userTurns,
      plannerSteps: tr.plannerSteps,
      sessionTotalTokens: tr.sessionTotals.totalTokens,
      compactionCount: tr.compactionCount,
      lastCompactionAt: tr.lastCompactionAt,
      sparkline: tr.sparkline,
      hasTranscript: true,
      children: [],
    });
  }

  // Also include API-only conversations (no transcript yet) if in full_api mode
  if (apiResult.mode === "full_api") {
    for (const [id, api] of apiById.entries()) {
      if (allNodes.has(id)) continue;
      const updatedMs = Date.parse(api?.state?.updateTime || api?.metadata?.createTime || "") || 0;
      const title = (api?.annotations?.title || api?.state?.summary || `Чат ${id.slice(0, 8)}`).trim();
      const parentId = api?.metadata?.parentConversationId || null;
      allNodes.set(id, {
        id,
        title,
        role: null,
        subagentType: null,
        parentId: parentId && parentId !== id ? parentId : null,
        rootId: api?.metadata?.rootConversationId || null,
        linkSource: parentId ? "api" : null,
        projectId: api?.metadata?.projectId || null,
        archived: Boolean(api?.annotations?.archived),
        pinned: Boolean(api?.annotations?.pinned),
        runState: normalizeRunState(api?.state?.runState, "IDLE"),
        updatedAt: updatedMs ? new Date(updatedMs).toISOString() : new Date().toISOString(),
        updatedMs,
        createdAt: api?.metadata?.createTime || null,
        model: {
          raw: "unknown",
          displayName: "Нет шагов модели",
          shortName: "—",
          contextLimit: 1_048_576,
          defaultCompactionThreshold: 450_000,
        },
        contextTokens: 0,
        contextLimit: 1_048_576,
        compactionThreshold: 450_000,
        percentOfLimit: 0,
        percentOfThreshold: 0,
        severity: "green",
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        cacheHitRatio: 0,
        lastStepAt: null,
        userTurns: 0,
        plannerSteps: 0,
        sessionTotalTokens: 0,
        compactionCount: 0,
        lastCompactionAt: null,
        sparkline: [],
        hasTranscript: false,
        children: [],
      });
    }
  }

  // Validate parent references (must exist & prevent cycles)
  for (const node of allNodes.values()) {
    if (!node.parentId || !allNodes.has(node.parentId)) {
      node.parentId = null;
      continue;
    }
    // Cycle guard
    const visited = new Set([node.id]);
    let curr = node.parentId;
    while (curr) {
      if (visited.has(curr)) {
        node.parentId = null;
        break;
      }
      visited.add(curr);
      curr = allNodes.get(curr)?.parentId || null;
    }
  }

  // Apply archive & age filters to roots (keep children if parent is visible)
  const includeArchived = filter.includeArchived ?? settings.showArchived ?? false;
  const maxAgeDays = filter.maxAgeDays ?? settings.maxAgeDays ?? 0;
  const cutoffMs = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : 0;
  const search = (filter.search || "").trim().toLowerCase();

  // Build parent -> children adjacency
  const roots = [];
  for (const node of allNodes.values()) {
    if (node.parentId && allNodes.has(node.parentId)) {
      allNodes.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children by updatedMs descending, and compute branch max updatedMs
  function sortBranch(node) {
    let maxUpdated = node.updatedMs;
    let totalDescendants = 0;
    for (const ch of node.children) {
      const sub = sortBranch(ch);
      if (sub.maxUpdated > maxUpdated) maxUpdated = sub.maxUpdated;
      totalDescendants += 1 + sub.totalDescendants;
    }
    node.children.sort((a, b) => b.updatedMs - a.updatedMs);
    node.descendantCount = totalDescendants;
    node.branchUpdatedMs = maxUpdated;
    return { maxUpdated, totalDescendants };
  }

  for (const root of roots) {
    sortBranch(root);
  }

  roots.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.branchUpdatedMs - a.branchUpdatedMs;
  });

  // Filter roots
  function branchMatchesSearch(node, q) {
    if (!q) return true;
    if (
      node.title.toLowerCase().includes(q) ||
      node.id.toLowerCase().includes(q) ||
      node.model.displayName.toLowerCase().includes(q) ||
      (node.projectLabel && node.projectLabel.toLowerCase().includes(q)) ||
      (node.role && node.role.toLowerCase().includes(q))
    ) {
      return true;
    }
    return node.children.some((ch) => branchMatchesSearch(ch, q));
  }

  const filteredRoots = roots.filter((r) => {
    if (!includeArchived && r.archived) return false;
    if (cutoffMs > 0 && r.branchUpdatedMs < cutoffMs && r.runState !== "running") return false;
    if (search && !branchMatchesSearch(r, search)) return false;
    return true;
  });

  // Pick active conversation:
  // 1) User pinnedConversationId (if present)
  // 2) Current conversation from env (if present)
  // 3) Most recently updated running root/chat, or most recently updated chat with transcript
  const allList = Array.from(allNodes.values());
  let active = null;
  if (settings.pinnedConversationId && allNodes.has(settings.pinnedConversationId)) {
    active = allNodes.get(settings.pinnedConversationId);
  } else if (apiResult.currentConversationId && allNodes.has(apiResult.currentConversationId)) {
    active = allNodes.get(apiResult.currentConversationId);
  } else {
    const running = allList
      .filter((n) => n.runState === "running" && !n.parentId)
      .sort((a, b) => b.updatedMs - a.updatedMs);
    active =
      running[0] ||
      roots.find((n) => n.hasTranscript && !n.archived) ||
      allList.sort((a, b) => b.updatedMs - a.updatedMs)[0] ||
      null;
  }

  // Summary counts
  const subchatCount = allList.filter((n) => Boolean(n.parentId)).length;
  const runningCount = allList.filter((n) => n.runState === "running").length;
  const totalCompactions = allList.reduce((acc, n) => acc + (n.compactionCount || 0), 0);
  const warningCount = allList.filter((n) => n.severity === "yellow" || n.severity === "red").length;

  // Strip circular or excessive fields for wire payload
  function serializeNode(node, depth = 0) {
    return {
      id: node.id,
      title: node.title,
      role: node.role,
      subagentType: node.subagentType,
      parentId: node.parentId,
      linkSource: node.linkSource,
      projectId: node.projectId,
      projectLabel: node.projectLabel || null,
      hasCustomTitle: Boolean(node.hasCustomTitle),
      archived: node.archived,
      pinned: node.pinned,
      runState: node.runState,
      updatedAt: node.updatedAt,
      modelName: node.model.displayName,
      modelShort: node.model.shortName,
      modelRaw: node.model.raw,
      contextTokens: node.contextTokens,
      contextLimit: node.contextLimit,
      compactionThreshold: node.compactionThreshold,
      percentOfLimit: node.percentOfLimit,
      percentOfThreshold: node.percentOfThreshold,
      severity: node.severity,
      inputTokens: node.inputTokens,
      cacheReadTokens: node.cacheReadTokens,
      outputTokens: node.outputTokens,
      cacheHitRatio: node.cacheHitRatio,
      lastStepAt: node.lastStepAt,
      userTurns: node.userTurns,
      plannerSteps: node.plannerSteps,
      sessionTotalTokens: node.sessionTotalTokens,
      compactionCount: node.compactionCount,
      lastCompactionAt: node.lastCompactionAt,
      descendantCount: node.descendantCount || 0,
      sparkline: node.sparkline,
      children: depth < 5 ? node.children.map((ch) => serializeNode(ch, depth + 1)) : [],
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: apiResult.mode,
    modeLabel: apiResult.mode === "full_api" ? "Full API" : "Local Logs",
    modeReason: apiResult.reason || null,
    canCreateViaApi: apiResult.mode === "full_api",
    currentProjectId: apiResult.currentProjectId || active?.projectId || null,
    stats: {
      totalConversations: allList.length,
      rootConversations: roots.length,
      visibleRoots: filteredRoots.length,
      subchats: subchatCount,
      running: runningCount,
      compactions: totalCompactions,
      warnings: warningCount,
    },
    active: active ? serializeNode(active, 1) : null,
    tree: filteredRoots.slice(0, 120).map((r) => serializeNode(r, 0)),
    settings,
  };
}
