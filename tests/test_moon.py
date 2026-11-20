from datetime import date, datetime, timezone

from bot.services.moon import moon_phase


def test_known_new_moon():
    # новолуние 2024-01-11 ~11:57 UTC
    p = moon_phase(datetime(2024, 1, 11, 12, tzinfo=timezone.utc))
    assert p.name == "Новолуние"
    assert p.illumination < 0.02


def test_known_full_moon():
    # полнолуние 2024-01-25 ~17:54 UTC
    p = moon_phase(datetime(2024, 1, 25, 18, tzinfo=timezone.utc))
    assert p.name == "Полнолуние"
    assert p.illumination > 0.98


def test_first_quarter():
    # первая четверть 2024-01-18 ~03:53 UTC
    p = moon_phase(datetime(2024, 1, 18, 4, tzinfo=timezone.utc))
    assert p.name == "Первая четверть"
    assert 0.35 < p.illumination < 0.65  # средняя луна даёт погрешность до ~1 суток


def test_accepts_date_and_age_in_range():
    for offset in range(0, 60):
        p = moon_phase(date.fromordinal(date(2026, 1, 1).toordinal() + offset))
        assert 0 <= p.age_days < 29.6
        assert 0 <= p.illumination <= 1
