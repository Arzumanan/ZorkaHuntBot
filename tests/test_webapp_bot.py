# ruff: noqa: F811

from bot.config import load_config
from tests.test_flows import h  # noqa: F401,F811  (фикстура)


async def test_start_without_webapp_url_has_no_webapp_button(h):
    texts = await h.say("/start")
    assert len(texts) == 1
    assert "Mini App пока не настроен" in (await h.say("/app"))[0]


async def test_start_with_webapp_url_sends_webapp_button(h):
    h.dp["webapp_url"] = "https://zorka.example.com"
    texts = await h.say("/start")
    assert len(texts) == 2 and "в приложении" in texts[1]
    button = h.session.markups()[1].inline_keyboard[0][0]
    assert button.web_app.url == "https://zorka.example.com" and "Открыть Зорьку" in button.text
    await h.say("/app")
    assert h.session.markups()[0].inline_keyboard[0][0].web_app.url == "https://zorka.example.com"


def test_config_webapp_defaults(monkeypatch, tmp_path):
    for key in ("WEBAPP_HOST", "WEBAPP_PORT", "WEBAPP_URL", "WEBAPP_DEV_USER_ID", "WEBAPP_CORS_ORIGIN"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("BOT_TOKEN", "1:x")
    monkeypatch.setattr("bot.config.load_dotenv", lambda *a, **k: None)
    c = load_config()
    assert (c.webapp_host, c.webapp_port, c.webapp_url, c.webapp_dev_user_id, c.webapp_cors_origin) == (
        "127.0.0.1", 8080, None, None, None)


def test_config_webapp_values_and_validation(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "1:x")
    monkeypatch.setattr("bot.config.load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("WEBAPP_URL", "https://a.trycloudflare.com/")
    monkeypatch.setenv("WEBAPP_PORT", "9090")
    monkeypatch.setenv("WEBAPP_DEV_USER_ID", "123")
    c = load_config()
    assert (c.webapp_url, c.webapp_port, c.webapp_dev_user_id) == ("https://a.trycloudflare.com", 9090, 123)
    monkeypatch.setenv("WEBAPP_URL", "http://insecure.example.com")     # Telegram требует HTTPS
    monkeypatch.setenv("WEBAPP_PORT", "не число")
    monkeypatch.setenv("WEBAPP_DEV_USER_ID", "abc")
    c = load_config()
    assert (c.webapp_url, c.webapp_port, c.webapp_dev_user_id) == (None, 8080, None)
