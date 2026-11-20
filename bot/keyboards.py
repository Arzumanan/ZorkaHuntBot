from aiogram import F
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, ReplyKeyboardMarkup

BTN_FORECAST = "🌅 Прогноз на зорьку"
BTN_ACTIVITY = "🐾 Активность"
BTN_SEASONS = "📅 Сроки охоты"
BTN_PLACES = "🏞 Угодья"
BTN_CHECKLIST = "🎒 Чек-лист"
BTN_JOURNAL = "📖 Журнал"
BTN_ADD = "➕ Добавить трофей"
BTN_STATS = "📊 Статистика"
BTN_REGION = "🗺 Регион"
BTN_SUBSCRIBE = "🔔 Рассылка"
BTN_LOCATION = "📍 Моё место"
BTN_HELP = "ℹ️ Помощь"

MENU_BUTTONS = {
    BTN_FORECAST, BTN_ACTIVITY, BTN_SEASONS, BTN_PLACES, BTN_CHECKLIST, BTN_JOURNAL,
    BTN_ADD, BTN_STATS, BTN_REGION, BTN_SUBSCRIBE, BTN_LOCATION, BTN_HELP,
}


def main_menu() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=BTN_FORECAST), KeyboardButton(text=BTN_ACTIVITY)],
            [KeyboardButton(text=BTN_SEASONS), KeyboardButton(text=BTN_CHECKLIST)],
            [KeyboardButton(text=BTN_PLACES), KeyboardButton(text=BTN_LOCATION)],
            [KeyboardButton(text=BTN_JOURNAL), KeyboardButton(text=BTN_ADD), KeyboardButton(text=BTN_STATS)],
            [KeyboardButton(text=BTN_REGION), KeyboardButton(text=BTN_SUBSCRIBE), KeyboardButton(text=BTN_HELP)],
        ],
        resize_keyboard=True,
    )


def location_request() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="📡 Отправить геолокацию", request_location=True)],
            [KeyboardButton(text="Отмена")],
        ],
        resize_keyboard=True,
        one_time_keyboard=True,
    )


def inline(rows: list[list[tuple[str, str]]]) -> InlineKeyboardMarkup:
    """rows: [[(текст, callback_data), ...], ...]"""
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text=t, callback_data=d) for t, d in row] for row in rows]
    )


# Обычный текст: не кнопка меню и не команда (для шагов диалогов)
PLAIN_TEXT = F.text & ~F.text.in_(MENU_BUTTONS) & ~F.text.startswith("/")
