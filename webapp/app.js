/* Зорька — Mini App: точка входа. Вкладки: Прогноз (с активностью), Сезоны, Чек-лист, Журнал, Ещё. */
(function () {
  "use strict";
  document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => {
    if (Z.state.tab !== b.dataset.tab) Z.haptic.select();
    Z.go(b.dataset.tab);
  }));
  (async function init() {
    try { await Z.loadMe(); } catch (e) { return Z.showError(e, () => location.reload()); }
    if (!Z.hasConsent()) return Z.showConsent();      // первый вход или новая версия политики
    const start = new URLSearchParams(location.search).get("tab");     // /?tab=checklist — удобно для проверки
    Z.go(Z.views[start] ? start : "weather");
  })();
})();
