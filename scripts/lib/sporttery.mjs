const API_ROOT = "https://webapi.sporttery.cn/gateway/uniform/football";
const REQUEST_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36",
  "referer": "https://www.lottery.gov.cn/",
  "origin": "https://www.lottery.gov.cn",
  "accept": "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.6"
};
const DETAIL_HEADERS = {
  ...REQUEST_HEADERS,
  referer: "https://www.sporttery.cn/jc/zqdz/",
  origin: "https://www.sporttery.cn"
};

async function fetchJson(url, attempts = 5, headers = REQUEST_HEADERS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18_000);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
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

const percentNumber = value => {
  const parsed = Number(String(value ?? "").replace("%", ""));
  return Number.isFinite(parsed) ? parsed / 100 : 0;
};

const compactStats = (block, side) => {
  const prefix = side === "home" ? "home" : "away";
  const wins = Number(block?.[`${prefix}WinGoalMatchCnt`] || 0);
  const draws = Number(block?.[`${prefix}DrawMatchCnt`] || 0);
  const losses = Number(block?.[`${prefix}LossGoalMatchCnt`] || 0);
  const samples = Number(block?.totalLegCnt || wins + draws + losses || 0);
  return { wins, draws, losses, samples };
};

function injuryNews(side, injuryPayload, playerPayload) {
  const injuries = injuryPayload?.[side]?.injuriesAndSuspensionsList || [];
  const players = new Map((playerPayload?.[side]?.playerList || []).map(player => [String(player.personId), player]));
  return injuries.map(entry => {
    const player = players.get(String(entry.personId)) || entry;
    const goalShare = percentNumber(player.goalProbability);
    const assistShare = percentNumber(player.assistProbability);
    const starterShare = Number(player.appearanceCnt || entry.appearanceCnt || 0)
      ? Number(player.startedMatchCnt || entry.startedMatchCnt || 0) / Number(player.appearanceCnt || entry.appearanceCnt)
      : 0;
    const importance = Math.min(0.17, 0.025 + goalShare * 0.16 + assistShare * 0.12 + starterShare * 0.03);
    const position = String(player.playerPositionCode || entry.playerPositionCode || "").toLowerCase();
    let ownAttack = importance * 0.55;
    let opponentAttack = importance * 0.25;
    if (position.includes("forward")) { ownAttack = importance; opponentAttack = 0; }
    else if (position.includes("midfielder")) { ownAttack = importance * 0.78; opponentAttack = importance * 0.12; }
    else if (position.includes("goalkeeper")) { ownAttack = 0; opponentAttack = importance; }
    else if (position.includes("defender")) { ownAttack = importance * 0.12; opponentAttack = importance * 0.78; }
    const status = Number(entry.suspensionFlag) === 1 ? "停赛" : "伤缺";
    const ownDelta = -ownAttack;
    const opponentDelta = opponentAttack;
    return {
      label: `${side === "home" ? "主队" : "客队"}${player.personName || entry.personName}${status}（${player.playerPositionDesc || entry.playerPositionDesc || "位置未知"}，${player.startedMatchCnt || entry.startedMatchCnt || 0}次首发，进球占比${Math.round(goalShare * 100)}%，助攻占比${Math.round(assistShare * 100)}%）`,
      source: "体彩网赛事前瞻（页面注明部分数据来自第三方）",
      confidence: 0.74,
      homeGoalsDelta: side === "home" ? ownDelta : opponentDelta,
      awayGoalsDelta: side === "away" ? ownDelta : opponentDelta,
      status,
      personId: entry.personId,
      importance
    };
  });
}

export function buildOfficialContext(matchId, payloads, fetchedAt = new Date().toISOString()) {
  const feature = payloads.feature || {};
  const history = payloads.history || {};
  const injuries = payloads.injuries || {};
  const players = payloads.players || {};
  const recentBlock = feature.eachHomeAway || {};
  const historyRows = (history.matchList || []).map(row => {
    const currentHomeWasHome = String(row.uniformHomeTeamId) === String(feature.uniformHomeTeamId)
      || row.homeTeamShortName === feature.homeTeamShortName;
    const homeGoals = Number(row.homeTeamFullCourtGoalCnt);
    const awayGoals = Number(row.awayTeamFullCourtGoalCnt);
    return {
      matchDate: row.matchDate,
      goalsFor: currentHomeWasHome ? homeGoals : awayGoals,
      goalsAgainst: currentHomeWasHome ? awayGoals : homeGoals,
      tournament: row.tournamentShortName || ""
    };
  }).filter(row => row.matchDate && Number.isFinite(row.goalsFor) && Number.isFinite(row.goalsAgainst));
  const teamNews = [
    ...injuryNews("home", injuries, players),
    ...injuryNews("away", injuries, players)
  ];
  return {
    source: "中国体彩网赛事前瞻",
    sourceUrl: `https://www.sporttery.cn/jc/zqdz/index.html?showType=2&mid=${matchId}`,
    fetchedAt,
    recent: {
      home: {
        team: feature.homeTeamShortName || "主队",
        ...compactStats(recentBlock, "home"),
        goalsForAverage: Number(feature.goalAvg?.homeGoalAvgCnt || 0),
        goalsAgainstAverage: Number(feature.lossGoalAvg?.homeLossGoalAvgCnt || 0)
      },
      away: {
        team: feature.awayTeamShortName || "客队",
        ...compactStats(recentBlock, "away"),
        goalsForAverage: Number(feature.goalAvg?.awayGoalAvgCnt || 0),
        goalsAgainstAverage: Number(feature.lossGoalAvg?.awayLossGoalAvgCnt || 0)
      }
    },
    headToHead: {
      matches: historyRows,
      samples: historyRows.length
    },
    injuries: {
      home: injuries.home?.injuriesAndSuspensionsList || [],
      away: injuries.away?.injuriesAndSuspensionsList || []
    },
    teamNews,
    available: Boolean(Object.keys(feature).length || historyRows.length || teamNews.length)
  };
}

export async function fetchOfficialContext(matchId) {
  const id = encodeURIComponent(String(matchId));
  const endpoints = {
    feature: `getMatchFeatureV1.qry?termLimits=10&sportteryMatchId=${id}`,
    history: `getResultHistoryV1.qry?sportteryMatchId=${id}&termLimits=10&tournamentFlag=0&homeAwayFlag=0`,
    injuries: `getInjurySuspensionV1.qry?sportteryMatchId=${id}`,
    players: `getMatchPlayerV1.qry?sportteryMatchId=${id}&termLimits=8`
  };
  const payloads = {};
  const errors = [];
  for (const [key, endpoint] of Object.entries(endpoints)) {
    try {
      const payload = await fetchJson(`${API_ROOT}/${endpoint}`, 2, DETAIL_HEADERS);
      payloads[key] = payload.value || {};
    } catch (error) {
      payloads[key] = {};
      errors.push(`${key}: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 140));
  }
  const context = buildOfficialContext(matchId, payloads);
  context.errors = errors;
  return context;
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
  resultUrl: "https://www.lottery.gov.cn/jc/zqsgkj/",
  detailUrl: "https://www.sporttery.cn/jc/zqdz/"
};
