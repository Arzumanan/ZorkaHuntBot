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
from aiogram.types import BotCommand, MenuButtonWebApp, WebAppInfo

from .config import load_config
from .db import Database
from .handlers import common
from .services.scheduler import run_scheduler
from .web.api import start_web_server

COMMANDS = [BotCommand(command="start", description="Открыть Зорьку")]


def build_dispatcher() -> Dispatcher:
    dp = Dispatcher()
    dp.include_router(common.router)
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
        dp["webapp_url"] = config.webapp_url
        scheduler_task = asyncio.create_task(run_scheduler(bot, db, http, config.webapp_url))
        try:
            web_runner = await start_web_server(config, db, http)
        except OSError as exc:  # например, порт занят: бот должен работать и без Mini App
            logging.getLogger(__name__).error("Веб-сервер Mini App не запущен: %s", exc)
            web_runner = None
        try:
            await bot.set_my_commands(COMMANDS)
            if config.webapp_url:
                await bot.set_chat_menu_button(
                    menu_button=MenuButtonWebApp(text="Зорька", web_app=WebAppInfo(url=config.webapp_url)))
            await dp.start_polling(bot)
        finally:
            scheduler_task.cancel()
            if web_runner is not None:
                await web_runner.cleanup()
            await bot.session.close()
            await db.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        print("Бот остановлен.")
