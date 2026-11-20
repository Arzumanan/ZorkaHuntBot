// Общие помощники JS-тестов: загрузка библиотек, поддельные хранилища и сеть.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..", "..");
const WEBAPP = path.join(ROOT, "webapp");
const lib = (name) => require(path.join(WEBAPP, "lib", name + ".js"));
const readJSON = (...p) => JSON.parse(fs.readFileSync(path.join(...p), "utf8"));
const golden = () => readJSON(__dirname, "fixtures", "golden.json");
const loadJSON = async (name) => readJSON(WEBAPP, "data", name);

/** Рекурсивное сравнение: числа — с допуском (порт на другой язык даёт те же формулы, но не обязан совпадать до последнего бита). */
function assertClose(actual, expected, where = "$", eps = 1e-9) {
  if (typeof expected === "number" && typeof actual === "number") {
    assert.ok(Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)), `${where}: ${actual} ≠ ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: ожидался массив`);
    assert.equal(actual.length, expected.length, `${where}: длина`);
    expected.forEach((e, i) => assertClose(actual[i], e, `${where}[${i}]`, eps));
  } else if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object", `${where}: ожидался объект`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${where}: ключи`);
    for (const k of Object.keys(expected)) assertClose(actual[k], expected[k], `${where}.${k}`, eps);
  } else {
    assert.equal(actual, expected, where);
  }
}

/** Поддельный Telegram.WebApp.CloudStorage: колбэки (err, res), лимиты и коды ошибок как у настоящего. */
function fakeCloudStorage(opts = {}) {
  const map = new Map();
  const log = [];
  const later = (fn) => setImmediate(fn);
  const bad = (k) => !/^[A-Za-z0-9_-]{1,128}$/.test(k);
  const cs = {
    map, log,
    setItem(key, value, cb) {
      log.push(["set", key]);
      later(() => {
        if (opts.failWith) return cb(opts.failWith);
        if (bad(key)) return cb("STORAGE_KEY_INVALID");
        if (typeof value !== "string" || value.length > 4096) return cb("STORAGE_VALUE_INVALID: too long (STORAGE_VALUE_TOO_LONG)");
        if (!map.has(key) && map.size >= 1024) return cb("STORAGE_KEYS_TOO_MUCH");
        map.set(key, value); cb(null, true);
      });
    },
    getItem(key, cb) { later(() => cb(null, map.get(key) || "")); },
    getItems(keys, cb) { log.push(["getItems", keys.length]); later(() => cb(null, Object.fromEntries(keys.map((k) => [k, map.get(k) || ""])))); },
    getKeys(cb) { later(() => cb(null, [...map.keys()])); },
    removeItem(key, cb) { later(() => { map.delete(key); cb(null, true); }); },
    removeItems(keys, cb) { log.push(["remove", keys.length]); later(() => { keys.forEach((k) => map.delete(k)); cb(null, true); }); },
  };
  return cs;
}

/** Поддельный fetch: routes — [[подстрока URL, ответ | функция]]; считает вызовы. */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [needle, reply] of routes) {
      if (!String(url).includes(needle)) continue;
      const r = typeof reply === "function" ? await reply(String(url), init) : reply;
      if (r instanceof Error) throw r;
      const status = r.status || 200;
      return { ok: status >= 200 && status < 300, status, json: async () => { if (r.html) throw new SyntaxError("not json"); return r.body; } };
    }
    throw new Error("нет маршрута для " + url);
  };
  f.calls = calls;
  return f;
}

module.exports = { assert, ROOT, WEBAPP, lib, readJSON, golden, loadJSON, assertClose, fakeCloudStorage, fakeFetch };
