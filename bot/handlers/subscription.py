"""Утренняя рассылка: /subscribe, /unsubscribe, /settime, /timezone."""
import html

from aiogram import F, Router
from aiogram.filters import Command, CommandObject
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from ..db import Database
from ..keyboards import BTN_SUBSCRIBE, inline, main_menu
from ..services.locations import list_spots
from ..services.seasons import get_region
from ..services.subscription import DEFAULT_TIME, TIMEZONES, parse_send_time

router = Router(name="subscription")


async def status_text(db: Database, uid: int) -> str:
    s = await db.get_settings(uid)
    region = get_region(s.region_code)
    spots = await list_spots(db, uid)
    lines = ["🔔 <b>Утренняя рассылка</b>",
             "Присылаю прогноз на зорьку по субботам и воскресеньям, и только если в твоём регионе открыт какой-то сезон.", "",
             f"Статус: <b>{'включена' if s.subscribed else 'выключена'}</b>",
             f"Время: <b>{s.send_time}</b> ({TIMEZONES.get(s.timezone, s.timezone)})",
             f"Регион: <b>{html.escape(region.name) if region else 'не выбран (/region)'}</b>",
             f"Место: <b>{html.escape(spots[0].title) if spots else 'не указано (/location или /places)'}</b>", "",
             "Команды: /subscribe, /unsubscribe, /settime ЧЧ:ММ, /timezone"]
    return "\n".join(lines)


@router.message(Command("subscribe"))
@router.message(F.text == BTN_SUBSCRIBE)
async def cmd_subscribe(message: Message, state: FSMContext, db: Database) -> None:
    await state.clear()
    uid = message.from_user.id
    s = await db.get_settings(uid)
    problems = []
    if get_region(s.region_code) is None:
        problems.append("выбери регион: /region")
    if not await list_spots(db, uid):
        problems.append("укажи место: /location или добавь угодье: /places")
    if problems:
        await message.answer("Чтобы включить рассылку, " + " и ".join(problems) + ".")
        return
    await db.set_subscribed(uid, True)
    await message.answer("Рассылка включена ✅\n\n" + await status_text(db, uid), reply_markup=main_menu())


@router.message(Command("unsubscribe"))
async def cmd_unsubscribe(message: Message, db: Database) -> None:
    await db.set_subscribed(message.from_user.id, False)
    await message.answer("Рассылка выключена. Включить снова: /subscribe", reply_markup=main_menu())


@router.message(Command("settime"))
async def cmd_settime(message: Message, command: CommandObject, db: Database) -> None:
    value = parse_send_time(command.args or "")
    if value is None:
        await message.answer(f"Укажи время в формате ЧЧ:ММ, например: /settime 05:30 (по умолчанию {DEFAULT_TIME}).")
        return
    await db.set_send_time(message.from_user.id, value)
    await message.answer(f"Время рассылки: <b>{value}</b> по твоему часовому поясу.")


@router.message(Command("timezone"))
async def cmd_timezone(message: Message) -> None:
    rows = [[(label, f"tz:{name}")] for name, label in TIMEZONES.items()]
    await message.answer("Выбери часовой пояс для рассылки:", reply_markup=inline(rows))


@router.callback_query(F.data.startswith("tz:"))
async def cb_timezone(cb: CallbackQuery, db: Database) -> None:
    name = cb.data[3:]
    if name not in TIMEZONES:
        await cb.answer("Неизвестный пояс", show_alert=True)
        return
    await db.set_timezone(cb.from_user.id, name)
    await cb.answer("Сохранено")
    await cb.message.answer(f"Часовой пояс: <b>{TIMEZONES[name]}</b>")
