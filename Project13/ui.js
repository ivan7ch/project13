// ui.js
// Все що пов'язано з рендером сторінки.

const UI = (() => {

  let currentMatches = [];
  let sortKey = "cases";
  let sortDir = "desc";

  function showError(msg) {
    const el = document.getElementById("error-log");
    document.getElementById("error-text").textContent = msg;
    el.classList.remove("hidden");
  }

  function hideError() {
    document.getElementById("error-log").classList.add("hidden");
  }

  function setFilesStatus(text) {
    document.getElementById("files-status").textContent = text;
  }

  function showUploadSection(show) {
    document.getElementById("upload-section").classList.toggle("hidden", !show);
  }

  function showMainSections(show) {
    ["current-section", "aggregate-section", "results-section"].forEach(id => {
      document.getElementById(id).classList.toggle("hidden", !show);
    });
  }

  function renderFilesStatus(weekdaysMeta, weekendsMeta) {
    const wd = weekdaysMeta ? `будні: ${weekdaysMeta.combinations.length} комбінацій, від ${weekdaysMeta.metadata.generated_at}` : "будні: ❌";
    const we = weekendsMeta ? `вихідні: ${weekendsMeta.combinations.length} комбінацій, від ${weekendsMeta.metadata.generated_at}` : "вихідні: ❌";
    setFilesStatus(`${wd} | ${we}`);
  }

  function renderCandles(closedCandles, currentCandle, fullParts) {
    const tbody = document.getElementById("candles-tbody");
    tbody.innerHTML = "";

    const n = closedCandles.length;
    // показуємо останні 4 закриті + поточну
    const lastClosed = closedCandles.slice(Math.max(0, n - 4));
    const startIdx = n - lastClosed.length;

    lastClosed.forEach((c, idx) => {
      const realIdx = startIdx + idx;
      const color = Indicators.candleColor(c.open, c.close);
      const colorClass = color === "g" ? "green-tag" : (color === "r" ? "red-tag" : "");
      const displayToken = fullParts[realIdx] ? Tokens.buildDisplayToken(fullParts[realIdx]) : "—";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${formatTime(c.time)}</td>
        <td>${fmt(c.open)}</td>
        <td>${fmt(c.high)}</td>
        <td>${fmt(c.low)}</td>
        <td>${fmt(c.close)}</td>
        <td>${fmtVol(c.volume)}</td>
        <td class="${colorClass}">${color}</td>
        <td class="text-xs">${displayToken}</td>
      `;
      tbody.appendChild(tr);
    });

    if (currentCandle) {
      const color = Indicators.candleColor(currentCandle.open, currentCandle.close);
      const colorClass = color === "g" ? "green-tag" : (color === "r" ? "red-tag" : "");
      const tr = document.createElement("tr");
      tr.style.background = "#fef3c7";
      tr.innerHTML = `
        <td><b>${formatTime(currentCandle.time)}</b> (формується)</td>
        <td>${fmt(currentCandle.open)}</td>
        <td>${fmt(currentCandle.high)}</td>
        <td>${fmt(currentCandle.low)}</td>
        <td>${fmt(currentCandle.close)}</td>
        <td>${fmtVol(currentCandle.volume)}</td>
        <td class="${colorClass}">${color}</td>
        <td class="text-xs text-gray-500">не враховується</td>
      `;
      tbody.appendChild(tr);
    }
  }

  function renderCurrentInfo(lastClosedTime, isWeekend, nextUpdateTime) {
    const dayWord = isWeekend ? "вихідний" : "будній";
    const dt = new Date(lastClosedTime);
    document.getElementById("current-time").textContent =
      `Остання закрита: ${formatDateTime(dt)} UTC — ${dayWord}`;

    if (nextUpdateTime) {
      const nu = new Date(nextUpdateTime);
      document.getElementById("next-update").textContent = formatTime(nu) + " UTC";
    }
  }

  function renderAggregate(agg) {
    const el = document.getElementById("aggregate-content");

    if (agg.total_matches === 0) {
      el.innerHTML = `<p class="text-gray-600">Немає сигналу — поточна ситуація не відповідає жодному відомому патерну.</p>`;
      return;
    }

    let recBadge = "";
    if (agg.recommendation === "GREEN") {
      recBadge = `<span class="badge badge-green text-base px-3 py-1">🟢 GREEN — ${agg.confidence}</span>`;
    } else if (agg.recommendation === "RED") {
      recBadge = `<span class="badge badge-red text-base px-3 py-1">🔴 RED — ${agg.confidence}</span>`;
    } else {
      recBadge = `<span class="badge badge-gray text-base px-3 py-1">нейтрально</span>`;
    }

    el.innerHTML = `
      <div class="mb-3">
        <span class="text-sm text-gray-600">Рекомендація:</span>
        ${recBadge}
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div class="p-3 rounded" style="background:#dcfce7">
          <p class="text-sm text-green-800 font-semibold">🟢 GREEN: ${agg.green_count} матчів</p>
          <p class="text-xs text-green-700">зважений WR: <b>${agg.green_weighted_wr.toFixed(2)}%</b></p>
          <p class="text-xs text-green-700">сума cases: ${agg.green_sum_cases}</p>
          <p class="text-xs text-green-700">score (Σ edge×cases): ${agg.green_score.toFixed(0)}</p>
        </div>
        <div class="p-3 rounded" style="background:#fee2e2">
          <p class="text-sm text-red-800 font-semibold">🔴 RED: ${agg.red_count} матчів</p>
          <p class="text-xs text-red-700">зважений WR: <b>${agg.red_weighted_wr.toFixed(2)}%</b></p>
          <p class="text-xs text-red-700">сума cases: ${agg.red_sum_cases}</p>
          <p class="text-xs text-red-700">score (Σ edge×cases): ${agg.red_score.toFixed(0)}</p>
        </div>
      </div>
    `;
  }

  function renderResults(matches) {
    currentMatches = matches;
    document.getElementById("results-count").textContent = `всього: ${matches.length}`;
    sortAndRender();
  }

  function sortAndRender() {
    const sorted = [...currentMatches].sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === "combo" || sortKey === "pattern" || sortKey === "direction") {
        va = String(va); vb = String(vb);
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      if (sortKey === "pattern") va = a.pattern_key, vb = b.pattern_key;
      return sortDir === "asc" ? va - vb : vb - va;
    });

    const tbody = document.getElementById("results-tbody");
    tbody.innerHTML = "";
    for (const m of sorted) {
      const dirClass = m.direction === "GREEN" ? "badge-green" : "badge-red";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="label-mono">${m.combo}</span></td>
        <td class="text-xs">${m.pattern_key.replace(/\|/g, " ▸ ")}</td>
        <td>${m.pattern_length}</td>
        <td><span class="badge ${dirClass}">${m.direction}</span></td>
        <td>${m.win_rate.toFixed(2)}%</td>
        <td>${m.edge_vs_baseline >= 0 ? "+" : ""}${m.edge_vs_baseline.toFixed(2)}%</td>
        <td>${m.cases}</td>
        <td>${m.train_cases}</td>
        <td>${m.train_wr.toFixed(2)}%</td>
        <td>${m.test_cases}</td>
        <td>${m.test_wr.toFixed(2)}%</td>
        <td>${m.stability >= 0 ? "+" : ""}${m.stability.toFixed(2)}%</td>
      `;
      tbody.appendChild(tr);
    }

    // Оновлюємо стрілки сортування
    document.querySelectorAll(".sortable").forEach(th => {
      const arrow = th.querySelector(".sort-arrow");
      arrow.classList.remove("active");
      arrow.textContent = "▾";
      if (th.dataset.sort === sortKey) {
        arrow.classList.add("active");
        arrow.textContent = sortDir === "asc" ? "▴" : "▾";
      }
    });
  }

  function attachSortHandlers() {
    document.querySelectorAll(".sortable").forEach(th => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (sortKey === key) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortKey = key;
          sortDir = "desc";
        }
        sortAndRender();
      });
    });
  }

  // ---- helpers ----
  function fmt(n) {
    return n.toFixed(2);
  }
  function fmtVol(n) {
    if (n >= 1000) return (n / 1000).toFixed(2) + "k";
    return n.toFixed(2);
  }
  function pad(n) {
    return String(n).padStart(2, "0");
  }
  function formatTime(d) {
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function formatDateTime(d) {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${formatTime(d)}`;
  }

  return {
    showError,
    hideError,
    setFilesStatus,
    showUploadSection,
    showMainSections,
    renderFilesStatus,
    renderCandles,
    renderCurrentInfo,
    renderAggregate,
    renderResults,
    attachSortHandlers,
  };
})();
