// tokens.js
// Будуємо "повний" токен з усіма 9 ознаками для кожної свічки,
// а потім для конкретної комбінації беремо підмножину цих ознак.
// Порядок ознак ЗАФІКСОВАНИЙ і має повністю співпадати з Python-кодом.

const Tokens = (() => {

  // Порядок ознак ідентичний Python build_tokens
  const FEATURE_ORDER = [
    "USE_COLOR",
    "USE_VOLUME",
    "USE_DELTA_VOLUME",
    "USE_BODY_SIZE",
    "USE_ATR",
    "USE_WICKS",
    "USE_EMA_TREND",
    "USE_RSI",
    "USE_CLOSE_POSITION",
  ];

  /**
   * Будує "fullParts" — масив масивів, де fullParts[i] це частини токена для свічки i.
   * Кожна частина може бути null якщо не вдалось обчислити (нема історії).
   *
   * @param candles - масив свічок з полями {time, open, high, low, close, volume}
   * @param config - feature_params з JSON: VOLUME_LOOKBACK, BODY_LOOKBACK, ATR_PERIOD, EMA_PERIOD, RSI_PERIOD
   * @returns масив parts по 9 елементів на свічку
   */
  function buildFullTokenParts(candles, config) {
    const n = candles.length;
    const opens = candles.map(c => c.open);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const bodies = closes.map((c, i) => Math.abs(c - opens[i]));
    const colors = closes.map((c, i) => Indicators.candleColor(opens[i], c));

    const atr = Indicators.computeATR(highs, lows, closes, config.ATR_PERIOD);
    const ema = Indicators.computeEMA(closes, config.EMA_PERIOD);
    const rsi = Indicators.computeRSI(closes, config.RSI_PERIOD);

    const volAvg = Indicators.rollingMean(volumes, config.VOLUME_LOOKBACK);
    const bodyAvg = Indicators.rollingMean(bodies, config.BODY_LOOKBACK);

    // atrAvg — rolling mean ATR за ATR_PERIOD (Python використовує ATR_PERIOD як lookback)
    const atrAvg = new Array(n).fill(null);
    for (let i = config.ATR_PERIOD * 2; i < n; i++) {
      let sum = 0, cnt = 0;
      for (let j = i - config.ATR_PERIOD; j < i; j++) {
        if (atr[j] != null) { sum += atr[j]; cnt++; }
      }
      if (cnt === config.ATR_PERIOD) atrAvg[i] = sum / config.ATR_PERIOD;
    }

    const allParts = [];
    for (let i = 0; i < n; i++) {
      const parts = new Array(9).fill(null);

      // 0: COLOR
      parts[0] = colors[i];

      // 1: VOLUME
      if (volAvg[i] != null) {
        parts[1] = volumes[i] > volAvg[i] ? "H" : "L";
      }

      // 2: DELTA_VOLUME
      if (i >= 1) {
        parts[2] = volumes[i] > volumes[i - 1] ? "U" : "D";
      }

      // 3: BODY_SIZE
      if (bodyAvg[i] != null) {
        parts[3] = bodies[i] > bodyAvg[i] ? "B" : "S";
      }

      // 4: ATR
      if (atr[i] != null && atrAvg[i] != null) {
        parts[4] = atr[i] > atrAvg[i] ? "h" : "l";
      }

      // 5: WICKS
      parts[5] = Indicators.wickType(opens[i], highs[i], lows[i], closes[i], bodies[i]);

      // 6: EMA_TREND
      if (ema[i] != null) {
        parts[6] = closes[i] > ema[i] ? "+" : "-";
      }

      // 7: RSI
      parts[7] = Indicators.rsiZone(rsi[i]);

      // 8: CLOSE_POSITION
      parts[8] = Indicators.closePositionInRange(opens[i], highs[i], lows[i], closes[i]);

      allParts.push(parts);
    }

    return allParts;
  }

  /**
   * Витягує токен для конкретної комбінації ознак.
   * @param fullParts - parts для однієї свічки (масив 9 елементів)
   * @param featureFlags - об'єкт {USE_COLOR: bool, ...} з конфігу комбінації
   * @returns рядок-токен або null якщо якась потрібна ознака None
   */
  function extractToken(fullParts, featureFlags) {
    const tokenParts = [];
    for (let i = 0; i < FEATURE_ORDER.length; i++) {
      if (featureFlags[FEATURE_ORDER[i]]) {
        if (fullParts[i] == null) return null;
        tokenParts.push(fullParts[i]);
      }
    }
    if (tokenParts.length === 0) return null;
    return tokenParts.join("_");
  }

  /**
   * Будує "візуальний" повний токен (з усіма 9 ознаками) для відображення в UI.
   * Якщо ознака недоступна — пише ".".
   */
  function buildDisplayToken(fullParts) {
    return fullParts.map(p => p == null ? "." : p).join("_");
  }

  return {
    FEATURE_ORDER,
    buildFullTokenParts,
    extractToken,
    buildDisplayToken,
  };
})();
