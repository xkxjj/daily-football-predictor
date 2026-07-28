import test from "node:test";
import assert from "node:assert/strict";
import { actualFromResult, applySlateCalibration, calibrate, predictMatch, scoreRecord, updateRatings, verificationSummary } from "./lib/model.mjs";
import { mergeContexts } from "./lib/context-feed.mjs";
import { matchDongqiudiEntry, updateTacticalKnowledge } from "./lib/dongqiudi.mjs";
import { buildOfficialContext } from "./lib/sporttery.mjs";

const match = {
  id:"demo-1", matchNumber:"周三001", league:"测试联赛", leagueId:999,
  home:"主队", homeId:1, away:"客队", awayId:2, homeRank:2, awayRank:9,
  handicap:-1, odds:{ result:{home:1.72,draw:3.45,away:4.6}, handicapResult:{home:3.1,draw:3.35,away:1.98} }
};
const state = { teamRatings:{"id:1":1580,"id:2":1480}, leagueGoals:{} };
const learning = { marketWeight:.78, goalScale:1, homeBias:0 };
const topKey = distribution => Object.entries(distribution).sort((a, b) => b[1] - a[1])[0][0];
const sum = distribution => Object.values(distribution).reduce((total, value) => total + value, 0);

test("模型稳定生成五项预测", () => {
  const first = predictMatch(match, state, learning);
  const second = predictMatch(match, state, learning);
  for (const key of ["result","handicapResult","score","totalGoals","halfFull"]) assert.equal(first.prediction[key], second.prediction[key]);
  assert.equal(first.prediction.simulations, 20_000);
  assert.ok(first.prediction.confidence > 0 && first.prediction.confidence < 1);
  assert.equal(first.prediction.result, topKey(first.prediction.resultDistribution), "胜平负必须选择校准分布第一名");
  assert.equal(first.prediction.handicapResult, topKey(first.prediction.handicapResultDistribution), "让球必须选择自身边际分布第一名");
  assert.equal(first.prediction.totalGoals, topKey(first.prediction.totalGoalsDistribution), "总进球必须选择自身校准分布第一名");
  assert.equal(first.prediction.halfFull, topKey(first.prediction.halfFullDistribution), "半全场必须在九种组合中选择联合分布第一名");
  assert.ok(["临界", "偏弱", "明确"].includes(first.prediction.handicapDecision.level));
  assert.ok(first.prediction.topScores.every(item => item.handicapResult));
  assert.equal(first.prediction.score, first.prediction.topScores[0].score);
  assert.equal(first.prediction.score, topKey(first.prediction.scoreDistribution));
  assert.ok(first.prediction.topScores.every((item, index, items) => index === 0 || items[index - 1].probability >= item.probability));
  assert.ok(first.prediction.scorePortfolio.coverageTwo <= first.prediction.scorePortfolio.coverageThree);
  assert.ok(Math.abs(sum(first.prediction.totalGoalsDistribution) - 1) < 1e-10);
  assert.ok(Math.abs(sum(first.prediction.scoreDistribution) - 1) < 1e-10);
  assert.ok(Math.abs(sum(first.prediction.scoreSimulationDistribution) - 1) < 1e-10);
  assert.ok(Math.abs(sum(first.prediction.scoreHistoricalDistribution) - 1) < 1e-10);
  assert.ok(Math.abs(sum(first.prediction.resultDistribution) - 1) < 1e-10);
  assert.ok(Math.abs(sum(first.prediction.handicapResultDistribution) - 1) < 1e-10);
  assert.ok(Math.abs(sum(first.prediction.halfFullDistribution) - 1) < 1e-10);
  assert.ok(first.prediction.reasoning.score.includes(first.prediction.score));
  assert.equal(first.prediction.tacticalAnalysis.dimensions.length, 6);
  assert.ok(first.prediction.tacticalAnalysis.dimensions.every(item => item.summary && item.missing.length));
});

test("懂球帝竞彩场次按日期和球队别名可靠匹配", () => {
  const entry = matchDongqiudiEntry({
    home: "浦项制铁", away: "全北现代", kickoff: "2026-07-25T18:30:00+08:00"
  }, [
    { match_id: 1, home_name: "浦项铁人", guest_name: "全北现代汽车", match_time: "07/25 18:30" },
    { match_id: 2, home_name: "浦项铁人", guest_name: "全北现代汽车", match_time: "09/05 18:30" }
  ]);
  assert.equal(entry.match_id, 1);
  assert.equal(matchDongqiudiEntry({ home: "代格福什", away: "佐加顿斯", kickoff: "2026-07-25T21:00:00+08:00" }, [
    { match_id: 3, home_name: "代格福什", guest_name: "尤尔加登", match_time: "07/25 21:00" }
  ]).match_id, 3);
  assert.equal(matchDongqiudiEntry({ home: "玛丽港", away: "AC奥卢", kickoff: "2026-07-25T21:30:00+08:00" }, [
    { match_id: 4, home_name: "马里汉姆", guest_name: "奥卢", match_time: "07/25 21:30" }
  ]).match_id, 4);
});

test("完赛赛况会积累逐队战术知识且不会把危险进攻冒充 xG", () => {
  const tacticalState = {};
  updateTacticalKnowledge(tacticalState, [{
    recordId: "dqd-1", score: "1:1", home: "哈马比", away: "安德莱赫特", capturedAt: "2026-07-24T04:00:00Z",
    formations: { home: "4-3-3", away: "4-2-3-1" },
    statistics: {
      "控球率": { home: 56, away: 44 }, "射门": { home: 12, away: 6 }, "射正": { home: 6, away: 4 },
      "危险进攻": { home: 70, away: 33 }, "角球": { home: 5, away: 2 }, "黄牌": { home: 2, away: 3 }, "红牌": { home: 0, away: 1 }
    },
    events: { home: [{ minute: 89, code: "G" }], away: [{ minute: 64, code: "SI" }] }
  }]);
  assert.equal(tacticalState.tacticalTeams["哈马比"].samples, 1);
  assert.equal(tacticalState.tacticalTeams["哈马比"].formations["4-3-3"], 1);
  assert.equal(tacticalState.tacticalTeams["安德莱赫特"].totals.redCards, 1);
  assert.equal(tacticalState.tacticalTeams["哈马比"].totals.goalsAfter75, 1);
  assert.equal(tacticalState.tacticalGlobal.samples, 2);
});

test("密集赛程以受限幅度进入 xG 并在六维解释中留下证据", () => {
  const tacticalMatch = {
    ...match,
    id: "tactical-rest",
    kickoff: "2026-07-25T18:30:00+08:00",
    dongqiudiContext: {
      available: true, source: "懂球帝公开比赛页", sourceUrl: "https://pc.dongqiudi.com/match/1",
      weather: "天晴", temperature: "30℃", field: "测试球场", homeTeamName: "主队", awayTeamName: "客队",
      formations: { home: { formation: "4-3-3", source: "recent-match" }, away: { formation: "4-2-3-1", source: "recent-match" } },
      recentMatches: { home: { kickoff: "2026-07-23T10:30:00Z" }, away: { kickoff: "2026-07-20T10:30:00Z" } }
    }
  };
  const generated = predictMatch(tacticalMatch, state, learning);
  assert.ok(generated.diagnostics.tactical.homeGoalsDelta < 0);
  assert.ok(generated.diagnostics.tactical.applied.some(item => item.includes("主队仅休整")));
  assert.equal(generated.prediction.tacticalAnalysis.dimensions.length, 6);
  assert.ok(generated.prediction.tacticalAnalysis.dimensions[1].missing[0].includes("PPDA"));
});

test("平局强信号会被明确选入而不是忽略", () => {
  const drawMatch = { ...match, id:"draw-demo", handicap:0, homeRank:6, awayRank:7, odds:{ result:{home:3.05,draw:2.35,away:3.05}, handicapResult:null } };
  const drawState = { teamRatings:{"id:1":1500,"id:2":1500}, teamForm:{}, leagueGoals:{"999":{homeGoals:25,awayGoals:24,draws:9,count:30,scoreCounts:{"1:1":6,"0:0":3},halfOutcomes:{"胜":8,"平":14,"负":8}}} };
  const predicted = predictMatch(drawMatch, drawState, learning).prediction;
  assert.equal(predicted.result, "平");
  assert.equal(predicted.score.split(":")[0], predicted.score.split(":")[1]);
  assert.equal(predicted.halfFull.split("/")[1], "平");
});

test("开放型比赛不会退化成固定小比分模板", () => {
  const openMatch = { ...match, id:"open-demo", handicap:-1, odds:{ result:{home:1.9,draw:4.2,away:3.1}, handicapResult:{home:3.0,draw:3.8,away:1.95} } };
  const openState = {
    teamRatings:{"id:1":1570,"id:2":1510},
    teamForm:{"id:1":{gf:Array(20).fill(3),ga:Array(20).fill(2)},"id:2":{gf:Array(20).fill(2),ga:Array(20).fill(3)}},
    leagueGoals:{"999":{homeGoals:60,awayGoals:55,draws:5,count:30,scoreCounts:{"3:2":4,"2:2":3,"2:1":2},halfOutcomes:{"胜":11,"平":10,"负":9}}}
  };
  const predicted = predictMatch(openMatch, openState, learning).prediction;
  assert.ok(predicted.topTotalGoals.some(item => Number(item.pick) >= 4),
    `开放型比赛的总进球候选应保留大球路径，实际得到 ${predicted.topTotalGoals.map(item => item.pick).join("、")}`);
  assert.equal(predicted.totalGoals, topKey(predicted.totalGoalsDistribution));
});

test("同联赛历史比分先验可以在样本充分时改变比分排序", () => {
  const baseline = predictMatch({ ...match, id: "score-prior-baseline" }, state, learning).prediction;
  const priorState = {
    ...state,
    leagueGoals: {
      "999": {
        homeGoals: 900, awayGoals: 300, draws: 40, count: 400,
        scoreCounts: { "3:0": 320, "1:0": 20, "2:0": 20, "2:1": 20, "1:1": 20 },
        halfOutcomes: { "胜": 160, "平": 180, "负": 60 }
      }
    }
  };
  const calibrated = predictMatch({ ...match, id: "score-prior-baseline" }, priorState, learning).prediction;
  assert.notEqual(baseline.score, "3:0", "基准模型不应天然固定输出测试先验比分");
  assert.equal(calibrated.score, "3:0");
  assert.ok(calibrated.scoreCalibration.historicalWeight > 0.3);
  assert.ok(calibrated.topScores[0].historicalProbability > calibrated.topScores[1].historicalProbability);
});

test("完赛比分对数损失会持续调节历史先验权重", () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    status: "settled",
    actual: { score: "2:1", result: "胜", homeGoals: 2, awayGoals: 1 },
    prediction: {
      scoreSimulationDistribution: { "2:1": 0.08, "1:0": 0.12 },
      scoreHistoricalDistribution: { "2:1": 0.20, "1:0": 0.05 },
      scoreCalibration: { baseHistoricalWeight: 0.30 }
    },
    diagnostics: {}
  }));
  const learned = calibrate(rows);
  assert.ok(learned.scorePriorMultiplier > 1);
  assert.equal(learned.scoreCalibrationSamples, 60);
});

test("只开让球胜平负时以让球盘反推实力差", () => {
  const handicapOnlyMatch = {
    ...match,
    id: "handicap-only",
    handicap: -2,
    odds: { result: null, handicapResult: { home: 1.82, draw: 4.1, away: 2.95 } }
  };
  const generated = predictMatch(handicapOnlyMatch, state, learning);
  assert.equal(generated.diagnostics.handicapOnly, true);
  assert.ok(generated.prediction.reasoning.context.includes("普通胜平负未开售"));
  assert.equal(generated.prediction.handicapResult, topKey(generated.prediction.handicapResultDistribution));
});

test("让球方向按独立边际概率选择而非由代表比分覆盖", () => {
  const strongFavorite = {
    ...match, id: "strong-favorite", handicap: -1, homeRank: 1, awayRank: 16,
    odds: { result: { home: 1.24, draw: 5.8, away: 9.5 }, handicapResult: { home: 1.64, draw: 4.05, away: 4.25 } }
  };
  const narrowFavorite = {
    ...match, id: "narrow-favorite", handicap: -1, homeRank: 4, awayRank: 9,
    odds: { result: { home: 1.76, draw: 3.55, away: 4.45 }, handicapResult: { home: 4.2, draw: 3.2, away: 1.75 } }
  };
  const strongVisitor = {
    ...match, id: "strong-visitor", handicap: 1, homeRank: 15, awayRank: 2,
    odds: { result: { home: 5.7, draw: 4.2, away: 1.48 }, handicapResult: { home: 2.95, draw: 3.55, away: 1.98 } }
  };
  const outcomes = [strongFavorite, narrowFavorite, strongVisitor]
    .map(item => predictMatch(item, state, learning).prediction);
  for (const prediction of outcomes) {
    assert.equal(prediction.handicapResult, topKey(prediction.handicapResultDistribution));
  }
  assert.ok(new Set(outcomes.map(item => item.handicapResult)).size >= 2, "代表性样本不应机械输出同一让球方向");
});

test("条件半全场历史能识别平局半场后取胜", () => {
  const conditionalState = {
    ...state,
    leagueGoals: {
      "999": {
        homeGoals: 150, awayGoals: 110, draws: 24, count: 100,
        scoreCounts: { "2:0": 12, "2:1": 10, "1:0": 9 },
        halfOutcomes: { "胜": 35, "平": 48, "负": 17 },
        halfFullOutcomes: { "平/胜": 80, "胜/胜": 4, "负/胜": 1 }
      }
    }
  };
  const predicted = predictMatch({ ...match, id: "half-full-conditional" }, conditionalState, learning).prediction;
  assert.equal(predicted.result, "胜");
  assert.equal(predicted.halfFull, "平/胜");
});

test("场外盘、教练与球员情报以受限权重进入模型", () => {
  const adjustment = {
    externalMarket: {
      source: "测试赔率源",
      confidence: 0.8,
      openingResult: { home: 2.1, draw: 3.2, away: 3.4 },
      result: { home: 1.85, draw: 3.4, away: 4.2 }
    },
    teamNews: [{ label: "主队前锋缺阵", source: "俱乐部公告", confidence: 0.9, homeGoalsDelta: -0.2, awayGoalsDelta: 0 }],
    coachNews: [{ label: "客队新帅", source: "俱乐部公告", confidence: 0.7, homeGoalsDelta: 0, awayGoalsDelta: 0.1 }]
  };
  const generated = predictMatch(match, state, learning, adjustment);
  assert.ok(generated.diagnostics.externalMarketProbabilities);
  assert.ok(Math.abs(generated.diagnostics.situational.homeGoalsDelta + 0.18) < 1e-10);
  assert.ok(Math.abs(generated.diagnostics.situational.awayGoalsDelta - 0.07) < 1e-10);
  assert.ok(generated.prediction.reasoning.context.includes("测试赔率源"));
  assert.ok(generated.prediction.reasoning.context.includes("主队前锋缺阵"));
});

test("体彩网赛事前瞻的近期胜率、交锋和伤停进入受限权重", () => {
  const officialContext = buildOfficialContext("demo-1", {
    feature: {
      homeTeamShortName: "主队", awayTeamShortName: "客队", uniformHomeTeamId: 101,
      eachHomeAway: { homeWinGoalMatchCnt: 4, homeDrawMatchCnt: 3, homeLossGoalMatchCnt: 3, awayWinGoalMatchCnt: 5, awayDrawMatchCnt: 2, awayLossGoalMatchCnt: 3, totalLegCnt: 10 },
      goalAvg: { homeGoalAvgCnt: "1.3", awayGoalAvgCnt: "1.6" },
      lossGoalAvg: { homeLossGoalAvgCnt: "1.3", awayLossGoalAvgCnt: "1.4" }
    },
    history: { matchList: [{ matchDate: "2025-04-27", uniformHomeTeamId: 101, homeTeamShortName: "主队", homeTeamFullCourtGoalCnt: "2", awayTeamFullCourtGoalCnt: "0", tournamentShortName: "杯赛" }] },
    injuries: { home: { injuriesAndSuspensionsList: [{ personId: 8, personName: "核心中场", playerPositionCode: "Midfielder", playerPositionDesc: "中场", appearanceCnt: 18, startedMatchCnt: 14, suspensionFlag: 1 }] } },
    players: { home: { playerList: [{ personId: 8, personName: "核心中场", playerPositionCode: "Midfielder", playerPositionDesc: "中场", appearanceCnt: 18, startedMatchCnt: 14, goalProbability: "11%", assistProbability: "43%" }] } }
  }, "2026-07-23T00:00:00.000Z");
  assert.equal(officialContext.recent.home.wins, 4);
  assert.equal(officialContext.headToHead.samples, 1);
  assert.ok(officialContext.teamNews[0].label.includes("停赛"));
  const generated = predictMatch({ ...match, officialContext }, state, learning);
  assert.equal(generated.diagnostics.officialForm.weight, 0.1);
  assert.equal(generated.diagnostics.headToHead.count, 1);
  assert.ok(generated.diagnostics.situational.homeGoalsDelta < 0);
  assert.ok(generated.prediction.reasoning.context.includes("核心中场停赛"));
});

test("历史交锋按当前主队视角记录并仅作弱辅助", () => {
  const h2hState = { teamRatings: {}, teamForm: {}, leagueGoals: {}, headToHead: {}, processedResults: [] };
  updateRatings(h2hState, [
    { id: "h1", matchDate: "2026-01-01", leagueId: 999, homeId: 1, awayId: 2, fullScore: "2:0", halfScore: "1:0" },
    { id: "h2", matchDate: "2026-03-01", leagueId: 999, homeId: 2, awayId: 1, fullScore: "1:1", halfScore: "0:0" }
  ]);
  assert.equal(h2hState.headToHead["1|2"].matches.length, 2);
  const generated = predictMatch(match, h2hState, learning);
  assert.equal(generated.diagnostics.headToHead.count, 2);
  assert.ok(generated.diagnostics.headToHead.weight <= 0.1);
  assert.ok(generated.prediction.reasoning.context.includes("近 2 次交锋"));
});

test("联网情报与本地核验信息按比赛合并，本地值优先", () => {
  const merged = mergeContexts(
    { matches: { "demo-1": { externalMarket: { source: "远程", confidence: 0.6 }, teamNews: [{ label: "远程伤停" }] } } },
    { matches: { "demo-1": { externalMarket: { confidence: 0.9 }, reason: "本地复核" } } }
  );
  assert.equal(merged.matches["demo-1"].externalMarket.source, "远程");
  assert.equal(merged.matches["demo-1"].externalMarket.confidence, 0.9);
  assert.equal(merged.matches["demo-1"].teamNews[0].label, "远程伤停");
  assert.equal(merged.matches["demo-1"].reason, "本地复核");
});

test("官方比分可推导五项真实赛果", () => {
  const actual = actualFromResult({ halfScore:"1:0", fullScore:"2:1" }, -1);
  assert.deepEqual(actual, { result:"胜", handicapResult:"平", score:"2:1", totalGoals:"3", halfFull:"胜/胜", halfScore:"1:0", homeGoals:2, awayGoals:1 });
});

test("验真只比较赛前锁定值", () => {
  const record = { id:"demo", handicap:-1, prediction:{ result:"胜", handicapResult:"平", score:"2:1", totalGoals:"3", halfFull:"胜/胜" } };
  const scored = scoreRecord(record, { halfScore:"1:0", fullScore:"2:1" });
  assert.equal(scored.hitCount, 5);
  const summary = verificationSummary([scored]);
  assert.equal(summary.strictAccuracy, 1);
  assert.equal(summary.metrics.score.accuracy, 1);
});

test("全日概率分配不会退化为逐场同一众数", () => {
  const distributions = {
    resultDistribution: { "胜": 0.45, "平": 0.30, "负": 0.25 },
    handicapResultDistribution: { "胜": 0.35, "平": 0.30, "负": 0.35 },
    scoreDistribution: { "1:1": 0.30, "2:1": 0.20, "1:2": 0.20, "2:0": 0.15, "0:2": 0.10, "3:1": 0.05 },
    totalGoalsDistribution: { "0": 0.05, "1": 0.15, "2": 0.30, "3": 0.25, "4": 0.15, "5": 0.10 },
    halfFullDistribution: { "胜/胜": 0.20, "平/胜": 0.15, "胜/平": 0.10, "平/平": 0.10, "负/平": 0.10, "平/负": 0.10, "负/负": 0.15, "胜/负": 0.05, "负/胜": 0.05 }
  };
  const rows = Array.from({ length: 10 }, (_, index) => ({
    id: `slate-${index}`,
    kickoffDate: "2026-07-28",
    prediction: {
      ...structuredClone(distributions),
      result: "胜", handicapResult: "胜", score: "1:1", totalGoals: "2", halfFull: "胜/胜",
      confidence: 0.45,
      probabilities: { result: 0.45, handicapResult: 0.35, score: 0.30, totalGoals: 0.30, halfFull: 0.20 },
      handicapDecision: { selected: "胜", marginalTop: "胜" },
      scorePortfolio: { primary: "1:1" },
      reasoning: {}
    }
  }));
  const summary = applySlateCalibration(rows)["2026-07-28"];
  for (const field of ["result", "handicapResult", "score", "totalGoals", "halfFull"]) {
    const selectedCounts = rows.reduce((counts, row) => {
      const selected = row.prediction.slatePick[field];
      counts[selected] = (counts[selected] || 0) + 1;
      return counts;
    }, {});
    assert.deepEqual(selectedCounts, Object.fromEntries(Object.entries(summary[field].quotas).filter(([, count]) => count > 0)));
  }
  assert.equal(rows.filter(row => row.prediction.slatePick.result === "平").length, 3);
  assert.ok(new Set(rows.map(row => row.prediction.slatePick.score)).size >= 5);
  assert.ok(rows.some(row => ["平/胜", "胜/平", "平/负", "负/平"].includes(row.prediction.slatePick.halfFull)));
  assert.ok(rows.every(row => row.prediction.singleMatchTop.result.pick === "胜"));
  assert.ok(rows.every(row => row.prediction.result === "胜"), "全日组合选不能覆盖单场最高概率主选");
});

test("真实频率以收缩权重校准完整分布", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    status: "settled",
    actual: { result: index < 10 ? "平" : index < 15 ? "胜" : "负", homeGoals: 1, awayGoals: 1, score: "1:1", totalGoals: "2", halfFull: "平/平", handicapResult: "平" },
    prediction: { resultDistribution: { "胜": 0.45, "平": 0.25, "负": 0.30 } }
  }));
  const learned = calibrate(rows);
  assert.equal(learned.categoricalCalibration.result.samples, 20);
  assert.ok(learned.categoricalCalibration.result.factors["平"] > 1);
  assert.ok(learned.categoricalCalibration.result.factors["胜"] < 1);
});

test("无样本时校准参数保持保守", () => {
  const learned = calibrate([]);
  assert.equal(learned.marketWeight, 0.78);
  assert.equal(learned.goalScale, 1);
  assert.equal(learned.homeBias, 0);
  assert.equal(learned.scorePriorMultiplier, 1);
  assert.equal(learned.sampleSize, 0);
  assert.equal(learned.categoricalCalibration.result.samples, 0);
});
