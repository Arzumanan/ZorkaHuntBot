"""Сквозные проверки маршрутизации хендлеров: настоящий Dispatcher + поддельная сессия Telegram (без сети)."""
import importlib
from datetime import datetime, timezone

import pytest
from aiogram import Bot
from aiogram.client.session.base import BaseSession
from aiogram.exceptions import TelegramForbiddenError
from aiogram.methods import SendMessage
from aiogram.types import Chat, Message

from bot.main import build_dispatcher
from bot.services import scheduler
from bot.services.seasons import season_open

USER = 555


class FakeSession(BaseSession):
    def __init__(self):
        super().__init__()
        self.calls = []

    async def close(self):
        pass

    async def stream_content(self, *a, **kw):
        yield b""

    async def make_request(self, bot, method, timeout=None):
        self.calls.append(method)
        if isinstance(method, SendMessage):
            return Message(message_id=len(self.calls), date=datetime.now(timezone.utc),
                           chat=Chat(id=method.chat_id, type="private"), text=method.text)
        return True

    @property
    def texts(self):
        return [m.text for m in self.calls if isinstance(m, SendMessage)]

    def markups(self):
        return [m.reply_markup for m in self.calls if isinstance(m, SendMessage)]


HANDLER_MODULES = ["common", "forecast", "seasons", "subscription", "checklist", "places", "journal", "location"]


def fresh_dispatcher():
    # Router нельзя подключить к двум Dispatcher: перечитываем модули хендлеров для каждого теста
    for name in HANDLER_MODULES:
        importlib.reload(importlib.import_module(f"bot.handlers.{name}"))
    return build_dispatcher()


class Harness:
    def __init__(self, db):
        self.session = FakeSession()
        self.bot = Bot("123456:TESTTOKEN", session=self.session)
        self.dp = fresh_dispatcher()
        self.dp["db"] = db
        self.dp["http"] = None
        self.n = 0
        self.db = db

    def _base(self):
        self.n += 1
        return {"message_id": self.n, "date": 1700000000, "chat": {"id": USER, "type": "private"},
                "from": {"id": USER, "is_bot": False, "first_name": "Жека"}}

    async def say(self, text):
        msg = self._base() | {"text": text}
        if text.startswith("/"):
            msg["entities"] = [{"type": "bot_command", "offset": 0, "length": len(text.split()[0])}]
        self.session.calls.clear()
        await self.dp.feed_raw_update(self.bot, {"update_id": self.n, "message": msg})
        return self.session.texts

    async def send_location(self, lat, lon):
        msg = self._base() | {"location": {"latitude": lat, "longitude": lon}}
        self.session.calls.clear()
        await self.dp.feed_raw_update(self.bot, {"update_id": self.n, "message": msg})
        return self.session.texts

    async def press(self, data):
        self.n += 1
        cb = {"id": str(self.n), "from": {"id": USER, "is_bot": False, "first_name": "Жека"},
              "chat_instance": "x", "data": data, "message": self._base() | {"text": "кнопка"}}
        self.session.calls.clear()
        await self.dp.feed_raw_update(self.bot, {"update_id": self.n, "callback_query": cb})
        return self.session.texts


@pytest.fixture
def h(db):
    return Harness(db)


async def test_start_and_help(h):
    texts = await h.say("/start")
    assert "Привет, Жека" in texts[0] and "/seasons" in texts[0] and "/checklist" in texts[0]
    assert "/stats" in (await h.say("/help"))[0]


async def test_region_pick_by_button_and_paging(h, db):
    texts = await h.say("/region")
    assert "Выбери свой регион" in texts[0]
    kb = h.session.markups()[0]
    assert kb.inline_keyboard[0][0].callback_data == "rg:s:krasnodar"      # Краснодарский край первым
    assert kb.inline_keyboard[1][0].callback_data == "rg:s:adygea"
    await h.press("rg:p:2")
    texts = await h.press("rg:s:krasnodar")
    assert "Регион сохранён" in texts[0]
    assert (await db.get_settings(USER)).region_code == "krasnodar"


async def test_region_search_by_text(h):
    await h.say("/region")
    texts = await h.say("адыг")
    assert texts == ["Нашёл:"]
    assert h.session.markups()[0].inline_keyboard[0][0].callback_data == "rg:s:adygea"
    assert await h.say("абракадабра") == ["Не нашёл такой регион. Попробуй другое написание или листай список кнопками."]


async def test_seasons_requires_region_then_shows_krasnodar(h, db):
    assert "выбери регион" in (await h.say("/seasons"))[0].lower()
    await db.set_region(USER, "krasnodar")
    texts = await h.say("/seasons")
    joined = "\n".join(texts)
    assert "Краснодарский край" in joined and "krasnodar-gov.ru" in joined
    assert "региональном охотуправлении" in joined


async def test_seasons_unverified_region_falls_back_to_federal(h, db):
    await db.set_region(USER, "samarskaya_oblast")
    joined = "\n".join(await h.say("/seasons"))
    assert "федеральные сроки" in joined


async def test_menu_button_inside_dialog_is_not_swallowed(h, db):
    await db.set_region(USER, "adygea")
    await h.say("/add_trophy")                       # состояние: ждём дату
    texts = await h.say("📅 Сроки охоты")             # кнопка меню должна сработать, а не стать «датой»
    assert any("Республика Адыгея" in t for t in texts)
    assert await db.list_trophies(USER) == []


async def test_places_flow_with_location_and_name(h, db):
    assert "Пока пусто" in (await h.say("/places"))[0]
    await h.press("pl:add")
    texts = await h.send_location(44.6, 40.1)       # не должен уйти в «Моё место»
    assert "Как назвать" in texts[0]
    assert await db.get_location(USER) is None
    texts = await h.say("Озеро за дамбой")
    assert "сохранено" in texts[0]
    places = await db.list_places(USER)
    assert [p.name for p in places] == ["Озеро за дамбой"] and places[0].is_default
    await h.press(f"pl:del:{places[0].id}")
    assert await db.list_places(USER) == []


async def test_forecast_without_place_asks_for_it(h):
    assert "/location" in (await h.say("/forecast"))[0]
    assert "/location" in (await h.say("/activity"))[0]


async def test_checklist_toggle_add_and_delete_custom(h, db):
    texts = await h.say("/checklist")
    assert "Чек-лист снаряжения" in texts[0] and "Подсказки по погоде появятся" in texts[0]
    await h.press("cl:c:docs")
    items = await db.list_checklist(USER, "general", "docs")
    assert any("Охотничий билет" in i.text for i in items)
    await h.press(f"cl:t:{items[0].id}")
    assert (await db.list_checklist(USER, "general", "docs"))[0].checked
    await h.press("cl:add:gear")
    await h.say("Рация")
    custom = [i for i in await db.list_checklist(USER, "general", "gear") if i.custom]
    assert [i.text for i in custom] == ["Рация"]
    await h.press("cl:dm:gear")
    await h.press(f"cl:d:{custom[0].id}")
    assert not [i for i in await db.list_checklist(USER, "general", "gear") if i.custom]
    await h.press("cl:st:waterfowl")
    assert (await db.get_settings(USER)).hunt_type == "waterfowl"


async def test_subscribe_flow(h, db):
    assert "/region" in (await h.say("/subscribe"))[0]
    await db.set_region(USER, "krasnodar")
    await db.set_location(USER, 45.0, 38.9, "Краснодар")
    assert "включена" in (await h.say("/subscribe"))[0]
    assert (await db.get_settings(USER)).subscribed
    assert "05:30" in (await h.say("/settime 5:30"))[0]
    assert (await db.get_settings(USER)).send_time == "05:30"
    assert "ЧЧ:ММ" in (await h.say("/settime плохо"))[0]
    await h.press("tz:Asia/Omsk")
    assert (await db.get_settings(USER)).timezone == "Asia/Omsk"
    await h.say("/unsubscribe")
    assert not (await db.get_settings(USER)).subscribed


async def test_stats_empty_and_filled(h, db):
    assert "пуста" in (await h.say("/stats"))[0]
    await db.add_trophy(USER, "2026-10-03", "Лес", "Кабан")
    text = (await h.say("📊 Статистика"))[0]
    assert "Записей (трофеев): <b>1</b>" in text


# ---------- планировщик ----------

class FakeBot:
    def __init__(self, forbidden=False):
        self.sent = []
        self.forbidden = forbidden

    async def send_message(self, chat_id, text):
        if self.forbidden:
            raise TelegramForbiddenError(method=None, message="Forbidden: bot was blocked by the user")
        self.sent.append((chat_id, text))


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
    assert await scheduler.process_user(bot, db, None, s, now) is True
    chat, text = bot.sent[0]
    assert chat == USER and "Зорька на выходные" in text and "Краснодарский край" in text
    assert "21 ноября" in text and "22 ноября" not in text
    s = (await db.list_subscribers())[0]
    assert s.last_sent == "2026-11-21"
    assert await scheduler.process_user(bot, db, None, s, utc(2026, 11, 21, 2, 6)) is False   # не дублируем
    assert len(bot.sent) == 1


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
