// storage.js
// Зберігання великих JSON у IndexedDB.
// localStorage обмежений ~5-10MB, тому для 18MB файлів використовуємо IndexedDB.

const Storage = (() => {

  const DB_NAME = "btc_patterns_db";
  const DB_VERSION = 1;
  const STORE = "files";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
    });
  }

  async function savePatterns(key, jsonData) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.put({
        id: key,
        data: jsonData,
        saved_at: new Date().toISOString(),
      });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function loadPatterns(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function hasPatterns(key) {
    const item = await loadPatterns(key);
    return item != null;
  }

  async function clearAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  return {
    savePatterns,
    loadPatterns,
    hasPatterns,
    clearAll,
    saveBacktest,
    loadBacktest,
    KEY_WEEKDAYS: "patterns_weekdays",
    KEY_WEEKENDS: "patterns_weekends",
    KEY_BACKTEST: "backtest_results",
  };

  async function saveBacktest(data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.put({
        id: "backtest_results",
        data: data,
        saved_at: new Date().toISOString(),
      });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function loadBacktest() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const req = store.get("backtest_results");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
})();
