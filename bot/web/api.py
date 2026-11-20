"""JSON API и статика Mini App (aiohttp)."""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

import aiohttp
from aiohttp import web

from ..config import BASE_DIR, Config
from ..db import Database
from ..services import weather as weather_service
from ..services.locations import Spot, list_spots, pick_spot
from ..services.seasons import get_region, is_verified, load_regions, seasons_payload
from ..services.subscription import local_now
from .auth import InitDataError, validate_init_data
from .payloads import forecast_payload

log = logging.getLogger(__name__)

WEBAPP_DIR = BASE_DIR / "webapp"
INIT_HEADER = "X-Telegram-Init-Data"
CITY_MAX = 80


def json_error(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": code, "message": message}, status=status)


# ---------- middleware ----------

@web.middleware
async def auth_middleware(request: web.Request, handler):
    if not request.path.startswith("/api/"):
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

def _db(request) -> Database:
    return request.app["db"]


def _weather(request):
    return request.app["weather"]


async def _resolve_spot(request: web.Request) -> Spot | None:
    spots = await list_spots(_db(request), request["user_id"])
    key = request.query.get("place_id")
    if key and key != "cur" and key.isdigit():
        key = f"p{key}"
    return pick_spot(spots, key or None)


async def _user_today(request: web.Request):
    settings = await _db(request).get_settings(request["user_id"])
    return local_now(datetime.now(timezone.utc), settings.timezone).date()


async def _forecast_raw(request: web.Request):
    spot = await _resolve_spot(request)
    if spot is None:
        return None, None
    raw = await _weather(request).fetch_forecast(request.app["http"], spot.latitude, spot.longitude)
    return spot, raw


def _place_dict(spot: Spot) -> dict:
    return {"key": spot.key, "title": spot.title, "lat": spot.latitude, "lon": spot.longitude}


NO_PLACE = ("no_place", "Сначала укажите место: найдите город или добавьте угодье.")


# ---------- handlers ----------

async def health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def me(request: web.Request) -> web.Response:
    db, uid = _db(request), request["user_id"]
    settings = await db.get_settings(uid)
    region = get_region(settings.region_code)
    places = await db.list_places(uid)
    loc = await db.get_location(uid)
    return web.json_response({
        "user_id": uid,
        "region": ({"code": region.code, "name": region.name, "verified": is_verified(region.code)} if region else None),
        "timezone": settings.timezone,
        "subscribed": settings.subscribed,
        "places": [{"id": p.id, "key": f"p{p.id}", "name": p.name, "lat": p.latitude, "lon": p.longitude,
                    "is_default": p.is_default} for p in places],
        "location": ({"lat": loc.latitude, "lon": loc.longitude, "name": loc.place} if loc else None),
        "has_place": bool(places or loc),
    })


async def forecast(request: web.Request) -> web.Response:
    spot, raw = await _forecast_raw(request)
    if spot is None:
        return json_error(409, *NO_PLACE)
    return web.json_response(forecast_payload(raw, _place_dict(spot)))


async def activity(request: web.Request) -> web.Response:
    spot, raw = await _forecast_raw(request)
    if spot is None:
        return json_error(409, *NO_PLACE)
    payload = forecast_payload(raw, _place_dict(spot))
    slim = [{"date": d["date"], "title": d["title"], "label": d["label"], "moon": d["moon"],
             "sunrise": d["sunrise"], "sunset": d["sunset"], "activity": d["activity"]} for d in payload["days"]]
    return web.json_response({"place": payload["place"], "days": slim, "disclaimer": payload["activity_disclaimer"]})


async def seasons(request: web.Request) -> web.Response:
    settings = await _db(request).get_settings(request["user_id"])
    if get_region(settings.region_code) is None:
        return json_error(409, "no_region", "Сначала выберите регион.")
    return web.json_response(seasons_payload(settings.region_code, await _user_today(request)))


async def regions(request: web.Request) -> web.Response:
    return web.json_response([{"code": r.code, "name": r.name, "verified": is_verified(r.code)}
                              for r in load_regions()])


async def read_json(request: web.Request) -> dict:
    try:
        data = await request.json()
    except Exception:
        raise web.HTTPBadRequest(text='{"error":"bad_json"}', content_type="application/json")
    if not isinstance(data, dict):
        raise web.HTTPBadRequest(text='{"error":"bad_json"}', content_type="application/json")
    return data


async def set_region(request: web.Request) -> web.Response:
    data = await read_json(request)
    region = get_region(str(data.get("code", "")))
    if region is None:
        return json_error(400, "unknown_region", "Такого региона нет в списке.")
    await _db(request).set_region(request["user_id"], region.code)
    return web.json_response({"ok": True, "region": {"code": region.code, "name": region.name,
                                                     "verified": is_verified(region.code)}})


def _valid_coord(value, lo, hi) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if lo <= value <= hi else None


async def set_location(request: web.Request) -> web.Response:
    data = await read_json(request)
    db, uid = _db(request), request["user_id"]
    if "lat" in data or "lon" in data:
        lat, lon = _valid_coord(data.get("lat"), -90, 90), _valid_coord(data.get("lon"), -180, 180)
        if lat is None or lon is None:
            return json_error(400, "bad_coordinates", "Некорректные координаты.")
        name = str(data.get("name") or "по координатам")[:80]
    else:
        city = re.sub(r"\s+", " ", str(data.get("city", ""))).strip()
        if not city or len(city) > CITY_MAX:
            return json_error(400, "bad_city", "Введите название города.")
        place = await _weather(request).geocode_city(request.app["http"], city)
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
    app.router.add_get("/api/forecast", forecast)
    app.router.add_get("/api/activity", activity)
    app.router.add_get("/api/seasons", seasons)
    app.router.add_get("/api/regions", regions)
    app.router.add_post("/api/region", set_region)
    app.router.add_post("/api/location", set_location)
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
