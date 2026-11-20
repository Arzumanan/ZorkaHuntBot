from datetime import date

import pytest

from bot.utils import parse_date

TODAY = date(2026, 11, 20)


@pytest.mark.parametrize(
    "text,expected",
    [
        ("сегодня", TODAY),
        ("Вчера", date(2026, 11, 19)),
        ("15.11.2026", date(2026, 11, 15)),
        ("15.11.26", date(2026, 11, 15)),
        ("2026-11-15", date(2026, 11, 15)),
        ("  01.01.2026 ", date(2026, 1, 1)),
    ],
)
def test_parse_date_ok(text, expected):
    assert parse_date(text, TODAY) == expected


@pytest.mark.parametrize("text", ["", "завтра", "31.02.2026", "abc", "15/11/2026"])
def test_parse_date_bad(text):
    assert parse_date(text, TODAY) is None
