import json
from datetime import date, datetime, timedelta, timezone

import pytest
from aiohttp.test_utils import TestClient, TestServer

from bot.config import Config
from bot.services.seasons import seasons_payload
from bot.services.weather import Place, hourly_series
from bot import policy
from bot.web.api import INIT_HEADER, create_app
from bot.web.auth import build_init_data
from bot.web.payloads import forecast_payload
from tests.conftest import build_forecast_json

TOKEN = "123456:TEST-TOKEN"


def fresh_forecast() -> dict:
    """Ответ Open-Meteo с датами «сегодня» и «завтра» (по UTC, смещение 0)."""
    today = datetime.now(timezone.utc).date()
    raw = json.dumps(build_forecast_json())
    raw = raw.replace("2026-11-20", today.isoformat()).replace("2026-11-21", (today + timedelta(days=1)).isoformat())
    data = json.loads(raw)
    data["utc_offset_seconds"] = 0
    return data


class FakeWeather:
    def __init__(self):
        self.forecast_calls = []

    async def fetch_forecast(self, http, lat, lon):
        self.forecast_calls.append((lat, lon))
        return fresh_forecast()

    async def geocode_city(self, http, name):
        if name.lower() == "майкоп":
            return Place("Майкоп", 44.6, 40.1, "Россия", "Адыгея")
        return None


def make_config(dev_user=None, cors=None) -> Config:
    return Config(bot_token=TOKEN, db_path=":memory:", webapp_dev_user_id=dev_user, webapp_cors_origin=cors)


CONSENT_USERS = (1, 2, 777)     # пользователи тестов: по умолчанию уже приняли политику


async def make_app(config, db, weather=None):
    """create_app, но предварительно записывает согласие тестовым пользователям."""
    for uid in CONSENT_USERS:
        await db.set_consent(uid, policy.POLICY_VERSION)
    return create_app(config, db, None, weather or FakeWeather())


def headers_for(user_id: int) -> dict:
    return {INIT_HEADER: build_init_data(TOKEN, {"id": user_id, "first_name": "T"})}


@pytest.fixture
async def client(db):
    weather = FakeWeather()
    app = await make_app(make_config(), db, weather)
    async with TestClient(TestServer(app)) as c:
        c.weather = weather
        yield c


H = headers_for(1)


# ---------- авторизация ----------

async def test_api_requires_init_data(client):
    for path in ("/api/me", "/api/forecast", "/api/activity", "/api/seasons", "/api/regions"):
        resp = await client.get(path)
        assert resp.status == 401, path
        assert (await resp.json())["error"] == "unauthorized"


async def test_api_rejects_invalid_init_data(client):
    resp = await client.get("/api/me", headers={INIT_HEADER: "hash=bad&auth_date=1"})
    assert resp.status == 401
    forged = build_init_data("999:OTHER", {"id": 1})
    assert (await client.get("/api/me", headers={INIT_HEADER: forged})).status == 401


async def test_post_requires_auth(client):
    assert (await client.post("/api/region", json={"code": "krasnodar"})).status == 401


async def test_dev_mode_allows_requests_without_init_data(db):
    app = await make_app(make_config(dev_user=777), db, FakeWeather())
    async with TestClient(TestServer(app)) as c:
        resp = await c.get("/api/me")
        assert resp.status == 200 and (await resp.json())["user_id"] == 777
        # а невалидные initData всё равно отвергаются
        assert (await c.get("/api/me", headers={INIT_HEADER: "hash=x"})).status == 401


async def test_dev_mode_off_by_default(client):
    assert (await client.get("/api/me")).status == 401


async def test_healthz_and_static_without_auth(client):
    assert (await client.get("/healthz")).status == 200
    resp = await client.get("/")
    assert resp.status == 200
    text = await resp.text()
    assert "telegram-web-app.js" in text and "/static/app.js" in text
    assert (await client.get("/static/app.js")).status == 200
    assert (await client.get("/static/style.css")).status == 200


async def test_every_script_and_style_in_index_is_served(client):
    import re

    text = await (await client.get("/")).text()
    local = re.findall(r'(?:src|href)="(/static/[^"]+)"', text)
    assert {"/static/style.css", "/static/core.js", "/static/app.js"} <= set(local)
    for url in local:
        resp = await client.get(url)
        assert resp.status == 200, url
    for tab in ("weather", "seasons", "checklist", "journal", "more"):
        assert f'data-tab="{tab}"' in text
    assert "Чек-лист" in text and "Журнал" in text


# ---------- /api/me, регион, место ----------

async def test_me_empty_state(client):
    data = await (await client.get("/api/me", headers=H)).json()
    assert data["region"] is None and data["places"] == [] and data["location"] is None
    assert data["has_place"] is False and data["timezone"] == "Europe/Moscow"


async def test_regions_list_krasnodar_adygea_first(client):
    data = await (await client.get("/api/regions", headers=H)).json()
    assert [r["code"] for r in data[:2]] == ["krasnodar", "adygea"]
    assert data[0]["verified"] is True and len(data) >= 85


async def test_set_region_and_me(client):
    resp = await client.post("/api/region", json={"code": "adygea"}, headers=H)
    assert resp.status == 200 and (await resp.json())["region"]["name"] == "Республика Адыгея"
    me = await (await client.get("/api/me", headers=H)).json()
    assert me["region"]["code"] == "adygea" and me["region"]["verified"] is True


async def test_set_region_validation(client):
    assert (await client.post("/api/region", json={"code": "mars"}, headers=H)).status == 400
    assert (await client.post("/api/region", json=["x"], headers=H)).status == 400
    assert (await client.post("/api/region", data="не json", headers=H)).status == 400


async def test_set_location_by_city(client):
    resp = await client.post("/api/location", json={"city": "  Майкоп "}, headers=H)
    assert resp.status == 200
    assert (await resp.json())["location"]["name"] == "Майкоп, Адыгея, Россия"
    me = await (await client.get("/api/me", headers=H)).json()
    assert me["has_place"] and me["location"]["lat"] == 44.6


async def test_set_location_unknown_city_and_bad_input(client):
    assert (await client.post("/api/location", json={"city": "Атлантида"}, headers=H)).status == 404
    assert (await client.post("/api/location", json={"city": "   "}, headers=H)).status == 400
    assert (await client.post("/api/location", json={"city": "я" * 200}, headers=H)).status == 400


async def test_set_location_by_coordinates(client):
    resp = await client.post("/api/location", json={"lat": 45.04, "lon": 38.98}, headers=H)
    assert resp.status == 200
    for bad in ({"lat": 91, "lon": 0}, {"lat": "x", "lon": 1}, {"lat": 10}, {"lat": True, "lon": 1}):
        assert (await client.post("/api/location", json=bad, headers=H)).status == 400, bad


# ---------- прогноз и активность ----------

async def test_forecast_without_place_is_409(client):
    resp = await client.get("/api/forecast", headers=H)
    assert resp.status == 409 and (await resp.json())["error"] == "no_place"
    assert (await client.get("/api/activity", headers=H)).status == 409


async def test_forecast_payload_structure(client, db):
    await db.set_location(1, 44.6, 40.1, "Майкоп")
    resp = await client.get("/api/forecast", headers=H)
    assert resp.status == 200
    data = await resp.json()
    assert data["place"]["key"] == "cur" and data["place"]["lat"] == 44.6
    assert [d["label"] for d in data["days"]] == ["today", "tomorrow"]
    day = data["days"][1]
    assert day["sunrise"] == "08:07" and day["sunset"] == "16:08"
    assert 1 <= day["score"]["value"] <= 5 and day["score"]["reasons"]
    assert day["moon"]["name"] and 0 <= day["moon"]["illumination"] <= 1
    hourly = day["hourly"]
    assert len(hourly["time"]) == 24 and hourly["time"][0] == "00:00"
    for key in ("temperature", "wind_speed", "wind_gusts", "wind_direction", "precipitation", "pressure_mmhg", "cloud_cover"):
        assert len(hourly[key]) == 24, key
    assert hourly["pressure_mmhg"][0] == pytest.approx(1015 * 0.750062, abs=0.1)
    assert day["dawn"]["wind_direction_name"] == "З"
    assert [a["group"] for a in day["activity"]] == ["waterfowl", "upland", "ungulates", "pheasant", "hare"]
    assert [d["heading"] for d in data["days"]][0].startswith("Сегодня, ")
    assert data["days"][1]["heading"].startswith("Завтра, ")
    assert "ориентировочная оценка" in data["activity_disclaimer"]


async def test_forecast_place_selection(client, db):
    await db.set_location(1, 1.0, 2.0, "Тут")
    await db.add_place(1, "Озеро", 45.0, 38.9)
    b = await db.add_place(1, "Лес", 44.6, 40.1)
    await client.get("/api/forecast", headers=H)                     # по умолчанию — первое угодье
    assert client.weather.forecast_calls[-1] == (45.0, 38.9)
    data = await (await client.get(f"/api/forecast?place_id={b}", headers=H)).json()
    assert client.weather.forecast_calls[-1] == (44.6, 40.1) and data["place"]["title"] == "Лес"
    await client.get("/api/forecast?place_id=cur", headers=H)
    assert client.weather.forecast_calls[-1] == (1.0, 2.0)
    assert (await client.get("/api/forecast?place_id=9999", headers=H)).status == 409


async def test_cannot_use_other_users_place(client, db):
    pid = await db.add_place(2, "Чужое", 10.0, 20.0)
    await db.set_location(1, 1.0, 2.0, "Моё")
    resp = await client.get(f"/api/forecast?place_id={pid}", headers=H)
    assert resp.status == 409                                        # чужого угодья для пользователя 1 не существует


async def test_activity_endpoint(client, db):
    await db.add_place(1, "Озеро", 45.0, 38.9)
    data = await (await client.get("/api/activity", headers=H)).json()
    assert len(data["days"]) == 2 and data["place"]["title"].endswith("Озеро")
    g = data["days"][0]["activity"][0]
    assert 1 <= g["dawn"]["value"] <= 5 and 1 <= g["dusk"]["value"] <= 5 and g["dawn"]["reasons"]
    assert "hourly" not in data["days"][0]


async def test_weather_failure_returns_502(db):
    from bot.services.weather import WeatherError

    class Broken(FakeWeather):
        async def fetch_forecast(self, http, lat, lon):
            raise WeatherError("нет сети")

    await db.set_location(1, 1.0, 2.0, "x")
    app = await make_app(make_config(), db, Broken())
    async with TestClient(TestServer(app)) as c:
        resp = await c.get("/api/forecast", headers=H)
        assert resp.status == 502 and (await resp.json())["error"] == "weather_unavailable"


# ---------- сезоны ----------

async def test_seasons_requires_region(client):
    resp = await client.get("/api/seasons", headers=H)
    assert resp.status == 409 and (await resp.json())["error"] == "no_region"


async def test_seasons_for_krasnodar(client, db):
    await db.set_region(1, "krasnodar")
    data = await (await client.get("/api/seasons", headers=H)).json()
    assert data["region"]["name"] == "Краснодарский край" and data["verified"] is True
    assert [c["id"] for c in data["categories"]] == ["spring", "birds", "ungulates", "fur"]
    assert any("krasnodar-gov.ru" in s["url"] for s in data["sources"])
    assert "региональном охотуправлении" in data["disclaimer"]
    birds = {e["id"]: e for c in data["categories"] for e in c["entries"]}
    assert birds["waterfowl"]["windows"][0]["start"].endswith("-09-26") or birds["waterfowl"]["state"] in ("open", "closed", "upcoming")
    assert birds["spring_frame"]["state"] == "banned"
    assert data["open_count"] >= 0


async def test_seasons_unverified_region_marked(client, db):
    await db.set_region(1, "samarskaya_oblast")
    data = await (await client.get("/api/seasons", headers=H)).json()
    assert data["verified"] is False and data["summary"] is None


async def test_users_are_isolated(client, db):
    await client.post("/api/region", json={"code": "krasnodar"}, headers=headers_for(1))
    me2 = await (await client.get("/api/me", headers=headers_for(2))).json()
    assert me2["region"] is None


async def test_cors_headers_when_configured(db):
    app = await make_app(make_config(cors="https://zorka.github.io"), db, FakeWeather())
    async with TestClient(TestServer(app)) as c:
        resp = await c.options("/api/me")
        assert resp.status == 204 and resp.headers["Access-Control-Allow-Origin"] == "https://zorka.github.io"
        assert INIT_HEADER in resp.headers["Access-Control-Allow-Headers"]
        resp = await c.get("/api/me", headers=H)
        assert resp.headers["Access-Control-Allow-Origin"] == "https://zorka.github.io"


async def test_no_cors_headers_by_default(client):
    resp = await client.get("/api/me", headers=H)
    assert "Access-Control-Allow-Origin" not in resp.headers


# ---------- чистые функции ----------

def test_hourly_series_filters_day():
    raw = build_forecast_json()
    s = hourly_series(raw, date(2026, 11, 21))
    assert len(s["time"]) == 24 and s["time"][-1] == "23:00"
    assert hourly_series(raw, date(2030, 1, 1))["time"] == []


def test_forecast_payload_skips_missing_days():
    raw = build_forecast_json()
    now = datetime(2026, 11, 21, 6, 0, tzinfo=timezone.utc)      # сегодня 21-е; завтра (22-е) в данных нет
    out = forecast_payload(raw, {"title": "x"}, now)
    assert [d["label"] for d in out["days"]] == ["today"]


def test_seasons_payload_states():
    p = seasons_payload("krasnodar", date(2026, 11, 20))
    entries = {e["id"]: e for c in p["categories"] for e in c["entries"]}
    assert entries["waterfowl"]["state"] == "open" and entries["waterfowl"]["current_end"] == "2027-01-20"
    assert entries["roe_males"]["state"] == "closed" and entries["roe_males"]["next_start"] == "2027-05-20"
    assert entries["spring_frame"]["windows"] == []
