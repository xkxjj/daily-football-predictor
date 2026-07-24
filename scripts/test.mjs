import test from "node:test";
import assert from "node:assert/strict";
import { actualFromResult, calibrate, predictMatch, scoreRecord, updateRatings, verificationSummary } from "./lib/model.mjs";
import { mergeContexts } from "./lib/context-feed.mjs";
import { buildOfficialContext } from "./lib/sporttery.mjs";

const match = {
  id:"demo-1", matchNumber:"周三001", league:"测试联赛", leagueId:999,
  home:"主队", homeId:1, away:"客队", awayId:2, homeRank:2, awayRank:9,
  handicap:-1, odds:{ result:{home:1.72,draw:3.45,away:4.6}, handicapResult:{home:3.1,draw:3.35,away:1.98} }
};
const state = { teamRatings:{"id:1":1580,"id:2":1480}, leagueGoals:{} };
const learning = { marketWeight:.78, goalScale:1, homeBias:0 };
const topKey = distribution => Object.entries(distribution).sort((a, b) => b[1] - a[1])[0][0];

test("模型稳定生成五项预测", () => {
  const first = predictMatch(match, state, learning);
  const second = predictMatch(match, state, learning);
  for (const key of ["result","handicapResult","score","totalGoals","halfFull"]) assert.equal(first.prediction[key], second.prediction[key]);
  assert.equal(first.prediction.simulations, 20_000);
  assert.ok(first.prediction.confidence > 0 && first.prediction.confidence < 1);
  const [home, away] = first.prediction.score.split(":").map(Number);
  const result = home > away ? "胜" : home < away ? "负" : "平";
  assert.equal(first.prediction.result, result, "比分必须与胜平负自洽");
  assert.equal(first.prediction.result, topKey(first.prediction.resultDistribution), "胜平负必须选择校准分布第一名");
  assert.equal(first.prediction.handicapResult, topKey(first.prediction.handicapResultDistribution), "让球必须选择自身边际分布第一名");
  assert.equal(first.prediction.totalGoals, String(home + away), "比分必须与总进球自洽");
  assert.equal(first.prediction.halfFull, topKey(first.prediction.halfFullDistribution), "半全场必须在九种组合中选择联合分布第一名");
  assert.ok(["临界", "偏弱", "明确"].includes(first.prediction.handicapDecision.level));
  assert.ok(first.prediction.topScores.every(item => item.handicapResult));
  assert.ok(first.prediction.reasoning.score.includes(first.prediction.score));
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
  const total = predicted.score.split(":").map(Number).reduce((a, b) => a + b, 0);
  assert.ok(total >= 4, `开放型比赛应保留大比分路径，实际得到 ${predicted.score}`);
  assert.equal(predicted.totalGoals, String(total));
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

test("无样本时校准参数保持保守", () => {
  assert.deepEqual(calibrate([]), { marketWeight:.78, goalScale:1, homeBias:0, sampleSize:0, summary:"尚无赛前锁定样本，使用保守初始参数；首批完赛后自动校准。" });
});
