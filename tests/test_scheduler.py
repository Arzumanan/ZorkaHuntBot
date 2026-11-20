"""Утренняя рассылка: планировщик с поддельным ботом (без сети и Telegram)."""
from datetime import datetime, timezone

import pytest
from aiogram.exceptions import TelegramForbiddenError

from bot.services import scheduler
from bot.services.seasons import season_open

USER = 555
URL = "https://zorka.example.com"


class FakeBot:
    def __init__(self, forbidden=False):
        self.sent = []
        self.forbidden = forbidden

    async def send_message(self, chat_id, text, reply_markup=None):
        if self.forbidden:
            raise TelegramForbiddenError(method=None, message="Forbidden: bot was blocked by the user")
        self.sent.append((chat_id, text, reply_markup))


@pytest.fixture
def patched_weather(monkeypatch, forecast_json):
    async def fake_fetch(http, lat, lon):
        return forecast_json

    monkeypatch.setattr(scheduler, "fetch_forecast", fake_fetch)


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


async def make_subscriber(db, region="krasnodar"):
    await db.set_region(USER, region)
    await db.set_location(USER, 45.0, 38.9, "Краснодар")
    await db.set_subscribed(USER, True)
    return (await db.list_subscribers())[0]


async def test_scheduler_sends_on_saturday_once(db, patched_weather):
    s = await make_subscriber(db)
    bot = FakeBot()
    now = utc(2026, 11, 21, 2, 5)          # суббота 05:05 по Москве
    assert await scheduler.process_user(bot, db, None, s, now, URL) is True
    chat, text, _ = bot.sent[0]
    assert chat == USER and "Зорька на выходные" in text and "Краснодарский край" in text
    assert "Сегодня, 21 ноября" in text and "22 ноября" not in text
    s = (await db.list_subscribers())[0]
    assert s.last_sent == "2026-11-21"
    assert await scheduler.process_user(bot, db, None, s, utc(2026, 11, 21, 2, 6), URL) is False   # не дублируем
    assert len(bot.sent) == 1


async def test_morning_message_has_webapp_button(db, patched_weather):
    s = await make_subscriber(db)
    bot = FakeBot()
    await scheduler.process_user(bot, db, None, s, utc(2026, 11, 21, 2, 5), URL)
    button = bot.sent[0][2].inline_keyboard[0][0]
    assert button.web_app.url == URL and "Открыть Зорьку" in button.text


async def test_morning_message_without_webapp_url_has_no_markup(db, patched_weather):
    s = await make_subscriber(db)
    bot = FakeBot()
    await scheduler.process_user(bot, db, None, s, utc(2026, 11, 21, 2, 5))
    assert bot.sent[0][2] is None


async def test_scheduler_skips_weekday(db, patched_weather):
    s = await make_subscriber(db)
    bot = FakeBot()
    assert await scheduler.process_user(bot, db, None, s, utc(2026, 11, 23, 2, 5)) is False   # понедельник
    assert bot.sent == []


async def test_scheduler_skips_when_no_season_open(db, patched_weather):
    s = await make_subscriber(db, region="samarskaya_oblast")
    assert not season_open("samarskaya_oblast", datetime(2027, 4, 3).date())
    bot = FakeBot()
    assert await scheduler.process_user(bot, db, None, s, utc(2027, 4, 3, 2, 5)) is False     # суббота, но сезона нет
    assert bot.sent == []


async def test_scheduler_unsubscribes_blocked_user(db, patched_weather):
    s = await make_subscriber(db)
    assert await scheduler.process_user(FakeBot(forbidden=True), db, None, s, utc(2026, 11, 21, 2, 5)) is False
    assert await db.list_subscribers() == []
