// timeformat.js
// Відображення часу в київському часовому поясі.
// УВАГА: вся внутрішня логіка (день тижня для патернів, тощо) залишається UTC.
// Цей модуль тільки для UI.

const TimeFormat = (() => {

  const TZ = "Europe/Kyiv";
  const MONTHS_SHORT = ["січ", "лют", "бер", "квіт", "трав", "черв",
                        "лип", "серп", "вер", "жовт", "лист", "груд"];

  // Кеш формато́рів — створювати їх кожний раз дорого
  const fmtDateParts = new Intl.DateTimeFormat("uk-UA", {
    timeZone: TZ,
    year: "numeric", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });

  function parts(date) {
    // Повертає {year, month, day, hour, minute, second} в київському часі
    const p = fmtDateParts.formatToParts(date);
    const o = {};
    for (const x of p) {
      if (x.type !== "literal") o[x.type] = parseInt(x.value, 10);
    }
    return o;
  }

  /**
   * Основний формат: "17 трав 14:30"
   */
  function formatDateTime(date) {
    const p = parts(date);
    return `${p.day} ${MONTHS_SHORT[p.month - 1]} ${pad(p.hour)}:${pad(p.minute)}`;
  }

  /**
   * Тільки час: "14:30:25"
   */
  function formatTime(date, withSeconds = false) {
    const p = parts(date);
    return withSeconds
      ? `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
      : `${pad(p.hour)}:${pad(p.minute)}`;
  }

  /**
   * Тільки дата без року: "17 трав"
   */
  function formatDate(date) {
    const p = parts(date);
    return `${p.day} ${MONTHS_SHORT[p.month - 1]}`;
  }

  /**
   * "5 секунд тому" / "2 хвилини тому"
   */
  function timeAgo(date) {
    const diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 5) return "щойно";
    if (diff < 60) return `${diff} с тому`;
    if (diff < 3600) return `${Math.floor(diff / 60)} хв тому`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} год тому`;
    return `${Math.floor(diff / 86400)} дн тому`;
  }

  /**
   * Початок поточної київської доби в UTC-мс
   */
  function startOfKyivToday() {
    const now = new Date();
    const p = parts(now);
    // Конструюємо ISO рядок як ніби це київський час, потім перетворюємо назад на UTC
    return kyivWallTimeToUTC(p.year, p.month, p.day, 0, 0, 0);
  }

  /**
   * Початок поточного київського тижня (понеділок 00:00)
   */
  function startOfKyivWeek() {
    const now = new Date();
    const p = parts(now);
    // Київський день тижня: створюємо Date з тими частинами і дізнаємось weekday
    // Простіше — обчислити через формато́р
    const wdFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, weekday: "short",
    });
    const wdStr = wdFmt.format(now);
    const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const wd = wdMap[wdStr];
    const daysToMonday = wd === 0 ? 6 : wd - 1;
    // Поточний київський день 00:00
    let target = kyivWallTimeToUTC(p.year, p.month, p.day, 0, 0, 0);
    // Віднімаємо daysToMonday днів
    target -= daysToMonday * 24 * 3600 * 1000;
    return target;
  }

  /**
   * Допоміжне: маємо "wall clock" час у Києві (year-month-day-hour-min-sec),
   * повертаємо UTC мс. Працює з літнім часом коректно.
   */
  function kyivWallTimeToUTC(year, month, day, hour, minute, second) {
    // Створюємо як UTC, потім підбираємо зсув
    // Спершу: припустимо UTC = (заданий час) — це буде помилкою на величину зсуву (+2 чи +3)
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
    // Подивимось як цей utc-час виглядає в Києві
    const guessed = parts(new Date(utcGuess));
    // Знайдемо різницю в годинах
    const guessHour = guessed.hour;
    // Зсув київський мінус UTC = (guessHour - hour) (з урахуванням переходу через дату)
    // Простіше: різниця між UTC і wall — це шукана корекція
    let diffHours = guessHour - hour;
    if (diffHours > 12) diffHours -= 24;
    if (diffHours < -12) diffHours += 24;
    // Київ випереджає UTC (+2 або +3), тому wall > UTC, тобто guessHour буде більший
    // utc = utcGuess - diffHours*3600*1000
    return utcGuess - diffHours * 3600 * 1000;
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  return {
    formatDateTime,
    formatTime,
    formatDate,
    timeAgo,
    startOfKyivToday,
    startOfKyivWeek,
    TZ,
  };
})();
