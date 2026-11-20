"""Временный перенос из старой базы: /api/legacy-export и /api/legacy-export/done."""
import sqlite3

import pytest
from aiohttp.test_utils import TestClient, TestServer

from bot import legacy
from bot.config import Config
from bot.web.auth import build_init_data
from bot.web.server import INIT_HEADER, create_app

TOKEN = "123456:TEST-TOKEN"
ORIGIN = "https://arzumanan.github.io"

# схема старой версии (с таблицей согласий) — как в zorka.db на ПК автора
OLD_SCHEMA = """
CREATE TABLE users (user_id INTEGER PRIMARY KEY, latitude REAL NOT NULL, longitude REAL NOT NULL, place TEXT);
CREATE TABLE trophies (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, hunt_date TEXT NOT NULL,
                       place TEXT NOT NULL, species TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE TABLE user_settings (user_id INTEGER PRIMARY KEY, region_code TEXT, timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
                            subscribed INTEGER NOT NULL DEFAULT 0, send_time TEXT NOT NULL DEFAULT '05:00', last_sent TEXT,
                            hunt_type TEXT NOT NULL DEFAULT 'general');
CREATE TABLE places (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
                     latitude REAL NOT NULL, longitude REAL NOT NULL, is_default INTEGER NOT NULL DEFAULT 0);
CREATE TABLE checklist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, hunt_type TEXT NOT NULL,
                              category TEXT NOT NULL, key TEXT, text TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0,
                              custom INTEGER NOT NULL DEFAULT 0);
CREATE TABLE consents (user_id INTEGER PRIMARY KEY, policy_version TEXT NOT NULL, accepted_at TEXT NOT NULL);
"""


def fill(path, uid, tag=""):
    con = sqlite3.connect(path)
    con.execute("INSERT INTO users VALUES (?, 45.0, 38.9, ?)", (uid, "Краснодар" + tag))
    con.execute("INSERT INTO user_settings(user_id, region_code, timezone, subscribed, send_time, hunt_type) "
                "VALUES (?, 'krasnodar', 'Europe/Moscow', 1, '05:30', 'waterfowl')", (uid,))
    con.execute("INSERT INTO places(user_id, name, latitude, longitude, is_default) VALUES (?, ?, 45.1, 38.8, 1)", (uid, "Озеро" + tag))
    con.execute("INSERT INTO trophies(user_id, hunt_date, place, species, note) VALUES (?, '2026-10-03', 'Озеро', 'Кряква', 'заметка')", (uid,))
    con.execute("INSERT INTO checklist_items(user_id, hunt_type, category, key, text, checked, custom) "
                "VALUES (?, 'waterfowl', 'gun', 'gun', 'Ружьё', 1, 0)", (uid,))
    con.execute("INSERT INTO checklist_items(user_id, hunt_type, category, key, text, checked, custom) "
                "VALUES (?, 'waterfowl', 'food', NULL, 'Термос', 0, 1)", (uid,))
    con.execute("INSERT INTO consents VALUES (?, '2026-11-20', '2026-11-20T10:00:00+00:00')", (uid,))
    con.commit()
    con.close()


@pytest.fixture
def db_path(tmp_path):
    path = str(tmp_path / "zorka.db")
    con = sqlite3.connect(path)
    con.executescript(OLD_SCHEMA)
    con.close()
    fill(path, 100, "-A")
    fill(path, 200, "-B")
    return path


def headers(uid):
    return {INIT_HEADER: build_init_data(TOKEN, {"id": uid, "first_name": "T"})}


def make_client(db_path, **kw):
    return TestClient(TestServer(create_app(Config(bot_token=TOKEN, db_path=db_path, **kw))))


def count(path, table, uid):
    con = sqlite3.connect(path)
    try:
        return con.execute(f"SELECT COUNT(*) FROM {table} WHERE user_id=?", (uid,)).fetchone()[0]
    finally:
        con.close()


async def test_export_returns_only_this_users_data(db_path):
    async with make_client(db_path) as c:
        resp = await c.get("/api/legacy-export", headers=headers(100))
        assert resp.status == 200 and resp.headers["Cache-Control"] == "no-store"
        data = await resp.json()
    assert data["user_id"] == 100
    assert data["settings"] == {"region_code": "krasnodar", "timezone": "Europe/Moscow", "hunt_type": "waterfowl"}
    assert data["location"] == {"lat": 45.0, "lon": 38.9, "place": "Краснодар-A"}
    assert [p["name"] for p in data["places"]] == ["Озеро-A"] and data["places"][0]["is_default"] is True
    assert data["trophies"][0] == {"id": 1, "date": "2026-10-03", "place": "Озеро", "species": "Кряква", "note": "заметка"}
    assert [(i["key"], i["checked"], i["custom"]) for i in data["checklist"]] == [("gun", True, False), (None, False, True)]
    assert "B" not in str(data)                      # данные второго пользователя не утекают


async def test_export_requires_valid_init_data(db_path):
    async with make_client(db_path) as c:
        assert (await c.get("/api/legacy-export")).status == 401
        assert (await c.get("/api/legacy-export", headers={INIT_HEADER: "hash=bad"})).status == 401
        forged = {INIT_HEADER: build_init_data("999:OTHER-TOKEN", {"id": 100})}
        assert (await c.get("/api/legacy-export", headers=forged)).status == 401
        assert (await c.post("/api/legacy-export/done")).status == 401
    assert count(db_path, "places", 100) == 1         # ничего не удалено


async def test_no_dev_mode_bypass(db_path):
    async with make_client(db_path) as c:
        assert (await c.get("/api/legacy-export?user_id=100")).status == 401


async def test_missing_database_is_404_and_not_created(tmp_path):
    path = str(tmp_path / "nope.db")
    async with make_client(path) as c:
        resp = await c.get("/api/legacy-export", headers=headers(100))
        assert resp.status == 404 and (await resp.json())["error"] == "no_legacy_db"
        resp = await c.post("/api/legacy-export/done", headers=headers(100))
        assert resp.status == 404 and (await resp.json())["error"] == "no_legacy_db"
    import os
    assert not os.path.exists(path)


async def test_unknown_user_is_404_no_data(db_path):
    async with make_client(db_path) as c:
        resp = await c.get("/api/legacy-export", headers=headers(999))
        assert resp.status == 404 and (await resp.json())["error"] == "no_legacy_data"


async def test_done_deletes_only_this_users_rows_in_every_table(db_path):
    tables = legacy.TABLES
    async with make_client(db_path) as c:
        resp = await c.post("/api/legacy-export/done", headers=headers(100))
        assert resp.status == 200
        body = await resp.json()
        assert body["ok"] is True and set(body["removed"]) == set(tables) and body["removed"]["checklist_items"] == 2
        for t in tables:
            assert count(db_path, t, 100) == 0, t
            assert count(db_path, t, 200) >= 1, t
        again = await c.post("/api/legacy-export/done", headers=headers(100))      # повтор безопасен
        assert again.status == 404 and (await again.json())["error"] == "no_legacy_data"
        assert (await c.get("/api/legacy-export", headers=headers(100))).status == 404
        assert (await c.get("/api/legacy-export", headers=headers(200))).status == 200


async def test_done_vacuums_so_deleted_text_is_gone_from_file(db_path):
    async with make_client(db_path) as c:
        await c.post("/api/legacy-export/done", headers=headers(100))
        await c.post("/api/legacy-export/done", headers=headers(200))
    raw = open(db_path, "rb").read()
    assert "Озеро".encode() not in raw and "Кряква".encode() not in raw


async def test_old_schema_without_consents_table_still_works(tmp_path):
    path = str(tmp_path / "old.db")
    con = sqlite3.connect(path)
    con.executescript(OLD_SCHEMA.replace("CREATE TABLE consents (user_id INTEGER PRIMARY KEY, policy_version TEXT NOT NULL, accepted_at TEXT NOT NULL);", ""))
    con.close()
    fill_no_consent = sqlite3.connect(path)
    fill_no_consent.execute("INSERT INTO places(user_id, name, latitude, longitude, is_default) VALUES (5, 'П', 1, 2, 1)")
    fill_no_consent.commit()
    fill_no_consent.close()
    async with make_client(path) as c:
        data = await (await c.get("/api/legacy-export", headers=headers(5))).json()
        assert data["places"][0]["name"] == "П" and data["settings"] is None and data["location"] is None
        assert (await c.post("/api/legacy-export/done", headers=headers(5))).status == 200


# ---------- CORS и остальные маршруты ----------

async def test_cors_headers_only_when_origin_configured(db_path):
    async with make_client(db_path) as c:
        resp = await c.get("/api/legacy-export", headers=headers(100))
        assert "Access-Control-Allow-Origin" not in resp.headers
    async with make_client(db_path, webapp_cors_origin=ORIGIN) as c:
        resp = await c.get("/api/legacy-export", headers=headers(100))
        assert resp.headers["Access-Control-Allow-Origin"] == ORIGIN
        pre = await c.options("/api/legacy-export", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "GET",
                                                              "Access-Control-Request-Headers": INIT_HEADER})
        assert pre.status == 204 and INIT_HEADER in pre.headers["Access-Control-Allow-Headers"]
        assert pre.headers["Access-Control-Allow-Origin"] == ORIGIN
        index = await c.get("/")
        assert "Access-Control-Allow-Origin" not in index.headers      # статике CORS не нужен


async def test_personal_data_api_is_gone(db_path):
    async with make_client(db_path) as c:
        for method, path in [("GET", "/api/me"), ("GET", "/api/places"), ("POST", "/api/journal"),
                             ("POST", "/api/consent"), ("GET", "/api/policy"), ("POST", "/api/account/delete")]:
            resp = await c.request(method, path, headers=headers(100))
            assert resp.status == 404 and (await resp.json())["error"] == "not_found", path
        assert (await c.get("/privacy")).status == 404
    assert count(db_path, "places", 100) == 1
