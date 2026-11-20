// Сверка JS-кода с эталоном: результаты прежней Python-реализации (bot/services/*), сохранённые в fixtures/golden.json.
"use strict";
const test = require("node:test");
const { assert, lib, golden, assertClose } = require("./helpers");

const G = golden();
const scoring = lib("scoring"), activity = lib("activity"), moon = lib("moon"), W = lib("weather"), F = lib("forecast");
const S = lib("seasons"), ST = lib("stats"), CL = lib("checklist"), D = lib("dates");
const { data: seasonsData } = { data: require("../../webapp/data/seasons.json") };
const regionList = require("../../webapp/data/regions.json");
const tpl = require("../../webapp/data/checklist.json");

test("оценка дня совпадает с Python на 500 наборах условий", () => {
  assert.equal(G.score.length, 500);
  for (const { in: c, out } of G.score) assert.deepEqual(scoring.scoreDay(c), out, JSON.stringify(c));
});

test("активность совпадает с Python: все группы × утро/вечер/день × граничные значения", () => {
  assert.ok(G.activity.length > 1000);
  for (const { g, in: c, out } of G.activity) {
    const r = activity.estimateActivity(g, c);
    assert.deepEqual([r.value, r.label, r.reasons], out, g + " " + JSON.stringify(c));
  }
});

test("фаза луны совпадает с Python на 4 годах", () => {
  for (const m of G.moon) {
    const r = moon.moonPhase(m.d);
    assertClose(r.age_days, m.age, m.d, 1e-9);
    assertClose(r.illumination, m.ill, m.d, 1e-9);
    assert.equal(r.name, m.name, m.d);
    assert.equal(r.emoji, m.emoji, m.d);
  }
});

test("разбор прогноза Open-Meteo: окна, перепады, пороша, условия дня", () => {
  assert.equal(G.weather.length, 4);
  for (const [i, w] of G.weather.entries()) {
    const days = W.parseForecast(w.raw);
    assert.deepEqual(Object.keys(days), Object.keys(w.parsed), "набор дней #" + i);
    for (const [d, exp] of Object.entries(w.parsed)) {
      const day = days[d];
      assert.equal(day.sunrise, exp.sunrise.slice(0, 16)); assert.equal(day.sunset, exp.sunset.slice(0, 16));
      assertClose(day.dawn, exp.dawn, `#${i} ${d} dawn`); assertClose(day.dusk, exp.dusk, `#${i} ${d} dusk`);
      for (const k of ["pressure_change", "temp_change", "snow_before_dawn", "snow_before_dusk"]) assertClose(day[k], exp[k], `#${i} ${d} ${k}`);
      assertClose(F.conditionsFor(day), exp.conditions, `#${i} ${d} conditions`);
    }
    for (const [d, exp] of Object.entries(w.series)) assertClose(W.hourlySeries(w.raw, d), exp, `#${i} series ${d}`);
    assert.equal(W.localToday(w.raw, new Date(w.now)), w.local_today, "локальная дата #" + i);
  }
});

test("полный прогноз для интерфейса (forecast_payload) совпадает с Python", () => {
  for (const [i, w] of G.weather.entries()) {
    const place = { key: "p1", title: "Тест", lat: 1.0, lon: 2.0 };
    assertClose(F.forecastPayload(w.raw, place, new Date(w.now)), w.payload, `payload #${i}`, 1e-9);
  }
});

test("в данных есть пороша: хотя бы один прогноз со снегом перед зорькой", () => {
  const snowy = G.weather.flatMap((w) => Object.values(w.parsed)).filter((d) => d.snow_before_dawn > 0.3 || d.snow_before_dusk > 0.3);
  assert.ok(snowy.length > 0, "эталон должен покрывать правило пороши у зайца");
});

test("стороны света и геокодинг", () => {
  for (const [deg, name] of G.wind_names) assert.equal(W.windDirectionName(deg), name, String(deg));
  for (const { raw, title } of G.geocoding) {
    const p = W.parseGeocoding(raw);
    assert.equal(p.title, title);
  }
  assert.equal(W.parseGeocoding({}), null);
  assert.equal(W.parseGeocoding({ results: [] }), null);
});

test("сроки охоты: payload региона совпадает с Python (все категории, статусы, окна, источники)", () => {
  assert.ok(G.seasons.length >= 40);
  for (const { code, today, payload, open } of G.seasons) {
    assert.deepEqual(S.seasonsPayload(seasonsData, regionList, code, today), payload, `${code} ${today}`);
    assert.equal(S.seasonOpen(seasonsData, code, today), open, `open ${code} ${today}`);
  }
});

test("список регионов и признак «проверен» совпадает с Python", () => {
  const got = regionList.map((r) => ({ code: r.code, name: r.name, verified: S.isVerified(seasonsData, r.code) }));
  assert.deepEqual(got, G.regions);
});

test("статистика журнала совпадает с Python", () => {
  for (const { in: rows, out } of G.stats) {
    const got = ST.computeStats(rows.map(([date, place, species]) => ({ date, place, species })));
    assert.deepEqual(got, out);
  }
});

test("шаблоны чек-листа и подсказки по погоде совпадают с Python", () => {
  for (const [type, items] of Object.entries(G.templates)) assert.deepEqual(CL.templateFor(tpl, type), items, type);
  for (const { in: args, out } of G.hints) assert.deepEqual(CL.weatherHints(...args), out, JSON.stringify(args));
});

test("разбор даты и чистка текста совпадают с Python", () => {
  for (const [text, iso] of G.parse_date) assert.equal(D.parseUserDate(text, "2026-11-20"), iso, JSON.stringify(text));
  const { cleanText } = lib("data");
  for (const [value, max, out] of G.clean_text) assert.equal(cleanText(value, max), out, JSON.stringify(value));
  for (const [day, today, out] of G.day_heading) assert.equal(F.dayHeading(day, today), out);
});
