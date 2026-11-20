/* Чек-лист снаряжения: шаблоны по виду охоты (data/checklist.json) и подсказки по погоде. Порт bot/services/checklist.py. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory();
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.checklist = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const has = (v) => v !== null && v !== undefined;

  /** Список [категория, ключ, текст] для вида охоты; неизвестный вид — как «general». */
  function templateFor(tpl, huntType) {
    const extra = tpl.by_type[huntType] || tpl.by_type.general;
    return [...tpl.common, ...extra];
  }

  /** Подсказки к чек-листу по прогнозу (всё необязательно). */
  function weatherHints(temperature, precipitation, windSpeed, windGusts) {
    const hints = [];
    if (has(precipitation) && precipitation >= 0.5) {
      if (has(temperature) && temperature <= 0) hints.push("❄️ Ожидается снег: маскхалат / белая маскировка, водоотталкивающая одежда.");
      else hints.push("🌧 Ожидается дождь: дождевик, сменные носки, влагозащита для оружия и оптики.");
    }
    if (has(temperature)) {
      if (temperature <= -10) hints.push("🥶 Сильный мороз: термобельё, тёплые перчатки и обувь, грелки, термос с горячим.");
      else if (temperature <= 3) hints.push("🧥 Холодно: тёплый слой, шапка, перчатки, горячий чай.");
      else if (temperature >= 20) hints.push("☀️ Тепло: больше воды, головной убор, средство от комаров и клещей.");
    }
    if ((has(windSpeed) && windSpeed >= 8) || (has(windGusts) && windGusts >= 12))
      hints.push("💨 Сильный ветер: ветрозащитная куртка, закрепите чучела и маскировку.");
    return hints;
  }
  return { templateFor, weatherHints };
});
