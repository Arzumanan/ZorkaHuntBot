from datetime import date

from bot.services.forecast_text import day_heading, format_forecast
from bot.services.weather import parse_forecast


def test_forecast_contains_activity_block_and_disclaimer(forecast_json):
    days = parse_forecast(forecast_json)
    text = format_forecast(days, date(2026, 11, 20), "Майкоп")
    assert "Активность зверя и птицы" in text
    assert "Водоплавающая дичь: утро" in text and "Копытные: утро" in text
    assert "ориентировочная оценка" in text
    assert "Фазан: утро" in text and "Заяц: утро" in text


def test_forecast_headings_capitalised_with_date(forecast_json):
    days = parse_forecast(forecast_json)
    text = format_forecast(days, date(2026, 11, 20), "Майкоп")
    assert "<b>Завтра, 21 ноября</b>" in text and "<b>Сегодня, 20 ноября</b>" in text
    assert "завтра" not in text


def test_day_heading():
    today = date(2026, 11, 20)
    assert day_heading(today, today) == "Сегодня, 20 ноября"
    assert day_heading(date(2026, 11, 21), today) == "Завтра, 21 ноября"
    assert day_heading(date(2026, 11, 23), today) == "23 ноября"


def test_forecast_only_today(forecast_json):
    days = parse_forecast(forecast_json)
    text = format_forecast(days, date(2026, 11, 20), "Майкоп", only_today=True)
    assert "20 ноября" in text and "21 ноября" not in text


def test_temp_change_parsed(forecast_json):
    forecast_json["hourly"]["temperature_2m"][24 + 8] = 10.0   # 21-е, 08:00
    d = parse_forecast(forecast_json)[date(2026, 11, 21)]
    base = forecast_json["hourly"]["temperature_2m"][8]
    assert d.temp_change == 10.0 - base
