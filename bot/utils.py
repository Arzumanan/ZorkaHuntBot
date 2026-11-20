"""Мелкие чистые помощники."""
from __future__ import annotations

from datetime import date, datetime


def parse_date(text: str, today: date | None = None) -> date | None:
    """Принимает 'сегодня', 'вчера', ДД.ММ.ГГГГ, ДД.ММ.ГГ или ГГГГ-ММ-ДД."""
    today = today or date.today()
    t = text.strip().lower()
    if t in {"сегодня", "today"}:
        return today
    if t == "вчера":
        return date.fromordinal(today.toordinal() - 1)
    for fmt in ("%d.%m.%Y", "%d.%m.%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(t, fmt).date()
        except ValueError:
            continue
    return None
