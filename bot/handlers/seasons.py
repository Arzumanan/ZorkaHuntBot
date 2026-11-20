"""Выбор региона и /seasons."""
import html
from datetime import datetime, timezone

from aiogram import F, Router
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, Message

from ..db import Database
from ..keyboards import BTN_REGION, BTN_SEASONS, PLAIN_TEXT, inline, main_menu
from ..services.subscription import local_now
from ..services.seasons import format_seasons, get_region, is_verified, load_regions, search_regions
from .util import answer_long

router = Router(name="seasons")
PAGE_SIZE = 8


class RegionStates(StatesGroup):
    search = State()


def region_page_markup(page: int):
    regions = load_regions()
    pages = (len(regions) + PAGE_SIZE - 1) // PAGE_SIZE
    page = max(0, min(page, pages - 1))
    chunk = regions[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]
    rows = [[((("✅ " if is_verified(r.code) else "") + r.name), f"rg:s:{r.code}")] for r in chunk]
    nav = []
    if page > 0:
        nav.append(("⬅️", f"rg:p:{page - 1}"))
    nav.append((f"{page + 1}/{pages}", "rg:noop"))
    if page < pages - 1:
        nav.append(("➡️", f"rg:p:{page + 1}"))
    rows.append(nav)
    return inline(rows)


REGION_INTRO = (
    "🗺 Выбери свой регион (субъект РФ) из списка или напиши его название текстом для поиска.\n"
    "✅ — для региона есть региональные сроки (степень проверки и источники — в /seasons); для остальных покажу федеральные рамки."
)


@router.message(Command("region"))
@router.message(F.text == BTN_REGION)
async def cmd_region(message: Message, state: FSMContext, db: Database) -> None:
    settings = await db.get_settings(message.from_user.id)
    current = get_region(settings.region_code)
    prefix = f"Сейчас выбран: <b>{html.escape(current.name)}</b>\n\n" if current else ""
    await state.set_state(RegionStates.search)
    await message.answer(prefix + REGION_INTRO, reply_markup=region_page_markup(0))


@router.callback_query(F.data.startswith("rg:"))
async def cb_region(cb: CallbackQuery, state: FSMContext, db: Database) -> None:
    parts = cb.data.split(":")
    action = parts[1]
    if action == "noop":
        await cb.answer()
        return
    if action == "p":
        await cb.message.edit_reply_markup(reply_markup=region_page_markup(int(parts[2])))
        await cb.answer()
        return
    if action == "s":
        region = get_region(parts[2])
        if region is None:
            await cb.answer("Регион не найден", show_alert=True)
            return
        await db.set_region(cb.from_user.id, region.code)
        await state.clear()
        await cb.answer("Сохранено")
        await cb.message.answer(
            f"Регион сохранён: <b>{html.escape(region.name)}</b> ✅\nСроки охоты: /seasons",
            reply_markup=main_menu(),
        )


@router.message(StateFilter(RegionStates.search), PLAIN_TEXT)
async def region_search(message: Message) -> None:
    found = search_regions(message.text)
    if not found:
        await message.answer("Не нашёл такой регион. Попробуй другое написание или листай список кнопками.")
        return
    rows = [[((("✅ " if is_verified(r.code) else "") + r.name), f"rg:s:{r.code}")] for r in found[:10]]
    await message.answer("Нашёл:", reply_markup=inline(rows))


@router.message(Command("seasons"))
@router.message(F.text == BTN_SEASONS)
async def cmd_seasons(message: Message, state: FSMContext, db: Database) -> None:
    await state.clear()
    settings = await db.get_settings(message.from_user.id)
    if get_region(settings.region_code) is None:
        await state.set_state(RegionStates.search)
        await message.answer("Сначала выбери регион, чтобы я показал сроки.\n\n" + REGION_INTRO,
                             reply_markup=region_page_markup(0))
        return
    today = local_now(datetime.now(timezone.utc), settings.timezone).date()
    parts = format_seasons(settings.region_code, today)
    for text in parts:
        await answer_long(message, text, disable_web_page_preview=True)
