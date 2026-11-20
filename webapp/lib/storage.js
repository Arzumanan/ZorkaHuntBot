/* Слой хранения: все данные пользователя лежат в Telegram CloudStorage (на устройстве — localStorage как запасной вариант).

   Ограничения CloudStorage: до 1024 ключей на пользователя, ключ 1–128 символов [A-Za-z0-9_-], значение до 4096 символов.
   Поэтому:
     • значения — JSON; слишком длинное значение режется на части `<ключ>__c1…__cN`, а в самом ключе остаётся заголовок
       {"__chunks":N}; чтение собирает части обратно (put/get/del делают это сами);
     • записи журнала хранятся по одной в ключе (см. data.js), чтобы не упираться в 4096;
     • переполнение превращается в понятную ошибку StorageError (code: too_big | full | bad_key | failed). */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory();
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.storage = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
  const MAX_VALUE = 4096;          // лимит Telegram, символов
  const MAX_KEYS = 1024;
  const DIRECT_BYTES = 4000;       // длиннее — режем на части (по байтам UTF-8, чтобы быть в безопасности при любом способе подсчёта)
  const CHUNK_BYTES = 3500;
  const CHUNK_SEP = "__c";
  const BATCH = 100;
  const TIMEOUT_MS = 12000;

  const MESSAGES = {
    too_big: "Запись слишком большая для хранилища Telegram (лимит 4096 символов).",
    full: "Хранилище Telegram заполнено (лимит 1024 ключа). Удалите старые записи журнала.",
    bad_key: "Недопустимый ключ хранилища.",
    failed: "Не удалось сохранить данные в хранилище. Проверьте связь и повторите.",
  };
  class StorageError extends Error {
    constructor(code, detail) {
      super(MESSAGES[code] || MESSAGES.failed);
      this.name = "StorageError"; this.code = code; this.detail = detail || null;
    }
  }
  function classify(err) {
    const s = String((err && err.message) || err || "");
    if (/TOO_LONG|VALUE_TOO|too_big/i.test(s)) return new StorageError("too_big", s);
    if (/KEYS_TOO_MUCH|TOO_MUCH|full/i.test(s)) return new StorageError("full", s);
    if (/KEY_INVALID|bad_key/i.test(s)) return new StorageError("bad_key", s);
    return err instanceof StorageError ? err : new StorageError("failed", s);
  }

  const utf8 = (s) => (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : unescape(encodeURIComponent(s)).length);
  /** Режет строку на части не длиннее maxBytes (UTF-8), не разрывая символы. */
  function splitByBytes(s, maxBytes) {
    const parts = [];
    let cur = "", curBytes = 0;
    for (const ch of s) {                       // итерация по кодовым точкам
      const b = utf8(ch);
      if (curBytes + b > maxBytes) { parts.push(cur); cur = ""; curBytes = 0; }
      cur += ch; curBytes += b;
    }
    if (cur || !parts.length) parts.push(cur);
    return parts;
  }
  const slices = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

  // ---------- бэкенды: kind, getKeys(), getItems(keys) → {key: строка | ""}, setItem(key, строка), removeItems(keys) ----------

  /** Telegram.WebApp.CloudStorage (колбэки → промисы). */
  function cloudBackend(cs) {
    const call = (fn, ...args) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new StorageError("failed", "timeout")), TIMEOUT_MS);
      try {
        fn.call(cs, ...args, (err, res) => { clearTimeout(timer); if (err) reject(classify(err)); else resolve(res); });
      } catch (e) { clearTimeout(timer); reject(classify(e)); }
    });
    return {
      kind: "telegram",
      getKeys: async () => (await call(cs.getKeys)) || [],
      async getItems(keys) {
        const out = {};
        for (const part of slices(keys, BATCH)) Object.assign(out, (await call(cs.getItems, part)) || {});
        return out;
      },
      setItem: (key, value) => call(cs.setItem, key, value),
      async removeItems(keys) { for (const part of slices(keys, BATCH)) await call(cs.removeItems, part); },
    };
  }

  /** Хранилище с теми же ограничениями, что и у Telegram (для запасного режима и тестов). load/save — как хранить карту. */
  function mapBackend(kind, load, save) {
    return {
      kind,
      async getKeys() { return Object.keys(load()); },
      async getItems(keys) { const m = load(), out = {}; for (const k of keys) out[k] = Object.prototype.hasOwnProperty.call(m, k) ? m[k] : ""; return out; },
      async setItem(key, value) {
        if (!KEY_RE.test(key)) throw new StorageError("bad_key", key);
        if (typeof value !== "string" || value.length > MAX_VALUE) throw new StorageError("too_big");
        const m = load();
        if (!(key in m) && Object.keys(m).length >= MAX_KEYS) throw new StorageError("full");
        m[key] = value; save(m);
      },
      async removeItems(keys) { const m = load(); for (const k of keys) delete m[k]; save(m); },
    };
  }
  function memoryBackend(initial) {
    let map = Object.assign({}, initial || {});
    const b = mapBackend("memory", () => map, (m) => { map = m; });
    b.dump = () => Object.assign({}, map);
    return b;
  }
  /** localStorage: один JSON-объект под одним ключом, чтобы не засорять чужие ключи страницы. */
  function localBackend(ls, name = "zorka:data") {
    const load = () => { try { return JSON.parse(ls.getItem(name) || "{}") || {}; } catch (e) { return {}; } };
    const save = (m) => {
      try { ls.setItem(name, JSON.stringify(m)); }
      catch (e) { throw new StorageError("failed", "localStorage: " + (e && e.message)); }
    };
    return mapBackend("local", load, save);
  }

  /** Выбор бэкенда: CloudStorage Telegram (клиент ≥ 6.9) → localStorage → память. */
  function chooseBackend(win) {
    const tg = win && win.Telegram && win.Telegram.WebApp;
    const supported = tg && tg.CloudStorage && (!tg.isVersionAtLeast || tg.isVersionAtLeast("6.9"));
    if (supported) return cloudBackend(tg.CloudStorage);
    try {
      const ls = win && win.localStorage;
      if (ls) { ls.setItem("zorka:probe", "1"); ls.removeItem("zorka:probe"); return localBackend(ls); }
    } catch (e) { /* приватный режим */ }
    return memoryBackend();
  }

  // ---------- хранилище JSON-значений поверх бэкенда ----------
  function createStore(backend) {
    const chunkCount = new Map();       // ключ → число частей, как мы его видели в этой сессии
    const chunkKey = (key, i) => `${key}${CHUNK_SEP}${i}`;
    const header = (raw) => {
      if (!raw || raw.charCodeAt(0) !== 123 /* { */ || raw.indexOf('"__chunks"') < 0) return 0;
      try { const h = JSON.parse(raw); return h && Number.isInteger(h.__chunks) ? h.__chunks : 0; } catch (e) { return 0; }
    };
    const parse = (raw) => { try { return JSON.parse(raw); } catch (e) { return null; } };

    async function resolve(map, key) {
      const raw = map[key];
      if (!raw) { chunkCount.set(key, 0); return null; }
      const n = header(raw);
      chunkCount.set(key, n);
      if (!n) return parse(raw);
      const keys = Array.from({ length: n }, (_, i) => chunkKey(key, i + 1));
      const got = await backend.getItems(keys);
      const joined = keys.map((k) => got[k] || "").join("");
      return parse(joined);
    }
    async function getMany(keys) {
      const map = await backend.getItems(keys);
      const out = {};
      for (const k of keys) out[k] = await resolve(map, k);
      return out;
    }
    const get = async (key) => (await getMany([key]))[key];

    async function knownChunks(key) {
      if (!chunkCount.has(key)) chunkCount.set(key, header((await backend.getItems([key]))[key]));
      return chunkCount.get(key);
    }
    async function put(key, value) {
      if (!KEY_RE.test(key)) throw new StorageError("bad_key", key);
      const json = JSON.stringify(value);
      const oldN = await knownChunks(key);
      try {
        let newN = 0;
        if (utf8(json) <= DIRECT_BYTES) {
          await backend.setItem(key, json);
        } else {
          const parts = splitByBytes(json, CHUNK_BYTES);
          newN = parts.length;
          for (let i = 0; i < parts.length; i++) await backend.setItem(chunkKey(key, i + 1), parts[i]);   // сначала части,
          await backend.setItem(key, JSON.stringify({ __chunks: newN }));                                  // потом заголовок
        }
        chunkCount.set(key, newN);
        if (oldN > newN) await backend.removeItems(Array.from({ length: oldN - newN }, (_, i) => chunkKey(key, newN + i + 1)));
      } catch (e) { chunkCount.delete(key); throw classify(e); }
    }
    async function del(key) {
      const n = await knownChunks(key);
      try { await backend.removeItems([key, ...Array.from({ length: n }, (_, i) => chunkKey(key, i + 1))]); }
      catch (e) { throw classify(e); }
      chunkCount.set(key, 0);
    }
    async function keys() { return (await backend.getKeys()) || []; }
    /** Логические ключи с префиксом (части больших значений не показываем). */
    async function list(prefix) { return (await keys()).filter((k) => k.startsWith(prefix) && !k.includes(CHUNK_SEP)); }
    /** Стирает всё, кроме перечисленных логических ключей (и их частей). */
    async function clear(keep = []) {
      const all = await keys();
      const keepSet = new Set(keep);
      const doomed = all.filter((k) => !keepSet.has(k.split(CHUNK_SEP)[0]));
      try { for (const part of slices(doomed, BATCH)) await backend.removeItems(part); }
      catch (e) { throw classify(e); }
      chunkCount.clear();
      return doomed.length;
    }
    async function usage() { const k = await keys(); return { keys: k.length, max_keys: MAX_KEYS }; }

    return { kind: backend.kind, backend, get, getMany, put, del, keys, list, clear, usage };
  }

  return { KEY_RE, MAX_VALUE, MAX_KEYS, CHUNK_SEP, StorageError, classify, utf8, splitByBytes, cloudBackend, memoryBackend,
    localBackend, chooseBackend, createStore };
});
