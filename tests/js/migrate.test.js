// ВРЕМЕННЫЙ перенос из старой базы: импорт (слияние, идемпотентность) и сценарии запуска. Удалить вместе с lib/migrate.js.
"use strict";
const test = require("node:test");
const { assert, lib, loadJSON, fakeFetch, fakeCloudStorage } = require("./helpers");

const st = lib("storage"), API = lib("api"), M = lib("migrate");
const NOW = new Date("2026-11-20T09:00:00Z");
const LEGACY = {
  user_id: 5,
  settings: { region_code: "krasnodar", timezone: "Europe/Moscow", hunt_type: "waterfowl" },
  location: { lat: 45.04, lon: 38.98, place: "Краснодар" },
  places: [{ id: 1, name: "Озеро", lat: 45.1, lon: 38.9, is_default: false }, { id: 2, name: "Плавни", lat: 45.3, lon: 38.5, is_default: true },
           { id: 3, name: "", lat: 1, lon: 1, is_default: false }],
  trophies: [{ id: 7, date: "2026-10-03", place: "Озеро", species: "кряква", note: "пролёт" }, { id: 8, date: "2026-11-01", place: "Плавни", species: "кабан", note: "" },
             { id: 9, date: "ерунда", place: "x", species: "y", note: "" }],
  checklist: [
    { hunt_type: "waterfowl", category: "gun", key: "gun", text: "Ружьё", checked: true, custom: false },
    { hunt_type: "waterfowl", category: "food", key: null, text: "Термос", checked: true, custom: true },
    { hunt_type: "general", category: "gear", key: "нет-такого", text: "?", checked: true, custom: false },
  ],
};
const copy = (o) => JSON.parse(JSON.stringify(o));

async function setup(cs = fakeCloudStorage()) {
  const api = await API.create({ backend: st.cloudBackend(cs), fetch: fakeFetch([]), loadJSON, now: () => NOW });
  return { api, cs, data: api.data };
}
const json = (status, body) => ({ status, body });

test("импорт: настройки, угодья (основное из старой базы), журнал, отметки и свои пункты чек-листа", async () => {
  const { api, data } = await setup();
  const rep = await data.importLegacy(copy(LEGACY));
  assert.deepEqual(rep, { places: 2, journal: 2, checklist_custom: 1, checked: 1, skipped: 2 });
  const me = await api.handle("/me", "GET");
  assert.deepEqual([me.region.code, me.timezone, me.hunt_type, me.location.name], ["krasnodar", "Europe/Moscow", "waterfowl", "Краснодар"]);
  assert.deepEqual(me.places.map((p) => [p.name, p.is_default]), [["Плавни", true], ["Озеро", false]]);   // основное — первым
  const j = await api.handle("/journal", "GET");
  assert.deepEqual(j.records.map((r) => [r.date, r.species]), [["2026-11-01", "кабан"], ["2026-10-03", "кряква"]]);
  const ck = await api.handle("/checklist", "GET");
  assert.equal(ck.done, 2);                                              // «ружьё» + свой «Термос»
  assert.ok(ck.categories.find((c) => c.code === "food").items.some((i) => i.custom && i.text === "Термос" && i.checked));
});

test("повторный импорт ничего не дублирует", async () => {
  const { api, data } = await setup();
  await data.importLegacy(copy(LEGACY));
  const before = (await api.handle("/journal", "GET")).count;
  const rep = await data.importLegacy(copy(LEGACY));
  assert.deepEqual([rep.places, rep.journal, rep.checklist_custom, rep.checked], [0, 0, 0, 0]);
  assert.equal((await api.handle("/journal", "GET")).count, before);
  assert.equal((await api.handle("/places", "GET")).places.length, 2);
});

test("импорт не затирает то, что пользователь уже настроил в новом приложении", async () => {
  const { api, data } = await setup();
  await api.handle("/region", "POST", { code: "adygea" });
  await api.handle("/places", "POST", { lat: 1, lon: 2, name: "Моё" });
  await api.handle("/checklist/type", "POST", { hunt_type: "upland" });
  await data.importLegacy(copy(LEGACY));
  const me = await api.handle("/me", "GET");
  assert.equal(me.region.code, "adygea"); assert.equal(me.hunt_type, "upland");
  assert.deepEqual(me.places.map((p) => [p.name, p.is_default]), [["Моё", true], ["Озеро", false], ["Плавни", false]]);
});

test("импорт отбрасывает мусор: неизвестный регион/пояс, неверные координаты, лишнее сверх лимитов", async () => {
  const { api, data } = await setup();
  const bad = { settings: { region_code: "atlantis", timezone: "Mars/Base", hunt_type: "fishing" }, location: { lat: 999, lon: 0, place: "x" },
    places: Array.from({ length: 40 }, (_, i) => ({ id: i, name: "П" + i, lat: 40 + i / 100, lon: 40, is_default: false })),
    trophies: [], checklist: [] };
  const rep = await data.importLegacy(bad);
  assert.equal(rep.places, 30); assert.equal(rep.skipped, 10);
  const me = await api.handle("/me", "GET");
  assert.deepEqual([me.region, me.location], [null, null]);
});

test("запуск вне Telegram (нет initData): ничего не делаем и не ходим на сервер", async () => {
  const { data } = await setup();
  const fetch = fakeFetch([]);
  assert.deepEqual(await M.run({ data, fetch, base: "", initData: "" }), { status: "browser" });
  assert.equal(fetch.calls.length, 0);
});

test("сервер ответил «данных нет» (JSON-404): ставим skipped и больше не спрашиваем", async () => {
  for (const code of ["no_legacy_db", "no_legacy_data"]) {
    const { data } = await setup();
    const fetch = fakeFetch([["/api/legacy-export", json(404, { error: code })]]);
    assert.deepEqual(await M.run({ data, fetch, base: "https://t.example", initData: "q=1" }), { status: "none" });
    assert.equal((await data.getMigration()).state, "skipped");
    assert.deepEqual(await M.run({ data, fetch, base: "https://t.example", initData: "q=1" }), { status: "skipped" });
    assert.equal(fetch.calls.length, 1);
  }
});

test("запрос подписан initData и идёт на заданный базовый адрес", async () => {
  const { data } = await setup();
  const fetch = fakeFetch([["/api/legacy-export", json(404, { error: "no_legacy_db" })]]);
  await M.run({ data, fetch, base: "https://t.example", initData: "user=%7B%7D&hash=abc" });
  assert.equal(fetch.calls[0].url, "https://t.example/api/legacy-export");
  assert.equal(fetch.calls[0].init.headers["X-Telegram-Init-Data"], "user=%7B%7D&hash=abc");
});

test("успех: импорт в CloudStorage, затем /done; метка done; повторный запуск молчит", async () => {
  const { api, cs, data } = await setup();
  const fetch = fakeFetch([["legacy-export/done", json(200, { ok: true })], ["/api/legacy-export", json(200, copy(LEGACY))]]);
  const r = await M.run({ data, fetch, base: "", initData: "q=1" });
  assert.equal(r.status, "imported"); assert.equal(r.cleaned, true); assert.equal(r.report.journal, 2);
  assert.deepEqual(fetch.calls.map((c) => [c.init.method, c.url]), [["GET", "/api/legacy-export"], ["POST", "/api/legacy-export/done"]]);
  assert.equal(JSON.parse(cs.map.get("mig")).state, "done");
  assert.equal((await api.handle("/journal", "GET")).count, 2);
  assert.deepEqual(await M.run({ data, fetch, base: "", initData: "q=1" }), { status: "done" });
  assert.equal(fetch.calls.length, 2);
});

test("если /done не удался: данные уже в CloudStorage, на следующем запуске повторяется только /done", async () => {
  const { api, data } = await setup();
  let doneOk = false;
  const fetch = fakeFetch([["legacy-export/done", () => (doneOk ? json(200, { ok: true }) : new Error("offline"))], ["/api/legacy-export", json(200, copy(LEGACY))]]);
  assert.equal((await M.run({ data, fetch, base: "", initData: "q=1" })).status, "error");
  assert.equal((await data.getMigration()).state, "imported");
  assert.equal((await api.handle("/journal", "GET")).count, 2);
  doneOk = true;
  const second = await M.run({ data, fetch, base: "", initData: "q=1" });
  assert.equal(second.status, "imported");
  assert.equal((await data.getMigration()).state, "done");
  assert.deepEqual(fetch.calls.filter((c) => c.url === "/api/legacy-export").length, 1);   // повторно не качаем
  assert.equal((await api.handle("/journal", "GET")).count, 2);
});

test("HTML-404 статического хостинга, 5xx и обрыв сети не считаются «данных нет»: метку не ставим", async () => {
  for (const reply of [{ status: 404, html: true }, json(500, { error: "boom" }), json(401, { error: "bad_auth" }), new Error("offline"), json(404, { error: "not_found" })]) {
    const { cs, data } = await setup();
    const fetch = fakeFetch([["/api/legacy-export", reply]]);
    const r = await M.run({ data, fetch, base: "", initData: "q=1" });
    assert.equal(r.status, "error");
    assert.equal(cs.map.has("mig"), false);
  }
});

test("после «Удалить все данные» старая база не воскрешает данные", async () => {
  const { api, cs, data } = await setup();
  await api.handle("/places", "POST", { lat: 1, lon: 1 });
  await api.handle("/data/delete-all", "POST", {});
  const fetch = fakeFetch([["/api/legacy-export", json(200, copy(LEGACY))]]);
  assert.deepEqual(await M.run({ data, fetch, base: "", initData: "q=1" }), { status: "skipped" });
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual([...cs.map.keys()], ["mig"]);
});

test("cleanupServer: просит сервер стереть строки пользователя, не падает без сети и вне Telegram", async () => {
  const fetch = fakeFetch([["legacy-export/done", json(200, { ok: true })]]);
  assert.equal(await M.cleanupServer({ fetch, base: "", initData: "q=1" }), true);
  assert.equal(fetch.calls[0].init.method, "POST");
  assert.equal(await M.cleanupServer({ fetch: fakeFetch([["x", new Error("e")]]), base: "", initData: "q=1" }), false);
  assert.equal(await M.cleanupServer({ fetch, base: "", initData: "" }), false);
});
