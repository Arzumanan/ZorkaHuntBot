/* Зорька — Mini App. Ядро: DOM-помощники, локальный API (данные в CloudStorage Telegram, погода из Open-Meteo),
   Telegram-интеграция. Без сборки и внешних библиотек. */
(function () {
  "use strict";
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  const API = (window.ZORKA_API_BASE || "").replace(/\/$/, "");     // нужен только для разового переноса из старой базы
  const VERSION = ((document.currentScript && document.currentScript.src) || "").split("?")[1] || "";
  const view = document.getElementById("view");
  const state = { me: null, tab: "weather", placeKey: null, cache: {} };
  const Z = { tg, view, state, views: {}, API };
  window.Z = Z;

  // ---------- DOM: всё через текстовые узлы, пользовательский текст не попадает в разметку ----------
  const PROPS = new Set(["value", "checked", "disabled", "selected", "indeterminate"]);
  Z.h = function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (PROPS.has(k)) el[k] = v;
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  };
  const svgNS = "http://www.w3.org/2000/svg";
  Z.s = function s(tag, attrs, ...children) {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  Z.fmt = (v, d = 0, unit = "") => (v == null ? "—" : Number(v).toFixed(d) + unit);
  Z.fmtDate = (iso) => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };
  Z.todayISO = () => ZL.dates.todayIn(state.me && state.me.timezone, new Date());

  // ---------- локальный API ----------
  // Те же вызовы, что раньше шли на сервер, но выполняются на устройстве (см. lib/api.js). Ошибки: Error с полем code.
  Z.init = async function init() {
    const backend = ZL.storage.chooseBackend(window);
    Z.local = await ZL.api.create({
      backend,
      fetch: (...args) => window.fetch(...args),
      loadJSON: async (name) => {
        const resp = await window.fetch("data/" + name + (VERSION ? "?" + VERSION : ""));
        if (!resp.ok) throw new Error("Не удалось загрузить данные приложения (" + name + ").");
        return resp.json();
      },
    });
    return backend.kind;
  };
  Z.api = async function api(path, opts) {
    if (!Z.local) throw Object.assign(new Error("Хранилище ещё не готово."), { code: "not_ready" });
    try {
      return await Z.local.handle(path, (opts && opts.method) || "GET", opts && opts.body ? JSON.parse(opts.body) : {});
    } catch (e) {
      const err = new Error(e && e.message ? e.message : "Ошибка");
      err.code = (e && e.code) || "error";
      throw err;
    }
  };
  Z.post = (path, body) => Z.api(path, { method: "POST", body: JSON.stringify(body || {}) });
  Z.legacy = () => ({ data: Z.local.data, fetch: (...a) => window.fetch(...a), base: API, initData: (tg && tg.initData) || "" });

  // ---------- Telegram: вибро-отклик, подтверждения, уведомления ----------
  const haptic = tg && tg.HapticFeedback;
  Z.haptic = {
    select() { if (haptic) try { haptic.selectionChanged(); } catch (e) { /* старый клиент */ } },
    tap() { if (haptic) try { haptic.impactOccurred("light"); } catch (e) { /* */ } },
    ok() { if (haptic) try { haptic.notificationOccurred("success"); } catch (e) { /* */ } },
    error() { if (haptic) try { haptic.notificationOccurred("error"); } catch (e) { /* */ } },
  };
  Z.confirm = function confirmDialog(message) {
    return new Promise((resolve) => {
      if (tg && tg.showConfirm && tg.isVersionAtLeast && tg.isVersionAtLeast("6.2")) tg.showConfirm(message, (ok) => resolve(!!ok));
      else resolve(window.confirm(message));
    });
  };
  let toastTimer = null;
  Z.toast = function toast(text, isError) {
    const el = document.getElementById("toast");
    el.textContent = text;
    el.classList.toggle("bad", !!isError);
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
    if (isError) Z.haptic.error();
  };
  Z.openLink = (ev, url) => { if (tg && tg.openLink) { ev.preventDefault(); tg.openLink(url); } };

  // ---------- общие экраны ----------
  // replaceChildren не разворачивает массивы и печатает false/undefined как текст — разворачиваем сами
  Z.render = (...nodes) => view.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
  Z.showLoader = (text) => Z.render(Z.h("div", { class: "loader" }, text || "Загрузка…"));
  Z.showError = (err, retry) => Z.render(Z.h("div", { class: "empty" },
    Z.h("p", { class: "error" }, err.message),
    retry && Z.h("button", { class: "btn", onclick: retry }, "Повторить")));
  Z.backBar = (title, onBack) => Z.h("div", { class: "backbar" },
    Z.h("button", { class: "icon-btn", onclick: onBack, "aria-label": "Назад" }, "←"), Z.h("b", {}, title));

  // ---------- профиль и выбор места ----------
  const placeSelect = document.getElementById("place-select");
  Z.loadMe = async function loadMe() {
    state.me = await Z.api("/me");
    const me = state.me;
    const options = me.places.map((p) => ({ key: p.key, title: (p.is_default ? "⭐ " : "") + p.name }));
    if (me.location) options.push({ key: "cur", title: "📍 " + (me.location.name || "Моё место") });
    placeSelect.replaceChildren(...options.map((o) => Z.h("option", { value: o.key }, o.title)));
    state.placeCount = options.length;
    if (!options.some((o) => o.key === state.placeKey)) state.placeKey = options.length ? options[0].key : null;
    placeSelect.value = state.placeKey || "";
    Z.syncHeader();
    return me;
  };
  Z.syncHeader = () => placeSelect.classList.toggle("hidden", state.tab !== "weather" || (state.placeCount || 0) < 2);
  placeSelect.addEventListener("change", () => { state.placeKey = placeSelect.value; Z.go("weather"); });

  // ---------- навигация ----------
  Z.go = async function go(tab) {
    state.tab = tab;
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    Z.syncHeader();
    const render = Z.views[tab];
    Z.showLoader();
    try { await render(); }
    catch (e) { if (state.tab === tab) Z.showError(e, () => Z.go(tab)); }
  };

  // «Нет места» / «нет региона» — вопрос прямо на вкладке, с возвратом после сохранения
  Z.askRegion = (after) => Z.views.regionPicker(after);
  Z.askCity = (after) => Z.views.cityForm(after);
})();
