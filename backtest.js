// backtest.js
// Для кожної свічки в історії обчислюємо прогноз так само як на головній сторінці.
// Розрахунок розбитий на чанки щоб не блокувати UI.

const Backtest = (() => {

  /**
   * Робить бектест по всім свічкам.
   *
   * @param allCandles - масив всіх свічок (з прогрівальною історією на початку)
   * @param warmupSize - скільки свічок на початку відкинути (для прогрівання EMA50 etc.)
   * @param weekdaysJson - JSON патернів для буднів
   * @param weekendsJson - JSON патернів для вихідних
   * @param onProgress - callback (done, total) для прогрес-бара
   * @returns масив об'єктів-результатів по кожній свічці
   */
  async function run(allCandles, warmupSize, weekdaysJson, weekendsJson, onProgress) {
    const n = allCandles.length;
    if (n <= warmupSize + 5) {
      throw new Error("Недостатньо свічок для бектесту");
    }

    // Конфіги однакові у weekdays і weekends (точно мають збігатися)
    const config = weekdaysJson.metadata.feature_params;

    // Прекомп'ютимо full token parts ОДИН раз для всіх свічок
    onProgress(0, n, "Будую токени для всіх свічок...");
    await yieldToUI();
    const fullParts = Tokens.buildFullTokenParts(allCandles, config);

    const results = [];
    const CHUNK = 50;

    // Йдемо по кожній свічці починаючи з warmupSize.
    // Для кожної свічки i:
    //   беремо fullParts[i-4..i-1] (4 свічки ДО i — це наш патерн)
    //   прогноз = findMatches на основі останніх 4 закритих
    //   factual = колір свічки i
    //   результат = виграш якщо direction == колір, програш якщо ні, none якщо немає прогнозу

    for (let i = warmupSize; i < n; i++) {
      if ((i - warmupSize) % CHUNK === 0) {
        onProgress(i - warmupSize, n - warmupSize, `Обчислюю прогнози: ${i - warmupSize}/${n - warmupSize}`);
        await yieldToUI();
      }

      // Чотири попередні свічки — використовуємо їх токени для пошуку патерну
      // (НЕ включаючи поточну i — її ми прогнозуємо)
      const last4Parts = [
        fullParts[i - 4],
        fullParts[i - 3],
        fullParts[i - 2],
        fullParts[i - 1],
      ];

      // Якщо хоч одна свічка без всіх ознак — патерн неможливий
      const allHaveAllFeatures = last4Parts.every(p => p.every(x => x != null));

      // Визначаємо який JSON використовувати за свічкою i (день тижня)
      const candleTime = allCandles[i].time;
      const wd = candleTime.getUTCDay();
      const isWeekend = (wd === 0 || wd === 6);
      const patternsJson = isWeekend ? weekendsJson : weekdaysJson;

      const fact = Indicators.candleColor(allCandles[i].open, allCandles[i].close);

      let matches = [];
      let agg = { recommendation: "NO_SIGNAL", total_matches: 0 };

      if (allHaveAllFeatures && patternsJson) {
        matches = findMatchesFast(last4Parts, patternsJson);
        agg = Matcher.aggregate(matches);
      }

      // Визначаємо результат
      let result = "none";  // не було прогнозу
      if (agg.recommendation === "GREEN") {
        if (fact === "g") result = "win";
        else if (fact === "r") result = "loss";
        else result = "loss";  // доджі вважаємо програшем
      } else if (agg.recommendation === "RED") {
        if (fact === "r") result = "win";
        else if (fact === "g") result = "loss";
        else result = "loss";
      }

      results.push({
        index: i,
        candle: allCandles[i],
        color: fact,
        prediction: agg.recommendation,
        confidence: agg.confidence || null,
        green_score: agg.green_score || 0,
        red_score: agg.red_score || 0,
        green_count: agg.green_count || 0,
        red_count: agg.red_count || 0,
        green_weighted_wr: agg.green_weighted_wr || 0,
        red_weighted_wr: agg.red_weighted_wr || 0,
        total_matches: agg.total_matches,
        is_weekend: isWeekend,
        result: result,
        matches: matches,  // повний список патернів — для деталей при кліку
      });
    }

    onProgress(n - warmupSize, n - warmupSize, "Готово");
    await yieldToUI();
    return results;
  }

  /**
   * Швидкий пошук матчів: уже маємо fullParts чотирьох свічок,
   * не треба перебудовувати з нуля.
   */
  function findMatchesFast(last4FullParts, patternsJson) {
    const matches = [];
    const combinations = patternsJson.combinations;

    for (const combo of combinations) {
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
            combo: combo.label,
            pattern_key: key,
            pattern_length: len,
            direction: p.direction,
            win_rate: p.win_rate,
            cases: p.cases,
            edge_vs_baseline: p.edge_vs_baseline,
            train_wr: p.train_wr,
            test_wr: p.test_wr,
            train_cases: p.train_cases,
            test_cases: p.test_cases,
            stability: p.stability,
          });
        }
      }
    }
    return matches;
  }

  function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  /**
   * Будує дані для PnL кривої: накопичувальний (wins - losses).
   */
  function computePnL(results) {
    const points = [];
    let cumulative = 0;
    for (const r of results) {
      if (r.result === "win") cumulative += 1;
      else if (r.result === "loss") cumulative -= 1;
      // none не змінює
      points.push({
        time: Math.floor(r.candle.open_time / 1000),  // секунди для lightweight-charts
        value: cumulative,
      });
    }
    return points;
  }

  /**
   * Загальна статистика.
   */
  function computeStats(results) {
    const total = results.length;
    const wins = results.filter(r => r.result === "win").length;
    const losses = results.filter(r => r.result === "loss").length;
    const noPred = results.filter(r => r.result === "none").length;
    const predicted = wins + losses;
    const accuracy = predicted > 0 ? (wins / predicted * 100) : 0;
    return {
      total,
      wins,
      losses,
      no_prediction: noPred,
      predicted,
      accuracy,
      net: wins - losses,
    };
  }

  /**
   * Інкрементальний бектест: якщо вже є кеш, перераховуємо тільки нові свічки.
   * Кеш зберігає масив results (як з run()) + open_time останньої свічки.
   *
   * @param allCandles - повний набір свічок з прогрівальною історією
   * @param warmupSize
   * @param weekdaysJson, weekendsJson
   * @param cachedResults - попередні results або null
   * @param onProgress - callback
   * @returns {results, fromCache: number, newlyComputed: number}
   */
  async function runIncremental(allCandles, warmupSize, weekdaysJson, weekendsJson, cachedResults, onProgress) {
    const n = allCandles.length;
    const config = weekdaysJson.metadata.feature_params;

    // Прекомп'ютимо повні токени для всіх свічок (це швидко, ~100мс на 1100 свічок)
    onProgress(0, n, "Будую токени для всіх свічок...");
    await yieldToUI();
    const fullParts = Tokens.buildFullTokenParts(allCandles, config);

    // Створимо мапу open_time → індекс кешованого результату
    const cacheMap = new Map();
    if (cachedResults && Array.isArray(cachedResults)) {
      for (const r of cachedResults) {
        cacheMap.set(r.candle.open_time, r);
      }
    }

    const results = [];
    let fromCache = 0;
    let newlyComputed = 0;
    const CHUNK = 50;

    for (let i = warmupSize; i < n; i++) {
      const candle = allCandles[i];
      const openTime = candle.open_time;

      // Перевіряємо чи маємо в кеші
      const cached = cacheMap.get(openTime);
      if (cached) {
        // Кеш має все, що нам треба, але об'єкт candle.time — це Date,
        // після JSON.stringify/parse він стає рядком, відновлюємо
        if (typeof cached.candle.time === "string") {
          cached.candle.time = new Date(cached.candle.time);
        }
        results.push(cached);
        fromCache++;
        continue;
      }

      // Обчислюємо нову точку
      newlyComputed++;
      if (newlyComputed % CHUNK === 1) {
        onProgress(i - warmupSize, n - warmupSize,
          `Обчислюю нові прогнози: ${newlyComputed} (з кешу: ${fromCache})`);
        await yieldToUI();
      }

      const last4Parts = [
        fullParts[i - 4],
        fullParts[i - 3],
        fullParts[i - 2],
        fullParts[i - 1],
      ];

      const allHaveAllFeatures = last4Parts.every(p => p.every(x => x != null));

      const wd = candle.time.getUTCDay();
      const isWeekend = (wd === 0 || wd === 6);
      const patternsJson = isWeekend ? weekendsJson : weekdaysJson;

      const fact = Indicators.candleColor(candle.open, candle.close);

      let matches = [];
      let agg = { recommendation: "NO_SIGNAL", total_matches: 0 };

      if (allHaveAllFeatures && patternsJson) {
        matches = findMatchesFast(last4Parts, patternsJson);
        agg = Matcher.aggregate(matches);
      }

      let result = "none";
      if (agg.recommendation === "GREEN") {
        result = fact === "g" ? "win" : "loss";
      } else if (agg.recommendation === "RED") {
        result = fact === "r" ? "win" : "loss";
      }

      results.push({
        index: i,
        candle: candle,
        color: fact,
        prediction: agg.recommendation,
        confidence: agg.confidence || null,
        green_score: agg.green_score || 0,
        red_score: agg.red_score || 0,
        green_count: agg.green_count || 0,
        red_count: agg.red_count || 0,
        green_weighted_wr: agg.green_weighted_wr || 0,
        red_weighted_wr: agg.red_weighted_wr || 0,
        total_matches: agg.total_matches,
        is_weekend: isWeekend,
        result: result,
        matches: matches,
      });
    }

    onProgress(n - warmupSize, n - warmupSize, "Готово");
    await yieldToUI();
    return { results, fromCache, newlyComputed };
  }

  return {
    run,
    runIncremental,
    computePnL,
    computeStats,
  };
})();
