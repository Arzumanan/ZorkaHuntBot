"""Сборка текста прогноза «на зорьку» (HTML для Telegram)."""
from __future__ import annotations

from datetime import date

from .activity import DISCLAIMER as ACTIVITY_DISCLAIMER, GROUPS, ActivityInputs, estimate_activity
from .moon import moon_phase
from .scoring import Conditions, Score, score_day
from .weather import DayForecast, WindowStats, hpa_to_mmhg, wind_direction_name

MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
          "августа", "сентября", "октября", "ноября", "декабря"]


def _f(value: float | None, fmt: str = "{:.0f}", unit: str = "") -> str:
    return "—" if value is None else fmt.format(value) + unit


def conditions_for(day: DayForecast) -> Conditions:
    """Объединяет рассвет и закат в одни условия для оценки."""
    windows = [day.dawn, day.dusk]
    speeds = [w.wind_speed for w in windows if w.wind_speed is not None]
    gusts = [w.wind_gusts for w in windows if w.wind_gusts is not None]
    precip = [w.precipitation for w in windows if w.precipitation is not None]
    temps = [w.temperature for w in windows if w.temperature is not None]
    clouds = [w.cloud_cover for w in windows if w.cloud_cover is not None]
    return Conditions(
        wind_speed=sum(speeds) / len(speeds) if speeds else None,
        wind_gusts=max(gusts) if gusts else None,
        precipitation=sum(precip) if precip else None,
        pressure_change=day.pressure_change,
        temperature=sum(temps) / len(temps) if temps else None,
        cloud_cover=sum(clouds) / len(clouds) if clouds else None,
    )


def _window_line(title: str, w: WindowStats) -> str:
    mm = hpa_to_mmhg(w.pressure_hpa)
    return (
        f"<b>{title}</b>\n"
        f"🌡 {_f(w.temperature, '{:+.0f}', '°C')}  "
        f"💨 {_f(w.wind_speed, '{:.1f}', ' м/с')} {wind_direction_name(w.wind_direction)}, "
        f"порывы до {_f(w.wind_gusts, '{:.0f}', ' м/с')}\n"
        f"🌧 осадки {_f(w.precipitation, '{:.1f}', ' мм')}  "
        f"☁️ облачность {_f(w.cloud_cover, '{:.0f}', '%')}  "
        f"📈 {_f(mm, '{:.0f}', ' мм рт. ст.')}"
    )


def stars(score: Score) -> str:
    return "⭐" * score.value + "▫️" * (5 - score.value)


def activity_inputs(day: DayForecast, window: WindowStats, time_of_day: str) -> ActivityInputs:
    return ActivityInputs(
        pressure_change=day.pressure_change,
        wind_speed=window.wind_speed,
        precipitation=window.precipitation,
        temp_change=day.temp_change,
        moon_illumination=moon_phase(day.day).illumination,
        time_of_day=time_of_day,
    )


def activity_lines(day: DayForecast) -> list[str]:
    """Строки активности по группам: утро / вечер."""
    lines = []
    for group, (emoji, title) in GROUPS.items():
        morning = estimate_activity(group, activity_inputs(day, day.dawn, "dawn"))
        evening = estimate_activity(group, activity_inputs(day, day.dusk, "dusk"))
        lines.append(f"{emoji} {title}: утро {morning.value}/5, вечер {evening.value}/5")
    return lines


def format_activity(day: DayForecast, heading: str) -> str:
    moon = moon_phase(day.day)
    out = [f"🐾 <b>{heading}, {day.day.day} {MONTHS[day.day.month - 1]}</b>",
           f"{moon.emoji} {moon.name}, освещено {moon.illumination * 100:.0f}%", ""]
    for group, (emoji, title) in GROUPS.items():
        for tod, label, window in (("dawn", "утро", day.dawn), ("dusk", "вечер", day.dusk)):
            a = estimate_activity(group, activity_inputs(day, window, tod))
            out.append(f"{emoji} {title}, {label}: <b>{a.value}/5</b> ({a.label})")
        reasons = estimate_activity(group, activity_inputs(day, day.dawn, "dawn")).reasons
        out.append("   <i>утром: " + "; ".join(reasons) + "</i>")
    out.append("")
    out.append(f"ℹ️ {ACTIVITY_DISCLAIMER}")
    return "\n".join(out)


def format_day(day: DayForecast, heading: str) -> str:
    moon = moon_phase(day.day)
    score = score_day(conditions_for(day))
    reasons = "; ".join(score.reasons) if score.reasons else "нет данных"
    return (
        f"🦌 <b>{heading}, {day.day.day} {MONTHS[day.day.month - 1]}</b>\n"
        f"🌅 Восход {day.sunrise:%H:%M}   🌇 Закат {day.sunset:%H:%M}\n"
        f"{moon.emoji} {moon.name}, освещено {moon.illumination * 100:.0f}%\n\n"
        f"{_window_line('Утренняя зорька', day.dawn)}\n\n"
        f"{_window_line('Вечерняя зорька', day.dusk)}\n\n"
        f"<b>Оценка дня для выезда: {score.value}/5</b> {stars(score)}\n"
        f"{score.label}. Почему: {reasons}.\n\n"
        f"<b>Активность зверя и птицы</b> (оценка)\n" + "\n".join(activity_lines(day))
    )


def format_forecast(days: dict[date, DayForecast], today: date, place_title: str,
                    only_today: bool = False) -> str:
    from datetime import timedelta

    tomorrow = today + timedelta(days=1)
    blocks = [f"📍 {place_title}"]
    if tomorrow in days and not only_today:
        blocks.append(format_day(days[tomorrow], "Прогноз на зорьку: завтра"))
    if today in days:
        blocks.append(format_day(days[today], "Сегодня"))
    if len(blocks) == 1:
        blocks.append("Нет данных для этого места (возможно, полярный день или ночь).")
    elif len(blocks) > 1:
        blocks.append(f"ℹ️ {ACTIVITY_DISCLAIMER}")
    return "\n\n".join(blocks)


def format_activity_report(days: dict[date, DayForecast], today: date, place_title: str) -> str:
    from datetime import timedelta

    tomorrow = today + timedelta(days=1)
    blocks = [f"📍 {place_title}"]
    if tomorrow in days:
        blocks.append(format_activity(days[tomorrow], "Активность: завтра"))
    if today in days:
        blocks.append(format_activity(days[today], "Сегодня"))
    if len(blocks) == 1:
        blocks.append("Нет данных для этого места.")
    return "\n\n".join(blocks)
