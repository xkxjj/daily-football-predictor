const OUTCOMES = ["胜", "平", "负"];
const METRIC_KEYS = ["result", "handicapResult", "score", "totalGoals", "halfFull"];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
  const rows = state.headToHead?.[pairKey(match.homeId, match.awayId)]?.matches || [];
  const relevant = [...rows]
    .filter(row => [String(row.homeId), String(row.awayId)].includes(String(match.homeId)))
    .sort((a, b) => String(b.matchDate).localeCompare(String(a.matchDate)))
    .slice(0, 8);
  if (!relevant.length) return { count: 0, weight: 0, probabilities: null, summary: "暂无可匹配的历史交锋样本" };

  const now = Date.now();
  let weightedWins = 0, weightedDraws = 0, weightedLosses = 0, weightedFor = 0, weightedAgainst = 0, totalWeight = 0;
  for (const row of relevant) {
    const ageDays = Math.max(0, (now - new Date(`${row.matchDate}T12:00:00Z`).getTime()) / 86_400_000);
    const recency = Math.exp(-ageDays / 540);
    const currentHomeWasHome = String(row.homeId) === String(match.homeId);
    const goalsFor = currentHomeWasHome ? row.homeGoals : row.awayGoals;
    const goalsAgainst = currentHomeWasHome ? row.awayGoals : row.homeGoals;
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
    summary: `近 ${relevant.length} 次交锋按时间衰减后，当前主队视角为胜 ${(probabilities[0] * 100).toFixed(0)}% / 平 ${(probabilities[1] * 100).toFixed(0)}% / 负 ${(probabilities[2] * 100).toFixed(0)}%，场均进球 ${averageFor.toFixed(2)}:${averageAgainst.toFixed(2)}`
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

function chooseCoherentScore(scores, resultPick, lambdaHome, lambdaAway, context, simulations) {
  const empiricalTotal = Object.values(context.scoreCounts).reduce((a, b) => a + b, 0) || 1;
  const candidates = [...scores.entries()].filter(([score]) => scoreOutcome(score) === resultPick);
  const ranked = candidates.map(([score, count]) => {
    const [home, away] = score.split(":").map(Number);
    const empiricalRate = (context.scoreCounts[score] || 0) / empiricalTotal;
    const distance = (home - lambdaHome) ** 2 + (away - lambdaAway) ** 2;
    const totalDistance = Math.abs(home + away - (lambdaHome + lambdaAway));
    const utility = Math.log(Math.max(count / simulations, 1e-8)) - 0.15 * distance - 0.07 * totalDistance + 0.45 * Math.sqrt(empiricalRate);
    return { score, count, utility };
  }).sort((a, b) => b.utility - a.utility);
  // 高节奏比赛用接近期望进球的代表路径，避免即使 xG 超过 4 球仍机械输出 1:0/1:1。
  if (lambdaHome + lambdaAway >= 3.6) {
    let home = Math.round(lambdaHome);
    let away = Math.round(lambdaAway);
    if (resultPick === "胜" && home <= away) home = away + 1;
    if (resultPick === "负" && away <= home) away = home + 1;
    if (resultPick === "平") home = away = Math.max(1, Math.round((lambdaHome + lambdaAway) / 2));
    const highTempo = ranked.find(candidate => candidate.score === `${home}:${away}` && candidate.count / simulations >= 0.01);
    if (highTempo) return highTempo;
  }
  return ranked[0];
}

function monteCarlo(lambdaHome, lambdaAway, handicap, seed, context, directionTarget, simulations = 20_000) {
  const random = mulberry32(hashSeed(seed));
  const result = new Map(OUTCOMES.map(key => [key, 0]));
  const handicapResult = new Map(OUTCOMES.map(key => [key, 0]));
  const scores = new Map();
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
    scores.set(scoreKey, (scores.get(scoreKey) || 0) + 1);
    totals.set(totalKey, totals.get(totalKey) + 1);
    halfFull.set(halfFullKey, (halfFull.get(halfFullKey) || 0) + 1);
  }
  const directionScores = OUTCOMES.map((key, index) => ({ key, score: 0.68 * result.get(key) / simulations + 0.32 * directionTarget[index] }));
  const resultPick = directionScores.sort((a, b) => b.score - a.score)[0].key;
  const resultCount = result.get(resultPick);
  const chosenScore = chooseCoherentScore(scores, resultPick, lambdaHome, lambdaAway, context, simulations);
  const [scoreHome, scoreAway] = chosenScore.score.split(":").map(Number);
  const handicapPick = outcome(scoreHome + handicap, scoreAway);
  const handicapCount = handicapResult.get(handicapPick);
  const totalPick = scoreHome + scoreAway >= 7 ? "7+" : String(scoreHome + scoreAway);
  const totalCount = totals.get(totalPick);
  const compatibleHalfRows = [...halfFull.entries()].filter(([key]) => key.endsWith(`/${resultPick}`));
  const maxHalfCount = Math.max(...compatibleHalfRows.map(([, count]) => count));
  const maxHalfPrior = Math.max(...Object.values(context.halfOutcomeRates));
  const halfCandidates = compatibleHalfRows
    .map(([key, count]) => {
      const halfKey = key.split("/")[0];
      const likelihood = count / maxHalfCount;
      const historical = (context.halfOutcomeRates[halfKey] || 0.28) / maxHalfPrior;
      return { key, count, adjusted: 0.64 * likelihood + 0.36 * historical };
    })
    .sort((a, b) => b.adjusted - a.adjusted);
  const halfFullPick = halfCandidates[0].key;
  const halfFullCount = halfCandidates[0].count;
  const topHalfFull = [[halfFullPick, halfFullCount], ...compatibleHalfRows.filter(([key]) => key !== halfFullPick).sort((a, b) => b[1] - a[1])].slice(0, 3);
  const rawTopScores = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const topScores = [[chosenScore.score, chosenScore.count], ...rawTopScores.filter(([score]) => score !== chosenScore.score)].slice(0, 3);
  return {
    result: resultPick,
    handicapResult: handicapPick,
    score: chosenScore.score,
    totalGoals: totalPick,
    halfFull: halfFullPick,
    confidence: resultCount / simulations,
    probabilities: {
      result: resultCount / simulations,
      handicapResult: handicapCount / simulations,
      score: chosenScore.count / simulations,
      totalGoals: totalCount / simulations,
      halfFull: halfFullCount / simulations
    },
    resultDistribution: Object.fromEntries([...result].map(([k, v]) => [k, v / simulations])),
    halfFullDistribution: Object.fromEntries([...halfFull].map(([k, v]) => [k, v / simulations])),
    topHalfFull: topHalfFull.map(([pick, count]) => ({ pick, probability: count / simulations })),
    topScores: topScores.map(([score, count]) => ({ score, probability: count / simulations })),
    simulations
  };
}

export function predictMatch(match, state, learning, adjustment = null) {
  const marketSignals = marketContext(match, adjustment);
  const market = marketSignals.consensus;
  const handicapMarket = normalizeOdds(match.odds.handicapResult);
  const elo = eloProbabilities(match, state);
  const externalOnlyPenalty = marketSignals.official ? 1 : 0.75;
  const effectiveMarketWeight = market ? learning.marketWeight * externalOnlyPenalty : 0;
  const rawTarget = market ? elo.map((p, index) => effectiveMarketWeight * market[index] + (1 - effectiveMarketWeight) * p) : elo;
  const context = leagueContext(match, state);
  const headToHead = headToHeadContext(match, state);
  const h2hTarget = blendProbabilities(rawTarget, headToHead.probabilities, headToHead.weight);
  const target = preserveDrawSignal(h2hTarget, context);
  const statPrior = teamGoalPrior(match, state, context);
  const handicapOnly = !market && Boolean(handicapMarket);
  const fitWeights = handicapOnly ? { result: 0.72, handicap: 2.15 } : { result: 1.7, handicap: 0.82 };
  const fit = fitExpectedGoals(target, handicapMarket, match.handicap, statPrior, fitWeights);
  let lambdaHome = clamp(fit.home * learning.goalScale + learning.homeBias, 0.15, 4.5);
  let lambdaAway = clamp(fit.away * learning.goalScale, 0.15, 4.2);
  const situational = situationalContext(adjustment);
  lambdaHome = clamp(lambdaHome + situational.homeGoalsDelta, 0.1, 5);
  lambdaAway = clamp(lambdaAway + situational.awayGoalsDelta, 0.1, 5);
  const fittedDirection = distribution(lambdaHome, lambdaAway, match.handicap).result;
  const directionTarget = handicapOnly ? blendProbabilities(target, fittedDirection, 0.68) : target;
  const prediction = monteCarlo(lambdaHome, lambdaAway, match.handicap, `${match.id}:v2.2.0`, context, directionTarget);
  prediction.expectedGoals = { home: lambdaHome, away: lambdaAway };
  const resultPct = OUTCOMES.map(key => `${key}${(prediction.resultDistribution[key] * 100).toFixed(0)}%`).join(" / ");
  const drawGap = Math.max(prediction.resultDistribution.胜, prediction.resultDistribution.负) - prediction.resultDistribution.平;
  const scoreDirection = prediction.result === "平" ? "双方方向接近，平局概率进入第一选择" : `${prediction.result}的综合概率最高`;
  const drawReason = prediction.result === "平"
    ? `平局并非兜底项：市场、Elo 与该联赛历史平局率共同校准后，模型主动选择平。`
    : `平局概率为 ${(prediction.resultDistribution.平 * 100).toFixed(1)}%，与最高方向相差 ${(drawGap * 100).toFixed(1)} 个百分点，已纳入但未列为主选。`;
  const halfFullCandidates = prediction.topHalfFull.map(item => `${item.pick} ${(item.probability * 100).toFixed(1)}%`).join("、");
  const externalMarketText = marketSignals.external
    ? `场外盘“${adjustment.externalMarket.source || "已配置数据源"}”去水概率 ${marketSignals.external.map(x => `${(x * 100).toFixed(0)}%`).join(" / ")}，以 ${(marketSignals.externalWeight * 100).toFixed(0)}% 的受限权重并入官方市场`
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
    direction: `方向分布为 ${resultPct}；${scoreDirection}。`,
    score: `该联赛近 ${context.count} 场平均 ${context.totalAverage.toFixed(2)} 球；双方近期攻防推得进球基线 ${statPrior.home.toFixed(2)}:${statPrior.away.toFixed(2)}，结合官方让球 ${match.handicap > 0 ? "+" : ""}${match.handicap} 后得到 xG ${lambdaHome.toFixed(2)}:${lambdaAway.toFixed(2)}。在“${prediction.result}”方向内，对小比分与开放型大比分长尾一并模拟，最终选择自洽代表比分 ${prediction.score}。`,
    draw: drawReason,
    context: `${handicapOnlyText}${externalMarketText}${movementText}。${headToHead.summary}，交锋权重限制为 ${(headToHead.weight * 100).toFixed(1)}%。${newsText}。`,
    halfFull: `半场单独使用较低进球阶段和联赛半场平局率校准，再限定全场方向必须为“${prediction.result}”。候选为 ${halfFullCandidates}，其中包含“半场平”的真实权重，最终主选 ${prediction.halfFull}。`
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
      situational
    },
    factors: {
      objective: [marketText, handicapOnlyText, externalMarketText + movementText, eloText, rankText, headToHead.summary, `联赛平局率 ${(context.drawRate * 100).toFixed(1)}%，模型期望进球 ${lambdaHome.toFixed(2)} : ${lambdaAway.toFixed(2)}`],
      subjective: adjustment?.reason || situational.applied.length
        ? [adjustment?.reason, ...situational.applied, `主/客总 xG 修正 ${situational.homeGoalsDelta.toFixed(2)} / ${situational.awayGoalsDelta.toFixed(2)}`].filter(Boolean)
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
    state.leagueGoals[leagueKey] ||= { goals: 0, homeGoals: 0, awayGoals: 0, draws: 0, count: 0, scoreCounts: {}, halfOutcomes: { "胜": 0, "平": 0, "负": 0 } };
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
  state.schemaVersion = 3;
  state.updatedAt = new Date().toISOString();
  return state;
}

export function calibrate(records) {
  const settled = records.filter(row => row.status === "settled" && row.actual).slice(-300);
  if (!settled.length) return { marketWeight: 0.78, goalScale: 1, homeBias: 0, sampleSize: 0, summary: "尚无赛前锁定样本，使用保守初始参数；首批完赛后自动校准。" };
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
  return {
    marketWeight, goalScale, homeBias, sampleSize: settled.length,
    summary: `基于最近 ${settled.length} 场赛前锁定样本：市场/Elo 权重按 Brier 表现调整，总进球与主场偏差按残差收缩校准。小样本自动向初始值回归。`
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
  return {
    settledCount: settled.length,
    strictHits,
    strictAccuracy: settled.length ? strictHits / settled.length : null,
    macroAccuracy: available.length ? available.reduce((a, b) => a + b, 0) / available.length : null,
    metrics,
    records: [...settled].sort((a, b) => b.kickoff.localeCompare(a.kickoff)).slice(0, 120)
  };
}

export const modelInfo = {
  version: "2.2.0",
  name: "Coherent Multi-signal Market-Elo Score Path",
  simulations: 20_000,
  metrics: METRIC_KEYS
};
