/**
 * Optional ConversationService client over documented local Connect HTTP+JSON API.
 * Gracefully degrades to Local Logs mode if ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN
 * are not provided to the MCP server process or the endpoint is unreachable.
 */

const IDLE_CACHE_TTL_MS = 60_000;
const RUNNING_CACHE_TTL_MS = 5_000;
const LIST_CACHE_TTL_MS = 3_000;
const RPC_TIMEOUT_MS = 2_500;

export class ConversationApiClient {
  constructor() {
    /** @type {Map<string, { fetchedAt: number, data: any }>} */
    this.convCache = new Map();
    this.lastList = null;
    this.lastListAt = 0;
    this.lastProbeError = null;
    this.available = false;
  }

  getEnvConfig() {
    const address = (process.env.ANTIGRAVITY_LS_ADDRESS || "").trim();
    const csrfToken = (process.env.ANTIGRAVITY_CSRF_TOKEN || "").trim();
    const projectId = (process.env.ANTIGRAVITY_PROJECT_ID || "").trim() || null;
    const conversationId = (process.env.ANTIGRAVITY_CONVERSATION_ID || "").trim() || null;
    return {
      address,
      csrfToken,
      projectId,
      conversationId,
      hasEnv: Boolean(address && csrfToken),
    };
  }

  async rpc(method, body) {
    const { address, csrfToken, hasEnv } = this.getEnvConfig();
    if (!hasEnv) {
      throw new Error("missing_env");
    }

    const url = `http://${address}/product.v1.ConversationService/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-antigravity-csrf-token": csrfToken,
      },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`http_${res.status}`);
    }
    return await res.json();
  }

  /**
   * Fetch metadata for top-level conversations + specific IDs from brain/.
   * Returns { mode: "full_api" | "local_logs", reason, conversationsById: Map<string, any> }
   */
  async fetchMetadata(brainIds, { includeArchived = false } = {}) {
    const env = this.getEnvConfig();
    if (!env.hasEnv) {
      this.available = false;
      this.lastProbeError = "ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN не переданы процессу MCP";
      return {
        mode: "local_logs",
        reason: this.lastProbeError,
        hasEnv: false,
        currentConversationId: env.conversationId,
        currentProjectId: env.projectId,
        conversationsById: new Map(),
      };
    }

    const byId = new Map();
    const now = Date.now();

    try {
      // 1. ListConversations (cached briefly)
      if (!this.lastList || now - this.lastListAt > LIST_CACHE_TTL_MS || this.lastList.includeArchived !== includeArchived) {
        const allListed = [];
        let pageToken = "";
        for (let page = 0; page < 3; page++) {
          const resp = await this.rpc("ListConversations", {
            pageSize: 100,
            includeArchived,
            ...(pageToken ? { pageToken } : {}),
          });
          if (Array.isArray(resp?.conversations)) {
            allListed.push(...resp.conversations);
          }
          pageToken = resp?.nextPageToken || "";
          if (!pageToken) break;
        }
        this.lastList = { includeArchived, items: allListed };
        this.lastListAt = now;
      }

      for (const conv of this.lastList.items) {
        if (conv?.id) {
          byId.set(conv.id, conv);
          this.convCache.set(conv.id, { fetchedAt: now, data: conv });
        }
      }

      // 2. GetConversation for brain IDs missing from ListConversations (e.g., child subagents or archived)
      const missingIds = [];
      for (const id of brainIds) {
        if (byId.has(id)) continue;
        const cached = this.convCache.get(id);
        if (cached) {
          const isRunning = cached.data?.state?.runState === "RUN_STATE_RUNNING";
          const ttl = isRunning ? RUNNING_CACHE_TTL_MS : IDLE_CACHE_TTL_MS;
          if (now - cached.fetchedAt < ttl) {
            if (cached.data) byId.set(id, cached.data);
            continue;
          }
        }
        missingIds.push(id);
      }

      // Fetch missing in bounded batches (cap to avoid bursts on huge directories)
      const toFetch = missingIds.slice(0, 60);
      const BATCH = 8;
      for (let i = 0; i < toFetch.length; i += BATCH) {
        const slice = toFetch.slice(i, i + BATCH);
        await Promise.all(
          slice.map(async (id) => {
            try {
              const conv = await this.rpc("GetConversation", { conversationId: id });
              const obj = conv?.conversation || conv;
              if (obj?.id) {
                byId.set(obj.id, obj);
                this.convCache.set(id, { fetchedAt: Date.now(), data: obj });
              } else {
                this.convCache.set(id, { fetchedAt: Date.now(), data: null });
              }
            } catch {
              this.convCache.set(id, { fetchedAt: Date.now(), data: null });
            }
          })
        );
      }

      // Prune stale cache entries
      if (this.convCache.size > 500) {
        const activeSet = new Set([...brainIds, ...byId.keys()]);
        for (const k of this.convCache.keys()) {
          if (!activeSet.has(k)) this.convCache.delete(k);
        }
      }

      this.available = true;
      this.lastProbeError = null;
      return {
        mode: "full_api",
        reason: null,
        hasEnv: true,
        currentConversationId: env.conversationId,
        currentProjectId: env.projectId,
        conversationsById: byId,
      };
    } catch (err) {
      this.available = false;
      this.lastProbeError = `ConversationService недоступен (${err?.message || "error"})`;
      return {
        mode: "local_logs",
        reason: this.lastProbeError,
        hasEnv: true,
        currentConversationId: env.conversationId,
        currentProjectId: env.projectId,
        conversationsById: new Map(),
      };
    }
  }

  async createConversation({ title, prompt, projectId, model }) {
    const env = this.getEnvConfig();
    const payload = {};
    if (projectId || env.projectId) payload.projectId = projectId || env.projectId;
    if (title) payload.title = title;
    if (model) payload.model = model;
    if (prompt) payload.prompt = [{ text: prompt }];
    const resp = await this.rpc("CreateConversation", payload);
    this.lastListAt = 0; // invalidate list cache
    return resp?.conversation || resp;
  }
}
