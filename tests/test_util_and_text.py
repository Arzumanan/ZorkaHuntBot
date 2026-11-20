from datetime import date

from bot.handlers.util import split_text
from bot.services.forecast_text import format_activity_report, format_forecast
from bot.services.weather import parse_forecast


def test_split_short_text_untouched():
    assert split_text("привет") == ["привет"]


def test_split_long_text_by_blocks_within_limit():
    text = "\n\n".join("а" * 900 for _ in range(10))
    chunks = split_text(text, 4000)
    assert len(chunks) > 1 and all(len(c) <= 4000 for c in chunks)
    assert "".join(c.replace("\n", "") for c in chunks) == text.replace("\n", "")


def test_split_giant_block():
    chunks = split_text("б" * 9000, 4000)
    assert [len(c) for c in chunks] == [4000, 4000, 1000]


def test_forecast_contains_activity_block_and_disclaimer(forecast_json):
    days = parse_forecast(forecast_json)
    text = format_forecast(days, date(2026, 11, 20), "Майкоп")
    assert "Активность зверя и птицы" in text
    assert "Водоплавающая дичь: утро" in text and "Копытные: утро" in text
    assert "ориентировочная оценка" in text


def test_forecast_only_today(forecast_json):
    days = parse_forecast(forecast_json)
    text = format_forecast(days, date(2026, 11, 20), "Майкоп", only_today=True)
    assert "20 ноября" in text and "21 ноября" not in text


def test_activity_report(forecast_json):
    days = parse_forecast(forecast_json)
    text = format_activity_report(days, date(2026, 11, 20), "Майкоп")
    for word in ("Водоплавающая дичь", "Боровая дичь", "Копытные", "ориентировочная оценка"):
        assert word in text


def test_temp_change_parsed(forecast_json):
    forecast_json["hourly"]["temperature_2m"][24 + 8] = 10.0   # 21-е, 08:00
    d = parse_forecast(forecast_json)[date(2026, 11, 21)]
    base = forecast_json["hourly"]["temperature_2m"][8]
    assert d.temp_change == 10.0 - base
