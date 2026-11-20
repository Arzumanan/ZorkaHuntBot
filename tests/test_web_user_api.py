# ruff: noqa: F811
"""API личных данных: чек-лист, угодья, журнал, статистика, настройки (aiohttp test client, временная БД)."""
from datetime import datetime, timedelta, timezone

import pytest
from aiohttp.test_utils import TestClient, TestServer

from bot.web.api import create_app
from tests.test_web_api import FakeWeather, H, client, fresh_forecast, headers_for, make_config  # noqa: F401


def post(client, path, body=None, headers=H):
    return client.post(path, json=body if body is not None else {}, headers=headers)


# ---------- авторизация всех новых маршрутов ----------

GET_PATHS = ["/api/checklist", "/api/places", "/api/journal", "/api/stats", "/api/settings"]
POST_PATHS = ["/api/checklist/type", "/api/checklist/toggle", "/api/checklist/add", "/api/checklist/delete",
              "/api/checklist/reset", "/api/places", "/api/places/update", "/api/places/delete",
              "/api/journal", "/api/journal/delete", "/api/settings"]


@pytest.mark.parametrize("path", GET_PATHS)
async def test_get_routes_require_auth(client, path):
    assert (await client.get(path)).status == 401


@pytest.mark.parametrize("path", POST_PATHS)
async def test_post_routes_require_auth(client, path):
    assert (await client.post(path, json={})).status == 401


@pytest.mark.parametrize("path", POST_PATHS)
async def test_post_routes_reject_non_object_json(client, path):
    resp = await client.post(path, data="[1,2]", headers=H)
    if path == "/api/checklist/reset":
        assert resp.status == 200                 # тело не нужно
    else:
        assert resp.status == 400 and (await resp.json())["error"] == "bad_json"


# ---------- чек-лист ----------

async def test_checklist_default_structure(client):
    data = await (await client.get("/api/checklist", headers=H)).json()
    assert data["hunt_type"] == "general" and data["done"] == 0 and data["total"] > 15
    assert [c["code"] for c in data["categories"]] == ["gun", "docs", "gear", "food"]
    assert [c["name"] for c in data["categories"]] == ["🔫 Оружие", "📄 Документы", "🎒 Снаряжение", "🥪 Еда и питьё"]
    assert [t["code"] for t in data["hunt_types"]] == ["waterfowl", "upland", "ungulates", "general"]
    assert sum(c["total"] for c in data["categories"]) == data["total"]
    assert all(not i["custom"] and not i["checked"] for c in data["categories"] for i in c["items"])
    assert data["hints"] == []                    # места нет — подсказок нет


async def test_checklist_toggle_progress_and_persistence(client):
    data = await (await client.get("/api/checklist", headers=H)).json()
    item = data["categories"][1]["items"][0]
    resp = await post(client, "/api/checklist/toggle", {"id": item["id"]})
    assert resp.status == 200 and (await resp.json())["checked"] is True
    data = await (await client.get("/api/checklist", headers=H)).json()
    assert data["done"] == 1 and data["categories"][1]["done"] == 1
    assert data["categories"][1]["items"][0]["checked"] is True
    assert (await (await post(client, "/api/checklist/toggle", {"id": item["id"]})).json())["checked"] is False
    assert (await (await client.get("/api/checklist", headers=H)).json())["done"] == 0


async def test_checklist_toggle_unknown_or_bad_id(client):
    for body in ({"id": 99999}, {"id": "x"}, {}, {"id": -1}, {"id": True}):
        assert (await post(client, "/api/checklist/toggle", body)).status == 404, body


async def test_checklist_state_is_per_hunt_type(client):
    gen = await (await client.get("/api/checklist", headers=H)).json()
    await post(client, "/api/checklist/toggle", {"id": gen["categories"][0]["items"][0]["id"]})
    wf = await (await post(client, "/api/checklist/type", {"hunt_type": "waterfowl"})).json()
    assert wf["hunt_type"] == "waterfowl" and wf["done"] == 0
    assert wf["total"] > gen["total"]
    assert any("Чучела" in i["text"] for c in wf["categories"] for i in c["items"])
    back = await (await post(client, "/api/checklist/type", {"hunt_type": "general"})).json()
    assert back["done"] == 1                       # отметка в «общем» сохранилась
    me = await (await client.get("/api/me", headers=H)).json()
    assert me["hunt_type"] == "general"


async def test_checklist_unknown_hunt_type(client):
    resp = await post(client, "/api/checklist/type", {"hunt_type": "fishing"})
    assert resp.status == 400 and (await resp.json())["error"] == "unknown_hunt_type"
    assert (await post(client, "/api/checklist/type", {})).status == 400


async def test_checklist_add_and_delete_custom_item(client):
    await client.get("/api/checklist", headers=H)
    resp = await post(client, "/api/checklist/add", {"category": "food", "text": "  Термос   с   чаем  "})
    assert resp.status == 201
    item = (await resp.json())["item"]
    assert item["text"] == "Термос с чаем" and item["custom"] is True
    data = await (await client.get("/api/checklist", headers=H)).json()
    food = data["categories"][3]
    assert food["items"][-1]["text"] == "Термос с чаем" and food["items"][-1]["custom"] is True
    assert (await post(client, "/api/checklist/delete", {"id": item["id"]})).status == 200
    data = await (await client.get("/api/checklist", headers=H)).json()
    assert all(not i["custom"] for c in data["categories"] for i in c["items"])
    assert (await post(client, "/api/checklist/delete", {"id": item["id"]})).status == 404


async def test_checklist_cannot_delete_template_item(client):
    data = await (await client.get("/api/checklist", headers=H)).json()
    template_id = data["categories"][0]["items"][0]["id"]
    assert (await post(client, "/api/checklist/delete", {"id": template_id})).status == 404
    assert (await (await client.get("/api/checklist", headers=H)).json())["total"] == data["total"]


async def test_checklist_add_validation_and_length_limit(client):
    assert (await post(client, "/api/checklist/add", {"category": "weapons", "text": "x"})).status == 400
    assert (await post(client, "/api/checklist/add", {"category": "gun", "text": "   "})).status == 400
    assert (await post(client, "/api/checklist/add", {"category": "gun", "text": 5})).status == 400
    item = (await (await post(client, "/api/checklist/add", {"category": "gun", "text": "я" * 300})).json())["item"]
    assert len(item["text"]) == 100


async def test_checklist_custom_item_survives_in_its_hunt_type_only(client):
    await post(client, "/api/checklist/add", {"category": "gear", "text": "Своя вещь"})
    wf = await (await post(client, "/api/checklist/type", {"hunt_type": "waterfowl"})).json()
    assert all(not i["custom"] for c in wf["categories"] for i in c["items"])


async def test_checklist_reset_clears_checks_of_current_type_only(client):
    data = await (await client.get("/api/checklist", headers=H)).json()
    for c in data["categories"][:2]:
        await post(client, "/api/checklist/toggle", {"id": c["items"][0]["id"]})
    await post(client, "/api/checklist/type", {"hunt_type": "upland"})
    up = await (await client.get("/api/checklist", headers=H)).json()
    await post(client, "/api/checklist/toggle", {"id": up["categories"][0]["items"][0]["id"]})
    resp = await post(client, "/api/checklist/reset")
    assert resp.status == 200 and (await resp.json())["done"] == 0
    back = await (await post(client, "/api/checklist/type", {"hunt_type": "general"})).json()
    assert back["done"] == 2                       # «общий» не тронут


async def test_checklist_isolated_between_users(client):
    mine = await (await client.get("/api/checklist", headers=H)).json()
    item_id = mine["categories"][0]["items"][0]["id"]
    other = headers_for(2)
    assert (await post(client, "/api/checklist/toggle", {"id": item_id}, other)).status == 404
    await post(client, "/api/checklist/add", {"category": "gun", "text": "Чужое"}, other)
    assert all(not i["custom"] for c in (await (await client.get("/api/checklist", headers=H)).json())["categories"]
               for i in c["items"])


async def test_checklist_weather_hints_for_default_place(client, db):
    await db.add_place(1, "Озеро", 45.0, 38.9)
    data = await (await client.get("/api/checklist", headers=H)).json()
    assert any("Холодно" in h for h in data["hints"])
    assert client.weather.forecast_calls[-1] == (45.0, 38.9)


async def test_checklist_hints_survive_weather_failure(db):
    from bot.services.weather import WeatherError

    class Broken(FakeWeather):
        async def fetch_forecast(self, http, lat, lon):
            raise WeatherError("нет сети")

    await db.add_place(1, "Озеро", 45.0, 38.9)
    app = create_app(make_config(), db, None, Broken())
    async with TestClient(TestServer(app)) as c:
        resp = await c.get("/api/checklist", headers=H)
        assert resp.status == 200 and (await resp.json())["hints"] == []


async def test_checklist_hints_rain(db):
    class Rainy(FakeWeather):
        async def fetch_forecast(self, http, lat, lon):
            raw = fresh_forecast()
            raw["hourly"]["precipitation"] = [3.0] * len(raw["hourly"]["time"])
            raw["hourly"]["temperature_2m"] = [12.0] * len(raw["hourly"]["time"])
            return raw

    await db.set_location(1, 45.0, 38.9, "Краснодар")
    app = create_app(make_config(), db, None, Rainy())
    async with TestClient(TestServer(app)) as c:
        data = await (await c.get("/api/checklist", headers=H)).json()
        assert any("дождь" in h.lower() for h in data["hints"])


# ---------- угодья ----------

async def test_places_empty_list(client):
    data = await (await client.get("/api/places", headers=H)).json()
    assert data["places"] == [] and data["max"] == 30


async def test_places_add_by_city_default_name_and_first_is_default(client):
    resp = await post(client, "/api/places", {"city": "Майкоп"})
    assert resp.status == 201
    p = (await resp.json())["place"]
    assert p["name"] == "Майкоп" and p["lat"] == 44.6 and p["is_default"] is True
    resp = await post(client, "/api/places", {"city": "Майкоп", "name": "Озеро за мостом"})
    p2 = (await resp.json())["place"]
    assert p2["name"] == "Озеро за мостом" and p2["is_default"] is False


async def test_places_add_by_coordinates(client):
    resp = await post(client, "/api/places", {"lat": 45.04, "lon": 38.98, "name": "  Лиман "})
    assert resp.status == 201 and (await resp.json())["place"]["name"] == "Лиман"
    p = (await (await post(client, "/api/places", {"lat": 45.1, "lon": 38.9})).json())["place"]
    assert p["name"].startswith("Угодье 45.100")


async def test_places_add_validation(client):
    for body in ({"lat": 91, "lon": 0}, {"lat": 0, "lon": 181}, {"lat": "a", "lon": 1}, {"lat": 5},
                 {"lat": True, "lon": 1}):
        assert (await post(client, "/api/places", body)).status == 400, body
    assert (await post(client, "/api/places", {"city": "  "})).status == 400
    assert (await post(client, "/api/places", {})).status == 400
    assert (await post(client, "/api/places", {"city": "Атлантида"})).status == 404
    assert (await client.get("/api/places", headers=H)).status == 200
    assert (await (await client.get("/api/places", headers=H)).json())["places"] == []


async def test_places_limit(client, db):
    for i in range(30):
        await db.add_place(1, f"П{i}", 1.0, 2.0)
    resp = await post(client, "/api/places", {"lat": 1, "lon": 2})
    assert resp.status == 400 and (await resp.json())["error"] == "too_many"


async def test_places_rename_and_set_default(client):
    a = (await (await post(client, "/api/places", {"lat": 1, "lon": 2, "name": "A"})).json())["place"]["id"]
    b = (await (await post(client, "/api/places", {"lat": 3, "lon": 4, "name": "B"})).json())["place"]["id"]
    resp = await post(client, "/api/places/update", {"id": b, "name": " Новое  имя ", "is_default": True})
    p = (await resp.json())["place"]
    assert p["name"] == "Новое имя" and p["is_default"] is True
    places = (await (await client.get("/api/places", headers=H)).json())["places"]
    assert [x["id"] for x in places] == [b, a] and places[1]["is_default"] is False
    me = await (await client.get("/api/me", headers=H)).json()
    assert me["places"][0]["id"] == b


async def test_places_update_validation(client):
    pid = (await (await post(client, "/api/places", {"lat": 1, "lon": 2, "name": "A"})).json())["place"]["id"]
    assert (await post(client, "/api/places/update", {"id": pid, "name": "   "})).status == 400
    assert (await post(client, "/api/places/update", {"id": 999, "name": "x"})).status == 404
    assert (await post(client, "/api/places/update", {"name": "x"})).status == 404
    p = (await (await post(client, "/api/places/update", {"id": pid, "is_default": False})).json())["place"]
    assert p["name"] == "A" and p["is_default"] is True       # is_default:false ничего не снимает


async def test_places_delete_reassigns_default(client):
    a = (await (await post(client, "/api/places", {"lat": 1, "lon": 2, "name": "A"})).json())["place"]["id"]
    b = (await (await post(client, "/api/places", {"lat": 3, "lon": 4, "name": "B"})).json())["place"]["id"]
    assert (await post(client, "/api/places/delete", {"id": a})).status == 200
    places = (await (await client.get("/api/places", headers=H)).json())["places"]
    assert [p["id"] for p in places] == [b] and places[0]["is_default"] is True
    assert (await post(client, "/api/places/delete", {"id": a})).status == 404
    assert (await post(client, "/api/places/delete", {})).status == 404


async def test_places_are_per_user(client):
    pid = (await (await post(client, "/api/places", {"lat": 1, "lon": 2, "name": "A"})).json())["place"]["id"]
    other = headers_for(2)
    assert (await (await client.get("/api/places", headers=other)).json())["places"] == []
    assert (await post(client, "/api/places/delete", {"id": pid}, other)).status == 404
    assert (await post(client, "/api/places/update", {"id": pid, "name": "x"}, other)).status == 404
    assert len((await (await client.get("/api/places", headers=H)).json())["places"]) == 1


# ---------- журнал ----------

def today_iso():
    return datetime.now(timezone.utc).date().isoformat()


async def test_journal_empty(client):
    assert await (await client.get("/api/journal", headers=H)).json() == {"records": [], "count": 0}


async def test_journal_add_list_delete(client):
    body = {"date": "2026-10-03", "place": "  Озеро  Круглое ", "species": "Кряква", "note": "утка пошла к 6:30"}
    resp = await post(client, "/api/journal", body)
    assert resp.status == 201
    rec = (await resp.json())["record"]
    assert rec["place"] == "Озеро Круглое" and rec["date"] == "2026-10-03" and rec["note"] == "утка пошла к 6:30"
    await post(client, "/api/journal", {"date": "2026-11-01", "place": "Лес", "species": "Кабан"})
    data = await (await client.get("/api/journal", headers=H)).json()
    assert data["count"] == 2 and [r["species"] for r in data["records"]] == ["Кабан", "Кряква"]   # новые сверху
    assert data["records"][0]["note"] == ""
    assert (await post(client, "/api/journal/delete", {"id": rec["id"]})).status == 200
    assert (await (await client.get("/api/journal", headers=H)).json())["count"] == 1
    assert (await post(client, "/api/journal/delete", {"id": rec["id"]})).status == 404


async def test_journal_accepts_ru_date_format_and_words(client):
    r = await post(client, "/api/journal", {"date": "15.11.2026", "place": "x", "species": "y"})
    assert (await r.json())["record"]["date"] == "2026-11-15"
    r = await post(client, "/api/journal", {"date": "сегодня", "place": "x", "species": "y"})
    assert r.status == 201


async def test_journal_validation(client):
    ok = {"date": "2026-10-03", "place": "x", "species": "y"}
    bad = [
        (ok | {"date": "завтра никогда"}, "bad_date"), (ok | {"date": 5}, "bad_date"), ({k: v for k, v in ok.items() if k != "date"}, "bad_date"),
        (ok | {"place": "  "}, "empty_place"), (ok | {"species": ""}, "empty_species"),
        (ok | {"date": (datetime.now(timezone.utc).date() + timedelta(days=3)).isoformat()}, "future_date"),
        (ok | {"place": 7}, "empty_place"),
    ]
    for body, code in bad:
        resp = await post(client, "/api/journal", body)
        assert resp.status == 400 and (await resp.json())["error"] == code, body
    assert (await (await client.get("/api/journal", headers=H)).json())["count"] == 0


async def test_journal_trims_long_fields(client):
    resp = await post(client, "/api/journal", {"date": today_iso(), "place": "п" * 500, "species": "в" * 300, "note": "з" * 900})
    rec = (await resp.json())["record"]
    assert (len(rec["place"]), len(rec["species"]), len(rec["note"])) == (200, 100, 500)


async def test_journal_is_per_user(client):
    rec = (await (await post(client, "/api/journal", {"date": today_iso(), "place": "x", "species": "y"})).json())["record"]
    other = headers_for(2)
    assert (await (await client.get("/api/journal", headers=other)).json())["count"] == 0
    assert (await post(client, "/api/journal/delete", {"id": rec["id"]}, other)).status == 404


async def test_journal_date_uses_user_timezone(db):
    """«Сегодня» считается по часовому поясу пользователя: у Камчатки (UTC+12) уже завтрашняя дата по UTC."""
    app = create_app(make_config(), db, None, FakeWeather())
    async with TestClient(TestServer(app)) as c:
        await post(c, "/api/settings", {"timezone": "Asia/Kamchatka"})
        kam_today = (datetime.now(timezone.utc) + timedelta(hours=12)).date()
        resp = await post(c, "/api/journal", {"date": kam_today.isoformat(), "place": "x", "species": "y"})
        assert resp.status == 201


# ---------- статистика ----------

async def test_stats_empty(client):
    data = await (await client.get("/api/stats", headers=H)).json()
    assert data["records"] == 0 and data["trips"] == 0 and data["by_species"] == [] and data["best_months"] == []


async def test_stats_filled(client):
    rows = [("2026-10-03", "Озеро", "Кряква"), ("2026-10-03", "озеро", "кряква"), ("2026-10-17", "Лес", "Кабан"),
            ("2026-11-01", "Лес", "Кабан")]
    for d, p, s in rows:
        await post(client, "/api/journal", {"date": d, "place": p, "species": s})
    data = await (await client.get("/api/stats", headers=H)).json()
    assert data["records"] == 4 and data["trips"] == 3
    assert data["by_species"][0]["count"] == 2
    assert {x["name"]: x["count"] for x in data["by_species"]} == {"Кряква": 2, "Кабан": 2}
    assert {x["name"]: x["count"] for x in data["by_place"]} == {"Озеро": 2, "Лес": 2}
    assert data["by_month"] == [{"month": "2026-10", "count": 3}, {"month": "2026-11", "count": 1}]
    assert data["best_months"][0] == {"name": "октябрь", "count": 3}


async def test_stats_are_per_user(client):
    await post(client, "/api/journal", {"date": "2026-10-03", "place": "x", "species": "y"})
    assert (await (await client.get("/api/stats", headers=headers_for(2))).json())["records"] == 0


# ---------- настройки ----------

async def test_settings_defaults(client):
    data = await (await client.get("/api/settings", headers=H)).json()
    assert data["region"] is None and data["timezone"] == "Europe/Moscow" and data["subscribed"] is False
    assert data["send_time"] == "05:00"
    assert data["timezones"][0]["code"] == "Europe/Kaliningrad" and len(data["timezones"]) == 10


async def test_settings_update_all_fields_and_persist(client):
    resp = await post(client, "/api/settings", {"timezone": "Asia/Yekaterinburg", "subscribed": True, "send_time": "5.30"})
    assert resp.status == 200
    data = await resp.json()
    assert (data["timezone"], data["subscribed"], data["send_time"]) == ("Asia/Yekaterinburg", True, "05:30")
    again = await (await client.get("/api/settings", headers=H)).json()
    assert (again["timezone"], again["subscribed"], again["send_time"]) == ("Asia/Yekaterinburg", True, "05:30")
    me = await (await client.get("/api/me", headers=H)).json()
    assert me["subscribed"] is True and me["send_time"] == "05:30" and me["timezone"] == "Asia/Yekaterinburg"


async def test_settings_partial_update_leaves_others(client):
    await post(client, "/api/settings", {"subscribed": True})
    await post(client, "/api/settings", {"send_time": "06:15"})
    data = await (await client.get("/api/settings", headers=H)).json()
    assert data["subscribed"] is True and data["send_time"] == "06:15" and data["timezone"] == "Europe/Moscow"
    await post(client, "/api/settings", {"subscribed": False})
    assert (await (await client.get("/api/settings", headers=H)).json())["subscribed"] is False


async def test_settings_validation_is_atomic(client):
    for body, code in [({"timezone": "Mars/Base"}, "bad_timezone"), ({"timezone": 3}, "bad_timezone"),
                       ({"subscribed": "yes"}, "bad_subscribed"), ({"subscribed": 1}, "bad_subscribed"),
                       ({"send_time": "25:00"}, "bad_time"), ({"send_time": "ab"}, "bad_time"), ({"send_time": 5}, "bad_time")]:
        resp = await post(client, "/api/settings", body)
        assert resp.status == 400 and (await resp.json())["error"] == code, body
    # недопустимое время не должно применить допустимую подписку из того же запроса
    resp = await post(client, "/api/settings", {"subscribed": True, "send_time": "99:99"})
    assert resp.status == 400
    assert (await (await client.get("/api/settings", headers=H)).json())["subscribed"] is False


async def test_settings_reflect_region(client):
    await post(client, "/api/region", {"code": "krasnodar"})
    data = await (await client.get("/api/settings", headers=H)).json()
    assert data["region"]["code"] == "krasnodar" and data["region"]["verified"] is True


async def test_subscription_users_listed_for_scheduler(client, db):
    await post(client, "/api/settings", {"subscribed": True, "send_time": "04:45"})
    subs = await db.list_subscribers()
    assert [(s.user_id, s.send_time) for s in subs] == [(1, "04:45")]


# ---------- активность: фазан и заяц, заголовки ----------

async def test_activity_includes_pheasant_hare_and_headings(client, db):
    await db.add_place(1, "Озеро", 45.0, 38.9)
    data = await (await client.get("/api/activity", headers=H)).json()
    assert [d["label"] for d in data["days"]] == ["today", "tomorrow"]
    assert data["days"][0]["heading"].startswith("Сегодня, ") and data["days"][1]["heading"].startswith("Завтра, ")
    for day in data["days"]:
        assert [g["group"] for g in day["activity"]] == ["waterfowl", "upland", "ungulates", "pheasant", "hare"]
        titles = {g["group"]: (g["emoji"], g["title"]) for g in day["activity"]}
        assert titles["pheasant"] == ("🐓", "Фазан") and titles["hare"] == ("🐇", "Заяц")
        hare = day["activity"][4]
        assert hare["dusk"]["value"] >= hare["dawn"]["value"]
    assert "ориентировочная оценка" in data["disclaimer"]


async def test_activity_hare_porosha_from_overnight_snow(db):
    class Snowy(FakeWeather):
        async def fetch_forecast(self, http, lat, lon):
            raw = fresh_forecast()
            n = len(raw["hourly"]["time"])
            raw["hourly"]["temperature_2m"] = [-3.0] * n
            raw["hourly"]["precipitation"] = [0.0] * n
            for i in range(n):
                if raw["hourly"]["time"][i].endswith(("T00:00", "T01:00", "T02:00", "T03:00", "T04:00")):
                    raw["hourly"]["precipitation"][i] = 0.6
            return raw

    await db.add_place(1, "Поле", 45.0, 38.9)
    app = create_app(make_config(), db, None, Snowy())
    async with TestClient(TestServer(app)) as c:
        data = await (await c.get("/api/activity", headers=H)).json()
        hare = next(g for g in data["days"][1]["activity"] if g["group"] == "hare")
        assert any("пороша" in r for r in hare["dawn"]["reasons"])
        up = next(g for g in data["days"][1]["activity"] if g["group"] == "upland")
        assert not any("пороша" in r for r in up["dawn"]["reasons"])
