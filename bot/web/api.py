"""JSON API и статика Mini App (aiohttp)."""
from __future__ import annotations

import logging
import re

import aiohttp
from aiohttp import web

from .. import policy
from ..config import BASE_DIR, Config
from ..db import Database
from ..services import weather as weather_service
from ..services.seasons import get_region, is_verified, load_regions, seasons_payload
from .auth import InitDataError, validate_init_data
from .helpers import (
    CITY_MAX, NO_PLACE, forecast_raw, get_db, get_weather, json_error, place_dict, read_json, user_today,
    valid_coord,
)
from .payloads import forecast_payload
from . import routes_user

log = logging.getLogger(__name__)

WEBAPP_DIR = BASE_DIR / "webapp"
INIT_HEADER = "X-Telegram-Init-Data"
PUBLIC_API = {"/api/policy"}      # без входа через Telegram: текст политики должен читаться всегда
# Работают без согласия: статус согласия (/me отдаёт урезанный ответ), принятие, список регионов (общий справочник)
# и удаление данных (право пользователя). Всё остальное требует согласия.
CONSENT_EXEMPT_API = {"/api/me", "/api/consent", "/api/regions", "/api/account/delete"}


# ---------- middleware ----------

@web.middleware
async def auth_middleware(request: web.Request, handler):
    if not request.path.startswith("/api/") or request.path in PUBLIC_API:
        return await handler(request)
    config: Config = request.app["config"]
    init_data = request.headers.get(INIT_HEADER, "")
    if init_data:
        try:
            request["user_id"] = validate_init_data(init_data, config.bot_token).id
        except InitDataError as exc:
            log.info("initData отклонена: %s", exc)
            return json_error(401, "unauthorized", "Не удалось проверить данные Telegram. Откройте Mini App из бота.")
    elif config.webapp_dev_user_id is not None:
        request["user_id"] = config.webapp_dev_user_id      # режим разработки
    else:
        return json_error(401, "unauthorized", "Откройте Mini App из Telegram.")
    # без согласия на текущую версию политики персональные данные не читаем и не пишем
    if request.path not in CONSENT_EXEMPT_API and not await get_db(request).has_consent(
            request["user_id"], policy.POLICY_VERSION):
        return json_error(403, "consent_required", "Нужно принять политику конфиденциальности.")
    return await handler(request)


@web.middleware
async def cors_middleware(request: web.Request, handler):
    origin = request.app["config"].webapp_cors_origin
    if not origin:
        return await handler(request)
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        resp = await handler(request)
    resp.headers["Access-Control-Allow-Origin"] = origin
    resp.headers["Access-Control-Allow-Headers"] = f"Content-Type, {INIT_HEADER}"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


@web.middleware
async def error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except weather_service.WeatherError:
        return json_error(502, "weather_unavailable", "Сервис погоды недоступен, попробуйте чуть позже.")
    except Exception:
        log.exception("Ошибка API")
        return json_error(500, "internal", "Внутренняя ошибка.")


# ---------- helpers ----------

# ---------- handlers ----------

async def health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


def _consent_json(consent) -> dict:
    ok = consent is not None and consent.policy_version == policy.POLICY_VERSION
    return {
        "accepted": ok,
        "version": policy.POLICY_VERSION,                          # текущая версия политики
        "accepted_version": consent.policy_version if consent else None,
        "accepted_at": consent.accepted_at if consent else None,
    }


async def me(request: web.Request) -> web.Response:
    db, uid = get_db(request), request["user_id"]
    consent = _consent_json(await db.get_consent(uid))
    if not consent["accepted"]:      # до согласия личные данные не отдаём
        return web.json_response({"user_id": uid, "consent": consent})
    settings = await db.get_settings(uid)
    region = get_region(settings.region_code)
    places = await db.list_places(uid)
    loc = await db.get_location(uid)
    return web.json_response({
        "user_id": uid,
        "consent": consent,
        "region": ({"code": region.code, "name": region.name, "verified": is_verified(region.code)} if region else None),
        "timezone": settings.timezone,
        "subscribed": settings.subscribed,
        "send_time": settings.send_time,
        "hunt_type": settings.hunt_type,
        "places": [{"id": p.id, "key": f"p{p.id}", "name": p.name, "lat": p.latitude, "lon": p.longitude,
                    "is_default": p.is_default} for p in places],
        "location": ({"lat": loc.latitude, "lon": loc.longitude, "name": loc.place} if loc else None),
        "has_place": bool(places or loc),
    })


def _policy(request: web.Request) -> dict:
    config: Config = request.app["config"]
    return policy.policy_payload(config.policy_operator, config.policy_contact)


async def policy_get(request: web.Request) -> web.Response:
    return web.json_response(_policy(request))


async def privacy_page(request: web.Request) -> web.Response:
    return web.Response(text=policy.render_policy_html(_policy(request)), content_type="text/html",
                        headers={"Cache-Control": "no-cache"})


async def consent_accept(request: web.Request) -> web.Response:
    data = await read_json(request)
    if data.get("accept") is not True:
        return json_error(400, "bad_request", "Нужно явное согласие.")
    if data.get("version") != policy.POLICY_VERSION:     # устаревшая страница не может принять новую политику
        return json_error(409, "version_mismatch", "Политика обновилась. Закройте и откройте приложение заново.")
    consent = await get_db(request).set_consent(request["user_id"], policy.POLICY_VERSION)
    return web.json_response({"ok": True, "consent": _consent_json(consent)})


async def account_delete(request: web.Request) -> web.Response:
    """Право на удаление: стираем все данные пользователя, включая согласие. Не требует согласия."""
    removed = await get_db(request).delete_user_data(request["user_id"])
    log.info("Данные пользователя %s удалены по его запросу", request["user_id"])
    return web.json_response({"ok": True, "removed": removed})


async def forecast(request: web.Request) -> web.Response:
    spot, raw = await forecast_raw(request)
    if spot is None:
        return json_error(409, *NO_PLACE)
    return web.json_response(forecast_payload(raw, place_dict(spot)))


async def activity(request: web.Request) -> web.Response:
    spot, raw = await forecast_raw(request)
    if spot is None:
        return json_error(409, *NO_PLACE)
    payload = forecast_payload(raw, place_dict(spot))
    slim = [{"date": d["date"], "title": d["title"], "label": d["label"], "heading": d["heading"], "moon": d["moon"],
             "sunrise": d["sunrise"], "sunset": d["sunset"], "activity": d["activity"]} for d in payload["days"]]
    return web.json_response({"place": payload["place"], "days": slim, "disclaimer": payload["activity_disclaimer"]})


async def seasons(request: web.Request) -> web.Response:
    settings = await get_db(request).get_settings(request["user_id"])
    if get_region(settings.region_code) is None:
        return json_error(409, "no_region", "Сначала выберите регион.")
    return web.json_response(seasons_payload(settings.region_code, await user_today(request)))


async def regions(request: web.Request) -> web.Response:
    return web.json_response([{"code": r.code, "name": r.name, "verified": is_verified(r.code)}
                              for r in load_regions()])


async def set_region(request: web.Request) -> web.Response:
    data = await read_json(request)
    region = get_region(str(data.get("code", "")))
    if region is None:
        return json_error(400, "unknown_region", "Такого региона нет в списке.")
    await get_db(request).set_region(request["user_id"], region.code)
    return web.json_response({"ok": True, "region": {"code": region.code, "name": region.name,
                                                     "verified": is_verified(region.code)}})


async def set_location(request: web.Request) -> web.Response:
    data = await read_json(request)
    db, uid = get_db(request), request["user_id"]
    if "lat" in data or "lon" in data:
        lat, lon = valid_coord(data.get("lat"), -90, 90), valid_coord(data.get("lon"), -180, 180)
        if lat is None or lon is None:
            return json_error(400, "bad_coordinates", "Некорректные координаты.")
        name = str(data.get("name") or "по координатам")[:80]
    else:
        city = re.sub(r"\s+", " ", str(data.get("city", ""))).strip()
        if not city or len(city) > CITY_MAX:
            return json_error(400, "bad_city", "Введите название города.")
        place = await get_weather(request).geocode_city(request.app["http"], city)
        if place is None:
            return json_error(404, "city_not_found", "Не нашёл такой город. Проверьте написание.")
        lat, lon, name = place.latitude, place.longitude, place.title
    await db.set_location(uid, lat, lon, name)
    return web.json_response({"ok": True, "location": {"lat": lat, "lon": lon, "name": name}})


# ---------- static ----------

async def index(request: web.Request) -> web.StreamResponse:
    return web.FileResponse(WEBAPP_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@web.middleware
async def no_cache_static(request: web.Request, handler):
    resp = await handler(request)
    if request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


class _Weather:
    """Обёртка над сетевыми функциями погоды — в тестах подменяется."""
    fetch_forecast = staticmethod(weather_service.fetch_forecast)
    geocode_city = staticmethod(weather_service.geocode_city)


def create_app(config: Config, db: Database, http: aiohttp.ClientSession, weather=None) -> web.Application:
    app = web.Application(middlewares=[cors_middleware, error_middleware, auth_middleware, no_cache_static])
    app["config"], app["db"], app["http"] = config, db, http
    app["weather"] = weather or _Weather
    app.router.add_get("/", index)
    app.router.add_get("/healthz", health)
    app.router.add_get("/api/me", me)
    app.router.add_get("/api/policy", policy_get)
    app.router.add_get("/privacy", privacy_page)
    app.router.add_post("/api/consent", consent_accept)
    app.router.add_post("/api/account/delete", account_delete)
    app.router.add_get("/api/forecast", forecast)
    app.router.add_get("/api/activity", activity)
    app.router.add_get("/api/seasons", seasons)
    app.router.add_get("/api/regions", regions)
    app.router.add_post("/api/region", set_region)
    app.router.add_post("/api/location", set_location)
    routes_user.register(app)
    app.router.add_static("/static/", WEBAPP_DIR, show_index=False)
    return app


async def start_web_server(config: Config, db: Database, http: aiohttp.ClientSession) -> web.AppRunner:
    runner = web.AppRunner(create_app(config, db, http))
    await runner.setup()
    site = web.TCPSite(runner, config.webapp_host, config.webapp_port)
    await site.start()
    log.info("Mini App: http://%s:%s/ (dev-режим: %s)", config.webapp_host, config.webapp_port,
             "ВКЛ" if config.webapp_dev_user_id is not None else "выкл")
    return runner
