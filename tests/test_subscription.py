from datetime import date, datetime, timezone

import pytest

from bot.services.subscription import (
    decide_send, is_time_due, local_now, parse_send_time, should_send_today,
)

SAT = date(2026, 11, 21)   # суббота
SUN = date(2026, 11, 22)
MON = date(2026, 11, 23)
FRI = date(2026, 11, 20)


@pytest.mark.parametrize("d,open_,expected", [
    (SAT, True, True), (SUN, True, True),
    (SAT, False, False), (SUN, False, False),   # выходной, но сезон закрыт
    (MON, True, False), (FRI, True, False),     # сезон открыт, но будний день
])
def test_should_send_today(d, open_, expected):
    assert should_send_today(d, open_) is expected


@pytest.mark.parametrize("text,expected", [
    ("05:00", "05:00"), ("5:30", "05:30"), ("05.45", "05:45"), (" 23:59 ", "23:59"),
    ("24:00", None), ("12:60", None), ("abc", None), ("", None), ("5", None),
])
def test_parse_send_time(text, expected):
    assert parse_send_time(text) == expected


def utc(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)


def test_local_now_moscow():
    assert local_now(utc(2026, 11, 21, 2, 0), "Europe/Moscow").hour == 5


def test_local_now_bad_tz_falls_back_to_moscow():
    assert local_now(utc(2026, 11, 21, 2, 0), "Mars/Olympus").hour == 5


def test_time_due_window():
    # 05:00 MSK = 02:00 UTC
    assert is_time_due(utc(2026, 11, 21, 1, 59), "Europe/Moscow", "05:00", None)[0] is False
    assert is_time_due(utc(2026, 11, 21, 2, 0), "Europe/Moscow", "05:00", None) == (True, SAT)
    assert is_time_due(utc(2026, 11, 21, 4, 59), "Europe/Moscow", "05:00", None)[0] is True
    assert is_time_due(utc(2026, 11, 21, 5, 1), "Europe/Moscow", "05:00", None)[0] is False   # слишком поздно


def test_not_due_if_already_sent_today():
    assert is_time_due(utc(2026, 11, 21, 2, 5), "Europe/Moscow", "05:00", "2026-11-21")[0] is False
    assert is_time_due(utc(2026, 11, 21, 2, 5), "Europe/Moscow", "05:00", "2026-11-14")[0] is True


def test_user_timezone_is_respected():
    # 05:00 в Екатеринбурге (UTC+5) = 00:00 UTC
    assert is_time_due(utc(2026, 11, 21, 0, 0), "Asia/Yekaterinburg", "05:00", None)[0] is True
    assert is_time_due(utc(2026, 11, 21, 0, 0), "Europe/Moscow", "05:00", None)[0] is False


def test_local_date_can_differ_from_utc_date():
    # 22:30 UTC в пятницу — это уже суббота 01:30 по Москве
    _, local_date = is_time_due(utc(2026, 11, 20, 22, 30), "Europe/Moscow", "01:00", None)
    assert local_date == SAT


def test_decide_send_weekend_in_season():
    assert decide_send(utc(2026, 11, 21, 2, 0), "Europe/Moscow", "05:00", None, lambda d: True) == (True, SAT)


def test_decide_send_not_in_season():
    assert decide_send(utc(2026, 11, 21, 2, 0), "Europe/Moscow", "05:00", None, lambda d: False)[0] is False


def test_decide_send_weekday_never_and_does_not_check_season():
    called = []

    def season(d):
        called.append(d)
        return True

    assert decide_send(utc(2026, 11, 23, 2, 0), "Europe/Moscow", "05:00", None, season)[0] is False  # понедельник
    assert called == []


def test_decide_send_passes_local_date_to_season_check():
    seen = []
    decide_send(utc(2026, 11, 21, 2, 0), "Europe/Moscow", "05:00", None, lambda d: seen.append(d) or True)
    assert seen == [SAT]
