/* Зорька — Mini App: точка входа. Вкладки: Прогноз (с активностью), Сезоны, Чек-лист, Журнал, Ещё. */
(function () {
  "use strict";
  document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => {
    if (Z.state.tab !== b.dataset.tab) Z.haptic.select();
    Z.go(b.dataset.tab);
  }));

  // ВРЕМЕННО: разовый перенос данных из старой серверной базы (см. README, «Перенос данных»)
  async function migrateLegacy() {
    const res = await ZL.migrate.run(Object.assign(Z.legacy(), { timeoutMs: 5000 }));
    if (res.status === "imported" && res.report) {
      const r = res.report;
      Z.toast(`Данные перенесены: угодий ${r.places}, записей журнала ${r.journal}`);
    }
  }

  async function init() {
    try {
      Z.showLoader();
      await Z.init();
      if (Z.tg && Z.tg.initData) {                 // перенос возможен только внутри Telegram
        Z.showLoader("Проверяю данные старой версии…");
        await migrateLegacy();
      }
      await Z.loadMe();
    } catch (e) { return Z.showError(e, init); }
    const start = new URLSearchParams(location.search).get("tab");     // ?tab=checklist — удобно для проверки
    Z.go(Z.views[start] ? start : "weather");
  }
  init();
})();
