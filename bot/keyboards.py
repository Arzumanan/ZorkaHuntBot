"""Клавиатуры бота: только кнопка запуска Mini App.

Подписанную initData передают лишь inline-кнопка (под сообщением) и кнопка меню чата;
кнопки обычной (reply) клавиатуры её не передают, поэтому здесь только inline.
"""
from __future__ import annotations

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

OPEN_BUTTON_TEXT = "🌄 Открыть Зорьку"

# Подписи кнопок старой reply-клавиатуры: если пользователь ещё жмёт их, убираем клавиатуру.
LEGACY_BUTTONS = frozenset({
    "🌅 Прогноз на зорьку", "🐾 Активность", "📅 Сроки охоты", "🏞 Угодья", "🎒 Чек-лист", "📖 Журнал",
    "➕ Добавить трофей", "📊 Статистика", "🗺 Регион", "🔔 Рассылка", "📍 Моё место", "ℹ️ Помощь",
})


def webapp_markup(webapp_url: str | None) -> InlineKeyboardMarkup | None:
    if not webapp_url:
        return None
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text=OPEN_BUTTON_TEXT, web_app=WebAppInfo(url=webapp_url))
    ]])
