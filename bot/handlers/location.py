import html

import aiohttp
from aiogram import F, Router
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import Message

from ..db import Database
from ..keyboards import PLAIN_TEXT, BTN_LOCATION, location_request, main_menu
from ..services.weather import WeatherError, geocode_city

router = Router(name="location")


class LocationStates(StatesGroup):
    waiting = State()


@router.message(Command("location"))
@router.message(F.text == BTN_LOCATION)
async def ask_location(message: Message, state: FSMContext, db: Database) -> None:
    current = await db.get_location(message.from_user.id)
    prefix = f"Сейчас у меня записано: <b>{html.escape(current.place or 'точка по координатам')}</b>.\n\n" if current else ""
    await state.set_state(LocationStates.waiting)
    await message.answer(
        prefix + "Напиши название города или отправь геолокацию кнопкой ниже.",
        reply_markup=location_request(),
    )


@router.message(F.location)
async def got_location(message: Message, state: FSMContext, db: Database) -> None:
    loc = message.location
    await db.set_location(message.from_user.id, loc.latitude, loc.longitude, "по геолокации")
    await state.clear()
    await message.answer(
        f"Запомнил точку: {loc.latitude:.3f}, {loc.longitude:.3f} 📍\nТеперь жми /forecast.",
        reply_markup=main_menu(),
    )


@router.message(StateFilter(LocationStates.waiting), PLAIN_TEXT)
async def got_city(message: Message, state: FSMContext, db: Database, http: aiohttp.ClientSession) -> None:
    query = message.text.strip()
    try:
        place = await geocode_city(http, query)
    except WeatherError:
        await message.answer("Сервис поиска городов сейчас недоступен, попробуй чуть позже.")
        return
    if place is None:
        await message.answer("Не нашёл такой город. Проверь написание или отправь геолокацию.")
        return
    await db.set_location(message.from_user.id, place.latitude, place.longitude, place.title)
    await state.clear()
    await message.answer(
        f"Запомнил: <b>{html.escape(place.title)}</b> 📍\nТеперь жми /forecast.",
        reply_markup=main_menu(),
    )
