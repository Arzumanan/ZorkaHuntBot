/* Вкладка «Ещё»: угодья, регион, место, утренняя рассылка. Плюс общие экраны выбора региона и города. */
(function () {
  "use strict";
  const { h, state, view } = Z;

  // ---------- выбор региона ----------
  Z.views.regionPicker = async function regionPicker(afterSave) {
    Z.showLoader();
    let regions;
    try { regions = await Z.api("/api/regions"); } catch (e) { return Z.showError(e, () => regionPicker(afterSave)); }
    const list = h("div", {});
    const input = h("input", { type: "text", placeholder: "Поиск региона…", autocomplete: "off" });
    const norm = (t) => t.toLowerCase().replace(/ё/g, "е");
    const draw = () => {
      const q = norm(input.value.trim());
      list.replaceChildren(...regions.filter((r) => norm(r.name).includes(q)).slice(0, 40).map((r) =>
        h("button", { class: "region-item", onclick: async () => {
          try { await Z.post("/api/region", { code: r.code }); Z.haptic.ok(); await Z.loadMe(); afterSave(); }
          catch (e) { Z.toast(e.message, true); }
        } }, (r.verified ? "✅ " : "") + r.name)));
    };
    input.addEventListener("input", draw);
    draw();
    Z.render(h("div", { class: "card" }, h("h3", {}, "🗺 Выберите регион"),
      h("div", { class: "muted" }, "✅ — есть региональные сроки. Для остальных покажу федеральные."), input), list);
    if (state.me && state.me.region) view.prepend(Z.backBar("Регион", () => Z.go(state.tab)));   // можно передумать
  };

  // ---------- поиск города (место «по умолчанию», пока нет угодий) ----------
  Z.views.cityForm = function cityForm(afterSave) {
    const input = h("input", { type: "text", placeholder: "Город или населённый пункт", autocomplete: "off" });
    const msg = h("div", { class: "error" });
    const go = async () => {
      msg.textContent = "";
      if (!input.value.trim()) return;
      try { await Z.post("/api/location", { city: input.value }); Z.haptic.ok(); await Z.loadMe(); afterSave(); }
      catch (e) { msg.textContent = e.message; }
    };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") go(); });
    Z.render(h("div", { class: "card" }, h("h3", {}, "📍 Где вы охотитесь?"),
      h("div", { class: "muted" }, "В Mini App нельзя запросить геолокацию, поэтому найдите город. Точное угодье с координатами можно добавить во вкладке «Ещё»."),
      h("div", { style: "margin:8px 0" }, input), msg, h("button", { class: "btn", onclick: go }, "Найти и сохранить")),
      h("div", { style: "text-align:center" }, h("button", { class: "btn secondary", onclick: () => Z.go("more") }, "Добавить угодье")));
  };

  // ---------- угодья ----------
  function placesCard(places, max, reload) {
    const rows = places.map((p) => {
      const nameInput = h("input", { type: "text", value: p.name, maxlength: "60", class: "hidden" });
      const title = h("b", {}, (p.is_default ? "⭐ " : "") + p.name);
      const rename = async () => {
        const name = nameInput.value.trim();
        if (!name || name === p.name) { nameInput.classList.add("hidden"); title.classList.remove("hidden"); return; }
        try { await Z.post("/api/places/update", { id: p.id, name }); Z.haptic.ok(); await reload(); }
        catch (e) { Z.toast(e.message, true); }
      };
      nameInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") rename(); });
      nameInput.addEventListener("blur", rename);
      return h("div", { class: "place-row" },
        h("div", { class: "place-main" }, title, nameInput,
          h("div", { class: "muted" }, `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}` + (p.is_default ? " · по умолчанию" : ""))),
        h("div", { class: "place-actions" },
          !p.is_default && h("button", { class: "icon-btn", "aria-label": "Сделать основным", title: "Сделать основным", onclick: async () => {
            try { await Z.post("/api/places/update", { id: p.id, is_default: true }); Z.haptic.select(); await reload(); } catch (e) { Z.toast(e.message, true); }
          } }, "⭐"),
          h("button", { class: "icon-btn", "aria-label": "Переименовать", title: "Переименовать", onclick: () => {
            title.classList.add("hidden"); nameInput.classList.remove("hidden"); nameInput.focus(); nameInput.select();
          } }, "✏️"),
          h("button", { class: "icon-btn del", "aria-label": "Удалить угодье", title: "Удалить", onclick: async () => {
            if (!(await Z.confirm(`Удалить угодье «${p.name}»?`))) return;
            try { await Z.post("/api/places/delete", { id: p.id }); Z.haptic.tap(); await reload(); } catch (e) { Z.toast(e.message, true); }
          } }, "🗑")));
    });

    // форма добавления: город или координаты, имя необязательно
    let mode = "city";
    const city = h("input", { type: "text", placeholder: "Город или населённый пункт", autocomplete: "off" });
    const lat = h("input", { type: "text", inputmode: "decimal", placeholder: "Широта, например 45.04", autocomplete: "off" });
    const lon = h("input", { type: "text", inputmode: "decimal", placeholder: "Долгота, например 38.98", autocomplete: "off" });
    const name = h("input", { type: "text", maxlength: "60", placeholder: "Название (необязательно)", autocomplete: "off" });
    const msg = h("div", { class: "error" });
    const cityBox = h("div", {}, city);
    const coordBox = h("div", { class: "hidden" }, h("div", { class: "row" }, lat, lon));
    const modeBtns = [["city", "По городу"], ["coords", "По координатам"]].map(([m, t]) =>
      h("button", { class: m === mode ? "active" : "", onclick: () => {
        mode = m;
        modeBtns.forEach((b, i) => b.classList.toggle("active", ["city", "coords"][i] === m));
        cityBox.classList.toggle("hidden", m !== "city"); coordBox.classList.toggle("hidden", m !== "coords");
      } }, t));
    const add = async () => {
      msg.textContent = "";
      const body = { name: name.value };
      if (mode === "city") body.city = city.value;
      else { body.lat = parseFloat(lat.value.replace(",", ".")); body.lon = parseFloat(lon.value.replace(",", ".")); }
      if (mode === "coords" && (Number.isNaN(body.lat) || Number.isNaN(body.lon))) { msg.textContent = "Введите широту и долготу числами."; return; }
      try { await Z.post("/api/places", body); Z.haptic.ok(); Z.toast("Угодье добавлено"); await reload(); }
      catch (e) { msg.textContent = e.message; }
    };
    const full = places.length >= max;
    return h("div", { class: "card" },
      h("h3", {}, "🏞 Угодья"),
      places.length ? rows : h("div", { class: "muted" }, "Пока нет сохранённых угодий. Прогноз и подсказки строятся по первому из них."),
      h("h4", {}, "Добавить угодье"),
      full ? h("div", { class: "muted" }, `Достигнут предел: ${max} угодий.`) : h("div", {},
        h("div", { class: "seg" }, modeBtns), cityBox, coordBox,
        h("div", { style: "margin:8px 0" }, name), msg, h("button", { class: "btn", onclick: add }, "Добавить")));
  }

  // ---------- рассылка ----------
  function digestCard(st, me) {
    const sw = h("input", { type: "checkbox", checked: st.subscribed, class: "switch", "aria-label": "Утренняя рассылка" });
    const time = h("input", { type: "time", value: st.send_time });
    const tz = h("select", {}, st.timezones.map((t) => h("option", { value: t.code, selected: t.code === st.timezone }, t.name)));
    const save = async (patch, revert) => {
      try { await Z.post("/api/settings", patch); Z.haptic.ok(); Z.toast("Сохранено"); await Z.loadMe(); }
      catch (e) { Z.toast(e.message, true); if (revert) revert(); }
    };
    sw.addEventListener("change", () => save({ subscribed: sw.checked }, () => { sw.checked = !sw.checked; }));
    time.addEventListener("change", () => { if (time.value) save({ send_time: time.value }, () => { time.value = st.send_time; }); });
    tz.addEventListener("change", () => save({ timezone: tz.value }, () => { tz.value = st.timezone; }));
    return h("div", { class: "card" },
      h("h3", {}, "🔔 Утренняя рассылка"),
      h("label", { class: "kv switch-row" }, h("span", {}, "Присылать прогноз"), sw),
      h("div", { class: "muted" }, "По субботам и воскресеньям, только если в вашем регионе открыт какой-то сезон. Сообщение придёт в чат с ботом."),
      !st.region ? h("div", { class: "error", style: "margin-top:4px" }, "Выберите регион в разделе «Регион» — без него сезон не определить.") : null,
      h("div", { class: "field" }, h("span", { class: "muted" }, "Время отправки"), time),
      h("div", { class: "field" }, h("span", { class: "muted" }, "Часовой пояс"), tz),
      h("div", { class: "muted" }, "Если сообщения не приходят, откройте чат с ботом и нажмите /start."));
  }

  function regionCard(st) {
    return h("div", { class: "card" },
      h("h3", {}, "🗺 Регион"),
      h("div", { class: "kv" }, h("span", {}, "Выбран"), h("b", {}, st.region ? st.region.name : "не выбран")),
      h("div", { class: "muted" }, st.region && st.region.verified ? "✅ Для региона есть проверенные сроки." : "Для остальных регионов показываются федеральные сроки."),
      h("button", { class: "btn secondary", style: "margin-top:8px", onclick: () => Z.askRegion(() => Z.go("more")) }, st.region ? "Сменить регион" : "Выбрать регион"));
  }

  function locationCard(me) {
    return h("div", { class: "card" },
      h("h3", {}, "📍 Текущее место"),
      h("div", { class: "kv" }, h("span", {}, "Город"), h("b", {}, me.location ? (me.location.name || "по координатам") : "не указано")),
      h("div", { class: "muted" }, "Используется для прогноза, если угодий нет, и доступно в выборе места рядом с ними."),
      h("button", { class: "btn secondary", style: "margin-top:8px", onclick: () => {
        Z.views.cityForm(() => Z.go("more"));
        view.prepend(Z.backBar("Текущее место", () => Z.go("more")));
      } }, me.location ? "Сменить место" : "Указать место"));
  }

  Z.views.more = async function renderMore() {
    await Z.loadMe();
    const [places, settings] = await Promise.all([Z.api("/api/places"), Z.api("/api/settings")]);
    if (state.tab !== "more") return;
    const reload = async () => { await Z.go("more"); };
    Z.render(
      placesCard(places.places, places.max, reload),
      regionCard(settings),
      locationCard(state.me),
      digestCard(settings, state.me),
      h("div", { class: "card muted" },
        "Зорька — справочный помощник. Оценки активности и сроки охоты ориентировочные: точные даты уточняйте в региональном охотуправлении."));
  };
})();
