/* Даты без часовых поясов: ISO-строки «ГГГГ-ММ-ДД» и локальные «ГГГГ-ММ-ДДTЧЧ:ММ» из Open-Meteo.
   Арифметика идёт через UTC-миллисекунды, чтобы переходы на летнее время и пояс браузера не влияли. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory();
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.dates = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const MS_DAY = 86400000;
  const pad = (n) => String(n).padStart(2, "0");

  function isValid(y, m, d) {
    if (!(m >= 1 && m <= 12 && d >= 1 && y >= 1000 && y <= 9999)) return false;
    return d <= daysInMonth(y, m);
  }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function make(y, m, d) {
    if (!isValid(y, m, d)) throw new RangeError(`Неверная дата ${y}-${m}-${d}`);
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  function ms(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) throw new RangeError("Неверная дата: " + iso);
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }
  const fromMs = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (iso, n) => fromMs(ms(iso) + n * MS_DAY);
  const diffDays = (a, b) => Math.round((ms(a) - ms(b)) / MS_DAY);        // a − b в сутках
  /** День недели как в Python: 0 = понедельник … 6 = воскресенье. */
  const weekday = (iso) => (new Date(ms(iso)).getUTCDay() + 6) % 7;
  const year = (iso) => Number(iso.slice(0, 4));

  // ---- локальное время «ГГГГ-ММ-ДДTЧЧ:ММ» (как отдаёт Open-Meteo при timezone=auto) ----
  function localMs(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
    if (!m) throw new RangeError("Неверное время: " + s);
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  }
  /** Ключ часа «ГГГГ-ММ-ДДTЧЧ:00» для момента t (мс), сдвинутого на offsetHours. */
  const hourKey = (t, offsetHours = 0) => new Date(t + offsetHours * 3600000).toISOString().slice(0, 13) + ":00";
  const hourOf = (s) => Number(s.slice(11, 13)) + Number(s.slice(14, 16)) / 60;

  /** Сегодняшняя дата в часовом поясе IANA (null/«auto» — по устройству). */
  function todayIn(tz, now) {
    now = now || new Date();
    if (tz && tz !== "auto") {
      try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
      catch (e) { /* неизвестный пояс: берём устройство */ }
    }
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /** «сегодня», «вчера», ДД.ММ.ГГГГ, ДД.ММ.ГГ или ГГГГ-ММ-ДД; иначе null. */
  function parseUserDate(text, today) {
    const t = String(text == null ? "" : text).trim().toLowerCase();
    if (t === "сегодня" || t === "today") return today;
    if (t === "вчера") return addDays(today, -1);
    let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
    if (m) return isValid(+m[3], +m[2], +m[1]) ? make(+m[3], +m[2], +m[1]) : null;
    m = /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/.exec(t);
    if (m) {
      const yy = +m[3], y = yy >= 69 ? 1900 + yy : 2000 + yy;      // как %y в Python
      return isValid(y, +m[2], +m[1]) ? make(y, +m[2], +m[1]) : null;
    }
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    if (m) return isValid(+m[1], +m[2], +m[3]) ? make(+m[1], +m[2], +m[3]) : null;
    return null;
  }

  const fmtDM = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  const fmtFull = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

  return { MS_DAY, pad, isValid, daysInMonth, make, ms, fromMs, addDays, diffDays, weekday, year, localMs, hourKey, hourOf,
    todayIn, parseUserDate, fmtDM, fmtFull };
});
