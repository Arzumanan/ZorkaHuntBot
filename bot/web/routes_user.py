"""API личных данных пользователя: чек-лист, угодья, журнал, статистика, настройки."""
from __future__ import annotations

from datetime import timedelta

from aiohttp import web

from ..services.checklist import CATEGORIES, CATEGORY_ORDER, HUNT_TYPES, template_for, weather_hints
from ..services.forecast_text import conditions_for
from ..services.locations import list_spots, pick_spot
from ..services.seasons import get_region, is_verified
from ..services.stats import compute_stats
from ..services.subscription import DEFAULT_TIME, TIMEZONES, parse_send_time
from ..services.weather import WeatherError, local_today, parse_forecast
from ..utils import parse_date
from .helpers import (
    CITY_MAX, clean_text, get_db, get_weather, json_error, read_json, user_today, valid_coord,
)

ITEM_MAX = 100
PLACE_NAME_MAX = 60
MAX_PLACES = 30
TROPHY_PLACE_MAX, TROPHY_SPECIES_MAX, TROPHY_NOTE_MAX = 200, 100, 500
JOURNAL_LIMIT = 500


def _int_id(data: dict, key: str = "id") -> int | None:
    value = data.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


# ---------- чек-лист ----------

async def _ensure_checklist(request: web.Request) -> str:
    db, uid = get_db(request), request["user_id"]
    hunt_type = (await db.get_settings(uid)).hunt_type
    if hunt_type not in HUNT_TYPES:
        hunt_type = "general"
    await db.seed_checklist(uid, hunt_type, template_for(hunt_type))
    return hunt_type


async def _weather_hints(request: web.Request) -> list[str]:
    """Подсказки по погоде для угодья по умолчанию (или текущего места); без места или без сети — пусто."""
    spot = pick_spot(await list_spots(get_db(request), request["user_id"]))
    if spot is None:
        return []
    try:
        raw = await get_weather(request).fetch_forecast(request.app["http"], spot.latitude, spot.longitude)
        days = parse_forecast(raw)
        today = local_today(raw)
    except WeatherError:
        return []
    day = days.get(today + timedelta(days=1)) or days.get(today)
    if day is None:
        return []
    c = conditions_for(day)
    return weather_hints(c.temperature, c.precipitation, c.wind_speed, c.wind_gusts)


async def checklist_payload(request: web.Request, with_hints: bool = True) -> dict:
    hunt_type = await _ensure_checklist(request)
    items = await get_db(request).list_checklist(request["user_id"], hunt_type)
    categories = []
    for code in CATEGORY_ORDER:
        cat_items = [i for i in items if i.category == code]
        categories.append({
            "code": code,
            "name": CATEGORIES[code],
            "done": sum(i.checked for i in cat_items),
            "total": len(cat_items),
            "items": [{"id": i.id, "text": i.text, "checked": i.checked, "custom": i.custom} for i in cat_items],
        })
    return {
        "hunt_type": hunt_type,
        "hunt_types": [{"code": c, "name": n} for c, n in HUNT_TYPES.items()],
        "done": sum(i.checked for i in items),
        "total": len(items),
        "categories": categories,
        "hints": await _weather_hints(request) if with_hints else [],
    }


async def checklist_get(request: web.Request) -> web.Response:
    return web.json_response(await checklist_payload(request))


async def checklist_set_type(request: web.Request) -> web.Response:
    data = await read_json(request)
    code = data.get("hunt_type")
    if code not in HUNT_TYPES:
        return json_error(400, "unknown_hunt_type", "Такого вида охоты нет.")
    await get_db(request).set_hunt_type(request["user_id"], code)
    return web.json_response(await checklist_payload(request))


async def checklist_toggle(request: web.Request) -> web.Response:
    data = await read_json(request)
    item_id = _int_id(data)
    checked = None if item_id is None else await get_db(request).toggle_item(request["user_id"], item_id)
    if checked is None:
        return json_error(404, "not_found", "Пункт не найден.")
    return web.json_response({"ok": True, "id": item_id, "checked": checked})


async def checklist_add(request: web.Request) -> web.Response:
    data = await read_json(request)
    category = data.get("category")
    text = clean_text(data.get("text"), ITEM_MAX)
    if category not in CATEGORIES:
        return json_error(400, "unknown_category", "Неизвестная категория.")
    if not text:
        return json_error(400, "empty_text", "Введите название пункта.")
    hunt_type = await _ensure_checklist(request)
    item_id = await get_db(request).add_custom_item(request["user_id"], hunt_type, category, text)
    return web.json_response({"ok": True, "item": {"id": item_id, "text": text, "checked": False, "custom": True,
                                                    "category": category}}, status=201)


async def checklist_delete(request: web.Request) -> web.Response:
    data = await read_json(request)
    item_id = _int_id(data)
    if item_id is None or not await get_db(request).delete_custom_item(request["user_id"], item_id):
        return json_error(404, "not_found", "Своего пункта с таким номером нет (пункты шаблона удалить нельзя).")
    return web.json_response({"ok": True})


async def checklist_reset(request: web.Request) -> web.Response:
    hunt_type = await _ensure_checklist(request)
    await get_db(request).reset_checks(request["user_id"], hunt_type)
    return web.json_response(await checklist_payload(request, with_hints=False) | {"ok": True})


# ---------- угодья ----------

def _place_json(p) -> dict:
    return {"id": p.id, "key": f"p{p.id}", "name": p.name, "lat": p.latitude, "lon": p.longitude,
            "is_default": p.is_default}


async def places_list(request: web.Request) -> web.Response:
    places = await get_db(request).list_places(request["user_id"])
    return web.json_response({"places": [_place_json(p) for p in places], "max": MAX_PLACES})


async def places_add(request: web.Request) -> web.Response:
    data = await read_json(request)
    db, uid = get_db(request), request["user_id"]
    if len(await db.list_places(uid)) >= MAX_PLACES:
        return json_error(400, "too_many", f"Можно сохранить не больше {MAX_PLACES} угодий.")
    name = clean_text(data.get("name"), PLACE_NAME_MAX)
    if "lat" in data or "lon" in data:
        lat, lon = valid_coord(data.get("lat"), -90, 90), valid_coord(data.get("lon"), -180, 180)
        if lat is None or lon is None:
            return json_error(400, "bad_coordinates", "Некорректные координаты (широта −90…90, долгота −180…180).")
        name = name or f"Угодье {lat:.3f}, {lon:.3f}"
    else:
        city = clean_text(data.get("city"), CITY_MAX + 1)
        if not city or len(city) > CITY_MAX:
            return json_error(400, "bad_city", "Введите название города или координаты.")
        found = await get_weather(request).geocode_city(request.app["http"], city)
        if found is None:
            return json_error(404, "city_not_found", "Не нашёл такой город. Проверьте написание.")
        lat, lon = found.latitude, found.longitude
        name = name or found.name[:PLACE_NAME_MAX]
    place_id = await db.add_place(uid, name, lat, lon)
    return web.json_response({"ok": True, "place": _place_json(await db.get_place(uid, place_id))}, status=201)


async def places_update(request: web.Request) -> web.Response:
    """Переименование и/или «по умолчанию»."""
    data = await read_json(request)
    db, uid = get_db(request), request["user_id"]
    place_id = _int_id(data)
    if place_id is None or await db.get_place(uid, place_id) is None:
        return json_error(404, "not_found", "Угодье не найдено.")
    if "name" in data:
        name = clean_text(data.get("name"), PLACE_NAME_MAX)
        if not name:
            return json_error(400, "empty_name", "Название не может быть пустым.")
        await db.rename_place(uid, place_id, name)
    if data.get("is_default") is True:
        await db.set_default_place(uid, place_id)
    return web.json_response({"ok": True, "place": _place_json(await db.get_place(uid, place_id))})


async def places_delete(request: web.Request) -> web.Response:
    data = await read_json(request)
    place_id = _int_id(data)
    if place_id is None or not await get_db(request).delete_place(request["user_id"], place_id):
        return json_error(404, "not_found", "Угодье не найдено.")
    return web.json_response({"ok": True})


# ---------- журнал и статистика ----------

def _trophy_json(t) -> dict:
    return {"id": t.id, "date": t.hunt_date, "place": t.place, "species": t.species, "note": t.note}


async def journal_list(request: web.Request) -> web.Response:
    items = await get_db(request).list_trophies(request["user_id"], limit=JOURNAL_LIMIT)
    return web.json_response({"records": [_trophy_json(t) for t in items], "count": len(items)})


async def journal_add(request: web.Request) -> web.Response:
    data = await read_json(request)
    today = await user_today(request)
    raw_date = data.get("date")
    hunt_date = parse_date(raw_date, today) if isinstance(raw_date, str) else None
    if hunt_date is None:
        return json_error(400, "bad_date", "Не понял дату. Формат: ГГГГ-ММ-ДД или ДД.ММ.ГГГГ.")
    if hunt_date > today:
        return json_error(400, "future_date", "Дата в будущем — укажите настоящую 🙂")
    place = clean_text(data.get("place"), TROPHY_PLACE_MAX)
    species = clean_text(data.get("species"), TROPHY_SPECIES_MAX)
    note = clean_text(data.get("note"), TROPHY_NOTE_MAX)
    if not place:
        return json_error(400, "empty_place", "Укажите, где охотились.")
    if not species:
        return json_error(400, "empty_species", "Укажите дичь или зверя.")
    db, uid = get_db(request), request["user_id"]
    trophy_id = await db.add_trophy(uid, hunt_date.isoformat(), place, species, note)
    record = {"id": trophy_id, "date": hunt_date.isoformat(), "place": place, "species": species, "note": note}
    return web.json_response({"ok": True, "record": record}, status=201)


async def journal_delete(request: web.Request) -> web.Response:
    data = await read_json(request)
    trophy_id = _int_id(data)
    if trophy_id is None or not await get_db(request).delete_trophy(request["user_id"], trophy_id):
        return json_error(404, "not_found", "Запись не найдена.")
    return web.json_response({"ok": True})


async def stats_get(request: web.Request) -> web.Response:
    s = compute_stats(await get_db(request).all_trophies(request["user_id"]))
    pairs = lambda rows: [{"name": n, "count": c} for n, c in rows]  # noqa: E731
    return web.json_response({
        "records": s.records,
        "trips": s.trips,
        "by_species": pairs(s.by_species),
        "by_place": pairs(s.by_place),
        "by_month": [{"month": m, "count": c} for m, c in s.by_month],
        "best_months": pairs(s.best_months),
    })


# ---------- настройки ----------

async def _settings_json(request: web.Request) -> dict:
    s = await get_db(request).get_settings(request["user_id"])
    region = get_region(s.region_code)
    return {
        "region": ({"code": region.code, "name": region.name, "verified": is_verified(region.code)}
                   if region else None),
        "timezone": s.timezone,
        "timezones": [{"code": c, "name": n} for c, n in TIMEZONES.items()],
        "subscribed": s.subscribed,
        "send_time": s.send_time or DEFAULT_TIME,
    }


async def settings_get(request: web.Request) -> web.Response:
    return web.json_response(await _settings_json(request))


async def settings_update(request: web.Request) -> web.Response:
    """Частичное обновление: timezone, subscribed, send_time. Всё проверяем до записи."""
    data = await read_json(request)
    db, uid = get_db(request), request["user_id"]
    changes = {}
    if "timezone" in data:
        if data["timezone"] not in TIMEZONES:
            return json_error(400, "bad_timezone", "Такого часового пояса нет в списке.")
        changes["timezone"] = data["timezone"]
    if "subscribed" in data:
        if not isinstance(data["subscribed"], bool):
            return json_error(400, "bad_subscribed", "Ожидается да или нет.")
        changes["subscribed"] = data["subscribed"]
    if "send_time" in data:
        parsed = parse_send_time(data["send_time"]) if isinstance(data["send_time"], str) else None
        if parsed is None:
            return json_error(400, "bad_time", "Время в формате ЧЧ:ММ, например 05:00.")
        changes["send_time"] = parsed
    if "timezone" in changes:
        await db.set_timezone(uid, changes["timezone"])
    if "subscribed" in changes:
        await db.set_subscribed(uid, changes["subscribed"])
    if "send_time" in changes:
        await db.set_send_time(uid, changes["send_time"])
    return web.json_response({"ok": True} | await _settings_json(request))


def register(app: web.Application) -> None:
    r = app.router
    r.add_get("/api/checklist", checklist_get)
    r.add_post("/api/checklist/type", checklist_set_type)
    r.add_post("/api/checklist/toggle", checklist_toggle)
    r.add_post("/api/checklist/add", checklist_add)
    r.add_post("/api/checklist/delete", checklist_delete)
    r.add_post("/api/checklist/reset", checklist_reset)
    r.add_get("/api/places", places_list)
    r.add_post("/api/places", places_add)
    r.add_post("/api/places/update", places_update)
    r.add_post("/api/places/delete", places_delete)
    r.add_get("/api/journal", journal_list)
    r.add_post("/api/journal", journal_add)
    r.add_post("/api/journal/delete", journal_delete)
    r.add_get("/api/stats", stats_get)
    r.add_get("/api/settings", settings_get)
    r.add_post("/api/settings", settings_update)
