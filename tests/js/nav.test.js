// Навигатор: расстояние, азимут, компас, снос запаха, метки.
"use strict";
const test = require("node:test");
const { assert, lib } = require("./helpers");
const N = lib("nav");

test("расстояние по хаверсинусу: известные пары и ноль для одной точки", () => {
  assert.equal(N.distance(45, 39, 45, 39), 0);
  // Краснодар (45.035, 38.975) — Майкоп (44.610, 40.106): примерно 103 км
  const d = N.distance(45.035, 38.975, 44.610, 40.106);
  assert.ok(d > 100000 && d < 106000, d);
  // 1° по меридиану ≈ 111,2 км
  const mer = N.distance(45, 39, 46, 39);
  assert.ok(Math.abs(mer - 111200) < 400, mer);
});

test("азимут: север, восток, запад, полный круг", () => {
  assert.ok(Math.abs(N.bearing(45, 39, 46, 39)) < 0.5);                 // точно на север
  assert.ok(Math.abs(N.bearing(45, 39, 45, 40) - 90) < 1);              // почти восток
  assert.ok(Math.abs(N.bearing(45, 39, 44, 39) - 180) < 0.5);
  assert.ok(Math.abs(N.bearing(45, 39, 45, 38) - 270) < 1);
  assert.equal(N.norm360(-90), 270);
});

test("азимут относительно курса: 0 — вперёд, 90 — вправо", () => {
  assert.equal(N.relativeBearing(90, 0), 90);
  assert.equal(N.relativeBearing(0, 90), 270);
  assert.equal(N.relativeBearing(10, 350), 20);
  assert.equal(N.relativeBearing(30, null), null);
});

test("формат расстояния и азимута по-русски", () => {
  assert.equal(N.formatDistance(0), "0 м");
  assert.equal(N.formatDistance(15.4), "15 м");
  assert.equal(N.formatDistance(999), "999 м");
  assert.equal(N.formatDistance(1000), "1,0 км");
  assert.equal(N.formatDistance(15300), "15 км");
  assert.equal(N.formatDistance(null), "—");
  assert.equal(N.formatAzimuth(0), "азимут 0° (С)");
  assert.equal(N.formatAzimuth(45), "азимут 45° (СВ)");
  assert.equal(N.formatAzimuth(359), "азимут 359° (С)");
});

test("стороны света: короткие и падежи для подсказок", () => {
  assert.equal(N.compassShort(0), "С");
  assert.equal(N.compassShort(22.4), "С");
  assert.equal(N.compassShort(22.5), "СВ");
  assert.equal(N.compassTo(90), "восток");
  assert.equal(N.compassFrom(90), "востока");
  assert.equal(N.compassFrom(45), "северо-востока");
  assert.equal(N.compassTo(null), "—");
});

test("запах сносит против ветра (направление + 180°): ветер с запада — снос на восток", () => {
  assert.equal(N.scentDrift(270), 90);          // ветер С ЗАПАДА → снос на восток
  assert.equal(N.scentDrift(0), 180);
  assert.equal(N.scentDrift(90), 270);
  assert.equal(N.scentDrift(null), null);
  const advice = N.approachAdvice(270, 3);
  assert.equal(advice.calm, false);
  assert.equal(advice.driftDeg, 90);
  assert.equal(advice.text, "Заходи к метке с подветренной стороны: с востока.");
  assert.equal(advice.scentText, "Запах сносит на восток.");
  assert.match(N.approachAdvice(45, 2).text, /с юго-запада/);
  assert.equal(N.approachAdvice(180, 0.2).calm, true);
  assert.equal(N.approachAdvice(null, 3), null);
});

test("текущий ветер берётся из ближайшего прошедшего часа ответа Open-Meteo", () => {
  const raw = {
    utc_offset_seconds: 3 * 3600,
    hourly: {
      time: ["2026-11-21T13:00", "2026-11-21T14:00", "2026-11-21T15:00"],
      wind_direction_10m: [270, 90, 0],
      wind_speed_10m: [1, 4, 6],
      wind_gusts_10m: [2, 7, 9],
    },
  };
  // 11:30 UTC = 14:30 в поясе +3 → слот 14:00
  const w = N.currentWind(raw, new Date("2026-11-21T11:30:00Z"));
  assert.deepEqual({ direction: w.direction, speed: w.speed, gusts: w.gusts, drift: w.drift, time: w.time },
    { direction: 90, speed: 4, gusts: 7, drift: 270, time: "2026-11-21T14:00" });
  assert.equal(N.currentWind({ hourly: { time: [] } }, new Date()), null);
});

test("метки: нормализация, округление координат, типы, упаковка", () => {
  const ok = N.normalizeMark({ type: "car", name: "  У дороги ", note: "клен", lat: 45.04012345, lon: 38.98098765 });
  assert.equal(ok.type, "car");
  assert.equal(ok.name, "У дороги");
  assert.equal(ok.lat, 45.040123);
  assert.equal(ok.lon, 38.980988);
  const named = N.normalizeMark({ type: "tower", lat: 45, lon: 39 });
  assert.equal(named.name, "Вышка");
  assert.equal(N.normalizeMark({ type: "нет", lat: 1, lon: 1 }).error, "bad_type");
  assert.equal(N.normalizeMark({ type: "car", lat: 91, lon: 0 }).error, "bad_coordinates");
  assert.equal(N.normalizeMark({ type: "car", lat: "45,5", lon: "39,1" }).lat, 45.5);
  const packed = N.packMark(3, ok);
  assert.deepEqual(packed, { id: 3, t: "car", n: "У дороги", o: "клен", lat: 45.040123, lon: 38.980988 });
  const pub = N.markPublic(N.unpackMark(packed));
  assert.deepEqual([pub.key, pub.emoji, pub.type_name], ["m3", "🚗", "Машина"]);
  assert.equal(N.unpackMark({ id: 1, t: "ghost", lat: 1, lon: 1 }), null);
});

test("метка: обрезка длинных полей, цель по умолчанию — машина, разбор id", () => {
  const long = N.normalizeMark({ type: "other", name: "я".repeat(80), note: "н".repeat(300), lat: 1, lon: 1 });
  assert.equal([...long.name].length, 60);
  assert.equal([...long.note].length, 200);
  const marks = [{ type: "tower", id: 1 }, { type: "car", id: 2, name: "УАЗ" }, { type: "car", id: 3 }];
  assert.equal(N.defaultNavTarget(marks).id, 2);
  assert.equal(N.defaultNavTarget([{ type: "tower" }]), null);
  assert.equal(N.parseMarkId("m12"), 12);
  assert.equal(N.parseMarkId(7), 7);
  assert.equal(N.parseMarkId("нет"), null);
});

test("курс устройства из события ориентации: iOS webkit и alpha (против часовой)", () => {
  assert.equal(N.headingFromOrientation({ webkitCompassHeading: 30 }), 30);
  assert.equal(N.headingFromOrientation({ alpha: 0 }), 0);
  assert.equal(N.headingFromOrientation({ alpha: 90 }), 270);
  assert.equal(N.headingFromOrientation({}), null);
});
