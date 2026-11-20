"""Минимальный бот (только /start, кнопка Mini App и ответ на любой текст) и конфиг Mini App.

Настоящий Dispatcher + поддельная сессия Telegram, без сети.
"""
import importlib
from datetime import datetime, timezone

import pytest
from aiogram import Bot
from aiogram.client.session.base import BaseSession
from aiogram.methods import SendMessage
from aiogram.types import Chat, Message, ReplyKeyboardRemove

from bot.config import Config, load_config
from bot.keyboards import LEGACY_BUTTONS
from bot.main import COMMANDS, build_dispatcher

USER = 555
URL = "https://zorka.example.com"


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
    def sent(self):
        return [m for m in self.calls if isinstance(m, SendMessage)]


class Harness:
    def __init__(self, webapp_url=URL):
        # Router нельзя подключить к двум Dispatcher: перечитываем модуль хендлеров для каждого теста
        importlib.reload(importlib.import_module("bot.handlers.common"))
        self.session = FakeSession()
        self.bot = Bot("123456:TESTTOKEN", session=self.session)
        self.dp = build_dispatcher()
        self.dp["webapp_url"] = webapp_url
        self.n = 0

    async def say(self, text):
        self.n += 1
        msg = {"message_id": self.n, "date": 1700000000, "chat": {"id": USER, "type": "private"},
               "from": {"id": USER, "is_bot": False, "first_name": "Жека"}, "text": text}
        if text.startswith("/"):
            msg["entities"] = [{"type": "bot_command", "offset": 0, "length": len(text.split()[0])}]
        self.session.calls.clear()
        await self.dp.feed_raw_update(self.bot, {"update_id": self.n, "message": msg})
        return self.session.sent


@pytest.fixture
def h():
    return Harness()


def button_url(sent_message):
    return sent_message.reply_markup.inline_keyboard[0][0].web_app.url


async def test_start_removes_old_keyboard_and_sends_webapp_button(h):
    sent = await h.say("/start")
    assert len(sent) == 2
    assert "Привет, Жека" in sent[0].text and isinstance(sent[0].reply_markup, ReplyKeyboardRemove)
    assert button_url(sent[1]) == URL and "Открыть Зорьку" in sent[1].reply_markup.inline_keyboard[0][0].text


async def test_start_greeting_is_short_and_has_no_command_list(h):
    sent = await h.say("/start")
    assert len(sent[0].text) < 400 and "/forecast" not in sent[0].text


async def test_start_without_webapp_url_explains_config():
    h = Harness(webapp_url=None)
    sent = await h.say("/start")
    assert isinstance(sent[0].reply_markup, ReplyKeyboardRemove)
    assert "WEBAPP_URL" in sent[1].text and sent[1].reply_markup is None


@pytest.mark.parametrize("text", ["привет", "что умеешь?", "12345"])
async def test_any_text_gets_webapp_button(h, text):
    sent = await h.say(text)
    assert len(sent) == 1 and button_url(sent[0]) == URL


@pytest.mark.parametrize("text", ["/forecast", "/checklist", "/help", "/add_trophy", "/app"])
async def test_removed_commands_hint_at_app_and_clear_keyboard(h, text):
    sent = await h.say(text)
    assert isinstance(sent[0].reply_markup, ReplyKeyboardRemove)
    assert button_url(sent[-1]) == URL


async def test_old_keyboard_buttons_clear_keyboard(h):
    for label in sorted(LEGACY_BUTTONS):
        sent = await h.say(label)
        assert isinstance(sent[0].reply_markup, ReplyKeyboardRemove), label
        assert button_url(sent[1]) == URL


async def test_plain_text_does_not_resend_removal(h):
    sent = await h.say("привет")
    assert not any(isinstance(m.reply_markup, ReplyKeyboardRemove) for m in sent)


def test_only_start_command_registered():
    assert [c.command for c in COMMANDS] == ["start"]


def test_dispatcher_has_no_removed_routers():
    importlib.reload(importlib.import_module("bot.handlers.common"))
    dp = build_dispatcher()
    names = {r.name for r in dp.sub_routers}
    assert names == {"common"}


async def test_start_says_data_lives_in_users_telegram_cloud(h):
    sent = await h.say("/start")
    assert "облаке Telegram" in sent[0].text and "согласи" not in sent[0].text.lower()


# ---------- конфиг ----------

def test_config_webapp_defaults(monkeypatch):
    for key in ("WEBAPP_HOST", "WEBAPP_PORT", "WEBAPP_URL", "WEBAPP_CORS_ORIGIN", "DB_PATH"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("BOT_TOKEN", "1:x")
    monkeypatch.setattr("bot.config.load_dotenv", lambda *a, **k: None)
    c = load_config()
    assert (c.webapp_host, c.webapp_port, c.webapp_url, c.webapp_cors_origin) == ("127.0.0.1", 8080, None, None)
    assert c.db_path.endswith("zorka.db")


def test_config_webapp_values_and_validation(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "1:x")
    monkeypatch.setattr("bot.config.load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("WEBAPP_URL", "https://arzumanan.github.io/ZorkaHuntBot/")
    monkeypatch.setenv("WEBAPP_PORT", "9090")
    monkeypatch.setenv("WEBAPP_CORS_ORIGIN", "https://arzumanan.github.io")
    c = load_config()
    assert (c.webapp_url, c.webapp_port, c.webapp_cors_origin) == (
        "https://arzumanan.github.io/ZorkaHuntBot", 9090, "https://arzumanan.github.io")
    monkeypatch.setenv("WEBAPP_URL", "http://insecure.example.com")     # Telegram требует HTTPS
    monkeypatch.setenv("WEBAPP_PORT", "не число")
    c = load_config()
    assert (c.webapp_url, c.webapp_port) == (None, 8080)


def test_config_has_no_personal_data_settings():
    from dataclasses import fields

    names = {f.name for f in fields(Config)}
    assert not {"policy_operator", "policy_contact", "webapp_dev_user_id"} & names


def test_bot_package_has_no_database_or_broadcast_code():
    import importlib.util

    for mod in ("bot.db", "bot.policy", "bot.services", "bot.web.api"):
        assert importlib.util.find_spec(mod) is None, mod
