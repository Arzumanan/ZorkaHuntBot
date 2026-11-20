# ruff: noqa: F811
"""Согласие на обработку данных, политика, удаление данных и миграция старой БД."""
import sqlite3
from datetime import datetime

import pytest
from aiohttp.test_utils import TestClient, TestServer

from bot import policy
from bot.config import load_config
from bot.db import SCHEMA, Database
from bot.web.api import INIT_HEADER, create_app
from bot.web.auth import build_init_data
from tests.test_web_api import FakeWeather, make_config, headers_for
from tests.test_web_user_api import post

NEWBIE = headers_for(50)        # пользователь без согласия
TABLES = Database.DATA_TABLES


@pytest.fixture
async def app_client(db):
    """Приложение БЕЗ предварительного согласия."""
    app = create_app(make_config(), db, None, FakeWeather())
    async with TestClient(TestServer(app)) as c:
        yield c


async def accept(client, headers=NEWBIE, version=None):
    return await post(client, "/api/consent", {"accept": True, "version": version or policy.POLICY_VERSION}, headers)


# ---------- политика ----------

def test_policy_covers_required_points():
    p = policy.policy_payload()
    text = " ".join(" ".join(sec.get("paragraphs", []) + sec.get("items", []) + sec.get("after", []))
                    for sec in p["sections"])
    for needle in ("Telegram ID", "регион", "часовой пояс", "координаты", "журнал", "чек-лист", "рассылк",
                   "согласи", "Российской Федерации", "Open-Meteo", "за пределами РФ", "не передаём", "до удаления",
                   "Удалить мои данные", "Cloudflare"):
        assert needle.lower() in text.lower(), needle
    assert "зарегистрир" not in text.lower() and "роскомнадзор" not in text.lower()   # регистрацию не заявляем
    assert p["version"] == policy.POLICY_VERSION and p["checkbox"] and len(p["summary"]) >= 4
    assert any("Open-Meteo" in line for line in p["summary"])


def test_policy_operator_defaults_and_override():
    default = policy.policy_payload()
    assert default["operator"] == policy.DEFAULT_OPERATOR and "@ZorkaHuntBot" in default["contact"]
    custom = policy.policy_payload("Иванов И. И.", "ivanov@example.com")
    assert custom["operator"] == "Иванов И. И." and "ivanov@example.com" in custom["sections"][0]["paragraphs"][0]
    assert policy.policy_payload("  ", "")["operator"] == policy.DEFAULT_OPERATOR      # пустое → по умолчанию


def test_config_reads_policy_env(monkeypatch):
    monkeypatch.setattr("bot.config.load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("BOT_TOKEN", "1:x")
    monkeypatch.delenv("POLICY_OPERATOR", raising=False)
    monkeypatch.delenv("POLICY_CONTACT", raising=False)
    c = load_config()
    assert c.policy_operator is None and c.policy_contact is None
    monkeypatch.setenv("POLICY_OPERATOR", " ИП Петров ")
    monkeypatch.setenv("POLICY_CONTACT", "t.me/petrov")
    c = load_config()
    assert (c.policy_operator, c.policy_contact) == ("ИП Петров", "t.me/petrov")


async def test_policy_endpoint_is_public(app_client):
    resp = await app_client.get("/api/policy")                 # без initData
    assert resp.status == 200
    data = await resp.json()
    assert data["version"] == policy.POLICY_VERSION and data["sections"] and data["operator"]


async def test_policy_uses_operator_from_config(db):
    cfg = make_config()
    cfg = type(cfg)(**{**cfg.__dict__, "policy_operator": "Иванов И. И.", "policy_contact": "ivan@example.com"})
    async with TestClient(TestServer(create_app(cfg, db, None, FakeWeather()))) as c:
        data = await (await c.get("/api/policy")).json()
        assert data["operator"] == "Иванов И. И." and data["contact"] == "ivan@example.com"
        page = await (await c.get("/privacy")).text()
        assert "Иванов И. И." in page and "ivan@example.com" in page


async def test_privacy_page_is_public_html_and_escapes(db):
    cfg = make_config()
    cfg = type(cfg)(**{**cfg.__dict__, "policy_operator": "<script>alert(1)</script>"})
    async with TestClient(TestServer(create_app(cfg, db, None, FakeWeather()))) as c:
        resp = await c.get("/privacy")
        assert resp.status == 200 and resp.content_type == "text/html"
        page = await resp.text()
        assert "<script>alert(1)</script>" not in page and "&lt;script&gt;" in page
        assert "Open-Meteo" in page and "Политика конфиденциальности" in page and "<script" not in page


# ---------- /api/me до и после согласия ----------

async def test_me_before_consent_is_minimal(app_client):
    data = await (await app_client.get("/api/me", headers=NEWBIE)).json()
    assert data == {"user_id": 50, "consent": {"accepted": False, "version": policy.POLICY_VERSION,
                                                "accepted_version": None, "accepted_at": None}}


async def test_me_before_consent_does_not_leak_stored_data(app_client, db):
    await db.add_place(50, "Озеро", 1.0, 2.0)
    await db.set_region(50, "krasnodar")
    data = await (await app_client.get("/api/me", headers=NEWBIE)).json()
    assert "places" not in data and "region" not in data and "location" not in data


async def test_me_after_consent_has_full_profile_and_consent_info(app_client):
    await accept(app_client)
    data = await (await app_client.get("/api/me", headers=NEWBIE)).json()
    assert data["consent"]["accepted"] is True and data["consent"]["accepted_version"] == policy.POLICY_VERSION
    assert data["places"] == [] and data["timezone"] == "Europe/Moscow"
    datetime.fromisoformat(data["consent"]["accepted_at"])


# ---------- блокировка без согласия ----------

GATED_GET = ["/api/forecast", "/api/activity", "/api/seasons", "/api/checklist", "/api/places", "/api/journal",
             "/api/stats", "/api/settings", "/api/forecast?place_id=cur"]
GATED_POST = [("/api/region", {"code": "krasnodar"}), ("/api/location", {"city": "Майкоп"}),
              ("/api/location", {"lat": 1, "lon": 2}), ("/api/checklist/type", {"hunt_type": "upland"}),
              ("/api/checklist/toggle", {"id": 1}), ("/api/checklist/add", {"category": "gun", "text": "x"}),
              ("/api/checklist/delete", {"id": 1}), ("/api/checklist/reset", {}), ("/api/places", {"city": "Майкоп"}),
              ("/api/places/update", {"id": 1, "name": "x"}), ("/api/places/delete", {"id": 1}),
              ("/api/journal", {"date": "2026-10-01", "place": "x", "species": "y"}), ("/api/journal/delete", {"id": 1}),
              ("/api/settings", {"subscribed": True})]


@pytest.mark.parametrize("path", GATED_GET)
async def test_reads_blocked_without_consent(app_client, path):
    resp = await app_client.get(path, headers=NEWBIE)
    assert resp.status == 403 and (await resp.json())["error"] == "consent_required"


@pytest.mark.parametrize("path,body", GATED_POST)
async def test_writes_blocked_without_consent(app_client, db, path, body):
    resp = await post(app_client, path, body, NEWBIE)
    assert resp.status == 403 and (await resp.json())["error"] == "consent_required"
    for table in TABLES:                         # ничего не записано
        async with db.conn.execute(f"SELECT COUNT(*) AS n FROM {table} WHERE user_id=50") as cur:
            assert (await cur.fetchone())["n"] == 0, table


async def test_blocked_requests_do_not_call_weather(app_client, db):
    await db.add_place(50, "Озеро", 1.0, 2.0)
    app_client.app["weather"].forecast_calls = []
    await app_client.get("/api/forecast", headers=NEWBIE)
    await app_client.get("/api/checklist", headers=NEWBIE)
    assert app_client.app["weather"].forecast_calls == []     # координаты за границу без согласия не уходят


async def test_blocked_checklist_read_does_not_seed_rows(app_client, db):
    await app_client.get("/api/checklist", headers=NEWBIE)
    async with db.conn.execute("SELECT COUNT(*) AS n FROM checklist_items") as cur:
        assert (await cur.fetchone())["n"] == 0


async def test_regions_reference_works_without_consent(app_client):
    resp = await app_client.get("/api/regions", headers=NEWBIE)
    assert resp.status == 200 and (await resp.json())[0]["code"] == "krasnodar"


async def test_unauthenticated_is_401_not_403(app_client):
    assert (await app_client.get("/api/places")).status == 401
    assert (await app_client.post("/api/consent", json={"accept": True, "version": policy.POLICY_VERSION})).status == 401


async def test_dev_mode_user_is_also_gated(db):
    app = create_app(make_config(dev_user=777), db, None, FakeWeather())
    async with TestClient(TestServer(app)) as c:
        assert (await c.get("/api/places")).status == 403
        assert (await post(c, "/api/consent", {"accept": True, "version": policy.POLICY_VERSION}, {})).status == 200
        assert (await c.get("/api/places")).status == 200


# ---------- принятие ----------

async def test_accept_stores_version_and_timestamp_and_unlocks(app_client, db):
    resp = await accept(app_client)
    assert resp.status == 200 and (await resp.json())["consent"]["accepted"] is True
    stored = await db.get_consent(50)
    assert stored.policy_version == policy.POLICY_VERSION
    assert abs((datetime.now().astimezone() - datetime.fromisoformat(stored.accepted_at)).total_seconds()) < 60
    assert (await app_client.get("/api/places", headers=NEWBIE)).status == 200
    assert (await post(app_client, "/api/region", {"code": "krasnodar"}, NEWBIE)).status == 200


@pytest.mark.parametrize("body", [{}, {"accept": False, "version": policy.POLICY_VERSION}, {"accept": "yes", "version": policy.POLICY_VERSION},
                                  {"version": policy.POLICY_VERSION}, {"accept": 1, "version": policy.POLICY_VERSION}])
async def test_accept_requires_explicit_true(app_client, db, body):
    resp = await post(app_client, "/api/consent", body, NEWBIE)
    assert resp.status == 400
    assert await db.get_consent(50) is None


async def test_accept_rejects_stale_version(app_client, db):
    resp = await accept(app_client, version="1999-01-01")
    assert resp.status == 409 and (await resp.json())["error"] == "version_mismatch"
    assert await db.get_consent(50) is None
    assert (await post(app_client, "/api/consent", {"accept": True}, NEWBIE)).status == 409      # версия не указана


async def test_consent_is_per_user(app_client):
    await accept(app_client, headers=headers_for(51))
    assert (await app_client.get("/api/places", headers=headers_for(51))).status == 200
    assert (await app_client.get("/api/places", headers=headers_for(52))).status == 403


async def test_accept_twice_is_idempotent_and_updates_timestamp(app_client, db):
    await accept(app_client)
    first = await db.get_consent(50)
    await accept(app_client)
    second = await db.get_consent(50)
    assert second.policy_version == first.policy_version and second.accepted_at >= first.accepted_at
    async with db.conn.execute("SELECT COUNT(*) AS n FROM consents WHERE user_id=50") as cur:
        assert (await cur.fetchone())["n"] == 1


# ---------- новая версия политики ----------

async def test_bumping_policy_version_reasks(app_client, monkeypatch):
    await accept(app_client)
    assert (await app_client.get("/api/places", headers=NEWBIE)).status == 200
    monkeypatch.setattr(policy, "POLICY_VERSION", "2099-01-01")
    me = await (await app_client.get("/api/me", headers=NEWBIE)).json()
    assert me["consent"]["accepted"] is False and me["consent"]["version"] == "2099-01-01"
    assert me["consent"]["accepted_version"] == policy.POLICY_VERSION.replace("2099-01-01", "2026-11-20")
    assert (await app_client.get("/api/places", headers=NEWBIE)).status == 403
    assert (await app_client.get("/api/policy")).status == 200
    assert (await accept(app_client, version="2026-11-20")).status == 409      # старую версию принять уже нельзя
    assert (await accept(app_client, version="2099-01-01")).status == 200
    assert (await app_client.get("/api/places", headers=NEWBIE)).status == 200


async def test_bumped_version_keeps_user_data(app_client, db, monkeypatch):
    await accept(app_client)
    await post(app_client, "/api/places", {"lat": 1, "lon": 2, "name": "Моё"}, NEWBIE)
    monkeypatch.setattr(policy, "POLICY_VERSION", "2099-01-01")
    assert len(await db.list_places(50)) == 1          # данные не стираются, просто закрыты до нового согласия


# ---------- удаление данных ----------

async def fill_user(db, uid):
    await db.set_consent(uid, policy.POLICY_VERSION)
    await db.set_location(uid, 1.0, 2.0, "Город")
    await db.add_trophy(uid, "2026-10-01", "Лес", "Кабан", "заметка")
    await db.set_region(uid, "krasnodar")
    await db.set_subscribed(uid, True)
    await db.add_place(uid, "Озеро", 3.0, 4.0)
    await db.seed_checklist(uid, "general", [("gun", "gun", "Ружьё")])
    await db.add_custom_item(uid, "general", "food", "Термос")


async def count(db, table, uid):
    async with db.conn.execute(f"SELECT COUNT(*) AS n FROM {table} WHERE user_id=?", (uid,)) as cur:
        return (await cur.fetchone())["n"]


async def test_account_delete_wipes_every_table_and_only_that_user(app_client, db):
    await fill_user(db, 50)
    await fill_user(db, 51)
    for table in TABLES:
        assert await count(db, table, 50) >= 1, table             # проверяем, что тест заполнил все таблицы
    resp = await post(app_client, "/api/account/delete", {}, NEWBIE)
    assert resp.status == 200
    body = await resp.json()
    assert body["ok"] is True and set(body["removed"]) == set(TABLES)
    for table in TABLES:
        assert await count(db, table, 50) == 0, table
        assert await count(db, table, 51) >= 1, table             # данные другого пользователя целы


async def test_delete_revokes_consent_and_blocks_api_again(app_client, db):
    await fill_user(db, 50)
    assert (await app_client.get("/api/journal", headers=NEWBIE)).status == 200
    await post(app_client, "/api/account/delete", {}, NEWBIE)
    assert (await app_client.get("/api/journal", headers=NEWBIE)).status == 403
    me = await (await app_client.get("/api/me", headers=NEWBIE)).json()
    assert me["consent"]["accepted"] is False and "places" not in me
    assert await db.list_subscribers() == []                       # рассылка тоже прекращена


async def test_after_delete_user_starts_clean(app_client, db):
    await fill_user(db, 50)
    await post(app_client, "/api/account/delete", {}, NEWBIE)
    await accept(app_client)
    assert (await (await app_client.get("/api/journal", headers=NEWBIE)).json())["records"] == []
    assert (await (await app_client.get("/api/places", headers=NEWBIE)).json())["places"] == []
    assert (await (await app_client.get("/api/settings", headers=NEWBIE)).json())["region"] is None


async def test_delete_works_without_consent_and_is_idempotent(app_client, db):
    await db.add_place(50, "Старое угодье", 1.0, 2.0)               # данные есть, согласия нет (старый пользователь)
    assert (await post(app_client, "/api/account/delete", {}, NEWBIE)).status == 200
    assert await count(db, "places", 50) == 0
    resp = await post(app_client, "/api/account/delete", {}, NEWBIE)
    assert resp.status == 200 and all(v == 0 for v in (await resp.json())["removed"].values())


async def test_delete_requires_auth(app_client, db):
    await fill_user(db, 50)
    assert (await app_client.post("/api/account/delete", json={})).status == 401
    assert (await app_client.post("/api/account/delete", json={}, headers={INIT_HEADER: build_init_data("9:x", {"id": 50})})).status == 401
    assert await count(db, "places", 50) == 1


async def test_delete_only_touches_authenticated_user_even_if_body_has_other_id(app_client, db):
    await fill_user(db, 50)
    await fill_user(db, 51)
    await post(app_client, "/api/account/delete", {"user_id": 51}, NEWBIE)
    assert await count(db, "places", 51) == 1 and await count(db, "places", 50) == 0


async def test_db_delete_user_data_counts(db):
    await fill_user(db, 7)
    removed = await db.delete_user_data(7)
    assert removed["places"] == 1 and removed["trophies"] == 1 and removed["checklist_items"] == 2
    assert removed["consents"] == 1 and removed["user_settings"] == 1 and removed["users"] == 1
    assert await db.get_consent(7) is None and await db.get_location(7) is None


async def test_set_consent_upsert(db):
    await db.set_consent(1, "v1", "2026-01-01T00:00:00+00:00")
    await db.set_consent(1, "v2", "2026-02-01T00:00:00+00:00")
    c = await db.get_consent(1)
    assert (c.policy_version, c.accepted_at) == ("v2", "2026-02-01T00:00:00+00:00")
    assert await db.has_consent(1, "v2") and not await db.has_consent(1, "v1") and not await db.has_consent(2, "v2")


# ---------- миграция старой БД (до появления согласия) ----------

def make_legacy_db(path):
    """БД в схеме до этой версии: без таблицы consents, с данными реальных пользователей."""
    old_schema = ";".join(part for part in SCHEMA.split(";") if "consents" not in part)
    con = sqlite3.connect(path)
    con.executescript(old_schema)
    con.execute("INSERT INTO users VALUES (900, 45.0, 38.9, 'Краснодар')")
    con.execute("INSERT INTO user_settings(user_id, region_code, timezone, subscribed, send_time, hunt_type) "
                "VALUES (900, 'krasnodar', 'Europe/Moscow', 1, '05:30', 'waterfowl')")
    con.execute("INSERT INTO places(user_id, name, latitude, longitude, is_default) VALUES (900, 'Старое озеро', 45.1, 38.8, 1)")
    con.execute("INSERT INTO trophies(user_id, hunt_date, place, species, note) VALUES (900, '2026-10-03', 'Озеро', 'Кряква', 'старая запись')")
    con.execute("INSERT INTO checklist_items(user_id, hunt_type, category, key, text, checked, custom) "
                "VALUES (900, 'waterfowl', 'gun', 'gun', 'Ружьё', 1, 0)")
    con.commit()
    con.close()


async def test_legacy_db_gets_consents_table_and_keeps_data(tmp_path):
    path = str(tmp_path / "legacy.db")
    make_legacy_db(path)
    con = sqlite3.connect(path)
    assert "consents" not in {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    con.close()
    db = Database(path)
    await db.connect()                                  # миграция: CREATE TABLE IF NOT EXISTS consents
    try:
        assert await db.get_consent(900) is None        # старый пользователь согласия не давал
        assert not await db.has_consent(900, policy.POLICY_VERSION)
        assert [p.name for p in await db.list_places(900)] == ["Старое озеро"]
        assert [t.species for t in await db.list_trophies(900)] == ["Кряква"]
        assert (await db.get_settings(900)).send_time == "05:30" and (await db.get_settings(900)).subscribed is True
        assert [i.checked for i in await db.list_checklist(900, "waterfowl")] == [True]
        assert (await db.get_location(900)).place == "Краснодар"
    finally:
        await db.close()


async def test_legacy_user_is_asked_then_sees_all_old_data(tmp_path):
    path = str(tmp_path / "legacy.db")
    make_legacy_db(path)
    db = Database(path)
    await db.connect()
    try:
        app = create_app(make_config(), db, None, FakeWeather())
        h = headers_for(900)
        async with TestClient(TestServer(app)) as c:
            me = await (await c.get("/api/me", headers=h)).json()
            assert me["consent"]["accepted"] is False and "places" not in me      # спрашиваем согласие
            assert (await c.get("/api/journal", headers=h)).status == 403
            assert (await accept(c, headers=h)).status == 200
            me = await (await c.get("/api/me", headers=h)).json()
            assert me["region"]["code"] == "krasnodar" and me["places"][0]["name"] == "Старое озеро"
            assert me["subscribed"] is True and me["hunt_type"] == "waterfowl"
            journal = await (await c.get("/api/journal", headers=h)).json()
            assert journal["records"][0]["note"] == "старая запись"
            cl = await (await c.get("/api/checklist", headers=h)).json()
            assert cl["hunt_type"] == "waterfowl" and cl["done"] == 1
    finally:
        await db.close()


async def test_connect_twice_does_not_lose_consent(tmp_path):
    path = str(tmp_path / "again.db")
    db = Database(path)
    await db.connect()
    await db.set_consent(5, policy.POLICY_VERSION)
    await db.close()
    db = Database(path)
    await db.connect()
    try:
        assert await db.has_consent(5, policy.POLICY_VERSION)
    finally:
        await db.close()


# ---------- тексты-оговорки в интерфейсе ----------

REF_NOTE = "Информация справочная. Перед выездом сверяйтесь с указом главы вашего региона и региональным охотуправлением."


async def test_frontend_has_disclaimers_consent_and_delete_ui(app_client):
    seasons = await (await app_client.get("/static/seasons.js")).text()
    assert REF_NOTE in seasons
    weather = await (await app_client.get("/static/weather.js")).text()
    assert "Оценка по правилам, а не гарантия." in weather and "activity_disclaimer" in weather
    consent = await (await app_client.get("/static/consent.js")).text()
    assert "/api/consent" in consent and "/api/account/delete" in consent and "Принимаю" in consent
    more = await (await app_client.get("/static/more.js")).text()
    assert "Удалить мои данные" in more and "Политика конфиденциальности" in more
    index = await (await app_client.get("/")).text()
    assert "/static/consent.js" in index


async def test_start_text_has_one_line_privacy_note():
    from tests.test_webapp_bot import Harness

    sent = await Harness().say("/start")
    lines = [ln for ln in sent[0].text.split("\n") if "согласи" in ln]
    assert len(lines) == 1 and "политика и согласие внутри" in lines[0]
