"""Конфигурация бота: читаем переменные окружения / файл .env."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Config:
    bot_token: str
    db_path: str


def load_config() -> Config:
    load_dotenv(BASE_DIR / ".env")
    token = os.getenv("BOT_TOKEN", "").strip()
    if not token:
        raise RuntimeError(
            "Не задан BOT_TOKEN. Скопируйте .env.example в .env и впишите токен от @BotFather."
        )
    db_path = os.getenv("DB_PATH", "").strip() or str(BASE_DIR / "zorka.db")
    return Config(bot_token=token, db_path=db_path)
