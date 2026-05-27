// matcher.js
// Для кожної комбінації з JSON будує токени і шукає чи останні 2/3/4 токенів
// дають збіг з якимось паттерном.

const Matcher = (() => {

  /**
   * Знаходить всі збіги для поточних свічок.
   *
   * @param closedCandles - масив закритих свічок (НЕ включає поточну формовану)
   * @param patternsJson - розпарсений JSON з combinations[]
   * @returns масив об'єктів-матчів
   */
  function findMatches(closedCandles, patternsJson) {
    const config = patternsJson.metadata.feature_params;
    const combinations = patternsJson.combinations;

    // Будуємо повні token parts для всіх свічок
    const fullParts = Tokens.buildFullTokenParts(closedCandles, config);

    const n = closedCandles.length;
    if (n < 4) return [];

    // Беремо останні 4 свічки — їх fullParts
    const lastIndices = [n - 4, n - 3, n - 2, n - 1];
    const last4FullParts = lastIndices.map(i => fullParts[i]);

    const matches = [];

    for (const combo of combinations) {
      const flags = combo.feature_flags;
      const patterns = combo.patterns;
      if (!patterns || Object.keys(patterns).length === 0) continue;

      // Витягуємо токени для цієї комбінації для останніх 4 свічок
      const tokens = last4FullParts.map(fp => Tokens.extractToken(fp, flags));

      // Якщо хоч один токен null — пропускаємо (нема даних для цієї комбінації)
      if (tokens.some(t => t == null)) continue;

      // Пробуємо довжини 2, 3, 4
      for (const len of [2, 3, 4]) {
        const slice = tokens.slice(4 - len);  // останні len токенів
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

  /**
   * Зважений агрегат: більші вибірки важливіші.
   * weighted_wr = sum(wr * cases) / sum(cases)
   * weighted_score = sum(edge * cases)
   */
  function aggregate(matches) {
    const green = matches.filter(m => m.direction === "GREEN");
    const red = matches.filter(m => m.direction === "RED");

    const sumCasesGreen = green.reduce((s, m) => s + m.cases, 0);
    const sumCasesRed = red.reduce((s, m) => s + m.cases, 0);

    const wrGreen = sumCasesGreen > 0
      ? green.reduce((s, m) => s + m.win_rate * m.cases, 0) / sumCasesGreen : 0;
    const wrRed = sumCasesRed > 0
      ? red.reduce((s, m) => s + m.win_rate * m.cases, 0) / sumCasesRed : 0;

    const scoreGreen = green.reduce((s, m) => s + m.edge_vs_baseline * m.cases, 0);
    const scoreRed = red.reduce((s, m) => s + m.edge_vs_baseline * m.cases, 0);

    let recommendation = "NO_SIGNAL";
    let confidence = "low";

    if (matches.length === 0) {
      recommendation = "NO_SIGNAL";
    } else if (scoreGreen > scoreRed * 1.5 && green.length >= red.length) {
      recommendation = "GREEN";
      confidence = "high";
    } else if (scoreGreen > scoreRed) {
      recommendation = "GREEN";
      confidence = scoreGreen > scoreRed * 1.2 ? "medium" : "low";
    } else if (scoreRed > scoreGreen * 1.5 && red.length >= green.length) {
      recommendation = "RED";
      confidence = "high";
    } else if (scoreRed > scoreGreen) {
      recommendation = "RED";
      confidence = scoreRed > scoreGreen * 1.2 ? "medium" : "low";
    } else {
      recommendation = "NO_SIGNAL";
    }

    return {
      total_matches: matches.length,
      green_count: green.length,
      red_count: red.length,
      green_weighted_wr: wrGreen,
      red_weighted_wr: wrRed,
      green_sum_cases: sumCasesGreen,
      red_sum_cases: sumCasesRed,
      green_score: scoreGreen,
      red_score: scoreRed,
      recommendation,
      confidence,
    };
  }

  return {
    findMatches,
    aggregate,
  };
})();
