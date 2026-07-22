import test from "node:test";
import assert from "node:assert/strict";
import { actualFromResult, calibrate, predictMatch, scoreRecord, verificationSummary } from "./lib/model.mjs";

const match = {
  id:"demo-1", matchNumber:"周三001", league:"测试联赛", leagueId:999,
  home:"主队", homeId:1, away:"客队", awayId:2, homeRank:2, awayRank:9,
  handicap:-1, odds:{ result:{home:1.72,draw:3.45,away:4.6}, handicapResult:{home:3.1,draw:3.35,away:1.98} }
};
const state = { teamRatings:{"id:1":1580,"id:2":1480}, leagueGoals:{} };
const learning = { marketWeight:.78, goalScale:1, homeBias:0 };

test("模型稳定生成五项预测", () => {
  const first = predictMatch(match, state, learning);
  const second = predictMatch(match, state, learning);
  for (const key of ["result","handicapResult","score","totalGoals","halfFull"]) assert.equal(first.prediction[key], second.prediction[key]);
  assert.equal(first.prediction.simulations, 20_000);
  assert.ok(first.prediction.confidence > 0 && first.prediction.confidence < 1);
  const [home, away] = first.prediction.score.split(":").map(Number);
  const result = home > away ? "胜" : home < away ? "负" : "平";
  const handicapResult = home + match.handicap > away ? "胜" : home + match.handicap < away ? "负" : "平";
  assert.equal(first.prediction.result, result, "比分必须与胜平负自洽");
  assert.equal(first.prediction.handicapResult, handicapResult, "比分必须与让球胜平负自洽");
  assert.equal(first.prediction.totalGoals, String(home + away), "比分必须与总进球自洽");
  assert.equal(first.prediction.halfFull.split("/")[1], result, "半全场的全场方向必须自洽");
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
