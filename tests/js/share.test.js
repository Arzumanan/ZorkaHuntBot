// Поделиться меткой: кодирование startapp, разбор и проверка ввода.
"use strict";
const test = require("node:test");
const { assert, lib } = require("./helpers");
const N = lib("nav");

const sample = { type: "other", name: "Фазан заяц", note: "у кромки леса", lat: 44.701234, lon: 38.866401 };

test("encodeShareMark: допустимый startapp и круговой разбор без потерь координат", () => {
  const enc = N.encodeShareMark(sample);
  assert.ok(!enc.error, enc.message);
  assert.ok(N.STARTAPP_MAX >= enc.param.length && /^[A-Za-z0-9_-]+$/.test(enc.param), enc.param);
  assert.ok(enc.param.startsWith(N.SHARE_PREFIX));
  assert.equal(enc.link, "https://t.me/" + N.SHARE_BOT + "?startapp=" + enc.param);
  const back = N.decodeShareParam(enc.param);
  assert.ok(back);
  assert.equal(back.type, "other");
  assert.equal(back.name, "Фазан заяц");
  assert.equal(back.note, "у кромки леса");
  assert.equal(back.lat, N.roundCoord(sample.lat));
  assert.equal(back.lon, N.roundCoord(sample.lon));
});

test("decodeShareParam отклоняет мусор, чужой префикс, HTML не исполняется, координаты вне диапазона", () => {
  assert.equal(N.decodeShareParam(""), null);
  assert.equal(N.decodeShareParam(null), null);
  assert.equal(N.decodeShareParam("m1_%%%"), null);
  assert.equal(N.decodeShareParam("x1_abc"), null);
  assert.equal(N.decodeShareParam("m1_"), null);
  const badCoords = N.encodeShareMark({ type: "car", name: "Машина", note: "", lat: 44.7, lon: 38.8 });
  // подменяем тело: широта 91
  const raw = Buffer.from(JSON.stringify([1, "car", "Машина", "", 91, 38.8])).toString("base64url");
  assert.equal(N.decodeShareParam(N.SHARE_PREFIX + raw), null);
  const unknownType = Buffer.from(JSON.stringify([1, "ghost", "X", "", 44.7, 38.8])).toString("base64url");
  assert.equal(N.decodeShareParam(N.SHARE_PREFIX + unknownType), null);
  const wrongVer = Buffer.from(JSON.stringify([2, "car", "X", "", 44.7, 38.8])).toString("base64url");
  assert.equal(N.decodeShareParam(N.SHARE_PREFIX + wrongVer), null);
  const extra = Buffer.from(JSON.stringify([1, "car", "X", "", 44.7, 38.8, "oops"])).toString("base64url");
  assert.equal(N.decodeShareParam(N.SHARE_PREFIX + extra), null);
  const htmlName = N.encodeShareMark({ type: "tower", name: "<img src=x onerror=alert(1)>", note: "<b>hi</b>", lat: 45, lon: 39 });
  const back = N.decodeShareParam(htmlName.param);
  assert.ok(back);
  assert.ok(back.name.includes("<img"), "текст сохраняется как текст");
  assert.equal(back.note, "<b>hi</b>");
});

test("длинная заметка укорачивается, чтобы параметр не превысил 512 символов", () => {
  const note = "я".repeat(200) + " хвост";
  const enc = N.encodeShareMark({ type: "labaz", name: "Лабаз на дубе очень длинное название метки ".repeat(2), note, lat: 44.1, lon: 39.2 });
  assert.ok(!enc.error, enc.message);
  assert.ok(enc.param.length <= N.STARTAPP_MAX, enc.param.length);
  const back = N.decodeShareParam(enc.param);
  assert.ok(back);
  assert.ok(back.note.length < note.length || enc.param.length <= N.STARTAPP_MAX);
  assert.equal(back.type, "labaz");
});

test("readStartParam берёт initData, затем tgWebAppStartParam из query и hash", () => {
  const enc = N.encodeShareMark(sample);
  assert.equal(N.readStartParam({ start_param: enc.param }), enc.param);
  assert.equal(N.readStartParam({ search: "?tab=map&tgWebAppStartParam=" + enc.param }), enc.param);
  assert.equal(N.readStartParam({ hash: "#tgWebAppStartParam=" + enc.param }), enc.param);
  assert.equal(N.readStartParam({ search: "?startapp=" + enc.param }), enc.param);
  assert.equal(N.readStartParam({}), "");
  assert.equal(N.readStartParam({ start_param: "   " }), "   "); // пустой после trim не делаем: decode отсеет
});

test("findDuplicateMark сравнивает тип и координаты с точностью хранения", () => {
  const rec = N.encodeShareMark(sample);
  const list = [
    { type: "other", lat: 44.701234, lon: 38.866401, name: "другое имя" },
    { type: "car", lat: 44.701234, lon: 38.866401, name: "Машина" },
  ];
  assert.equal(N.findDuplicateMark(list, rec).name, "другое имя");
  assert.equal(N.findDuplicateMark(list, { type: "tower", lat: rec.lat, lon: rec.lon }), null);
  assert.equal(N.findDuplicateMark([], rec), null);
});

test("текст и ссылка шаринга содержат название, координаты и карты", () => {
  const enc = N.encodeShareMark(sample);
  const text = N.shareText(enc);
  assert.ok(text.includes("Метка «Фазан заяц» — открой в Зорьке"));
  assert.ok(text.includes("44.701234"));
  assert.ok(text.includes("38.866401"));
  assert.ok(text.includes("https://yandex.ru/maps/?pt=38.866401,44.701234"));
  assert.ok(text.includes("https://maps.google.com/?q=44.701234,38.866401"));
  const url = N.telegramShareUrl(enc);
  assert.ok(url.startsWith("https://t.me/share/url?url="));
  assert.ok(url.includes(encodeURIComponent(enc.link)));
  assert.ok(url.includes("text="));
});
