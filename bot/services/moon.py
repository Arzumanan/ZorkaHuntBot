"""Фаза луны: простая астрономическая формула (средний синодический месяц)."""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, timezone

SYNODIC_MONTH = 29.530588853  # суток
# Опорное новолуние: 2000-01-06 18:14 UTC
_REF_NEW_MOON = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)


@dataclass(frozen=True)
class MoonPhase:
    age_days: float      # возраст луны в сутках, 0..29.53
    illumination: float  # доля освещённого диска, 0..1
    name: str
    emoji: str


def moon_age(moment: datetime) -> float:
    """Возраст луны в сутках на момент времени (naive считается UTC)."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    days = (moment - _REF_NEW_MOON).total_seconds() / 86400.0
    return days % SYNODIC_MONTH


def phase_name(age: float) -> tuple[str, str]:
    """Название и эмодзи фазы по возрасту луны."""
    fraction = (age % SYNODIC_MONTH) / SYNODIC_MONTH
    # 8 секторов, новолуние в центре сектора 0
    idx = int((fraction * 8) + 0.5) % 8
    return [
        ("Новолуние", "🌑"),
        ("Растущий серп", "🌒"),
        ("Первая четверть", "🌓"),
        ("Растущая луна", "🌔"),
        ("Полнолуние", "🌕"),
        ("Убывающая луна", "🌖"),
        ("Последняя четверть", "🌗"),
        ("Убывающий серп", "🌘"),
    ][idx]


def moon_phase(day: date | datetime, hour_utc: int = 12) -> MoonPhase:
    """Фаза луны на дату (по умолчанию на полдень UTC)."""
    if isinstance(day, datetime):
        moment = day
    else:
        moment = datetime(day.year, day.month, day.day, hour_utc, tzinfo=timezone.utc)
    age = moon_age(moment)
    illumination = (1 - math.cos(2 * math.pi * age / SYNODIC_MONTH)) / 2
    name, emoji = phase_name(age)
    return MoonPhase(age_days=age, illumination=illumination, name=name, emoji=emoji)
