// Правила оценки дня, активности и фазы луны — выборочно, по смыслу (полная сверка с Python в golden.test.js).
"use strict";
const test = require("node:test");
const { assert, lib } = require("./helpers");

const scoring = lib("scoring"), A = lib("activity"), M = lib("moon"), D = lib("dates"), W = lib("weather"), F = lib("forecast");
const act = (group, c) => A.estimateActivity(group, c);

test("оценка дня: штиль 5, ветер/порывы/осадки/скачок давления снижают, всегда 1..5", () => {
  assert.equal(scoring.scoreDay({}).value, 5);
  assert.equal(scoring.scoreDay({ wind_speed: 2, precipitation: 0, pressure_change: 0.5, temperature: 5 }).value, 5);
  assert.equal(scoring.scoreDay({ wind_speed: 12, wind_gusts: 20, precipitation: 6, pressure_change: -8, temperature: -25 }).value, 1);
  assert.deepEqual(scoring.scoreDay({ wind_speed: 4 }).reasons, ["умеренный ветер"]);
  assert.equal(scoring.scoreDay({ precipitation: 1 }).label, "Хороший день");
  assert.equal(scoring.scoreDay({ pressure_change: -6 }).reasons[0], "резкий скачок давления вниз");
});

test("активность: зорька выше полудня; значения 1..5; неизвестные аргументы — ошибка", () => {
  for (const g of Object.keys(A.GROUPS)) {
    assert.ok(act(g, { time_of_day: "dawn" }).value >= act(g, { time_of_day: "day" }).value, g);
    for (const tod of A.TIMES_OF_DAY) { const v = act(g, { time_of_day: tod, wind_speed: 20, precipitation: 9, pressure_change: 9 }).value; assert.ok(v >= 1 && v <= 5); }
  }
  assert.throws(() => act("дракон", {}), /Неизвестная группа/);
  assert.throws(() => act("hare", { time_of_day: "night" }), /Неизвестное время/);
  assert.deepEqual(Object.keys(A.GROUPS), ["waterfowl", "upland", "ungulates", "pheasant", "hare"]);
});

test("фазан: дождь и сильный ветер прижимают, луна не важна", () => {
  const calm = act("pheasant", { time_of_day: "dawn", wind_speed: 2, precipitation: 0 });
  assert.ok(calm.value > act("pheasant", { time_of_day: "dawn", wind_speed: 10, precipitation: 3 }).value);
  assert.ok(act("pheasant", { time_of_day: "dawn", precipitation: 1, temperature: -2 }).reasons.some((r) => r.startsWith("снег")));
  assert.ok(act("pheasant", { time_of_day: "dawn", precipitation: 1, temperature: 8 }).reasons.some((r) => r.startsWith("дождь")));
  assert.deepEqual(act("pheasant", { time_of_day: "dawn", moon_illumination: 1 }), act("pheasant", { time_of_day: "dawn" }));
});

test("заяц: вечер сильнее утра, днём лежит, пороша повышает, ливень убирает порошу", () => {
  const evening = act("hare", { time_of_day: "dusk" }), morning = act("hare", { time_of_day: "dawn" }), day = act("hare", { time_of_day: "day" });
  assert.ok(evening.value >= morning.value && morning.value > day.value);
  const base = { time_of_day: "dusk", wind_speed: 2 };
  const fresh = act("hare", { ...base, fresh_snow: 1 });
  assert.ok(fresh.reasons.some((r) => r.startsWith("пороша")));
  assert.ok(fresh.value >= act("hare", base).value);
  assert.ok(!act("hare", { ...base, fresh_snow: 1, precipitation: 3 }).reasons.some((r) => r.startsWith("пороша")));
  assert.ok(!act("hare", { ...base, fresh_snow: 0.2 }).reasons.some((r) => r.startsWith("пороша")));
});

test("утка: ветер 3–8 м/с — плюс, шторм — минус", () => {
  assert.ok(act("waterfowl", { wind_speed: 5 }).value >= act("waterfowl", { wind_speed: 14 }).value);
  assert.ok(act("waterfowl", { wind_speed: 5 }).reasons.includes("ветер 3–8 м/с — утка летает активно"));
});

test("луна: новолуние 2000-01-06, полнолуние ~14,8 суток спустя, фазы по кругу", () => {
  const nm = M.moonPhase("2000-01-06", 18);
  assert.ok(nm.illumination < 0.01 && nm.name === "Новолуние");
  const full = M.moonPhase("2000-01-21", 6);
  assert.ok(full.illumination > 0.99 && full.name === "Полнолуние" && full.emoji === "🌕");
  const names = new Set();
  for (let i = 0; i < 30; i++) names.add(M.moonPhase(D.addDays("2026-11-01", i)).name);
  assert.equal(names.size, 8);
  for (const age of [0, 3.7, 7.4, 11.1, 14.8, 18.4, 22.1, 25.8, 29.5]) { const [n, e] = M.phaseName(age); assert.ok(n && e); }
});

test("направление ветра: откуда дует", () => {
  assert.deepEqual([0, 90, 180, 270, 359].map(W.windDirectionName), ["С", "В", "Ю", "З", "С"]);
  assert.equal(W.windDirectionName(null), "—");
});

test("заголовки дней: «Сегодня, 20 ноября», «Завтра, 21 ноября»", () => {
  assert.equal(F.dayHeading("2026-11-20", "2026-11-20"), "Сегодня, 20 ноября");
  assert.equal(F.dayHeading("2026-11-21", "2026-11-20"), "Завтра, 21 ноября");
  assert.equal(F.dayHeading("2026-12-02", "2026-11-20"), "2 декабря");
});

test("даты: арифметика, високосный год, день недели как в Python (пн = 0)", () => {
  assert.equal(D.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(D.addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(D.diffDays("2026-11-21", "2026-11-20"), 1);
  assert.equal(D.weekday("2026-11-20"), 4);     // пятница
  assert.equal(D.weekday("2026-11-22"), 6);     // воскресенье
  assert.equal(D.todayIn("Europe/Moscow", new Date("2026-11-20T21:30:00Z")), "2026-11-21");     // в Москве уже завтра
  assert.equal(D.todayIn("Asia/Kamchatka", new Date("2026-11-20T01:00:00Z")), "2026-11-20");
  assert.equal(D.todayIn("Нет/Такого", new Date()).length, 10);
});
