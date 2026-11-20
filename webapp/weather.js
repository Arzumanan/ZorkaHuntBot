/* Вкладка «Прогноз»: погода и активность зверя и птицы (оба дня), графики на inline SVG. */
(function () {
  "use strict";
  const { h, s, fmt, state, view } = Z;
  state.weatherMode = "weather";    // weather | activity
  state.dayIdx = 0;

  // ---------- графики ----------
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
    if (opts.sunrise != null) {   // светлое время между восходом и закатом
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
  Z.lineChart = lineChart;

  function windArrow(deg) {
    const rot = deg == null ? 0 : (deg + 180) % 360;   // «откуда дует» → стрелка «куда»
    return s("svg", { viewBox: "0 0 40 40", class: "arrow", style: deg == null ? "opacity:.3" : "" },
      s("g", { transform: `rotate(${rot} 20 20)` },
        s("path", { d: "M20 4 L28 20 L22 20 L22 36 L18 36 L18 20 L12 20 Z", fill: "var(--btn)" })));
  }

  // ---------- погода ----------
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

  function weatherView(data) {
    state.dayIdx = Math.min(state.dayIdx, data.days.length - 1);
    const day = data.days[state.dayIdx];
    const seg = h("div", { class: "seg" }, data.days.map((d, i) =>
      h("button", { class: i === state.dayIdx ? "active" : "", onclick: () => { state.dayIdx = i; draw(data); } }, d.heading)));
    const sc = day.score, hr = day.hourly;
    const sunOpts = { sunrise: day.sunrise_hour, sunset: day.sunset_hour };
    return [
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
        h("div", { class: "muted" }, "Жёлтая полоса — светлое время между восходом и закатом.")),
    ];
  }

  // ---------- активность: сегодня и завтра ----------
  function actBar(value) {
    const color = value >= 4 ? "var(--ok)" : value === 3 ? "var(--warn)" : "var(--bad)";
    return h("div", { class: "bar" }, h("div", { style: `width:${value * 20}%;background:${color}` }));
  }
  function groupCard(g) {
    return h("div", { class: "card" },
      h("h3", {}, g.emoji + " " + g.title),
      h("div", { class: "kv" }, h("span", {}, "Утро"), h("b", {}, g.dawn.value + "/5 · " + g.dawn.label)), actBar(g.dawn.value),
      h("div", { class: "kv" }, h("span", {}, "Вечер"), h("b", {}, g.dusk.value + "/5 · " + g.dusk.label)), actBar(g.dusk.value),
      h("details", { class: "why" }, h("summary", {}, "Почему такая оценка"),
        h("div", { class: "muted" }, h("b", {}, "Утро: "), g.dawn.reasons.join("; ") + "."),
        h("div", { class: "muted", style: "margin-top:4px" }, h("b", {}, "Вечер: "), g.dusk.reasons.join("; ") + ".")));
  }
  function activityView(data) {
    return [
      ...data.days.map((d) => h("section", {},
        h("h2", { class: "day-title" }, d.heading),
        h("div", { class: "muted" }, d.moon.emoji + " " + d.moon.name + " · 🌅 " + d.sunrise + " · 🌇 " + d.sunset),
        d.activity.map(groupCard))),
      h("div", { class: "card notice" }, "ℹ️ " + data.activity_disclaimer),
    ];
  }

  function draw(data) {
    const mode = h("div", { class: "seg" },
      h("button", { class: state.weatherMode === "weather" ? "active" : "", onclick: () => { state.weatherMode = "weather"; draw(data); } }, "🌦 Погода"),
      h("button", { class: state.weatherMode === "activity" ? "active" : "", onclick: () => { state.weatherMode = "activity"; draw(data); } }, "🐾 Активность"));
    if (!data.days.length) { Z.render(h("div", { class: "empty" }, "Нет данных для этого места.")); return; }
    Z.render(
      h("div", { class: "muted" }, "📍 " + data.place.title.replace(/^(⭐|📍)\s*/, "")),
      mode,
      state.weatherMode === "weather" ? weatherView(data) : activityView(data));
  }

  Z.views.weather = async function renderWeather() {
    const q = state.placeKey ? "?place_id=" + encodeURIComponent(state.placeKey) : "";
    try {
      const data = await Z.api("/api/forecast" + q);
      if (state.tab !== "weather") return;
      draw(data);
    } catch (e) {
      if (state.tab !== "weather") return;
      if (e.code === "no_place") return Z.askCity(() => Z.go("weather"));
      throw e;
    }
  };
})();
