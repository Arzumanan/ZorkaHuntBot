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
    db_path: str
    webapp_host: str = "127.0.0.1"
    webapp_port: int = 8080
    webapp_url: str | None = None          # публичный HTTPS-адрес Mini App (для кнопки в боте)
    webapp_dev_user_id: int | None = None  # только для разработки: пускает без initData
    webapp_cors_origin: str | None = None  # если статика отдаётся с другого домена
    policy_operator: str | None = None     # оператор данных для политики (иначе значение из bot/policy.py)
    policy_contact: str | None = None      # контакт оператора для политики


def load_config() -> Config:
    load_dotenv(BASE_DIR / ".env")
    token = os.getenv("BOT_TOKEN", "").strip()
    if not token:
        raise RuntimeError(
            "Не задан BOT_TOKEN. Скопируйте .env.example в .env и впишите токен от @BotFather."
        )
    db_path = os.getenv("DB_PATH", "").strip() or str(BASE_DIR / "zorka.db")
    url = os.getenv("WEBAPP_URL", "").strip().rstrip("/") or None
    if url and not url.startswith("https://"):
        logging.getLogger(__name__).warning("WEBAPP_URL должен начинаться с https:// — Mini App в боте отключён")
        url = None
    dev_raw = os.getenv("WEBAPP_DEV_USER_ID", "").strip()
    dev_user = int(dev_raw) if dev_raw.isdigit() else None
    try:
        port = int(os.getenv("WEBAPP_PORT", "").strip() or 8080)
    except ValueError:
        port = 8080
    return Config(
        bot_token=token,
        db_path=db_path,
        webapp_host=os.getenv("WEBAPP_HOST", "").strip() or "127.0.0.1",
        webapp_port=port,
        webapp_url=url,
        webapp_dev_user_id=dev_user,
        webapp_cors_origin=os.getenv("WEBAPP_CORS_ORIGIN", "").strip() or None,
        policy_operator=os.getenv("POLICY_OPERATOR", "").strip() or None,
        policy_contact=os.getenv("POLICY_CONTACT", "").strip() or None,
    )
