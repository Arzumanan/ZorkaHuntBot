"""Утренняя рассылка: чистые функции «слать ли сегодня» и «пора ли слать сейчас»."""
from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_TZ = "Europe/Moscow"
DEFAULT_TIME = "05:00"
WEEKEND = {5, 6}  # суббота, воскресенье
GRACE_MINUTES = 180  # не слать «опоздавшую» рассылку позже чем через 3 часа

TIMEZONES = {
    "Europe/Kaliningrad": "Калининград (UTC+2)",
    "Europe/Moscow": "Москва, Краснодар, Майкоп (UTC+3)",
    "Europe/Samara": "Самара (UTC+4)",
    "Asia/Yekaterinburg": "Екатеринбург (UTC+5)",
    "Asia/Omsk": "Омск (UTC+6)",
    "Asia/Krasnoyarsk": "Красноярск (UTC+7)",
    "Asia/Irkutsk": "Иркутск (UTC+8)",
    "Asia/Yakutsk": "Якутск (UTC+9)",
    "Asia/Vladivostok": "Владивосток (UTC+10)",
    "Asia/Kamchatka": "Камчатка (UTC+12)",
}

_TIME_RE = re.compile(r"^\s*(\d{1,2})[:.](\d{2})\s*$")


def parse_send_time(text: str) -> str | None:
    """'5:30' / '05.30' -> '05:30'; None, если формат неверный."""
    m = _TIME_RE.match(text or "")
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 23 or mi > 59:
        return None
    return f"{h:02d}:{mi:02d}"


def should_send_today(local_date: date, season_open: bool) -> bool:
    """Слать только в субботу и воскресенье и только если в регионе открыт какой-то сезон."""
    return local_date.weekday() in WEEKEND and season_open


def local_now(now_utc: datetime, tz_name: str) -> datetime:
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo(DEFAULT_TZ)
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)
    return now_utc.astimezone(tz)


def is_time_due(now_utc: datetime, tz_name: str, send_time: str, last_sent: str | None) -> tuple[bool, date]:
    """Наступило ли время отправки по часам пользователя (и не слали ли уже сегодня).

    Возвращает (due, local_date).
    """
    now = local_now(now_utc, tz_name)
    today = now.date()
    if last_sent == today.isoformat():
        return False, today
    parsed = parse_send_time(send_time) or DEFAULT_TIME
    h, m = map(int, parsed.split(":"))
    target = datetime.combine(today, time(h, m), tzinfo=now.tzinfo)
    due = target <= now < target + timedelta(minutes=GRACE_MINUTES)
    return due, today


def decide_send(now_utc: datetime, tz_name: str, send_time: str, last_sent: str | None,
                season_open_on) -> tuple[bool, date]:
    """Полное решение. season_open_on(date) -> bool вызывается только если пора по времени и выходной."""
    due, today = is_time_due(now_utc, tz_name, send_time, last_sent)
    if not due or today.weekday() not in WEEKEND:
        return False, today
    return should_send_today(today, bool(season_open_on(today))), today
