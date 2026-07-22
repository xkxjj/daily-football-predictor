import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSchedule, fetchResults, sourceInfo } from "./lib/sporttery.mjs";
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
  return entry;
}

function publicRecord(record) {
  const { diagnostics, revisions, ...safe } = record;
  return safe;
}

await mkdir(dataDir, { recursive: true });
const now = new Date();
const today = dateInShanghai(now);
const windowEnd = addDays(today, 1);

const [historyFile, state, adjustments] = await Promise.all([
  readJson(paths.history, { version: 1, records: [] }),
  readJson(paths.state, { version: 1, teamRatings: {}, leagueGoals: {}, processedResults: [] }),
  readJson(paths.adjustments, { version: 1, matches: {} })
]);

// 2.1 首次运行时回填 180 天；日常仅复查 45 天，兼顾延期赛果且不重复施压官方接口。
const needsBackfill = state.schemaVersion !== 2;
if (needsBackfill) {
  state.teamRatings = {};
  state.teamForm = {};
  state.leagueGoals = {};
  state.processedResults = [];
  state.schemaVersion = 2;
}
const historyStart = addDays(today, needsBackfill ? -180 : -45);

console.log(`同步体彩网：赛程 ${today}—${windowEnd}，赛果 ${historyStart}—${today}`);
const [schedule, results] = await Promise.all([fetchSchedule(), fetchResults(historyStart, today)]);
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
  source: sourceInfo,
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
