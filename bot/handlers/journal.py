import html
from datetime import date

from aiogram import F, Router
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import Message

from ..db import Database
from ..keyboards import PLAIN_TEXT, BTN_ADD, BTN_JOURNAL, BTN_STATS, main_menu
from ..services.stats import compute_stats, format_stats
from ..utils import parse_date

router = Router(name="journal")


class AddTrophy(StatesGroup):
    date = State()
    place = State()
    species = State()
    note = State()


def format_date(iso: str) -> str:
    y, m, d = iso.split("-")
    return f"{d}.{m}.{y}"


@router.message(Command("journal"))
@router.message(F.text == BTN_JOURNAL)
async def cmd_journal(message: Message, state: FSMContext, db: Database) -> None:
    await state.clear()
    items = await db.list_trophies(message.from_user.id, limit=10)
    if not items:
        await message.answer("Журнал пока пуст. Добавь первую запись: /add_trophy")
        return
    lines = ["📖 <b>Последние записи</b>\n"]
    for t in items:
        line = f"• <b>{format_date(t.hunt_date)}</b> — {html.escape(t.species)}, {html.escape(t.place)}"
        if t.note:
            line += f"\n   <i>{html.escape(t.note)}</i>"
        lines.append(line)
    await message.answer("\n".join(lines))


@router.message(Command("stats"))
@router.message(F.text == BTN_STATS)
async def cmd_stats(message: Message, state: FSMContext, db: Database) -> None:
    await state.clear()
    stats = compute_stats(await db.all_trophies(message.from_user.id))
    await message.answer(format_stats(stats))


@router.message(Command("add_trophy"))
@router.message(F.text == BTN_ADD)
async def start_add(message: Message, state: FSMContext) -> None:
    await state.set_state(AddTrophy.date)
    await message.answer("Когда была охота? Напиши дату (ДД.ММ.ГГГГ) или «сегодня» / «вчера». Отмена: /cancel")


@router.message(StateFilter(AddTrophy.date), PLAIN_TEXT)
async def got_date(message: Message, state: FSMContext) -> None:
    d = parse_date(message.text)
    if d is None:
        await message.answer("Не понял дату. Пример: 15.11.2026, «сегодня» или «вчера».")
        return
    if d > date.today():
        await message.answer("Дата в будущем — давай настоящую 🙂")
        return
    await state.update_data(hunt_date=d.isoformat())
    await state.set_state(AddTrophy.place)
    await message.answer("Где охотились? (угодье, лес, область)")


@router.message(StateFilter(AddTrophy.place), PLAIN_TEXT)
async def got_place(message: Message, state: FSMContext) -> None:
    await state.update_data(place=message.text.strip()[:200])
    await state.set_state(AddTrophy.species)
    await message.answer("Какая дичь / зверь? (например: кабан, утка, глухарь)")


@router.message(StateFilter(AddTrophy.species), PLAIN_TEXT)
async def got_species(message: Message, state: FSMContext) -> None:
    await state.update_data(species=message.text.strip()[:100])
    await state.set_state(AddTrophy.note)
    await message.answer("Заметка (необязательно). Напиши «-», чтобы пропустить.")


@router.message(StateFilter(AddTrophy.note), PLAIN_TEXT)
async def got_note(message: Message, state: FSMContext, db: Database) -> None:
    text = message.text.strip()
    note = "" if text == "-" else text[:500]
    data = await state.get_data()
    await db.add_trophy(message.from_user.id, data["hunt_date"], data["place"], data["species"], note)
    await state.clear()
    await message.answer("Записано в журнал ✅ Смотри: /journal", reply_markup=main_menu())
