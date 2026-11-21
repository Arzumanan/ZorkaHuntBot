/* Вкладка «Карта»: охотничий навигатор. Leaflet подгружается только при открытии вкладки (без CDN). */
(function () {
  "use strict";
  const N = ZL.nav;
  const { h } = Z;
  const VERSION = ((document.currentScript && document.currentScript.src) || "").split("?")[1] || "";
  const qs = VERSION ? "?" + VERSION : "";
  const HOME = { lat: 44.82, lon: 39.54, zoom: 8 };     // середина между Краснодаром и Майкопом
  const TILES = {
    osm: {
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attr: [{ href: "https://www.openstreetmap.org/copyright", text: "© OpenStreetMap" }],
      maxZoom: 19, label: "Схема",
    },
    esri: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attr: [{ text: "Снимки © Esri, Maxar, Earthstar Geographics" }],
      maxZoom: 18, label: "Спутник",
    },
    topo: {
      url: "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
      attr: [
        { href: "https://www.openstreetmap.org/copyright", text: "© OSM" },
        { href: "https://opentopomap.org", text: "OpenTopoMap (CC-BY-SA)" },
      ],
      maxZoom: 17, label: "Рельеф",
    },
  };
  const OOPT_ATTR = { href: "https://www.openstreetmap.org/copyright", text: "ООПТ: OSM contributors (ODbL)" };
  const BOUNDARY_DISCLAIMER = "Границы ориентировочные, по официальным схемам; не проверены — сверяйтесь с охотпользователем";
  const TYPE_LABEL = { public: "Общедоступные угодья", assigned: "Закреплённые угодья", protection: "Зона охраны", oopt: "ООПТ" };
  const BOUNDARY_STYLE = {
    public: { color: "#2e7d32", weight: 2, fillOpacity: 0.14 },
    assigned: { color: "#1565c0", weight: 2, fillOpacity: 0.14 },
    protection: { color: "#e65100", weight: 2, fillOpacity: 0.16 },
    oopt: { color: "#6a1b9a", weight: 2, fillOpacity: 0.14 },
  };
  function boundaryKind(t) {
    const s = String(t || "").toLowerCase();
    if (/общедоступ|public/.test(s)) return "public";
    if (/охран|protection/.test(s)) return "protection";
    if (/оопт|oopt|заповед|заказник/.test(s)) return "oopt";
    return "assigned";
  }

  let leafletPromise = null, map = null, layers = {}, meMarker = null, meCircle = null, targetLine = null;
  let markLayer = null, placeLayer = null, windLayer = null, boundsLayer = null;
  let session = { layer: "esri", targetId: null, heading: null, pos: null, wind: null, showBounds: true, hasOopt: false };

  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "vendor/leaflet/leaflet.css" + qs;
      document.head.appendChild(css);
      const s = document.createElement("script");
      s.src = "vendor/leaflet/leaflet.js" + qs;
      s.onload = () => {
        if (window.L && L.Icon && L.Icon.Default) L.Icon.Default.imagePath = "vendor/leaflet/images/";
        resolve(window.L);
      };
      s.onerror = () => reject(new Error("Не удалось загрузить карту. Проверьте интернет и обновите страницу."));
      document.head.appendChild(s);
    });
    return leafletPromise;
  }

  const fromBrowserPos = (p, source) => ({
    lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy || null,
    heading: p.coords.heading != null && p.coords.heading >= 0 ? p.coords.heading : null, source,
  });
  const geoFail = (err) => { const info = N.describeGeoError(err); return Object.assign(new Error(info.message), info); };
  const telegramCapable = (tg) => {
    const lm = tg && tg.LocationManager;
    if (!lm) return false;
    if (tg.isVersionAtLeast && !tg.isVersionAtLeast("8.0")) return false;
    if (lm.isLocationAvailable === false) return false;
    return true;
  };
  function browserLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(geoFail({ code: "geo_unsupported" }));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve(fromBrowserPos(p, "browser")),
        (err) => reject(geoFail(err)),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 4000 });
    });
  }
  function telegramLocation(tg) {
    return new Promise((resolve, reject) => {
      const lm = tg.LocationManager;
      if (lm.isLocationAvailable === false) return reject(geoFail({ code: "geo_unavailable", message: "WebAppLocationManagerLocationNotAvailable" }));
      if (lm.isAccessRequested && !lm.isAccessGranted) return reject(geoFail({ code: "geo_denied", settings: true }));
      const finish = (loc) => {
        try {
          if (typeof loc === "string") return reject(geoFail(loc));
          if (loc && (typeof loc.error === "string" || typeof loc.error_code === "string")) return reject(geoFail(loc.error || loc.error_code));
          if (!loc || loc.latitude == null) return reject(geoFail({ code: "geo_unavailable" }));
          const course = loc.course;
          resolve({
            lat: loc.latitude, lon: loc.longitude, accuracy: loc.horizontal_accuracy || null,
            heading: course != null && course >= 0 && course <= 360 ? course : null, source: "telegram",
          });
        } catch (e) { reject(geoFail(e)); }
      };
      const start = () => {
        try {
          const ret = lm.getLocation(finish);
          if (ret && typeof ret.then === "function") ret.then(finish, (e) => reject(geoFail(e)));
        } catch (e) { reject(geoFail(e)); }
      };
      try {
        if (lm.isInited) start();
        else lm.init((res) => {
          if (res === false || (res && (res.error || res === "WebAppLocationManagerLocationNotAvailable"))) return reject(geoFail(res && res.error ? res.error : res || { code: "geo_unavailable" }));
          start();
        });
      } catch (e) { reject(geoFail(e)); }
    });
  }
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(geoFail({ code: "geo_timeout" })), ms);
      promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(geoFail(e)); });
    });
  }
  /** Telegram LocationManager, при недоступности — navigator.geolocation. Отказ в доступе не подменяем молча. */
  async function requestLocation(tg) {
    let last = null;
    if (telegramCapable(tg)) {
      try { return await withTimeout(telegramLocation(tg), 8000); }
      catch (e) {
        last = e;
        if (!N.shouldFallbackFromTelegram(N.describeGeoError(e))) throw geoFail(e);
      }
    } else if (tg && tg.LocationManager && tg.LocationManager.isLocationAvailable === false) {
      last = geoFail({ code: "geo_unavailable", message: "WebAppLocationManagerLocationNotAvailable" });
    }
    try { return await browserLocation(); }
    catch (e) {
      const prefer = last && N.describeGeoError(last).code === "geo_unavailable" ? last : e;
      throw geoFail(prefer);
    }
  }
  function startLocation(onPos, onErr) {
    let timer = null, watchId = null, stopped = false;
    const tick = () => {
      requestLocation(Z.tg).then((p) => {
        if (stopped) return;
        onPos(p);
        if (p.source === "browser" && navigator.geolocation && navigator.geolocation.watchPosition && watchId == null) {
          if (timer) { clearInterval(timer); timer = null; }
          watchId = navigator.geolocation.watchPosition(
            (pos) => { if (!stopped) onPos(fromBrowserPos(pos, "browser")); },
            (err) => { if (!stopped) onErr(geoFail(err)); },
            { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
        }
      }, (e) => { if (!stopped) onErr(geoFail(e)); });
    };
    tick();
    timer = setInterval(() => { if (!stopped && watchId == null) tick(); }, 8000);
    return () => { stopped = true; if (timer) clearInterval(timer); if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId); };
  }
  function openGeoSettings() {
    const tg = Z.tg, lm = tg && tg.LocationManager;
    if (lm && lm.openSettings) lm.openSettings();
    else if (tg && tg.openSettings) tg.openSettings();
    else Z.toast("Разрешите геопозицию в настройках Telegram или браузера.", true);
  }

  function startHeading(onHeading) {
    const tg = Z.tg;
    let stopped = false;
    const apply = (e) => { const deg = N.headingFromOrientation(e); if (deg != null && !stopped) onHeading(deg); };
    if (tg && tg.DeviceOrientation && (!tg.isVersionAtLeast || tg.isVersionAtLeast("8.0"))) {
      const handler = (e) => apply(e);
      if (tg.onEvent) tg.onEvent("deviceOrientationChanged", handler);
      try { tg.DeviceOrientation.start({ refresh_rate: 20, need_absolute: true }); } catch (e) { /* старый клиент */ }
      return () => { stopped = true; try { tg.DeviceOrientation.stop(); } catch (e) { /* */ } if (tg.offEvent) tg.offEvent("deviceOrientationChanged", handler); };
    }
    const handler = (e) => apply(e);
    const listen = () => {
      window.addEventListener("deviceorientationabsolute", handler, true);
      window.addEventListener("deviceorientation", handler, true);
    };
    const stop = () => {
      stopped = true;
      window.removeEventListener("deviceorientationabsolute", handler, true);
      window.removeEventListener("deviceorientation", handler, true);
    };
    if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) {
      DeviceOrientationEvent.requestPermission().then((res) => { if (res === "granted" && !stopped) listen(); }).catch(() => {});
    } else listen();
    return stop;
  }

  function emojiIcon(emoji, cls) {
    const el = document.createElement("div");
    el.className = "map-pin" + (cls ? " " + cls : "");
    el.append(document.createTextNode(emoji));
    return L.divIcon({ className: "map-divicon", html: el, iconSize: [32, 32], iconAnchor: [16, 30], popupAnchor: [0, -24] });
  }
  function meIcon() {
    const el = document.createElement("div");
    el.className = "map-me";
    return L.divIcon({ className: "map-divicon", html: el, iconSize: [22, 22], iconAnchor: [11, 11] });
  }

  function bindLongPress(leafMap, onPoint) {
    let timer = null, start = null;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    leafMap.on("contextmenu", (e) => {
      if (e.originalEvent) e.originalEvent.preventDefault();
      onPoint(e.latlng);
    });
    const box = leafMap.getContainer();
    box.addEventListener("touchstart", (ev) => {
      if (ev.touches.length !== 1) return cancel();
      const t = ev.touches[0];
      start = { x: t.clientX, y: t.clientY };
      cancel();
      timer = setTimeout(() => {
        timer = null;
        const latlng = leafMap.mouseEventToLatLng({ clientX: start.x, clientY: start.y });
        Z.haptic.tap();
        onPoint(latlng);
      }, 550);
    }, { passive: true });
    box.addEventListener("touchmove", (ev) => {
      if (!start || ev.touches.length !== 1) return cancel();
      const t = ev.touches[0];
      if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > 14) cancel();
    }, { passive: true });
    box.addEventListener("touchend", cancel);
    box.addEventListener("touchcancel", cancel);
    leafMap.on("zoomstart dragstart", cancel);
  }

  async function loadBoundaries(leaf) {
    const group = leaf.layerGroup();
    session.hasOopt = false;
    try {
      const resp = await fetch("data/boundaries/index.json" + qs);
      if (!resp.ok) return group;
      const list = await resp.json();
      const entries = (Array.isArray(list) ? list : []).map((x) => (typeof x === "string" ? { file: x } : (x || {})));
      for (const entry of entries) {
        const file = String(entry.file || "").replace(/^.*[/\\]/, "").replace(/[^\w.\-]/g, "");
        if (!file) continue;
        try {
          const r = await fetch("data/boundaries/" + file + qs);
          if (!r.ok) continue;
          const geo = await r.json();
          const fallbackType = entry.type || null;
          const layer = leaf.geoJSON(geo, {
            style: (f) => BOUNDARY_STYLE[boundaryKind((f && f.properties && (f.properties.type || f.properties.kind)) || fallbackType)],
            onEachFeature: (f, lyr) => {
              const p = (f && f.properties) || {};
              const kind = boundaryKind(p.type || p.kind || fallbackType);
              if (kind === "oopt") session.hasOopt = true;
              const lines = [
                TYPE_LABEL[kind] || null,
                p.user || null,
                p.protection_title && p.protection_title !== p.name ? p.protection_title : null,
                p.area_stated_ha ? ("площадь по акту: " + p.area_stated_ha + " га") : null,
                p.source || null,
                BOUNDARY_DISCLAIMER,
              ];
              lyr.bindPopup(() => popupNode(p.name || TYPE_LABEL[kind] || "Участок", lines));
            },
          });
          layer.addTo(group);
        } catch (e) { /* один файл битый — остальные всё равно пробуем */ }
      }
    } catch (e) { /* каталога нет — слой просто пустой */ }
    return group;
  }

  // ---------- отрисовка меток, угодий, ветра, себя ----------
  function popupNode(title, lines, buttons) {
    const box = h("div", { class: "map-pop" }, h("b", {}, title),
      (lines || []).map((t) => t ? h("div", { class: "muted" }, t) : null),
      buttons && buttons.length ? h("div", { class: "map-pop-btns" }, buttons) : null);
    return box;
  }
  function redrawMarks(marks) {
    if (!map || !markLayer) return;
    markLayer.clearLayers();
    for (const m of marks) {
      const mk = L.marker([m.lat, m.lon], { icon: emojiIcon(m.emoji), title: m.name, riseOnHover: true });
      mk.bindPopup(() => popupNode(m.emoji + " " + m.name, [m.type_name, m.note], [
        h("button", { class: "btn", onclick: () => { session.targetId = m.id; map.closePopup(); refreshPanel(); drawNavLine(); } }, "Вернуться"),
        h("button", { class: "btn secondary", onclick: () => { map.closePopup(); openForm(m); } }, "Изменить"),
      ]));
      mk.addTo(markLayer);
    }
  }
  function redrawPlaces(places) {
    if (!map || !placeLayer) return;
    placeLayer.clearLayers();
    for (const p of places) {
      const mk = L.marker([p.lat, p.lon], { icon: emojiIcon(p.is_default ? "⭐" : "🗺", "place"), title: p.name });
      mk.bindPopup(() => popupNode((p.is_default ? "⭐ " : "") + p.name, ["Угодье"], [
        h("button", { class: "btn", onclick: () => openForecast(p.key, "weather") }, "Прогноз"),
        h("button", { class: "btn secondary", onclick: () => openForecast(p.key, "activity") }, "Активность"),
      ]));
      mk.addTo(placeLayer);
    }
  }
  function openForecast(placeKey, mode) {
    Z.state.placeKey = placeKey;
    Z.state.weatherMode = mode;
    Z.go("weather");
  }
  function drawMe() {
    if (!map || !session.pos) return;
    const { lat, lon, accuracy } = session.pos;
    if (!meMarker) {
      meMarker = L.marker([lat, lon], { icon: meIcon(), zIndexOffset: 1000, keyboard: false }).addTo(map);
    } else meMarker.setLatLng([lat, lon]);
    if (accuracy && accuracy > 0) {
      if (!meCircle) meCircle = L.circle([lat, lon], { radius: accuracy, color: "#2481cc", weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      else { meCircle.setLatLng([lat, lon]); meCircle.setRadius(accuracy); }
    }
    drawNavLine();
    drawWindArrow();
  }
  function drawNavLine() {
    if (!map) return;
    const target = currentTarget();
    if (targetLine) { map.removeLayer(targetLine); targetLine = null; }
    if (!session.pos || !target) return;
    targetLine = L.polyline([[session.pos.lat, session.pos.lon], [target.lat, target.lon]], {
      color: "#d93025", weight: 3, opacity: 0.85, dashArray: "8 6", interactive: false,
    }).addTo(map);
  }
  function drawWindArrow() {
    if (!map || !windLayer) return;
    windLayer.clearLayers();
    const w = session.wind;
    if (!w || w.scent_drift == null) return;
    const origin = session.pos || (map.getCenter() && { lat: map.getCenter().lat, lon: map.getCenter().lng });
    if (!origin) return;
    const deg = w.scent_drift;
    const el = document.createElement("div");
    el.className = "map-wind-arrow";
    el.style.transform = "rotate(" + deg + "deg)";
    el.title = w.scent_text || "";
    L.marker([origin.lat, origin.lon], {
      icon: L.divIcon({ className: "map-divicon", html: el, iconSize: [44, 44], iconAnchor: [22, 22] }),
      interactive: false, zIndexOffset: 400,
    }).addTo(windLayer);
  }

  // ---------- панели ----------
  let panelEl = null, bannerEl = null, sheetEl = null, marksCache = [], placesCache = [];
  function currentTarget() {
    if (session.targetId == null) return null;
    return marksCache.find((m) => m.id === session.targetId) || null;
  }
  function refreshPanel() {
    if (!panelEl) return;
    panelEl.replaceChildren(panelContent());
  }
  function headingDeg() {
    if (session.heading != null) return session.heading;
    if (session.pos && session.pos.heading != null) return session.pos.heading;
    return null;
  }
  function panelContent() {
    const target = currentTarget();
    const pos = session.pos;
    const opts = [h("option", { value: "", selected: !target }, "Выберите метку")].concat(
      marksCache.map((m) => h("option", { value: String(m.id), selected: !!(target && target.id === m.id) }, m.emoji + " " + m.name)));
    const sel = h("select", { "aria-label": "Вернуться к метке", class: "map-target" }, opts);
    sel.addEventListener("change", () => {
      session.targetId = sel.value ? Number(sel.value) : null;
      drawNavLine(); refreshPanel();
    });
    let navInfo = h("div", { class: "muted" }, pos ? "Выберите метку, чтобы увидеть расстояние и направление." : "Включите геопозицию, чтобы вести к метке.");
    let arrow = null;
    if (pos && target) {
      const dist = N.distance(pos.lat, pos.lon, target.lat, target.lon);
      const az = N.bearing(pos.lat, pos.lon, target.lat, target.lon);
      const hd = headingDeg();
      const rel = N.relativeBearing(az, hd);
      const rot = rel != null ? rel : az;
      arrow = h("div", { class: "map-compass", title: hd != null ? "Стрелка относительно вашего курса" : "Азимут относительно севера" },
        h("div", { class: "map-compass-arrow", style: "transform:rotate(" + rot + "deg)" }, "▲"),
        h("div", { class: "map-compass-label" }, hd != null ? "курс" : "С"));
      navInfo = h("div", {},
        h("b", {}, N.formatDistance(dist)),
        h("div", { class: "muted" }, N.formatAzimuth(az) + (hd != null ? " · относительно курса " + Math.round(rel) + "°" : "")));
    }
    const w = session.wind;
    let windBlock = h("div", { class: "muted" }, "Запрашиваю ветер…");
    if (w) {
      const speed = w.wind_speed != null ? Number(w.wind_speed).toFixed(1) + " м/с" : "—";
      const from = w.wind_direction_name ? "ветер " + w.wind_direction_name : "";
      windBlock = h("div", { class: "map-wind-text" },
        h("div", {}, "💨 " + speed + (from ? ", " + from : "") + (w.scent_text ? ". " + w.scent_text : "")),
        target && w.approach_text ? h("div", {}, w.approach_text) : null);
    }
    return h("div", {},
      h("div", { class: "map-nav-row" },
        arrow,
        h("div", { class: "map-nav-main" },
          h("div", { class: "map-nav-label" }, "Вернуться к…"),
          sel, navInfo)),
      windBlock);
  }
  function showBanner(err) {
    if (!bannerEl) return;
    if (!err) { bannerEl.replaceChildren(); bannerEl.classList.add("hidden"); return; }
    const info = N.describeGeoError(err);
    bannerEl.classList.remove("hidden");
    const actions = [];
    if (info.settings && Z.tg && Z.tg.LocationManager && Z.tg.LocationManager.openSettings) {
      actions.push(h("button", { class: "btn secondary", onclick: openGeoSettings }, "Открыть настройки"));
    }
    actions.push(h("button", { class: "btn secondary", onclick: () => relocate(true) }, "Повторить"));
    bannerEl.replaceChildren(h("div", { class: "map-banner-inner" },
      h("div", { class: "map-banner-text" }, info.message),
      h("div", { class: "map-banner-actions" },
        actions,
        h("button", { class: "icon-btn map-banner-close", type: "button", "aria-label": "Закрыть", onclick: () => showBanner(null) }, "×"))));
  }
  function openSheet(node) {
    if (!sheetEl) return;
    sheetEl.replaceChildren(h("div", { class: "map-sheet-card" },
      h("button", { class: "icon-btn map-sheet-close", onclick: closeSheet, "aria-label": "Закрыть" }, "×"),
      node));
    sheetEl.classList.remove("hidden");
  }
  function closeSheet() { if (sheetEl) { sheetEl.classList.add("hidden"); sheetEl.replaceChildren(); } }

  function openForm(existing, latlng) {
    const isNew = !existing;
    const lat = existing ? existing.lat : latlng.lat, lon = existing ? existing.lon : latlng.lng;
    let type = existing ? existing.type : "other";
    const name = h("input", { type: "text", maxlength: String(N.NAME_MAX), placeholder: "Название (необязательно)", value: existing && existing.name !== N.TYPE_BY[existing.type].name ? existing.name : "" });
    const note = h("textarea", { rows: "3", maxlength: String(N.NOTE_MAX), placeholder: "Заметка" }, existing ? existing.note : "");
    if (existing && existing.note) note.value = existing.note;
    const chips = () => h("div", { class: "chips" }, N.MARK_TYPES.map((t) =>
      h("button", { class: "chipbtn" + (t.code === type ? " active" : ""), type: "button", onclick: (ev) => { type = t.code; ev.currentTarget.parentNode.replaceWith(chips()); } }, t.emoji + " " + t.name)));
    const save = async () => {
      try {
        if (isNew) await Z.post("/marks", { type, name: name.value, note: note.value, lat, lon });
        else await Z.post("/marks/update", { id: existing.id, type, name: name.value, note: note.value, lat, lon });
        Z.haptic.ok();
        closeSheet();
        await reloadMarks();
      } catch (e) { Z.toast(e.message, true); }
    };
    const del = existing ? h("button", { class: "btn secondary", onclick: async () => {
      if (!(await Z.confirm("Удалить метку «" + existing.name + "»?"))) return;
      try { await Z.post("/marks/delete", { id: existing.id }); Z.haptic.tap(); closeSheet(); await reloadMarks(); }
      catch (e) { Z.toast(e.message, true); }
    } }, "Удалить") : null;
    openSheet(h("div", {},
      h("h3", {}, isNew ? "Новая метка" : "Метка"),
      h("div", { class: "muted" }, lat.toFixed(5) + ", " + lon.toFixed(5)),
      h("div", { class: "field" }, h("span", {}, "Тип"), chips()),
      h("label", { class: "field" }, h("span", {}, "Название"), name),
      h("label", { class: "field" }, h("span", {}, "Заметка"), note),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: save }, "Сохранить"), del)));
  }
  function openList() {
    const pos = session.pos;
    const rows = marksCache.length ? marksCache.map((m) => {
      const d = pos ? N.formatDistance(N.distance(pos.lat, pos.lon, m.lat, m.lon)) : "";
      return h("div", { class: "place-row" },
        h("div", { class: "place-main", onclick: () => { map.setView([m.lat, m.lon], Math.max(map.getZoom(), 15)); closeSheet(); } },
          h("b", {}, m.emoji + " " + m.name),
          h("div", { class: "muted" }, m.type_name + (d ? " · " + d : ""))),
        h("div", { class: "place-actions" },
          h("button", { class: "icon-btn", title: "Вернуться", "aria-label": "Вернуться к метке", onclick: () => { session.targetId = m.id; closeSheet(); if (map) map.setView([m.lat, m.lon], Math.max(map.getZoom(), 14)); refreshPanel(); drawNavLine(); } }, "➤"),
          h("button", { class: "icon-btn", title: "Изменить", "aria-label": "Изменить", onclick: () => openForm(m) }, "✎"),
          h("button", { class: "icon-btn del", title: "Удалить", "aria-label": "Удалить", onclick: async () => {
            if (!(await Z.confirm("Удалить метку «" + m.name + "»?"))) return;
            try { await Z.post("/marks/delete", { id: m.id }); Z.haptic.tap(); await reloadMarks(); openList(); }
            catch (e) { Z.toast(e.message, true); }
          } }, "🗑")));
    }) : h("div", { class: "muted" }, "Меток пока нет. Долгое нажатие на карте или кнопка «Метка здесь».");
    openSheet(h("div", {}, h("h3", {}, "Метки"), rows));
  }

  async function reloadMarks() {
    const data = await Z.api("/marks");
    marksCache = data.marks || [];
    if (session.targetId != null && !marksCache.some((m) => m.id === session.targetId)) session.targetId = null;
    if (session.targetId == null) {
      const def = N.defaultNavTarget(marksCache);
      if (def) session.targetId = def.id;
    }
    redrawMarks(marksCache);
    refreshPanel();
    drawNavLine();
  }

  let windTimer = null;
  function scheduleWind() {
    clearTimeout(windTimer);
    windTimer = setTimeout(loadWind, 700);
  }
  async function loadWind() {
    const src = session.pos || (map && { lat: map.getCenter().lat, lon: map.getCenter().lng });
    if (!src) return;
    try {
      const w = await Z.api("/wind?lat=" + encodeURIComponent(src.lat) + "&lon=" + encodeURIComponent(src.lon));
      if (Z.state.tab !== "map") return;
      session.wind = w;
      drawWindArrow();
      refreshPanel();
    } catch (e) {
      if (Z.state.tab !== "map") return;
      session.wind = null;
      if (panelEl) refreshPanel();
    }
  }
  function relocate(fit) {
    showBanner(null);
    requestLocation(Z.tg).then((p) => {
      session.pos = p;
      if (p.heading != null) session.heading = p.heading;
      drawMe();
      if (fit && map) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15));
      scheduleWind();
      refreshPanel();
    }, (e) => showBanner(e));
  }

  function setBaseLayer(name) {
    if (!map || !layers[name]) return;
    if (layers[session.layer]) map.removeLayer(layers[session.layer]);
    session.layer = name;
    layers[name].addTo(map);
    const menu = document.getElementById("map-layer-menu");
    if (menu) menu.querySelectorAll("button[data-layer]").forEach((b) => b.classList.toggle("active", b.dataset.layer === name));
    refreshAttr();
  }
  function setBoundsVisible(on) {
    session.showBounds = !!on;
    if (map && boundsLayer) {
      if (session.showBounds) boundsLayer.addTo(map);
      else map.removeLayer(boundsLayer);
    }
    const cb = document.getElementById("map-bounds-on");
    if (cb) cb.checked = session.showBounds;
    refreshAttr();
  }
  function currentAttributions() {
    const items = [];
    const base = TILES[session.layer];
    if (base && base.attr) items.push(...base.attr);
    if (session.showBounds && session.hasOopt) items.push(OOPT_ATTR);
    return items;
  }
  function refreshAttr() {
    const panel = document.getElementById("map-attr-panel");
    if (!panel) return;
    const links = currentAttributions().map((a) => {
      if (a.href) return h("div", {}, h("a", { href: a.href, onclick: (ev) => Z.openLink(ev, a.href) }, a.text));
      return h("div", {}, a.text);
    });
    panel.replaceChildren(...[
      h("div", { class: "map-attr-title" }, "Источники карты"),
      ...links,
      session.showBounds ? h("div", { class: "muted map-attr-note" }, BOUNDARY_DISCLAIMER) : null,
    ].filter(Boolean));
  }
  function toggleAttr() {
    const panel = document.getElementById("map-attr-panel");
    if (!panel) return;
    const menu = document.getElementById("map-layer-menu");
    if (menu) menu.classList.add("hidden");
    const open = panel.classList.toggle("hidden") === false;
    if (open) refreshAttr();
    const btn = document.getElementById("map-attr-btn");
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function buildChrome(root) {
    const boundsToggle = h("label", { class: "map-bounds-toggle" },
      h("input", { type: "checkbox", id: "map-bounds-on", checked: session.showBounds, onchange: (ev) => setBoundsVisible(ev.target.checked) }),
      " Границы угодий");
    const layerMenu = h("div", { id: "map-layer-menu", class: "map-layer-menu hidden" },
      Object.entries(TILES).map(([k, t]) => h("button", { type: "button", "data-layer": k, class: session.layer === k ? "active" : "", onclick: () => { setBaseLayer(k); layerMenu.classList.add("hidden"); } }, t.label)),
      boundsToggle,
      h("div", { class: "muted map-bounds-note" }, BOUNDARY_DISCLAIMER));
    const fabs = h("div", { class: "map-fabs" },
      h("button", { class: "map-fab", title: "Подложка", "aria-label": "Слой карты", onclick: () => { const ap = document.getElementById("map-attr-panel"); if (ap) ap.classList.add("hidden"); layerMenu.classList.toggle("hidden"); } }, "🗺"),
      h("button", { class: "map-fab", title: "Моё место", "aria-label": "Центрировать на мне", onclick: () => relocate(true) }, "◎"),
      h("button", { class: "map-fab", title: "Метка здесь", "aria-label": "Поставить метку здесь", onclick: () => {
        if (session.pos) openForm(null, { lat: session.pos.lat, lng: session.pos.lon });
        else { Z.toast("Сначала определите своё место."); relocate(true); }
      } }, "📌"),
      h("button", { class: "map-fab", title: "Список меток", "aria-label": "Список меток", onclick: openList }, "☰"));
    bannerEl = h("div", { class: "map-banner hidden", role: "status" });
    panelEl = h("div", { class: "map-panel" }, panelContent());
    sheetEl = h("div", { class: "map-sheet hidden" });
    const attrBtn = h("button", { type: "button", id: "map-attr-btn", class: "map-attr-btn", title: "Источники карты", "aria-label": "Источники карты", "aria-expanded": "false", onclick: toggleAttr }, "ⓘ");
    const attrPanel = h("div", { id: "map-attr-panel", class: "map-attr-panel hidden" });
    root.append(fabs, layerMenu, bannerEl, panelEl, sheetEl, attrBtn, attrPanel);
  }

  function cleanup() {
    document.body.classList.remove("map-open");
    clearTimeout(windTimer);
    if (session.stopLoc) { session.stopLoc(); session.stopLoc = null; }
    if (session.stopHdg) { session.stopHdg(); session.stopHdg = null; }
    if (map) { map.remove(); map = null; }
    meMarker = meCircle = targetLine = markLayer = placeLayer = windLayer = boundsLayer = null;
    layers = {};
    panelEl = bannerEl = sheetEl = null;
  }

  Z.views.map = async function renderMap() {
    document.body.classList.add("map-open");
    Z.state.leaveTab = cleanup;
    Z.showLoader("Загружаю карту…");
    try { await loadLeaflet(); }
    catch (e) { document.body.classList.remove("map-open"); throw e; }
    if (Z.state.tab !== "map") return;
    const root = h("div", { id: "map-root" });
    const mapEl = h("div", { id: "map", "aria-label": "Карта" });
    root.append(mapEl);
    Z.render(root);
    buildChrome(root);

    const [marksData, placesData] = await Promise.all([Z.api("/marks"), Z.api("/places").catch(() => ({ places: [] }))]);
    if (Z.state.tab !== "map") return;
    marksCache = marksData.marks || [];
    placesCache = (placesData && placesData.places) || [];
    if (session.targetId == null) {
      const def = N.defaultNavTarget(marksCache);
      if (def) session.targetId = def.id;
    }

    const start = session.pos || (placesCache[0] ? { lat: placesCache[0].lat, lon: placesCache[0].lon, zoom: 12 } :
      (marksCache[0] ? { lat: marksCache[0].lat, lon: marksCache[0].lon, zoom: 13 } : HOME));
    map = L.map(mapEl, { zoomControl: true, attributionControl: false }).setView([start.lat, start.lon], start.zoom || 13);
    layers = {};
    for (const [k, t] of Object.entries(TILES)) {
      layers[k] = L.tileLayer(t.url, { attribution: "", maxZoom: t.maxZoom, updateWhenIdle: true });
    }
    setBaseLayer(session.layer);
    markLayer = L.layerGroup().addTo(map);
    placeLayer = L.layerGroup().addTo(map);
    windLayer = L.layerGroup().addTo(map);
    redrawMarks(marksCache);
    redrawPlaces(placesCache);
    refreshPanel();

    const pts = placesCache.concat(marksCache).map((p) => [p.lat, p.lon]);
    if (!session.pos && pts.length > 1) try { map.fitBounds(pts, { padding: [40, 80], maxZoom: 13 }); } catch (e) { /* пустой охват */ }

    bindLongPress(map, (latlng) => openForm(null, latlng));
    map.on("moveend", scheduleWind);
    loadWind();

    boundsLayer = await loadBoundaries(L);
    if (Z.state.tab !== "map" || !map) return;
    if (boundsLayer && boundsLayer.getLayers && boundsLayer.getLayers().length && session.showBounds) boundsLayer.addTo(map);
    refreshAttr();

    session.stopLoc = startLocation((p) => {
      session.pos = p;
      if (p.heading != null) session.heading = p.heading;
      drawMe();
      scheduleWind();
      refreshPanel();
      showBanner(null);
    }, (e) => showBanner(e));
    session.stopHdg = startHeading((deg) => { session.heading = deg; refreshPanel(); });
    map.whenReady(() => setTimeout(() => { if (map) map.invalidateSize(); }, 80));
  };
})();
