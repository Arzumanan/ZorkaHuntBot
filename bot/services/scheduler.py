"""Планировщик утренней рассылки (свой asyncio-цикл, без внешних зависимостей)."""
from __future__ import annotations

import asyncio
import html
import logging
from datetime import datetime, timezone

import aiohttp
from aiogram import Bot
from aiogram.exceptions import TelegramForbiddenError

from ..db import Database, Settings
from ..keyboards import webapp_markup
from .forecast_text import format_forecast
from .locations import list_spots, pick_spot
from .seasons import get_region, open_entries, season_open
from .subscription import decide_send
from .weather import WeatherError, fetch_forecast, local_today, parse_forecast

log = logging.getLogger(__name__)
CHECK_INTERVAL = 60  # секунд


async def build_morning_message(db: Database, http: aiohttp.ClientSession, settings: Settings, today,
                                now_utc: datetime | None = None) -> str | None:
    spot = pick_spot(await list_spots(db, settings.user_id))
    if spot is None:
        return None
    raw = await fetch_forecast(http, spot.latitude, spot.longitude)
    days = parse_forecast(raw)
    region = get_region(settings.region_code)
    forecast = format_forecast(days, local_today(raw, now_utc), html.escape(spot.title), only_today=True)
    names = [e.name for e in open_entries(settings.region_code, today)][:6]
    header = (f"🌄 <b>Доброе утро! Зорька на выходные</b>\n"
              f"Регион: {html.escape(region.name) if region else '—'}\n"
              f"Открыто сейчас: {html.escape('; '.join(names)) if names else '—'}\n"
              f"Точные сроки уточняйте в региональном охотуправлении.")
    return f"{header}\n\n{forecast}"


async def process_user(bot: Bot, db: Database, http: aiohttp.ClientSession, s: Settings, now_utc: datetime,
                       webapp_url: str | None = None) -> bool:
    """Отправляет рассылку одному пользователю, если пора. Возвращает True, если отправлено."""
    send, today = decide_send(now_utc, s.timezone, s.send_time, s.last_sent,
                              lambda d: season_open(s.region_code, d))
    if not send:
        return False
    text = await build_morning_message(db, http, s, today, now_utc)
    if text is None:
        return False
    try:
        await bot.send_message(s.user_id, text, reply_markup=webapp_markup(webapp_url))
    except TelegramForbiddenError:  # пользователь заблокировал бота
        await db.set_subscribed(s.user_id, False)
        log.info("Пользователь %s заблокировал бота — рассылка выключена", s.user_id)
        return False
    await db.set_last_sent(s.user_id, today.isoformat())
    return True


async def run_scheduler(bot: Bot, db: Database, http: aiohttp.ClientSession, webapp_url: str | None = None,
                        interval: int = CHECK_INTERVAL) -> None:
    log.info("Планировщик рассылки запущен")
    while True:
        try:
            now_utc = datetime.now(timezone.utc)
            for s in await db.list_subscribers():
                try:
                    await process_user(bot, db, http, s, now_utc, webapp_url)
                except WeatherError:
                    log.warning("Погода недоступна для %s, повторим на следующем шаге", s.user_id)
                except Exception:  # один пользователь не должен ронять цикл
                    log.exception("Ошибка рассылки для %s", s.user_id)
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Ошибка планировщика")
            await asyncio.sleep(interval)
