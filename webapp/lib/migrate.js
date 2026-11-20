/* ВРЕМЕННО: разовый перенос данных из старой серверной базы (zorka.db на ПК автора) в CloudStorage.
   Запрос GET /api/legacy-export подписан initData; если базы нет, сервер отвечает 404 с JSON {"error":"no_legacy_db"|"no_legacy_data"}.
   Любой другой ответ (нет сети, HTML-404 статического хостинга, 5xx) не считается «данных нет»: метку не ставим, попробуем в следующий запуск.
   После успешного импорта вызывается POST /api/legacy-export/done — сервер стирает строки пользователя. Удалить после переноса (см. README). */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory();
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.migrate = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const HEADER = "X-Telegram-Init-Data";

  async function request(deps, path, method) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), deps.timeoutMs || 5000) : null;
    try {
      const resp = await deps.fetch(deps.base + path, { method, headers: { [HEADER]: deps.initData }, signal: ctrl ? ctrl.signal : undefined });
      let body = null;
      try { body = await resp.json(); } catch (e) { /* не JSON */ }
      return { status: resp.status, ok: resp.ok, body };
    } finally { if (timer) clearTimeout(timer); }
  }
  const isNoLegacy = (r) => r.status === 404 && r.body && typeof r.body.error === "string" && r.body.error.startsWith("no_legacy");

  /** deps: { data, fetch, base, initData, timeoutMs } → { status: browser|done|skipped|none|imported|error, report? } */
  async function run(deps) {
    if (!deps.initData) return { status: "browser" };                     // не в Telegram: переносить некому
    let mig;
    try { mig = await deps.data.getMigration(); } catch (e) { return { status: "error", error: e }; }
    if (mig && (mig.state === "done" || mig.state === "skipped")) return { status: mig.state };
    try {
      if (!mig) {                                                         // первая попытка
        const res = await request(deps, "/api/legacy-export", "GET");
        if (isNoLegacy(res)) { await deps.data.setMigration("skipped"); return { status: "none" }; }
        if (!res.ok || !res.body) return { status: "error", error: new Error("legacy " + res.status) };
        const report = await deps.data.importLegacy(res.body);
        await deps.data.setMigration("imported");
        mig = { state: "imported", report };
      }
      // данные уже в CloudStorage — просим сервер стереть их у себя
      const done = await request(deps, "/api/legacy-export/done", "POST");
      if (done.ok || isNoLegacy(done)) { await deps.data.setMigration("done"); return { status: "imported", report: mig.report || null, cleaned: true }; }
      return { status: "imported", report: mig.report || null, cleaned: false };
    } catch (e) { return { status: "error", error: e }; }
  }

  /** Удаление всех данных: заодно просим сервер стереть старую копию (best effort). */
  async function cleanupServer(deps) {
    if (!deps.initData) return false;
    try { const r = await request(deps, "/api/legacy-export/done", "POST"); return r.ok; } catch (e) { return false; }
  }
  return { HEADER, run, cleanupServer };
});
