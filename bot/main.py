"""Точка входа: python -m bot.main"""
from __future__ import annotations

import asyncio
import logging

try:  # use Windows certificate store (antivirus / corporate proxy)
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

import aiohttp
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import BotCommand

from .config import load_config
from .db import Database
from .handlers import checklist, common, forecast, journal, location, places, seasons, subscription
from .services.scheduler import run_scheduler

COMMANDS = [
    BotCommand(command="forecast", description="Прогноз на зорьку"),
    BotCommand(command="activity", description="Активность зверя и птицы"),
    BotCommand(command="seasons", description="Сроки охоты в регионе"),
    BotCommand(command="region", description="Выбрать регион"),
    BotCommand(command="places", description="Сохранённые угодья"),
    BotCommand(command="checklist", description="Чек-лист снаряжения"),
    BotCommand(command="subscribe", description="Утренняя рассылка"),
    BotCommand(command="location", description="Указать место"),
    BotCommand(command="add_trophy", description="Добавить запись в журнал"),
    BotCommand(command="journal", description="Журнал охоты"),
    BotCommand(command="stats", description="Статистика журнала"),
    BotCommand(command="help", description="Справка"),
]


def build_dispatcher() -> Dispatcher:
    dp = Dispatcher()
    # Порядок важен: кнопки меню и /cancel (common) должны срабатывать раньше шагов диалогов.
    # location — последним: его F.location работает в любом состоянии, а у places свой StateFilter.
    dp.include_routers(
        common.router, forecast.router, seasons.router, subscription.router, checklist.router,
        places.router, journal.router, location.router,
    )
    return dp


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = load_config()
    db = Database(config.db_path)
    await db.connect()
    bot = Bot(config.bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    async with aiohttp.ClientSession() as http:
        dp = build_dispatcher()
        dp["db"] = db
        dp["http"] = http
        scheduler_task = asyncio.create_task(run_scheduler(bot, db, http))
        try:
            await bot.set_my_commands(COMMANDS)
            await dp.start_polling(bot)
        finally:
            scheduler_task.cancel()
            await bot.session.close()
            await db.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        print("Бот остановлен.")
