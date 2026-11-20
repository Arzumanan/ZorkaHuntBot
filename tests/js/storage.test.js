// Слой хранения: CloudStorage (поддельный, с лимитами Telegram), нарезка больших значений, выбор бэкенда, ошибки.
"use strict";
const test = require("node:test");
const { assert, lib, fakeCloudStorage } = require("./helpers");

const st = lib("storage");
const cloudStore = (opts) => { const cs = fakeCloudStorage(opts); return { cs, store: st.createStore(st.cloudBackend(cs)) }; };
const big = (n, ch = "Я") => ch.repeat(n);

test("запись и чтение JSON; отсутствующий ключ — null (CloudStorage отдаёт пустую строку)", async () => {
  const { store } = cloudStore();
  assert.equal(await store.get("meta"), null);
  await store.put("meta", { region: "krasnodar", tz: null, n: [1, 2], s: "Привет 🦆" });
  assert.deepEqual(await store.get("meta"), { region: "krasnodar", tz: null, n: [1, 2], s: "Привет 🦆" });
  assert.deepEqual(await store.getMany(["meta", "нет"].map((k) => k.replace("нет", "none"))), { meta: { region: "krasnodar", tz: null, n: [1, 2], s: "Привет 🦆" }, none: null });
});

test("значение больше 4096 символов режется на части и собирается обратно без потерь", async () => {
  const { cs, store } = cloudStore();
  const value = { items: Array.from({ length: 300 }, (_, i) => ({ id: i, text: "Пункт чек-листа №" + i + " " + big(30, "ж") })) };
  assert.ok(JSON.stringify(value).length > 4096 * 3);
  await store.put("ck_general", value);
  assert.deepEqual(await store.get("ck_general"), value);
  for (const [k, v] of cs.map) assert.ok(v.length <= 4096, `${k}: ${v.length}`);
  assert.ok([...cs.map.keys()].some((k) => k.startsWith("ck_general__c")));
  assert.match(cs.map.get("ck_general"), /^\{"__chunks":\d+\}$/);
});

test("части режутся по байтам UTF-8 и не рвут эмодзи и кириллицу", async () => {
  const text = "🦆Ж".repeat(4000);
  const parts = st.splitByBytes(text, 3500);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((p) => st.utf8(p) <= 3500));
  const { store } = cloudStore();
  await store.put("j_x", { t: text });
  assert.equal((await store.get("j_x")).t, text);
});

test("перезапись короче удаляет лишние части; возврат к короткому значению чистит все части", async () => {
  const { cs, store } = cloudStore();
  await store.put("places", { v: big(20000) });
  const partsBefore = [...cs.map.keys()].filter((k) => k.includes("__c")).length;
  assert.ok(partsBefore >= 5);
  await store.put("places", { v: big(9000) });
  const partsMid = [...cs.map.keys()].filter((k) => k.includes("__c")).length;
  assert.ok(partsMid < partsBefore && partsMid >= 2);
  await store.put("places", { v: "коротко" });
  assert.deepEqual([...cs.map.keys()], ["places"]);
  assert.deepEqual(await store.get("places"), { v: "коротко" });
});

test("свежая сессия узнаёт о частях старого значения и тоже их чистит", async () => {
  const { cs, store } = cloudStore();
  await store.put("meta", { v: big(12000) });
  const fresh = st.createStore(st.cloudBackend(cs));          // как после перезапуска приложения
  await fresh.put("meta", { v: "x" });
  assert.deepEqual([...cs.map.keys()], ["meta"]);
});

test("del удаляет ключ и его части; list не показывает части", async () => {
  const { cs, store } = cloudStore();
  await store.put("j_20261003_a", { d: 1 });
  await store.put("j_20261004_b", { v: big(9000) });
  await store.put("meta", { a: 1 });
  assert.deepEqual((await store.list("j_")).sort(), ["j_20261003_a", "j_20261004_b"]);
  await store.del("j_20261004_b");
  assert.deepEqual([...cs.map.keys()].sort(), ["j_20261003_a", "meta"]);
  assert.equal(await store.get("j_20261004_b"), null);
});

test("clear стирает всё, кроме перечисленных ключей (и их частей)", async () => {
  const { cs, store } = cloudStore();
  await store.put("mig", { state: "done" });
  await store.put("places", { v: big(9000) });
  for (let i = 0; i < 250; i++) await store.put("j_2026_" + i, { i });
  assert.ok(cs.map.size > 250);
  const removed = await store.clear(["mig"]);
  assert.ok(removed > 250);
  assert.deepEqual([...cs.map.keys()], ["mig"]);
  assert.ok(cs.log.filter(([op]) => op === "remove").every(([, n]) => n <= 100), "удаление идёт пачками по ≤100");
});

test("лимит 1024 ключей даёт понятную ошибку full, а не молчаливую потерю", async () => {
  const { cs, store } = cloudStore();
  for (let i = 0; i < 1024; i++) cs.map.set("k" + i, "1");
  await assert.rejects(() => store.put("j_new", { a: 1 }), (e) => e instanceof st.StorageError && e.code === "full" && /1024/.test(e.message));
  await store.put("k5", { a: 2 });                                    // существующий ключ перезаписывается
  assert.deepEqual(await store.get("k5"), { a: 2 });
});

test("недопустимый ключ и ошибки Telegram превращаются в StorageError с русским сообщением", async () => {
  const { store } = cloudStore();
  await assert.rejects(() => store.put("плохой ключ", {}), (e) => e.code === "bad_key");
  await assert.rejects(() => store.put("a".repeat(129), {}), (e) => e.code === "bad_key");
  const broken = cloudStore({ failWith: "STORAGE_VALUE_TOO_LONG" });
  await assert.rejects(() => broken.store.put("meta", {}), (e) => e.code === "too_big" && /4096/.test(e.message));
  const offline = cloudStore({ failWith: "WebAppMethodUnsupported" });
  await assert.rejects(() => offline.store.put("meta", {}), (e) => e.code === "failed" && /Не удалось сохранить/.test(e.message));
  assert.equal(st.classify("STORAGE_KEYS_TOO_MUCH").code, "full");
  assert.equal(st.classify(new Error("STORAGE_KEY_INVALID")).code, "bad_key");
});

test("испорченное значение читается как отсутствующее, а не роняет приложение", async () => {
  const { cs, store } = cloudStore();
  cs.map.set("meta", "{не json");
  assert.equal(await store.get("meta"), null);
});

test("локальное хранилище подчиняется тем же лимитам, что и Telegram", async () => {
  const ls = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; })();
  const backend = st.localBackend(ls);
  await assert.rejects(() => backend.setItem("плохой", "1"), (e) => e.code === "bad_key");
  await assert.rejects(() => backend.setItem("k", "x".repeat(4097)), (e) => e.code === "too_big");
  const store = st.createStore(backend);
  await store.put("meta", { a: 1 });
  await store.put("big", { v: big(10000) });
  const again = st.createStore(st.localBackend(ls));                  // «перезагрузка страницы»
  assert.deepEqual(await again.get("meta"), { a: 1 });
  assert.equal((await again.get("big")).v.length, 10000);
  assert.equal(store.kind, "local");
});

test("выбор хранилища: CloudStorage только у клиента ≥ 6.9, иначе localStorage, иначе память", () => {
  const cs = fakeCloudStorage();
  const ls = { getItem: () => null, setItem() {}, removeItem() {} };
  const tg = (ver) => ({ Telegram: { WebApp: { CloudStorage: cs, isVersionAtLeast: (v) => parseFloat(v) <= ver } }, localStorage: ls });
  assert.equal(st.chooseBackend(tg(7.0)).kind, "telegram");
  assert.equal(st.chooseBackend(tg(6.9)).kind, "telegram");
  assert.equal(st.chooseBackend(tg(6.8)).kind, "local");
  assert.equal(st.chooseBackend({ localStorage: ls }).kind, "local");
  assert.equal(st.chooseBackend({ Telegram: { WebApp: {} }, localStorage: ls }).kind, "local");
  assert.equal(st.chooseBackend({}).kind, "memory");
  const blocked = { localStorage: { setItem() { throw new Error("denied"); } } };
  assert.equal(st.chooseBackend(blocked).kind, "memory");
});

test("облачный бэкенд отправляет getItems пачками и не теряет значения", async () => {
  const { cs, store } = cloudStore();
  const keys = Array.from({ length: 250 }, (_, i) => "j_" + i);
  for (const k of keys) cs.map.set(k, JSON.stringify({ k }));
  const got = await store.getMany(keys);
  assert.equal(Object.keys(got).length, 250);
  assert.ok(cs.log.filter(([op]) => op === "getItems").every(([, n]) => n <= 100));
  assert.deepEqual(got.j_249, { k: "j_249" });
});
