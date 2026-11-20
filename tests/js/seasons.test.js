// Сроки охоты: правила дат, статусы, целостность seasons.json / regions.json.
"use strict";
const test = require("node:test");
const { assert, lib, readJSON, WEBAPP } = require("./helpers");
const path = require("node:path");

const S = lib("seasons"), D = lib("dates");
const data = readJSON(WEBAPP, "data", "seasons.json");
const regions = readJSON(WEBAPP, "data", "regions.json");

test("правила дат: N-я суббота, конец месяца, фиксированная дата", () => {
  const cases = [
    ["sat2-08", 2026, "2026-08-08"], ["sat3-08", 2026, "2026-08-15"], ["sat4-09", 2026, "2026-09-26"],   // открытие утки в Краснодарском крае
    ["sat3-01", 2027, "2027-01-16"], ["sat3-04", 2026, "2026-04-18"], ["sat4-04", 2026, "2026-04-25"],
    ["eom-02", 2027, "2027-02-28"], ["eom-02", 2028, "2028-02-29"], ["10-15", 2026, "2026-10-15"],
  ];
  for (const [rule, year, expected] of cases) assert.equal(S.resolveRule(rule, year), expected, `${rule} ${year}`);
});

test("диапазон переходит на следующий год; days вместо end; сезон собак до 3-й субботы января", () => {
  assert.deepEqual(S.resolveRange({ start: "09-15", end: "01-10" }, 2026), { start: "2026-09-15", end: "2027-01-10" });
  assert.deepEqual(S.resolveRange({ start: "sat2-04", days: 10 }, 2027), { start: "2027-04-10", end: "2027-04-19" });
  assert.deepEqual(S.resolveRange({ start: "sat3-08", end: "sat3-01" }, 2026), { start: "2026-08-15", end: "2027-01-16" });
});

test("несуществующая дата в правиле — ошибка, а не тихий переход на другой месяц", () => {
  assert.throws(() => S.resolveRule("02-30", 2026), RangeError);
  assert.throws(() => S.resolveRule("13-01", 2026), RangeError);
});

const entry = (ranges, extra) => Object.assign({ id: "x", category: "fur", name: "Тест", ranges, confidence: "federal", source: "", note: null, closed: false, frame: false }, extra);

test("статус: открыт, границы, смена года", () => {
  const e = entry([{ start: "10-01", end: "01-10" }]);
  assert.equal(S.entryStatus(e, "2026-10-01").state, "open");
  assert.equal(S.entryStatus(e, "2027-01-10").state, "open");
  assert.notEqual(S.entryStatus(e, "2027-01-11").state, "open");
  assert.equal(S.entryStatus(e, "2026-11-20").window.end, "2027-01-10");
});

test("статус «скоро» — не дальше 30 дней, дальше «закрыт» с ближайшим окном", () => {
  const e = entry([{ start: "10-01", end: "01-10" }]);
  const near = S.entryStatus(e, "2026-09-01");           // ровно 30 дней
  assert.deepEqual([near.state, near.days], ["upcoming", 30]);
  const far = S.entryStatus(e, "2026-08-31");            // 31 день
  assert.deepEqual([far.state, far.days, far.window.start], ["closed", 31, "2026-10-01"]);
});

test("запрет и рамки: closed/без периодов — banned; рамки не считаются открытым сезоном", () => {
  assert.equal(S.entryStatus(entry([{ start: "10-01", end: "01-10" }], { closed: true }), "2026-11-01").state, "banned");
  assert.equal(S.entryStatus(entry([]), "2026-11-01").state, "banned");
  const fake = { federal: [{ id: "f", category: "spring", name: "Рамки", ranges: [{ start: "03-01", end: "06-16" }], frame: true }], regions: {}, sources: {} };
  assert.equal(S.seasonOpen(fake, null, "2026-04-01"), false);
});

test("запись региона с тем же id заменяет федеральную, остальные добавляются в конец", () => {
  const d = { federal: [{ id: "a", category: "fur", name: "Фед A", ranges: [] }, { id: "b", category: "fur", name: "Фед B", ranges: [] }],
    regions: { r: { entries: [{ id: "b", category: "fur", name: "Рег B", ranges: [] }, { id: "c", category: "fur", name: "Рег C", ranges: [] }] } }, sources: {} };
  assert.deepEqual(S.regionEntries(d, "r").map((e) => e.name), ["Фед A", "Рег B", "Рег C"]);
  assert.deepEqual(S.regionEntries(d, "нет такого").map((e) => e.name), ["Фед A", "Фед B"]);
});

test("Краснодарский край 2026: утка открывается в 4-ю субботу сентября, 26.09 — день открытия", () => {
  const before = S.seasonsPayload(data, regions, "krasnodar", "2026-09-25");
  const open = S.seasonsPayload(data, regions, "krasnodar", "2026-09-26");
  const find = (p) => p.categories.flatMap((c) => c.entries).filter((e) => e.state === "open").length;
  assert.ok(find(open) > find(before));
  assert.equal(open.verified, true);
});

test("payload региона без проверенных данных показывает федеральные сроки и всегда отдаёт оговорку", () => {
  const p = S.seasonsPayload(data, regions, regions.find((r) => !S.isVerified(data, r.code)).code, "2026-11-20");
  assert.equal(p.verified, false); assert.equal(p.summary, null); assert.equal(p.disclaimer, S.DISCLAIMER);
  assert.ok(p.sources.length >= 3 && p.sources.every((s) => s.title && s.url.startsWith("https://")));
});

test("целостность seasons.json: все правила считаются на 2024–2031, id уникальны, источники существуют", () => {
  const all = [...data.federal, ...Object.values(data.regions).flatMap((r) => r.entries)];
  assert.ok(all.length > 20);
  for (const e of all) {
    for (const rng of e.ranges || []) for (let y = 2024; y <= 2031; y++) {
      const w = S.resolveRange(rng, y);
      assert.ok(w.start <= w.end, `${e.id} ${y}`);
      assert.ok(D.diffDays(w.end, w.start) < 370, `${e.id}: окно длиннее года`);
    }
    if (e.source) assert.ok(data.sources[e.source], `источник ${e.source} (${e.id})`);
  }
  for (const [code, reg] of Object.entries(data.regions)) {
    assert.equal(new Set(reg.entries.map((e) => e.id)).size, reg.entries.length, `дубли id в ${code}`);
    for (const key of reg.sources || []) assert.ok(data.sources[key], `${code}: источник ${key}`);
    if (reg.verified) assert.ok(reg.summary, `${code}: у проверенного региона нужна сводка`);
    assert.ok(regions.some((r) => r.code === code), `${code} отсутствует в regions.json`);
  }
});

test("regions.json: коды уникальны, Краснодарский край и Адыгея — первые", () => {
  assert.equal(new Set(regions.map((r) => r.code)).size, regions.length);
  assert.deepEqual(regions.slice(0, 2).map((r) => r.code), ["krasnodar", "adygea"]);
  assert.ok(regions.every((r) => /^[a-z0-9_]+$/.test(r.code) && r.name));
});

test("для каждого региона payload строится на любую дату года без ошибок", () => {
  for (const r of regions) for (const day of ["2026-01-01", "2026-04-15", "2026-08-20", "2026-12-31", "2028-02-29"]) {
    const p = S.seasonsPayload(data, regions, r.code, day);
    assert.equal(p.categories.length, 4);
    assert.equal(p.today, day);
  }
});
