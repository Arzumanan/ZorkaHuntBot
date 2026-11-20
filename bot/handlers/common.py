from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo

from ..keyboards import BTN_HELP, main_menu

router = Router(name="common")

HELP_TEXT = (
    "Я <b>Зорька</b> — помощник охотника 🦌\n\n"
    "<b>Погода и активность</b>\n"
    "/forecast — прогноз на зорьку: восход, закат, ветер, давление, луна, оценка дня и активность зверя и птицы\n"
    "/activity — активность водоплавающей, боровой дичи и копытных (оценка)\n\n"
    "<b>Регион и сроки</b>\n"
    "/region — выбрать свой регион (сохраняется)\n"
    "/seasons — сроки охоты в регионе: что открыто и что скоро\n\n"
    "<b>Места</b>\n"
    "/location — текущее место (город или геолокация)\n"
    "/places — сохранённые угодья: добавить, удалить, выбрать по умолчанию\n\n"
    "<b>Утренняя рассылка</b>\n"
    "/subscribe, /unsubscribe — вкл/выкл (суббота и воскресенье, только в сезон)\n"
    "/settime ЧЧ:ММ — время (по умолчанию 05:00), /timezone — часовой пояс\n\n"
    "<b>Подготовка и журнал</b>\n"
    "/checklist — чек-лист снаряжения: оружие, документы, снаряжение, еда и питьё\n"
    "/add_trophy — записать трофей, /journal — последние 10 записей\n"
    "/stats — статистика журнала (если ведёшь записи)\n"
    "/app — открыть Mini App (если настроен)\n/cancel — отменить текущий ввод\n\n"
    "Начни с /region и /location. Сроки охоты — справочные: "
    "точные даты уточняйте в региональном охотуправлении."
)


def webapp_markup(webapp_url: str | None) -> InlineKeyboardMarkup | None:
    """Inline-кнопка Mini App (только inline и кнопка меню передают подписанную initData)."""
    if not webapp_url:
        return None
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🌄 Открыть Зорьку", web_app=WebAppInfo(url=webapp_url))
    ]])


@router.message(CommandStart())
async def cmd_start(message: Message, state: FSMContext, webapp_url: str | None = None) -> None:
    await state.clear()
    name = message.from_user.first_name if message.from_user else "охотник"
    await message.answer(f"Привет, {name}! 👋\n\n{HELP_TEXT}", reply_markup=main_menu())
    markup = webapp_markup(webapp_url)
    if markup:
        await message.answer("Прогноз, активность и сроки охоты с графиками — в приложении:", reply_markup=markup)


@router.message(Command("app"))
async def cmd_app(message: Message, webapp_url: str | None = None) -> None:
    markup = webapp_markup(webapp_url)
    if markup is None:
        await message.answer("Mini App пока не настроен (нужен WEBAPP_URL в .env, см. README).")
        return
    await message.answer("Открой приложение кнопкой ниже:", reply_markup=markup)


@router.message(Command("help"))
@router.message(F.text == BTN_HELP)
async def cmd_help(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer(HELP_TEXT, reply_markup=main_menu())


@router.message(Command("cancel"))
@router.message(F.text.casefold() == "отмена")
async def cmd_cancel(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer("Отменено.", reply_markup=main_menu())
