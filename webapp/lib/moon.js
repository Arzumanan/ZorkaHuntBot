/* Фаза луны по среднему синодическому месяцу; порт bot/services/moon.py. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("./dates.js") : root.ZL.dates);
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.moon = api; }
})(typeof self !== "undefined" ? self : this, function (dates) {
  "use strict";
  const SYNODIC_MONTH = 29.530588853;
  const REF_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);     // новолуние 2000-01-06 18:14 UTC
  const NAMES = [
    ["Новолуние", "🌑"], ["Растущий серп", "🌒"], ["Первая четверть", "🌓"], ["Растущая луна", "🌔"],
    ["Полнолуние", "🌕"], ["Убывающая луна", "🌖"], ["Последняя четверть", "🌗"], ["Убывающий серп", "🌘"],
  ];
  const mod = (a, n) => ((a % n) + n) % n;

  const moonAge = (tMs) => mod((tMs - REF_NEW_MOON) / 86400000, SYNODIC_MONTH);
  function phaseName(age) {
    const fraction = mod(age, SYNODIC_MONTH) / SYNODIC_MONTH;
    return NAMES[Math.floor(fraction * 8 + 0.5) % 8];
  }
  /** Фаза на дату ISO (по умолчанию на полдень UTC). */
  function moonPhase(iso, hourUtc = 12) {
    const t = dates.ms(iso) + hourUtc * 3600000;
    const age = moonAge(t);
    const [name, emoji] = phaseName(age);
    return { age_days: age, illumination: (1 - Math.cos((2 * Math.PI * age) / SYNODIC_MONTH)) / 2, name, emoji };
  }
  return { SYNODIC_MONTH, moonAge, phaseName, moonPhase };
});
