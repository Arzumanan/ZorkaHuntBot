import pytest

from bot.services.scoring import Conditions, score_day


def test_perfect_day_gets_5():
    s = score_day(Conditions(wind_speed=1.5, wind_gusts=3, precipitation=0, pressure_change=0.5, temperature=5))
    assert s.value == 5
    assert "слабый ветер" in s.reasons
    assert "давление стабильное" in s.reasons


def test_strong_wind_and_rain_gets_low_score():
    s = score_day(Conditions(wind_speed=9, wind_gusts=18, precipitation=6, pressure_change=-7))
    assert s.value == 1
    assert any("осадки" in r for r in s.reasons)


@pytest.mark.parametrize(
    "wind,expected_max",
    [(2, 5), (4, 5), (6, 4), (10, 3)],
)
def test_wind_lowers_score(wind, expected_max):
    s = score_day(Conditions(wind_speed=wind, wind_gusts=wind, precipitation=0, pressure_change=0))
    assert s.value <= expected_max


def test_pressure_drop_penalised():
    calm = score_day(Conditions(wind_speed=1, pressure_change=0))
    drop = score_day(Conditions(wind_speed=1, pressure_change=-8))
    assert drop.value < calm.value
    assert any("давления" in r for r in drop.reasons)


def test_extreme_cold_penalised():
    assert score_day(Conditions(wind_speed=1, temperature=-30)).value < 5


def test_no_data_does_not_crash_and_is_in_range():
    s = score_day(Conditions())
    assert 1 <= s.value <= 5


def test_score_always_within_1_5():
    s = score_day(Conditions(wind_speed=30, wind_gusts=40, precipitation=50, pressure_change=-20, temperature=-40))
    assert s.value == 1
