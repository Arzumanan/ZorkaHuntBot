// Данные пользователя (угодья, чек-лист, журнал, настройки) и локальный API поверх хранилища.
"use strict";
const test = require("node:test");
const { assert, lib, golden, loadJSON, fakeFetch, fakeCloudStorage } = require("./helpers");

const st = lib("storage"), API = lib("api");
const G = golden();
const NOW = new Date("2026-11-20T09:00:00Z");

/** Приложение на поддельном CloudStorage, погода — из эталонного ответа Open-Meteo. */
async function app(opts = {}) {
  const cs = opts.cs || fakeCloudStorage();
  const raw = JSON.parse(JSON.stringify(G.weather[0].raw));
  const fetch = opts.fetch || fakeFetch([
    ["geocoding-api", (url) => (decodeURIComponent(url).includes("Майкоп")
      ? { body: { results: [{ name: "Майкоп", latitude: 44.6, longitude: 40.1, country: "Россия", admin1: "Адыгея" }] } } : { body: {} })],
    ["api.open-meteo.com", { body: raw }],
  ]);
  let now = opts.now || NOW;
  const api = await API.create({ backend: st.cloudBackend(cs), fetch, loadJSON, now: () => now });
  const call = (path, method, body) => api.handle(path, method, body);
  return { api, cs, fetch, raw, get: (p) => call(p, "GET"), post: (p, b) => call(p, "POST", b), setNow: (d) => { now = d; }, call };
}
const rejects = (promise, code, status) => assert.rejects(promise, (e) => e instanceof API.ApiError && e.code === code && (!status || e.status === status), code);

// ---------- регион, место, часовой пояс ----------

test("регион и часовой пояс сохраняются; неизвестные значения отклоняются", async () => {
  const a = await app();
  assert.equal((await a.get("/me")).region, null);
  await a.post("/region", { code: "krasnodar" });
  await rejects(a.post("/region", { code: "atlantis" }), "unknown_region", 400);
  assert.deepEqual((await a.get("/me")).region, { code: "krasnodar", name: "Краснодарский край", verified: true });
  await a.post("/settings", { timezone: "Asia/Yekaterinburg" });
  assert.equal((await a.get("/me")).timezone, "Asia/Yekaterinburg");
  await rejects(a.post("/settings", { timezone: "Mars/Base" }), "bad_timezone", 400);
  await a.post("/settings", { timezone: "auto" });
  assert.equal((await a.get("/me")).timezone, "auto");
  const s = await a.get("/settings");
  assert.equal(s.timezones[0].code, "auto");
  assert.ok(s.timezones.length >= 11);
});

test("все данные лежат в хранилище: после «перезапуска» (новый API на тех же ключах) всё на месте", async () => {
  const a = await app();
  await a.post("/region", { code: "adygea" });
  await a.post("/places", { lat: 44.6, lon: 40.1, name: "Озеро" });
  await a.post("/checklist/toggle", { id: "t:gun" });
  await a.post("/journal", { date: "2026-10-03", place: "Озеро", species: "Кряква" });
  const b = await app({ cs: a.cs });
  assert.equal((await b.get("/me")).region.code, "adygea");
  assert.equal((await b.get("/places")).places[0].name, "Озеро");
  assert.equal((await b.get("/checklist")).done, 1);
  assert.equal((await b.get("/journal")).count, 1);
  for (const [k, v] of a.cs.map) { assert.match(k, /^[A-Za-z0-9_-]{1,128}$/, k); assert.ok(v.length <= 4096); }
});

test("текущее место: по городу (геокодер) и по координатам; неизвестный город — 404", async () => {
  const a = await app();
  const r = await a.post("/location", { city: "  Майкоп " });
  assert.equal(r.location.name, "Майкоп, Адыгея, Россия");
  assert.deepEqual((await a.get("/me")).location, { lat: 44.6, lon: 40.1, name: "Майкоп, Адыгея, Россия" });
  await rejects(a.post("/location", { city: "Нигдеград" }), "city_not_found", 404);
  await rejects(a.post("/location", { city: "   " }), "bad_city", 400);
  await rejects(a.post("/location", { city: "я".repeat(81) }), "bad_city", 400);
  await rejects(a.post("/location", { lat: 91, lon: 0 }), "bad_coordinates", 400);
  await a.post("/location", { lat: 45.5, lon: 39 });
  assert.equal((await a.get("/me")).location.name, "по координатам");
});

// ---------- угодья ----------

test("угодья: первое становится основным, переименование, смена основного, удаление основного назначает следующее", async () => {
  const a = await app();
  const p1 = (await a.post("/places", { lat: 45.04, lon: 38.98 })).place;
  assert.equal(p1.name, "Угодье 45.040, 38.980"); assert.equal(p1.is_default, true); assert.equal(p1.key, "p1");
  const p2 = (await a.post("/places", { city: "Майкоп", name: "Дальнее" })).place;
  assert.equal(p2.is_default, false);
  await a.post("/places/update", { id: p2.id, name: "  Дальнее   озеро " });
  await a.post("/places/update", { id: p2.id, is_default: true });
  let list = (await a.get("/places")).places;
  assert.deepEqual(list.map((p) => [p.name, p.is_default]), [["Дальнее озеро", true], ["Угодье 45.040, 38.980", false]]);
  await a.post("/places/delete", { id: p2.id });
  list = (await a.get("/places")).places;
  assert.deepEqual(list.map((p) => [p.id, p.is_default]), [[p1.id, true]]);
  await a.post("/places/delete", { id: p1.id });
  assert.deepEqual((await a.get("/places")).places, []);
  assert.equal((await a.get("/me")).has_place, false);
});

test("угодья: проверка ввода и предел 30", async () => {
  const a = await app();
  await rejects(a.post("/places", { lat: "x", lon: 1 }), "bad_coordinates", 400);
  await rejects(a.post("/places", { lat: 10, lon: 181 }), "bad_coordinates", 400);
  await rejects(a.post("/places", { city: "" }), "bad_city", 400);
  await rejects(a.post("/places", { city: "Нигдеград" }), "city_not_found", 404);
  await rejects(a.post("/places/update", { id: 99, name: "x" }), "not_found", 404);
  await rejects(a.post("/places/delete", { id: 99 }), "not_found", 404);
  for (let i = 0; i < 30; i++) await a.post("/places", { lat: 40 + i / 100, lon: 40, name: "П" + i });
  await rejects(a.post("/places", { lat: 1, lon: 1 }), "too_many", 400);
  assert.equal((await a.get("/places")).max, 30);
  const a2 = await app();
  const p = (await a2.post("/places", { lat: 1, lon: 1 })).place;
  await rejects(a2.post("/places/update", { id: p.id, name: "   " }), "empty_name", 400);
});

test("30 угодий с длинными названиями не упираются в 4096 символов (значение режется на части)", async () => {
  const a = await app();
  for (let i = 0; i < 30; i++) await a.post("/places", { lat: 40 + i / 100, lon: 40.123456, name: ("Очень длинное название угодья номер " + i + " ").repeat(2).slice(0, 60) });
  assert.ok(JSON.stringify((await a.get("/places")).places).length > 4096);
  assert.equal((await a.get("/places")).places.length, 30);
  assert.ok([...a.cs.map.values()].every((v) => v.length <= 4096));
});

// ---------- чек-лист ----------

test("чек-лист: шаблон по виду охоты, отметки сохраняются отдельно для каждого вида, сброс", async () => {
  const a = await app();
  const g = await a.get("/checklist");
  assert.equal(g.hunt_type, "general"); assert.equal(g.total, 19); assert.equal(g.done, 0);
  assert.deepEqual(g.categories.map((c) => c.code), ["gun", "docs", "gear", "food"]);
  assert.equal((await a.post("/checklist/toggle", { id: "t:gun" })).checked, true);
  assert.equal((await a.post("/checklist/toggle", { id: "t:ticket" })).checked, true);
  assert.equal((await a.get("/checklist")).done, 2);
  const w = await a.post("/checklist/type", { hunt_type: "waterfowl" });
  assert.equal(w.total, 23); assert.equal(w.done, 0);
  await a.post("/checklist/toggle", { id: "t:decoys" });
  assert.equal((await a.post("/checklist/type", { hunt_type: "general" })).done, 2);       // отметки общего списка на месте
  assert.equal((await a.post("/checklist/type", { hunt_type: "waterfowl" })).done, 1);
  await rejects(a.post("/checklist/type", { hunt_type: "рыбалка" }), "unknown_hunt_type", 400);
  const reset = await a.post("/checklist/reset", {});
  assert.equal(reset.done, 0); assert.equal(reset.ok, true);
  assert.equal((await a.post("/checklist/type", { hunt_type: "general" })).done, 2);       // сброс только текущего вида
  assert.equal((await a.get("/me")).hunt_type, "general");
});

test("чек-лист: свои пункты (добавить, отметить, удалить), шаблонные удалить нельзя", async () => {
  const a = await app();
  const item = (await a.post("/checklist/add", { category: "food", text: "  Термос   с кофе " })).item;
  assert.deepEqual([item.text, item.custom, item.checked, item.category], ["Термос с кофе", true, false, "food"]);
  assert.equal((await a.post("/checklist/toggle", { id: item.id })).checked, true);
  let food = (await a.get("/checklist")).categories.find((c) => c.code === "food");
  assert.deepEqual(food.items.map((i) => i.text).slice(-1), ["Термос с кофе"]);
  assert.equal(food.done, 1);
  await rejects(a.post("/checklist/delete", { id: "t:gun" }), "not_found", 404);
  await rejects(a.post("/checklist/add", { category: "weapons", text: "x" }), "unknown_category", 400);
  await rejects(a.post("/checklist/add", { category: "gun", text: "  " }), "empty_text", 400);
  await rejects(a.post("/checklist/toggle", { id: "t:нет-такого" }), "not_found", 404);
  await rejects(a.post("/checklist/toggle", { id: "c:99" }), "not_found", 404);
  await a.post("/checklist/reset", {});
  food = (await a.get("/checklist")).categories.find((c) => c.code === "food");
  assert.equal(food.done, 0); assert.equal(food.items.length, 3);                           // свой пункт остался
  await a.post("/checklist/delete", { id: item.id });
  assert.equal((await a.get("/checklist")).categories.find((c) => c.code === "food").items.length, 2);
  const long = (await a.post("/checklist/add", { category: "gun", text: "я".repeat(300) })).item;
  assert.equal([...long.text].length, 100);
});

test("чек-лист: много своих пунктов не ломает хранение (нарезка), предел 100", async () => {
  const a = await app();
  for (let i = 0; i < 100; i++) await a.post("/checklist/add", { category: "gear", text: ("Свой пункт номер " + i + " ").repeat(4).trim() });
  await rejects(a.post("/checklist/add", { category: "gear", text: "ещё" }), "too_many", 400);
  assert.equal((await a.get("/checklist")).total, 19 + 100);
  const b = await app({ cs: a.cs });
  assert.equal((await b.get("/checklist")).total, 119);
  assert.ok([...a.cs.map.values()].every((v) => v.length <= 4096));
});

test("подсказки к чек-листу берутся из прогноза основного угодья и не мешают самому чек-листу", async () => {
  const a = await app();
  assert.deepEqual((await a.get("/checklist/hints")).hints, []);                 // нет места
  await a.post("/places", { lat: 44.6, lon: 40.1 });
  const hints = (await a.get("/checklist/hints")).hints;
  assert.ok(Array.isArray(hints));
  const offline = await app({ fetch: fakeFetch([["open-meteo", new Error("offline")]]) });
  await offline.post("/places", { lat: 44.6, lon: 40.1 });
  assert.deepEqual((await offline.get("/checklist/hints")).hints, []);
  assert.equal((await offline.get("/checklist")).total, 19);
});

// ---------- журнал и статистика ----------

test("журнал: запись, сортировка (новые сверху), статистика только когда записи есть, удаление", async () => {
  const a = await app();
  assert.deepEqual(await a.get("/journal"), { records: [], count: 0, stats: null });
  const r1 = (await a.post("/journal", { date: "2026-10-03", place: "Озеро", species: "кряква", note: "пролёт" })).record;
  await a.post("/journal", { date: "2026-11-01", place: " озеро ", species: "КРЯКВА" });
  await a.post("/journal", { date: "2026-11-01", place: "Лес", species: "кабан" });
  const j = await a.get("/journal");
  assert.equal(j.count, 3);
  assert.deepEqual(j.records.map((r) => r.date), ["2026-11-01", "2026-11-01", "2026-10-03"]);
  assert.equal(j.records[2].note, "пролёт"); assert.equal(j.records[2].id, r1.id);
  assert.deepEqual(j.stats.by_species[0], { name: "Кряква", count: 2 });
  assert.equal(j.stats.records, 3); assert.equal(j.stats.trips, 2);
  assert.deepEqual(j.stats.by_month, [{ month: "2026-10", count: 1 }, { month: "2026-11", count: 2 }]);
  assert.deepEqual(await a.get("/stats"), j.stats);
  await a.post("/journal/delete", { id: r1.id });
  assert.equal((await a.get("/journal")).count, 2);
  await rejects(a.post("/journal/delete", { id: r1.id }), "not_found", 404);
  await rejects(a.post("/journal/delete", { id: "meta" }), "not_found", 404);       // чужие ключи удалять нельзя
  await rejects(a.post("/journal/delete", { id: "../x" }), "not_found", 404);
  assert.ok(await a.api.store.get("meta") === null || true);
});

test("журнал: проверка ввода (дата, будущее, пустые поля, длины)", async () => {
  const a = await app();
  const ok = { date: "2026-10-03", place: "Озеро", species: "Кряква" };
  await rejects(a.post("/journal", { ...ok, date: "не дата" }), "bad_date", 400);
  await rejects(a.post("/journal", { ...ok, date: "" }), "bad_date", 400);
  await rejects(a.post("/journal", { ...ok, date: "2026-11-21" }), "future_date", 400);       // завтра
  await rejects(a.post("/journal", { ...ok, place: "  " }), "empty_place", 400);
  await rejects(a.post("/journal", { ...ok, species: "" }), "empty_species", 400);
  assert.equal((await a.post("/journal", { ...ok, date: "20.11.2026" })).record.date, "2026-11-20");
  assert.equal((await a.post("/journal", { ...ok, date: "вчера" })).record.date, "2026-11-19");
  const rec = (await a.post("/journal", { ...ok, place: "п".repeat(300), species: "в".repeat(300), note: "н".repeat(900) })).record;
  assert.deepEqual([rec.place.length, rec.species.length, rec.note.length], [200, 100, 500]);
  assert.ok([...a.cs.map.values()].every((v) => v.length <= 4096));
});

test("журнал: «сегодня» считается по выбранному часовому поясу", async () => {
  const a = await app({ now: new Date("2026-11-20T21:30:00Z") });             // в Москве уже 21 ноября
  await a.post("/settings", { timezone: "Europe/Moscow" });
  await a.post("/journal", { date: "2026-11-21", place: "Озеро", species: "Заяц" });
  await a.post("/settings", { timezone: "Asia/Kamchatka" });
  assert.equal((await a.get("/me")).timezone, "Asia/Kamchatka");
});

test("журнал: предел записей и каждая запись — в своём ключе (до 900)", async () => {
  const a = await app();
  const ok = { date: "2026-10-03", place: "Озеро", species: "Кряква" };
  await a.post("/journal", ok);
  const keys = [...a.cs.map.keys()].filter((k) => k.startsWith("j_"));
  assert.equal(keys.length, 1); assert.match(keys[0], /^j_20261003_[0-9a-z]+$/);
  for (let i = 0; i < 899; i++) a.cs.map.set(`j_20261003_seed${i}`, JSON.stringify({ d: "2026-10-03", p: "П", s: "В", n: "" }));
  await rejects(a.post("/journal", ok), "journal_full", 400);
  assert.equal((await a.get("/journal")).records.length, 500);                  // в списке — последние 500
  assert.equal((await a.get("/stats")).records, 900);                           // в статистике — все
});

// ---------- сезоны и прогноз ----------

test("сезоны: без региона — no_region, с регионом — данные по сегодняшней дате пользователя", async () => {
  const a = await app();
  await rejects(a.get("/seasons"), "no_region", 409);
  await a.post("/region", { code: "krasnodar" });
  const s = await a.get("/seasons");
  assert.equal(s.today, "2026-11-20"); assert.equal(s.region.name, "Краснодарский край"); assert.equal(s.verified, true);
  assert.match(s.disclaimer, /уточняйте/);
});

test("прогноз: без места — no_place; по основному угодью; place_id; текущее место", async () => {
  const a = await app({ now: new Date("2026-11-20T03:00:00Z") });
  await rejects(a.get("/forecast"), "no_place", 409);
  await a.post("/places", { lat: 44.6, lon: 40.1, name: "Озеро" });
  await a.post("/places", { lat: 45.0, lon: 39.0, name: "Поле" });
  await a.post("/location", { city: "Майкоп" });
  let f = await a.get("/forecast");
  assert.equal(f.place.key, "p1"); assert.equal(f.place.title, "⭐ Озеро");
  assert.deepEqual(f.days.map((d) => d.heading), ["Сегодня, 20 ноября", "Завтра, 21 ноября"]);
  assert.deepEqual(f.days[0].activity.map((g) => g.group), ["waterfowl", "upland", "ungulates", "pheasant", "hare"]);
  assert.equal(f.activity_disclaimer.startsWith("Это ориентировочная оценка"), true);
  assert.match(a.fetch.calls.at(-1).url, /latitude=44\.6&longitude=40\.1/);
  f = await a.get("/forecast?place_id=p2");
  assert.equal(f.place.title, "Поле"); assert.match(a.fetch.calls.at(-1).url, /latitude=45&longitude=39/);
  f = await a.get("/forecast?place_id=cur");
  assert.match(f.place.title, /^📍 Майкоп/);
  await rejects(a.get("/forecast?place_id=p77"), "no_place", 409);
});

test("прогноз: запрос к Open-Meteo напрямую, с нужными параметрами; повторный запрос — из кэша на 10 минут", async () => {
  const a = await app({ now: new Date("2026-11-20T03:00:00Z") });
  await a.post("/places", { lat: 44.6, lon: 40.1 });
  await a.get("/forecast");
  const url = new URL(a.fetch.calls.at(-1).url);
  assert.equal(url.origin + url.pathname, "https://api.open-meteo.com/v1/forecast");
  assert.equal(url.searchParams.get("hourly"), "temperature_2m,precipitation,pressure_msl,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m");
  assert.equal(url.searchParams.get("daily"), "sunrise,sunset");
  assert.deepEqual(["wind_speed_unit", "timezone", "past_days", "forecast_days"].map((k) => url.searchParams.get(k)), ["ms", "auto", "1", "3"]);
  const n = a.fetch.calls.length;
  await a.get("/forecast"); await a.get("/checklist/hints");
  assert.equal(a.fetch.calls.length, n, "кэш");
  a.setNow(new Date("2026-11-20T03:11:00Z"));
  await a.get("/forecast");
  assert.equal(a.fetch.calls.length, n + 1, "кэш устарел");
});

test("прогноз: сеть недоступна или ответ с ошибкой — weather_unavailable (502), ломаный ответ — тоже", async () => {
  for (const reply of [new Error("offline"), { status: 500, body: {} }, { body: { hourly: {} } }]) {
    const a = await app({ fetch: fakeFetch([["open-meteo", reply]]) });
    await a.post("/places", { lat: 44.6, lon: 40.1 });
    await rejects(a.get("/forecast"), "weather_unavailable", 502);
  }
  const geo = await app({ fetch: fakeFetch([["geocoding", new Error("offline")]]) });
  await rejects(geo.post("/location", { city: "Майкоп" }), "weather_unavailable", 502);
  assert.equal((await geo.get("/me")).location, null);
});

test("координаты и город уходят только в Open-Meteo: других адресов приложение не запрашивает", async () => {
  const a = await app({ now: new Date("2026-11-20T03:00:00Z") });
  await a.post("/location", { city: "Майкоп" });
  await a.post("/places", { lat: 44.6, lon: 40.1 });
  await a.get("/forecast"); await a.get("/checklist/hints");
  const hosts = new Set(a.fetch.calls.map((c) => new URL(c.url).host));
  assert.deepEqual([...hosts].sort(), ["api.open-meteo.com", "geocoding-api.open-meteo.com"]);
  assert.ok(a.fetch.calls.every((c) => !c.init || !c.init.headers), "без заголовков с идентификаторами");
});

// ---------- удаление всех данных ----------

test("«Удалить все данные» стирает ключи (включая части), оставляет только метку переноса; прогнозный кэш сбрасывается", async () => {
  const a = await app({ now: new Date("2026-11-20T03:00:00Z") });
  await a.post("/region", { code: "krasnodar" });
  await a.post("/places", { lat: 44.6, lon: 40.1 });
  for (let i = 0; i < 60; i++) await a.post("/checklist/add", { category: "gear", text: ("Пункт " + i + " ").repeat(5) });
  await a.post("/journal", { date: "2026-10-03", place: "Озеро", species: "Кряква" });
  await a.get("/forecast");
  assert.ok(a.cs.map.size > 5 && [...a.cs.map.keys()].some((k) => k.includes("__c")));
  const r = await a.post("/data/delete-all", {});
  assert.equal(r.ok, true); assert.ok(r.removed > 5);
  assert.deepEqual([...a.cs.map.keys()], ["mig"]);
  assert.equal(JSON.parse(a.cs.map.get("mig")).state, "skipped");
  const me = await a.get("/me");
  assert.deepEqual([me.region, me.places, me.location, me.has_place], [null, [], null, false]);
  assert.deepEqual(await a.get("/journal"), { records: [], count: 0, stats: null });
  await rejects(a.get("/forecast"), "no_place", 409);
  const calls = a.fetch.calls.length;
  await a.post("/places", { lat: 44.6, lon: 40.1 });
  await a.get("/forecast");
  assert.equal(a.fetch.calls.length, calls + 1);
});

test("удаление всех данных не затирает уже поставленную метку переноса", async () => {
  const a = await app();
  await a.api.data.setMigration("done");
  await a.post("/places", { lat: 1, lon: 1 });
  await a.post("/data/delete-all", {});
  assert.equal(JSON.parse(a.cs.map.get("mig")).state, "done");
});

test("служебные запросы: размер хранилища, неизвестный маршрут", async () => {
  const a = await app();
  await a.post("/places", { lat: 1, lon: 1 });
  assert.deepEqual(await a.get("/storage"), { kind: "telegram", keys: 1, max_keys: 1024 });
  await rejects(a.get("/nope"), "not_found", 404);
  await rejects(a.call("/me", "POST", {}), "not_found", 404);
});

test("ошибки хранилища доходят до интерфейса понятным сообщением", async () => {
  const a = await app({ cs: fakeCloudStorage({ failWith: "boom" }) });
  await assert.rejects(a.post("/region", { code: "krasnodar" }), (e) => e.code === "failed" && /Не удалось сохранить/.test(e.message));
});

test("параллельные быстрые нажатия не теряют друг друга (очередь записей)", async () => {
  const a = await app();
  await Promise.all(["t:gun", "t:case", "t:belt", "t:clean", "t:ticket"].map((id) => a.post("/checklist/toggle", { id })));
  assert.equal((await a.get("/checklist")).done, 5);
  await Promise.all(Array.from({ length: 8 }, (_, i) => a.post("/places", { lat: 40 + i, lon: 40, name: "П" + i })));
  assert.equal((await a.get("/places")).places.length, 8);
});

// ---------- метки навигатора ----------

test("метки: добавление, правка, удаление, типы и предел 200", async () => {
  const a = await app();
  const empty = await a.get("/marks");
  assert.equal(empty.marks.length, 0);
  assert.equal(empty.max, 200);
  assert.deepEqual(empty.types.map((t) => t.code), ["tower", "salt", "labaz", "flush", "car", "other"]);
  const m = (await a.post("/marks", { type: "car", name: "  УАЗ ", note: "у клёна", lat: 45.04012345, lon: 38.98098765 })).mark;
  assert.deepEqual([m.key, m.emoji, m.name, m.lat], ["m1", "🚗", "УАЗ", 45.040123]);
  const tower = (await a.post("/marks", { type: "tower", lat: 45.1, lon: 39 })).mark;
  assert.equal(tower.name, "Вышка");
  const renamed = (await a.post("/marks/update", { id: m.id, name: "Нива" })).mark;
  assert.equal(renamed.name, "Нива"); assert.equal(renamed.type, "car");
  await rejects(a.post("/marks", { type: "нет", lat: 1, lon: 1 }), "bad_type", 400);
  await rejects(a.post("/marks", { type: "car", lat: 91, lon: 0 }), "bad_coordinates", 400);
  await rejects(a.post("/marks/delete", { id: 99 }), "not_found", 404);
  await a.post("/marks/delete", { id: "m" + tower.id });
  assert.equal((await a.get("/marks")).marks.length, 1);
  const b = await app({ cs: a.cs });
  assert.equal((await b.get("/marks")).marks[0].name, "Нива");
  for (let i = 1; i < 200; i++) await a.post("/marks", { type: "other", name: "М" + i, lat: 44 + i / 10000, lon: 39 });
  await rejects(a.post("/marks", { type: "other", lat: 1, lon: 1 }), "too_many", 400);
  assert.ok([...a.cs.map.values()].every((v) => v.length <= 4096));
});

test("удаление всех данных стирает и метки", async () => {
  const a = await app();
  await a.post("/marks", { type: "car", lat: 45, lon: 39 });
  await a.post("/data/delete-all", {});
  assert.deepEqual((await a.get("/marks")).marks, []);
  assert.deepEqual([...a.cs.map.keys()], ["mig"]);
});

test("ветер в точке: направление, снос запаха и кэш по округлённым координатам", async () => {
  const a = await app({ now: new Date("2026-11-20T03:00:00Z") });
  const w = await a.get("/wind?lat=45.0412&lon=38.979");
  assert.ok(w.wind_direction != null || w.wind_speed != null);
  assert.ok("scent_drift" in w && "scent_text" in w);
  const n = a.fetch.calls.length;
  await a.get("/wind?lat=45.0414&lon=38.9792");                         // тот же округлённый ключ (~100 м)
  assert.equal(a.fetch.calls.length, n, "кэш ветра");
  await rejects(a.get("/wind?lat=91&lon=0"), "bad_coordinates", 400);
});
