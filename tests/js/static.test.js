// Статические проверки webapp/: годится для голого статического хостинга (GitHub Pages), без innerHTML, без лишних запросов.
"use strict";
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { assert, WEBAPP, readJSON } = require("./helpers");

const read = (...p) => fs.readFileSync(path.join(WEBAPP, ...p), "utf8");
const html = read("index.html");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const jsFiles = walk(WEBAPP).filter((f) => f.endsWith(".js") && !f.includes(path.sep + "vendor" + path.sep));
const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);

test("index.html: свои файлы подключены по относительным путям, существуют и версионированы одним ?v=", () => {
  const own = assets.filter((a) => !/^https?:/.test(a));
  assert.ok(own.length >= 20);
  const versions = new Set();
  for (const a of own) {
    assert.ok(!a.startsWith("/") && !a.startsWith("//"), "абсолютный путь ломает хостинг в подкаталоге: " + a);
    const m = a.match(/^([^?]+)\?v=(\d+)$/);
    assert.ok(m, "нет ?v=: " + a);
    versions.add(m[2]);
    assert.ok(fs.existsSync(path.join(WEBAPP, m[1])), "нет файла " + m[1]);
  }
  assert.equal(versions.size, 1, "версия должна быть одна на все файлы");
  assert.deepEqual(assets.filter((a) => /^https?:/.test(a)), ["https://telegram.org/js/telegram-web-app.js"]);
});

test("порядок скриптов: библиотеки раньше интерфейса, каждый файл подключён один раз", () => {
  const scripts = assets.filter((a) => a.endsWith(".js") || a.includes(".js?")).map((a) => a.split("?")[0]).filter((a) => !a.startsWith("http"));
  assert.equal(new Set(scripts).size, scripts.length);
  const idx = (n) => scripts.indexOf(n);
  assert.ok(idx("lib/storage.js") < idx("lib/data.js") && idx("lib/data.js") < idx("lib/api.js") && idx("lib/api.js") < idx("core.js"));
  assert.ok(idx("core.js") < idx("app.js") && idx("app.js") === scripts.length - 1);
  const libs = fs.readdirSync(path.join(WEBAPP, "lib")).map((f) => "lib/" + f).sort();
  assert.deepEqual([...scripts.filter((s) => s.startsWith("lib/"))].sort(), libs, "каждая библиотека подключена");
});

test("код обращается к /api только в разовом переносе; нет ни абсолютных адресов сервера автора, ни innerHTML", () => {
  for (const f of jsFiles) {
    const src = fs.readFileSync(f, "utf8");
    const rel = path.relative(WEBAPP, f).replace(/\\/g, "/");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(src), "небезопасная вставка HTML: " + rel);
    const apiMentions = src.split("\n").filter((l) => /["'`]\/api\//.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    if (!["lib/migrate.js", "lib/api.js", "core.js", "app.js"].includes(rel)) assert.deepEqual(apiMentions, [], rel);
    assert.ok(!/trycloudflare|localhost|127\.0\.0\.1/.test(src), "жёсткий адрес в " + rel);
  }
  const external = new Set();
  for (const f of jsFiles) for (const m of fs.readFileSync(f, "utf8").matchAll(/https?:\/\/[a-z0-9.-]+/gi)) external.add(m[0]);
  const allowed = ["https://api.open-meteo.com", "https://geocoding-api.open-meteo.com", "https://open-meteo.com", "https://t.me", "https://telegram.org", "http://www.w3.org", "http://local", "https://tile.openstreetmap.org", "https://www.openstreetmap.org", "https://openstreetmap.org", "https://server.arcgisonline.com", "https://opentopomap.org", "https://a.tile.opentopomap.org"];   // w3.org — SVG; http://local — разбор пути; тайлы и атрибуция карты
  for (const u of external) assert.ok(allowed.some((a) => u.startsWith(a)), "посторонний адрес в коде: " + u);
});

test("статические данные — корректный JSON нужной формы", () => {
  const seasons = readJSON(WEBAPP, "data", "seasons.json"), regions = readJSON(WEBAPP, "data", "regions.json"), ck = readJSON(WEBAPP, "data", "checklist.json");
  assert.ok(Array.isArray(regions) && regions.length > 50 && regions.every((r) => r.code && r.name));
  assert.ok(seasons.regions || seasons.version || Object.keys(seasons).length);
  assert.deepEqual(Object.keys(ck).sort(), ["by_type", "categories", "category_order", "common", "hunt_types"]);
  assert.deepEqual(ck.category_order, ["gun", "docs", "gear", "food"]);
});

test("в приложении нет согласия, политики и рассылки; есть блок «О данных» и кнопка удаления", () => {
  const all = jsFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n") + html;
  assert.ok(!/consent|политик|оператор персональн|рассылк|подписк/i.test(all), "остатки старой схемы");
  const more = read("more.js");
  assert.match(more, /О данных/); assert.match(more, /Удалить все данные/);
  assert.match(more, /Open-Meteo/); assert.match(more, /open-meteo\.com/);
  assert.match(more, /CloudStorage|облак/i);
  assert.match(more, /не хранит/);
});

test("оговорки сохранены: «Информация справочная…» у сезонов и «Оценка по правилам…» у активности", () => {
  assert.match(read("seasons.js") + read("lib/seasons.js"), /Информация справочная\. Перед выездом сверяйтесь с указом главы вашего региона и региональным охотуправлением\./);
  assert.match(read("weather.js") + read("lib/activity.js") + read("lib/forecast.js"), /Оценка по правилам, а не гарантия\./);
});

test("каждое значение текста выводится как текст: в UI нет присвоения разметки", () => {
  const core = read("core.js");
  assert.match(core, /textContent|createTextNode/);
});

test("вкладка «Карта» есть в меню, Leaflet лежит в vendor/ со своей лицензией и не подключается с CDN", () => {
  assert.match(html, /data-tab="map"/);
  assert.match(html, />Карта</);
  assert.match(html, /src="map\.js\?v=/);
  assert.match(html, /src="lib\/nav\.js\?v=/);
  assert.ok(!/unpkg|cdnjs|jsdelivr|leaflet@/i.test(html));
  const dir = path.join(WEBAPP, "vendor", "leaflet");
  assert.ok(fs.existsSync(path.join(dir, "leaflet.js")) && fs.existsSync(path.join(dir, "leaflet.css")));
  const lic = fs.readFileSync(path.join(dir, "LICENSE"), "utf8");
  assert.match(lic, /BSD 2-Clause/);
  assert.match(lic, /Volodymyr Agafonkin/);
  for (const img of ["marker-icon.png", "marker-icon-2x.png", "marker-shadow.png", "layers.png", "layers-2x.png"]) {
    assert.ok(fs.existsSync(path.join(dir, "images", img)), img);
  }
});

test("каталог границ: файлы на месте, загрузчик и оговорка есть, черновик Абинского не включён", () => {
  const map = read("map.js");
  assert.match(map, /data\/boundaries\/index\.json/);
  assert.match(map, /общедоступ|закрепл|ООПТ|oopt/i);
  assert.ok(fs.existsSync(path.join(WEBAPP, "data", "boundaries")));
  const catalog = JSON.parse(fs.readFileSync(path.join(WEBAPP, "data", "boundaries", "index.json"), "utf8"));
  assert.ok(Array.isArray(catalog) && catalog.length >= 3);
  const files = catalog.map((e) => e.file);
  assert.ok(files.includes("adygea_maykop.geojson") && files.includes("oopt_adygea.geojson") && files.includes("oopt_krasnodar.geojson"));
  assert.ok(!files.some((f) => /abinsky/i.test(f)));
  for (const e of catalog) {
    assert.ok(e.file && e.region && e.type, JSON.stringify(e));
    const geo = readJSON(WEBAPP, "data", "boundaries", e.file);
    assert.ok(Array.isArray(geo.features) && geo.features.length, e.file);
    assert.ok(geo.features.every((f) => f.geometry && f.properties && f.properties.name));
  }
  assert.equal(readJSON(WEBAPP, "data", "boundaries", "adygea_maykop.geojson").features.length, 2);
  assert.equal(readJSON(WEBAPP, "data", "boundaries", "oopt_adygea.geojson").features.length, 7);
  assert.equal(readJSON(WEBAPP, "data", "boundaries", "oopt_krasnodar.geojson").features.length, 71);
  assert.match(map, /Границы ориентировочные, по официальным схемам; не проверены — сверяйтесь с охотпользователем/);
  assert.match(map, /OSM contributors \(ODbL\)/);
  assert.match(map, /map-attr-btn/);
  assert.match(map, /describeGeoError/);

});

test("приложение отключает вертикальный свайп Telegram (закрытие Mini App), если метод есть", () => {
  const core = read("core.js");
  assert.match(core, /disableVerticalSwipes/);
  assert.match(core, /isVersionAtLeast\(["']7\.7["']\)/);
  assert.ok(!/enableClosingConfirmation\s*\(/.test(core), "подтверждение закрытия не включаем");
});

test("список «Вернуться к…» не пересобирается при обновлении курса, позиции и ветра", () => {
  const map = read("map.js");
  assert.match(map, /function updateNavLive\s*\(/);
  assert.match(map, /function updateWindLive\s*\(/);
  assert.match(map, /function openTargetPicker\s*\(/);
  assert.match(map, /targetOptionLabels/);
  assert.ok(!/h\(\s*["']select["']/.test(map), "нативный select больше не используем: он закрывался при перерисовке");
  assert.match(map, /startHeading\(\(deg\) => \{ session\.heading = deg; updateNavLive\(\); \}\)/);
  assert.match(map, /scheduleWind\(\);\s*updateNavLive\(\)/);
  assert.match(map, /drawWindArrow\(\);\s*updateWindLive\(\)/);
});

test("геолокация: LocationManager спрашивает разрешение один раз, без getCurrentPosition на каждый опрос", () => {
  const map = read("map.js");
  const nav = read("lib/nav.js");
  assert.match(nav, /function geoDecision\s*\(/);
  assert.match(map, /geoDecision/);
  assert.match(map, /ensureLmInit/);
  assert.match(map, /locRuntime/);
  assert.ok(!/getCurrentPosition/.test(map), "getCurrentPosition в WebView Telegram снова показывает окно разрешения");
  assert.match(map, /watchPosition/);
  assert.ok(!/shouldFallbackFromTelegram/.test(map));
});
