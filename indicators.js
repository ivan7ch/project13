// indicators.js
// Обчислення всіх технічних індикаторів. Логіка точно повторює Python-код.

const Indicators = (() => {

  function candleColor(o, c) {
    if (c > o) return "g";
    if (c < o) return "r";
    return "d";
  }

  function computeATR(highs, lows, closes, period) {
    const n = highs.length;
    const tr = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (i === 0) {
        tr[i] = highs[i] - lows[i];
      } else {
        tr[i] = Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1])
        );
      }
    }
    const atr = new Array(n).fill(null);
    for (let i = period; i < n; i++) {
      let sum = 0;
      for (let j = i - period; j < i; j++) sum += tr[j];
      atr[i] = sum / period;
    }
    return atr;
  }

  function computeEMA(values, period) {
    const n = values.length;
    const ema = new Array(n).fill(null);
    if (n < period) return ema;
    let sma = 0;
    for (let i = 0; i < period; i++) sma += values[i];
    sma /= period;
    ema[period - 1] = sma;
    const k = 2 / (period + 1);
    for (let i = period; i < n; i++) {
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
    return ema;
  }

  function computeRSI(closes, period) {
    const n = closes.length;
    const rsi = new Array(n).fill(null);
    if (n < period + 1) return rsi;

    const gains = new Array(n).fill(0);
    const losses = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const diff = closes[i] - closes[i - 1];
      gains[i] = Math.max(diff, 0);
      losses[i] = Math.max(-diff, 0);
    }

    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      avgGain += gains[i];
      avgLoss += losses[i];
    }
    avgGain /= period;
    avgLoss /= period;

    if (avgLoss === 0) rsi[period] = 100.0;
    else {
      const rs = avgGain / avgLoss;
      rsi[period] = 100 - (100 / (1 + rs));
    }

    for (let i = period + 1; i < n; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      if (avgLoss === 0) rsi[i] = 100.0;
      else {
        const rs = avgGain / avgLoss;
        rsi[i] = 100 - (100 / (1 + rs));
      }
    }
    return rsi;
  }

  function rsiZone(val) {
    if (val == null) return null;
    if (val < 30) return "O";
    if (val > 70) return "B";
    return "N";
  }

  function closePositionInRange(o, h, l, c) {
    if (h === l) return "M";
    const pos = (c - l) / (h - l);
    if (pos > 0.66) return "T";
    if (pos < 0.33) return "b";
    return "M";
  }

  function wickType(o, h, l, c, bodySize) {
    const upper = h - Math.max(o, c);
    const lower = Math.min(o, c) - l;
    const bs = bodySize === 0 ? 1e-9 : bodySize;
    const upperBig = (upper / bs) > 0.5;
    const lowerBig = (lower / bs) > 0.5;
    if (upperBig && lowerBig) return "B";
    if (upperBig) return "U";
    if (lowerBig) return "L";
    return "N";
  }

  function rollingMean(values, lookback, fromIdx) {
    // Повертає масив де arr[i] = середнє за останні lookback значень ДО i (i не включно)
    const n = values.length;
    const out = new Array(n).fill(null);
    for (let i = lookback; i < n; i++) {
      let sum = 0;
      for (let j = i - lookback; j < i; j++) sum += values[j];
      out[i] = sum / lookback;
    }
    return out;
  }

  return {
    candleColor,
    computeATR,
    computeEMA,
    computeRSI,
    rsiZone,
    closePositionInRange,
    wickType,
    rollingMean,
  };
})();
