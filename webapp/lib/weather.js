/* Open-Meteo: разбор прогноза и геокодинг. Порт bot/services/weather.py.
   Запросы идут прямо с устройства пользователя (Open-Meteo отдаёт CORS-заголовки), ключ API не нужен. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("./dates.js") : root.ZL.dates);
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.weather = api; }
})(typeof self !== "undefined" ? self : this, function (D) {
  "use strict";
  const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
  const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
  const HPA_TO_MMHG = 0.750062;
  const SNOW_MAX_TEMP = 0.5;      // осадки при такой температуре и ниже считаем снегом
  const COMPASS = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"];
  const has = (v) => v !== null && v !== undefined;

  class WeatherError extends Error {
    constructor(message) { super(message); this.name = "WeatherError"; this.code = "weather_unavailable"; }
  }

  function windDirectionName(deg) {
    if (!has(deg)) return "—";
    return COMPASS[Math.floor((((deg % 360) + 360) % 360 + 22.5) / 45) % 8];
  }
  const hpaToMmhg = (hpa) => (has(hpa) ? hpa * HPA_TO_MMHG : null);

  // ---------- геокодинг ----------
  function placeTitle(p) {
    const parts = [p.name];
    if (p.region && p.region !== p.name) parts.push(p.region);
    if (p.country) parts.push(p.country);
    return parts.join(", ");
  }
  function parseGeocoding(raw) {
    const results = (raw && raw.results) || [];
    if (!results.length) return null;
    const r = results[0];
    const lat = Number(r.latitude), lon = Number(r.longitude);
    if (!r.name || Number.isNaN(lat) || Number.isNaN(lon)) throw new WeatherError("Некорректный ответ геокодера");
    const place = { name: r.name, latitude: lat, longitude: lon, country: r.country || null, region: r.admin1 || null };
    place.title = placeTitle(place);
    return place;
  }

  // ---------- разбор прогноза ----------
  function avg(values) {
    const vals = values.filter(has);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  /** Окно вокруг рассвета/заката: средние значения, максимум порывов, сумма осадков. */
  function windowStats(hourly, centerMs, before, after) {
    const points = [];
    for (let off = -before; off <= after; off++) {
      const p = hourly[D.hourKey(centerMs, off)];
      if (p) points.push(p);
    }
    const precip = points.map((p) => p.precipitation).filter(has);
    const gusts = points.map((p) => p.wind_gusts).filter(has);
    const nearest = hourly[D.hourKey(centerMs)] || points[Math.floor(points.length / 2)] || null;   // направление по ближайшему часу
    return {
      temperature: avg(points.map((p) => p.temperature)),
      wind_speed: avg(points.map((p) => p.wind_speed)),
      wind_gusts: gusts.length ? Math.max(...gusts) : null,
      wind_direction: nearest && has(nearest.wind_direction) ? nearest.wind_direction : null,
      precipitation: precip.length ? precip.reduce((a, b) => a + b, 0) : null,
      pressure_hpa: avg(points.map((p) => p.pressure)),
      cloud_cover: avg(points.map((p) => p.cloud_cover)),
    };
  }

  /** Сумма осадков (мм воды) за `hours` часов до момента, считая только часы с t ≤ 0,5 °C («пороша»). */
  function snowBefore(hourly, momentMs, hours = 10) {
    let total = 0, seen = false;
    for (let back = 1; back <= hours; back++) {
      const p = hourly[D.hourKey(momentMs, -back)];
      if (!p || !has(p.precipitation) || !has(p.temperature)) continue;
      seen = true;
      if (p.temperature <= SNOW_MAX_TEMP) total += p.precipitation;
    }
    return seen ? total : null;
  }

  /** Ответ Open-Meteo → { "ГГГГ-ММ-ДД": {day, sunrise, sunset, dawn, dusk, pressure_change, temp_change, snow_before_*} }. */
  function parseForecast(raw) {
    let hourlyRaw, daily, times, sunrises, sunsets, days;
    try {
      hourlyRaw = raw.hourly; daily = raw.daily; times = hourlyRaw.time;
      sunrises = daily.sunrise; sunsets = daily.sunset; days = daily.time;
      if (![times, sunrises, sunsets, days].every(Array.isArray)) throw new TypeError("not arrays");
    } catch (e) { throw new WeatherError("Некорректный ответ сервиса погоды"); }
    const col = (name) => (hourlyRaw[name] && hourlyRaw[name].length ? hourlyRaw[name] : times.map(() => null));
    const cols = {
      temperature: col("temperature_2m"), wind_speed: col("wind_speed_10m"), wind_gusts: col("wind_gusts_10m"),
      wind_direction: col("wind_direction_10m"), precipitation: col("precipitation"), pressure: col("pressure_msl"),
      cloud_cover: col("cloud_cover"),
    };
    const hourly = {};
    times.forEach((t, i) => {
      const point = {};
      for (const name of Object.keys(cols)) point[name] = has(cols[name][i]) ? cols[name][i] : null;
      hourly[t] = point;
    });
    const result = {};
    const n = Math.min(days.length, sunrises.length, sunsets.length);
    for (let i = 0; i < n; i++) {
      const sr = sunrises[i], ss = sunsets[i];
      if (!sr || !ss) continue;                                  // полярный день/ночь
      const srMs = D.localMs(sr), ssMs = D.localMs(ss);
      const nowKey = D.hourKey(srMs);
      const pNow = hourly[nowKey] && hourly[nowKey].pressure;
      const pBefore = (hourly[D.hourKey(srMs, -12)] || {}).pressure;
      const tNow = hourly[nowKey] && hourly[nowKey].temperature;
      const tBefore = (hourly[D.hourKey(srMs, -24)] || {}).temperature;
      result[days[i]] = {
        day: days[i], sunrise: sr.slice(0, 16), sunset: ss.slice(0, 16),
        dawn: windowStats(hourly, srMs, 1, 2), dusk: windowStats(hourly, ssMs, 2, 1),
        pressure_change: has(pNow) && has(pBefore) ? pNow - pBefore : null,
        temp_change: has(tNow) && has(tBefore) ? tNow - tBefore : null,
        snow_before_dawn: snowBefore(hourly, srMs), snow_before_dusk: snowBefore(hourly, ssMs),
      };
    }
    return result;
  }

  /** Почасовые ряды за сутки для графиков (давление в мм рт. ст.); пропуски — null. */
  function hourlySeries(raw, dayIso) {
    const hourly = raw.hourly || {};
    const times = hourly.time || [];
    const idx = [];
    times.forEach((t, i) => { if (t.startsWith(dayIso)) idx.push(i); });
    const col = (name) => { const v = hourly[name] && hourly[name].length ? hourly[name] : null; return idx.map((i) => (v && has(v[i]) ? v[i] : null)); };
    return {
      time: idx.map((i) => times[i].slice(11, 16)),
      temperature: col("temperature_2m"), wind_speed: col("wind_speed_10m"), wind_gusts: col("wind_gusts_10m"),
      wind_direction: col("wind_direction_10m"), precipitation: col("precipitation"),
      pressure_mmhg: col("pressure_msl").map((p) => (has(p) ? Math.round(p * HPA_TO_MMHG * 10) / 10 : null)),
      cloud_cover: col("cloud_cover"),
    };
  }

  /** Сегодняшняя дата в часовом поясе точки (по utc_offset_seconds ответа). */
  function localToday(raw, now) {
    const offset = Number((raw && raw.utc_offset_seconds) || 0);
    return new Date((now || new Date()).getTime() + offset * 1000).toISOString().slice(0, 10);
  }

  // ---------- сетевые вызовы ----------
  async function getJson(fetchImpl, url, timeoutMs = 15000) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const resp = await fetchImpl(url, ctrl ? { signal: ctrl.signal } : undefined);
      if (!resp.ok) throw new WeatherError("Сервис погоды ответил ошибкой " + resp.status);
      return await resp.json();
    } catch (e) {
      if (e instanceof WeatherError) throw e;
      throw new WeatherError("Сервис погоды недоступен: " + (e && e.message || e));
    } finally { if (timer) clearTimeout(timer); }
  }
  const HOURLY = ["temperature_2m", "precipitation", "pressure_msl", "cloud_cover", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"];
  function forecastUrl(lat, lon) {
    return `${FORECAST_URL}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&hourly=${HOURLY.join(",")}` +
      "&daily=sunrise,sunset&wind_speed_unit=ms&timezone=auto&past_days=1&forecast_days=3";
  }
  const fetchForecast = (fetchImpl, lat, lon) => getJson(fetchImpl, forecastUrl(lat, lon));
  const geocodeCity = async (fetchImpl, name) =>
    parseGeocoding(await getJson(fetchImpl, `${GEOCODING_URL}?name=${encodeURIComponent(name)}&count=1&language=ru&format=json`));

  return { FORECAST_URL, GEOCODING_URL, HPA_TO_MMHG, SNOW_MAX_TEMP, WeatherError, windDirectionName, hpaToMmhg, placeTitle,
    parseGeocoding, parseForecast, hourlySeries, localToday, forecastUrl, fetchForecast, geocodeCity };
});
