"""Сохранённые угодья: /places."""
import html

import aiohttp
from aiogram import F, Router
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, Message

from ..db import Database
from .util import safe_edit
from ..keyboards import BTN_PLACES, PLAIN_TEXT, inline, location_request, main_menu
from ..services.weather import WeatherError, geocode_city

router = Router(name="places")
MAX_PLACES = 20


class AddPlace(StatesGroup):
    point = State()   # геолокация или город
    name = State()    # название угодья


async def places_view(db: Database, user_id: int):
    places = await db.list_places(user_id)
    if not places:
        text = ("🏞 <b>Сохранённые угодья</b>\n\nПока пусто. Добавь угодье: пришли геолокацию или название города "
                "и придумай ему имя. Прогноз можно будет смотреть по любому угодью.")
        return text, inline([[("➕ Добавить угодье", "pl:add")]])
    lines = ["🏞 <b>Сохранённые угодья</b>", ""]
    rows = []
    for p in places:
        lines.append(f"{'⭐' if p.is_default else '•'} <b>{html.escape(p.name)}</b> ({p.latitude:.3f}, {p.longitude:.3f})")
        row = []
        if not p.is_default:
            row.append(("⭐ По умолчанию", f"pl:def:{p.id}"))
        row.append((f"🗑 {p.name[:18]}", f"pl:del:{p.id}"))
        rows.append(row)
    rows.append([("➕ Добавить угодье", "pl:add")])
    lines.append("\n⭐ — угодье по умолчанию (по нему идёт /forecast и утренняя рассылка).")
    return "\n".join(lines), inline(rows)


@router.message(Command("places"))
@router.message(F.text == BTN_PLACES)
async def cmd_places(message: Message, state: FSMContext, db: Database) -> None:
    await state.clear()
    text, markup = await places_view(db, message.from_user.id)
    await message.answer(text, reply_markup=markup)


@router.callback_query(F.data.startswith("pl:"))
async def cb_places(cb: CallbackQuery, state: FSMContext, db: Database) -> None:
    parts = cb.data.split(":")
    action = parts[1]
    uid = cb.from_user.id
    if action == "add":
        if len(await db.list_places(uid)) >= MAX_PLACES:
            await cb.answer(f"Максимум {MAX_PLACES} угодий", show_alert=True)
            return
        await state.set_state(AddPlace.point)
        await cb.answer()
        await cb.message.answer("Пришли геолокацию кнопкой ниже или напиши название города / населённого пункта рядом с угодьем.",
                                reply_markup=location_request())
        return
    if action == "def":
        ok = await db.set_default_place(uid, int(parts[2]))
        await cb.answer("Готово" if ok else "Угодье не найдено")
    elif action == "del":
        ok = await db.delete_place(uid, int(parts[2]))
        await cb.answer("Удалено" if ok else "Угодье не найдено")
    else:
        await cb.answer()
        return
    text, markup = await places_view(db, uid)
    await safe_edit(cb.message, text, reply_markup=markup)


@router.message(StateFilter(AddPlace.point), F.location)
async def got_point_location(message: Message, state: FSMContext) -> None:
    loc = message.location
    await state.update_data(lat=loc.latitude, lon=loc.longitude, suggested="Угодье")
    await state.set_state(AddPlace.name)
    await message.answer("Как назвать это угодье? (например: «Озеро за дамбой»)", reply_markup=main_menu())


@router.message(StateFilter(AddPlace.point), PLAIN_TEXT)
async def got_point_city(message: Message, state: FSMContext, http: aiohttp.ClientSession) -> None:
    try:
        place = await geocode_city(http, message.text.strip())
    except WeatherError:
        await message.answer("Сервис поиска городов сейчас недоступен, попробуй чуть позже или отправь геолокацию.")
        return
    if place is None:
        await message.answer("Не нашёл такой пункт. Проверь написание или отправь геолокацию.")
        return
    await state.update_data(lat=place.latitude, lon=place.longitude, suggested=place.name)
    await state.set_state(AddPlace.name)
    await message.answer(
        f"Нашёл: {html.escape(place.title)}.\nКак назвать угодье? Напиши имя или «-», чтобы оставить «{html.escape(place.name)}».",
        reply_markup=main_menu(),
    )


@router.message(StateFilter(AddPlace.name), PLAIN_TEXT)
async def got_place_name(message: Message, state: FSMContext, db: Database) -> None:
    data = await state.get_data()
    name = message.text.strip()
    if name == "-":
        name = data.get("suggested", "Угодье")
    name = name[:60]
    await db.add_place(message.from_user.id, name, data["lat"], data["lon"])
    await state.clear()
    text, markup = await places_view(db, message.from_user.id)
    await message.answer(f"Угодье «{html.escape(name)}» сохранено ✅", reply_markup=main_menu())
    await message.answer(text, reply_markup=markup)
