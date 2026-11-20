/* Согласие на обработку данных, текст политики и удаление данных. */
(function () {
  "use strict";
  const { h, state, view } = Z;
  const nav = document.getElementById("nav");

  function chrome(on) {          // нижнее меню и выбор угодья скрыты, пока нет согласия
    nav.classList.toggle("hidden", !on);
    if (!on) document.getElementById("place-select").classList.add("hidden");
  }

  function policyBody(p) {
    return p.sections.map((sec) => h("div", { class: "policy-sec" },
      h("h3", {}, sec.title),
      (sec.paragraphs || []).map((t) => h("p", {}, t)),
      sec.items ? h("ul", { class: "plain" }, sec.items.map((i) => h("li", {}, i))) : null,
      (sec.after || []).map((t) => h("p", {}, t))));
  }

  // Полный текст политики; back — куда вернуться
  Z.views.policy = async function showPolicy(back) {
    Z.showLoader();
    let p;
    try { p = await Z.api("/api/policy"); } catch (e) { return Z.showError(e, () => showPolicy(back)); }
    Z.render(
      Z.backBar("Политика", back),
      h("div", { class: "card" }, h("h2", { class: "policy-title" }, p.title),
        h("div", { class: "muted" }, `Версия ${p.version} от ${p.date}`), policyBody(p)),
      h("div", { style: "text-align:center" }, h("button", { class: "btn secondary", onclick: back }, "Назад")));
  };

  // Экран согласия
  Z.showConsent = async function showConsent() {
    state.consentPending = true;
    chrome(false);
    Z.showLoader();
    let p;
    try { p = await Z.api("/api/policy"); } catch (e) { return Z.showError(e, Z.showConsent); }
    const box = h("input", { type: "checkbox", "aria-label": p.checkbox });
    const btn = h("button", { class: "btn wide", disabled: true }, "Принимаю");
    const msg = h("div", { class: "error" });
    box.addEventListener("change", () => { btn.disabled = !box.checked; Z.haptic.select(); });
    btn.addEventListener("click", async () => {
      if (!box.checked) return;
      btn.disabled = true; msg.textContent = "";
      try {
        await Z.post("/api/consent", { accept: true, version: p.version });
        state.consentPending = false;
        Z.haptic.ok();
        await Z.loadMe();
        chrome(true);
        Z.go("weather");
      } catch (e) { msg.textContent = e.message; btn.disabled = false; Z.haptic.error(); }
    });
    const draw = () => Z.render(
      h("div", { class: "card" },
        h("h2", { class: "policy-title" }, "🔒 Перед началом"),
        h("div", { class: "muted" }, "Оператор данных: " + p.operator + ". Связь: " + p.contact + "."),
        h("ul", { class: "plain consent-list" }, p.summary.map((t) => h("li", {}, t))),
        h("button", { class: "linkbtn", onclick: () => Z.views.policy(draw) }, "Читать политику полностью"),
        h("label", { class: "check-row consent-check" }, box, h("span", { class: "check-text" }, p.checkbox)),
        msg, btn),
      h("div", { class: "muted", style: "text-align:center" }, `Версия политики ${p.version}. Без согласия приложение не работает.`));
    draw();
  };

  // Сервер потребовал согласие (политика обновилась, пока приложение было открыто)
  Z.onConsentRequired = function () {
    if (state.consentPending) return;
    Z.loadMe().then(() => Z.showConsent());
  };

  // Удаление всех данных (вызывается из «Ещё»)
  Z.deleteAccount = async function deleteAccount() {
    const ok = await Z.confirm("Удалить все ваши данные безвозвратно: угодья, журнал, чек-лист, настройки и согласие? Это нельзя отменить.");
    if (!ok) return;
    try {
      await Z.post("/api/account/delete");
      Z.haptic.ok();
      Z.toast("Все данные удалены");
      state.me = null; state.placeKey = null;
      await Z.loadMe();
      Z.showConsent();
    } catch (e) { Z.toast(e.message, true); }
  };
})();
