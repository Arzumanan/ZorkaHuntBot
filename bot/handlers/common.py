"""Минимальный бот: /start, кнопка запуска Mini App и ответ на любые другие сообщения.

Весь функционал (прогноз, активность, сезоны, чек-лист, угодья, журнал, настройки) живёт в Mini App.
"""
from aiogram import Router
from aiogram.filters import CommandStart
from aiogram.types import Message, ReplyKeyboardRemove

from ..keyboards import LEGACY_BUTTONS, webapp_markup

router = Router(name="common")

NOT_CONFIGURED = "Приложение пока не настроено: нужен адрес WEBAPP_URL в .env (см. README)."


async def send_open_button(message: Message, text: str, webapp_url: str | None) -> None:
    markup = webapp_markup(webapp_url)
    if markup is None:
        await message.answer(NOT_CONFIGURED)
        return
    await message.answer(text, reply_markup=markup)


@router.message(CommandStart())
async def cmd_start(message: Message, webapp_url: str | None = None) -> None:
    name = message.from_user.first_name if message.from_user else "охотник"
    # клавиатуру убираем отдельным сообщением: в одном сообщении может быть только один reply_markup
    await message.answer(
        f"Привет, {name}! 👋 Я <b>Зорька</b> — помощник охотника.\n"
        "Прогноз на зорьку, активность зверя и птицы, сроки охоты, чек-лист, угодья и журнал — "
        "в приложении.",
        reply_markup=ReplyKeyboardRemove(),
    )
    await send_open_button(message, "Открой приложение кнопкой ниже или кнопкой меню у поля ввода 👇", webapp_url)


@router.message()
async def any_message(message: Message, webapp_url: str | None = None) -> None:
    text = (message.text or "").strip()
    if text in LEGACY_BUTTONS or text.startswith("/"):
        # старая клавиатура или старая команда: убираем клавиатуру, а кнопку отправляем следом
        await message.answer("Теперь всё в приложении 👇", reply_markup=ReplyKeyboardRemove())
    await send_open_button(message, "Всё работает в приложении — открой его кнопкой ниже:", webapp_url)
