/* Зорька — Mini App (фаза 1: прогноз, активность, сезоны). Без сборки и внешних библиотек. */
(function () {
  "use strict";
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  const API = (window.ZORKA_API_BASE || "").replace(/\/$/, "");
  const view = document.getElementById("view");
  const placeSelect = document.getElementById("place-select");
  const state = { me: null, tab: "forecast", placeKey: null, dayIdx: 0, cache: {} };

  // ---------- утилиты ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const svgNS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, ...children) {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  const fmt = (v, d = 0, unit = "") => (v == null ? "—" : Number(v).toFixed(d) + unit);
  const fmtDate = (iso) => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };
  const STATE_LABEL = { open: "открыт", upcoming: "скоро", closed: "закрыт", banned: "нет" };

  async function api(path, opts) {
    const headers = { "X-Telegram-Init-Data": (tg && tg.initData) || "" };
    if (opts && opts.body) headers["Content-Type"] = "application/json";
    let resp;
    try { resp = await fetch(API + path, Object.assign({ headers }, opts || {})); }
    catch (e) { const err = new Error("Нет связи с сервером."); err.code = "network"; throw err; }
    let data = null;
    try { data = await resp.json(); } catch (e) { /* не JSON */ }
    if (!resp.ok) {
      const err = new Error((data && data.message) || "Ошибка " + resp.status);
      err.code = (data && data.error) || "http_" + resp.status;
      throw err;
    }
    return data;
  }
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

  function showLoader() { view.replaceChildren(h("div", { class: "loader" }, "Загрузка…")); }
  function showError(err, retry) {
    view.replaceChildren(h("div", { class: "empty" },
      h("p", { class: "error" }, err.message),
      retry && h("button", { class: "btn", onclick: retry }, "Повторить")));
  }

  // ---------- графики (inline SVG) ----------
  function lineChart(times, series, opts) {
    const W = 320, H = 130, L = 30, R = 8, T = 8, B = 20;
    const all = series.flatMap((x) => x.values).filter((v) => v != null);
    if (!all.length) return h("div", { class: "muted" }, "нет данных");
    let min = Math.min(...all), max = Math.max(...all);
    if (opts.min != null) min = Math.min(min, opts.min);
    if (max - min < (opts.minSpan || 1)) { const mid = (max + min) / 2; min = mid - (opts.minSpan || 1) / 2; max = mid + (opts.minSpan || 1) / 2; }
    const pad = (max - min) * 0.1; min -= pad; max += pad;
    if (opts.zero) min = Math.max(0, min);
    const n = times.length;
    const x = (i) => L + (i * (W - L - R)) / Math.max(1, n - 1);
    const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": opts.label });
    // ночь / день: полоса между восходом и закатом
    if (opts.sunrise != null) {
      const xs = (hr) => L + (hr / 23) * (W - L - R);
      svg.append(s("rect", { x: xs(opts.sunrise), y: T, width: Math.max(0, xs(opts.sunset) - xs(opts.sunrise)), height: H - T - B, fill: "rgba(249,171,0,.12)" }));
      for (const hr of [opts.sunrise, opts.sunset]) svg.append(s("line", { x1: xs(hr), x2: xs(hr), y1: T, y2: H - B, stroke: "rgba(249,171,0,.6)", "stroke-dasharray": "3 3" }));
    }
    for (let k = 0; k <= 3; k++) {
      const v = min + ((max - min) * k) / 3;
      svg.append(s("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: "rgba(128,128,128,.25)" }));
      svg.append(s("text", { x: L - 4, y: y(v) + 3, "text-anchor": "end" }, v.toFixed(opts.digits || 0)));
    }
    for (let i = 0; i < n; i += 6) svg.append(s("text", { x: x(i), y: H - 6, "text-anchor": "middle" }, times[i]));
    if (opts.bars) {
      const bw = (W - L - R) / n - 1;
      series[0].values.forEach((v, i) => { if (v != null && v > 0) svg.append(s("rect", { x: x(i) - bw / 2, y: y(v), width: Math.max(1, bw), height: H - B - y(v), fill: series[0].color })); });
    } else {
      for (const sr of series) {
        let d = "";
        sr.values.forEach((v, i) => { if (v != null) d += (d && sr.values[i - 1] != null ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1); });
        svg.append(s("path", { d, fill: "none", stroke: sr.color, "stroke-width": 2, "stroke-linejoin": "round" }));
      }
    }
    const legend = h("div", { class: "legend" }, series.map((sr) => h("span", {}, h("i", { style: "background:" + sr.color }), sr.name)));
    return h("div", {}, svg, legend);
  }

  function windArrow(deg) {
    // направление «откуда дует»; стрелка показывает, куда дует (+180°)
    const rot = deg == null ? 0 : (deg + 180) % 360;
    return s("svg", { viewBox: "0 0 40 40", class: "arrow", style: deg == null ? "opacity:.3" : "" },
      s("g", { transform: `rotate(${rot} 20 20)` },
        s("path", { d: "M20 4 L28 20 L22 20 L22 36 L18 36 L18 20 L12 20 Z", fill: "var(--btn)" })));
  }

  // ---------- вкладка «Прогноз» ----------
  function windowCard(title, w) {
    return h("div", { class: "card" },
      h("h3", {}, title),
      h("div", { class: "wind" }, windArrow(w.wind_direction),
        h("div", {}, h("b", {}, fmt(w.wind_speed, 1, " м/с"), " ", w.wind_direction_name),
          h("div", { class: "muted" }, "порывы до ", fmt(w.wind_gusts, 0, " м/с")))),
      h("div", { class: "kv" }, h("span", {}, "Температура"), h("span", {}, fmt(w.temperature, 0, "°C"))),
      h("div", { class: "kv" }, h("span", {}, "Осадки"), h("span", {}, fmt(w.precipitation, 1, " мм"))),
      h("div", { class: "kv" }, h("span", {}, "Давление"), h("span", {}, fmt(w.pressure_mmhg, 0, " мм рт. ст."))),
      h("div", { class: "kv" }, h("span", {}, "Облачность"), h("span", {}, fmt(w.cloud_cover, 0, "%"))));
  }

  function renderForecast(data) {
    if (!data.days.length) { view.replaceChildren(h("div", { class: "empty" }, "Нет данных для этого места.")); return; }
    state.dayIdx = Math.min(state.dayIdx, data.days.length - 1);
    const day = data.days[state.dayIdx];
    const names = { today: "Сегодня", tomorrow: "Завтра" };
    const seg = h("div", { class: "seg" }, data.days.map((d, i) =>
      h("button", { class: i === state.dayIdx ? "active" : "", onclick: () => { state.dayIdx = i; renderForecast(data); } },
        `${names[d.label] || d.label}, ${d.title}`)));
    const sc = day.score;
    const hr = day.hourly;
    const sunOpts = { sunrise: day.sunrise_hour, sunset: day.sunset_hour };
    view.replaceChildren(
      h("div", { class: "muted" }, "📍 " + data.place.title),
      seg,
      h("div", { class: "card" },
        h("div", { class: "score" },
          h("div", { class: "num" }, sc.value, h("small", {}, "/5")),
          h("div", {}, h("div", { class: "stars" }, "⭐".repeat(sc.value) + "▫️".repeat(5 - sc.value)),
            h("b", {}, sc.label), h("div", { class: "muted" }, "Оценка дня для выезда"))),
        h("div", { class: "muted", style: "margin-top:6px" }, sc.reasons.join("; ") + "."),
        h("div", { class: "row", style: "margin-top:8px" },
          h("div", {}, "🌅 ", h("b", {}, day.sunrise)), h("div", {}, "🌇 ", h("b", {}, day.sunset)),
          h("div", {}, day.moon.emoji + " ", h("b", {}, Math.round(day.moon.illumination * 100) + "%")))),
      h("div", { class: "muted" }, day.moon.name),
      windowCard("Утренняя зорька", day.dawn),
      windowCard("Вечерняя зорька", day.dusk),
      h("div", { class: "card" }, h("h3", {}, "Ветер, м/с"),
        lineChart(hr.time, [{ name: "ветер", values: hr.wind_speed, color: "#2481cc" }, { name: "порывы", values: hr.wind_gusts, color: "#d93025" }],
          Object.assign({ label: "Ветер", zero: true, minSpan: 4 }, sunOpts))),
      h("div", { class: "card" }, h("h3", {}, "Давление, мм рт. ст."),
        lineChart(hr.time, [{ name: "давление", values: hr.pressure_mmhg, color: "#8e44ad" }], Object.assign({ label: "Давление", minSpan: 6 }, sunOpts)),
        h("div", { class: "muted" }, day.pressure_change == null ? "" : "За 12 ч до рассвета: " + (day.pressure_change >= 0 ? "+" : "") + day.pressure_change.toFixed(1) + " гПа")),
      h("div", { class: "card" }, h("h3", {}, "Температура, °C"),
        lineChart(hr.time, [{ name: "температура", values: hr.temperature, color: "#f9ab00" }], Object.assign({ label: "Температура", minSpan: 4 }, sunOpts))),
      h("div", { class: "card" }, h("h3", {}, "Осадки, мм/ч"),
        lineChart(hr.time, [{ name: "осадки", values: hr.precipitation, color: "#34a853" }], Object.assign({ label: "Осадки", bars: true, zero: true, min: 0, minSpan: 1, digits: 1 }, sunOpts)),
        h("div", { class: "muted" }, "Жёлтая полоса — светлое время между восходом и закатом.")));
  }

  // ---------- вкладка «Активность» ----------
  function actBar(value) {
    const color = value >= 4 ? "var(--ok)" : value === 3 ? "var(--warn)" : "var(--bad)";
    return h("div", { class: "bar" }, h("div", { style: `width:${value * 20}%;background:${color}` }));
  }
  function renderActivity(data) {
    if (!data.days.length) { view.replaceChildren(h("div", { class: "empty" }, "Нет данных для этого места.")); return; }
    state.dayIdx = Math.min(state.dayIdx, data.days.length - 1);
    const day = data.days[state.dayIdx];
    const names = { today: "Сегодня", tomorrow: "Завтра" };
    const seg = h("div", { class: "seg" }, data.days.map((d, i) =>
      h("button", { class: i === state.dayIdx ? "active" : "", onclick: () => { state.dayIdx = i; renderActivity(data); } },
        `${names[d.label] || d.label}, ${d.title}`)));
    view.replaceChildren(
      h("div", { class: "muted" }, "📍 " + data.place.title + " · " + day.moon.emoji + " " + day.moon.name),
      seg,
      day.activity.map((g) => h("div", { class: "card" },
        h("h3", {}, g.emoji + " " + g.title),
        h("div", { class: "kv" }, h("span", {}, "Утро"), h("b", {}, g.dawn.value + "/5 · " + g.dawn.label)), actBar(g.dawn.value),
        h("div", { class: "kv" }, h("span", {}, "Вечер"), h("b", {}, g.dusk.value + "/5 · " + g.dusk.label)), actBar(g.dusk.value),
        h("div", { class: "muted", style: "margin-top:6px" }, "Утром: " + g.dawn.reasons.join("; ") + "."))),
      h("div", { class: "card notice" }, "ℹ️ " + data.disclaimer));
  }

  // ---------- вкладка «Сезоны» ----------
  function entryNode(e) {
    let when = "";
    if (e.state === "open") when = "до " + fmtDate(e.current_end);
    else if (e.state === "upcoming") when = `откроется ${fmtDate(e.next_start)} (через ${e.days_to_open} дн.)`;
    else if (e.state === "closed" && e.next_start) when = "следующий — с " + fmtDate(e.next_start);
    const ranges = e.windows.map((w) => `${fmtDate(w.start)} — ${fmtDate(w.end)}`).join("; ");
    return h("div", { class: "entry" },
      h("div", {}, h("span", { class: "chip " + e.state }, e.frame ? "рамки" : STATE_LABEL[e.state]), " ", h("span", { class: "name" }, e.name)),
      when && h("div", {}, when),
      ranges && h("div", { class: "muted" }, ranges),
      e.confidence === "regional_reported" && h("div", { class: "muted" }, "⚠️ по сообщениям, проверьте"),
      e.note && h("div", { class: "muted" }, e.note));
  }
  function renderSeasons(data) {
    const links = data.sources.map((src) => h("li", {}, h("a", { href: src.url, onclick: (ev) => { if (tg && tg.openLink) { ev.preventDefault(); tg.openLink(src.url); } } }, src.title)));
    view.replaceChildren(
      h("div", { class: "card notice" + (data.verified ? " ok" : "") },
        h("b", {}, data.region.name), h("div", { class: "muted" }, "Сегодня " + fmtDate(data.today) + " · открыто сейчас: " + data.open_count),
        h("div", {}, data.verified ? data.summary : "Для этого региона нет проверенных региональных дат: показаны федеральные сроки (приказ Минприроды № 477)."),
        h("div", { class: "muted", style: "margin-top:6px" }, "⚠️ " + data.disclaimer)),
      data.categories.filter((c) => c.entries.length).map((c) => h("div", { class: "card" }, h("h3", {}, c.title), c.entries.map(entryNode))),
      data.notes && h("div", { class: "card" }, "ℹ️ " + data.notes),
      h("div", { class: "card" }, h("h3", {}, "Источники"), h("ul", { class: "plain" }, links),
        h("div", { class: "muted" }, "Это справка, а не юридический документ.")));
  }

  // ---------- пустые состояния и настройки ----------
  async function renderRegionPicker(afterSave) {
    showLoader();
    let regions;
    try { regions = await api("/api/regions"); } catch (e) { return showError(e, () => renderRegionPicker(afterSave)); }
    const list = h("div", {});
    const input = h("input", { type: "text", placeholder: "Поиск региона…", autocomplete: "off" });
    const draw = () => {
      const q = input.value.trim().toLowerCase().replace(/ё/g, "е");
      list.replaceChildren(...regions.filter((r) => r.name.toLowerCase().replace(/ё/g, "е").includes(q)).slice(0, 40).map((r) =>
        h("button", { class: "region-item", onclick: async () => {
          try { await post("/api/region", { code: r.code }); state.cache = {}; await loadMe(); afterSave(); }
          catch (e) { alert(e.message); }
        } }, (r.verified ? "✅ " : "") + r.name)));
    };
    input.addEventListener("input", draw);
    draw();
    view.replaceChildren(h("div", { class: "card" }, h("h3", {}, "🗺 Выберите регион"),
      h("div", { class: "muted" }, "✅ — есть региональные сроки. Для остальных покажу федеральные."), input), list);
  }

  function renderCityForm(afterSave) {
    const input = h("input", { type: "text", placeholder: "Город или населённый пункт", autocomplete: "off" });
    const msg = h("div", { class: "error" });
    const go = async () => {
      msg.textContent = "";
      if (!input.value.trim()) return;
      try { await post("/api/location", { city: input.value }); state.cache = {}; await loadMe(); afterSave(); }
      catch (e) { msg.textContent = e.message; }
    };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") go(); });
    view.replaceChildren(h("div", { class: "card" }, h("h3", {}, "📍 Где вы охотитесь?"),
      h("div", { class: "muted" }, "В Mini App нельзя запросить геолокацию, поэтому найдите город. Точное угодье можно добавить в боте командой /places."),
      h("div", { style: "margin:8px 0" }, input), msg, h("button", { class: "btn", onclick: go }, "Найти и сохранить")));
  }

  function renderSettings() {
    const me = state.me;
    view.replaceChildren(h("div", { class: "card" }, h("h3", {}, "Настройки"),
      h("div", { class: "kv" }, h("span", {}, "Регион"), h("span", {}, me.region ? me.region.name : "не выбран")),
      h("div", { class: "kv" }, h("span", {}, "Место"), h("span", {}, me.location ? (me.location.name || "по координатам") : "не указано")),
      h("div", { style: "display:flex;gap:8px;margin-top:10px;flex-wrap:wrap" },
        h("button", { class: "btn", onclick: () => renderRegionPicker(() => switchTab(state.tab)) }, "Сменить регион"),
        h("button", { class: "btn secondary", onclick: () => renderCityForm(() => switchTab(state.tab)) }, "Сменить место"))));
  }

  // ---------- загрузка ----------
  async function loadMe() {
    state.me = await api("/api/me");
    const me = state.me;
    const options = me.places.map((p) => ({ key: p.key, title: (p.is_default ? "⭐ " : "") + p.name }));
    if (me.location) options.push({ key: "cur", title: "📍 " + (me.location.name || "Моё место") });
    placeSelect.replaceChildren(...options.map((o) => h("option", { value: o.key }, o.title)));
    placeSelect.classList.toggle("hidden", options.length < 2);
    if (!options.some((o) => o.key === state.placeKey)) state.placeKey = options.length ? options[0].key : null;
    placeSelect.value = state.placeKey || "";
  }

  async function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    showLoader();
    try {
      if (tab === "seasons") renderSeasons(await api("/api/seasons"));
      else {
        const q = state.placeKey ? "?place_id=" + encodeURIComponent(state.placeKey) : "";
        const data = await api("/api/" + tab + q);
        (tab === "forecast" ? renderForecast : renderActivity)(data);
      }
    } catch (e) {
      if (e.code === "no_place") return renderCityForm(() => switchTab(tab));
      if (e.code === "no_region") return renderRegionPicker(() => switchTab(tab));
      showError(e, () => switchTab(tab));
    }
  }

  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  placeSelect.addEventListener("change", () => { state.placeKey = placeSelect.value; switchTab(state.tab); });
  document.getElementById("settings-btn").addEventListener("click", renderSettings);

  (async function init() {
    try { await loadMe(); } catch (e) { return showError(e, () => location.reload()); }
    switchTab("forecast");
  })();
})();
