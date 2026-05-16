// journal-app.js

(function () {

  const ANALYSIS_SIZE = 1000;   // скільки свічок аналізувати
  const WARMUP_SIZE = 100;       // прогрівання EMA50/RSI/ATR
  // Загальна кількість свічок для завантаження = ANALYSIS_SIZE + WARMUP_SIZE = 1100
  // Binance ліміт 1000 за запит, тому потрібно 2 запити

  let backtestResults = null;
  let candlesSeries = null;
  let pnlSeries = null;
  let candlesChart = null;
  let pnlChart = null;
  let markersSeries = null;  // зберігаємо посилання для оновлення маркерів

  // ===== INIT =====

  document.addEventListener("DOMContentLoaded", async () => {
    document.getElementById("btn-refresh").addEventListener("click", () => {
      window.location.reload();
    });

    try {
      // Завантажуємо JSON-и
      setProgress("Завантаження файлів патернів...", 5);
      const wd = await Storage.loadPatterns(Storage.KEY_WEEKDAYS);
      const we = await Storage.loadPatterns(Storage.KEY_WEEKENDS);
      if (!wd || !we) {
        throw new Error("Файли патернів не завантажені. Перейдіть на головну сторінку і завантажте.");
      }
      const weekdaysJson = wd.data;
      const weekendsJson = we.data;

      // Тягнемо свічки з Binance (1100 штук = 2 запити)
      setProgress("Завантаження свічок з Binance...", 10);
      const totalNeeded = ANALYSIS_SIZE + WARMUP_SIZE;
      const candles = await fetchManyCandles(totalNeeded);

      // Відкидаємо поточну формовану
      const { closed } = Binance.splitClosedAndCurrent(candles);
      if (closed.length < totalNeeded * 0.9) {
        throw new Error(`Недостатньо закритих свічок: отримано ${closed.length}, потрібно ${totalNeeded}`);
      }

      // Беремо останні N для бектесту (з прогрівальною історією)
      const candlesForBacktest = closed.slice(-totalNeeded);

      // Завантажуємо кеш бектесту (якщо є)
      setProgress("Перевірка кешу бектесту...", 12);
      const cachedItem = await Storage.loadBacktest();
      const cachedResults = cachedItem ? cachedItem.data : null;
      if (cachedResults) {
        console.log("Знайдено кеш:", cachedResults.length, "записів від", cachedItem.saved_at);
      }

      // Інкрементальний бектест
      setProgress("Початок бектесту...", 15);
      const { results, fromCache, newlyComputed } = await Backtest.runIncremental(
        candlesForBacktest,
        WARMUP_SIZE,
        weekdaysJson,
        weekendsJson,
        cachedResults,
        (done, total, msg) => {
          const pct = 15 + Math.floor((done / total) * 70);
          setProgress(msg, pct);
        }
      );
      backtestResults = results;

      console.log(`Бектест завершено: з кешу ${fromCache}, нових ${newlyComputed}`);

      // Зберігаємо результати в кеш
      setProgress("Збереження кешу...", 87);
      await yieldToUI();
      try {
        await Storage.saveBacktest(results);
      } catch (e) {
        console.warn("Не вдалось зберегти кеш бектесту:", e);
      }

      // Рендер
      setProgress("Рендер графіків та таблиці...", 90);
      await yieldToUI();
      renderPeriodInfo(results);
      renderStats(results);
      renderCandlesChart(results);
      renderPnLChart(results);
      renderTable(results);

      setProgress("Готово", 100);
      hideProgress();

    } catch (err) {
      console.error(err);
      hideProgress();
      showError(err.message + "\n\n" + (err.stack || ""));
    }
  });

  // ===== ЗАВАНТАЖЕННЯ БАГАТО СВІЧОК =====

  async function fetchManyCandles(total) {
    // Binance API ліміт 1000 за запит
    const all = [];
    let endTime = Date.now();

    while (all.length < total) {
      const need = Math.min(1000, total - all.length);
      const chunk = await fetchKlinesWithEndTime(need, endTime);
      if (chunk.length === 0) break;
      all.unshift(...chunk);
      // Наступна порція — раніше за найранішу що отримали
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
      open_time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      close_time: k[6],
      time: new Date(k[0]),
    }));
  }

  // ===== РЕНДЕР =====

  function renderPeriodInfo(results) {
    if (results.length === 0) return;
    const first = results[0].candle.time;
    const last = results[results.length - 1].candle.time;
    document.getElementById("period-info").textContent =
      `${formatDateTime(first)} — ${formatDateTime(last)} UTC  (${results.length} свічок)`;
  }

  function renderStats(results) {
    const s = Backtest.computeStats(results);
    const grid = document.getElementById("stats-grid");
    grid.innerHTML = `
      <div class="stat-box" style="background:#f1f5f9">
        <div class="stat-value">${s.total}</div>
        <div class="stat-label">всього свічок</div>
      </div>
      <div class="stat-box" style="background:#dcfce7">
        <div class="stat-value text-green-700">${s.wins}</div>
        <div class="stat-label">виграшних (✅)</div>
      </div>
      <div class="stat-box" style="background:#fee2e2">
        <div class="stat-value text-red-700">${s.losses}</div>
        <div class="stat-label">програшних (❌)</div>
      </div>
      <div class="stat-box" style="background:#f1f5f9">
        <div class="stat-value text-gray-500">${s.no_prediction}</div>
        <div class="stat-label">без прогнозу</div>
      </div>
      <div class="stat-box" style="background:#eff6ff">
        <div class="stat-value text-blue-700">${s.accuracy.toFixed(1)}%</div>
        <div class="stat-label">точність (${s.predicted} прогнозів)</div>
      </div>
    `;
  }

  function renderCandlesChart(results) {
    const chartEl = document.getElementById("chart-candles");
    chartEl.innerHTML = "";

    candlesChart = LightweightCharts.createChart(chartEl, {
      width: chartEl.clientWidth,
      height: 380,
      layout: {
        background: { color: "#ffffff" },
        textColor: "#1e293b",
      },
      grid: {
        vertLines: { color: "#f1f5f9" },
        horzLines: { color: "#f1f5f9" },
      },
      rightPriceScale: { borderColor: "#cbd5e1" },
      timeScale: { borderColor: "#cbd5e1", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    candlesSeries = candlesChart.addCandlestickSeries({
      upColor: "#16a34a",
      downColor: "#dc2626",
      borderUpColor: "#16a34a",
      borderDownColor: "#dc2626",
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626",
    });

    // Дані: lightweight-charts хоче time в секундах UTC
    const data = results.map(r => ({
      time: Math.floor(r.candle.open_time / 1000),
      open: r.candle.open,
      high: r.candle.high,
      low: r.candle.low,
      close: r.candle.close,
    }));
    candlesSeries.setData(data);

    // Маркери прогнозів
    const markers = [];
    for (const r of results) {
      if (r.prediction === "GREEN") {
        markers.push({
          time: Math.floor(r.candle.open_time / 1000),
          position: "belowBar",
          color: "#16a34a",
          shape: "arrowUp",
          text: "G",
        });
      } else if (r.prediction === "RED") {
        markers.push({
          time: Math.floor(r.candle.open_time / 1000),
          position: "aboveBar",
          color: "#dc2626",
          shape: "arrowDown",
          text: "R",
        });
      }
    }
    candlesSeries.setMarkers(markers);
    markersSeries = candlesSeries;

    // Клік на свічку
    candlesChart.subscribeClick(param => {
      if (!param.time) return;
      const r = results.find(x => Math.floor(x.candle.open_time / 1000) === param.time);
      if (r) renderDetails(r);
    });

    // Підлаштування під розмір вікна
    window.addEventListener("resize", () => {
      candlesChart.applyOptions({ width: chartEl.clientWidth });
    });
  }

  function renderPnLChart(results) {
    const chartEl = document.getElementById("chart-pnl");
    chartEl.innerHTML = "";

    pnlChart = LightweightCharts.createChart(chartEl, {
      width: chartEl.clientWidth,
      height: 220,
      layout: {
        background: { color: "#ffffff" },
        textColor: "#1e293b",
      },
      grid: {
        vertLines: { color: "#f1f5f9" },
        horzLines: { color: "#f1f5f9" },
      },
      rightPriceScale: { borderColor: "#cbd5e1" },
      timeScale: { borderColor: "#cbd5e1", timeVisible: true, secondsVisible: false },
    });

    pnlSeries = pnlChart.addLineSeries({
      color: "#2563eb",
      lineWidth: 2,
    });
    const points = Backtest.computePnL(results);
    pnlSeries.setData(points);

    // Лінія нуля (baseline)
    const zeroSeries = pnlChart.addLineSeries({
      color: "#94a3b8",
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    if (points.length > 0) {
      zeroSeries.setData([
        { time: points[0].time, value: 0 },
        { time: points[points.length - 1].time, value: 0 },
      ]);
    }

    // Синхронізуємо часову вісь з графіком свічок
    candlesChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (range) pnlChart.timeScale().setVisibleLogicalRange(range);
    });
    pnlChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (range) candlesChart.timeScale().setVisibleLogicalRange(range);
    });

    window.addEventListener("resize", () => {
      pnlChart.applyOptions({ width: chartEl.clientWidth });
    });
  }

  function renderTable(results) {
    document.getElementById("table-count").textContent = `${results.length} рядків (найновіші зверху)`;
    const tbody = document.getElementById("journal-tbody");
    const rows = [];
    // Йдемо в зворотному порядку — найновіші зверху
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i];
      const displayNum = i + 1;  // номер в історичному порядку (1 = найстаріший)
      const colorClass = r.color === "g" ? "green-tag" : (r.color === "r" ? "red-tag" : "gray-tag");
      const colorTxt = r.color;

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

      rows.push(`<tr data-idx="${i}">
        <td>${displayNum}</td>
        <td>${formatDateTime(r.candle.time)}</td>
        <td>${r.candle.open.toFixed(2)}</td>
        <td>${r.candle.high.toFixed(2)}</td>
        <td>${r.candle.low.toFixed(2)}</td>
        <td>${r.candle.close.toFixed(2)}</td>
        <td class="${colorClass}">${colorTxt}</td>
        <td>${predBadge}</td>
        <td>${factBadge}</td>
        <td>${resultIcon}</td>
        <td>${r.total_matches}</td>
      </tr>`);
    }
    tbody.innerHTML = rows.join("");

    tbody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      const idx = parseInt(tr.dataset.idx, 10);
      if (!isNaN(idx) && results[idx]) {
        renderDetails(results[idx]);
        // Скрол до деталей
        document.getElementById("details-section").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
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
      const rows = sorted.map(m => {
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
        <thead><tr>
          <th>combo</th><th>pattern</th><th>len</th><th>dir</th><th>WR</th><th>edge</th><th>cases</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
    }

    content.innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <div>
          <p class="text-xs text-gray-500">Час</p>
          <p class="font-semibold">${formatDateTime(r.candle.time)} UTC</p>
        </div>
        <div>
          <p class="text-xs text-gray-500">День</p>
          <p class="font-semibold">${r.is_weekend ? "вихідний" : "будній"}</p>
        </div>
        <div>
          <p class="text-xs text-gray-500">Прогноз</p>
          <p>${predBadge}</p>
        </div>
        <div>
          <p class="text-xs text-gray-500">Фактичний колір</p>
          <p>${factBadge}</p>
        </div>
        <div>
          <p class="text-xs text-gray-500">Результат</p>
          <p>${resultBadge}</p>
        </div>
        <div>
          <p class="text-xs text-gray-500">Зважений WR</p>
          <p class="text-sm">G: ${r.green_weighted_wr.toFixed(2)}% (n=${r.green_count}) / R: ${r.red_weighted_wr.toFixed(2)}% (n=${r.red_count})</p>
        </div>
        <div>
          <p class="text-xs text-gray-500">Score (edge × cases)</p>
          <p class="text-sm">G: ${r.green_score.toFixed(0)} / R: ${r.red_score.toFixed(0)}</p>
        </div>
        <div>
          <p class="text-xs text-gray-500">OHLC</p>
          <p class="text-sm mono">o:${r.candle.open.toFixed(2)} c:${r.candle.close.toFixed(2)}<br>h:${r.candle.high.toFixed(2)} l:${r.candle.low.toFixed(2)}</p>
        </div>
      </div>
      <h3 class="font-semibold mb-2">Знайдені патерни (${r.matches.length})</h3>
      ${matchesHtml}
    `;
  }

  // ===== ХЕЛПЕРИ =====

  function setProgress(text, pct) {
    document.getElementById("progress").classList.remove("hidden");
    document.getElementById("progress-text").textContent = text;
    document.getElementById("progress-fill").style.width = pct + "%";
    document.getElementById("progress-sub").textContent = pct + "%";
  }

  function hideProgress() {
    document.getElementById("progress").classList.add("hidden");
  }

  function showError(msg) {
    const el = document.getElementById("error-log");
    document.getElementById("error-text").textContent = msg;
    el.classList.remove("hidden");
  }

  function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function formatDateTime(d) {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

})();
