function cleanFeed(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("情报源必须返回 JSON 对象");
  const matches = payload.matches && typeof payload.matches === "object" ? payload.matches : {};
  return {
    version: Number(payload.version || 1),
    source: payload.source || "external-context-feed",
    updatedAt: payload.updatedAt || null,
    matches
  };
}

export async function fetchContextFeed(url, token) {
  if (!url) return { configured: false, source: null, updatedAt: null, matches: {} };
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("联网情报源必须使用 HTTPS");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(parsed, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`联网情报源 HTTP ${response.status}`);
    const feed = cleanFeed(await response.json());
    return { configured: true, ...feed };
  } finally {
    clearTimeout(timer);
  }
}

function mergeEntry(remote = {}, local = {}) {
  return {
    ...remote,
    ...local,
    externalMarket: { ...(remote.externalMarket || {}), ...(local.externalMarket || {}) },
    teamNews: local.teamNews || remote.teamNews || [],
    coachNews: local.coachNews || remote.coachNews || []
  };
}

export function mergeContexts(remoteFeed, localFile) {
  const keys = new Set([
    ...Object.keys(remoteFeed?.matches || {}),
    ...Object.keys(localFile?.matches || {})
  ]);
  return {
    version: Math.max(Number(remoteFeed?.version || 1), Number(localFile?.version || 1)),
    matches: Object.fromEntries([...keys].map(key => [key, mergeEntry(remoteFeed?.matches?.[key], localFile?.matches?.[key])]))
  };
}
