const DATA_URL = "data/predictions.json";
const METRIC_LABELS = {
  result: "胜平负", handicapResult: "让球", score: "比分", totalGoals: "进球", halfFull: "半全场"
};

let dashboard = null;
let selectedDate = "all";
let historyFilter = "all";

const el = id => document.getElementById(id);
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
const dateLabel = date => new Intl.DateTimeFormat("zh-CN", { month:"long", day:"numeric", weekday:"short", timeZone:"Asia/Shanghai" }).format(new Date(`${date}T12:00:00+08:00`));
const timeLabel = iso => new Intl.DateTimeFormat("zh-CN", { hour:"2-digit", minute:"2-digit", hour12:false, timeZone:"Asia/Shanghai" }).format(new Date(iso));
const updatedLabel = iso => new Intl.DateTimeFormat("zh-CN", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false, timeZone:"Asia/Shanghai" }).format(new Date(iso));

async function loadData() {
  el("refreshButton").disabled = true;
  try {
    const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache:"no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dashboard = await response.json();
    render();
  } catch (error) {
    el("matchList").innerHTML = `<div class="empty-state">数据读取失败：${escapeHtml(error.message)}。请先运行 <code>npm run update</code>。</div>`;
  } finally {
    el("refreshButton").disabled = false;
  }
}

function render() {
  const { window, generatedAt, model, matches = [], verification = {}, learning = {} } = dashboard;
  el("windowLabel").textContent = `${window.start} — ${window.end}（北京时间）`;
  el("updatedLabel").textContent = `更新 ${updatedLabel(generatedAt)}`;
  el("modelVersion").textContent = model.version;
  renderKpis(matches, verification);
  renderDateTabs(matches);
  renderMatches(matches);
  renderAccuracy(verification);
  renderHistory(verification.records || []);
  renderLearning(learning);
}

function renderKpis(matches, verification) {
  const metrics = verification.metrics || {};
  const items = [
    ["未来两日场次", String(matches.length).padStart(2,"0"), `${new Set(matches.map(m => m.league)).size} 个赛事`],
    ["累计验真样本", String(verification.settledCount || 0).padStart(2,"0"), "仅计赛前锁定预测"],
    ["胜平负准确率", percent(metrics.result?.accuracy), `${metrics.result?.hits || 0}/${metrics.result?.total || 0}`],
    ["五项全中率", percent(verification.strictAccuracy), `${verification.strictHits || 0}/${verification.settledCount || 0}`]
  ];
  el("kpiGrid").innerHTML = items.map(([label,value,note]) => `<article class="kpi"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
}

function renderDateTabs(matches) {
  const dates = [...new Set(matches.map(m => m.kickoffDate))];
  if (selectedDate !== "all" && !dates.includes(selectedDate)) selectedDate = "all";
  el("dateTabs").innerHTML = [`<button class="${selectedDate === "all" ? "active" : ""}" data-date="all" type="button">全部 ${matches.length}</button>`, ...dates.map(date => {
    const count = matches.filter(m => m.kickoffDate === date).length;
    return `<button class="${selectedDate === date ? "active" : ""}" data-date="${date}" type="button">${dateLabel(date)} · ${count}</button>`;
  })].join("");
  el("dateTabs").querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    selectedDate = button.dataset.date;
    renderDateTabs(matches);
    renderMatches(matches);
  }));
}

function renderMatches(matches) {
  const rows = matches.filter(m => selectedDate === "all" || m.kickoffDate === selectedDate);
  const list = el("matchList");
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = `<div class="empty-state">当前窗口暂无未开赛竞彩足球。系统仍会按计划更新赛果与校准参数。</div>`;
    return;
  }
  rows.forEach(match => {
    const node = el("matchTemplate").content.cloneNode(true);
    node.querySelector(".league").textContent = match.league;
    node.querySelector(".match-number").textContent = match.matchNumber;
    node.querySelector("time").textContent = `${match.kickoffDate} ${timeLabel(match.kickoff)}`;
    node.querySelector(".confidence").textContent = `主选置信 ${percent(match.prediction.confidence)}`;
    node.querySelector(".home").textContent = match.home;
    node.querySelector(".away").textContent = match.away;
    node.querySelector(".expected-goals").textContent = `xG ${match.prediction.expectedGoals.home.toFixed(2)} : ${match.prediction.expectedGoals.away.toFixed(2)}`;
    Object.entries(METRIC_LABELS).forEach(([key]) => {
      node.querySelector(`[data-pred="${key}"]`).textContent = match.prediction[key];
      node.querySelector(`[data-prob="${key}"]`).textContent = percent(match.prediction.probabilities[key]);
    });
    const reasoning = match.prediction.reasoning || {};
    node.querySelector(".reason-copy").innerHTML = [
      reasoning.direction && `<p><b>方向：</b>${escapeHtml(reasoning.direction)}</p>`,
      reasoning.score && `<p><b>比分：</b>${escapeHtml(reasoning.score)}</p>`,
      reasoning.draw && `<p><b>平局：</b>${escapeHtml(reasoning.draw)}</p>`,
      reasoning.halfFull && `<p><b>半场：</b>${escapeHtml(reasoning.halfFull)}</p>`
    ].filter(Boolean).join("");
    const objective = match.factors.objective.map(x => `<div><b>客观</b> · ${escapeHtml(x)}</div>`).join("");
    const subjective = match.factors.subjective.map(x => `<div><b>赛前情境</b> · ${escapeHtml(x)}</div>`).join("");
    const alternatives = match.prediction.topScores.map(x => `${x.score} ${percent(x.probability)}`).join(" / ");
    node.querySelector(".factor-content").innerHTML = `${objective}${subjective}<div><b>比分候选</b> · ${alternatives}</div><div><b>官方让球</b> · ${match.handicap > 0 ? "+" : ""}${match.handicap}</div>`;
    list.appendChild(node);
  });
}

function renderAccuracy(verification) {
  const metrics = verification.metrics || {};
  const keys = ["result","handicapResult","score","totalGoals","halfFull"];
  const cells = keys.map(key => ({ label:METRIC_LABELS[key], value:metrics[key]?.accuracy, note:`${metrics[key]?.hits || 0}/${metrics[key]?.total || 0}` }));
  cells.push({ label:"五项宏平均", value:verification.macroAccuracy, note:"五类准确率等权" });
  el("accuracyStrip").innerHTML = cells.map(item => `<div class="accuracy-item"><span>${item.label}</span><strong>${percent(item.value)}</strong><div class="meter"><i style="width:${Number.isFinite(item.value) ? item.value * 100 : 0}%"></i></div><span>${item.note}</span></div>`).join("");
}

function renderHistory(records) {
  const settled = records.filter(row => row.status === "settled");
  const rows = settled.filter(row => historyFilter === "all" || (historyFilter === "hit" ? row.hitCount === 5 : row.hitCount < 5));
  el("historyCount").textContent = `${rows.length} 条已验真`;
  el("historyBody").innerHTML = rows.length ? rows.map(row => {
    const p = row.prediction, a = row.actual;
    const predLines = [`胜平负 ${p.result}`,`让球 ${p.handicapResult}`,`比分 ${p.score}`,`进球 ${p.totalGoals}`,`半全场 ${p.halfFull}`];
    const actualLines = [`胜平负 ${a.result}`,`让球 ${a.handicapResult}`,`比分 ${a.score}`,`进球 ${a.totalGoals}`,`半全场 ${a.halfFull}`];
    return `<tr data-perfect="${row.hitCount === 5}">
      <td class="date-cell">${row.kickoffDate}<br>${row.matchNumber}</td>
      <td class="game-cell"><strong>${escapeHtml(row.home)} vs ${escapeHtml(row.away)}</strong><span>${escapeHtml(row.league)} · 让球 ${row.handicap > 0 ? "+" : ""}${row.handicap}</span></td>
      <td><div class="outcome-lines">${predLines.map(x=>`<span>${x}</span>`).join("")}</div></td>
      <td><div class="outcome-lines">${actualLines.map(x=>`<span>${x}</span>`).join("")}</div></td>
      <td><div class="hit-grid">${Object.keys(METRIC_LABELS).map(key=>`<span class="hit-badge ${row.hits[key] ? "yes" : "no"}" title="${METRIC_LABELS[key]}">${row.hits[key] ? "✓" : "×"}</span>`).join("")}</div><span class="hit-score">${row.hitCount}/5 命中</span></td>
    </tr>`;
  }).join("") : `<tr><td colspan="5" class="empty-state">当前筛选没有已验真记录。</td></tr>`;
}

function renderLearning(learning) {
  el("marketWeight").textContent = percent(learning.marketWeight);
  el("goalScale").textContent = `${Number(learning.goalScale || 1).toFixed(3)}×`;
  const bias = Number(learning.homeBias || 0);
  el("homeBias").textContent = `${bias >= 0 ? "+" : ""}${bias.toFixed(3)}`;
  el("learningSummary").textContent = learning.summary || "样本积累中；小样本阶段保持保守参数。";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]);
}

el("refreshButton").addEventListener("click", loadData);
el("historyFilters").querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
  historyFilter = button.dataset.filter;
  el("historyFilters").querySelectorAll("button").forEach(x => x.classList.toggle("active", x === button));
  renderHistory(dashboard?.verification?.records || []);
}));

loadData();
