/* «Локальный API» Mini App: те же понятия, что были у серверного API (прогноз, сезоны, угодья, чек-лист, журнал), но всё
   считается на устройстве: данные — в CloudStorage Telegram (storage.js), погода — напрямую из Open-Meteo.
   handle(path, method, body) возвращает объект либо бросает ApiError(status, code, message). */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const need = (n) => (node ? require("./" + n + ".js") : root.ZL[n]);
  const api = factory(need("dates"), need("weather"), need("forecast"), need("seasons"), need("checklist"), need("stats"),
    need("storage"), need("data"), need("nav"));
  if (node) module.exports = api; else { root.ZL = root.ZL || {}; root.ZL.api = api; }
})(typeof self !== "undefined" ? self : this, function (D, W, F, S, CL, ST, storage, dataMod, N) {
  "use strict";
  const { ApiError, fail, cleanText, validCoord } = dataMod;
  const FORECAST_TTL_MS = 10 * 60 * 1000;
  const NO_PLACE = ["no_place", "Сначала укажите место: найдите город или добавьте угодье."];
  const pairs = (rows) => rows.map(([name, count]) => ({ name, count }));

  /** deps: { backend, fetch, loadJSON(имя) → Promise, now() } */
  async function create(deps) {
    const [tpl, seasonsData, regionList] = await Promise.all(
      ["checklist.json", "seasons.json", "regions.json"].map((n) => deps.loadJSON(n)));
    const now = deps.now || (() => new Date());
    const store = storage.createStore(deps.backend);
    const regions = regionList.map((r) => ({ code: r.code, name: r.name, verified: S.isVerified(seasonsData, r.code) }));
    const data = dataMod.createData({ store, tpl, regions, now });
    const forecastCache = new Map();

    async function weatherCall(promise) {
      try { return await promise; }
      catch (e) {
        if (e instanceof W.WeatherError) fail(502, "weather_unavailable", "Сервис погоды недоступен, попробуйте чуть позже.");
        throw e;
      }
    }
    async function rawForecast(lat, lon) {
      const key = `${lat},${lon}`;
      const hit = forecastCache.get(key);
      if (hit && now().getTime() - hit.t < FORECAST_TTL_MS) return hit.raw;
      const raw = await weatherCall(W.fetchForecast(deps.fetch, lat, lon).then((r) => { W.parseForecast(r); return r; }));   // битый ответ не кэшируем
      forecastCache.set(key, { t: now().getTime(), raw });
      return raw;
    }


    async function windAt(query) {
      const lat = N.validCoord(query.get("lat"), -90, 90), lon = N.validCoord(query.get("lon"), -180, 180);
      if (lat === null || lon === null) fail(400, "bad_coordinates", "Некорректные координаты.");
      const raw = await rawForecast(N.roundCoord(lat, 3), N.roundCoord(lon, 3));   // кэш с шагом ~100 м
      const w = N.currentWind(raw, now());
      if (!w) fail(502, "weather_unavailable", "Сервис погоды недоступен, попробуйте чуть позже.");
      const advice = N.approachAdvice(w.direction, w.speed);
      return {
        lat, lon, time: w.time, wind_direction: w.direction, wind_speed: w.speed, wind_gusts: w.gusts,
        wind_direction_name: N.compassShort(w.direction), scent_drift: w.drift,
        scent_drift_name: N.compassShort(w.drift), scent_text: advice ? advice.scentText : null,
        approach_text: advice && !advice.calm ? advice.text : (advice ? advice.text : null), calm: !!(advice && advice.calm),
      };
    }

    // ---------- точки для прогноза: угодья (по умолчанию первым), затем «текущее место» ----------
    async function spots() {
      const [places, meta] = await Promise.all([data.listPlaces(), data.getMeta()]);
      const out = places.map((p) => ({ key: p.key, title: (p.is_default ? "⭐ " : "") + p.name, lat: p.lat, lon: p.lon }));
      if (meta.loc) out.push({ key: "cur", title: "📍 " + (meta.loc.name || "Моё место"), lat: meta.loc.lat, lon: meta.loc.lon });
      return out;
    }
    const pickSpot = (list, key) => (!list.length ? null : key ? list.find((s) => s.key === key) || null : list[0]);

    async function me() {
      const [meta, places] = await Promise.all([data.getMeta(), data.listPlaces()]);
      const region = regions.find((r) => r.code === meta.region) || null;
      return {
        region, timezone: meta.tz || "auto", hunt_type: meta.hunt, places,
        location: meta.loc ? { lat: meta.loc.lat, lon: meta.loc.lon, name: meta.loc.name } : null,
        has_place: !!(places.length || meta.loc), storage: store.kind,
      };
    }

    async function forecast(query) {
      const spot = pickSpot(await spots(), query.get("place_id") || null);
      if (!spot) fail(409, ...NO_PLACE);
      const raw = await rawForecast(spot.lat, spot.lon);
      return F.forecastPayload(raw, { key: spot.key, title: spot.title, lat: spot.lat, lon: spot.lon }, now());
    }

    async function checklistHints() {
      const spot = pickSpot(await spots(), null);
      if (!spot) return { hints: [] };
      try {
        const raw = await rawForecast(spot.lat, spot.lon);
        const days = W.parseForecast(raw);
        const today = W.localToday(raw, now());
        const day = days[D.addDays(today, 1)] || days[today];
        if (!day) return { hints: [] };
        const c = F.conditionsFor(day);
        return { hints: CL.weatherHints(c.temperature, c.precipitation, c.wind_speed, c.wind_gusts) };
      } catch (e) { return { hints: [] }; }       // нет сети — подсказок нет, чек-лист работает
    }

    async function setLocation(body) {
      let lat, lon, name;
      if ("lat" in body || "lon" in body) {
        lat = validCoord(body.lat, -90, 90); lon = validCoord(body.lon, -180, 180);
        if (lat === null || lon === null) fail(400, "bad_coordinates", "Некорректные координаты.");
        name = [...String(body.name || "по координатам")].slice(0, 80).join("");
      } else {
        const city = String(body.city == null ? "" : body.city).replace(/\s+/g, " ").trim();
        if (!city || city.length > data.LIMITS.CITY_MAX) fail(400, "bad_city", "Введите название города.");
        const place = await weatherCall(W.geocodeCity(deps.fetch, city));
        if (!place) fail(404, "city_not_found", "Не нашёл такой город. Проверьте написание.");
        lat = place.latitude; lon = place.longitude; name = place.title;
      }
      await data.patchMeta({ loc: { lat, lon, name } });
      return { ok: true, location: { lat, lon, name } };
    }

    async function addPlace(body) {
      const L = data.LIMITS;
      if ((await data.listPlaces()).length >= L.MAX_PLACES) fail(400, "too_many", `Можно сохранить не больше ${L.MAX_PLACES} угодий.`);
      let name = cleanText(body.name, L.PLACE_NAME_MAX), lat, lon;
      if ("lat" in body || "lon" in body) {
        lat = validCoord(body.lat, -90, 90); lon = validCoord(body.lon, -180, 180);
        if (lat === null || lon === null) fail(400, "bad_coordinates", "Некорректные координаты (широта −90…90, долгота −180…180).");
        name = name || `Угодье ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
      } else {
        const city = cleanText(body.city, L.CITY_MAX + 1);
        if (!city || city.length > L.CITY_MAX) fail(400, "bad_city", "Введите название города или координаты.");
        const found = await weatherCall(W.geocodeCity(deps.fetch, city));
        if (!found) fail(404, "city_not_found", "Не нашёл такой город. Проверьте написание.");
        lat = found.latitude; lon = found.longitude; name = name || [...found.name].slice(0, L.PLACE_NAME_MAX).join("");
      }
      return { ok: true, place: await data.addPlace(name, lat, lon) };
    }

    async function statsPayload(records) {
      const s = ST.computeStats((records || await data.allRecords()).map((r) => ({ date: r.date, place: r.place, species: r.species })));
      return { records: s.records, trips: s.trips, by_species: pairs(s.by_species), by_place: pairs(s.by_place),
        by_month: s.by_month.map(([month, count]) => ({ month, count })), best_months: pairs(s.best_months) };
    }

    async function settings() {
      const meta = await data.getMeta();
      const region = regions.find((r) => r.code === meta.region) || null;
      return { region, timezone: meta.tz || "auto", timezones: [data.AUTO_TZ, ...data.TIMEZONES] };
    }

    const bool = (v) => v === true;
    async function handle(path, method, body) {
      const url = new URL(path, "http://local");
      const route = url.pathname.replace(/^\/api(?=\/)/, "");
      body = body || {};
      const key = `${method || "GET"} ${route}`;
      switch (key) {
        case "GET /me": return me();
        case "GET /forecast": return forecast(url.searchParams);
        case "GET /regions": return regions;
        case "GET /seasons": {
          const meta = await data.getMeta();
          if (!regions.some((r) => r.code === meta.region)) fail(409, "no_region", "Сначала выберите регион.");
          return S.seasonsPayload(seasonsData, regionList, meta.region, await data.today());
        }
        case "POST /region": {
          const region = regions.find((r) => r.code === String(body.code == null ? "" : body.code));
          if (!region) fail(400, "unknown_region", "Такого региона нет в списке.");
          await data.patchMeta({ region: region.code });
          return { ok: true, region };
        }
        case "POST /location": return setLocation(body);
        case "GET /checklist": return data.checklistPayload();
        case "GET /checklist/hints": return checklistHints();
        case "POST /checklist/type": await data.setHuntType(body.hunt_type); return data.checklistPayload();
        case "POST /checklist/toggle": return { ok: true, id: body.id, checked: await data.toggleItem(body.id) };
        case "POST /checklist/add": return { ok: true, item: await data.addCustomItem(body.category, body.text) };
        case "POST /checklist/delete": await data.deleteCustomItem(body.id); return { ok: true };
        case "POST /checklist/reset": await data.resetChecks(); return Object.assign(await data.checklistPayload(), { ok: true });
        case "GET /places": return { places: await data.listPlaces(), max: data.LIMITS.MAX_PLACES };
        case "POST /places": return addPlace(body);
        case "POST /places/update": {
          const patch = {};
          if ("name" in body) {
            patch.name = cleanText(body.name, data.LIMITS.PLACE_NAME_MAX);
            if (!patch.name) fail(400, "empty_name", "Название не может быть пустым.");
          }
          patch.makeDefault = bool(body.is_default);
          return { ok: true, place: await data.updatePlace(body.id, patch) };
        }
        case "POST /places/delete": await data.deletePlace(body.id); return { ok: true };
        case "GET /journal": {
          const all = await data.allRecords();
          const records = all.slice(0, data.LIMITS.JOURNAL_LIMIT);
          return { records, count: records.length, stats: all.length ? await statsPayload(all) : null };
        }
        case "POST /journal": return { ok: true, record: await data.addRecord(body) };
        case "POST /journal/delete": await data.deleteRecord(body.id); return { ok: true };
        case "GET /stats": return statsPayload();
        case "GET /settings": return settings();
        case "POST /settings": {
          if ("timezone" in body) {
            const ok = body.timezone === "auto" || data.TIMEZONES.some((t) => t.code === body.timezone);
            if (!ok) fail(400, "bad_timezone", "Такого часового пояса нет в списке.");
            await data.patchMeta({ tz: body.timezone === "auto" ? null : body.timezone });
          }
          return Object.assign({ ok: true }, await settings());
        }
        case "GET /wind": return windAt(url.searchParams);
        case "GET /marks": return { marks: await data.listMarks(), types: N.MARK_TYPES, max: data.LIMITS.MAX_MARKS };
        case "POST /marks": return { ok: true, mark: await data.addMark(body) };
        case "POST /marks/update": return { ok: true, mark: await data.updateMark(body.id, body) };
        case "POST /marks/delete": await data.deleteMark(body.id); return { ok: true };
        case "GET /geo": return data.getGeo();
        case "POST /geo": return Object.assign({ ok: true }, await data.setGeo(body && body.status));
        case "GET /storage": return Object.assign({ kind: store.kind }, await store.usage());
        case "POST /data/delete-all": { const removed = await data.deleteAll(); forecastCache.clear(); return { ok: true, removed }; }
        default: return fail(404, "not_found", "Неизвестный запрос: " + key);
      }
    }
    return { handle, store, data, regions, seasonsData };
  }

  return { create, ApiError, NO_PLACE };
});
