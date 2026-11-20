/* Оценка дня для выезда (1–5). Чистая функция; порт bot/services/scoring.py. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory();
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.scoring = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const LABELS = { 1: "Лучше остаться дома", 2: "Так себе", 3: "Нормально", 4: "Хороший день", 5: "Отличный день" };
  const has = (v) => v !== null && v !== undefined;

  /** c: { wind_speed, wind_gusts, precipitation, pressure_change, temperature } (всё необязательно). */
  function scoreDay(c) {
    let points = 5.0;
    const reasons = [];
    if (has(c.wind_speed)) {
      if (c.wind_speed <= 3) reasons.push("слабый ветер");
      else if (c.wind_speed <= 5) { points -= 0.5; reasons.push("умеренный ветер"); }
      else if (c.wind_speed <= 8) { points -= 1.5; reasons.push("сильный ветер"); }
      else { points -= 2.5; reasons.push("очень сильный ветер"); }
    }
    if (has(c.wind_gusts)) {
      if (c.wind_gusts >= 15) { points -= 1.5; reasons.push("опасные порывы ветра"); }
      else if (c.wind_gusts >= 10) { points -= 0.75; reasons.push("порывистый ветер"); }
    }
    if (has(c.precipitation)) {
      if (c.precipitation >= 5) { points -= 2.0; reasons.push("сильные осадки"); }
      else if (c.precipitation >= 1) { points -= 1.0; reasons.push("заметные осадки"); }
      else if (c.precipitation > 0.2) { points -= 0.3; reasons.push("небольшие осадки"); }
      else reasons.push("без осадков");
    }
    if (has(c.pressure_change)) {
      const d = c.pressure_change;
      if (Math.abs(d) >= 6) { points -= 1.5; reasons.push("резкий скачок давления" + (d < 0 ? " вниз" : " вверх")); }
      else if (Math.abs(d) >= 3) { points -= 0.5; reasons.push("давление заметно " + (d < 0 ? "падает" : "растёт")); }
      else reasons.push("давление стабильное");
    }
    if (has(c.temperature)) {
      if (c.temperature <= -20) { points -= 1.0; reasons.push("сильный мороз"); }
      else if (c.temperature >= 30) { points -= 1.0; reasons.push("сильная жара"); }
    }
    const value = Math.max(1, Math.min(5, Math.floor(points + 0.5)));
    return { value, label: LABELS[value], reasons };
  }
  return { LABELS, scoreDay };
});
