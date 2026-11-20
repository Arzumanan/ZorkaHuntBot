from datetime import date, datetime, timezone

import pytest

from bot.services.forecast_text import conditions_for, format_forecast
from bot.services.weather import (
    WeatherError, hpa_to_mmhg, local_today, parse_forecast, parse_geocoding, wind_direction_name,
)


def test_parse_forecast_sun_times(forecast_json):
    days = parse_forecast(forecast_json)
    d = days[date(2026, 11, 21)]
    assert d.sunrise == datetime(2026, 11, 21, 8, 7)
    assert d.sunset == datetime(2026, 11, 21, 16, 8)


def test_parse_forecast_windows(forecast_json):
    d = parse_forecast(forecast_json)[date(2026, 11, 21)]
    assert d.dawn.wind_speed == pytest.approx(2.0)
    assert d.dawn.wind_gusts == pytest.approx(4.0)
    assert d.dawn.wind_direction == 270
    assert d.dusk.cloud_cover == pytest.approx(40.0)
    assert d.dawn.precipitation == 0


def test_pressure_change_computed(forecast_json):
    # на 21-е рассвет 08:00, 12 часов назад — 20-е 20:00
    forecast_json["hourly"]["pressure_msl"][24 + 8] = 1010.0
    d = parse_forecast(forecast_json)[date(2026, 11, 21)]
    assert d.pressure_change == pytest.approx(-5.0)


def test_pressure_change_none_without_history(forecast_json):
    d = parse_forecast(forecast_json)[date(2026, 11, 20)]
    assert d.pressure_change is None  # нет данных за предыдущие 12 ч


def test_missing_fields_raise():
    with pytest.raises(WeatherError):
        parse_forecast({"hourly": {}})


def test_polar_day_skipped(forecast_json):
    forecast_json["daily"]["sunrise"][0] = None
    assert date(2026, 11, 20) not in parse_forecast(forecast_json)


def test_local_today_uses_offset(forecast_json):
    now = datetime(2026, 11, 20, 22, 30, tzinfo=timezone.utc)  # +3 ч => уже 21-е
    assert local_today(forecast_json, now) == date(2026, 11, 21)


@pytest.mark.parametrize("deg,name", [(0, "С"), (44, "СВ"), (90, "В"), (180, "Ю"), (270, "З"), (350, "С"), (None, "—")])
def test_wind_direction_name(deg, name):
    assert wind_direction_name(deg) == name


def test_hpa_to_mmhg():
    assert hpa_to_mmhg(1013.25) == pytest.approx(760, abs=0.5)
    assert hpa_to_mmhg(None) is None


def test_parse_geocoding():
    raw = {"results": [{"name": "Тверь", "latitude": 56.86, "longitude": 35.9, "country": "Россия", "admin1": "Тверская область"}]}
    p = parse_geocoding(raw)
    assert p.name == "Тверь"
    assert p.title == "Тверь, Тверская область, Россия"
    assert (p.latitude, p.longitude) == (56.86, 35.9)


def test_parse_geocoding_empty():
    assert parse_geocoding({}) is None
    assert parse_geocoding({"results": []}) is None


def test_format_forecast_smoke(forecast_json):
    days = parse_forecast(forecast_json)
    text = format_forecast(days, date(2026, 11, 20), "Тверь")
    assert "Тверь" in text
    assert "21 ноября" in text and "20 ноября" in text
    assert "Восход 08:07" in text
    assert "Оценка дня для выезда" in text


def test_conditions_for_calm_day_scores_high(forecast_json):
    from bot.services.scoring import score_day

    d = parse_forecast(forecast_json)[date(2026, 11, 21)]
    assert score_day(conditions_for(d)).value >= 4
