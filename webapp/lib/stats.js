/* Статистика журнала охоты (чистая функция по списку записей). Порт bot/services/stats.py. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory();
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.stats = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const MONTH_NAMES = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  const norm = (s) => s.trim().split(/\s+/).filter(Boolean).join(" ").toLowerCase();
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  /** Как str.capitalize() в Python: первая буква заглавная, остальные строчные. */
  const capitalize = (s) => { const chars = [...s]; return chars.length ? chars[0].toUpperCase() + chars.slice(1).join("").toLowerCase() : ""; };

  function top(counter, display) {
    return [...counter.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([k, n]) => [display.get(k), n]);
  }

  /** records: [{date: "ГГГГ-ММ-ДД", place, species}] → { records, trips, by_species, by_place, by_month, best_months } (пары [название, число]). */
  function computeStats(records) {
    const items = [...records];
    if (!items.length) return { records: 0, trips: 0, by_species: [], by_place: [], by_month: [], best_months: [] };
    const species = new Map(), places = new Map(), months = new Map(), monthOfYear = new Map();
    const spDisp = new Map(), plDisp = new Map();
    const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const t of items) {
      let k = norm(t.species);
      inc(species, k); if (!spDisp.has(k)) spDisp.set(k, capitalize(t.species.trim()));
      k = norm(t.place);
      inc(places, k); if (!plDisp.has(k)) plDisp.set(k, t.place.trim());
      inc(months, t.date.slice(0, 7));
      inc(monthOfYear, Number(t.date.slice(5, 7)));
    }
    const best = [...monthOfYear.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3);
    return {
      records: items.length,
      trips: new Set(items.map((t) => t.date)).size,
      by_species: top(species, spDisp), by_place: top(places, plDisp),
      by_month: [...months.entries()].sort((a, b) => cmp(a[0], b[0])),
      best_months: best.map(([m, n]) => [MONTH_NAMES[m - 1], n]),
    };
  }
  return { MONTH_NAMES, computeStats, capitalize };
});
