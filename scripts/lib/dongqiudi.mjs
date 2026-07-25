const INDEX_URL = "https://lottery-aggregator.dongqiudi.com/pcWeb/spreadMatch";
const BASE_URL = "https://pc.dongqiudi.com";

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

export function normalizeTeamName(value) {
  const compact = String(value || "")
    .toLowerCase()
    .replace(/足球俱乐部|俱乐部|football club|fc|汽车|韩亚|制铁|铁人|现代|sk|1995/g, "")
    .replace(/^ac/, "")
    .replace(/[\s·・.\-_]/g, "");
  const aliases = {
    "佐加顿斯": "尤尔加登",
    "玛丽港": "马里汉姆",
    "库奥皮奥": "古比斯"
  };
  return aliases[compact] || compact;
}

function monthDay(iso) {
  const date = new Date(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit"
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.month}/${parts.day}`;
}

export function matchDongqiudiEntry(match, entries = []) {
  const home = normalizeTeamName(match.home);
  const away = normalizeTeamName(match.away);
  const kickoffMonthDay = monthDay(match.kickoff);
  const candidates = entries.filter(entry => normalizeTeamName(entry.home_name) === home
    && normalizeTeamName(entry.guest_name) === away);
  return candidates.find(entry => String(entry.match_time || "").startsWith(kickoffMonthDay)) || candidates[0] || null;
}

async function fetchJson(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "daily-football-predictor/2.7" }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchDongqiudiIndex() {
  const payload = await fetchJson(INDEX_URL);
  if (Number(payload?.code) !== 0 || !Array.isArray(payload?.data)) throw new Error("竞彩列表返回结构异常");
  return payload.data;
}

function lineupMatchId(matchId) {
  const normalized = String(matchId).replace(/^0+/, "");
  return normalized.startsWith("5") ? normalized.slice(1) : normalized;
}

function formationSide(lineup, side) {
  const current = lineup?.persons?.[side];
  const recent = lineup?.recent_match_persons?.persons?.[side];
  const source = current?.formation ? "confirmed" : recent?.formation ? "recent-match" : "missing";
  const row = current?.formation ? current : recent;
  return {
    formation: row?.formation || null,
    coach: row?.team_coach || null,
    marketValue: row?.team_market_value || null,
    averageAge: row?.team_age || null,
    source
  };
}

function recentSide(lineup, side) {
  const row = lineup?.recent_match_persons?.recent_match?.[side];
  if (!row) return null;
  return {
    matchId: row.match_id ? String(row.match_id) : null,
    kickoff: row.start_play ? `${row.start_play.replace(" ", "T")}Z` : null,
    home: row.team_A_name || null,
    away: row.team_B_name || null,
    score: row.team_A_score !== undefined && row.team_B_score !== undefined ? `${row.team_A_score}:${row.team_B_score}` : null,
    competition: row.competition_name || null
  };
}

function statisticMap(overview) {
  const output = {};
  for (const row of overview?.statistics?.list || []) {
    output[row.type] = { home: Number(row.team_A?.value || 0), away: Number(row.team_B?.value || 0) };
  }
  return output;
}

function eventSummary(overview) {
  const summary = { home: [], away: [] };
  for (const bucket of Object.values(overview?.events || {})) {
    for (const [source, target] of [["teamAEvents", "home"], ["teamBEvents", "away"]]) {
      for (const event of bucket?.[source] || []) {
        summary[target].push({ minute: Number(bucket.minute || 0), code: event.code || "", person: event.person || null, score: event.score || null });
      }
    }
  }
  return summary;
}

function hashSignature(value) {
  let hash = 2166136261;
  for (const character of JSON.stringify(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function buildDongqiudiContext(match, entry, detail, lineup, overview, errors = []) {
  if (!entry) return { available: false, errors };
  const home = formationSide(lineup, "team_A");
  const away = formationSide(lineup, "team_B");
  const context = {
    available: true,
    source: "懂球帝公开比赛页",
    sourceUrl: `${BASE_URL}/match/${entry.match_id}`,
    matchId: String(entry.match_id),
    fetchedAt: new Date().toISOString(),
    homeTeamName: entry.home_name,
    awayTeamName: entry.guest_name,
    competition: entry.match_name || detail?.matchSample?.competition_name || null,
    field: lineup?.base?.field || null,
    weather: lineup?.base?.weather || null,
    temperature: lineup?.base?.temperature || lineup?.base?.weather_info?.temperature || null,
    referee: lineup?.base?.referee && lineup.base.referee !== "暂无信息" ? lineup.base.referee : null,
    formations: { home, away },
    recentMatches: { home: recentSide(lineup, "team_A"), away: recentSide(lineup, "team_B") },
    statistics: statisticMap(overview),
    events: eventSummary(overview),
    status: overview?.match_status || detail?.matchSample?.status || null,
    errors
  };
  context.signature = hashSignature({
    matchId: context.matchId,
    field: context.field,
    weather: context.weather,
    temperature: context.temperature,
    referee: context.referee,
    formations: context.formations,
    recentMatches: context.recentMatches,
    statistics: context.statistics,
    events: context.events,
    status: context.status
  });
  return context;
}

export async function fetchDongqiudiContext(match, entries) {
  const entry = matchDongqiudiEntry(match, entries);
  if (!entry) return { available: false, status: "not-matched", errors: [] };
  const matchId = String(entry.match_id);
  const requests = [
    [`${BASE_URL}/magicball/v1/match/app/detail?id=${matchId}&app=dqd&lang=zh-cn`, "detail"],
    [`${BASE_URL}/sport-data/soccer/biz/dqd/v1/match/lineup/${lineupMatchId(matchId)}?app=dqd&lang=zh-cn`, "lineup"],
    [`${BASE_URL}/api/data/overview/match/${matchId}`, "overview"]
  ];
  const values = {};
  const errors = [];
  await Promise.all(requests.map(async ([url, key]) => {
    try { values[key] = await fetchJson(url); }
    catch (error) { errors.push(`${key}: ${error.message}`); }
  }));
  return buildDongqiudiContext(match, entry, values.detail, values.lineup, values.overview, errors);
}

export async function fetchDongqiudiObservation(record) {
  const matchId = record.dongqiudiContext?.matchId;
  if (!matchId) return null;
  const [overview, lineup] = await Promise.all([
    fetchJson(`${BASE_URL}/api/data/overview/match/${matchId}`),
    fetchJson(`${BASE_URL}/sport-data/soccer/biz/dqd/v1/match/lineup/${lineupMatchId(matchId)}?app=dqd&lang=zh-cn`).catch(() => null)
  ]);
  if (!overview?.statistics?.list?.length) return null;
  return {
    recordId: record.id,
    matchId: String(matchId),
    kickoff: record.kickoff,
    source: "懂球帝公开比赛页",
    sourceUrl: `${BASE_URL}/match/${matchId}`,
    home: overview.statistics.team_A?.name || record.dongqiudiContext.homeTeamName || record.home,
    away: overview.statistics.team_B?.name || record.dongqiudiContext.awayTeamName || record.away,
    score: record.actual?.score || null,
    formations: { home: formationSide(lineup, "team_A").formation, away: formationSide(lineup, "team_B").formation },
    statistics: statisticMap(overview),
    events: eventSummary(overview),
    capturedAt: new Date().toISOString()
  };
}

function emptyProfile(name) {
  return {
    name, samples: 0, formations: {}, totals: {
      goalsFor: 0, goalsAgainst: 0, possession: 0, shots: 0, shotsAgainst: 0,
      shotsOnTarget: 0, shotsOnTargetAgainst: 0, dangerousAttacks: 0, dangerousAttacksAgainst: 0,
      corners: 0, cornersAgainst: 0, yellowCards: 0, redCards: 0, goalsAfter75: 0, substitutions60to75: 0
    }
  };
}

export function updateTacticalKnowledge(state, observations = []) {
  state.tacticalTeams ||= {};
  state.tacticalGlobal ||= emptyProfile("global");
  state.processedTacticalResults ||= [];
  const processed = new Set(state.processedTacticalResults);
  for (const observation of observations) {
    if (!observation || processed.has(observation.recordId) || !/^\d+:\d+$/.test(observation.score || "")) continue;
    const [homeGoals, awayGoals] = observation.score.split(":").map(Number);
    const stat = key => observation.statistics?.[key] || { home: 0, away: 0 };
    for (const side of ["home", "away"]) {
      const opponent = side === "home" ? "away" : "home";
      const name = observation[side];
      const key = normalizeTeamName(name);
      state.tacticalTeams[key] ||= emptyProfile(name);
      const profile = state.tacticalTeams[key];
      const goalsFor = side === "home" ? homeGoals : awayGoals;
      const goalsAgainst = side === "home" ? awayGoals : homeGoals;
      profile.samples += 1;
      profile.totals.goalsFor += goalsFor;
      profile.totals.goalsAgainst += goalsAgainst;
      profile.totals.possession += stat("控球率")[side];
      profile.totals.shots += stat("射门")[side];
      profile.totals.shotsAgainst += stat("射门")[opponent];
      profile.totals.shotsOnTarget += stat("射正")[side];
      profile.totals.shotsOnTargetAgainst += stat("射正")[opponent];
      profile.totals.dangerousAttacks += stat("危险进攻")[side];
      profile.totals.dangerousAttacksAgainst += stat("危险进攻")[opponent];
      profile.totals.corners += stat("角球")[side];
      profile.totals.cornersAgainst += stat("角球")[opponent];
      profile.totals.yellowCards += stat("黄牌")[side];
      profile.totals.redCards += stat("红牌")[side];
      profile.totals.goalsAfter75 += (observation.events?.[side] || []).filter(event => event.code === "G" && event.minute >= 75).length;
      profile.totals.substitutions60to75 += (observation.events?.[side] || []).filter(event => event.code === "SI" && event.minute >= 60 && event.minute <= 75).length;
      const formation = observation.formations?.[side];
      if (formation) profile.formations[formation] = (profile.formations[formation] || 0) + 1;
      profile.updatedAt = observation.capturedAt;
    }
    const global = state.tacticalGlobal;
    global.samples += 2;
    for (const profileName of [normalizeTeamName(observation.home), normalizeTeamName(observation.away)]) {
      const profile = state.tacticalTeams[profileName];
      for (const key of Object.keys(global.totals)) global.totals[key] += profile.totals[key] - (profile._lastGlobal?.[key] || 0);
      profile._lastGlobal = { ...profile.totals };
    }
    processed.add(observation.recordId);
  }
  state.processedTacticalResults = [...processed].slice(-5000);
  state.tacticalSchemaVersion = 1;
  return state;
}

function profileFor(match, state, side) {
  const contextName = match.dongqiudiContext?.[side === "home" ? "homeTeamName" : "awayTeamName"];
  return state.tacticalTeams?.[normalizeTeamName(contextName || match[side])] || null;
}

function averageStat(profile, key) {
  return profile?.samples ? profile.totals[key] / profile.samples : null;
}

function daysBetween(previous, current) {
  if (!previous || !current) return null;
  const days = (new Date(current) - new Date(previous)) / 86_400_000;
  return Number.isFinite(days) ? Math.max(0, Math.round(days * 10) / 10) : null;
}

export function tacticalAdjustment(match, state) {
  const context = match.dongqiudiContext;
  const homeProfile = profileFor(match, state, "home");
  const awayProfile = profileFor(match, state, "away");
  const global = state.tacticalGlobal;
  const homeRest = daysBetween(context?.recentMatches?.home?.kickoff, match.kickoff);
  const awayRest = daysBetween(context?.recentMatches?.away?.kickoff, match.kickoff);
  let homeGoalsDelta = 0;
  let awayGoalsDelta = 0;
  const applied = [];
  if (homeRest !== null && homeRest <= 3.5) { homeGoalsDelta -= 0.05; awayGoalsDelta += 0.02; applied.push(`主队仅休整 ${homeRest.toFixed(1)} 天`); }
  if (awayRest !== null && awayRest <= 3.5) { awayGoalsDelta -= 0.05; homeGoalsDelta += 0.02; applied.push(`客队仅休整 ${awayRest.toFixed(1)} 天`); }
  const globalSot = averageStat(global, "shotsOnTarget");
  const globalDanger = averageStat(global, "dangerousAttacks");
  const pressureDelta = profile => {
    if (!profile || profile.samples < 5 || globalSot === null || globalDanger === null) return 0;
    return clamp((averageStat(profile, "shotsOnTarget") - globalSot) * 0.012
      + (averageStat(profile, "dangerousAttacks") - globalDanger) * 0.0007, -0.06, 0.06);
  };
  const homePressure = pressureDelta(homeProfile);
  const awayPressure = pressureDelta(awayProfile);
  if (homePressure) { homeGoalsDelta += homePressure; applied.push(`主队 ${homeProfile.samples} 场射正/危险进攻压力代理修正`); }
  if (awayPressure) { awayGoalsDelta += awayPressure; applied.push(`客队 ${awayProfile.samples} 场射正/危险进攻压力代理修正`); }
  return {
    homeGoalsDelta: clamp(homeGoalsDelta, -0.12, 0.12),
    awayGoalsDelta: clamp(awayGoalsDelta, -0.12, 0.12),
    homeRestDays: homeRest,
    awayRestDays: awayRest,
    homeProfile,
    awayProfile,
    applied
  };
}

function formationText(formation) {
  if (!formation) return "暂无可靠阵型";
  if (formation === "4-3-3") return "4-3-3 提供三中场与天然边路宽度，但实际是否转为 3-2-5 仍需首发站位验证";
  if (formation === "4-2-3-1") return "4-2-3-1 的双后腰有利于保护中路与二点球，前腰身后空间利用取决于边后卫站位";
  if (/^3-|^5-/.test(formation)) return `${formation} 通常能形成三中卫出球或五后卫防线，翼卫身后的转换空间是关键观察点`;
  return `${formation} 仅代表名义阵型，攻守阶段的真实站位仍需比赛事件验证`;
}

export function buildTacticalAnalysis(match, state, prediction, adjustment) {
  const context = match.dongqiudiContext || {};
  const hf = prediction.topHalfFull?.slice(0, 2).map(item => `${item.pick} ${(item.probability * 100).toFixed(1)}%`).join("、") || "暂无";
  const profileEvidence = (profile, label) => profile?.samples
    ? `${label}${profile.samples} 场：场均射正 ${averageStat(profile, "shotsOnTarget").toFixed(1)}、危险进攻 ${averageStat(profile, "dangerousAttacks").toFixed(1)}、角球 ${averageStat(profile, "corners").toFixed(1)}`
    : `${label}尚无已同步的懂球帝完赛统计`;
  const dimensions = [
    {
      key: "tacticalSpatial", title: "战术结构与空间博弈", confidence: context.formations?.home?.formation || context.formations?.away?.formation ? 0.62 : 0.30,
      summary: `${match.home}：${formationText(context.formations?.home?.formation)}；${match.away}：${formationText(context.formations?.away?.formation)}。`,
      evidence: [context.formations?.home?.source === "confirmed" || context.formations?.away?.source === "confirmed" ? "已公布阵容" : "最近一场名义阵型"],
      missing: ["进攻/防守动态形态与肋部站位需比赛画面或事件级触球数据确认"]
    },
    {
      key: "expectedMetrics", title: "核心底层数据", confidence: 0.66,
      summary: `本模型赛前 xG 为 ${prediction.expectedGoals.home.toFixed(2)}:${prediction.expectedGoals.away.toFixed(2)}；${profileEvidence(adjustment.homeProfile, "主队")}；${profileEvidence(adjustment.awayProfile, "客队")}。`,
      evidence: ["体彩赔率、Elo、近期进失球、懂球帝射门/射正与危险进攻（有样本时）"],
      missing: ["懂球帝页面未明确提供 PPDA、Packing Rate、Progressive Actions 与官方事件级 xG，系统不会估造"]
    },
    {
      key: "matchups", title: "关键对位与弱点识别", confidence: 0.48,
      summary: `模型只把已验证阵型与攻防压力用于方向判断；具体边锋—边后卫、前锋—中卫对位必须等首发名单与位置确认，当前不以球员名气替代证据。`,
      evidence: [context.formations?.home?.formation && context.formations?.away?.formation ? `${context.formations.home.formation} 对 ${context.formations.away.formation}` : "阵型尚未完整公布"],
      missing: ["球员速度、对抗、盯人职责及实际换位数据"]
    },
    {
      key: "gameState", title: "比赛情境与心理节点", confidence: 0.60,
      summary: `半全场高概率路径为 ${hf}。若 60–75 分钟仍平局，应优先观察双后腰撤换、边后卫压上幅度与换人后的防守平衡，而不是机械沿用赛前比分。`,
      evidence: [adjustment.applied.length ? adjustment.applied.join("；") : "暂无可量化的额外赛程/压力修正"],
      missing: ["临场红牌、伤退与比分变化只能在开赛后重新评估"]
    },
    {
      key: "context", title: "环境与外部因果", confidence: context.available ? 0.72 : 0.28,
      summary: `场地：${context.field || "未提供"}；天气：${context.weather || "未提供"} ${context.temperature || ""}；休整：主队 ${adjustment.homeRestDays ?? "未知"} 天、客队 ${adjustment.awayRestDays ?? "未知"} 天。`,
      evidence: [context.source || "当前无懂球帝匹配记录"],
      missing: ["赛前降雨、草皮状态与轮换动机需临场来源复核"]
    },
    {
      key: "setPieces", title: "定位球与特殊场景", confidence: adjustment.homeProfile?.samples >= 3 || adjustment.awayProfile?.samples >= 3 ? 0.52 : 0.25,
      summary: `${profileEvidence(adjustment.homeProfile, "主队")}；${profileEvidence(adjustment.awayProfile, "客队")}。角球只反映定位球入口数量，不等同于定位球质量。`,
      evidence: ["完赛角球、黄红牌与 60–75 分钟换人事件（同步后累计）"],
      missing: ["前点掩护、后点包抄和二点球控制率没有可靠结构化来源"]
    }
  ];
  return {
    source: context.source || null,
    sourceUrl: context.sourceUrl || null,
    dataPolicy: "只使用页面明确字段；缺失的高级指标不推测、不伪造",
    appliedGoalsDelta: { home: adjustment.homeGoalsDelta, away: adjustment.awayGoalsDelta },
    dimensions
  };
}
