"""Общие помощники обработчиков API."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from aiohttp import web

from ..db import Database
from ..services.locations import Spot, list_spots, pick_spot
from ..services.subscription import local_now

CITY_MAX = 80


def json_error(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": code, "message": message}, status=status)


def _bad_json() -> web.HTTPBadRequest:
    body = {"error": "bad_json", "message": "Некорректный запрос."}
    return web.HTTPBadRequest(text=json.dumps(body, ensure_ascii=False), content_type="application/json")


async def read_json(request: web.Request) -> dict:
    try:
        data = await request.json()
    except Exception:
        raise _bad_json()
    if not isinstance(data, dict):
        raise _bad_json()
    return data


def get_db(request: web.Request) -> Database:
    return request.app["db"]


def get_weather(request: web.Request):
    return request.app["weather"]


async def resolve_spot(request: web.Request) -> Spot | None:
    spots = await list_spots(get_db(request), request["user_id"])
    key = request.query.get("place_id")
    if key and key != "cur" and key.isdigit():
        key = f"p{key}"
    return pick_spot(spots, key or None)


async def user_today(request: web.Request):
    settings = await get_db(request).get_settings(request["user_id"])
    return local_now(datetime.now(timezone.utc), settings.timezone).date()


async def forecast_raw(request: web.Request):
    spot = await resolve_spot(request)
    if spot is None:
        return None, None
    raw = await get_weather(request).fetch_forecast(request.app["http"], spot.latitude, spot.longitude)
    return spot, raw


def place_dict(spot: Spot) -> dict:
    return {"key": spot.key, "title": spot.title, "lat": spot.latitude, "lon": spot.longitude}


def valid_coord(value, lo, hi) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if lo <= value <= hi else None


def clean_text(value, max_len: int) -> str:
    """Схлопывает пробелы; не строка — пустая строка; длинное — обрезается."""
    if not isinstance(value, str):
        return ""
    return re.sub(r"[ \t]+", " ", value.replace("\r", "")).strip()[:max_len]


NO_PLACE = ("no_place", "Сначала укажите место: найдите город или добавьте угодье.")
