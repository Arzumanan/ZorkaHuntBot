/* Данные пользователя поверх хранилища (storage.js): настройки, угодья, чек-лист, журнал, перенос из старой базы.
   Ключи хранилища (все ≤ 128 символов, [A-Za-z0-9_-]):
     meta            {region, tz, hunt, loc}                      — регион, часовой пояс, вид охоты, текущее место
     places          {seq, def, list:[{id,name,lat,lon}]}         — угодья
     ck_<вид>        {seq, checked:[ключи шаблона], custom:[{id,cat,text,checked}]} — чек-лист по виду охоты
     j_<ГГГГММДД>_<id>  {d,p,s,n}                                — одна запись журнала в одном ключе
     mig             {state, at}                                  — перенос из старой базы (imported | done | skipped) */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const need = (n) => (node ? require("./" + n + ".js") : root.ZL[n]);
  const api = factory(need("dates"), need("checklist"));
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.data = api; }
})(typeof self !== "undefined" ? self : this, function (D, CL) {
  "use strict";
  const LIMITS = {
    ITEM_MAX: 100, PLACE_NAME_MAX: 60, MAX_PLACES: 30, MAX_CUSTOM_ITEMS: 100, CITY_MAX: 80,
    PLACE_MAX: 200, SPECIES_MAX: 100, NOTE_MAX: 500, JOURNAL_LIMIT: 500, MAX_RECORDS: 900,
  };
  const TIMEZONES = [
    ["Europe/Kaliningrad", "Калининград (UTC+2)"], ["Europe/Moscow", "Москва, Краснодар, Майкоп (UTC+3)"],
    ["Europe/Samara", "Самара (UTC+4)"], ["Asia/Yekaterinburg", "Екатеринбург (UTC+5)"], ["Asia/Omsk", "Омск (UTC+6)"],
    ["Asia/Krasnoyarsk", "Красноярск (UTC+7)"], ["Asia/Irkutsk", "Иркутск (UTC+8)"], ["Asia/Yakutsk", "Якутск (UTC+9)"],
    ["Asia/Vladivostok", "Владивосток (UTC+10)"], ["Asia/Kamchatka", "Камчатка (UTC+12)"],
  ].map(([code, name]) => ({ code, name }));
  const AUTO_TZ = { code: "auto", name: "Как на устройстве" };

  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.name = "ApiError"; this.status = status; this.code = code; }
  }
  const fail = (status, code, message) => { throw new ApiError(status, code, message); };

  /** Схлопывает пробелы; не строка — пустая строка; длинное — обрезается. */
  function cleanText(value, maxLen) {
    if (typeof value !== "string") return "";
    return [...value.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim()].slice(0, maxLen).join("");
  }
  const validCoord = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
  const idOk = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v);

  function createData(ctx) {
    const { store, tpl } = ctx;
    const now = () => (ctx.now ? ctx.now() : new Date());
    const HUNT_TYPES = tpl.hunt_types;
    const CATEGORIES = tpl.categories;

    // Все записи идут по одной очереди: чтение-изменение-запись не должны перемешиваться
    let chain = Promise.resolve();
    const locked = (fn) => { const run = chain.then(fn, fn); chain = run.then(() => undefined, () => undefined); return run; };

    // ---------- meta ----------
    const DEFAULT_META = { region: null, tz: null, hunt: "general", loc: null };
    async function getMeta() {
      const m = (await store.get("meta")) || {};
      const meta = Object.assign({}, DEFAULT_META, m);
      if (!(meta.hunt in HUNT_TYPES)) meta.hunt = "general";
      return meta;
    }
    const patchMeta = (patch) => locked(async () => {
      const meta = Object.assign(await getMeta(), patch);
      await store.put("meta", meta);
      return meta;
    });
    async function today() { return D.todayIn((await getMeta()).tz, now()); }

    // ---------- угодья ----------
    const placeJson = (p, def) => ({ id: p.id, key: "p" + p.id, name: p.name, lat: p.lat, lon: p.lon, is_default: p.id === def });
    async function getPlacesRaw() {
      const p = (await store.get("places")) || {};
      return { seq: p.seq || 0, def: p.def == null ? null : p.def, list: Array.isArray(p.list) ? p.list : [] };
    }
    /** Угодья: по умолчанию первым, затем по номеру. */
    async function listPlaces() {
      const raw = await getPlacesRaw();
      const items = raw.list.map((p) => placeJson(p, raw.def));
      return items.sort((a, b) => (b.is_default - a.is_default) || (a.id - b.id));
    }
    const addPlace = (name, lat, lon) => locked(async () => {
      const raw = await getPlacesRaw();
      if (raw.list.length >= LIMITS.MAX_PLACES) fail(400, "too_many", `Можно сохранить не больше ${LIMITS.MAX_PLACES} угодий.`);
      const id = raw.seq + 1;
      raw.seq = id; raw.list.push({ id, name, lat, lon });
      if (raw.def == null) raw.def = id;
      await store.put("places", raw);
      return placeJson(raw.list[raw.list.length - 1], raw.def);
    });
    const updatePlace = (id, { name, makeDefault }) => locked(async () => {
      const raw = await getPlacesRaw();
      const p = raw.list.find((x) => x.id === id);
      if (!p) fail(404, "not_found", "Угодье не найдено.");
      if (name !== undefined) p.name = name;
      if (makeDefault) raw.def = id;
      await store.put("places", raw);
      return placeJson(p, raw.def);
    });
    const deletePlace = (id) => locked(async () => {
      const raw = await getPlacesRaw();
      const i = raw.list.findIndex((x) => x.id === id);
      if (i < 0) fail(404, "not_found", "Угодье не найдено.");
      raw.list.splice(i, 1);
      if (raw.def === id) raw.def = raw.list.length ? Math.min(...raw.list.map((x) => x.id)) : null;   // новое «по умолчанию»
      await store.put("places", raw);
    });

    // ---------- чек-лист ----------
    const ckKey = (hunt) => "ck_" + hunt;
    async function getCk(hunt) {
      const c = (await store.get(ckKey(hunt))) || {};
      return { seq: c.seq || 0, checked: Array.isArray(c.checked) ? c.checked : [], custom: Array.isArray(c.custom) ? c.custom : [] };
    }
    async function checklistPayload() {
      const hunt = (await getMeta()).hunt;
      const ck = await getCk(hunt);
      const template = CL.templateFor(tpl, hunt);
      const checked = new Set(ck.checked);
      const categories = tpl.category_order.map((code) => {
        const items = [
          ...template.filter(([cat]) => cat === code).map(([, key, text]) => ({ id: "t:" + key, text, checked: checked.has(key), custom: false })),
          ...ck.custom.filter((c) => c.cat === code).map((c) => ({ id: "c:" + c.id, text: c.text, checked: !!c.checked, custom: true })),
        ];
        return { code, name: CATEGORIES[code], done: items.filter((i) => i.checked).length, total: items.length, items };
      });
      return {
        hunt_type: hunt,
        hunt_types: Object.entries(HUNT_TYPES).map(([code, name]) => ({ code, name })),
        done: categories.reduce((s, c) => s + c.done, 0), total: categories.reduce((s, c) => s + c.total, 0),
        categories, hints: [],
      };
    }
    const setHuntType = (code) => {
      if (!(code in HUNT_TYPES)) fail(400, "unknown_hunt_type", "Такого вида охоты нет.");
      return patchMeta({ hunt: code });
    };
    const toggleItem = (id) => locked(async () => {
      const hunt = (await getMeta()).hunt;
      const ck = await getCk(hunt);
      let result = null;
      if (typeof id === "string" && id.startsWith("t:")) {
        const key = id.slice(2);
        if (CL.templateFor(tpl, hunt).some(([, k]) => k === key)) {
          const i = ck.checked.indexOf(key);
          if (i >= 0) { ck.checked.splice(i, 1); result = false; } else { ck.checked.push(key); result = true; }
        }
      } else if (typeof id === "string" && id.startsWith("c:")) {
        const item = ck.custom.find((c) => "c:" + c.id === id);
        if (item) { item.checked = !item.checked; result = item.checked; }
      }
      if (result === null) fail(404, "not_found", "Пункт не найден.");
      await store.put(ckKey(hunt), ck);
      return result;
    });
    const addCustomItem = (category, rawText) => locked(async () => {
      const text = cleanText(rawText, LIMITS.ITEM_MAX);
      if (!(category in CATEGORIES)) fail(400, "unknown_category", "Неизвестная категория.");
      if (!text) fail(400, "empty_text", "Введите название пункта.");
      const hunt = (await getMeta()).hunt;
      const ck = await getCk(hunt);
      if (ck.custom.length >= LIMITS.MAX_CUSTOM_ITEMS) fail(400, "too_many", `Можно добавить не больше ${LIMITS.MAX_CUSTOM_ITEMS} своих пунктов.`);
      const id = ck.seq + 1;
      ck.seq = id; ck.custom.push({ id, cat: category, text, checked: false });
      await store.put(ckKey(hunt), ck);
      return { id: "c:" + id, text, checked: false, custom: true, category };
    });
    const deleteCustomItem = (id) => locked(async () => {
      const hunt = (await getMeta()).hunt;
      const ck = await getCk(hunt);
      const i = typeof id === "string" ? ck.custom.findIndex((c) => "c:" + c.id === id) : -1;
      if (i < 0) fail(404, "not_found", "Своего пункта с таким номером нет (пункты шаблона удалить нельзя).");
      ck.custom.splice(i, 1);
      await store.put(ckKey(hunt), ck);
    });
    const resetChecks = () => locked(async () => {
      const hunt = (await getMeta()).hunt;
      const ck = await getCk(hunt);
      ck.checked = []; ck.custom.forEach((c) => { c.checked = false; });
      await store.put(ckKey(hunt), ck);
    });

    // ---------- журнал ----------
    const recJson = (key, v) => ({ id: key, date: v.d, place: v.p, species: v.s, note: v.n || "" });
    const byNewest = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    /** Все записи журнала, новые сверху. */
    async function allRecords() {
      const keys = await store.list("j_");
      const values = await store.getMany(keys);
      return keys.filter((k) => values[k] && values[k].d).map((k) => recJson(k, values[k])).sort(byNewest);
    }
    function newRecordKey(date) {
      const rand = Math.random().toString(36).slice(2, 5).padEnd(3, "0");
      return `j_${date.replace(/-/g, "")}_${Date.now().toString(36)}${rand}`;
    }
    function validateRecord(input, todayIso) {
      const date = typeof input.date === "string" ? D.parseUserDate(input.date, todayIso) : null;
      if (!date) fail(400, "bad_date", "Не понял дату. Формат: ГГГГ-ММ-ДД или ДД.ММ.ГГГГ.");
      if (date > todayIso) fail(400, "future_date", "Дата в будущем — укажите настоящую 🙂");
      const place = cleanText(input.place, LIMITS.PLACE_MAX);
      const species = cleanText(input.species, LIMITS.SPECIES_MAX);
      const note = cleanText(input.note, LIMITS.NOTE_MAX);
      if (!place) fail(400, "empty_place", "Укажите, где охотились.");
      if (!species) fail(400, "empty_species", "Укажите дичь или зверя.");
      return { date, place, species, note };
    }
    const addRecord = (input) => locked(async () => {
      const rec = validateRecord(input, await today());
      const keys = await store.list("j_");
      if (keys.length >= LIMITS.MAX_RECORDS) fail(400, "journal_full", `Достигнут предел журнала: ${LIMITS.MAX_RECORDS} записей. Удалите старые.`);
      const key = newRecordKey(rec.date);
      await store.put(key, { d: rec.date, p: rec.place, s: rec.species, n: rec.note });
      return { id: key, ...rec };
    });
    const deleteRecord = (id) => locked(async () => {
      if (!idOk(id) || !id.startsWith("j_") || !(await store.get(id))) fail(404, "not_found", "Запись не найдена.");
      await store.del(id);
    });

    // ---------- перенос из старой базы (временно, см. README) ----------
    const importLegacy = (legacy) => locked(async () => {
      const report = { places: 0, journal: 0, checklist_custom: 0, checked: 0, skipped: 0 };
      const s = legacy.settings || {};
      const hasMeta = !!(await store.get("meta"));
      const meta = await getMeta();
      const patch = {};
      const regionCodes = new Set((ctx.regions || []).map((r) => r.code));
      if (!meta.region && s.region_code && regionCodes.has(s.region_code)) patch.region = s.region_code;
      if (!meta.tz && TIMEZONES.some((t) => t.code === s.timezone)) patch.tz = s.timezone;
      if ((!hasMeta || meta.hunt === "general") && s.hunt_type in HUNT_TYPES) patch.hunt = s.hunt_type;
      const loc = legacy.location;
      if (!meta.loc && loc && validCoord(loc.lat, -90, 90) !== null && validCoord(loc.lon, -180, 180) !== null)
        patch.loc = { lat: loc.lat, lon: loc.lon, name: cleanText(loc.place || "", 80) || null };
      if (Object.keys(patch).length) await store.put("meta", Object.assign(meta, patch));

      // угодья: добавляем недостающие (по названию и координатам)
      const raw = await getPlacesRaw();
      const hadPlaces = raw.list.length > 0;
      let defaultLegacy = null;
      for (const p of legacy.places || []) {
        const name = cleanText(p.name, LIMITS.PLACE_NAME_MAX);
        if (!name || validCoord(p.lat, -90, 90) === null || validCoord(p.lon, -180, 180) === null) { report.skipped++; continue; }
        let found = raw.list.find((x) => x.name === name && x.lat === p.lat && x.lon === p.lon);
        if (!found) {
          if (raw.list.length >= LIMITS.MAX_PLACES) { report.skipped++; continue; }
          found = { id: ++raw.seq, name, lat: p.lat, lon: p.lon };
          raw.list.push(found); report.places++;
        }
        if (p.is_default) defaultLegacy = found.id;
      }
      if (!hadPlaces && defaultLegacy !== null) raw.def = defaultLegacy;        // основное угодье берём из старой базы
      else if (raw.def == null && raw.list.length) raw.def = raw.list[0].id;
      if (report.places) await store.put("places", raw);

      // чек-лист: отметки шаблона и свои пункты по каждому виду охоты
      const byHunt = {};
      for (const it of legacy.checklist || []) if (it.hunt_type in HUNT_TYPES) (byHunt[it.hunt_type] = byHunt[it.hunt_type] || []).push(it);
      for (const [hunt, items] of Object.entries(byHunt)) {
        const ck = await getCk(hunt);
        const template = CL.templateFor(tpl, hunt);
        let changed = false;
        for (const it of items) {
          if (it.custom) {
            const text = cleanText(it.text, LIMITS.ITEM_MAX);
            if (!text || !(it.category in CATEGORIES) || ck.custom.length >= LIMITS.MAX_CUSTOM_ITEMS) { report.skipped++; continue; }
            if (ck.custom.some((c) => c.cat === it.category && c.text === text)) continue;
            ck.custom.push({ id: ++ck.seq, cat: it.category, text, checked: !!it.checked }); report.checklist_custom++; changed = true;
          } else if (it.checked && template.some(([, k]) => k === it.key) && !ck.checked.includes(it.key)) {
            ck.checked.push(it.key); report.checked++; changed = true;
          }
        }
        if (changed) await store.put(ckKey(hunt), ck);
      }

      // журнал: ключ строится из номера старой записи, поэтому повторный импорт ничего не дублирует
      const have = new Set(await store.list("j_"));
      let count = have.size;
      for (const t of legacy.trophies || []) {
        const date = typeof t.date === "string" ? D.parseUserDate(t.date, "2000-01-01") : null;
        const place = cleanText(t.place, LIMITS.PLACE_MAX), species = cleanText(t.species, LIMITS.SPECIES_MAX);
        if (!date || !place || !species) { report.skipped++; continue; }
        const key = `j_${date.replace(/-/g, "")}_l${Number(t.id || 0).toString(36)}`;
        if (have.has(key)) continue;
        if (count >= LIMITS.MAX_RECORDS) { report.skipped++; continue; }
        await store.put(key, { d: date, p: place, s: species, n: cleanText(t.note, LIMITS.NOTE_MAX) });
        have.add(key); count++; report.journal++;
      }
      return report;
    });

    // ---------- перенос: состояние ----------
    const getMigration = () => store.get("mig");
    const setMigration = (state) => locked(() => store.put("mig", { state, at: now().toISOString() }));

    /** Стирает все данные пользователя. Метка переноса остаётся (она не личная), чтобы старая база не «воскресила» данные. */
    const deleteAll = () => locked(async () => {
      const mig = await store.get("mig");
      const removed = await store.clear(["mig"]);
      if (!mig) await store.put("mig", { state: "skipped", at: now().toISOString() });
      return removed;
    });

    return { LIMITS, TIMEZONES, AUTO_TZ, getMeta, patchMeta, today, listPlaces, addPlace, updatePlace, deletePlace, checklistPayload,
      setHuntType, toggleItem, addCustomItem, deleteCustomItem, resetChecks, allRecords, addRecord, deleteRecord, importLegacy,
      getMigration, setMigration, deleteAll };
  }

  return { LIMITS, TIMEZONES, AUTO_TZ, ApiError, fail, cleanText, validCoord, createData };
});
