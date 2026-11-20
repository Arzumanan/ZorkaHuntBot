import html

import aiohttp
from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from ..db import Database
from ..keyboards import BTN_ACTIVITY, BTN_FORECAST, inline
from ..services.forecast_text import format_activity_report, format_forecast
from ..services.locations import list_spots, pick_spot
from ..services.weather import WeatherError, fetch_forecast, local_today, parse_forecast
from .util import answer_long

router = Router(name="forecast")

NO_PLACE = "Сначала укажи место: /location или добавь угодье: /places"


async def build_report(db: Database, http: aiohttp.ClientSession, user_id: int, kind: str, key: str | None):
    """Возвращает (текст, клавиатура_выбора_угодья | None). kind: 'f' — прогноз, 'a' — активность."""
    spots = await list_spots(db, user_id)
    spot = pick_spot(spots, key)
    if spot is None:
        return NO_PLACE, None
    try:
        raw = await fetch_forecast(http, spot.latitude, spot.longitude)
        days = parse_forecast(raw)
        today = local_today(raw)
    except WeatherError:
        return "Не получилось получить прогноз. Попробуй чуть позже.", None
    title = html.escape(spot.title)
    if kind == "a":
        text = format_activity_report(days, today, title)
    else:
        text = format_forecast(days, today, title)
    markup = None
    others = [s for s in spots if s.key != spot.key]
    if others:  # выбор другого угодья
        markup = inline([[(s.title, f"fc:{kind}:{s.key}")] for s in others])
        text += "\n\nДругое угодье:"
    return text, markup


@router.message(Command("forecast"))
@router.message(F.text == BTN_FORECAST)
async def cmd_forecast(message: Message, state: FSMContext, db: Database, http: aiohttp.ClientSession) -> None:
    await state.clear()
    text, markup = await build_report(db, http, message.from_user.id, "f", None)
    await answer_long(message, text, reply_markup=markup)


@router.message(Command("activity"))
@router.message(F.text == BTN_ACTIVITY)
async def cmd_activity(message: Message, state: FSMContext, db: Database, http: aiohttp.ClientSession) -> None:
    await state.clear()
    text, markup = await build_report(db, http, message.from_user.id, "a", None)
    await answer_long(message, text, reply_markup=markup)


@router.callback_query(F.data.startswith("fc:"))
async def cb_forecast(cb: CallbackQuery, db: Database, http: aiohttp.ClientSession) -> None:
    _, kind, key = cb.data.split(":", 2)
    await cb.answer()
    if cb.message is None:
        return
    text, markup = await build_report(db, http, cb.from_user.id, kind, key)
    await answer_long(cb.message, text, reply_markup=markup)
