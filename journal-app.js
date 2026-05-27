// journal-app.js
// Завантажує тиждень+прогрів. Спочатку бектестить лише сьогодні (UTC) і одразу рендерить.
// Потім у фоні добектестує решту тижня. Селектор періоду фільтрує те що показуємо.

(function () {

  const DAYS_BACK = 7;
  const WARMUP_SIZE = 100;
  const CANDLES_PER_DAY = 96;
  const TOTAL_CANDLES = DAYS_BACK * CANDLES_PER_DAY + WARMUP_SIZE;

  let allCandles = null;
  let analysisStart = 0;
  let allResults = [];
  let computedRange = { from: -1, to: -1 };
  let weekdaysJson = null;
  let weekendsJson = null;
  let currentPeriod = "today";
  let candlesChart = null;
  let pnlChart = null;
  let fullPartsCache = null;

  document.addEventListener("DOMContentLoaded", async () => {
    document.getElementById("btn-refresh").addEventListener("click", () => window.location.reload());
    attachPeriodHandlers();

    try {
      setProgress("Завантаження файлів патернів...", 5);
      const wd = await Storage.loadPatterns(Storage.KEY_WEEKDAYS);
      const we = await Storage.loadPatterns(Storage.KEY_WEEKENDS);
      if (!wd || !we) throw new Error("Файли патернів не завантажені. Перейдіть на головну і завантажте.");
      weekdaysJson = wd.data;
      weekendsJson = we.data;

      setProgress("Завантаження свічок з Binance...", 10);
      const candles = await fetchManyCandles(TOTAL_CANDLES);
      const { closed } = Binance.splitClosedAndCurrent(candles);
      if (closed.length < TOTAL_CANDLES * 0.9) {
        throw new Error(`Недостатньо закритих свічок: ${closed.length}/${TOTAL_CANDLES}`);
      }
      allCandles = closed.slice(-TOTAL_CANDLES);
      analysisStart = WARMUP_SIZE;
      allResults = new Array(allCandles.length).fill(null);

      // Прекомпʼют fullParts один раз
      const config = weekdaysJson.metadata.feature_params;
      fullPartsCache = Tokens.buildFullTokenParts(allCandles, config);

      // 1) Швидкий бектест: тільки свічки сьогоднішнього UTC-дня
      setProgress("Швидкий бектест за сьогодні (UTC)...", 30);
      const todayRange = getRangeByPeriod("today");
      await backtestRange(todayRange.fromIdx, todayRange.toIdx, (done, total) => {
        const pct = 30 + Math.floor((done / Math.max(total, 1)) * 30);
        setProgress(`Бектест за сьогодні: ${done}/${total}`, pct);
      });
      computedRange = { from: todayRange.fromIdx, to: todayRange.toIdx };

      setProgress("Рендер...", 65);
      await yieldToUI();
      renderForPeriod("today");
      setProgress("Готово", 100);
      hideProgress();

      // 2) У фоні — добектестуємо решту тижня
      runBackgroundFullBacktest();

    } catch (err) {
      console.error(err);
      hideProgress();
      showError(err.message + "\n\n" + (err.stack || ""));
    }
  });

  function attachPeriodHandlers() {
    document.querySelectorAll(".period-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const period = btn.dataset.period;
        currentPeriod = period;
        updatePeriodButtonStyles();

        const range = getRangeByPeriod(period);
        if (range.fromIdx < computedRange.from || range.toIdx > computedRange.to) {
          setProgress(`Бектест за ${periodLabel(period)}...`, 0);
          await backtestRange(range.fromIdx, range.toIdx, (done, total) => {
            const pct = Math.floor((done / Math.max(total, 1)) * 100);
            setProgress(`Обчислюю прогнози: ${done}/${total}`, pct);
          });
          computedRange.from = Math.min(computedRange.from === -1 ? range.fromIdx : computedRange.from, range.fromIdx);
          computedRange.to = Math.max(computedRange.to, range.toIdx);
          hideProgress();
        }
        renderForPeriod(period);
      });
    });
  }

  function updatePeriodButtonStyles() {
    document.querySelectorAll(".period-btn").forEach(btn => {
      const active = btn.dataset.period === currentPeriod;
      if (active) {
        btn.className = "period-btn bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium";
      } else {
        btn.className = "period-btn bg-gray-200 hover:bg-gray-300 px-4 py-2 rounded text-sm";
      }
    });
  }

  function periodLabel(p) {
    return p === "today" ? "сьогодні (Київ)" :
           p === "this_week" ? "цей тиждень (Київ)" :
           p === "24h" ? "24 години" :
           p === "7d" ? "7 днів" : p;
  }

  function getRangeByPeriod(period) {
    let fromTime;
    if (period === "today") {
      // Початок поточної КИЇВСЬКОЇ доби (а не UTC!) — щоб відповідати "моєму дню"
      fromTime = new Date(TimeFormat.startOfKyivToday());
    } else if (period === "this_week") {
      // Початок поточного КИЇВСЬКОГО тижня (понеділок 00:00 за Києвом)
      fromTime = new Date(TimeFormat.startOfKyivWeek());
    } else if (period === "24h") {
      fromTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    } else if (period === "7d") {
      fromTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    } else {
      fromTime = new Date(0);
    }

    let fromIdx = allCandles.length;
    for (let i = analysisStart; i < allCandles.length; i++) {
      if (allCandles[i].time >= fromTime) { fromIdx = i; break; }
    }
    return { fromIdx, toIdx: allCandles.length - 1 };
  }

  async function backtestRange(fromIdx, toIdx, onProgress) {
    let computed = 0;
    const total = Math.max(0, toIdx - fromIdx + 1);
    const CHUNK = 30;

    for (let i = fromIdx; i <= toIdx; i++) {
      if (allResults[i] !== null) { computed++; continue; }
      if (i < 4) { computed++; continue; }

      const last4 = [fullPartsCache[i - 4], fullPartsCache[i - 3], fullPartsCache[i - 2], fullPartsCache[i - 1]];
      const allHave = last4.every(p => p.every(x => x != null));
      const candle = allCandles[i];
      const wd = candle.time.getUTCDay();
      const isWeekend = (wd === 0 || wd === 6);
      const patternsJson = isWeekend ? weekendsJson : weekdaysJson;
      const fact = Indicators.candleColor(candle.open, candle.close);

      let matches = [];
      let agg = { recommendation: "NO_SIGNAL", total_matches: 0 };
      if (allHave && patternsJson) {
        matches = findMatchesForCandle(last4, patternsJson);
        agg = Matcher.aggregate(matches);
      }

      let result = "none";
      if (agg.recommendation === "GREEN") result = fact === "g" ? "win" : "loss";
      else if (agg.recommendation === "RED") result = fact === "r" ? "win" : "loss";

      allResults[i] = {
        index: i, candle, color: fact,
        prediction: agg.recommendation, confidence: agg.confidence || null,
        green_score: agg.green_score || 0, red_score: agg.red_score || 0,
        green_count: agg.green_count || 0, red_count: agg.red_count || 0,
        green_weighted_wr: agg.green_weighted_wr || 0, red_weighted_wr: agg.red_weighted_wr || 0,
        total_matches: agg.total_matches, is_weekend: isWeekend,
        result, matches,
      };

      computed++;
      if (computed % CHUNK === 0) {
        if (onProgress) onProgress(computed, total);
        await yieldToUI();
      }
    }
    if (onProgress) onProgress(computed, total);
  }

  function findMatchesForCandle(last4FullParts, patternsJson) {
    const matches = [];
    for (const combo of patternsJson.combinations) {
      const flags = combo.feature_flags;
      const patterns = combo.patterns;
      if (!patterns || Object.keys(patterns).length === 0) continue;
      const tokens = last4FullParts.map(fp => Tokens.extractToken(fp, flags));
      if (tokens.some(t => t == null)) continue;
      for (const len of [2, 3, 4]) {
        const slice = tokens.slice(4 - len);
        const key = slice.join("|");
        if (patterns[key]) {
          const p = patterns[key];
          matches.push({
            combo: combo.label, pattern_key: key, pattern_length: len,
            direction: p.direction, win_rate: p.win_rate, cases: p.cases,
            edge_vs_baseline: p.edge_vs_baseline,
            train_wr: p.train_wr, test_wr: p.test_wr,
            train_cases: p.train_cases, test_cases: p.test_cases,
            stability: p.stability,
          });
        }
      }
    }
    return matches;
  }

  async function runBackgroundFullBacktest() {
    const bgStatus = document.getElementById("bg-status");
    bgStatus.textContent = "🔄 фоновий бектест тижня...";

    const total = allCandles.length - analysisStart;
    let done = 0;
    const CHUNK = 30;

    for (let i = analysisStart; i < allCandles.length; i++) {
      if (allResults[i] !== null) { done++; continue; }
      if (i < 4) { done++; continue; }

      const last4 = [fullPartsCache[i - 4], fullPartsCache[i - 3], fullPartsCache[i - 2], fullPartsCache[i - 1]];
      const allHave = last4.every(p => p.every(x => x != null));
      const candle = allCandles[i];
      const wd = candle.time.getUTCDay();
      const isWeekend = (wd === 0 || wd === 6);
      const patternsJson = isWeekend ? weekendsJson : weekdaysJson;
      const fact = Indicators.candleColor(candle.open, candle.close);

      let matches = [];
      let agg = { recommendation: "NO_SIGNAL", total_matches: 0 };
      if (allHave && patternsJson) {
        matches = findMatchesForCandle(last4, patternsJson);
        agg = Matcher.aggregate(matches);
      }

      let result = "none";
      if (agg.recommendation === "GREEN") result = fact === "g" ? "win" : "loss";
      else if (agg.recommendation === "RED") result = fact === "r" ? "win" : "loss";

      allResults[i] = {
        index: i, candle, color: fact,
        prediction: agg.recommendation, confidence: agg.confidence || null,
        green_score: agg.green_score || 0, red_score: agg.red_score || 0,
        green_count: agg.green_count || 0, red_count: agg.red_count || 0,
        green_weighted_wr: agg.green_weighted_wr || 0, red_weighted_wr: agg.red_weighted_wr || 0,
        total_matches: agg.total_matches, is_weekend: isWeekend,
        result, matches,
      };

      done++;
      if (done % CHUNK === 0) {
        bgStatus.textContent = `🔄 фоновий бектест: ${done}/${total}`;
        await yieldToUI();
      }
    }

    computedRange = { from: analysisStart, to: allCandles.length - 1 };
    bgStatus.textContent = "✅ повний бектест тижня готовий";
    setTimeout(() => { bgStatus.textContent = ""; }, 5000);
  }

  async function fetchManyCandles(total) {
    const all = [];
    let endTime = Date.now();
    while (all.length < total) {
      const need = Math.min(1000, total - all.length);
      const chunk = await fetchKlinesWithEndTime(need, endTime);
      if (chunk.length === 0) break;
      all.unshift(...chunk);
      endTime = chunk[0].open_time - 1;
      setProgress(`Завантажено ${all.length}/${total} свічок...`, 10);
      await yieldToUI();
    }
    return all;
  }

  async function fetchKlinesWithEndTime(limit, endTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=${limit}&endTime=${endTime}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Binance API error: ${resp.status}`);
    const raw = await resp.json();
    return raw.map(k => ({
      open_time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      close_time: k[6], time: new Date(k[0]),
    }));
  }

  function renderForPeriod(period) {
    const range = getRangeByPeriod(period);
    const filtered = [];
    for (let i = range.fromIdx; i <= range.toIdx; i++) {
      if (allResults[i] !== null) filtered.push(allResults[i]);
    }
    renderPeriodInfo(filtered, period);
    renderStats(filtered);
    renderCandlesChart(filtered);
    renderPnLChart(filtered);
    renderTable(filtered);
  }

  function renderPeriodInfo(results, period) {
    if (results.length === 0) {
      document.getElementById("period-info").textContent = "Немає даних за обраний період";
      return;
    }
    const first = results[0].candle.time;
    const last = results[results.length - 1].candle.time;
    document.getElementById("period-info").textContent =
      `${periodLabel(period)} | ${formatDateTime(first)} — ${formatDateTime(last)} | ${results.length} свічок`;
  }

  function renderStats(results) {
    const wins = results.filter(r => r.result === "win").length;
    const losses = results.filter(r => r.result === "loss").length;
    const noPred = results.filter(r => r.result === "none").length;
    const predicted = wins + losses;
    const accuracy = predicted > 0 ? (wins / predicted * 100) : 0;

    document.getElementById("stats-grid").innerHTML = `
      <div class="stat-box" style="background:#f1f5f9">
        <div class="stat-value">${results.length}</div>
        <div class="stat-label">всього свічок</div>
      </div>
      <div class="stat-box" style="background:#dcfce7">
        <div class="stat-value text-green-700">${wins}</div>
        <div class="stat-label">виграшних (✅)</div>
      </div>
      <div class="stat-box" style="background:#fee2e2">
        <div class="stat-value text-red-700">${losses}</div>
        <div class="stat-label">програшних (❌)</div>
      </div>
      <div class="stat-box" style="background:#f1f5f9">
        <div class="stat-value text-gray-500">${noPred}</div>
        <div class="stat-label">без прогнозу</div>
      </div>
      <div class="stat-box" style="background:#eff6ff">
        <div class="stat-value text-blue-700">${accuracy.toFixed(1)}%</div>
        <div class="stat-label">точність (${predicted} прогнозів)</div>
      </div>
    `;
  }

  function renderCandlesChart(results) {
    const chartEl = document.getElementById("chart-candles");
    chartEl.innerHTML = "";
    if (results.length === 0) {
      chartEl.innerHTML = '<p class="text-gray-500 p-4">Немає даних</p>';
      return;
    }

    candlesChart = LightweightCharts.createChart(chartEl, {
      width: chartEl.clientWidth, height: 380,
      layout: { background: { color: "#ffffff" }, textColor: "#1e293b" },
      grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
      rightPriceScale: { borderColor: "#cbd5e1" },
      timeScale: { borderColor: "#cbd5e1", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    const candlesSeries = candlesChart.addCandlestickSeries({
      upColor: "#16a34a", downColor: "#dc2626",
      borderUpColor: "#16a34a", borderDownColor: "#dc2626",
      wickUpColor: "#16a34a", wickDownColor: "#dc2626",
    });

    candlesSeries.setData(results.map(r => ({
      time: Math.floor(r.candle.open_time / 1000),
      open: r.candle.open, high: r.candle.high,
      low: r.candle.low, close: r.candle.close,
    })));

    const markers = [];
    for (const r of results) {
      if (r.prediction === "GREEN") {
        markers.push({ time: Math.floor(r.candle.open_time / 1000),
          position: "belowBar", color: "#16a34a", shape: "arrowUp", text: "G" });
      } else if (r.prediction === "RED") {
        markers.push({ time: Math.floor(r.candle.open_time / 1000),
          position: "aboveBar", color: "#dc2626", shape: "arrowDown", text: "R" });
      }
    }
    candlesSeries.setMarkers(markers);

    candlesChart.subscribeClick(param => {
      if (!param.time) return;
      const r = results.find(x => Math.floor(x.candle.open_time / 1000) === param.time);
      if (r) renderDetails(r);
    });

    window.addEventListener("resize", () => {
      if (candlesChart) candlesChart.applyOptions({ width: chartEl.clientWidth });
    });
  }

  function renderPnLChart(results) {
    const chartEl = document.getElementById("chart-pnl");
    chartEl.innerHTML = "";
    if (results.length === 0) {
      chartEl.innerHTML = '<p class="text-gray-500 p-4">Немає даних</p>';
      return;
    }

    pnlChart = LightweightCharts.createChart(chartEl, {
      width: chartEl.clientWidth, height: 220,
      layout: { background: { color: "#ffffff" }, textColor: "#1e293b" },
      grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
      rightPriceScale: { borderColor: "#cbd5e1" },
      timeScale: { borderColor: "#cbd5e1", timeVisible: true, secondsVisible: false },
    });

    const pnlSeries = pnlChart.addLineSeries({ color: "#2563eb", lineWidth: 2 });
    const points = [];
    let cumulative = 0;
    for (const r of results) {
      if (r.result === "win") cumulative += 1;
      else if (r.result === "loss") cumulative -= 1;
      points.push({ time: Math.floor(r.candle.open_time / 1000), value: cumulative });
    }
    pnlSeries.setData(points);

    const zeroSeries = pnlChart.addLineSeries({
      color: "#94a3b8", lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      lastValueVisible: false, priceLineVisible: false,
    });
    if (points.length > 0) {
      zeroSeries.setData([
        { time: points[0].time, value: 0 },
        { time: points[points.length - 1].time, value: 0 },
      ]);
    }

    if (candlesChart) {
      candlesChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (range && pnlChart) pnlChart.timeScale().setVisibleLogicalRange(range);
      });
      pnlChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (range && candlesChart) candlesChart.timeScale().setVisibleLogicalRange(range);
      });
    }

    window.addEventListener("resize", () => {
      if (pnlChart) pnlChart.applyOptions({ width: chartEl.clientWidth });
    });
  }

  function renderTable(results) {
    document.getElementById("table-count").textContent = `${results.length} рядків (найновіші зверху)`;
    const tbody = document.getElementById("journal-tbody");
    const rows = [];
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i];
      const colorClass = r.color === "g" ? "green-tag" : (r.color === "r" ? "red-tag" : "gray-tag");

      let predBadge = "—";
      if (r.prediction === "GREEN") predBadge = '<span class="badge badge-green">GREEN</span>';
      else if (r.prediction === "RED") predBadge = '<span class="badge badge-red">RED</span>';

      let factBadge = "—";
      if (r.color === "g") factBadge = '<span class="badge badge-green">GREEN</span>';
      else if (r.color === "r") factBadge = '<span class="badge badge-red">RED</span>';
      else factBadge = '<span class="badge badge-gray">doji</span>';

      let resultIcon = "—";
      if (r.result === "win") resultIcon = '<span class="green-tag">✅</span>';
      else if (r.result === "loss") resultIcon = '<span class="red-tag">❌</span>';

      rows.push(`<tr data-time="${r.candle.open_time}">
        <td>${i + 1}</td>
        <td>${formatDateTime(r.candle.time)}</td>
        <td>${r.candle.open.toFixed(2)}</td>
        <td>${r.candle.high.toFixed(2)}</td>
        <td>${r.candle.low.toFixed(2)}</td>
        <td>${r.candle.close.toFixed(2)}</td>
        <td class="${colorClass}">${r.color}</td>
        <td>${predBadge}</td>
        <td>${factBadge}</td>
        <td>${resultIcon}</td>
        <td>${r.total_matches}</td>
      </tr>`);
    }
    tbody.innerHTML = rows.join("");

    tbody.onclick = (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      const ot = parseInt(tr.dataset.time, 10);
      const r = allResults.find(x => x && x.candle.open_time === ot);
      if (r) {
        renderDetails(r);
        document.getElementById("details-section").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
  }

  function renderDetails(r) {
    const section = document.getElementById("details-section");
    section.classList.remove("hidden");
    const content = document.getElementById("details-content");

    let predBadge = '<span class="badge badge-gray">немає сигналу</span>';
    if (r.prediction === "GREEN") predBadge = `<span class="badge badge-green">🟢 GREEN (${r.confidence || ""})</span>`;
    else if (r.prediction === "RED") predBadge = `<span class="badge badge-red">🔴 RED (${r.confidence || ""})</span>`;

    let factBadge = '<span class="badge badge-gray">doji</span>';
    if (r.color === "g") factBadge = '<span class="badge badge-green">GREEN</span>';
    else if (r.color === "r") factBadge = '<span class="badge badge-red">RED</span>';

    let resultBadge = '<span class="badge badge-gray">без прогнозу</span>';
    if (r.result === "win") resultBadge = '<span class="badge badge-green">✅ виграш</span>';
    else if (r.result === "loss") resultBadge = '<span class="badge badge-red">❌ програш</span>';

    let matchesHtml = '<p class="text-sm text-gray-500">Збігів не знайдено</p>';
    if (r.matches.length > 0) {
      const sorted = [...r.matches].sort((a, b) => b.cases - a.cases);
      const mRows = sorted.map(m => {
        const dirClass = m.direction === "GREEN" ? "badge-green" : "badge-red";
        return `<tr>
          <td><span class="label-mono">${m.combo}</span></td>
          <td class="text-xs">${m.pattern_key.replace(/\|/g, " ▸ ")}</td>
          <td>${m.pattern_length}</td>
          <td><span class="badge ${dirClass}">${m.direction}</span></td>
          <td>${m.win_rate.toFixed(2)}%</td>
          <td>${m.edge_vs_baseline >= 0 ? "+" : ""}${m.edge_vs_baseline.toFixed(2)}%</td>
          <td>${m.cases}</td>
        </tr>`;
      }).join("");
      matchesHtml = `<div class="results-wrap"><table class="mono">
        <thead><tr><th>combo</th><th>pattern</th><th>len</th><th>dir</th><th>WR</th><th>edge</th><th>cases</th></tr></thead>
        <tbody>${mRows}</tbody></table></div>`;
    }

    content.innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <div><p class="text-xs text-gray-500">Час (Київ)</p><p class="font-semibold">${formatDateTime(r.candle.time)}</p></div>
        <div><p class="text-xs text-gray-500">День</p><p class="font-semibold">${r.is_weekend ? "вихідний" : "будній"}</p></div>
        <div><p class="text-xs text-gray-500">Прогноз</p><p>${predBadge}</p></div>
        <div><p class="text-xs text-gray-500">Фактичний колір</p><p>${factBadge}</p></div>
        <div><p class="text-xs text-gray-500">Результат</p><p>${resultBadge}</p></div>
        <div><p class="text-xs text-gray-500">Зважений WR</p><p class="text-sm">G: ${r.green_weighted_wr.toFixed(2)}% (n=${r.green_count}) / R: ${r.red_weighted_wr.toFixed(2)}% (n=${r.red_count})</p></div>
        <div><p class="text-xs text-gray-500">Score</p><p class="text-sm">G: ${r.green_score.toFixed(0)} / R: ${r.red_score.toFixed(0)}</p></div>
        <div><p class="text-xs text-gray-500">OHLC</p><p class="text-sm mono">o:${r.candle.open.toFixed(2)} c:${r.candle.close.toFixed(2)}<br>h:${r.candle.high.toFixed(2)} l:${r.candle.low.toFixed(2)}</p></div>
      </div>
      <h3 class="font-semibold mb-2">Знайдені патерни (${r.matches.length})</h3>
      ${matchesHtml}
    `;
  }

  function setProgress(text, pct) {
    document.getElementById("progress").classList.remove("hidden");
    document.getElementById("progress-text").textContent = text;
    document.getElementById("progress-fill").style.width = pct + "%";
    document.getElementById("progress-sub").textContent = pct + "%";
  }
  function hideProgress() { document.getElementById("progress").classList.add("hidden"); }
  function showError(msg) {
    const el = document.getElementById("error-log");
    document.getElementById("error-text").textContent = msg;
    el.classList.remove("hidden");
  }
  function yieldToUI() { return new Promise(resolve => setTimeout(resolve, 0)); }
  // Делегуємо формат у TimeFormat (Київ)
  function formatDateTime(d) { return TimeFormat.formatDateTime(d); }

})();
