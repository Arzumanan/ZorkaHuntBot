"""Чек-лист снаряжения: /checklist."""
from datetime import timedelta

import aiohttp
from aiogram import F, Router
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, Message

from ..db import Database
from .util import safe_edit
from ..keyboards import BTN_CHECKLIST, PLAIN_TEXT, inline
from ..services.checklist import CATEGORIES, CATEGORY_ORDER, HUNT_TYPES, template_for, weather_hints
from ..services.forecast_text import conditions_for
from ..services.locations import list_spots, pick_spot
from ..services.weather import WeatherError, fetch_forecast, local_today, parse_forecast

router = Router(name="checklist")


class AddItem(StatesGroup):
    text = State()


async def _ensure(db: Database, uid: int) -> str:
    hunt_type = (await db.get_settings(uid)).hunt_type
    await db.seed_checklist(uid, hunt_type, template_for(hunt_type))
    return hunt_type


async def _hints(db: Database, http: aiohttp.ClientSession, uid: int) -> list[str]:
    spot = pick_spot(await list_spots(db, uid))
    if spot is None:
        return []
    try:
        raw = await fetch_forecast(http, spot.latitude, spot.longitude)
        days = parse_forecast(raw)
        today = local_today(raw)
    except WeatherError:
        return []
    day = days.get(today + timedelta(days=1)) or days.get(today)
    if day is None:
        return []
    c = conditions_for(day)
    return weather_hints(c.temperature, c.precipitation, c.wind_speed, c.wind_gusts)


async def home_view(db: Database, uid: int, hints: list[str] | None = None):
    hunt_type = await _ensure(db, uid)
    items = await db.list_checklist(uid, hunt_type)
    done = sum(i.checked for i in items)
    lines = ["🎒 <b>Чек-лист снаряжения</b>", f"Вид охоты: {HUNT_TYPES[hunt_type]}",
             f"Собрано: <b>{done}/{len(items)}</b>"]
    if hints:
        lines += ["", "<b>Подсказки по погоде</b>"] + hints
    elif hints is not None:
        lines += ["", "Подсказки по погоде появятся, когда укажешь место (/location или /places)."]
    rows = []
    for cat in CATEGORY_ORDER:
        cat_items = [i for i in items if i.category == cat]
        rows.append([(f"{CATEGORIES[cat]} ({sum(i.checked for i in cat_items)}/{len(cat_items)})", f"cl:c:{cat}")])
    rows.append([("🔁 Вид охоты", "cl:type"), ("♻️ Сбросить отметки", "cl:reset")])
    return "\n".join(lines), inline(rows)


async def category_view(db: Database, uid: int, cat: str, delete_mode: bool = False):
    hunt_type = await _ensure(db, uid)
    items = await db.list_checklist(uid, hunt_type, cat)
    title = f"{CATEGORIES[cat]} — {HUNT_TYPES[hunt_type]}"
    rows = []
    if delete_mode:
        customs = [i for i in items if i.custom]
        text = f"{title}\n\nНажми на свой пункт, чтобы удалить его."
        rows = [[(f"🗑 {i.text[:50]}", f"cl:d:{i.id}")] for i in customs]
        if not customs:
            text = f"{title}\n\nСвоих пунктов в этой категории пока нет."
        rows.append([("⬅️ Назад", f"cl:c:{cat}")])
        return text, inline(rows)
    text = f"{title}\n\nОтмечай собранное — нажми на пункт."
    for i in items:
        rows.append([(f"{'✅' if i.checked else '⬜'} {i.text[:60]}", f"cl:t:{i.id}")])
    rows.append([("➕ Свой пункт", f"cl:add:{cat}"), ("🗑 Удалить свои", f"cl:dm:{cat}")])
    rows.append([("⬅️ К списку", "cl:home")])
    return text, inline(rows)


@router.message(Command("checklist"))
@router.message(F.text == BTN_CHECKLIST)
async def cmd_checklist(message: Message, state: FSMContext, db: Database, http: aiohttp.ClientSession) -> None:
    await state.clear()
    hints = await _hints(db, http, message.from_user.id)
    text, markup = await home_view(db, message.from_user.id, hints)
    await message.answer(text, reply_markup=markup)


@router.callback_query(F.data.startswith("cl:"))
async def cb_checklist(cb: CallbackQuery, state: FSMContext, db: Database, http: aiohttp.ClientSession) -> None:
    parts = cb.data.split(":")
    action = parts[1]
    uid = cb.from_user.id
    msg = cb.message

    if action == "home":
        hints = await _hints(db, http, uid)
        text, markup = await home_view(db, uid, hints)
        await safe_edit(msg, text, reply_markup=markup)
    elif action == "c":
        text, markup = await category_view(db, uid, parts[2])
        await safe_edit(msg, text, reply_markup=markup)
    elif action == "t":
        item_id = int(parts[2])
        hunt_type = await _ensure(db, uid)
        item = next((i for i in await db.list_checklist(uid, hunt_type) if i.id == item_id), None)
        if item is None:
            await cb.answer("Пункт не найден")
            return
        await db.toggle_item(uid, item_id)
        text, markup = await category_view(db, uid, item.category)
        await safe_edit(msg, text, reply_markup=markup)
    elif action == "type":
        rows = [[(label, f"cl:st:{key}")] for key, label in HUNT_TYPES.items()]
        await safe_edit(msg, "Выбери вид охоты — от него зависит набор пунктов:", reply_markup=inline(rows))
    elif action == "st":
        if parts[2] in HUNT_TYPES:
            await db.set_hunt_type(uid, parts[2])
        hints = await _hints(db, http, uid)
        text, markup = await home_view(db, uid, hints)
        await safe_edit(msg, text, reply_markup=markup)
    elif action == "reset":
        hunt_type = await _ensure(db, uid)
        await db.reset_checks(uid, hunt_type)
        text, markup = await home_view(db, uid, None)
        await safe_edit(msg, text, reply_markup=markup)
        await cb.answer("Отметки сброшены")
        return
    elif action == "add":
        await state.set_state(AddItem.text)
        await state.update_data(cat=parts[2])
        await cb.answer()
        await msg.answer(f"Напиши свой пункт для категории «{CATEGORIES[parts[2]]}» (или /cancel).")
        return
    elif action == "dm":
        text, markup = await category_view(db, uid, parts[2], delete_mode=True)
        await safe_edit(msg, text, reply_markup=markup)
    elif action == "d":
        hunt_type = await _ensure(db, uid)
        item = next((i for i in await db.list_checklist(uid, hunt_type) if i.id == int(parts[2])), None)
        await db.delete_custom_item(uid, int(parts[2]))
        cat = item.category if item else CATEGORY_ORDER[0]
        text, markup = await category_view(db, uid, cat, delete_mode=True)
        await safe_edit(msg, text, reply_markup=markup)
    await cb.answer()


@router.message(StateFilter(AddItem.text), PLAIN_TEXT)
async def got_custom_item(message: Message, state: FSMContext, db: Database) -> None:
    data = await state.get_data()
    uid = message.from_user.id
    hunt_type = await _ensure(db, uid)
    await db.add_custom_item(uid, hunt_type, data["cat"], message.text.strip()[:100])
    await state.clear()
    text, markup = await category_view(db, uid, data["cat"])
    await message.answer(f"Добавлено ✅\n\n{text}", reply_markup=markup)
