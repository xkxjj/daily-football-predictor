import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSchedule, fetchResults, sourceInfo } from "./lib/sporttery.mjs";
import { fetchContextFeed, mergeContexts } from "./lib/context-feed.mjs";
import { calibrate, modelInfo, predictMatch, scoreRecord, updateRatings, verificationSummary } from "./lib/model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, "data");
const paths = {
  history: resolve(dataDir, "history.json"),
  state: resolve(dataDir, "model-state.json"),
  adjustments: resolve(dataDir, "adjustments.json"),
  dashboard: resolve(dataDir, "predictions.json")
};

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function dateInShanghai(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function activeAdjustment(adjustments, match, now) {
  const entry = adjustments.matches?.[match.id] || adjustments.matches?.[`${match.home}|${match.away}`];
  if (!entry) return null;
  if (entry.expiresAt && new Date(entry.expiresAt) <= now) return null;
  const stillActive = item => item?.source && (!item.expiresAt || new Date(item.expiresAt) > now);
  return {
    ...entry,
    externalMarket: stillActive(entry.externalMarket) ? entry.externalMarket : null,
    teamNews: (entry.teamNews || []).filter(stillActive),
    coachNews: (entry.coachNews || []).filter(stillActive)
  };
}

function publicRecord(record) {
  const { diagnostics, revisions, ...safe } = record;
  return safe;
}

await mkdir(dataDir, { recursive: true });
const now = new Date();
const today = dateInShanghai(now);
const windowEnd = addDays(today, 1);

const [historyFile, state, localAdjustments, contextFeed] = await Promise.all([
  readJson(paths.history, { version: 1, records: [] }),
  readJson(paths.state, { version: 1, teamRatings: {}, leagueGoals: {}, processedResults: [] }),
  readJson(paths.adjustments, { version: 2, matches: {} }),
  fetchContextFeed(process.env.FOOTBALL_CONTEXT_FEED_URL, process.env.FOOTBALL_CONTEXT_FEED_TOKEN)
    .catch(error => {
      console.warn(`联网情报源暂不可用，继续使用本地与官方数据：${error.message}`);
      return { configured: true, source: null, updatedAt: null, matches: {}, error: error.message };
    })
]);
const adjustments = mergeContexts(contextFeed, localAdjustments);

// 2.2 首次升级时回填两年用于交锋样本；日常仅复查 45 天，且通过 matchId 去重。
const needsBackfill = state.schemaVersion !== 3;
if (needsBackfill) {
  state.teamRatings = {};
  state.teamForm = {};
  state.leagueGoals = {};
  state.headToHead = {};
  state.processedResults = [];
  state.schemaVersion = 3;
}
const historyStart = addDays(today, needsBackfill ? -730 : -45);

console.log(`同步体彩网：赛程 ${today}—${windowEnd}，赛果 ${historyStart}—${today}`);
// 官方接口对境外机房偶尔返回 567。赛程优先串行获取，避免并发触发风控；
// 赛果同步失败时保留既有历史与验真，未来预测仍可继续更新。
let schedule;
try {
  schedule = await fetchSchedule();
} catch (error) {
  console.warn(`赛程同步暂不可用，本轮不改写任何预测数据：${error.message}`);
  console.log("保留仓库中的最后一次有效快照，等待下一轮自动重试。");
  process.exit(0);
}
let results = [];
let resultSync = { ok: true, error: null };
try {
  results = await fetchResults(historyStart, today);
} catch (error) {
  resultSync = { ok: false, error: error.message };
  console.warn(`赛果同步暂不可用，本轮保留既有验真数据：${error.message}`);
}
const resultMap = new Map(results.map(result => [result.id, result]));

let records = historyFile.records || [];
records = records.map(record => record.status !== "settled" && resultMap.has(record.id) ? scoreRecord(record, resultMap.get(record.id)) : record);
updateRatings(state, results);
const learning = calibrate(records);
const recordIndex = new Map(records.map((record, index) => [record.id, index]));

const futureMatches = schedule
  .filter(match => match.kickoffDate >= today && match.kickoffDate <= windowEnd)
  .filter(match => new Date(match.kickoff) > now)
  .filter(match => match.odds.result || match.odds.handicapResult)
  .sort((a, b) => a.kickoff.localeCompare(b.kickoff));

const dashboardMatches = [];
for (const match of futureMatches) {
  let record = recordIndex.has(match.id) ? records[recordIndex.get(match.id)] : null;
  const needsRevision = record?.status === "pending" && record.modelVersion !== modelInfo.version;
  if (!record || needsRevision) {
    const generated = predictMatch(match, state, learning, activeAdjustment(adjustments, match, now));
    const revisions = needsRevision ? [...(record.revisions || []), {
      modelVersion: record.modelVersion,
      publishedAt: record.publishedAt,
      prediction: record.prediction,
      diagnostics: record.diagnostics,
      factors: record.factors,
      oddsSnapshot: record.oddsSnapshot
    }] : [];
    const nextRecord = {
      ...match,
      status: "pending",
      publishedAt: record?.publishedAt || now.toISOString(),
      republishedAt: needsRevision ? now.toISOString() : undefined,
      modelVersion: modelInfo.version,
      prediction: generated.prediction,
      diagnostics: generated.diagnostics,
      factors: generated.factors,
      oddsSnapshot: match.odds,
      revisions
    };
    if (recordIndex.has(match.id)) records[recordIndex.get(match.id)] = nextRecord;
    else {
      recordIndex.set(match.id, records.length);
      records.push(nextRecord);
    }
    record = nextRecord;
  }
  dashboardMatches.push(publicRecord(record));
}

records = records.slice(-5000);
const verification = verificationSummary(records);
const dashboard = {
  generatedAt: now.toISOString(),
  window: { start: today, end: windowEnd, timezone: "Asia/Shanghai" },
  source: {
    ...sourceInfo,
    contextFeed: {
      configured: contextFeed.configured,
      source: contextFeed.source,
      updatedAt: contextFeed.updatedAt,
      availableMatches: Object.keys(contextFeed.matches || {}).length,
      error: contextFeed.error || null
    },
    resultSync
  },
  model: modelInfo,
  matches: dashboardMatches,
  verification,
  learning
};

await Promise.all([
  writeJson(paths.history, { version: 1, updatedAt: now.toISOString(), records }),
  writeJson(paths.state, state),
  writeJson(paths.dashboard, dashboard)
]);

console.log(`完成：未来比赛 ${dashboardMatches.length} 场，累计验真 ${verification.settledCount} 场。`);
