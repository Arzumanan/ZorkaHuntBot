"""Точка входа: python -m bot.main

Бот: /start → приветствие и кнопка запуска Mini App, любое сообщение → та же кнопка. Mini App целиком клиентский
(данные в CloudStorage Telegram), поэтому ни базы данных, ни рассылки здесь нет.
"""
from __future__ import annotations

import asyncio
import logging

try:  # use Windows certificate store (antivirus / corporate proxy)
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import BotCommand, MenuButtonWebApp, WebAppInfo

from .config import load_config
from .handlers import common
from .web.server import start_web_server

COMMANDS = [BotCommand(command="start", description="Открыть Зорьку")]


def build_dispatcher() -> Dispatcher:
    dp = Dispatcher()
    dp.include_router(common.router)
    return dp


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = load_config()
    bot = Bot(config.bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = build_dispatcher()
    dp["webapp_url"] = config.webapp_url
    try:
        web_runner = await start_web_server(config)
    except OSError as exc:  # например, порт занят: бот должен работать и без локального сервера
        logging.getLogger(__name__).error("Веб-сервер не запущен: %s", exc)
        web_runner = None
    try:
        await bot.set_my_commands(COMMANDS)
        if config.webapp_url:
            await bot.set_chat_menu_button(
                menu_button=MenuButtonWebApp(text="Зорька", web_app=WebAppInfo(url=config.webapp_url)))
        await dp.start_polling(bot)
    finally:
        if web_runner is not None:
            await web_runner.cleanup()
        await bot.session.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        print("Бот остановлен.")
