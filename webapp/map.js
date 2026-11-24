/* Вкладка «Карта»: охотничий навигатор. Leaflet подгружается только при открытии вкладки (без CDN). */
(function () {
  "use strict";
  const N = ZL.nav;
  const { h, s } = Z;
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
  const TYPE_LABEL = { public: "Общедоступные угодья", assigned: "Закреплённые угодья", protection: "Зона охраны", oopt: "ООПТ", excluded: "Охота запрещена" };
  const BOUNDARY_STYLE = {
    public: { color: "#2e7d32", weight: 2, fillOpacity: 0.14 },
    assigned: { color: "#0d47a1", weight: 2.5, fillColor: "#1976d2", fillOpacity: 0.16, className: "bound-assigned" },
    protection: { color: "#e65100", weight: 2, fillOpacity: 0.16 },
    oopt: { color: "#6a1b9a", weight: 2, fillOpacity: 0.14 },
    excluded: { color: "#b71c1c", weight: 2, fillColor: "#e53935", fillOpacity: 0.22, dashArray: "5 4", className: "bound-excluded" },
  };
  function boundaryKind(t) {
    const s = String(t || "").toLowerCase();
    if (/запрещ|excluded|no.?hunt/.test(s)) return "excluded";
    if (/общедоступ|public/.test(s)) return "public";
    if (/закрепл|assigned/.test(s)) return "assigned";
    if (/охран|protection/.test(s)) return "protection";
    if (/оопт|oopt|заповед|заказник/.test(s)) return "oopt";
    return "assigned";
  }
  function ensureExcludedHatch(leafMap) {
    if (!leafMap || !leafMap.getPanes) return;
    const pane = leafMap.getPanes().overlayPane;
    const svg = pane && pane.querySelector("svg");
    if (!svg || svg.querySelector("#zorka-hatch-excluded")) return;
    const ns = "http://www.w3.org/2000/svg";
    let defs = svg.querySelector("defs");
    if (!defs) { defs = document.createElementNS(ns, "defs"); svg.insertBefore(defs, svg.firstChild); }
    const pat = document.createElementNS(ns, "pattern");
    pat.setAttribute("id", "zorka-hatch-excluded");
    pat.setAttribute("patternUnits", "userSpaceOnUse");
    pat.setAttribute("width", "8");
    pat.setAttribute("height", "8");
    pat.setAttribute("patternTransform", "rotate(45)");
    const bg = document.createElementNS(ns, "rect");
    bg.setAttribute("width", "8"); bg.setAttribute("height", "8"); bg.setAttribute("fill", "rgba(198,40,40,0.12)");
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", "0"); ln.setAttribute("y1", "0"); ln.setAttribute("x2", "0"); ln.setAttribute("y2", "8");
    ln.setAttribute("stroke", "#c62828"); ln.setAttribute("stroke-width", "3");
    pat.append(bg, ln);
    defs.appendChild(pat);
  }

  let leafletPromise = null, map = null, layers = {}, meMarker = null, meCircle = null, targetLine = null;
  let markLayer = null, placeLayer = null, windLayer = null, boundsLayer = null;
  let session = { layer: "esri", targetId: null, heading: null, pos: null, wind: null, showBounds: true, hasOopt: false, hasExcluded: false };

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
  const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(geoFail({ code: "geo_timeout" })), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(geoFail(e)); });
  });

  // Один экземпляр на всё открытие Mini App: init LocationManager один раз, один poll/watch,
  // без повторного запроса разрешения при каждом заходе на вкладку и без запасного browser-prompt.
  const locRuntime = {
    initPromise: null, pollTimer: null, watchId: null, starting: false,
    listeners: [], lastPos: null, remembered: null, rememberedLoaded: false,
    browserPermission: null, asked: false,
  };
  function lmUsable(tg) {
    const lm = tg && tg.LocationManager;
    if (!lm) return false;
    if (tg.isVersionAtLeast && !tg.isVersionAtLeast("8.0")) return false;
    return true;
  }
  function lmSnapshot(tg) {
    const lm = tg && tg.LocationManager;
    const versionOk = !tg || !tg.isVersionAtLeast || tg.isVersionAtLeast("8.0");
    return {
      hasManager: !!(lm && versionOk),
      versionOk,
      isLocationAvailable: lm ? lm.isLocationAvailable : null,
      isInited: !!(lm && lm.isInited),
      isAccessRequested: !!(lm && lm.isAccessRequested),
      isAccessGranted: !!(lm && lm.isAccessGranted),
      remembered: locRuntime.remembered,
      browserPermission: locRuntime.browserPermission,
      asked: locRuntime.asked,
    };
  }
  function ensureLmInit(tg) {
    const lm = tg && tg.LocationManager;
    if (!lmUsable(tg) || !lm) return Promise.resolve(null);
    if (lm.isInited) return Promise.resolve(lm);
    if (locRuntime.initPromise) return locRuntime.initPromise;
    locRuntime.initPromise = new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(lm); };
      try {
        const ret = lm.init((res) => { finish(res); });
        if (ret && typeof ret.then === "function") ret.then(() => finish(), () => finish());
      } catch (e) { finish(); }
      setTimeout(finish, 5000);
    });
    return locRuntime.initPromise;
  }
  async function loadRemembered() {
    if (locRuntime.rememberedLoaded) return locRuntime.remembered;
    try {
      const r = await Z.api("/geo");
      locRuntime.remembered = (r && (r.status === "granted" || r.status === "denied")) ? r.status : null;
    } catch (e) { locRuntime.remembered = null; }
    locRuntime.rememberedLoaded = true;
    return locRuntime.remembered;
  }
  async function saveRemembered(status) {
    locRuntime.remembered = status;
    locRuntime.rememberedLoaded = true;
    try { await Z.post("/geo", { status }); } catch (e) { /* хранилище недоступно — флаг всё равно в сессии */ }
  }
  async function queryBrowserPermission() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const s = await navigator.permissions.query({ name: "geolocation" });
        locRuntime.browserPermission = s && s.state ? s.state : null;
        return locRuntime.browserPermission;
      }
    } catch (e) { /* iOS и часть WebView не умеют query */ }
    return locRuntime.browserPermission;
  }
  function telegramGetLocation(tg) {
    return new Promise((resolve, reject) => {
      const lm = tg && tg.LocationManager;
      if (!lm) return reject(geoFail({ code: "geo_unavailable" }));
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
      try {
        const ret = lm.getLocation(finish);
        if (ret && typeof ret.then === "function") ret.then(finish, (e) => reject(geoFail(e)));
      } catch (e) { reject(geoFail(e)); }
    });
  }
  function startOrReuseBrowserWatch() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation || !navigator.geolocation.watchPosition) {
        return reject(geoFail({ code: "geo_unsupported" }));
      }
      if (locRuntime.watchId != null) {
        if (locRuntime.lastPos && locRuntime.lastPos.source === "browser") return resolve(locRuntime.lastPos);
        locRuntime._browserWait = { resolve, reject };
        return;
      }
      locRuntime._browserWait = { resolve, reject };
      locRuntime.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const p = fromBrowserPos(pos, "browser");
          const wait = locRuntime._browserWait;
          locRuntime._browserWait = null;
          if (wait) wait.resolve(p);
          else emitLocPos(p);
        },
        (err) => {
          const fail = geoFail(err);
          if (N.describeGeoError(fail).code === "geo_denied") saveRemembered("denied");
          const wait = locRuntime._browserWait;
          locRuntime._browserWait = null;
          if (wait) wait.reject(fail);
          else emitLocErr(fail);
        },
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
    });
  }
  async function obtainLocation(opts) {
    const poll = !!(opts && opts.poll);
    const tg = Z.tg;
    await loadRemembered();
    if (lmUsable(tg)) await ensureLmInit(tg);
    const snap0 = lmSnapshot(tg);
    if (!(snap0.hasManager && snap0.versionOk && snap0.isLocationAvailable !== false)) {
      await queryBrowserPermission();
    }
    let action = N.geoDecision(lmSnapshot(tg));
    if (poll && action === "request") action = "settings";
    if (action === "request") locRuntime.asked = true;
    if (action === "settings") throw geoFail({ code: "geo_denied", settings: true });
    if (action === "get" || action === "request") {
      const p = await withTimeout(telegramGetLocation(tg), 8000);
      await saveRemembered("granted");
      return p;
    }
    if (locRuntime.browserPermission === "denied" || locRuntime.remembered === "denied") {
      throw geoFail({ code: "geo_denied", settings: true });
    }
    const p = await startOrReuseBrowserWatch();
    await saveRemembered("granted");
    return p;
  }
  function emitLocPos(p) {
    locRuntime.lastPos = p;
    locRuntime.listeners.forEach((l) => { try { l.onPos(p); } catch (e) { /* */ } });
  }
  function emitLocErr(e) {
    const err = geoFail(e);
    locRuntime.listeners.forEach((l) => { try { l.onErr(err); } catch (x) { /* */ } });
  }
  async function locTick(opts) {
    try {
      const p = await obtainLocation(opts);
      emitLocPos(p);
    } catch (e) {
      const info = N.describeGeoError(e);
      if (info.code === "geo_denied") { await saveRemembered("denied"); emitLocErr(e); return; }
      if (locRuntime.lastPos && info.code === "geo_timeout") return;
      emitLocErr(e);
    }
  }
  function ensureLocLoop() {
    if (locRuntime.pollTimer || locRuntime.watchId != null || locRuntime.starting) {
      return;
    }
    locRuntime.starting = true;
    locTick({ poll: false }).finally(() => {
      locRuntime.starting = false;
      if (locRuntime.watchId != null) return;          // браузер сам шлёт обновления
      if (locRuntime.pollTimer) return;
      locRuntime.pollTimer = setInterval(() => {
        const action = N.geoDecision(lmSnapshot(Z.tg));
        if (action !== "get") return;                  // повторно не спрашиваем разрешение
        locTick({ poll: true });
      }, 8000);
    });
  }
  /** Слушатель геопозиции на всё время сессии. Снятие слушателя не останавливает общий poll/watch и не делает init заново. */
  function startLocation(onPos, onErr) {
    const sub = { onPos, onErr };
    locRuntime.listeners.push(sub);
    if (locRuntime.lastPos) try { onPos(locRuntime.lastPos); } catch (e) { /* */ }
    ensureLocLoop();
    return () => { locRuntime.listeners = locRuntime.listeners.filter((x) => x !== sub); };
  }
  function requestLocation() {
    return obtainLocation({ poll: false });
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
    const apply = (e) => { try { const deg = N.headingFromOrientation(e); if (deg != null && !stopped) onHeading(deg); } catch (err) { /* нет датчика */ } };
    const stops = [];
    if (tg && tg.DeviceOrientation && (!tg.isVersionAtLeast || tg.isVersionAtLeast("8.0"))) {
      const handler = (e) => apply(e);
      try { if (tg.onEvent) tg.onEvent("deviceOrientationChanged", handler); } catch (e) { /* */ }
      try {
        const ret = tg.DeviceOrientation.start({ refresh_rate: 20, need_absolute: true });
        if (ret && typeof ret.then === "function") ret.catch(function () { /* нет датчика или отказано */ });
      } catch (e) { /* старый клиент или нет сенсора */ }
      stops.push(() => { try { tg.DeviceOrientation.stop(); } catch (e) { /* */ } try { if (tg.offEvent) tg.offEvent("deviceOrientationChanged", handler); } catch (e) { /* */ } });
    } else if (typeof DeviceOrientationEvent !== "undefined" && !DeviceOrientationEvent.requestPermission) {
      // На iOS разрешение можно спрашивать только по жесту — здесь не вызываем, чтобы не спровоцировать странное поведение WebView.
      const handler = (e) => apply(e);
      try {
        window.addEventListener("deviceorientationabsolute", handler, true);
        window.addEventListener("deviceorientation", handler, true);
      } catch (e) { /* */ }
      stops.push(() => {
        try { window.removeEventListener("deviceorientationabsolute", handler, true); } catch (e) { /* */ }
        try { window.removeEventListener("deviceorientation", handler, true); } catch (e) { /* */ }
      });
    }
    return () => { stopped = true; stops.forEach((fn) => { try { fn(); } catch (e) { /* */ } }); };
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
    session.hasExcluded = false;
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
              if (kind === "excluded") session.hasExcluded = true;
              const lines = [
                TYPE_LABEL[kind] || null,
                p.user ? ("охотпользователь: " + p.user) : null,
                p.address || null,
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


  function btnIco(...children) {
    return s("svg", { class: "btn-ico", viewBox: "0 0 24 24", width: "18", height: "18", "aria-hidden": "true", focusable: "false" }, ...children);
  }
  // Стрелка «отправить», как в Telegram — не путать с кнопкой «Вернуться».
  function shareIcon() {
    // Силуэт бумажного самолётика остриём вверх-вправо, как «отправить» в Telegram.
    return btnIco(s("path", { fill: "currentColor", d: "M20.6 3.2 14.1 20.6 10.7 12.9 3.3 9.5z" }));
  }
  // Навигационный указатель к метке.
  function navIcon() {
    return btnIco(s("path", { fill: "currentColor", d: "M12 3 5.1 20.05l.8.35L12 17.4l6.1 3 .8-.35z" }));
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
        h("button", { class: "btn", type: "button", title: "Вернуться", "aria-label": "Вернуться к метке", onclick: () => { session.targetId = m.id; map.closePopup(); refreshPanel(); drawNavLine(); } }, navIcon(), "Вернуться"),
        h("button", { class: "btn secondary", type: "button", onclick: () => { map.closePopup(); openForm(m); } }, "Изменить"),
        h("button", { class: "btn secondary", type: "button", title: "Поделиться", "aria-label": "Поделиться", onclick: () => shareMark(m) }, shareIcon(), "Поделиться"),
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
  function headingDeg() {
    if (session.heading != null) return session.heading;
    if (session.pos && session.pos.heading != null) return session.pos.heading;
    return null;
  }
  // Каркас панели собирается один раз. Курс (до 20 Гц), геопозиция и ветер меняют только текстовые узлы и поворот стрелки —
  // нативный <select> из-за пересборки option сразу закрывался на телефоне.
  function buildPanel() {
    const arrow = h("div", { class: "map-compass hidden", id: "map-compass" },
      h("div", { class: "map-compass-arrow", id: "map-compass-arrow" }, "▲"),
      h("div", { class: "map-compass-label", id: "map-compass-label" }, "С"));
    const btn = h("button", { type: "button", id: "map-target-btn", class: "map-target",
      "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": "Вернуться к метке" }, "Выберите метку");
    btn.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); openTargetPicker(); });
    const info = h("div", { id: "map-nav-info" },
      h("b", { id: "map-nav-dist", class: "hidden" }),
      h("div", { id: "map-nav-az", class: "muted hidden" }),
      h("div", { id: "map-nav-hint", class: "muted" }));
    const wind = h("div", { class: "map-wind-text", id: "map-wind" },
      h("div", { id: "map-wind-line" }, "Запрашиваю ветер…"),
      h("div", { id: "map-wind-approach", class: "hidden" }));
    return h("div", {},
      h("div", { class: "map-nav-row" },
        arrow,
        h("div", { class: "map-nav-main" },
          h("div", { class: "map-nav-label" }, "Вернуться к…"),
          btn, info)),
      wind);
  }
  function refreshPanel() {
    if (!panelEl) return;
    if (!panelEl.querySelector("#map-target-btn")) panelEl.replaceChildren(buildPanel());
    syncTargetButton();
    updateNavLive();
    updateWindLive();
  }
  function syncTargetButton() {
    const btn = document.getElementById("map-target-btn");
    if (!btn) return;
    const target = currentTarget();
    const opts = N.targetOptionLabels(marksCache);
    const hit = target && opts.find((o) => o.id === target.id);
    const next = hit ? hit.label : (opts.length ? "Выберите метку" : "Нет меток");
    if (btn.textContent !== next) btn.textContent = next;
  }
  function updateNavLive() {
    const info = document.getElementById("map-nav-info");
    const distEl = document.getElementById("map-nav-dist");
    const azEl = document.getElementById("map-nav-az");
    const hint = document.getElementById("map-nav-hint");
    const compass = document.getElementById("map-compass");
    const arrow = document.getElementById("map-compass-arrow");
    const compassLabel = document.getElementById("map-compass-label");
    if (!info || !distEl || !azEl) return;
    const target = currentTarget();
    const pos = session.pos;
    if (pos && target) {
      const dist = N.distance(pos.lat, pos.lon, target.lat, target.lon);
      const az = N.bearing(pos.lat, pos.lon, target.lat, target.lon);
      const hd = headingDeg();
      const rel = N.relativeBearing(az, hd);
      const rot = rel != null ? rel : az;
      const distText = N.formatDistance(dist);
      const azText = N.formatAzimuth(az) + (hd != null ? " · относительно курса " + Math.round(rel) + "°" : "");
      if (hint) { hint.classList.add("hidden"); if (hint.textContent) hint.textContent = ""; }
      distEl.classList.remove("hidden");
      azEl.classList.remove("hidden");
      if (distEl.textContent !== distText) distEl.textContent = distText;
      if (azEl.textContent !== azText) azEl.textContent = azText;
      if (compass) {
        compass.classList.remove("hidden");
        compass.title = hd != null ? "Стрелка относительно вашего курса" : "Азимут относительно севера";
      }
      if (arrow) arrow.style.transform = "rotate(" + rot + "deg)";
      const cl = hd != null ? "курс" : "С";
      if (compassLabel && compassLabel.textContent !== cl) compassLabel.textContent = cl;
    } else {
      const fallback = pos ? "Выберите метку, чтобы увидеть расстояние и направление." : "Включите геопозицию, чтобы вести к метке.";
      distEl.classList.add("hidden");
      azEl.classList.add("hidden");
      if (distEl.textContent) distEl.textContent = "";
      if (azEl.textContent) azEl.textContent = "";
      if (hint) { hint.classList.remove("hidden"); if (hint.textContent !== fallback) hint.textContent = fallback; }
      if (compass) compass.classList.add("hidden");
    }
  }
  function updateWindLive() {
    const line = document.getElementById("map-wind-line");
    const ap = document.getElementById("map-wind-approach");
    if (!line) return;
    const w = session.wind;
    const target = currentTarget();
    let text = "Запрашиваю ветер…";
    let approach = "";
    if (w) {
      const speed = w.wind_speed != null ? Number(w.wind_speed).toFixed(1) + " м/с" : "—";
      const from = w.wind_direction_name ? "ветер " + w.wind_direction_name : "";
      text = "💨 " + speed + (from ? ", " + from : "") + (w.scent_text ? ". " + w.scent_text : "");
      if (target && w.approach_text) approach = w.approach_text;
    }
    if (line.textContent !== text) line.textContent = text;
    if (ap) {
      if (ap.textContent !== approach) ap.textContent = approach;
      ap.classList.toggle("hidden", !approach);
    }
  }
  function pickTarget(id) {
    session.targetId = id == null || id === "" ? null : Number(id);
    closeSheet();
    syncTargetButton();
    updateNavLive();
    updateWindLive();
    drawNavLine();
  }
  function openTargetPicker() {
    const btn = document.getElementById("map-target-btn");
    const opts = N.targetOptionLabels(marksCache);
    if (!opts.length) { Z.toast("Сначала поставьте метку на карте."); return; }
    if (btn) btn.setAttribute("aria-expanded", "true");
    const pos = session.pos;
    const rows = opts.map((o) => {
      const m = marksCache.find((x) => x.id === o.id);
      const d = (pos && m) ? N.formatDistance(N.distance(pos.lat, pos.lon, m.lat, m.lon)) : "";
      const selected = session.targetId === o.id;
      return h("button", { type: "button", class: "map-pick-row" + (selected ? " active" : ""), "aria-current": selected ? "true" : null, onclick: () => pickTarget(o.id) },
        h("span", {}, o.label),
        d ? h("span", { class: "muted" }, d) : null);
    });
    openSheet(h("div", {}, h("h3", {}, "Вернуться к…"), rows));
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
  function closeSheet() {
    if (sheetEl) { sheetEl.classList.add("hidden"); sheetEl.replaceChildren(); }
    const btn = document.getElementById("map-target-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

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
          h("button", { class: "icon-btn", title: "Вернуться", "aria-label": "Вернуться к метке", onclick: () => { session.targetId = m.id; closeSheet(); if (map) map.setView([m.lat, m.lon], Math.max(map.getZoom(), 14)); refreshPanel(); drawNavLine(); } }, navIcon()),
          h("button", { class: "icon-btn", title: "Изменить", "aria-label": "Изменить", onclick: () => openForm(m) }, "✎"),
          h("button", { class: "icon-btn", title: "Поделиться", "aria-label": "Поделиться", onclick: () => shareMark(m) }, shareIcon()),
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
      updateWindLive();
    } catch (e) {
      if (Z.state.tab !== "map") return;
      session.wind = null;
      updateWindLive();
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
      updateNavLive();
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
  let boundsLoading = null;
  function ensureBoundaries() {
    if (boundsLayer) {
      if (map && session.showBounds && !map.hasLayer(boundsLayer)) boundsLayer.addTo(map);
      refreshAttr();
      return Promise.resolve(boundsLayer);
    }
    if (boundsLoading) return boundsLoading;
    boundsLoading = loadBoundaries(L).then((group) => {
      boundsLoading = null;
      if (Z.state.tab !== "map" || !map) return group;
      boundsLayer = group;
      if (session.showBounds && group && group.getLayers && group.getLayers().length) group.addTo(map);
      try { ensureExcludedHatch(map); } catch (e) { /* */ }
      refreshAttr();
      if (map) try { map.invalidateSize(); } catch (e) { /* */ }
      return group;
    }).catch((e) => { boundsLoading = null; refreshAttr(); return null; });
    return boundsLoading;
  }
  function setBoundsVisible(on) {
    session.showBounds = !!on;
    if (session.showBounds) ensureBoundaries();
    else if (map && boundsLayer) map.removeLayer(boundsLayer);
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
      h("div", { class: "map-legend", "aria-label": "Условные знаки границ" },
        h("div", { class: "map-legend-row" }, h("span", { class: "map-swatch map-swatch-public", "aria-hidden": "true" }), " Общедоступные угодья"),
        h("div", { class: "map-legend-row" }, h("span", { class: "map-swatch map-swatch-assigned", "aria-hidden": "true" }), " Закреплённые угодья"),
        h("div", { class: "map-legend-row" }, h("span", { class: "map-swatch map-swatch-oopt", "aria-hidden": "true" }), " ООПТ"),
        h("div", { class: "map-legend-row" }, h("span", { class: "map-swatch map-swatch-excluded", "aria-hidden": "true" }), " Охота запрещена")),
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
    panelEl = h("div", { class: "map-panel" }, buildPanel());
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
    dismissSharedPreview(false);
    if (map) { map.remove(); map = null; }
    meMarker = meCircle = targetLine = markLayer = placeLayer = windLayer = boundsLayer = null;
    boundsLoading = null;
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
    map = L.map(mapEl, { zoomControl: true, attributionControl: false, tap: false, bounceAtZoomLimits: false }).setView([start.lat, start.lon], start.zoom || 13);
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

    if (session.showBounds) ensureBoundaries();   // GeoJSON только на вкладке «Карта» и если слой включён
    else refreshAttr();

    session.stopLoc = startLocation((p) => {
      session.pos = p;
      if (p.heading != null) session.heading = p.heading;
      drawMe();
      scheduleWind();
      updateNavLive();
      showBanner(null);
    }, (e) => showBanner(e));
    session.stopHdg = startHeading((deg) => { session.heading = deg; updateNavLive(); });
    map.whenReady(() => setTimeout(() => {
      if (map) map.invalidateSize();
      if (Z.state.sharedMark) showSharedPreview(Z.state.sharedMark);
    }, 80));
  };

  let shareMarker = null, sharePreviewEl = null;
  function shareMark(m) {
    const enc = N.encodeShareMark(m);
    if (enc.error) { Z.toast(enc.message, true); return; }
    const url = N.telegramShareUrl(enc);
    const tg = Z.tg;
    try {
      if (tg && typeof tg.openTelegramLink === "function") tg.openTelegramLink(url);
      else if (tg && typeof tg.openLink === "function") tg.openLink(url);
      else window.open(url, "_blank");
      Z.haptic.tap();
    } catch (e) { Z.toast("Не удалось открыть окно отправки.", true); }
  }
  function dismissSharedPreview(clearState) {
    if (shareMarker && map) { try { map.removeLayer(shareMarker); } catch (e) { /* карта уже снята */ } }
    shareMarker = null;
    if (sharePreviewEl && sharePreviewEl.parentNode) sharePreviewEl.parentNode.removeChild(sharePreviewEl);
    sharePreviewEl = null;
    if (panelEl) panelEl.classList.remove("hidden");
    if (clearState !== false) Z.state.sharedMark = null;
  }
  function showSharedPreview(rec) {
    if (!map || !rec) return;
    closeSheet();
    dismissSharedPreview(false);
    const pub = N.markPublic(Object.assign({ id: 0, key: "shared" }, rec));
    map.setView([rec.lat, rec.lon], Math.max(map.getZoom() || 0, 15));
    shareMarker = L.marker([rec.lat, rec.lon], { icon: emojiIcon(pub.emoji), zIndexOffset: 1200, title: pub.name }).addTo(map);
    if (panelEl) panelEl.classList.add("hidden");
    const already = N.findDuplicateMark(marksCache, rec);
    const save = async () => {
      if (already) { Z.toast("Эта метка уже есть в вашем списке."); dismissSharedPreview(); return; }
      try {
        await Z.post("/marks", { type: rec.type, name: rec.name, note: rec.note, lat: rec.lat, lon: rec.lon });
        Z.haptic.ok();
        dismissSharedPreview();
        await reloadMarks();
        Z.toast("Метка сохранена");
      } catch (e) { Z.toast(e.message, true); }
    };
    sharePreviewEl = h("div", { class: "map-share-preview", role: "dialog", "aria-label": "Вам поделились меткой" },
      h("h3", {}, "Вам поделились меткой"),
      h("div", { class: "share-preview-title" }, pub.emoji + " " + pub.name),
      h("div", { class: "muted" }, pub.type_name + " · " + rec.lat.toFixed(6) + ", " + rec.lon.toFixed(6)),
      rec.note ? h("div", { class: "rec-note" }, rec.note) : null,
      already ? h("div", { class: "muted" }, "Эта метка уже есть в вашем списке.") : null,
      h("div", { class: "row share-preview-actions" },
        already
          ? h("button", { class: "btn", onclick: () => dismissSharedPreview() }, "Понятно")
          : h("button", { class: "btn", onclick: save }, "Сохранить в мои метки"),
        h("button", { class: "btn secondary", onclick: () => dismissSharedPreview() }, "Отмена")));
    const root = document.getElementById("map-root");
    if (root) root.append(sharePreviewEl);
  }
})();
