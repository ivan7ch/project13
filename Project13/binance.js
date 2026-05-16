// binance.js
// Публічний Binance API, CORS дозволений, ключі не потрібні.

const Binance = (() => {

  const BASE = "https://api.binance.com/api/v3/klines";

  /**
   * Тягне останні N свічок BTCUSDT 15m.
   * Повертає масив об'єктів з відповідними полями.
   *
   * Binance kline format:
   * [
   *   openTime, open, high, low, close, volume,
   *   closeTime, quoteVolume, trades, takerBuyVol, takerBuyQuote, ignore
   * ]
   */
  async function fetchKlines(limit = 100, symbol = "BTCUSDT", interval = "15m") {
    const url = `${BASE}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Binance API error: ${resp.status} ${resp.statusText}`);
    }
    const raw = await resp.json();
    return raw.map(k => ({
      open_time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      close_time: k[6],
      time: new Date(k[0]),  // Date з open_time для зручності
    }));
  }

  /**
   * Розділяє свічки на закриті і поточну (формовану).
   * Binance повертає в кінці поточну свічку. Її close_time > Date.now().
   */
  function splitClosedAndCurrent(candles) {
    const now = Date.now();
    const closed = [];
    let current = null;

    for (const c of candles) {
      if (c.close_time < now) {
        closed.push(c);
      } else {
        current = c;
      }
    }
    return { closed, current };
  }

  return {
    fetchKlines,
    splitClosedAndCurrent,
  };
})();
