// app.js — головна логіка зі змінною швидкістю оновлення і звуком

(function () {

  let weekdaysData = null;
  let weekendsData = null;
  let updateTimer = null;           // таймер на закриття 15м свічки
  let previewTimer = null;          // інтервал preview (2 або 30 сек)
  let countdownTimer = null;        // 1 сек таймер для countdown
  let lastCurrentCloseTime = 0;
  let lastSeenLastClosedTime = 0;   // open_time останньої закритої свічки (для виявлення нової)
  let previewMiniChart = null;
  let previewMiniSeries = null;

  const FAST_INTERVAL_MS = 2000;
  const SLOW_INTERVAL_MS = 30000;
  const MINI_CHART_BARS = 30;       // скільки свічок у міні-графіку

  document.addEventListener("DOMContentLoaded", async () => {
    UI.attachSortHandlers();
    attachButtonHandlers();
    setupVisibilityHandler();

    try {
      const wd = await Storage.loadPatterns(Storage.KEY_WEEKDAYS);
      const we = await Storage.loadPatterns(Storage.KEY_WEEKENDS);

      if (wd && we) {
        weekdaysData = wd.data;
        weekendsData = we.data;
        UI.renderFilesStatus(weekdaysData, weekendsData);
        UI.showUploadSection(false);
        UI.showMainSections(true);
        await runAnalysisCycle();
        schedulePreviewLoop();
        scheduleNextUpdate();
      } else {
        UI.setFilesStatus("Файли не знайдено — завантажте обидва нижче");
        UI.showUploadSection(true);
      }
    } catch (e) {
      console.error(e);
      UI.showError("Помилка ініціалізації: " + e.message);
      UI.showUploadSection(true);
    }
  });

  function attachButtonHandlers() {
    const fileWd = document.getElementById("file-weekdays");
    const fileWe = document.getElementById("file-weekends");
    const btnSave = document.getElementById("btn-save-files");
    const btnLoadFiles = document.getElementById("btn-load-files");
    const btnRefreshAgg = document.getElementById("btn-refresh-aggregate");

    let parsedWd = null, parsedWe = null;
    const check = () => btnSave.disabled = !(parsedWd && parsedWe);

    fileWd.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        parsedWd = JSON.parse(await file.text());
        document.getElementById("weekdays-info").textContent =
          `✅ ${parsedWd.combinations?.length || 0} комбінацій (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
      } catch {
        document.getElementById("weekdays-info").textContent = "❌ помилка парсингу JSON";
        parsedWd = null;
      }
      check();
    });

    fileWe.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        parsedWe = JSON.parse(await file.text());
        document.getElementById("weekends-info").textContent =
          `✅ ${parsedWe.combinations?.length || 0} комбінацій (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
      } catch {
        document.getElementById("weekends-info").textContent = "❌ помилка парсингу JSON";
        parsedWe = null;
      }
      check();
    });

    btnSave.addEventListener("click", async () => {
      btnSave.disabled = true;
      btnSave.textContent = "Зберігаю...";
      try {
        await Storage.savePatterns(Storage.KEY_WEEKDAYS, parsedWd);
        await Storage.savePatterns(Storage.KEY_WEEKENDS, parsedWe);
        weekdaysData = parsedWd; weekendsData = parsedWe;
        UI.renderFilesStatus(weekdaysData, weekendsData);
        UI.showUploadSection(false);
        UI.showMainSections(true);
        await runAnalysisCycle();
        schedulePreviewLoop();
        scheduleNextUpdate();
      } catch (err) {
        UI.showError("Не вдалось зберегти: " + err.message);
        btnSave.disabled = false;
        btnSave.textContent = "Зберегти і запустити аналіз";
      }
    });

    btnLoadFiles.addEventListener("click", () => UI.showUploadSection(true));

    btnRefreshAgg.addEventListener("click", async () => {
      const svg = btnRefreshAgg.querySelector("svg");
      svg.style.animation = "spin 0.6s linear";
      try { await runAnalysisCycle(); }
      finally { setTimeout(() => svg.style.animation = "", 600); }
    });
  }

  // Переключення темпу оновлення коли вкладка стає неактивною/активною
  function setupVisibilityHandler() {
    document.addEventListener("visibilitychange", () => {
      schedulePreviewLoop();  // перезапускаємо з потрібним інтервалом
    });
  }

  // ===== ОСНОВНИЙ ЦИКЛ (закриті свічки) =====

  async function runAnalysisCycle() {
    UI.hideError();
    try {
      const allCandles = await Binance.fetchKlines(100);
      const { closed, current } = Binance.splitClosedAndCurrent(allCandles);

      if (closed.length < 60) throw new Error(`Замало закритих свічок: ${closed.length}`);

      const lastClosed = closed[closed.length - 1];

      // Перевіряємо чи нова закрита свічка зявилась — і пілікаємо
      if (lastSeenLastClosedTime !== 0 && lastClosed.open_time > lastSeenLastClosedTime) {
        playCandleClosedBeep();
      }
      lastSeenLastClosedTime = lastClosed.open_time;

      const wd = lastClosed.time.getUTCDay();
      const isWeekend = (wd === 0 || wd === 6);
      const patternsJson = isWeekend ? weekendsData : weekdaysData;
      if (!patternsJson) throw new Error(`Немає JSON для ${isWeekend ? "вихідних" : "буднів"}`);

      const config = patternsJson.metadata.feature_params;
      const fullParts = Tokens.buildFullTokenParts(closed, config);

      UI.renderCandles(closed, current, fullParts);
      UI.renderCurrentInfo(lastClosed.time, isWeekend, null);

      const matches = Matcher.findMatches(closed, patternsJson);
      const agg = Matcher.aggregate(matches);

      UI.renderAggregate(agg, new Date());
      UI.renderResults(matches);
    } catch (err) {
      console.error(err);
      UI.showError("Помилка: " + err.message);
    }
  }

  // ===== АВТО-PREVIEW (швидкий або повільний таймер) =====

  function schedulePreviewLoop() {
    if (previewTimer) clearInterval(previewTimer);
    runPreview();  // запустити одразу
    const interval = document.hidden ? SLOW_INTERVAL_MS : FAST_INTERVAL_MS;
    previewTimer = setInterval(runPreview, interval);
    // Підпис на сторінці
    const rateInfo = document.getElementById("preview-rate-info");
    if (rateInfo) {
      rateInfo.textContent = document.hidden
        ? "Вкладка у фоні — оновлення кожні 30 сек."
        : "По формованій свічці. Оновлення кожні 2 сек.";
    }
  }

  async function runPreview() {
    try {
      const allCandles = await Binance.fetchKlines(100);
      const { closed, current } = Binance.splitClosedAndCurrent(allCandles);
      if (!current || closed.length < 60) return;

      if (current.close_time !== lastCurrentCloseTime) {
        lastCurrentCloseTime = current.close_time;
        startCountdown(current.close_time);
      }

      const forPreview = [...closed, current];
      const wd = current.time.getUTCDay();
      const isWeekend = (wd === 0 || wd === 6);
      const patternsJson = isWeekend ? weekendsData : weekdaysData;
      if (!patternsJson) return;

      const matches = Matcher.findMatches(forPreview, patternsJson);
      const agg = Matcher.aggregate(matches);

      renderPreviewBlock(agg, current);
      renderMiniChart(closed.slice(-(MINI_CHART_BARS - 1)), current);

      document.getElementById("preview-last-update").textContent =
        "оновлено " + TimeFormat.formatTime(new Date(), true);
    } catch (err) {
      console.warn("preview помилка:", err);
    }
  }

  function renderPreviewBlock(agg, currentCandle) {
    const el = document.getElementById("preview-prediction");
    const currentColor = Indicators.candleColor(currentCandle.open, currentCandle.close);
    const currentLabel = currentColor === "g" ? "🟢 GREEN" : (currentColor === "r" ? "🔴 RED" : "⬜ doji");

    if (agg.total_matches === 0) {
      el.innerHTML = `
        <p class="text-base mb-2" style="color: var(--text-dim);">Немає сигналу</p>
        <p class="text-xs" style="color: var(--text-dim);">Поточна формована: ${currentLabel} (close ${currentCandle.close.toFixed(2)})</p>
      `;
      return;
    }

    const isGreen = agg.recommendation === "GREEN";
    const isRed = agg.recommendation === "RED";
    const recColor = isGreen ? "var(--green)" : (isRed ? "var(--red)" : "var(--text-dim)");
    const recIcon = isGreen ? "🟢" : (isRed ? "🔴" : "⬜");
    const recText = isGreen ? "GREEN" : (isRed ? "RED" : "—");
    const wr = isGreen ? agg.green_weighted_wr : (isRed ? agg.red_weighted_wr : 0);
    const confClass = agg.confidence || "low";

    const totalMatches = agg.green_count + agg.red_count;
    const greenSharePct = totalMatches > 0 ? (agg.green_count / totalMatches * 100) : 0;
    const redSharePct = totalMatches > 0 ? (agg.red_count / totalMatches * 100) : 0;

    el.innerHTML = `
      <div style="margin-bottom: 18px;">
        <p class="text-xs mb-2" style="color: var(--text-dim);">Прогноз на наступну свічку</p>
        <div class="prediction-big" style="color: ${recColor};">
          <span class="prediction-emoji">${recIcon}</span>
          <span>${recText}</span>
          <span style="font-size: 28px; font-weight: 700; color: ${recColor}; opacity: 0.9;">${wr.toFixed(1)}%</span>
        </div>
        <div class="mt-3">
          <span class="confidence-pill ${confClass}">
            <span class="confidence-dot"></span>
            впевненість: ${confClass}
          </span>
        </div>
      </div>

      <div style="margin-top: auto;">
        <p class="text-xs mb-2" style="color: var(--text-dim);">Розподіл знайдених матчів:</p>
        <div class="match-bar mb-2">
          <div style="background: var(--green); width: ${greenSharePct}%;"></div>
          <div style="background: var(--red); width: ${redSharePct}%;"></div>
        </div>
        <div class="flex justify-between text-xs mono">
          <span style="color: var(--green);">🟢 ${agg.green_count} матчів (n=${agg.green_sum_cases})</span>
          <span style="color: var(--red);">🔴 ${agg.red_count} матчів (n=${agg.red_sum_cases})</span>
        </div>
        <p class="text-xs mt-3" style="color: var(--text-dim);">
          Зважений WR: <span style="color: var(--green);">G ${agg.green_weighted_wr.toFixed(1)}%</span>
          &nbsp;/&nbsp;
          <span style="color: var(--red);">R ${agg.red_weighted_wr.toFixed(1)}%</span>
        </p>
        <p class="text-xs mt-2" style="color: var(--text-dim);">
          Зараз формується: <span style="color: var(--text); font-weight: 600;">${currentLabel}</span>
          (close <span class="mono">${currentCandle.close.toFixed(2)}</span>)
        </p>
      </div>
    `;
  }

  function renderMiniChart(closedCandles, currentCandle) {
    const el = document.getElementById("preview-minichart");

    if (!previewMiniChart) {
      previewMiniChart = LightweightCharts.createChart(el, {
        width: el.clientWidth, height: el.clientHeight || 240,
        layout: { background: { color: "transparent" }, textColor: "transparent" },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        rightPriceScale: { visible: false },
        leftPriceScale: { visible: false },
        timeScale: { visible: false },
        crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        handleScroll: false,
        handleScale: false,
      });
      previewMiniSeries = previewMiniChart.addCandlestickSeries({
        upColor: "#00b87a", downColor: "#e53e51",
        borderUpColor: "#00b87a", borderDownColor: "#e53e51",
        wickUpColor: "#00b87a", wickDownColor: "#e53e51",
      });
      // Свічки втричі вужчі: barSpacing=2 (дефолт ~6)
      previewMiniChart.timeScale().applyOptions({ barSpacing: 2 });

      window.addEventListener("resize", () => {
        if (previewMiniChart) previewMiniChart.applyOptions({
          width: el.clientWidth, height: el.clientHeight || 240,
        });
      });
    }

    const all = [...closedCandles, currentCandle];
    const data = all.map(c => ({
      time: Math.floor(c.open_time / 1000),
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    previewMiniSeries.setData(data);
    previewMiniChart.timeScale().fitContent();
  }

  function startCountdown(closeTimeMs) {
    if (countdownTimer) clearInterval(countdownTimer);
    const el = document.getElementById("preview-countdown");

    function update() {
      const remain = closeTimeMs - Date.now();
      if (remain <= 0) {
        el.textContent = "закрита";
        el.style.color = "var(--green)";
        clearInterval(countdownTimer);
        return;
      }
      const m = Math.floor(remain / 60000);
      const s = Math.floor((remain % 60000) / 1000);
      el.textContent = `${m}:${String(s).padStart(2, "0")}`;
      if (remain > 5 * 60000) el.style.color = "var(--red)";
      else if (remain > 60000) el.style.color = "var(--amber)";
      else el.style.color = "var(--green)";
    }
    update();
    countdownTimer = setInterval(update, 1000);
  }

  // ===== ЗВУК "ПІ-ПІ" ЧЕРЕЗ WEB AUDIO API =====

  let audioCtx = null;

  function playCandleClosedBeep() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Два короткі "пі" з невеликою паузою
      const t0 = audioCtx.currentTime;
      playBeep(t0, 880, 0.12);          // перше пі (A5)
      playBeep(t0 + 0.18, 880, 0.12);   // друге пі
    } catch (e) {
      console.warn("Звук недоступний:", e);
    }
  }

  function playBeep(startTime, freq, duration) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(0.15, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  // ===== ТАЙМЕР ЗАКРИТТЯ 15М СВІЧКИ — :01 =====

  function scheduleNextUpdate() {
    if (updateTimer) clearTimeout(updateTimer);
    const next = computeNextUpdateTime();
    UI.renderCurrentInfo(null, null, next);
    const delay = next - Date.now();
    updateTimer = setTimeout(async () => {
      await runAnalysisCycle();
      scheduleNextUpdate();
    }, delay);
  }

  function computeNextUpdateTime() {
    const now = new Date();
    const minutes = now.getUTCMinutes();
    const nextQuarter = Math.floor(minutes / 15) * 15 + 15;
    return new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      now.getUTCHours(), nextQuarter, 1, 0
    )).getTime();
  }

})();
