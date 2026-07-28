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
  const { window, generatedAt, model, matches = [], verification = {}, resultArchive = {}, learning = {} } = dashboard;
  el("windowLabel").textContent = `${window.start} — ${window.end}（北京时间）`;
  el("updatedLabel").textContent = `更新 ${updatedLabel(generatedAt)}`;
  el("modelVersion").textContent = model.version;
  renderKpis(matches, verification);
  renderDateTabs(matches);
  renderMatches(matches);
  renderAccuracy(verification);
  renderDistributionAudit(verification.distributionAudit || {});
  renderHistory(verification.records || []);
  renderResultArchive(resultArchive);
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
    const resultTop = match.prediction.singleMatchTop?.result;
    node.querySelector(".confidence").textContent = resultTop
      ? `单场主选 ${resultTop.pick} ${percent(resultTop.probability)} · 另列全日组合选`
      : `主选置信 ${percent(match.prediction.confidence)}`;
    node.querySelector(".home").textContent = match.home;
    node.querySelector(".away").textContent = match.away;
    node.querySelector(".expected-goals").textContent = `xG ${match.prediction.expectedGoals.home.toFixed(2)} : ${match.prediction.expectedGoals.away.toFixed(2)}`;
    Object.entries(METRIC_LABELS).forEach(([key]) => {
      node.querySelector(`[data-pred="${key}"]`).textContent = match.prediction[key];
      const probability = percent(match.prediction.probabilities[key]);
      const slateDecision = match.prediction.slateDecision?.[key];
      const slateNote = slateDecision
        ? slateDecision.selected === match.prediction[key]
          ? " · 全日组合同主选"
          : ` · 全日组合 ${slateDecision.selected} ${percent(slateDecision.selectedProbability)}`
        : "";
      const strength = key === "handicapResult" && match.prediction.handicapDecision
        ? ` · ${match.prediction.handicapDecision.level}`
        : "";
      node.querySelector(`[data-prob="${key}"]`).textContent = `${probability}${strength}${slateNote}`;
    });
    const reasoning = match.prediction.reasoning || {};
    node.querySelector(".reason-copy").innerHTML = [
      reasoning.direction && `<p><b>方向：</b>${escapeHtml(reasoning.direction)}</p>`,
      reasoning.score && `<p><b>比分：</b>${escapeHtml(reasoning.score)}</p>`,
      reasoning.draw && `<p><b>平局：</b>${escapeHtml(reasoning.draw)}</p>`,
      reasoning.slate && `<p><b>全日概率分配：</b>${escapeHtml(reasoning.slate)}</p>`,
      reasoning.context && `<p><b>近期 / 场外 / 人员 / 交锋：</b>${escapeHtml(reasoning.context)}</p>`,
      reasoning.halfFull && `<p><b>半场：</b>${escapeHtml(reasoning.halfFull)}</p>`
    ].filter(Boolean).join("");
    const objective = match.factors.objective.map(x => `<div><b>客观</b> · ${escapeHtml(x)}</div>`).join("");
    const subjective = match.factors.subjective.map(x => `<div><b>赛前情境</b> · ${escapeHtml(x)}</div>`).join("");
    const alternatives = match.prediction.topScores.map(x => `${x.score} ${percent(x.probability)}（让球${x.handicapResult}）`).join(" / ");
    const portfolio = match.prediction.scorePortfolio;
    const scoreCoverage = portfolio
      ? `<div><b>比分组合覆盖</b> · 双选 ${percent(portfolio.coverageTwo)} / 三选 ${percent(portfolio.coverageThree)}（3 场分别为 8 / 27 组）</div>`
      : "";
    const totalCandidates = (match.prediction.topTotalGoals || [])
      .map(x => `${x.pick}球 ${percent(x.probability)}`).join(" / ");
    const totalCoverage = totalCandidates ? `<div><b>总进球候选</b> · ${totalCandidates}</div>` : "";
    const tactical = match.prediction.tacticalAnalysis;
    const tacticalHtml = tactical?.dimensions?.length ? `<section class="tactical-analysis">
      <div class="tactical-heading"><b>六维战术分析</b><span>${escapeHtml(tactical.dataPolicy)}</span>${tactical.sourceUrl ? `<a href="${escapeHtml(tactical.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看来源</a>` : ""}</div>
      <div class="tactical-grid">${tactical.dimensions.map(item => `<article><div><strong>${escapeHtml(item.title)}</strong><small>证据置信 ${percent(item.confidence)}</small></div><p>${escapeHtml(item.summary)}</p><span>依据：${escapeHtml((item.evidence || []).join("；"))}</span><em>缺口：${escapeHtml((item.missing || []).join("；"))}</em></article>`).join("")}</div>
    </section>` : "";
    const slatePicks = match.prediction.slatePick
      ? `<div><b>全日组合代表</b> · 胜平负 ${match.prediction.slatePick.result} / 让球 ${match.prediction.slatePick.handicapResult} / 比分 ${match.prediction.slatePick.score} / 进球 ${match.prediction.slatePick.totalGoals} / 半全场 ${match.prediction.slatePick.halfFull}</div>`
      : "";
    node.querySelector(".factor-content").innerHTML = `${tacticalHtml}${objective}${subjective}${slatePicks}<div><b>比分候选</b> · ${alternatives}</div>${scoreCoverage}${totalCoverage}<div><b>官方让球</b> · ${match.handicap > 0 ? "+" : ""}${match.handicap}</div>`;
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

function renderDistributionAudit(audit) {
  const container = el("distributionAudit");
  if (!container) return;
  const specifications = [
    ["result", "胜平负", 3],
    ["halfFull", "半全场路径", 9],
    ["score", "比分", 8],
    ["totalGoals", "总进球", 8]
  ];
  const cards = specifications.map(([field, label, limit]) => {
    const item = audit[field];
    if (!item?.samples) return "";
    const keys = [...new Set([
      ...Object.keys(item.actualCounts || {}),
      ...Object.keys(item.selectedCounts || {}),
      ...Object.keys(item.expectedCounts || {})
    ])].sort((a, b) => (item.actualCounts?.[b] || 0) - (item.actualCounts?.[a] || 0)
      || (item.expectedCounts?.[b] || 0) - (item.expectedCounts?.[a] || 0));
    const rows = keys.slice(0, limit).map(key => `<tr>
      <th>${escapeHtml(key)}</th>
      <td>${item.actualCounts?.[key] || 0}</td>
      <td>${item.selectedCounts?.[key] || 0}</td>
      <td>${Number(item.expectedCounts?.[key] || 0).toFixed(1)}</td>
    </tr>`).join("");
    return `<article><h3>${label}</h3><p>${item.samples} 场：真实结果、旧版单项主选与完整概率期望的对照。</p><table><thead><tr><th>类别</th><th>真实</th><th>主选</th><th>概率期望</th></tr></thead><tbody>${rows}</tbody></table></article>`;
  }).filter(Boolean);
  container.innerHTML = cards.length
    ? `<div class="audit-heading"><strong>历史分布审计</strong><span>“概率期望”是每场完整分布相加，不等于机械取第一名；2.8 起用全日联合分配抑制众数塌缩。</span></div><div class="audit-grid">${cards.join("")}</div>`
    : "";
}

function renderHistory(records) {
  const settled = records.filter(row => row.status === "settled");
  const rows = settled.filter(row => historyFilter === "all" || (historyFilter === "hit" ? row.hitCount === 5 : row.hitCount < 5));
  el("historyCount").textContent = `${rows.length} 条已验真`;
  el("historyBody").innerHTML = rows.length ? rows.map(row => {
    const p = row.prediction, a = row.actual;
    const predLine = (label, field) => `${label} ${p[field]}${p.slatePick?.[field] && p.slatePick[field] !== p[field] ? `（组合 ${p.slatePick[field]}）` : ""}`;
    const predLines = [predLine("胜平负", "result"),predLine("让球", "handicapResult"),predLine("比分", "score"),predLine("进球", "totalGoals"),predLine("半全场", "halfFull")];
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

function renderResultArchive(archive = {}) {
  const rows = archive.records || [];
  el("resultOnlyCount").textContent = `${rows.length} 条仅赛果`;
  el("resultOnlyBody").innerHTML = rows.length ? rows.map(row => {
    const a = row.actual;
    const actualLines = [`胜平负 ${a.result}`, `让球 ${a.handicapResult}`, `比分 ${a.score}`, `进球 ${a.totalGoals}`, `半全场 ${a.halfFull}`];
    return `<tr>
      <td class="date-cell">${row.kickoffDate}<br>${escapeHtml(row.matchNumber)}</td>
      <td class="game-cell"><strong>${escapeHtml(row.home)} vs ${escapeHtml(row.away)}</strong><span>${escapeHtml(row.league)} · 让球 ${row.handicap > 0 ? "+" : ""}${row.handicap}</span></td>
      <td><div class="outcome-lines"><span class="result-only-note">未生成赛前预测</span><span>${escapeHtml(row.note)}</span></div></td>
      <td><div class="outcome-lines">${actualLines.map(x => `<span>${escapeHtml(x)}</span>`).join("")}</div></td>
      <td><span class="result-only-badge">不计入命中率</span></td>
    </tr>`;
  }).join("") : `<tr><td colspan="5" class="empty-state">当前没有需要补录展示的官方赛果。</td></tr>`;
}

function renderLearning(learning) {
  el("marketWeight").textContent = percent(learning.marketWeight);
  el("goalScale").textContent = `${Number(learning.goalScale || 1).toFixed(3)}×`;
  const bias = Number(learning.homeBias || 0);
  el("homeBias").textContent = `${bias >= 0 ? "+" : ""}${bias.toFixed(3)}`;
  el("scorePriorMultiplier").textContent = `${Number(learning.scorePriorMultiplier || 1).toFixed(3)}×`;
  el("tacticalSamples").textContent = `${Number(learning.tacticalSamples || 0)} 队场`;
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
