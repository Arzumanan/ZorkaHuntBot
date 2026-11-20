"""Open-Meteo: прогноз погоды, восход/закат и геокодинг (без ключа API)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

import aiohttp

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
HPA_TO_MMHG = 0.750062

_COMPASS = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"]


class WeatherError(Exception):
    """Не удалось получить или разобрать данные погоды."""


@dataclass(frozen=True)
class Place:
    name: str
    latitude: float
    longitude: float
    country: str | None = None
    region: str | None = None

    @property
    def title(self) -> str:
        parts = [self.name]
        if self.region and self.region != self.name:
            parts.append(self.region)
        if self.country:
            parts.append(self.country)
        return ", ".join(parts)


@dataclass(frozen=True)
class WindowStats:
    """Агрегированные значения за окно вокруг рассвета или заката."""
    temperature: float | None
    wind_speed: float | None
    wind_gusts: float | None
    wind_direction: float | None
    precipitation: float | None
    pressure_hpa: float | None
    cloud_cover: float | None


@dataclass(frozen=True)
class DayForecast:
    day: date
    sunrise: datetime
    sunset: datetime
    dawn: WindowStats
    dusk: WindowStats
    pressure_change: float | None  # гПа: на рассвете минус 12 ч назад
    temp_change: float | None = None  # °C: на рассвете минус то же время сутки назад


def wind_direction_name(degrees: float | None) -> str:
    """Откуда дует ветер, словами (С, СВ, ...)."""
    if degrees is None:
        return "—"
    return _COMPASS[int(((degrees % 360) + 22.5) // 45) % 8]


def hpa_to_mmhg(hpa: float | None) -> float | None:
    return None if hpa is None else hpa * HPA_TO_MMHG


# ---------- разбор ответов ----------

def parse_geocoding(raw: dict[str, Any]) -> Place | None:
    results = raw.get("results") or []
    if not results:
        return None
    r = results[0]
    try:
        return Place(
            name=r["name"],
            latitude=float(r["latitude"]),
            longitude=float(r["longitude"]),
            country=r.get("country"),
            region=r.get("admin1"),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise WeatherError("Некорректный ответ геокодера") from exc


def _avg(values: list[float | None]) -> float | None:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else None


def _window(hourly: dict[str, dict[str, float | None]], center: datetime, before: int, after: int) -> WindowStats:
    base = center.replace(minute=0, second=0, microsecond=0)
    points = []
    for offset in range(-before, after + 1):
        key = (base + timedelta(hours=offset)).strftime("%Y-%m-%dT%H:%M")
        if key in hourly:
            points.append(hourly[key])
    precip_vals = [p["precipitation"] for p in points if p.get("precipitation") is not None]
    gusts = [p["wind_gusts"] for p in points if p.get("wind_gusts") is not None]
    # направление берём по ближайшему к центру часу
    nearest = hourly.get(center.strftime("%Y-%m-%dT%H:00")) or (points[len(points) // 2] if points else {})
    return WindowStats(
        temperature=_avg([p.get("temperature") for p in points]),
        wind_speed=_avg([p.get("wind_speed") for p in points]),
        wind_gusts=max(gusts) if gusts else None,
        wind_direction=nearest.get("wind_direction") if nearest else None,
        precipitation=sum(precip_vals) if precip_vals else None,
        pressure_hpa=_avg([p.get("pressure") for p in points]),
        cloud_cover=_avg([p.get("cloud_cover") for p in points]),
    )


def parse_forecast(raw: dict[str, Any]) -> dict[date, DayForecast]:
    """Разбирает ответ Open-Meteo (hourly + daily sunrise/sunset) в прогноз по датам."""
    try:
        hourly_raw = raw["hourly"]
        daily = raw["daily"]
        times = hourly_raw["time"]
        sunrises = daily["sunrise"]
        sunsets = daily["sunset"]
        days = daily["time"]
    except (KeyError, TypeError) as exc:
        raise WeatherError("Некорректный ответ сервиса погоды") from exc

    def col(name: str) -> list[float | None]:
        return hourly_raw.get(name) or [None] * len(times)

    cols = {
        "temperature": col("temperature_2m"),
        "wind_speed": col("wind_speed_10m"),
        "wind_gusts": col("wind_gusts_10m"),
        "wind_direction": col("wind_direction_10m"),
        "precipitation": col("precipitation"),
        "pressure": col("pressure_msl"),
        "cloud_cover": col("cloud_cover"),
    }
    hourly: dict[str, dict[str, float | None]] = {
        t: {name: values[i] for name, values in cols.items()} for i, t in enumerate(times)
    }

    result: dict[date, DayForecast] = {}
    for d, sr, ss in zip(days, sunrises, sunsets):
        if not sr or not ss:  # полярный день/ночь
            continue
        sunrise = datetime.fromisoformat(sr)
        sunset = datetime.fromisoformat(ss)
        dawn = _window(hourly, sunrise, 1, 2)
        dusk = _window(hourly, sunset, 2, 1)
        p_now = hourly.get(sunrise.replace(minute=0).strftime("%Y-%m-%dT%H:%M"), {}).get("pressure")
        p_before = hourly.get(
            (sunrise.replace(minute=0) - timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M"), {}
        ).get("pressure")
        change = (p_now - p_before) if p_now is not None and p_before is not None else None
        t_now = hourly.get(sunrise.replace(minute=0).strftime("%Y-%m-%dT%H:%M"), {}).get("temperature")
        t_before = hourly.get(
            (sunrise.replace(minute=0) - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M"), {}
        ).get("temperature")
        t_change = (t_now - t_before) if t_now is not None and t_before is not None else None
        result[date.fromisoformat(d)] = DayForecast(
            day=date.fromisoformat(d), sunrise=sunrise, sunset=sunset,
            dawn=dawn, dusk=dusk, pressure_change=change, temp_change=t_change,
        )
    return result


def hourly_series(raw: dict[str, Any], day: date) -> dict[str, list]:
    """Почасовые ряды за сутки (для графиков): время ЧЧ:ММ, температура, ветер, порывы, направление,
    осадки, давление (мм рт. ст.), облачность. Пропуски — None."""
    hourly = raw.get("hourly") or {}
    times = hourly.get("time") or []
    prefix = day.isoformat()
    idx = [i for i, t in enumerate(times) if t.startswith(prefix)]

    def col(name: str) -> list[float | None]:
        values = hourly.get(name) or [None] * len(times)
        return [values[i] for i in idx]

    pressure = col("pressure_msl")
    return {
        "time": [times[i][11:16] for i in idx],
        "temperature": col("temperature_2m"),
        "wind_speed": col("wind_speed_10m"),
        "wind_gusts": col("wind_gusts_10m"),
        "wind_direction": col("wind_direction_10m"),
        "precipitation": col("precipitation"),
        "pressure_mmhg": [None if p is None else round(p * HPA_TO_MMHG, 1) for p in pressure],
        "cloud_cover": col("cloud_cover"),
    }


def local_today(raw: dict[str, Any], now_utc: datetime | None = None) -> date:
    """Сегодняшняя дата в часовом поясе точки (по utc_offset_seconds ответа)."""
    now_utc = now_utc or datetime.now(timezone.utc)
    offset = int(raw.get("utc_offset_seconds", 0) or 0)
    return (now_utc + timedelta(seconds=offset)).date()


# ---------- сетевые вызовы ----------

async def _get_json(session: aiohttp.ClientSession, url: str, params: dict[str, Any]) -> dict[str, Any]:
    try:
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            resp.raise_for_status()
            return await resp.json()
    except (aiohttp.ClientError, TimeoutError) as exc:
        raise WeatherError(f"Сервис погоды недоступен: {exc}") from exc


async def fetch_forecast(session: aiohttp.ClientSession, latitude: float, longitude: float) -> dict[str, Any]:
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "hourly": ",".join([
            "temperature_2m", "precipitation", "pressure_msl", "cloud_cover",
            "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
        ]),
        "daily": "sunrise,sunset",
        "wind_speed_unit": "ms",
        "timezone": "auto",
        "past_days": 1,
        "forecast_days": 3,
    }
    return await _get_json(session, FORECAST_URL, params)


async def geocode_city(session: aiohttp.ClientSession, name: str) -> Place | None:
    raw = await _get_json(
        session, GEOCODING_URL, {"name": name, "count": 1, "language": "ru", "format": "json"}
    )
    return parse_geocoding(raw)
