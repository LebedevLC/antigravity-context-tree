/**
 * Model metadata: human-readable display names, context window limits,
 * and adaptive default auto-compaction thresholds.
 */

const ONE_MILLION = 1_048_576;
const TWO_HUNDRED_K = 200_000;
const ONE_TWENTY_EIGHT_K = 131_072;

export function getModelInfo(rawModel) {
  if (!rawModel || typeof rawModel !== "string") {
    return {
      raw: "unknown",
      displayName: "Неизвестная модель",
      shortName: "Unknown",
      contextLimit: TWO_HUNDRED_K,
      defaultCompactionThreshold: 135_000,
    };
  }

  const m = rawModel.trim();
  const lower = m.toLowerCase();

  // Gemini Pro Orchestrator variants
  if (lower.startsWith("gemini-pro-orchestrator")) {
    const rest = m.replace(/^gemini-pro-orchestrator-?/i, "");
    const suffix = rest ? ` (${capitalize(rest)})` : " (Carbon)";
    return {
      raw: m,
      displayName: `Orchestrator${suffix}`,
      shortName: `Orchestrator${rest ? " " + capitalize(rest) : ""}`,
      contextLimit: ONE_MILLION,
      defaultCompactionThreshold: 450_000,
    };
  }

  // Gemini 4 family (1M context window)
  if (lower.startsWith("gemini-4")) {
    const parts = m.split("-");
    const codename = parts[2] ? capitalize(parts[2]) : "";
    const tierRaw = parts.slice(3).join(" ");
    const tier = formatTier(tierRaw);
    const base = codename ? `Gemini 4 ${codename}` : "Gemini 4";
    return {
      raw: m,
      displayName: tier ? `${base} (${tier})` : base,
      shortName: base,
      contextLimit: ONE_MILLION,
      defaultCompactionThreshold: 450_000,
    };
  }

  // Gemini 3.x / 2.x / 1.5 family (1M context window)
  if (lower.startsWith("gemini-")) {
    const parts = m.split("-");
    const ver = parts[1] || "";
    const variant = parts[2] ? capitalize(parts[2]) : "";
    const tier = formatTier(parts.slice(3).join(" "));
    const base = `Gemini ${ver}${variant ? " " + variant : ""}`.trim();
    return {
      raw: m,
      displayName: tier ? `${base} (${tier})` : base,
      shortName: base,
      contextLimit: ONE_MILLION,
      defaultCompactionThreshold: 450_000,
    };
  }

  // Claude family
  if (lower.startsWith("claude-")) {
    const parts = m.split("-");
    const family = parts[1] ? capitalize(parts[1]) : "";
    const nums = [];
    const rest = [];
    for (const p of parts.slice(2)) {
      if (/^\d+$/.test(p) && rest.length === 0) {
        nums.push(p);
      } else {
        rest.push(p);
      }
    }
    const ver = nums.join(".");
    const tier = formatTier(rest.join(" "));
    const base = `Claude ${family}${ver ? " " + ver : ""}`.trim();
    return {
      raw: m,
      displayName: tier ? `${base} (${tier})` : base,
      shortName: base,
      contextLimit: TWO_HUNDRED_K,
      defaultCompactionThreshold: 135_000,
    };
  }

  // GPT-OSS family
  if (lower.startsWith("gpt-oss")) {
    const parts = m.split("-");
    const size = parts[2] ? parts[2].toUpperCase() : "";
    const tier = formatTier(parts.slice(3).join(" "));
    const base = `GPT-OSS${size ? " " + size : ""}`;
    return {
      raw: m,
      displayName: tier ? `${base} (${tier})` : base,
      shortName: base,
      contextLimit: ONE_TWENTY_EIGHT_K,
      defaultCompactionThreshold: 96_000,
    };
  }

  // OpenAI GPT / o-series fallback
  if (lower.startsWith("gpt-") || /^o[1-9]/.test(lower)) {
    return {
      raw: m,
      displayName: m.toUpperCase(),
      shortName: m.toUpperCase(),
      contextLimit: TWO_HUNDRED_K,
      defaultCompactionThreshold: 135_000,
    };
  }

  return {
    raw: m,
    displayName: m,
    shortName: m.length > 22 ? m.slice(0, 21) + "…" : m,
    contextLimit: TWO_HUNDRED_K,
    defaultCompactionThreshold: 135_000,
  };
}

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function formatTier(raw) {
  if (!raw) return "";
  const map = {
    xhigh: "XHigh",
    high: "High",
    medium: "Medium",
    low: "Low",
    "tiered high": "Tiered High",
    "tiered medium": "Tiered Medium",
  };
  const key = raw.toLowerCase();
  if (map[key]) return map[key];
  return raw
    .split(/\s+/)
    .map(capitalize)
    .join(" ");
}

export function resolveCompactionThreshold(modelInfo, settings) {
  const limit = modelInfo?.contextLimit || TWO_HUNDRED_K;
  const mode = settings?.thresholdMode || "adaptive";

  if (mode === "custom_k") {
    const custom = Number(settings?.customThresholdK);
    if (Number.isFinite(custom) && custom >= 10) {
      return Math.min(Math.round(custom * 1000), limit);
    }
  }

  if (mode === "percent") {
    const pct = Number(settings?.customThresholdPercent);
    if (Number.isFinite(pct) && pct >= 5 && pct <= 98) {
      return Math.round((limit * pct) / 100);
    }
  }

  return modelInfo?.defaultCompactionThreshold || 135_000;
}
