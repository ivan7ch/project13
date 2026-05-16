// app.js
// Орекстрація всього: завантаження файлів, fetch свічок, аналіз, рендер, таймер.

(function () {

  let weekdaysData = null;
  let weekendsData = null;
  let updateTimer = null;

  // ===== INIT =====

  document.addEventListener("DOMContentLoaded", async () => {
    UI.attachSortHandlers();
    attachButtonHandlers();

    // Перевіряємо чи є файли в IndexedDB
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
        scheduleNextUpdate();
      } else {
        UI.setFilesStatus("Файли не знайдено в кеші — завантажте обидва нижче");
        UI.showUploadSection(true);
      }
    } catch (e) {
      console.error(e);
      UI.showError("Помилка ініціалізації: " + e.message);
      UI.showUploadSection(true);
    }
  });

  // ===== ОБРОБНИКИ КНОПОК =====

  function attachButtonHandlers() {
    const fileWd = document.getElementById("file-weekdays");
    const fileWe = document.getElementById("file-weekends");
    const btnSave = document.getElementById("btn-save-files");
    const btnRefresh = document.getElementById("btn-refresh");
    const btnLoadFiles = document.getElementById("btn-load-files");

    let parsedWd = null, parsedWe = null;

    function checkReady() {
      btnSave.disabled = !(parsedWd && parsedWe);
    }

    fileWd.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        parsedWd = JSON.parse(text);
        document.getElementById("weekdays-info").textContent =
          `✅ ${parsedWd.combinations?.length || 0} комбінацій (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
        checkReady();
      } catch (err) {
        document.getElementById("weekdays-info").textContent = "❌ помилка парсингу JSON";
        parsedWd = null;
        checkReady();
      }
    });

    fileWe.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        parsedWe = JSON.parse(text);
        document.getElementById("weekends-info").textContent =
          `✅ ${parsedWe.combinations?.length || 0} комбінацій (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
        checkReady();
      } catch (err) {
        document.getElementById("weekends-info").textContent = "❌ помилка парсингу JSON";
        parsedWe = null;
        checkReady();
      }
    });

    btnSave.addEventListener("click", async () => {
      btnSave.disabled = true;
      btnSave.textContent = "Зберігаю...";
      try {
        await Storage.savePatterns(Storage.KEY_WEEKDAYS, parsedWd);
        await Storage.savePatterns(Storage.KEY_WEEKENDS, parsedWe);
        weekdaysData = parsedWd;
        weekendsData = parsedWe;
        UI.renderFilesStatus(weekdaysData, weekendsData);
        UI.showUploadSection(false);
        UI.showMainSections(true);
        await runAnalysisCycle();
        scheduleNextUpdate();
      } catch (err) {
        UI.showError("Не вдалось зберегти: " + err.message);
        btnSave.disabled = false;
        btnSave.textContent = "Зберегти і запустити аналіз";
      }
    });

    btnRefresh.addEventListener("click", async () => {
      btnRefresh.disabled = true;
      btnRefresh.textContent = "Оновлення...";
      try {
        await runAnalysisCycle();
      } finally {
        btnRefresh.disabled = false;
        btnRefresh.textContent = "Оновити вручну";
      }
    });

    const btnPreview = document.getElementById("btn-preview");
    btnPreview.addEventListener("click", async () => {
      btnPreview.disabled = true;
      btnPreview.textContent = "Розрахунок...";
      try {
        await runPreview();
      } finally {
        btnPreview.disabled = false;
        btnPreview.textContent = "⚡ Прогноз по поточній свічці";
      }
    });

    btnLoadFiles.addEventListener("click", () => {
      UI.showUploadSection(true);
    });
  }

  // ===== PREVIEW (по формованій свічці) =====

  async function runPreview() {
    UI.hideError();
    try {
      // Тягнемо ті ж 100 свічок
      const allCandles = await Binance.fetchKlines(100);
      const { closed, current } = Binance.splitClosedAndCurrent(allCandles);

      if (!current) {
        UI.showError("Не знайдено формовану свічку — спробуйте ще раз через декілька секунд.");
        return;
      }
      if (closed.length < 60) {
        UI.showError(`Замало закритих свічок: ${closed.length}, треба хоча б 60`);
        return;
      }

      // Будуємо "віртуальний" масив для preview: всі закриті + поточна як остання
      // Поточна свічка тут вважається "як ніби закритою" для побудови токенів
      const candlesForPreview = [...closed, current];

      // Визначаємо день за часом ПОТОЧНОЇ свічки (бо прогноз для наступної,
      // яка скоріше за все в той самий день)
      const isWeekend = (current.time.getUTCDay() === 0 || current.time.getUTCDay() === 6);
      const patternsJson = isWeekend ? weekendsData : weekdaysData;
      if (!patternsJson) {
        throw new Error(`Немає JSON для ${isWeekend ? "вихідних" : "буднів"}`);
      }

      // Знаходимо матчі — як на головній, але остання свічка в патерні це current
      const matches = Matcher.findMatches(candlesForPreview, patternsJson);
      const agg = Matcher.aggregate(matches);

      // Рендеримо preview блок
      const previewSection = document.getElementById("preview-section");
      previewSection.classList.remove("hidden");

      renderPreviewAggregate(agg, current);
      renderPreviewResults(matches);
      startPreviewCountdown(current);
    } catch (err) {
      console.error(err);
      UI.showError("Помилка preview: " + err.message);
    }
  }

  function renderPreviewAggregate(agg, currentCandle) {
    const el = document.getElementById("preview-aggregate-content");

    const currentColor = Indicators.candleColor(currentCandle.open, currentCandle.close);
    const colorLabel = currentColor === "g" ? "🟢 GREEN" : (currentColor === "r" ? "🔴 RED" : "⬜ doji");

    let recBadge = "";
    if (agg.recommendation === "GREEN") {
      recBadge = `<span class="badge badge-green text-base px-3 py-1">🟢 GREEN — ${agg.confidence}</span>`;
    } else if (agg.recommendation === "RED") {
      recBadge = `<span class="badge badge-red text-base px-3 py-1">🔴 RED — ${agg.confidence}</span>`;
    } else {
      recBadge = `<span class="badge badge-gray text-base px-3 py-1">нейтрально / немає сигналу</span>`;
    }

    let metricsHtml = "";
    if (agg.total_matches > 0) {
      metricsHtml = `
        <div class="grid grid-cols-2 gap-3">
          <div class="p-3 rounded" style="background:#dcfce7">
            <p class="text-sm text-green-800 font-semibold">🟢 GREEN: ${agg.green_count} матчів</p>
            <p class="text-xs text-green-700">зваж. WR: <b>${agg.green_weighted_wr.toFixed(2)}%</b></p>
            <p class="text-xs text-green-700">сума cases: ${agg.green_sum_cases}</p>
            <p class="text-xs text-green-700">score: ${agg.green_score.toFixed(0)}</p>
          </div>
          <div class="p-3 rounded" style="background:#fee2e2">
            <p class="text-sm text-red-800 font-semibold">🔴 RED: ${agg.red_count} матчів</p>
            <p class="text-xs text-red-700">зваж. WR: <b>${agg.red_weighted_wr.toFixed(2)}%</b></p>
            <p class="text-xs text-red-700">сума cases: ${agg.red_sum_cases}</p>
            <p class="text-xs text-red-700">score: ${agg.red_score.toFixed(0)}</p>
          </div>
        </div>
      `;
    } else {
      metricsHtml = `<p class="text-gray-600 text-sm">Жоден патерн не співпав із поточною ситуацією.</p>`;
    }

    el.innerHTML = `
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <span class="text-sm text-gray-600">Прогноз для наступної свічки:</span>
        ${recBadge}
        <span class="text-xs text-gray-500">| формована свічка зараз: ${colorLabel} (o:${currentCandle.open.toFixed(2)} c:${currentCandle.close.toFixed(2)})</span>
      </div>
      ${metricsHtml}
    `;
  }

  function renderPreviewResults(matches) {
    const tbody = document.getElementById("preview-results-tbody");
    if (matches.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-gray-500 py-2">Немає збігів</td></tr>`;
      return;
    }
    const sorted = [...matches].sort((a, b) => b.cases - a.cases);
    tbody.innerHTML = sorted.map(m => {
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
  }

  // Зворотний відлік до закриття поточної свічки
  let previewCountdownTimer = null;

  function startPreviewCountdown(currentCandle) {
    if (previewCountdownTimer) clearInterval(previewCountdownTimer);

    const closeTime = currentCandle.close_time;  // ms timestamp коли свічка закриється

    function update() {
      const remainMs = closeTime - Date.now();
      const el = document.getElementById("preview-countdown");
      if (remainMs <= 0) {
        el.textContent = "закрита";
        el.classList.remove("text-amber-700");
        el.classList.add("text-green-700");
        clearInterval(previewCountdownTimer);
        return;
      }
      const minutes = Math.floor(remainMs / 60000);
      const seconds = Math.floor((remainMs % 60000) / 1000);
      el.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;

      // підсвічуємо червоним коли більше 5 хв — рано довіряти
      // помаранчевим коли 1-5 хв
      // зеленим коли менше 1 хв — дані близькі до фінальних
      el.classList.remove("text-red-700", "text-amber-700", "text-green-700");
      if (remainMs > 5 * 60000) el.classList.add("text-red-700");
      else if (remainMs > 60000) el.classList.add("text-amber-700");
      else el.classList.add("text-green-700");
    }

    update();
    previewCountdownTimer = setInterval(update, 1000);
  }

  // ===== ЦИКЛ АНАЛІЗУ =====

  async function runAnalysisCycle() {
    UI.hideError();
    try {
      // 1. Тягнемо 100 свічок з Binance
      const allCandles = await Binance.fetchKlines(100);

      // 2. Розділяємо на закриті і поточну
      const { closed, current } = Binance.splitClosedAndCurrent(allCandles);

      if (closed.length < 60) {
        throw new Error(`Замало закритих свічок: ${closed.length}, треба хоча б 60 для EMA50`);
      }

      // 3. Визначаємо день за часом останньої закритої свічки
      const lastClosed = closed[closed.length - 1];
      const weekday = lastClosed.time.getUTCDay();  // 0=нд, 1=пн, ... 6=сб
      // У Python weekday(): 0=пн ... 6=нд. Тут JS getUTCDay(): 0=нд, 6=сб.
      // weekend: субота(6) або неділя(0)
      const isWeekend = (weekday === 0 || weekday === 6);
      const patternsJson = isWeekend ? weekendsData : weekdaysData;

      if (!patternsJson) {
        throw new Error(`Немає JSON для ${isWeekend ? "вихідних" : "буднів"}`);
      }

      // 4. Для відображення свічок — будуємо full token parts
      const config = patternsJson.metadata.feature_params;
      const fullParts = Tokens.buildFullTokenParts(closed, config);

      UI.renderCandles(closed, current, fullParts);
      UI.renderCurrentInfo(lastClosed.time, isWeekend, null);

      // 5. Шукаємо збіги
      const matches = Matcher.findMatches(closed, patternsJson);
      const agg = Matcher.aggregate(matches);

      UI.renderAggregate(agg);
      UI.renderResults(matches);

    } catch (err) {
      console.error(err);
      UI.showError("Помилка циклу оновлення: " + err.message);
    }
  }

  // ===== ТАЙМЕР =====

  function scheduleNextUpdate() {
    if (updateTimer) clearTimeout(updateTimer);

    const nextTime = computeNextUpdateTime();
    const delay = nextTime - Date.now();

    UI.renderCurrentInfo(null, null, nextTime);
    document.getElementById("next-update").textContent = formatTime(new Date(nextTime)) + " UTC";

    updateTimer = setTimeout(async () => {
      await runAnalysisCycle();
      scheduleNextUpdate();
    }, delay);
  }

  function computeNextUpdateTime() {
    // Наступне закриття 15-хвилинки + 15 сек запасу.
    const now = new Date();
    const minutes = now.getUTCMinutes();
    const nextQuarter = Math.floor(minutes / 15) * 15 + 15;
    const next = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      nextQuarter,
      15,  // +15 секунд
      0
    ));
    return next.getTime();
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function formatTime(d) {
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

})();
