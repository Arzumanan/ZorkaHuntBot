"""Оценка активности зверя и птицы (1–5). Эвристика, а не наука: чистая функция без сети.

Правила (ориентиры из охотничьей практики):
 • давление: медленное падение перед сменой погоды — зверь и птица кормятся активнее;
   резкий скачок или быстрый рост — активность падает;
 • ветер: у каждой группы свой комфортный диапазон; сильный ветер прижимает всех;
 • осадки: сильный дождь или снег снижают активность (особенно у боровой дичи и копытных);
 • смена температуры: резкая — минус; похолодание подталкивает перелёт и кормёжку;
 • луна: яркая ночь — зверь кормится ночью, на зорьке менее активен;
 • время суток: утро и вечер — пик активности, середина дня — спад;
 • фазан: не любит дождь и сильный ветер, держится у кромок и укрытий, кормится утром и вечером;
 • заяц: активнее в сумерки и ночью (вечер сильнее утра), любит тихую погоду, сильный ветер и ливень
   заставляют лежать; свежий снег ночью («пороша») повышает активность и делает следы читаемыми.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

GROUPS = {
    "waterfowl": ("🦆", "Водоплавающая дичь"),
    "upland": ("🐦", "Боровая дичь"),
    "ungulates": ("🐗", "Копытные"),
    "pheasant": ("🐓", "Фазан"),
    "hare": ("🐇", "Заяц"),
}
LABELS = {1: "очень низкая", 2: "низкая", 3: "средняя", 4: "высокая", 5: "очень высокая"}
TIMES_OF_DAY = ("dawn", "dusk", "day")

DISCLAIMER = "Это ориентировочная оценка по правилам, а не гарантия: реальная активность зависит от угодья, пресса охоты и корма."


@dataclass(frozen=True)
class ActivityInputs:
    pressure_change: float | None = None  # гПа за ~12 ч
    wind_speed: float | None = None       # м/с
    precipitation: float | None = None    # мм
    temp_change: float | None = None      # °C к тому же времени вчера
    moon_illumination: float | None = None  # 0..1
    time_of_day: str = "dawn"             # dawn | dusk | day
    temperature: float | None = None      # °C в окне зорьки (отличает снег от дождя)
    fresh_snow: float | None = None       # мм осадков при t≤0,5 °C за ~10 ч до зорьки («пороша»)


@dataclass(frozen=True)
class Activity:
    value: int
    label: str
    reasons: list[str] = field(default_factory=list)


def estimate_activity(group: str, c: ActivityInputs) -> Activity:
    if group not in GROUPS:
        raise ValueError(f"Неизвестная группа: {group}")
    if c.time_of_day not in TIMES_OF_DAY:
        raise ValueError(f"Неизвестное время суток: {c.time_of_day}")

    points = 3.0
    reasons: list[str] = []

    # время суток
    if group == "hare":
        if c.time_of_day == "dusk":
            points += 1.5
            reasons.append("вечер — заяц выходит на жировку")
        elif c.time_of_day == "dawn":
            points += 0.5
            reasons.append("утро — заяц ещё кормится, к рассвету ложится на лёжку")
        else:
            points -= 1.0
            reasons.append("день — заяц лежит на лёжке")
    elif c.time_of_day in ("dawn", "dusk"):
        points += 1.0
        reasons.append("утро и вечер — фазан кормится у кромок и укрытий" if group == "pheasant"
                       else "зорька — пик активности")
    else:
        points -= 0.5
        reasons.append("середина дня — спад активности")

    # давление
    d = c.pressure_change
    if d is not None:
        if -6 <= d <= -1.5:
            points += 1.0
            reasons.append("давление медленно падает — кормятся активнее")
        elif d < -6:
            points += 0.5 if group == "waterfowl" else -0.5
            reasons.append("резкое падение давления" + (" — птица в движении" if group == "waterfowl" else " — затаиваются"))
        elif 1.5 <= d <= 6:
            points -= 0.5
            reasons.append("давление растёт — активность чуть ниже")
        elif d > 6:
            points -= 1.0
            reasons.append("быстрый рост давления — активность низкая")
        else:
            reasons.append("давление стабильное")

    # ветер (комфортные пределы по группам)
    w = c.wind_speed
    if w is not None:
        if group == "waterfowl":
            if 3 <= w <= 8:
                points += 0.5
                reasons.append("ветер 3–8 м/с — утка летает активно")
            elif w > 10:
                points -= 1.0
                reasons.append("сильный ветер — птица прижимается к укрытиям")
        elif group == "upland":
            if w <= 4:
                points += 0.5
                reasons.append("тихо — боровая дичь активна")
            elif w > 6:
                points -= 1.0
                reasons.append("ветер мешает — птица сидит")
        elif group == "pheasant":
            if w <= 4:
                points += 0.5
                reasons.append("тихо — фазан выходит кормиться")
            elif w > 9:
                points -= 1.5
                reasons.append("сильный ветер — фазан прячется в густом укрытии")
            elif w > 6:
                points -= 1.0
                reasons.append("ветер — фазан держится ближе к укрытию")
        elif group == "hare":
            if w <= 4:
                points += 0.5
                reasons.append("тихо — заяц спокойно кормится")
            elif w > 10:
                points -= 1.5
                reasons.append("сильный ветер — заяц лежит и не выходит")
            elif w > 7:
                points -= 1.0
                reasons.append("ветер тревожит зайца — меньше ходит")
        else:  # ungulates
            if w <= 4:
                points += 0.5
                reasons.append("тихо — зверь выходит на кормёжку")
            elif w > 8:
                points -= 1.0
                reasons.append("сильный ветер — зверь в укрытиях")

    # осадки
    p = c.precipitation
    if p is not None:
        snowing = c.temperature is not None and c.temperature <= 0.5
        if group == "pheasant" and p >= 0.5:
            points -= 1.5 if p >= 2 else 1.0
            reasons.append(("снег" if snowing else "дождь") + " — фазан отсиживается в укрытии")
        elif p >= 2:
            points -= 0.5 if group == "waterfowl" else 1.0
            reasons.append("заметные осадки снижают активность")
        elif p > 0.2:
            reasons.append("небольшие осадки")
        else:
            reasons.append("без осадков")

    # свежий снег: пороша (заяц)
    if group == "hare" and c.fresh_snow is not None and c.fresh_snow >= 0.3 and (p is None or p < 2):
        points += 1.0
        reasons.append("пороша — свежий снег ночью: заяц ходит, следы читаются")

    # температура
    t = c.temp_change
    if t is not None:
        if t <= -4 and group in ("waterfowl", "ungulates"):
            points += 0.5
            reasons.append("похолодание — подталкивает перелёт и кормёжку")
        elif abs(t) >= 6:
            points -= 0.5
            reasons.append("резкая смена температуры")
    if group == "pheasant" and c.temperature is not None and c.temperature <= -15:
        points -= 0.5
        reasons.append("сильный мороз — фазан малоподвижен")

    # луна
    m = c.moon_illumination
    if m is not None and group != "pheasant":    # фазан ночью спит на присаде — луна не важна
        if m >= 0.85:
            points -= 0.5
            reasons.append("яркая луна — " + ("заяц кормится всю ночь, к утру менее активен" if group == "hare"
                                              else "зверь кормится ночью"))
        elif m <= 0.15:
            points += 0.5
            reasons.append("тёмные ночи — днём и на зорьке активнее")

    value = max(1, min(5, int(math.floor(points + 0.5))))
    return Activity(value=value, label=LABELS[value], reasons=reasons)
