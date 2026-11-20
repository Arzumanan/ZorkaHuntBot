"""Преобразование данных прогноза в JSON для Mini App (чистые функции)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from ..services.activity import DISCLAIMER as ACTIVITY_DISCLAIMER, GROUPS, estimate_activity
from ..services.forecast_text import MONTHS, activity_inputs, conditions_for
from ..services.moon import moon_phase
from ..services.scoring import score_day
from ..services.weather import (
    DayForecast, WindowStats, hourly_series, hpa_to_mmhg, local_today, parse_forecast, wind_direction_name,
)


def _window(w: WindowStats) -> dict:
    mm = hpa_to_mmhg(w.pressure_hpa)
    return {
        "temperature": w.temperature,
        "wind_speed": w.wind_speed,
        "wind_gusts": w.wind_gusts,
        "wind_direction": w.wind_direction,
        "wind_direction_name": wind_direction_name(w.wind_direction),
        "precipitation": w.precipitation,
        "pressure_mmhg": None if mm is None else round(mm, 1),
        "cloud_cover": w.cloud_cover,
    }


def activity_block(day: DayForecast) -> list[dict]:
    result = []
    for group, (emoji, title) in GROUPS.items():
        entry = {"group": group, "emoji": emoji, "title": title}
        for key, window, tod in (("dawn", day.dawn, "dawn"), ("dusk", day.dusk, "dusk")):
            a = estimate_activity(group, activity_inputs(day, window, tod))
            entry[key] = {"value": a.value, "label": a.label, "reasons": a.reasons}
        result.append(entry)
    return result


def day_payload(raw: dict[str, Any], day: DayForecast, label: str) -> dict:
    moon = moon_phase(day.day)
    score = score_day(conditions_for(day))
    return {
        "date": day.day.isoformat(),
        "title": f"{day.day.day} {MONTHS[day.day.month - 1]}",
        "label": label,
        "sunrise": day.sunrise.strftime("%H:%M"),
        "sunset": day.sunset.strftime("%H:%M"),
        "sunrise_hour": day.sunrise.hour + day.sunrise.minute / 60,
        "sunset_hour": day.sunset.hour + day.sunset.minute / 60,
        "moon": {"name": moon.name, "emoji": moon.emoji, "illumination": round(moon.illumination, 3)},
        "score": {"value": score.value, "label": score.label, "reasons": score.reasons},
        "dawn": _window(day.dawn),
        "dusk": _window(day.dusk),
        "pressure_change": day.pressure_change,
        "temp_change": day.temp_change,
        "hourly": hourly_series(raw, day.day),
        "activity": activity_block(day),
    }


def forecast_payload(raw: dict[str, Any], place: dict, now_utc: datetime | None = None) -> dict:
    """Сегодня и завтра для места."""
    days = parse_forecast(raw)
    today = local_today(raw, now_utc or datetime.now(timezone.utc))
    out = []
    for offset, label in ((0, "today"), (1, "tomorrow")):
        d = today + timedelta(days=offset)
        if d in days:
            out.append(day_payload(raw, days[d], label))
    return {"place": place, "today": today.isoformat(), "days": out, "activity_disclaimer": ACTIVITY_DISCLAIMER}
