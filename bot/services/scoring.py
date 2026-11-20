"""Оценка дня для выезда на охоту (1–5). Чистая функция без сетевых вызовов."""
from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Conditions:
    """Усреднённые условия на зорьке (рассвет и закат)."""
    wind_speed: float | None = None         # м/с, средний
    wind_gusts: float | None = None         # м/с, максимум порывов
    precipitation: float | None = None      # мм за окна зорьки
    pressure_change: float | None = None    # гПа за ~12 ч (положительное — растёт)
    temperature: float | None = None        # °C
    cloud_cover: float | None = None        # %


@dataclass(frozen=True)
class Score:
    value: int
    label: str
    reasons: list[str] = field(default_factory=list)


LABELS = {
    1: "Лучше остаться дома",
    2: "Так себе",
    3: "Нормально",
    4: "Хороший день",
    5: "Отличный день",
}


def score_day(c: Conditions) -> Score:
    points = 5.0
    reasons: list[str] = []

    if c.wind_speed is not None:
        if c.wind_speed <= 3:
            reasons.append("слабый ветер")
        elif c.wind_speed <= 5:
            points -= 0.5
            reasons.append("умеренный ветер")
        elif c.wind_speed <= 8:
            points -= 1.5
            reasons.append("сильный ветер")
        else:
            points -= 2.5
            reasons.append("очень сильный ветер")

    if c.wind_gusts is not None:
        if c.wind_gusts >= 15:
            points -= 1.5
            reasons.append("опасные порывы ветра")
        elif c.wind_gusts >= 10:
            points -= 0.75
            reasons.append("порывистый ветер")

    if c.precipitation is not None:
        if c.precipitation >= 5:
            points -= 2.0
            reasons.append("сильные осадки")
        elif c.precipitation >= 1:
            points -= 1.0
            reasons.append("заметные осадки")
        elif c.precipitation > 0.2:
            points -= 0.3
            reasons.append("небольшие осадки")
        else:
            reasons.append("без осадков")

    if c.pressure_change is not None:
        delta = c.pressure_change
        if abs(delta) >= 6:
            points -= 1.5
            reasons.append("резкий скачок давления" + (" вниз" if delta < 0 else " вверх"))
        elif abs(delta) >= 3:
            points -= 0.5
            reasons.append("давление заметно " + ("падает" if delta < 0 else "растёт"))
        else:
            reasons.append("давление стабильное")

    if c.temperature is not None:
        if c.temperature <= -20:
            points -= 1.0
            reasons.append("сильный мороз")
        elif c.temperature >= 30:
            points -= 1.0
            reasons.append("сильная жара")

    value = max(1, min(5, int(math.floor(points + 0.5))))
    return Score(value=value, label=LABELS[value], reasons=reasons)
