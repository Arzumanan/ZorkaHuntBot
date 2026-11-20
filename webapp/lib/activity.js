/* Оценка активности зверя и птицы (1–5). Эвристика, а не наука; порт bot/services/activity.py.

   Правила (ориентиры из охотничьей практики):
    • давление: медленное падение перед сменой погоды — кормятся активнее; резкий скачок или рост — активность падает;
    • ветер: у каждой группы свой комфортный диапазон; сильный ветер прижимает всех;
    • осадки: сильный дождь или снег снижают активность; смена температуры: резкая — минус, похолодание — плюс;
    • луна: яркая ночь — зверь кормится ночью, на зорьке менее активен;
    • время суток: утро и вечер — пик, середина дня — спад;
    • фазан: не любит дождь и сильный ветер, держится у кромок и укрытий;
    • заяц: активнее в сумерки и ночью (вечер сильнее утра), любит тихую погоду; пороша повышает активность. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory();
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.activity = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const GROUPS = {
    waterfowl: ["🦆", "Водоплавающая дичь"],
    upland: ["🐦", "Боровая дичь"],
    ungulates: ["🐗", "Копытные"],
    pheasant: ["🐓", "Фазан"],
    hare: ["🐇", "Заяц"],
  };
  const LABELS = { 1: "очень низкая", 2: "низкая", 3: "средняя", 4: "высокая", 5: "очень высокая" };
  const TIMES_OF_DAY = ["dawn", "dusk", "day"];
  const DISCLAIMER = "Это ориентировочная оценка по правилам, а не гарантия: реальная активность зависит от угодья, пресса охоты и корма.";
  const has = (v) => v !== null && v !== undefined;

  /** c: pressure_change, wind_speed, precipitation, temp_change, moon_illumination, time_of_day, temperature, fresh_snow */
  function estimateActivity(group, c) {
    if (!(group in GROUPS)) throw new Error("Неизвестная группа: " + group);
    const tod = c.time_of_day || "dawn";
    if (!TIMES_OF_DAY.includes(tod)) throw new Error("Неизвестное время суток: " + tod);
    let points = 3.0;
    const reasons = [];
    const add = (delta, text) => { points += delta; reasons.push(text); };

    // время суток
    if (group === "hare") {
      if (tod === "dusk") add(1.5, "вечер — заяц выходит на жировку");
      else if (tod === "dawn") add(0.5, "утро — заяц ещё кормится, к рассвету ложится на лёжку");
      else add(-1.0, "день — заяц лежит на лёжке");
    } else if (tod === "dawn" || tod === "dusk") {
      add(1.0, group === "pheasant" ? "утро и вечер — фазан кормится у кромок и укрытий" : "зорька — пик активности");
    } else add(-0.5, "середина дня — спад активности");

    // давление
    const d = c.pressure_change;
    if (has(d)) {
      if (d >= -6 && d <= -1.5) add(1.0, "давление медленно падает — кормятся активнее");
      else if (d < -6) add(group === "waterfowl" ? 0.5 : -0.5,
        "резкое падение давления" + (group === "waterfowl" ? " — птица в движении" : " — затаиваются"));
      else if (d >= 1.5 && d <= 6) add(-0.5, "давление растёт — активность чуть ниже");
      else if (d > 6) add(-1.0, "быстрый рост давления — активность низкая");
      else reasons.push("давление стабильное");
    }

    // ветер (комфортные пределы по группам)
    const w = c.wind_speed;
    if (has(w)) {
      if (group === "waterfowl") {
        if (w >= 3 && w <= 8) add(0.5, "ветер 3–8 м/с — утка летает активно");
        else if (w > 10) add(-1.0, "сильный ветер — птица прижимается к укрытиям");
      } else if (group === "upland") {
        if (w <= 4) add(0.5, "тихо — боровая дичь активна");
        else if (w > 6) add(-1.0, "ветер мешает — птица сидит");
      } else if (group === "pheasant") {
        if (w <= 4) add(0.5, "тихо — фазан выходит кормиться");
        else if (w > 9) add(-1.5, "сильный ветер — фазан прячется в густом укрытии");
        else if (w > 6) add(-1.0, "ветер — фазан держится ближе к укрытию");
      } else if (group === "hare") {
        if (w <= 4) add(0.5, "тихо — заяц спокойно кормится");
        else if (w > 10) add(-1.5, "сильный ветер — заяц лежит и не выходит");
        else if (w > 7) add(-1.0, "ветер тревожит зайца — меньше ходит");
      } else {   // ungulates
        if (w <= 4) add(0.5, "тихо — зверь выходит на кормёжку");
        else if (w > 8) add(-1.0, "сильный ветер — зверь в укрытиях");
      }
    }

    // осадки
    const p = c.precipitation;
    if (has(p)) {
      const snowing = has(c.temperature) && c.temperature <= 0.5;
      if (group === "pheasant" && p >= 0.5) add(p >= 2 ? -1.5 : -1.0, (snowing ? "снег" : "дождь") + " — фазан отсиживается в укрытии");
      else if (p >= 2) add(group === "waterfowl" ? -0.5 : -1.0, "заметные осадки снижают активность");
      else if (p > 0.2) reasons.push("небольшие осадки");
      else reasons.push("без осадков");
    }

    // свежий снег: пороша (заяц)
    if (group === "hare" && has(c.fresh_snow) && c.fresh_snow >= 0.3 && (!has(p) || p < 2))
      add(1.0, "пороша — свежий снег ночью: заяц ходит, следы читаются");

    // температура
    const t = c.temp_change;
    if (has(t)) {
      if (t <= -4 && (group === "waterfowl" || group === "ungulates")) add(0.5, "похолодание — подталкивает перелёт и кормёжку");
      else if (Math.abs(t) >= 6) add(-0.5, "резкая смена температуры");
    }
    if (group === "pheasant" && has(c.temperature) && c.temperature <= -15) add(-0.5, "сильный мороз — фазан малоподвижен");

    // луна (фазан ночью спит на присаде — луна не важна)
    const m = c.moon_illumination;
    if (has(m) && group !== "pheasant") {
      if (m >= 0.85) add(-0.5, "яркая луна — " + (group === "hare" ? "заяц кормится всю ночь, к утру менее активен" : "зверь кормится ночью"));
      else if (m <= 0.15) add(0.5, "тёмные ночи — днём и на зорьке активнее");
    }

    const value = Math.max(1, Math.min(5, Math.floor(points + 0.5)));
    return { value, label: LABELS[value], reasons };
  }
  return { GROUPS, LABELS, TIMES_OF_DAY, DISCLAIMER, estimateActivity };
});
