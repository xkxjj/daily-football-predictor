import { buildTacticalAnalysis, tacticalAdjustment } from "./dongqiudi.mjs";

const OUTCOMES = ["胜", "平", "负"];
const METRIC_KEYS = ["result", "handicapResult", "score", "totalGoals", "halfFull"];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function normalizeDistributionObject(distribution) {
  const entries = Object.entries(distribution || {}).filter(([, value]) => Number.isFinite(value) && value >= 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return total > 0 ? Object.fromEntries(entries.map(([key, value]) => [key, value / total])) : {};
}

function applyCategoricalCalibration(distribution, calibration) {
  const normalized = normalizeDistributionObject(distribution);
  const factors = calibration?.factors || {};
  const adjusted = Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, value * (factors[key] || 1)]));
  return normalizeDistributionObject(adjusted);
}

function normalizeOdds(odds) {
  if (!odds?.home || !odds?.draw || !odds?.away) return null;
  const raw = [1 / odds.home, 1 / odds.draw, 1 / odds.away];
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map(value => value / total);
}

function blendProbabilities(primary, auxiliary, weight) {
  if (!primary) return auxiliary;
  if (!auxiliary) return primary;
  const safeWeight = clamp(Number(weight) || 0, 0, 1);
  return primary.map((value, index) => value * (1 - safeWeight) + auxiliary[index] * safeWeight);
}

function pairKey(homeId, awayId) {
  return [String(homeId), String(awayId)].sort().join("|");
}

function marketContext(match, adjustment) {
  const verifiedExternal = adjustment?.externalMarket?.source ? adjustment.externalMarket : null;
  const official = normalizeOdds(match.odds?.result);
  const external = normalizeOdds(verifiedExternal?.result);
  const openingExternal = normalizeOdds(verifiedExternal?.openingResult);
  const confidence = clamp(Number(verifiedExternal?.confidence ?? 0.65), 0, 1);
  const externalWeight = official && external ? clamp(0.08 + confidence * 0.22, 0.08, 0.30) : external ? 1 : 0;
  const consensus = blendProbabilities(official, external, externalWeight);
  const movement = external && openingExternal ? external.map((value, index) => value - openingExternal[index]) : null;
  return { official, external, openingExternal, consensus, confidence, externalWeight, movement };
}

function outcome(home, away) {
  return home > away ? "胜" : home < away ? "负" : "平";
}

function poissonArray(lambda, max = 9) {
  const values = [Math.exp(-lambda)];
  for (let k = 1; k <= max; k += 1) values[k] = values[k - 1] * lambda / k;
  const sum = values.reduce((a, b) => a + b, 0);
  values[max] += 1 - sum;
  return values;
}

function distribution(lambdaHome, lambdaAway, handicap = 0) {
  const home = poissonArray(lambdaHome);
  const away = poissonArray(lambdaAway);
  const result = [0, 0, 0];
  const handicapResult = [0, 0, 0];
  for (let h = 0; h < home.length; h += 1) for (let a = 0; a < away.length; a += 1) {
    const p = home[h] * away[a];
    result[OUTCOMES.indexOf(outcome(h, a))] += p;
    handicapResult[OUTCOMES.indexOf(outcome(h + handicap, a))] += p;
  }
  return { result, handicapResult };
}

function eloProbabilities(match, state) {
  const homeRating = state.teamRatings?.[`id:${match.homeId}`] ?? 1500;
  const awayRating = state.teamRatings?.[`id:${match.awayId}`] ?? 1500;
  const rankSignal = match.homeRank && match.awayRank ? clamp((match.awayRank - match.homeRank) * 4, -60, 60) : 0;
  const expected = 1 / (1 + 10 ** (-(homeRating - awayRating + 68 + rankSignal) / 400));
  const draw = clamp(0.29 - Math.abs(expected - 0.5) * 0.28, 0.16, 0.29);
  return [(1 - draw) * expected, draw, (1 - draw) * (1 - expected)];
}

function average(values, fallback) {
  return values?.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

function leagueContext(match, state) {
  const league = state.leagueGoals?.[String(match.leagueId)];
  const count = league?.count || 0;
  const homeAverage = count ? league.homeGoals / count : 1.43;
  const awayAverage = count ? league.awayGoals / count : 1.18;
  const drawRate = count ? league.draws / count : 0.27;
  const halfTotal = league ? Object.values(league.halfOutcomes || {}).reduce((a, b) => a + b, 0) : 0;
  const halfOutcomeRates = Object.fromEntries(OUTCOMES.map(key => [key, halfTotal ? (league.halfOutcomes?.[key] || 0) / halfTotal : key === "平" ? 0.44 : 0.28]));
  return {
    count,
    homeAverage: clamp(homeAverage, 0.75, 2.35),
    awayAverage: clamp(awayAverage, 0.65, 2.15),
    totalAverage: clamp(homeAverage + awayAverage, 1.7, 4.1),
    drawRate: clamp(drawRate, 0.16, 0.38),
    halfOutcomeRates,
    halfFullOutcomeCounts: league?.halfFullOutcomes || {},
    scoreCounts: league?.scoreCounts || {}
  };
}

function teamGoalPrior(match, state, context) {
  const home = state.teamForm?.[`id:${match.homeId}`];
  const away = state.teamForm?.[`id:${match.awayId}`];
  const homeGf = average(home?.gf, context.homeAverage);
  const homeGa = average(home?.ga, context.awayAverage);
  const awayGf = average(away?.gf, context.awayAverage);
  const awayGa = average(away?.ga, context.homeAverage);
  const homeWeight = Math.min(0.72, (home?.gf?.length || 0) / 18);
  const awayWeight = Math.min(0.72, (away?.gf?.length || 0) / 18);
  const homeRaw = Math.sqrt(Math.max(0.2, homeGf) * Math.max(0.2, awayGa));
  const awayRaw = Math.sqrt(Math.max(0.2, awayGf) * Math.max(0.2, homeGa));
  return {
    home: clamp(context.homeAverage * (1 - homeWeight) + homeRaw * homeWeight, 0.35, 3.5),
    away: clamp(context.awayAverage * (1 - awayWeight) + awayRaw * awayWeight, 0.3, 3.3),
    homeRecentScored: homeGf,
    homeRecentConceded: homeGa,
    awayRecentScored: awayGf,
    awayRecentConceded: awayGa,
    homeSamples: home?.gf?.length || 0,
    awaySamples: away?.gf?.length || 0
  };
}

function headToHeadContext(match, state) {
  const officialRows = match.officialContext?.headToHead?.matches || [];
  const stateRows = state.headToHead?.[pairKey(match.homeId, match.awayId)]?.matches || [];
  const usingDetail = officialRows.length > 0;
  const relevant = usingDetail
    ? [...officialRows].sort((a, b) => String(b.matchDate).localeCompare(String(a.matchDate))).slice(0, 8)
    : [...stateRows]
      .filter(row => [String(row.homeId), String(row.awayId)].includes(String(match.homeId)))
      .sort((a, b) => String(b.matchDate).localeCompare(String(a.matchDate)))
      .slice(0, 8);
  if (!relevant.length) {
    const checkedDetail = match.officialContext?.source;
    return {
      count: 0,
      weight: 0,
      probabilities: null,
      summary: checkedDetail
        ? "体彩网本场赛事前瞻未返回可匹配交锋；这不等于两队从未交手"
        : "体彩网近两年已收录赛果中暂无可匹配交锋；这不等于两队从未交手"
    };
  }

  const now = Date.now();
  let weightedWins = 0, weightedDraws = 0, weightedLosses = 0, weightedFor = 0, weightedAgainst = 0, totalWeight = 0;
  for (const row of relevant) {
    const ageDays = Math.max(0, (now - new Date(`${row.matchDate}T12:00:00Z`).getTime()) / 86_400_000);
    const recency = Math.exp(-ageDays / 540);
    const currentHomeWasHome = String(row.homeId) === String(match.homeId);
    const goalsFor = usingDetail ? row.goalsFor : currentHomeWasHome ? row.homeGoals : row.awayGoals;
    const goalsAgainst = usingDetail ? row.goalsAgainst : currentHomeWasHome ? row.awayGoals : row.homeGoals;
    weightedFor += goalsFor * recency;
    weightedAgainst += goalsAgainst * recency;
    totalWeight += recency;
    if (goalsFor > goalsAgainst) weightedWins += recency;
    else if (goalsFor < goalsAgainst) weightedLosses += recency;
    else weightedDraws += recency;
  }
  const probabilities = totalWeight
    ? [weightedWins / totalWeight, weightedDraws / totalWeight, weightedLosses / totalWeight]
    : null;
  // 交锋的阵容和教练更替很快，因此最多只占方向判断的 10%。
  const weight = clamp(totalWeight / 40, 0, 0.10);
  const averageFor = weightedFor / totalWeight;
  const averageAgainst = weightedAgainst / totalWeight;
  return {
    count: relevant.length,
    weight,
    probabilities,
    averageFor,
    averageAgainst,
    summary: `${usingDetail ? "体彩网赛事前瞻" : "官方赛果库"}近 ${relevant.length} 次交锋按时间衰减后，当前主队视角为胜 ${(probabilities[0] * 100).toFixed(0)}% / 平 ${(probabilities[1] * 100).toFixed(0)}% / 负 ${(probabilities[2] * 100).toFixed(0)}%，场均进球 ${averageFor.toFixed(2)}:${averageAgainst.toFixed(2)}`
  };
}

function officialFormContext(match, context) {
  const recent = match.officialContext?.recent;
  const home = recent?.home;
  const away = recent?.away;
  const sample = Math.min(Number(home?.samples || 0), Number(away?.samples || 0));
  if (!sample) return { weight: 0, probabilities: null, prior: null, summary: "体彩网赛事前瞻暂无双方近期战况样本" };
  const homePoints = (home.wins + 0.5 * home.draws + 1) / (home.samples + 2);
  const awayPoints = (away.wins + 0.5 * away.draws + 1) / (away.samples + 2);
  const difference = homePoints - awayPoints;
  const homeShare = 1 / (1 + Math.exp(-(difference * 3 + 0.16)));
  const draw = clamp(0.29 - Math.abs(difference) * 0.18, 0.18, 0.30);
  const probabilities = [(1 - draw) * homeShare, draw, (1 - draw) * (1 - homeShare)];
  const homeExpected = average([home.goalsForAverage, away.goalsAgainstAverage].filter(value => value > 0), context.homeAverage);
  const awayExpected = average([away.goalsForAverage, home.goalsAgainstAverage].filter(value => value > 0), context.awayAverage);
  return {
    weight: Math.min(0.12, sample / 100),
    probabilities,
    prior: { home: homeExpected, away: awayExpected, weight: Math.min(0.24, sample / 40) },
    summary: `体彩网赛事前瞻近期战况：${home.team}近 ${home.samples} 场 ${home.wins}胜${home.draws}平${home.losses}负，${away.team}近 ${away.samples} 场 ${away.wins}胜${away.draws}平${away.losses}负；以 ${(Math.min(0.12, sample / 100) * 100).toFixed(1)}% 受限权重并入方向判断`
  };
}

function blendOfficialPrior(statPrior, form) {
  if (!form.prior) return statPrior;
  const weight = form.prior.weight;
  return {
    ...statPrior,
    home: clamp(statPrior.home * (1 - weight) + form.prior.home * weight, 0.35, 3.5),
    away: clamp(statPrior.away * (1 - weight) + form.prior.away * weight, 0.3, 3.3),
    officialFormWeight: weight
  };
}

function mergeOfficialNews(adjustment, officialContext) {
  return {
    ...(adjustment || {}),
    teamNews: [...(officialContext?.teamNews || []), ...(adjustment?.teamNews || [])],
    coachNews: [...(adjustment?.coachNews || [])]
  };
}

function situationalContext(adjustment) {
  const entries = [...(adjustment?.teamNews || []), ...(adjustment?.coachNews || [])];
  let homeGoalsDelta = Number(adjustment?.homeGoalsDelta || 0);
  let awayGoalsDelta = Number(adjustment?.awayGoalsDelta || 0);
  const applied = [];
  for (const entry of entries) {
    if (!entry?.source) continue;
    const confidence = clamp(Number(entry.confidence ?? 0.65), 0, 1);
    const homeDelta = Number(entry.homeGoalsDelta || 0) * confidence;
    const awayDelta = Number(entry.awayGoalsDelta || 0) * confidence;
    if (!Number.isFinite(homeDelta) || !Number.isFinite(awayDelta)) continue;
    homeGoalsDelta += homeDelta;
    awayGoalsDelta += awayDelta;
    const label = entry.label || entry.name || entry.type || "赛前情报";
    applied.push(`${label}（可信度 ${(confidence * 100).toFixed(0)}%，xG ${homeDelta >= 0 ? "+" : ""}${homeDelta.toFixed(2)} / ${awayDelta >= 0 ? "+" : ""}${awayDelta.toFixed(2)}）`);
  }
  return {
    homeGoalsDelta: clamp(homeGoalsDelta, -0.45, 0.45),
    awayGoalsDelta: clamp(awayGoalsDelta, -0.45, 0.45),
    applied
  };
}

function preserveDrawSignal(probabilities, context) {
  const historyWeight = Math.min(0.28, context.count / 250);
  const draw = clamp(probabilities[1] * (1 - historyWeight) + context.drawRate * historyWeight, 0.14, 0.42);
  const decisive = probabilities[0] + probabilities[2];
  return decisive > 0
    ? [probabilities[0] / decisive * (1 - draw), draw, probabilities[2] / decisive * (1 - draw)]
    : [(1 - draw) / 2, draw, (1 - draw) / 2];
}

function fitExpectedGoals(target, handicapTarget, handicap, statPrior, weights = {}) {
  const resultWeight = Number(weights.result ?? 1.7);
  const handicapWeight = Number(weights.handicap ?? 0.82);
  let best = { loss: Infinity, home: 1.4, away: 1.15 };
  for (let h = 0.3; h <= 3.8; h += 0.1) for (let a = 0.25; a <= 3.5; a += 0.1) {
    const dist = distribution(h, a, handicap);
    let loss = resultWeight * target.reduce((sum, p, i) => sum + (dist.result[i] - p) ** 2, 0);
    if (handicapTarget) loss += handicapWeight * handicapTarget.reduce((sum, p, i) => sum + (dist.handicapResult[i] - p) ** 2, 0);
    loss += 0.11 * ((h - statPrior.home) ** 2 + (a - statPrior.away) ** 2);
    if (loss < best.loss) best = { loss, home: h, away: a };
  }
  return best;
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function mulberry32(seed) {
  return () => {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function samplePoisson(lambda, random) {
  const limit = Math.exp(-lambda);
  let product = 1;
  let value = 0;
  do { value += 1; product *= random(); } while (product > limit && value < 15);
  return value - 1;
}

function topEntry(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1])[0];
}

function standardNormal(random) {
  const u = Math.max(random(), 1e-9);
  const v = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function scoreOutcome(score) {
  const [home, away] = score.split(":").map(Number);
  return outcome(home, away);
}

function chooseCalibratedScore(scores, handicap, context, simulations, resultDistribution, scorePriorMultiplier = 1, categoricalCalibration = null) {
  const ranked = [];
  for (const resultKey of OUTCOMES) {
    const simulatedRows = [...scores.entries()].filter(([score]) => scoreOutcome(score) === resultKey);
    const historicalRows = Object.entries(context.scoreCounts).filter(([score]) => scoreOutcome(score) === resultKey);
    const candidates = new Set([...simulatedRows.map(([score]) => score), ...historicalRows.map(([score]) => score)]);
    const simulatedOutcomeTotal = simulatedRows.reduce((sum, [, count]) => sum + count, 0) || 1;
    const historicalSamples = historicalRows.reduce((sum, [, count]) => sum + count, 0);
    const baseHistoricalWeight = historicalSamples ? Math.min(0.40, historicalSamples / (historicalSamples + 120)) : 0;
    const historicalWeight = Math.min(0.40, baseHistoricalWeight * scorePriorMultiplier);
    for (const score of candidates) {
      const count = scores.get(score) || 0;
      const [home, away] = score.split(":").map(Number);
      const simulatedConditional = count / simulatedOutcomeTotal;
      const historicalConditional = historicalSamples
        ? (context.scoreCounts[score] || 0) / historicalSamples
        : simulatedConditional;
      const simulationProbability = resultDistribution[resultKey] * simulatedConditional;
      const historicalProbability = resultDistribution[resultKey] * historicalConditional;
      ranked.push({
        score,
        count,
        handicapKey: outcome(home + handicap, away),
        probability: (1 - historicalWeight) * simulationProbability + historicalWeight * historicalProbability,
        simulationProbability,
        historicalProbability,
        historicalWeight,
        baseHistoricalWeight,
        historicalSamples
      });
    }
  }
  const calibrated = applyCategoricalCalibration(
    Object.fromEntries(ranked.map(item => [item.score, item.probability])),
    categoricalCalibration
  );
  for (const item of ranked) {
    item.calibrationFactor = categoricalCalibration?.factors?.[item.score] || 1;
    item.probability = calibrated[item.score] || 0;
  }
  ranked.sort((a, b) => b.probability - a.probability);
  const selected = ranked[0];
  return {
    ...selected,
    ranked,
    scoreDistribution: Object.fromEntries(ranked.map(item => [item.score, item.probability])),
    scoreSimulationDistribution: Object.fromEntries(ranked.map(item => [item.score, item.simulationProbability])),
    scoreHistoricalDistribution: Object.fromEntries(ranked.map(item => [item.score, item.historicalProbability]))
  };
}

function monteCarlo(lambdaHome, lambdaAway, handicap, seed, context, directionTarget, handicapDirectionTarget, scorePriorMultiplier = 1, categoricalCalibration = {}, simulations = 20_000) {
  const random = mulberry32(hashSeed(seed));
  const result = new Map(OUTCOMES.map(key => [key, 0]));
  const handicapResult = new Map(OUTCOMES.map(key => [key, 0]));
  const scores = new Map();
  const jointOutcomes = new Map();
  const totals = new Map(Array.from({ length: 8 }, (_, i) => [i === 7 ? "7+" : String(i), 0]));
  const halfFull = new Map();
  for (let i = 0; i < simulations; i += 1) {
    // 随机比赛节奏制造真实足球中常见的“闷平”和开放型大比分长尾，避免普通泊松过度挤在 0/1 球模板。
    const tempo = Math.exp(0.27 * standardNormal(random) - 0.5 * 0.27 ** 2);
    const halfHome = samplePoisson(lambdaHome * tempo * 0.43, random);
    const halfAway = samplePoisson(lambdaAway * tempo * 0.43, random);
    const home = halfHome + samplePoisson(lambdaHome * tempo * 0.57, random);
    const away = halfAway + samplePoisson(lambdaAway * tempo * 0.57, random);
    const resultKey = outcome(home, away);
    const handicapKey = outcome(home + handicap, away);
    const scoreKey = `${home}:${away}`;
    const totalKey = home + away >= 7 ? "7+" : String(home + away);
    const halfFullKey = `${outcome(halfHome, halfAway)}/${resultKey}`;
    result.set(resultKey, result.get(resultKey) + 1);
    handicapResult.set(handicapKey, handicapResult.get(handicapKey) + 1);
    const jointKey = `${resultKey}|${handicapKey}`;
    jointOutcomes.set(jointKey, (jointOutcomes.get(jointKey) || 0) + 1);
    scores.set(scoreKey, (scores.get(scoreKey) || 0) + 1);
    totals.set(totalKey, totals.get(totalKey) + 1);
    halfFull.set(halfFullKey, (halfFull.get(halfFullKey) || 0) + 1);
  }
  const resultBlend = applyCategoricalCalibration(
    Object.fromEntries(OUTCOMES.map((key, index) => [key, 0.68 * result.get(key) / simulations + 0.32 * directionTarget[index]])),
    categoricalCalibration.result
  );
  // 先按普通胜平负的边际概率确定主方向。不能直接在联合格子里取最大值：
  // 同一个让球方向可能被拆到多个普通赛果格子，联合 MAP 会天然偏向没有被拆分的格子。
  const resultPick = [...OUTCOMES].sort((a, b) => resultBlend[b] - resultBlend[a])[0];
  const jointCandidates = [...jointOutcomes.entries()].map(([key, count]) => {
    const [resultKey, handicapKey] = key.split("|");
    const pairProbability = count / simulations;
    return { resultKey, handicapKey, count, pairProbability };
  }).sort((a, b) => b.pairProbability - a.pairProbability);

  // 在主方向可实现的路径内形成让球条件分布。它用于软评分与风险标记，
  // 不再先选让球结果、再用硬条件裁剪比分。
  const conditionalRows = jointCandidates.filter(item => item.resultKey === resultPick && item.count > 0);
  const conditionalTotal = conditionalRows.reduce((sum, item) => sum + item.count, 0);
  const marketConditionalTotal = conditionalRows.reduce((sum, item) => {
    const index = OUTCOMES.indexOf(item.handicapKey);
    return sum + (handicapDirectionTarget?.[index] || 0);
  }, 0);
  const handicapCandidates = conditionalRows.map(item => {
    const simulated = item.count / conditionalTotal;
    const index = OUTCOMES.indexOf(item.handicapKey);
    const market = marketConditionalTotal
      ? handicapDirectionTarget[index] / marketConditionalTotal
      : simulated;
    return { ...item, simulated, market, adjusted: 0.55 * simulated + 0.45 * market };
  }).sort((a, b) => b.adjusted - a.adjusted);
  const resultProbability = resultBlend[resultPick];
  const handicapMarginal = applyCategoricalCalibration(Object.fromEntries(OUTCOMES.map((key, index) => {
    const simulated = handicapResult.get(key) / simulations;
    const market = handicapDirectionTarget?.[index] ?? simulated;
    return [key, 0.68 * simulated + 0.32 * market];
  })), categoricalCalibration.handicapResult);
  const handicapMarginalCandidates = Object.entries(handicapMarginal).sort((a, b) => b[1] - a[1]);
  const handicapPick = handicapMarginalCandidates[0][0];
  const handicapProbability = handicapMarginalCandidates[0][1];
  const chosenScore = chooseCalibratedScore(scores, handicap, context, simulations, resultBlend, scorePriorMultiplier, categoricalCalibration.score);
  const [scoreHome, scoreAway] = chosenScore.score.split(":").map(Number);
  const scoreHandicapResult = outcome(scoreHome + handicap, scoreAway);
  const empiricalTotalCounts = new Map(Array.from({ length: 8 }, (_, i) => [i === 7 ? "7+" : String(i), 0]));
  for (const [score, count] of Object.entries(context.scoreCounts)) {
    const goals = score.split(":").map(Number).reduce((sum, value) => sum + value, 0);
    const key = goals >= 7 ? "7+" : String(goals);
    empiricalTotalCounts.set(key, empiricalTotalCounts.get(key) + count);
  }
  const empiricalTotalSample = [...empiricalTotalCounts.values()].reduce((sum, count) => sum + count, 0);
  const totalHistoricalWeight = empiricalTotalSample ? Math.min(0.35, empiricalTotalSample / (empiricalTotalSample + 300)) : 0;
  const totalGoalDistribution = applyCategoricalCalibration(Object.fromEntries([...totals.entries()].map(([key, count]) => {
    const simulated = count / simulations;
    const historical = empiricalTotalSample ? empiricalTotalCounts.get(key) / empiricalTotalSample : simulated;
    return [key, (1 - totalHistoricalWeight) * simulated + totalHistoricalWeight * historical];
  })), categoricalCalibration.totalGoals);
  const totalCandidates = Object.entries(totalGoalDistribution).sort((a, b) => b[1] - a[1]);
  const totalPick = totalCandidates[0][0];
  const totalProbability = totalCandidates[0][1];
  const halfRows = OUTCOMES.flatMap(halfKey => OUTCOMES.map(fullKey => {
    const key = `${halfKey}/${fullKey}`;
    const count = halfFull.get(key) || 0;
    const simulatedFullTotal = result.get(fullKey) || 1;
    const simulatedConditional = count / simulatedFullTotal;
    const historicalFullTotal = OUTCOMES.reduce(
      (sum, candidateHalf) => sum + (context.halfFullOutcomeCounts[`${candidateHalf}/${fullKey}`] || 0),
      0
    );
    const historicalConditional = historicalFullTotal
      ? (context.halfFullOutcomeCounts[key] || 0) / historicalFullTotal
      : context.halfOutcomeRates[halfKey] || 1 / 3;
    const historicalWeight = historicalFullTotal ? Math.min(0.38, 0.18 + historicalFullTotal / 500) : 0.18;
    const calibratedConditional = (1 - historicalWeight) * simulatedConditional + historicalWeight * historicalConditional;
    return { key, count, adjusted: resultBlend[fullKey] * calibratedConditional };
  }));
  const calibratedHalfFull = applyCategoricalCalibration(
    Object.fromEntries(halfRows.map(item => [item.key, item.adjusted])),
    categoricalCalibration.halfFull
  );
  const halfCandidates = halfRows
    .map(item => ({ ...item, adjusted: calibratedHalfFull[item.key] || 0 }))
    .sort((a, b) => b.adjusted - a.adjusted);
  const halfFullPick = halfCandidates[0].key;
  const halfFullProbability = halfCandidates[0].adjusted;
  const topHalfFull = halfCandidates.slice(0, 3);
  const topScores = chosenScore.ranked.slice(0, 3);
  const scoreCoverage = topScores.reduce((sum, item) => sum + item.probability, 0);
  const scoreCoverageTwo = topScores.slice(0, 2).reduce((sum, item) => sum + item.probability, 0);
  const handicapGap = handicapMarginalCandidates.length > 1 ? handicapMarginalCandidates[0][1] - handicapMarginalCandidates[1][1] : 1;
  return {
    result: resultPick,
    handicapResult: handicapPick,
    score: chosenScore.score,
    totalGoals: totalPick,
    halfFull: halfFullPick,
    confidence: resultProbability,
    probabilities: {
      result: resultProbability,
      handicapResult: handicapProbability,
      score: chosenScore.probability,
      totalGoals: totalProbability,
      halfFull: halfFullProbability
    },
    resultDistribution: resultBlend,
    resultSimulationDistribution: Object.fromEntries([...result].map(([k, v]) => [k, v / simulations])),
    handicapResultDistribution: handicapMarginal,
    handicapSimulationDistribution: Object.fromEntries([...handicapResult].map(([k, v]) => [k, v / simulations])),
    handicapConditionalDistribution: Object.fromEntries(handicapCandidates.map(item => [item.handicapKey, item.adjusted])),
    handicapDecision: {
      selected: handicapPick,
      marginalTop: handicapPick,
      scoreImplied: scoreHandicapResult,
      gap: handicapGap,
      level: handicapGap < 0.05 ? "临界" : handicapGap < 0.10 ? "偏弱" : "明确"
    },
    scoreCalibration: {
      method: "league-empirical-bayes",
      historicalWeight: chosenScore.historicalWeight,
      baseHistoricalWeight: chosenScore.baseHistoricalWeight,
      priorMultiplier: scorePriorMultiplier,
      historicalSamples: chosenScore.historicalSamples
    },
    scorePortfolio: {
      primary: chosenScore.score,
      coverageTwo: scoreCoverageTwo,
      coverageThree: scoreCoverage,
      combinationsForThreeMatches: { twoEach: 8, threeEach: 27 }
    },
    totalGoalsDistribution: totalGoalDistribution,
    topTotalGoals: totalCandidates.slice(0, 3).map(([pick, probability]) => ({ pick, probability })),
    scoreDistribution: chosenScore.scoreDistribution,
    scoreSimulationDistribution: chosenScore.scoreSimulationDistribution,
    scoreHistoricalDistribution: chosenScore.scoreHistoricalDistribution,
    jointOutcomeDistribution: Object.fromEntries(jointCandidates.map(item => [`${item.resultKey}/${item.handicapKey}`, item.pairProbability])),
    halfFullDistribution: Object.fromEntries(halfCandidates.map(item => [item.key, item.adjusted])),
    halfFullSimulationDistribution: Object.fromEntries([...halfFull].map(([k, v]) => [k, v / simulations])),
    topHalfFull: topHalfFull.map(item => ({ pick: item.key, probability: item.adjusted })),
    topScores: topScores.map(item => ({
      score: item.score,
      probability: item.probability,
      simulationProbability: item.simulationProbability,
      historicalProbability: item.historicalProbability,
      handicapResult: item.handicapKey || outcome(Number(item.score.split(":")[0]) + handicap, Number(item.score.split(":")[1]))
    })),
    simulations
  };
}

function largestRemainderQuotas(distributions) {
  const expectedCounts = {};
  for (const distribution of distributions) {
    for (const [key, probability] of Object.entries(distribution)) {
      expectedCounts[key] = (expectedCounts[key] || 0) + probability;
    }
  }
  const quotas = Object.fromEntries(Object.entries(expectedCounts).map(([key, expected]) => [key, Math.floor(expected)]));
  let remaining = distributions.length - Object.values(quotas).reduce((sum, value) => sum + value, 0);
  const remainders = Object.entries(expectedCounts)
    .map(([key, expected]) => ({ key, expected, remainder: expected - Math.floor(expected) }))
    .sort((a, b) => b.remainder - a.remainder || b.expected - a.expected || a.key.localeCompare(b.key, "zh-CN"));
  for (let index = 0; index < remaining; index += 1) quotas[remainders[index % remainders.length].key] += 1;
  return { expectedCounts, quotas };
}

// Hungarian assignment: expand each probability quota into a slot, then find the
// minimum aggregate -log(probability). This retains the day's probability mass
// without randomly forcing a rare outcome onto an unsuitable match.
function minimumCostAssignment(costs) {
  const size = costs.length;
  const u = Array(size + 1).fill(0);
  const v = Array(size + 1).fill(0);
  const p = Array(size + 1).fill(0);
  const way = Array(size + 1).fill(0);
  for (let row = 1; row <= size; row += 1) {
    p[0] = row;
    let column0 = 0;
    const minimum = Array(size + 1).fill(Infinity);
    const used = Array(size + 1).fill(false);
    do {
      used[column0] = true;
      const row0 = p[column0];
      let delta = Infinity;
      let column1 = 0;
      for (let column = 1; column <= size; column += 1) if (!used[column]) {
        const current = costs[row0 - 1][column - 1] - u[row0] - v[column];
        if (current < minimum[column]) {
          minimum[column] = current;
          way[column] = column0;
        }
        if (minimum[column] < delta) {
          delta = minimum[column];
          column1 = column;
        }
      }
      for (let column = 0; column <= size; column += 1) {
        if (used[column]) {
          u[p[column]] += delta;
          v[column] -= delta;
        } else minimum[column] -= delta;
      }
      column0 = column1;
    } while (p[column0] !== 0);
    do {
      const column1 = way[column0];
      p[column0] = p[column1];
      column0 = column1;
    } while (column0 !== 0);
  }
  const assignment = Array(size).fill(-1);
  for (let column = 1; column <= size; column += 1) assignment[p[column] - 1] = column - 1;
  return assignment;
}

function allocateSlateDimension(records, field, distributionField) {
  const eligible = records.filter(record => Object.keys(record.prediction?.[distributionField] || {}).length);
  if (!eligible.length) return { matches: 0, expectedCounts: {}, quotas: {} };
  const distributions = eligible.map(record => normalizeDistributionObject(record.prediction[distributionField]));
  const { expectedCounts, quotas } = largestRemainderQuotas(distributions);
  const slots = Object.entries(quotas).flatMap(([key, count]) => Array.from({ length: count }, () => key));
  const costs = eligible.map((record, row) => slots.map((key, column) => {
    const probability = distributions[row][key] || 1e-12;
    const tieBreaker = (hashSeed(`${record.id}|${field}|${key}|${column}`) % 10_000) / 1e12;
    return -Math.log(probability) + tieBreaker;
  }));
  const assignment = minimumCostAssignment(costs);
  eligible.forEach((record, row) => {
    const prediction = record.prediction;
    const distribution = distributions[row];
    const ranked = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
    const marginalTop = ranked[0][0];
    const marginalProbability = ranked[0][1];
    const selected = slots[assignment[row]];
    const selectedProbability = distribution[selected] || 0;
    prediction.singleMatchTop ||= {};
    prediction.singleMatchTop[field] = { pick: marginalTop, probability: marginalProbability };
    prediction.slatePick ||= {};
    prediction.slatePick[field] = selected;
    prediction.slateDecision ||= {};
    prediction.slateDecision[field] = {
      method: "daily-probability-matched-assignment",
      marginalTop,
      marginalProbability,
      selected,
      selectedProbability,
      opportunityCost: Math.max(0, marginalProbability - selectedProbability)
    };
    if (field === "score" && prediction.scorePortfolio) prediction.scorePortfolio.slateRepresentative = selected;
    if (field === "handicapResult" && prediction.handicapDecision) {
      prediction.handicapDecision.marginalTop = marginalTop;
      prediction.handicapDecision.slateSelected = selected;
    }
  });
  return { matches: eligible.length, expectedCounts, quotas };
}

export function applySlateCalibration(records) {
  const dimensions = [
    ["result", "resultDistribution"],
    ["handicapResult", "handicapResultDistribution"],
    ["score", "scoreDistribution"],
    ["totalGoals", "totalGoalsDistribution"],
    ["halfFull", "halfFullDistribution"]
  ];
  const groups = new Map();
  for (const record of records) {
    const date = record.kickoffDate || record.businessDate || "unknown";
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(record);
  }
  const summary = {};
  for (const [date, rows] of groups) {
    summary[date] = Object.fromEntries(dimensions.map(([field, distributionField]) => [
      field,
      allocateSlateDimension(rows, field, distributionField)
    ]));
    for (const record of rows) {
      const decisions = record.prediction?.slateDecision || {};
      const changed = Object.entries(decisions)
        .filter(([, decision]) => decision.selected !== decision.marginalTop)
        .map(([field, decision]) => `${field}:${decision.marginalTop}→${decision.selected}`);
      record.prediction.reasoning ||= {};
      record.prediction.reasoning.slate = changed.length
        ? `全日联合概率分配为避免逐场众数塌缩，在保持各玩法总概率数量的前提下，本场组合代表为 ${changed.join("、")}；它用于组合覆盖，不覆盖单场最高概率主选。`
        : "本场全日概率代表选与单场最高概率项一致。";
    }
  }
  return summary;
}

export function predictMatch(match, state, learning, adjustment = null) {
  const combinedAdjustment = mergeOfficialNews(adjustment, match.officialContext);
  const marketSignals = marketContext(match, combinedAdjustment);
  const market = marketSignals.consensus;
  const handicapMarket = normalizeOdds(match.odds.handicapResult);
  const elo = eloProbabilities(match, state);
  const externalOnlyPenalty = marketSignals.official ? 1 : 0.75;
  const effectiveMarketWeight = market ? learning.marketWeight * externalOnlyPenalty : 0;
  const rawTarget = market ? elo.map((p, index) => effectiveMarketWeight * market[index] + (1 - effectiveMarketWeight) * p) : elo;
  const context = leagueContext(match, state);
  const headToHead = headToHeadContext(match, state);
  const h2hTarget = blendProbabilities(rawTarget, headToHead.probabilities, headToHead.weight);
  const officialForm = officialFormContext(match, context);
  const formTarget = blendProbabilities(h2hTarget, officialForm.probabilities, officialForm.weight);
  const target = preserveDrawSignal(formTarget, context);
  const statPrior = blendOfficialPrior(teamGoalPrior(match, state, context), officialForm);
  const handicapOnly = !market && Boolean(handicapMarket);
  const fitWeights = handicapOnly ? { result: 0.72, handicap: 2.15 } : { result: 1.7, handicap: 0.82 };
  const fit = fitExpectedGoals(target, handicapMarket, match.handicap, statPrior, fitWeights);
  let lambdaHome = clamp(fit.home * learning.goalScale + learning.homeBias, 0.15, 4.5);
  let lambdaAway = clamp(fit.away * learning.goalScale, 0.15, 4.2);
  const situational = situationalContext(combinedAdjustment);
  lambdaHome = clamp(lambdaHome + situational.homeGoalsDelta, 0.1, 5);
  lambdaAway = clamp(lambdaAway + situational.awayGoalsDelta, 0.1, 5);
  const tactical = tacticalAdjustment(match, state);
  lambdaHome = clamp(lambdaHome + tactical.homeGoalsDelta, 0.1, 5);
  lambdaAway = clamp(lambdaAway + tactical.awayGoalsDelta, 0.1, 5);
  const fittedDirection = distribution(lambdaHome, lambdaAway, match.handicap).result;
  const directionTarget = handicapOnly ? blendProbabilities(target, fittedDirection, 0.68) : target;
  // 随机流只绑定比赛，不绑定模型版本；相同输入不会仅因发布补丁而漂移。
  const prediction = monteCarlo(
    lambdaHome,
    lambdaAway,
    match.handicap,
    `${match.id}:stable-score-path`,
    context,
    directionTarget,
    handicapMarket,
    learning.scorePriorMultiplier ?? 1,
    learning.categoricalCalibration || {}
  );
  prediction.expectedGoals = { home: lambdaHome, away: lambdaAway };
  prediction.tacticalAnalysis = buildTacticalAnalysis(match, state, prediction, tactical);
  const resultPct = OUTCOMES.map(key => `${key}${(prediction.resultDistribution[key] * 100).toFixed(0)}%`).join(" / ");
  const drawGap = Math.max(prediction.resultDistribution.胜, prediction.resultDistribution.负) - prediction.resultDistribution.平;
  const marginalResult = Object.entries(prediction.resultDistribution).sort((a, b) => b[1] - a[1])[0][0];
  const scoreDirection = prediction.result === marginalResult
    ? prediction.result === "平" ? "双方方向接近，平局概率进入第一选择" : `${prediction.result}的边际概率最高`
    : `模拟原始边际最高为“${marginalResult}”，但官方市场、Elo、交锋与联赛平局率融合后的主方向为“${prediction.result}”`;
  const drawReason = prediction.result === "平"
    ? `平局并非兜底项：市场、Elo 与该联赛历史平局率共同校准后，模型主动选择平。`
    : `平局概率为 ${(prediction.resultDistribution.平 * 100).toFixed(1)}%，与最高方向相差 ${(drawGap * 100).toFixed(1)} 个百分点，已纳入但未列为主选。`;
  const halfFullCandidates = prediction.topHalfFull.map(item => `${item.pick} ${(item.probability * 100).toFixed(1)}%`).join("、");
  const scoreCandidatesText = prediction.topScores.map(item => `${item.score} ${(item.probability * 100).toFixed(1)}%`).join("、");
  const totalCandidatesText = prediction.topTotalGoals.map(item => `${item.pick}球 ${(item.probability * 100).toFixed(1)}%`).join("、");
  const handicapMarginalText = Object.entries(prediction.handicapResultDistribution)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key}${(value * 100).toFixed(1)}%`)
    .join(" / ");
  const scoreHandicapText = prediction.handicapDecision.scoreImplied === prediction.handicapResult
    ? `代表比分 ${prediction.score} 对应同一让球结果`
    : `代表比分 ${prediction.score} 对应让球${prediction.handicapDecision.scoreImplied}；比分是独立的最高概率场景，不覆盖让球市场主选`;
  const externalMarketText = marketSignals.external
      ? `场外盘“${combinedAdjustment.externalMarket.source || "已配置数据源"}”去水概率 ${marketSignals.external.map(x => `${(x * 100).toFixed(0)}%`).join(" / ")}，以 ${(marketSignals.externalWeight * 100).toFixed(0)}% 的受限权重并入官方市场`
    : "未配置可核验的场外盘数据，本场不凭空补值";
  const movementText = marketSignals.movement
    ? `；相对开盘，胜/平/负概率变化 ${marketSignals.movement.map(value => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`).join(" / ")} 个百分点`
    : "";
  const newsText = situational.applied.length
    ? `教练/球员情报：${situational.applied.join("；")}`
    : "暂无带来源与可信度的有效教练/球员情报，不做主观加减分";
  const handicapOnlyText = handicapOnly
    ? `本场普通胜平负未开售，但官方让球 ${match.handicap > 0 ? "+" : ""}${match.handicap} 的去水概率为 ${handicapMarket.map(x => `${(x * 100).toFixed(0)}%`).join(" / ")}；模型已提高让球盘拟合权重，用其反推真实实力差，并非按缺失数据处理。`
    : handicapMarket
      ? `官方让球盘去水概率 ${handicapMarket.map(x => `${(x * 100).toFixed(0)}%`).join(" / ")}，与普通胜平负共同约束比分。`
      : "本场官方让球盘尚未开售。";
  prediction.reasoning = {
    direction: `方向分布为 ${resultPct}；${scoreDirection}。让球边际分布为 ${handicapMarginalText}（前两项差 ${(prediction.handicapDecision.gap * 100).toFixed(1)} 个百分点，判断为“${prediction.handicapDecision.level}”），独立主选“让球${prediction.handicapResult}”。${scoreHandicapText}。`,
    score: `该联赛近 ${context.count} 场平均 ${context.totalAverage.toFixed(2)} 球；双方近期攻防推得进球基线 ${statPrior.home.toFixed(2)}:${statPrior.away.toFixed(2)}，结合官方让球 ${match.handicap > 0 ? "+" : ""}${match.handicap} 后得到 xG ${lambdaHome.toFixed(2)}:${lambdaAway.toFixed(2)}。比分在全部赛果方向内使用经验贝叶斯校准：模拟分布与同联赛 ${prediction.scoreCalibration.historicalSamples} 场同方向历史比分按 ${(prediction.scoreCalibration.historicalWeight * 100).toFixed(0)}% 权重融合，权重再由完赛比分对数损失持续修正。候选为 ${scoreCandidatesText}；双选覆盖 ${(prediction.scorePortfolio.coverageTwo * 100).toFixed(1)}%，三选覆盖 ${(prediction.scorePortfolio.coverageThree * 100).toFixed(1)}%。总进球独立边际候选为 ${totalCandidatesText}，主选 ${prediction.totalGoals} 球，不再由代表比分机械推导。`,
    draw: drawReason,
    context: `${handicapOnlyText}${externalMarketText}${movementText}。${officialForm.summary}。${headToHead.summary}，交锋权重为 ${(headToHead.weight * 100).toFixed(1)}%。${newsText}。`,
    tactical: prediction.tacticalAnalysis.dimensions.map(item => `${item.title}：${item.summary}`).join("；"),
    halfFull: `半全场在全部九种组合中独立比较模拟概率与联赛历史频率，不再先限定全场方向。候选为 ${halfFullCandidates}，最终主选 ${prediction.halfFull}。`
  };
  const marketText = marketSignals.official ? `官方胜平负去水概率 ${marketSignals.official.map(x => `${(x * 100).toFixed(0)}%`).join(" / ")}` : "官方胜平负未开售，降低市场信号权重";
  const eloText = `滚动 Elo ${Math.round(state.teamRatings?.[`id:${match.homeId}`] ?? 1500)} : ${Math.round(state.teamRatings?.[`id:${match.awayId}`] ?? 1500)}`;
  const rankText = match.homeRank && match.awayRank ? `联赛排名 ${match.homeRank} : ${match.awayRank}` : "官方页面暂无双方联赛排名";
  return {
    prediction,
    diagnostics: {
      marketProbabilities: market,
      officialMarketProbabilities: marketSignals.official,
      externalMarketProbabilities: marketSignals.external,
      handicapMarketProbabilities: handicapMarket,
      handicapOnly,
      eloProbabilities: elo,
      targetProbabilities: target,
      fittedLoss: fit.loss,
      statPrior,
      headToHead,
      officialForm,
      situational,
      tactical
    },
    factors: {
      objective: [marketText, handicapOnlyText, externalMarketText + movementText, eloText, rankText, officialForm.summary, headToHead.summary, `联赛平局率 ${(context.drawRate * 100).toFixed(1)}%，模型期望进球 ${lambdaHome.toFixed(2)} : ${lambdaAway.toFixed(2)}`, match.dongqiudiContext?.available ? `懂球帝：${match.dongqiudiContext.weather || "天气未提供"} ${match.dongqiudiContext.temperature || ""}，阵型 ${match.dongqiudiContext.formations?.home?.formation || "未知"} vs ${match.dongqiudiContext.formations?.away?.formation || "未知"}` : "懂球帝当前竞彩列表未匹配，本场不补造战术字段"],
      subjective: adjustment?.reason || situational.applied.length || tactical.applied.length
        ? [adjustment?.reason, ...situational.applied, ...tactical.applied, `主/客总 xG 修正 ${(situational.homeGoalsDelta + tactical.homeGoalsDelta).toFixed(2)} / ${(situational.awayGoalsDelta + tactical.awayGoalsDelta).toFixed(2)}`].filter(Boolean)
        : ["暂无经核验的教练、球员或其他人工赛前修正，保持客观基线"]
    }
  };
}

export function actualFromResult(result, handicap) {
  const [halfHome, halfAway] = result.halfScore.split(":").map(Number);
  const [home, away] = result.fullScore.split(":").map(Number);
  return {
    result: outcome(home, away),
    handicapResult: outcome(home + handicap, away),
    score: `${home}:${away}`,
    totalGoals: home + away >= 7 ? "7+" : String(home + away),
    halfFull: `${outcome(halfHome, halfAway)}/${outcome(home, away)}`,
    halfScore: `${halfHome}:${halfAway}`,
    homeGoals: home,
    awayGoals: away
  };
}

export function scoreRecord(record, result) {
  const actual = actualFromResult(result, record.handicap);
  const hits = Object.fromEntries(METRIC_KEYS.map(key => [key, record.prediction[key] === actual[key]]));
  return { ...record, status: "settled", actual, hits, hitCount: Object.values(hits).filter(Boolean).length, settledAt: new Date().toISOString() };
}

export function updateRatings(state, results) {
  state.teamRatings ||= {};
  state.teamForm ||= {};
  state.leagueGoals ||= {};
  state.headToHead ||= {};
  state.processedResults ||= [];
  const processed = new Set(state.processedResults);
  for (const result of [...results].sort((a, b) => a.matchDate.localeCompare(b.matchDate))) {
    if (processed.has(result.id)) continue;
    const [homeGoals, awayGoals] = result.fullScore.split(":").map(Number);
    const homeKey = `id:${result.homeId}`;
    const awayKey = `id:${result.awayId}`;
    const homeRating = state.teamRatings[homeKey] ?? 1500;
    const awayRating = state.teamRatings[awayKey] ?? 1500;
    const expected = 1 / (1 + 10 ** (-(homeRating - awayRating + 68) / 400));
    const actual = homeGoals > awayGoals ? 1 : homeGoals < awayGoals ? 0 : 0.5;
    const margin = 1 + Math.log1p(Math.abs(homeGoals - awayGoals)) * 0.45;
    const delta = 22 * margin * (actual - expected);
    state.teamRatings[homeKey] = homeRating + delta;
    state.teamRatings[awayKey] = awayRating - delta;
    state.teamForm[homeKey] ||= { gf: [], ga: [] };
    state.teamForm[awayKey] ||= { gf: [], ga: [] };
    state.teamForm[homeKey].gf.push(homeGoals);
    state.teamForm[homeKey].ga.push(awayGoals);
    state.teamForm[awayKey].gf.push(awayGoals);
    state.teamForm[awayKey].ga.push(homeGoals);
    state.teamForm[homeKey].gf = state.teamForm[homeKey].gf.slice(-20);
    state.teamForm[homeKey].ga = state.teamForm[homeKey].ga.slice(-20);
    state.teamForm[awayKey].gf = state.teamForm[awayKey].gf.slice(-20);
    state.teamForm[awayKey].ga = state.teamForm[awayKey].ga.slice(-20);
    const leagueKey = String(result.leagueId || result.league);
    state.leagueGoals[leagueKey] ||= { goals: 0, homeGoals: 0, awayGoals: 0, draws: 0, count: 0, scoreCounts: {}, halfOutcomes: { "胜": 0, "平": 0, "负": 0 }, halfFullOutcomes: {} };
    state.leagueGoals[leagueKey].halfFullOutcomes ||= {};
    state.leagueGoals[leagueKey].goals += homeGoals + awayGoals;
    state.leagueGoals[leagueKey].homeGoals += homeGoals;
    state.leagueGoals[leagueKey].awayGoals += awayGoals;
    if (homeGoals === awayGoals) state.leagueGoals[leagueKey].draws += 1;
    state.leagueGoals[leagueKey].count += 1;
    const scoreKey = `${homeGoals}:${awayGoals}`;
    state.leagueGoals[leagueKey].scoreCounts[scoreKey] = (state.leagueGoals[leagueKey].scoreCounts[scoreKey] || 0) + 1;
    if (/^\d+:\d+$/.test(result.halfScore || "")) {
      const [halfHome, halfAway] = result.halfScore.split(":").map(Number);
      const halfKey = outcome(halfHome, halfAway);
      state.leagueGoals[leagueKey].halfOutcomes[halfKey] = (state.leagueGoals[leagueKey].halfOutcomes[halfKey] || 0) + 1;
      const halfFullKey = `${halfKey}/${outcome(homeGoals, awayGoals)}`;
      state.leagueGoals[leagueKey].halfFullOutcomes[halfFullKey] = (state.leagueGoals[leagueKey].halfFullOutcomes[halfFullKey] || 0) + 1;
    }
    const h2hKey = pairKey(result.homeId, result.awayId);
    state.headToHead[h2hKey] ||= { matches: [] };
    state.headToHead[h2hKey].matches.push({
      id: result.id,
      matchDate: result.matchDate,
      leagueId: result.leagueId,
      homeId: result.homeId,
      awayId: result.awayId,
      homeGoals,
      awayGoals
    });
    state.headToHead[h2hKey].matches = state.headToHead[h2hKey].matches
      .sort((a, b) => String(a.matchDate).localeCompare(String(b.matchDate)))
      .slice(-12);
    processed.add(result.id);
  }
  state.processedResults = [...processed].slice(-20000);
  state.schemaVersion = 4;
  state.updatedAt = new Date().toISOString();
  return state;
}

function learnCategoricalCalibration(rows, actualField, distributionField, priorStrength, limit) {
  const eligible = rows.filter(row => row.actual?.[actualField] && row.prediction?.[distributionField]);
  const predictedCounts = {};
  const actualCounts = {};
  for (const row of eligible) {
    const distribution = normalizeDistributionObject(row.prediction[distributionField]);
    for (const [key, probability] of Object.entries(distribution)) {
      predictedCounts[key] = (predictedCounts[key] || 0) + probability;
    }
    const actual = row.actual[actualField];
    actualCounts[actual] = (actualCounts[actual] || 0) + 1;
  }
  const labels = new Set([...Object.keys(predictedCounts), ...Object.keys(actualCounts)]);
  const factors = {};
  const expectedRates = {};
  const observedRates = {};
  for (const label of labels) {
    const expectedRate = eligible.length ? (predictedCounts[label] || 0) / eligible.length : 0;
    const observedRate = eligible.length ? (actualCounts[label] || 0) / eligible.length : 0;
    const shrunkenRate = eligible.length
      ? ((actualCounts[label] || 0) + priorStrength * expectedRate) / (eligible.length + priorStrength)
      : expectedRate;
    expectedRates[label] = expectedRate;
    observedRates[label] = observedRate;
    factors[label] = expectedRate > 1e-8 ? clamp(shrunkenRate / expectedRate, 1 - limit, 1 + limit) : 1;
  }
  return { samples: eligible.length, factors, expectedRates, observedRates };
}

function learnAllCategoricalCalibration(settled) {
  return {
    result: learnCategoricalCalibration(settled, "result", "resultDistribution", 80, 0.18),
    handicapResult: learnCategoricalCalibration(settled, "handicapResult", "handicapResultDistribution", 90, 0.18),
    score: learnCategoricalCalibration(settled, "score", "scoreDistribution", 140, 0.15),
    totalGoals: learnCategoricalCalibration(settled, "totalGoals", "totalGoalsDistribution", 110, 0.18),
    halfFull: learnCategoricalCalibration(settled, "halfFull", "halfFullDistribution", 120, 0.18)
  };
}

export function calibrate(records) {
  const settled = records.filter(row => row.status === "settled" && row.actual).slice(-300);
  if (!settled.length) return {
    marketWeight: 0.78,
    goalScale: 1,
    homeBias: 0,
    scorePriorMultiplier: 1,
    scoreCalibrationSamples: 0,
    categoricalCalibration: learnAllCategoricalCalibration([]),
    sampleSize: 0,
    summary: "尚无赛前锁定样本，使用保守初始参数；首批完赛后自动校准。"
  };
  const goalRows = settled.filter(row => row.prediction.expectedGoals);
  const predictedGoals = goalRows.reduce((sum, row) => sum + row.prediction.expectedGoals.home + row.prediction.expectedGoals.away, 0);
  const actualGoals = goalRows.reduce((sum, row) => sum + row.actual.homeGoals + row.actual.awayGoals, 0);
  const shrink = Math.min(1, goalRows.length / 40);
  const rawScale = predictedGoals ? actualGoals / predictedGoals : 1;
  const goalScale = clamp(1 + shrink * (rawScale - 1), 0.85, 1.15);
  const rawHomeBias = goalRows.length ? goalRows.reduce((sum, row) => sum + row.actual.homeGoals - row.prediction.expectedGoals.home, 0) / goalRows.length : 0;
  const homeBias = clamp(rawHomeBias * shrink, -0.25, 0.25);
  const probRows = settled.filter(row => row.diagnostics?.marketProbabilities && row.diagnostics?.eloProbabilities);
  let marketWeight = 0.78;
  if (probRows.length) {
    let marketBrier = 0, eloBrier = 0;
    for (const row of probRows) {
      const actualIndex = OUTCOMES.indexOf(row.actual.result);
      marketBrier += row.diagnostics.marketProbabilities.reduce((sum, p, i) => sum + (p - (i === actualIndex ? 1 : 0)) ** 2, 0);
      eloBrier += row.diagnostics.eloProbabilities.reduce((sum, p, i) => sum + (p - (i === actualIndex ? 1 : 0)) ** 2, 0);
    }
    marketBrier /= probRows.length;
    eloBrier /= probRows.length;
    const probShrink = Math.min(1, probRows.length / 60);
    marketWeight = clamp(0.76 + probShrink * (eloBrier - marketBrier) * 0.55, 0.65, 0.90);
  }
  const scoreRows = settled.filter(row => row.prediction.scoreSimulationDistribution
    && row.prediction.scoreHistoricalDistribution
    && Number.isFinite(row.prediction.scoreCalibration?.baseHistoricalWeight));
  let scorePriorMultiplier = 1;
  if (scoreRows.length) {
    const candidates = Array.from({ length: 13 }, (_, index) => index * 0.125);
    const losses = candidates.map(multiplier => {
      const loss = scoreRows.reduce((total, row) => {
        const actualScore = row.actual.score;
        const simulated = row.prediction.scoreSimulationDistribution[actualScore] || 0;
        const historical = row.prediction.scoreHistoricalDistribution[actualScore] || 0;
        const weight = Math.min(0.40, row.prediction.scoreCalibration.baseHistoricalWeight * multiplier);
        return total - Math.log(Math.max(1e-8, (1 - weight) * simulated + weight * historical));
      }, 0) / scoreRows.length;
      return { multiplier, loss };
    }).sort((a, b) => a.loss - b.loss);
    const scoreShrink = Math.min(1, scoreRows.length / 60);
    scorePriorMultiplier = clamp(1 + scoreShrink * (losses[0].multiplier - 1), 0.5, 1.35);
  }
  const categoricalCalibration = learnAllCategoricalCalibration(settled);
  return {
    marketWeight, goalScale, homeBias, scorePriorMultiplier, scoreCalibrationSamples: scoreRows.length,
    categoricalCalibration,
    sampleSize: settled.length,
    summary: `基于最近 ${settled.length} 场赛前锁定样本：市场/Elo 权重按 Brier 表现调整，总进球与主场偏差按残差收缩校准；比分历史先验按真实比分对数损失调权（有效 ${scoreRows.length} 场）；胜平负、让球、比分、总进球和半全场的完整概率分布再按真实频率做受限校准。小样本自动向初始值回归。`
  };
}

export function verificationSummary(records) {
  const settled = records.filter(row => row.status === "settled");
  const metrics = {};
  for (const key of METRIC_KEYS) {
    const hits = settled.filter(row => row.hits?.[key]).length;
    metrics[key] = { hits, total: settled.length, accuracy: settled.length ? hits / settled.length : null };
  }
  const strictHits = settled.filter(row => row.hitCount === 5).length;
  const available = Object.values(metrics).map(x => x.accuracy).filter(Number.isFinite);
  const distributionFields = {
    result: "resultDistribution",
    handicapResult: "handicapResultDistribution",
    score: "scoreDistribution",
    totalGoals: "totalGoalsDistribution",
    halfFull: "halfFullDistribution"
  };
  const distributionAudit = Object.fromEntries(Object.entries(distributionFields).map(([field, distributionField]) => {
    const actualCounts = {};
    const selectedCounts = {};
    const expectedCounts = {};
    let probabilitySamples = 0;
    for (const row of settled) {
      const actual = row.actual?.[field];
      const selected = row.prediction?.[field];
      if (actual) actualCounts[actual] = (actualCounts[actual] || 0) + 1;
      if (selected) selectedCounts[selected] = (selectedCounts[selected] || 0) + 1;
      if (row.prediction?.[distributionField]) {
        const distribution = normalizeDistributionObject(row.prediction[distributionField]);
        for (const [key, probability] of Object.entries(distribution)) {
          expectedCounts[key] = (expectedCounts[key] || 0) + probability;
        }
        probabilitySamples += 1;
      }
    }
    return [field, { samples: settled.length, probabilitySamples, actualCounts, selectedCounts, expectedCounts }];
  }));
  return {
    settledCount: settled.length,
    strictHits,
    strictAccuracy: settled.length ? strictHits / settled.length : null,
    macroAccuracy: available.length ? available.reduce((a, b) => a + b, 0) / available.length : null,
    metrics,
    distributionAudit,
    records: [...settled].sort((a, b) => b.kickoff.localeCompare(a.kickoff)).slice(0, 120)
  };
}

export const modelInfo = {
  version: "2.8.0",
  name: "Distribution-Matched Slate + Auditable Tactical Context",
  simulations: 20_000,
  metrics: METRIC_KEYS
};
