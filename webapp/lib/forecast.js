/* Сборка данных для вкладки «Прогноз»: условия дня, активность, фаза луны, заголовки. Порт forecast_text.py и payloads.py. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const need = (n) => (node ? require("./" + n + ".js") : root.ZL[n]);
  const api = factory(need("dates"), need("weather"), need("scoring"), need("moon"), need("activity"));
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.forecast = api; }
})(typeof self !== "undefined" ? self : this, function (D, W, scoring, moon, A) {
  "use strict";
  const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const DAY_NAMES = { 0: "Сегодня", 1: "Завтра" };
  const has = (v) => v !== null && v !== undefined;
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  /** «Сегодня, 20 ноября» / «Завтра, 21 ноября»; для прочих дат — «22 ноября». */
  function dayHeading(dayIso, todayIso) {
    const text = `${Number(dayIso.slice(8, 10))} ${MONTHS[Number(dayIso.slice(5, 7)) - 1]}`;
    const name = DAY_NAMES[D.diffDays(dayIso, todayIso)];
    return name ? `${name}, ${text}` : text;
  }

  /** Рассвет и закат вместе → одни условия для оценки дня. */
  function conditionsFor(day) {
    const ws = [day.dawn, day.dusk];
    const pick = (k) => ws.map((w) => w[k]).filter(has);
    const gusts = pick("wind_gusts"), precip = pick("precipitation");
    return {
      wind_speed: mean(pick("wind_speed")),
      wind_gusts: gusts.length ? Math.max(...gusts) : null,
      precipitation: precip.length ? precip.reduce((a, b) => a + b, 0) : null,
      pressure_change: day.pressure_change,
      temperature: mean(pick("temperature")),
      cloud_cover: mean(pick("cloud_cover")),
    };
  }

  function activityInputs(day, win, tod) {
    return {
      pressure_change: day.pressure_change, wind_speed: win.wind_speed, precipitation: win.precipitation,
      temp_change: day.temp_change, moon_illumination: moon.moonPhase(day.day).illumination, time_of_day: tod,
      temperature: win.temperature, fresh_snow: tod === "dusk" ? day.snow_before_dusk : day.snow_before_dawn,
    };
  }

  function windowJson(w) {
    const mm = W.hpaToMmhg(w.pressure_hpa);
    return {
      temperature: w.temperature, wind_speed: w.wind_speed, wind_gusts: w.wind_gusts, wind_direction: w.wind_direction,
      wind_direction_name: W.windDirectionName(w.wind_direction), precipitation: w.precipitation,
      pressure_mmhg: mm === null ? null : Math.round(mm * 10) / 10, cloud_cover: w.cloud_cover,
    };
  }

  function activityBlock(day) {
    return Object.entries(A.GROUPS).map(([group, [emoji, title]]) => {
      const entry = { group, emoji, title };
      for (const [key, win] of [["dawn", day.dawn], ["dusk", day.dusk]]) {
        const a = A.estimateActivity(group, activityInputs(day, win, key));
        entry[key] = { value: a.value, label: a.label, reasons: a.reasons };
      }
      return entry;
    });
  }

  function dayPayload(raw, day, label, todayIso) {
    const m = moon.moonPhase(day.day);
    const score = scoring.scoreDay(conditionsFor(day));
    return {
      date: day.day,
      title: `${Number(day.day.slice(8, 10))} ${MONTHS[Number(day.day.slice(5, 7)) - 1]}`,
      label, heading: dayHeading(day.day, todayIso || day.day),
      sunrise: day.sunrise.slice(11, 16), sunset: day.sunset.slice(11, 16),
      sunrise_hour: D.hourOf(day.sunrise), sunset_hour: D.hourOf(day.sunset),
      moon: { name: m.name, emoji: m.emoji, illumination: Math.round(m.illumination * 1000) / 1000 },
      score, dawn: windowJson(day.dawn), dusk: windowJson(day.dusk),
      pressure_change: day.pressure_change, temp_change: day.temp_change,
      hourly: W.hourlySeries(raw, day.day), activity: activityBlock(day),
    };
  }

  /** Сегодня и завтра для места. */
  function forecastPayload(raw, place, now) {
    const days = W.parseForecast(raw);
    const today = W.localToday(raw, now);
    const out = [];
    [[0, "today"], [1, "tomorrow"]].forEach(([offset, label]) => {
      const d = D.addDays(today, offset);
      if (days[d]) out.push(dayPayload(raw, days[d], label, today));
    });
    return { place, today, days: out, activity_disclaimer: A.DISCLAIMER };
  }

  return { MONTHS, dayHeading, conditionsFor, activityInputs, activityBlock, dayPayload, forecastPayload };
});
