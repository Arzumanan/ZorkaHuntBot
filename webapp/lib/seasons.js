/* Сроки охоты по регионам: данные в data/seasons.json, расчёт дат — чистые функции. Порт bot/services/seasons.py.

   Формат дат в JSON:
     "MM-DD"    — фиксированная дата (например "10-15");
     "satN-MM"  — N-я суббота месяца MM (например "sat3-08" — третья суббота августа);
     "eom-MM"   — последний день месяца MM.
   Если конец раньше начала, сезон переходит на следующий год. У диапазона может быть "days" вместо "end".
   Запись региона с тем же "id", что и в "federal", заменяет федеральную. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("./dates.js") : root.ZL.dates);
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.seasons = api; }
})(typeof self !== "undefined" ? self : this, function (D) {
  "use strict";
  const CATEGORY_TITLES = {
    spring: "🌱 Весенняя охота на пернатую дичь",
    birds: "🦆 Летне-осенняя охота на пернатую дичь",
    ungulates: "🐗 Копытные (кабан, лось, косуля, олень)",
    fur: "🦊 Пушные звери",
  };
  const CATEGORY_ORDER = ["spring", "birds", "ungulates", "fur"];
  const CONFIDENCE_LABELS = {
    federal: "федеральные правила", regional_official: "региональный акт", regional_reported: "по сообщениям (проверьте)",
  };
  const DISCLAIMER = "Точные сроки уточняйте в региональном охотуправлении / указе губернатора.";
  const UPCOMING_DAYS = 30;

  // ---------- правила дат ----------
  function nthWeekday(year, month, weekday, n) {      // weekday: 0 = пн … 5 = сб
    const first = D.make(year, month, 1);
    const delta = (((weekday - D.weekday(first)) % 7) + 7) % 7;
    return D.addDays(first, delta + 7 * (n - 1));
  }
  function resolveRule(rule, year) {
    if (rule.startsWith("sat")) {
      const [n, month] = rule.slice(3).split("-");
      return nthWeekday(year, Number(month), 5, Number(n));
    }
    if (rule.startsWith("eom-")) {
      const month = Number(rule.slice(4));
      return D.make(year, month, D.daysInMonth(year, month));
    }
    const [month, day] = rule.split("-");
    return D.make(year, Number(month), Number(day));
  }
  /** Окно сезона, который НАЧИНАЕТСЯ в году year. */
  function resolveRange(rng, year) {
    const start = resolveRule(rng.start, year);
    if (rng.days) return { start, end: D.addDays(start, Number(rng.days) - 1) };
    let end = resolveRule(rng.end, year);
    if (end < start) end = resolveRule(rng.end, year + 1);
    return { start, end };
  }

  // ---------- записи региона ----------
  function toEntry(raw) {
    return { id: raw.id, category: raw.category, name: raw.name, ranges: raw.ranges || [], confidence: raw.confidence || "federal",
      source: raw.source || "", note: raw.note === undefined ? null : raw.note, closed: !!raw.closed, frame: !!raw.frame };
  }
  /** Федеральные записи, поверх которых лежат записи региона (по id). */
  function regionEntries(data, code) {
    const merged = {}, order = [];
    for (const e of data.federal) { merged[e.id] = e; order.push(e.id); }
    const region = data.regions[code || ""];
    if (region) for (const e of region.entries) { if (!(e.id in merged)) order.push(e.id); merged[e.id] = e; }
    return order.map((id) => toEntry(merged[id]));
  }
  const isVerified = (data, code) => !!((data.regions[code || ""] || {}).verified);

  function entryWindows(entry, around) {
    const y = D.year(around), windows = [];
    for (const rng of entry.ranges) for (const yy of [y - 1, y, y + 1]) windows.push(resolveRange(rng, yy));
    return windows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }
  /** state: open | upcoming | closed | banned; window — текущее (open) или ближайшее (upcoming/closed) окно. */
  function entryStatus(entry, today) {
    if (entry.closed || !entry.ranges.length) return { state: "banned", window: null, days: null };
    const windows = entryWindows(entry, today);
    for (const w of windows) if (w.start <= today && today <= w.end) return { state: "open", window: w, days: null };
    const nxt = windows.find((w) => w.start > today) || null;
    if (!nxt) return { state: "closed", window: null, days: null };
    const delta = D.diffDays(nxt.start, today);
    return { state: delta <= UPCOMING_DAYS ? "upcoming" : "closed", window: nxt, days: delta };
  }
  const openEntries = (data, code, on) =>
    regionEntries(data, code).filter((e) => !e.frame && !e.closed && entryStatus(e, on).state === "open");
  const seasonOpen = (data, code, on) => openEntries(data, code, on).length > 0;

  // ---------- JSON для интерфейса ----------
  function seasonsPayload(data, regions, code, today) {
    const region = regions.find((r) => r.code === code) || null;
    const verified = isVerified(data, code);
    const entries = regionEntries(data, code);
    const categories = [];
    for (const cat of CATEGORY_ORDER) {
      let items = entries.filter((e) => e.category === cat);
      if (cat === "spring" && items.some((e) => !e.frame)) items = items.filter((e) => !e.frame);   // рамки — только если нет периодов региона
      const out = items.map((e) => {
        const st = entryStatus(e, today);
        let windows = [];
        if (e.ranges.length && !e.closed) {
          const limit = D.addDays(today, 366);
          windows = entryWindows(e, today).filter((w) => w.end >= today && w.start <= limit).slice(0, e.ranges.length)
            .map((w) => ({ start: w.start, end: w.end }));
        }
        return {
          id: e.id, name: e.name, state: st.state, frame: e.frame, note: e.note, confidence: e.confidence,
          confidence_label: CONFIDENCE_LABELS[e.confidence] || e.confidence,
          days_to_open: st.state === "upcoming" ? st.days : null,
          current_end: st.state === "open" && st.window ? st.window.end : null,
          next_start: (st.state === "upcoming" || st.state === "closed") && st.window ? st.window.start : null,
          windows,
        };
      });
      categories.push({ id: cat, title: CATEGORY_TITLES[cat], entries: out });
    }
    const reg = verified ? data.regions[code] : {};
    const srcKeys = [...new Set([...(reg.sources || []), "fed_birds", "fed_ungulates", "fed_fur"])];
    return {
      region: { code, name: region ? region.name : code },
      verified, summary: verified ? reg.summary || null : null, notes: verified ? reg.notes || null : null,
      today, categories, sources: srcKeys.map((k) => data.sources[k]), disclaimer: DISCLAIMER,
      open_count: entries.filter((e) => !e.frame && !e.closed && entryStatus(e, today).state === "open").length,
    };
  }

  return { CATEGORY_TITLES, CATEGORY_ORDER, CONFIDENCE_LABELS, DISCLAIMER, UPCOMING_DAYS, nthWeekday, resolveRule, resolveRange,
    regionEntries, isVerified, entryWindows, entryStatus, openEntries, seasonOpen, seasonsPayload };
});
