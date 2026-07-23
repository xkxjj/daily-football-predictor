const API_ROOT = "https://webapi.sporttery.cn/gateway/uniform/football";
const REQUEST_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36",
  "referer": "https://www.lottery.gov.cn/",
  "origin": "https://www.lottery.gov.cn",
  "accept": "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.6"
};

async function fetchJson(url, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18_000);
    try {
      const response = await fetch(url, { headers: REQUEST_HEADERS, signal: controller.signal });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("json")) {
        const body = await response.text();
        throw new Error(`体彩网接口 HTTP ${response.status}: ${body.slice(0, 80)}`);
      }
      const payload = await response.json();
      if (String(payload.errorCode) !== "0") throw new Error(payload.errorMessage || `接口错误 ${payload.errorCode}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const backoff = Math.min(12_000, 1_500 * 2 ** (attempt - 1));
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

const toNumber = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const rankNumber = value => {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : null;
};

function poolOdds(pool) {
  if (!pool || typeof pool !== "object" || !toNumber(pool.h)) return null;
  return { home: toNumber(pool.h), draw: toNumber(pool.d), away: toNumber(pool.a), updatedAt: [pool.updateDate, pool.updateTime].filter(Boolean).join("T") };
}

export async function fetchSchedule() {
  const query = new URLSearchParams({ channel: "c", poolCode: "hhad,had" });
  const payload = await fetchJson(`${API_ROOT}/getMatchCalculatorV1.qry?${query}`);
  const groups = payload.value?.matchInfoList || [];
  return groups.flatMap(group => (group.subMatchList || []).map(match => ({
    id: String(match.matchId),
    matchNumber: match.matchNumStr,
    matchNumberDate: match.matchNumDate,
    league: match.leagueAbbName || match.leagueAllName,
    leagueFull: match.leagueAllName,
    leagueId: match.leagueId,
    home: match.homeTeamAbbName || match.homeTeamAllName,
    homeFull: match.homeTeamAllName,
    homeId: match.homeTeamId,
    away: match.awayTeamAbbName || match.awayTeamAllName,
    awayFull: match.awayTeamAllName,
    awayId: match.awayTeamId,
    homeRank: rankNumber(match.homeRank),
    awayRank: rankNumber(match.awayRank),
    kickoff: `${match.matchDate}T${match.matchTime || "00:00:00"}+08:00`,
    kickoffDate: match.matchDate,
    businessDate: match.businessDate,
    status: match.matchStatus,
    remark: match.remark || "",
    handicap: Number(match.hhad?.goalLineValue ?? match.hhad?.goalLine ?? 0),
    odds: { result: poolOdds(match.had), handicapResult: poolOdds(match.hhad) },
    sourceUpdatedAt: payload.value?.lastUpdateTime || null
  })));
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function fetchResultRange(startDate, endDate) {
  const rows = [];
  let pageNo = 1;
  let pages = 1;
  do {
    const query = new URLSearchParams({
      matchBeginDate: startDate,
      matchEndDate: endDate,
      leagueId: "",
      pageSize: "100",
      pageNo: String(pageNo),
      isFix: "0",
      matchPage: "1",
      pcOrWap: "1"
    });
    const payload = await fetchJson(`${API_ROOT}/getUniformMatchResultV1.qry?${query}`);
    const value = payload.value || {};
    rows.push(...(value.matchResult || []).map(match => ({
      id: String(match.matchId),
      matchNumber: match.matchNumStr,
      matchDate: match.matchDate,
      league: match.leagueNameAbbr || match.leagueName,
      leagueFull: match.leagueName,
      leagueId: match.leagueId,
      home: match.homeTeam,
      homeFull: match.allHomeTeam,
      homeId: match.homeTeamId,
      away: match.awayTeam,
      awayFull: match.allAwayTeam,
      awayId: match.awayTeamId,
      handicap: Number(match.goalLine || 0),
      halfScore: match.sectionsNo1,
      fullScore: match.sectionsNo999,
      resultStatus: match.matchResultStatus,
      winFlag: match.winFlag
    })));
    pages = Number(value.pages || Math.ceil(Number(value.total || 0) / 100) || 1);
    pageNo += 1;
    if (pageNo <= pages) await new Promise(resolve => setTimeout(resolve, 450));
  } while (pageNo <= pages && pageNo <= 20);
  return rows.filter(row => /^\d+:\d+$/.test(row.fullScore || "") && /^\d+:\d+$/.test(row.halfScore || ""));
}

export async function fetchResults(startDate, endDate) {
  const rows = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const chunkEnd = addDays(cursor, 29) < endDate ? addDays(cursor, 29) : endDate;
    rows.push(...await fetchResultRange(cursor, chunkEnd));
    cursor = addDays(chunkEnd, 1);
    if (cursor <= endDate) await new Promise(resolve => setTimeout(resolve, 650));
  }
  return [...new Map(rows.map(row => [row.id, row])).values()];
}

export const sourceInfo = {
  name: "中国体彩网竞彩足球公开数据",
  scheduleUrl: "https://www.lottery.gov.cn/jc/zqszsc/",
  resultUrl: "https://www.lottery.gov.cn/jc/zqsgkj/"
};
