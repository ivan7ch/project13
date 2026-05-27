// ui.js — рендеринг сторінки в крипто-стилі. Київський час через TimeFormat.

const UI = (() => {

  let currentMatches = [];
  let sortKey = "cases";
  let sortDir = "desc";

  function showError(msg) {
    const el = document.getElementById("error-log");
    document.getElementById("error-text").textContent = msg;
    el.classList.remove("hidden");
  }
  function hideError() { document.getElementById("error-log").classList.add("hidden"); }

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
    const wd = weekdaysMeta ? `будні: ${weekdaysMeta.combinations.length} комбінацій` : "будні: ❌";
    const we = weekendsMeta ? `вихідні: ${weekendsMeta.combinations.length} комбінацій` : "вихідні: ❌";
    setFilesStatus(`${wd} · ${we}`);
  }

  function renderCandles(closedCandles, currentCandle, fullParts) {
    const tbody = document.getElementById("candles-tbody");
    tbody.innerHTML = "";

    const n = closedCandles.length;
    const lastClosed = closedCandles.slice(Math.max(0, n - 4));
    const startIdx = n - lastClosed.length;

    lastClosed.forEach((c, idx) => {
      const realIdx = startIdx + idx;
      const color = Indicators.candleColor(c.open, c.close);
      const colorClass = color === "g" ? "green-tag" : (color === "r" ? "red-tag" : "");
      const displayToken = fullParts[realIdx] ? Tokens.buildDisplayToken(fullParts[realIdx]) : "—";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${TimeFormat.formatDateTime(c.time)}</td>
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
      tr.style.background = "rgba(255,152,0,0.08)";
      tr.innerHTML = `
        <td><b>${TimeFormat.formatDateTime(currentCandle.time)}</b> <span style="color: var(--amber); font-size: 11px;">(формується)</span></td>
        <td>${fmt(currentCandle.open)}</td>
        <td>${fmt(currentCandle.high)}</td>
        <td>${fmt(currentCandle.low)}</td>
        <td>${fmt(currentCandle.close)}</td>
        <td>${fmtVol(currentCandle.volume)}</td>
        <td class="${colorClass}">${color}</td>
        <td class="text-xs" style="color: var(--text-dim);">не враховується</td>
      `;
      tbody.appendChild(tr);
    }
  }

  function renderCurrentInfo(lastClosedTime, isWeekend, nextUpdateTime) {
    if (lastClosedTime) {
      const dayWord = isWeekend ? "вихідний (UTC)" : "будній (UTC)";
      document.getElementById("current-time").textContent =
        `Остання закрита: ${TimeFormat.formatDateTime(new Date(lastClosedTime))} — ${dayWord}`;
    }
    if (nextUpdateTime) {
      document.getElementById("next-update").textContent =
        TimeFormat.formatTime(new Date(nextUpdateTime), true);
    }
  }

  function renderAggregate(agg, updatedAt) {
    const el = document.getElementById("aggregate-content");

    if (agg.total_matches === 0) {
      el.innerHTML = `<p style="color: var(--text-dim);">Немає сигналу — поточна ситуація не відповідає жодному відомому патерну.</p>`;
    } else {
      const isGreen = agg.recommendation === "GREEN";
      const isRed = agg.recommendation === "RED";
      const recColor = isGreen ? "var(--green)" : (isRed ? "var(--red)" : "var(--text-dim)");
      const recIcon = isGreen ? "🟢" : (isRed ? "🔴" : "⬜");
      const recText = isGreen ? "GREEN" : (isRed ? "RED" : "нейтрально");
      const wr = isGreen ? agg.green_weighted_wr : (isRed ? agg.red_weighted_wr : 0);

      const totalMatches = agg.green_count + agg.red_count;
      const greenSharePct = totalMatches > 0 ? (agg.green_count / totalMatches * 100) : 0;
      const redSharePct = totalMatches > 0 ? (agg.red_count / totalMatches * 100) : 0;

      el.innerHTML = `
        <div class="mb-4">
          <p class="text-xs mb-2" style="color: var(--text-dim);">Рекомендація:</p>
          <div class="prediction-big" style="color: ${recColor};">
            <span class="prediction-emoji">${recIcon}</span>
            <span>${recText}</span>
            <span style="font-size: 28px; font-weight: 700; color: ${recColor}; opacity: 0.9;">${wr.toFixed(1)}%</span>
          </div>
          <div class="mt-3">
            <span class="confidence-pill ${agg.confidence}">
              <span class="confidence-dot"></span>
              впевненість: ${agg.confidence}
            </span>
          </div>
        </div>

        <div class="mb-4">
          <p class="text-xs mb-2" style="color: var(--text-dim);">Розподіл матчів:</p>
          <div class="match-bar mb-2">
            <div style="background: var(--green); width: ${greenSharePct}%;"></div>
            <div style="background: var(--red); width: ${redSharePct}%;"></div>
          </div>
          <div class="flex justify-between text-xs mono">
            <span style="color: var(--green);">🟢 ${agg.green_count} матчів (n=${agg.green_sum_cases})</span>
            <span style="color: var(--red);">🔴 ${agg.red_count} матчів (n=${agg.red_sum_cases})</span>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="stat-tile green">
            <div class="stat-tile-label">🟢 GREEN</div>
            <div class="stat-tile-value">${agg.green_weighted_wr.toFixed(2)}%</div>
            <p class="text-xs mt-1" style="color: var(--text-dim);">${agg.green_count} матчів · score ${agg.green_score.toFixed(0)}</p>
          </div>
          <div class="stat-tile red">
            <div class="stat-tile-label">🔴 RED</div>
            <div class="stat-tile-value">${agg.red_weighted_wr.toFixed(2)}%</div>
            <p class="text-xs mt-1" style="color: var(--text-dim);">${agg.red_count} матчів · score ${agg.red_score.toFixed(0)}</p>
          </div>
        </div>
      `;
    }
    if (updatedAt) {
      document.getElementById("aggregate-updated").textContent =
        `оновлено ${TimeFormat.formatTime(updatedAt, true)}`;
    }
  }

  function renderResults(matches) {
    currentMatches = matches;
    document.getElementById("results-count").textContent = `всього: ${matches.length}`;
    sortAndRender();
  }

  function sortAndRender() {
    const sorted = [...currentMatches].sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === "combo" || sortKey === "direction") {
        va = String(va); vb = String(vb);
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      if (sortKey === "pattern") {
        va = a.pattern_key; vb = b.pattern_key;
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
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
        if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
        else { sortKey = key; sortDir = "desc"; }
        sortAndRender();
      });
    });
  }

  function fmt(n) { return n.toFixed(2); }
  function fmtVol(n) { return n >= 1000 ? (n / 1000).toFixed(2) + "k" : n.toFixed(2); }

  return {
    showError, hideError,
    setFilesStatus, showUploadSection, showMainSections,
    renderFilesStatus,
    renderCandles, renderCurrentInfo,
    renderAggregate, renderResults,
    attachSortHandlers,
  };
})();
