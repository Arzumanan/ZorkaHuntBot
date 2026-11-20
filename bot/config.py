"""Конфигурация бота: читаем переменные окружения / файл .env."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Config:
    bot_token: str
    webapp_host: str = "127.0.0.1"
    webapp_port: int = 8080
    webapp_url: str | None = None          # публичный HTTPS-адрес Mini App (для кнопки в боте)
    webapp_cors_origin: str | None = None  # если приложение открывается с другого домена (GitHub Pages) — для разового переноса
    db_path: str = str(BASE_DIR / "zorka.db")   # ВРЕМЕННО: старая база, откуда переносятся данные (см. bot/legacy.py)


def load_config() -> Config:
    load_dotenv(BASE_DIR / ".env")
    token = os.getenv("BOT_TOKEN", "").strip()
    if not token:
        raise RuntimeError(
            "Не задан BOT_TOKEN. Скопируйте .env.example в .env и впишите токен от @BotFather."
        )
    url = os.getenv("WEBAPP_URL", "").strip().rstrip("/") or None
    if url and not url.startswith("https://"):
        logging.getLogger(__name__).warning("WEBAPP_URL должен начинаться с https:// — Mini App в боте отключён")
        url = None
    try:
        port = int(os.getenv("WEBAPP_PORT", "").strip() or 8080)
    except ValueError:
        port = 8080
    return Config(
        bot_token=token,
        webapp_host=os.getenv("WEBAPP_HOST", "").strip() or "127.0.0.1",
        webapp_port=port,
        webapp_url=url,
        webapp_cors_origin=os.getenv("WEBAPP_CORS_ORIGIN", "").strip() or None,
        db_path=os.getenv("DB_PATH", "").strip() or str(BASE_DIR / "zorka.db"),
    )
