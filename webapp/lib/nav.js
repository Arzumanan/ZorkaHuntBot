/* Навигатор охотника: расстояние, азимут, компас, снос запаха, типы и проверка меток.
   Чистая логика, без DOM и сети — её покрывают tests/js/nav.test.js. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory();
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.nav = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const EARTH_M = 6371000;
  const COORD_DECIMALS = 6;          // ≈ 0,11 м, достаточно для метки и влезает в хранилище
  const MAX_MARKS = 200;
  const NAME_MAX = 60;
  const NOTE_MAX = 200;
  const CALM_MS = 0.5;               // слабее — запах почти не сносит
  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;
  const norm360 = (d) => ((d % 360) + 360) % 360;
  const has = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

  const MARK_TYPES = [
    { code: "tower", name: "Вышка", emoji: "🗼" },
    { code: "salt", name: "Солонец", emoji: "🧂" },
    { code: "labaz", name: "Лабаз", emoji: "🪵" },
    { code: "flush", name: "Место подъёма", emoji: "🐦" },
    { code: "car", name: "Машина", emoji: "🚗" },
    { code: "other", name: "Другое", emoji: "📍" },
  ];
  const TYPE_BY = Object.fromEntries(MARK_TYPES.map((t) => [t.code, t]));
  const COMPASS = [
    { short: "С", to: "север", from: "севера" },
    { short: "СВ", to: "северо-восток", from: "северо-востока" },
    { short: "В", to: "восток", from: "востока" },
    { short: "ЮВ", to: "юго-восток", from: "юго-востока" },
    { short: "Ю", to: "юг", from: "юга" },
    { short: "ЮЗ", to: "юго-запад", from: "юго-запада" },
    { short: "З", to: "запад", from: "запада" },
    { short: "СЗ", to: "северо-запад", from: "северо-запада" },
  ];
  function compassIndex(deg) {
    if (!has(deg)) return null;
    return Math.floor((norm360(Number(deg)) + 22.5) / 45) % 8;
  }
  const compass = (deg) => { const i = compassIndex(deg); return i == null ? null : COMPASS[i]; };
  const compassShort = (deg) => (compass(deg) || { short: "—" }).short;
  const compassTo = (deg) => (compass(deg) || { to: "—" }).to;
  const compassFrom = (deg) => (compass(deg) || { from: "—" }).from;

  /** Расстояние по дуге большого круга, метры. */
  function distance(lat1, lon1, lat2, lon2) {
    const φ1 = toRad(lat1), φ2 = toRad(lat2), Δφ = toRad(lat2 - lat1), Δλ = toRad(lon2 - lon1);
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  /** Начальный азимут из точки 1 на точку 2, градусы по часовой стрелке от севера (0…360). */
  function bearing(lat1, lon1, lat2, lon2) {
    const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return norm360(toDeg(Math.atan2(y, x)));
  }
  /** Азимут цели относительно курса устройства: 0 — прямо вперёд, 90 — справа. */
  const relativeBearing = (targetDeg, headingDeg) =>
    (has(targetDeg) && has(headingDeg) ? norm360(Number(targetDeg) - Number(headingDeg)) : null);
  function formatDistance(m) {
    if (!has(m) || m < 0) return "—";
    if (m < 1000) return Math.round(m) + " м";
    if (m < 10000) return (Math.round(m / 100) / 10).toFixed(1).replace(".", ",") + " км";
    return Math.round(m / 1000) + " км";
  }
  const formatAzimuth = (deg) => (has(deg) ? "азимут " + Math.round(norm360(deg)) + "° (" + compassShort(deg) + ")" : "—");

  /** Метеорологическое направление — откуда дует; запах сносит в противоположную сторону. */
  const scentDrift = (windFromDeg) => (has(windFromDeg) ? norm360(Number(windFromDeg) + 180) : null);

  /**
   * Подсказка подхода: идти с подветренной стороны, то есть оттуда, куда сносит запах,
   * чтобы метка оказалась на ветру от вас. При слабом ветре совета нет.
   */
  function approachAdvice(windFromDeg, speed) {
    const drift = scentDrift(windFromDeg);
    if (drift == null) return null;
    if (has(speed) && Number(speed) < CALM_MS) {
      return { calm: true, driftDeg: drift, text: "Ветер слишком слабый, запах почти не сносит." };
    }
    return {
      calm: false, driftDeg: drift,
      text: "Заходи к метке с подветренной стороны: с " + compassFrom(drift) + ".",
      scentText: "Запах сносит на " + compassTo(drift) + ".",
    };
  }

  /** Ветер ближайшего часа из сырого ответа Open-Meteo (время в поясе точки). */
  function currentWind(raw, now) {
    const hourly = raw && raw.hourly, times = hourly && hourly.time;
    if (!Array.isArray(times) || !times.length) return null;
    const offset = Number((raw && raw.utc_offset_seconds) || 0);
    const key = new Date((now || new Date()).getTime() + offset * 1000).toISOString().slice(0, 13) + ":00";
    let idx = 0;
    for (let i = 0; i < times.length; i++) { if (times[i] <= key) idx = i; else break; }
    const col = (name) => { const v = hourly[name] && hourly[name][idx]; return has(v) ? Number(v) : null; };
    const direction = col("wind_direction_10m"), speed = col("wind_speed_10m"), gusts = col("wind_gusts_10m");
    if (direction == null && speed == null) return null;
    return { time: times[idx], direction, speed, gusts, drift: scentDrift(direction) };
  }

  const roundCoord = (v, n) => {
    const d = n == null ? COORD_DECIMALS : n;
    const x = Number(v);
    return Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null;
  };
  const validCoord = (v, lo, hi) => {
    const x = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(String(v).replace(",", ".")) : NaN);
    return Number.isFinite(x) && x >= lo && x <= hi ? x : null;
  };
  function cleanText(value, maxLen) {
    if (typeof value !== "string") return "";
    return [...value.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim()].slice(0, maxLen).join("");
  }

  /** Проверка полей метки. Возвращает нормализованный объект или { error, message }. */
  function normalizeMark(input) {
    const type = input && input.type;
    if (!type || !TYPE_BY[type]) return { error: "bad_type", message: "Выберите тип метки." };
    const lat = validCoord(input.lat, -90, 90), lon = validCoord(input.lon, -180, 180);
    if (lat === null || lon === null) return { error: "bad_coordinates", message: "Некорректные координаты." };
    const name = cleanText(input.name, NAME_MAX) || TYPE_BY[type].name;
    const note = cleanText(input.note, NOTE_MAX);
    return { type, name, note, lat: roundCoord(lat), lon: roundCoord(lon) };
  }
  /** Сжатая запись для хранилища: короткие поля, координаты округлены. */
  const packMark = (id, rec) => ({ id, t: rec.type, n: rec.name, o: rec.note || "", lat: rec.lat, lon: rec.lon });
  const unpackMark = (raw) => {
    if (!raw || !TYPE_BY[raw.t] || !has(raw.lat) || !has(raw.lon)) return null;
    return { id: raw.id, key: "m" + raw.id, type: raw.t, name: raw.n || TYPE_BY[raw.t].name, note: raw.o || "", lat: raw.lat, lon: raw.lon };
  };
  const markPublic = (m) => {
    const t = TYPE_BY[m.type];
    return { id: m.id, key: m.key || "m" + m.id, type: m.type, name: m.name, note: m.note || "", lat: m.lat, lon: m.lon,
      type_name: t ? t.name : m.type, emoji: t ? t.emoji : "📍" };
  };
  /** Цель «вернуться к…» по умолчанию: первая машина, иначе ничего не выбираем. */
  const defaultNavTarget = (marks) => {
    const list = marks || [];
    return (list.find((m) => m.type === "car") || null);
  };
  const parseMarkId = (v) => {
    if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
    if (typeof v === "string" && /^m?\d+$/.test(v)) return Number(v.replace(/^m/, ""));
    return null;
  };
  const headingFromOrientation = (e) => {
    if (!e) return null;
    if (has(e.webkitCompassHeading)) return norm360(e.webkitCompassHeading);
    if (has(e.alpha)) return norm360(360 - e.alpha);
    return null;
  };


  /** Тексты ошибок геопозиции: никогда не показываем сырые коды вроде WebAppLocationManagerLocationNotAvailable. */
  const GEO_TEXT = {
    geo_denied: "Геопозиция запрещена. Разрешите доступ в настройках.",
    geo_unavailable: "На этом устройстве Telegram не даёт геопозицию. Открой Зорьку на телефоне или разреши доступ к местоположению.",
    geo_timeout: "Не удалось определить местоположение: истекло время ожидания.",
    geo_unsupported: "Это устройство не умеет определять местоположение.",
    geo_generic: "Не удалось определить местоположение.",
  };
  const GEO_UNAVAILABLE_RE = /LocationNotAvailable|LOCATION_NOT_AVAILABLE|isLocationAvailable|WebAppMethodUnsupported|MethodUnsupported|not available|POSITION_UNAVAILABLE|location.?unavailable/i;
  const GEO_DENIED_RE = /PERMISSION_DENIED|permission.?denied|access.?denied|not.?granted|User denied/i;
  const GEO_TIMEOUT_RE = /TIMEOUT|timed? ?out|Position.?Timeout/i;
  const GEO_CODE_RE = /WebApp[A-Za-z0-9]+|[A-Z]{3,}(?:_[A-Z0-9]+)+/;
  function classifyGeoRaw(raw) {
    const s = String(raw == null ? "" : raw);
    if (GEO_DENIED_RE.test(s)) return "geo_denied";
    if (GEO_TIMEOUT_RE.test(s)) return "geo_timeout";
    if (GEO_UNAVAILABLE_RE.test(s)) return "geo_unavailable";
    if (/unsupported|not supported|not.?capable/i.test(s)) return "geo_unsupported";
    return null;
  }
  /**
   * Любая ошибка геопозиции (объект, код Telegram, код браузера 1/2/3) → { code, message, settings }.
   * message всегда по-русски, без технических кодов.
   */
  function describeGeoError(err) {
    let code = null;
    if (err && typeof err === "object") {
      if (err.code === 1 || err.code === "geo_denied") code = "geo_denied";
      else if (err.code === 3 || err.code === "geo_timeout") code = "geo_timeout";
      else if (err.code === "geo_unavailable" || err.code === "geo_unsupported" || err.code === "geo_generic") code = err.code;
      else if (err.code === 2) code = "geo_generic";
      if (!code) code = classifyGeoRaw([err.message, err.code, err.error, err.name].filter((x) => x != null).join(" "));
    } else if (err != null && err !== "") {
      if (err === 1) code = "geo_denied";
      else if (err === 3) code = "geo_timeout";
      else if (err === 2) code = "geo_generic";
      else code = classifyGeoRaw(err);
    }
    if (!code) code = "geo_generic";
    return { code, message: GEO_TEXT[code] || GEO_TEXT.geo_generic, settings: code === "geo_denied" };
  }

  /** Ключ состава меток: меняется только когда меняются сами метки, не позиция и не курс. */
  function marksKey(marks) {
    return uniqueMarks(marks).map((m) => [m.id, m.type || "", m.name || "", m.lat, m.lon].join("\t")).join("\n");
  }
  function uniqueMarks(marks) {
    const seen = new Set();
    const out = [];
    for (const m of marks || []) {
      if (!m || m.id == null || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  }
  /**
   * Подписи пунктов «Вернуться к…». Стабильны относительно позиции и курса:
   * при одинаковых именах добавляем тип, а если тип тоже совпадает — координаты, не расстояние.
   */
  function targetOptionLabels(marks) {
    const list = uniqueMarks(marks);
    const counts = Object.create(null);
    for (const m of list) {
      const key = String(m.name || "").trim().toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
    }
    const typeOf = (m) => m.type_name || (TYPE_BY[m.type] && TYPE_BY[m.type].name) || "";
    return list.map((m) => {
      const emoji = m.emoji || (TYPE_BY[m.type] && TYPE_BY[m.type].emoji) || "📍";
      const name = m.name || (TYPE_BY[m.type] && TYPE_BY[m.type].name) || "Метка";
      const base = (emoji + " " + name).trim();
      const key = String(m.name || "").trim().toLowerCase();
      if ((counts[key] || 0) <= 1) return { id: m.id, label: base };
      const typ = typeOf(m);
      const sameType = list.filter((x) => String(x.name || "").trim().toLowerCase() === key && typeOf(x) === typ).length > 1;
      let extra = typ;
      if (sameType && has(m.lat) && has(m.lon)) {
        extra = (extra ? extra + ", " : "") + Number(m.lat).toFixed(3) + ", " + Number(m.lon).toFixed(3);
      }
      return { id: m.id, label: extra ? base + " (" + extra + ")" : base };
    });
  }

  const shouldFallbackFromTelegram = (info) => info && info.code !== "geo_denied";

  return {
    EARTH_M, COORD_DECIMALS, MAX_MARKS, NAME_MAX, NOTE_MAX, CALM_MS, MARK_TYPES, TYPE_BY,
    compassShort, compassTo, compassFrom, distance, bearing, relativeBearing, formatDistance, formatAzimuth,
    scentDrift, approachAdvice, currentWind, roundCoord, validCoord, cleanText, normalizeMark,
    packMark, unpackMark, markPublic, defaultNavTarget, parseMarkId, headingFromOrientation, norm360,
    GEO_TEXT, describeGeoError, classifyGeoRaw, shouldFallbackFromTelegram,
    marksKey, uniqueMarks, targetOptionLabels,
  };
});
