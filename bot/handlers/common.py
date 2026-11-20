from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.types import Message

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
    "/cancel — отменить текущий ввод\n\n"
    "Начни с /region и /location. Сроки охоты — справочные: "
    "точные даты уточняйте в региональном охотуправлении."
)


@router.message(CommandStart())
async def cmd_start(message: Message, state: FSMContext) -> None:
    await state.clear()
    name = message.from_user.first_name if message.from_user else "охотник"
    await message.answer(f"Привет, {name}! 👋\n\n{HELP_TEXT}", reply_markup=main_menu())


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
