"""Сроки охоты по регионам: данные в bot/data/seasons.json, расчёт дат — чистые функции.

Формат дат в JSON:
  "MM-DD"      — фиксированная дата (например "10-15");
  "satN-MM"    — N-я суббота месяца MM (например "sat3-08" — третья суббота августа);
  "eom-MM"     — последний день месяца MM (например "eom-02" — 28 или 29 февраля).
Если конец раньше начала, сезон переходит на следующий год.
У диапазона может быть "days" вместо "end" (N календарных дней от начала).
Запись региона с тем же "id", что и в "federal", заменяет федеральную.
"""
from __future__ import annotations

import calendar
import json
from dataclasses import dataclass
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

CATEGORY_TITLES = {
    "spring": "🌱 Весенняя охота на пернатую дичь",
    "birds": "🦆 Летне-осенняя охота на пернатую дичь",
    "ungulates": "🐗 Копытные (кабан, лось, косуля, олень)",
    "fur": "🦊 Пушные звери",
}
CATEGORY_ORDER = ["spring", "birds", "ungulates", "fur"]

CONFIDENCE_LABELS = {
    "federal": "федеральные правила",
    "regional_official": "региональный акт",
    "regional_reported": "по сообщениям (проверьте)",
}

DISCLAIMER = "Точные сроки уточняйте в региональном охотуправлении / указе губернатора."


@dataclass(frozen=True)
class Region:
    code: str
    name: str


@dataclass(frozen=True)
class Window:
    start: date
    end: date

    def contains(self, d: date) -> bool:
        return self.start <= d <= self.end


@dataclass(frozen=True)
class SeasonEntry:
    id: str
    category: str
    name: str
    ranges: tuple[dict, ...]
    confidence: str
    source: str
    note: str | None = None
    closed: bool = False
    frame: bool = False


# ---------- загрузка ----------

@lru_cache(maxsize=1)
def load_data() -> dict:
    with open(DATA_DIR / "seasons.json", encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def load_regions() -> tuple[Region, ...]:
    with open(DATA_DIR / "regions.json", encoding="utf-8") as f:
        return tuple(Region(r["code"], r["name"]) for r in json.load(f))


def get_region(code: str | None) -> Region | None:
    if not code:
        return None
    return next((r for r in load_regions() if r.code == code), None)


def search_regions(query: str) -> list[Region]:
    q = query.strip().lower().replace("ё", "е")
    if not q:
        return []
    return [r for r in load_regions() if q in r.name.lower().replace("ё", "е")]


# ---------- правила дат ----------

def nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """N-й день недели (0=пн … 5=сб) месяца."""
    first = date(year, month, 1)
    delta = (weekday - first.weekday()) % 7
    return first + timedelta(days=delta + 7 * (n - 1))


def resolve_rule(rule: str, year: int) -> date:
    if rule.startswith("sat"):
        n, month = rule[3:].split("-")
        return nth_weekday(year, int(month), 5, int(n))
    if rule.startswith("eom-"):
        month = int(rule[4:])
        return date(year, month, calendar.monthrange(year, month)[1])
    month, day = rule.split("-")
    return date(year, int(month), int(day))


def resolve_range(rng: dict, year: int) -> Window:
    """Окно сезона, который НАЧИНАЕТСЯ в году year."""
    start = resolve_rule(rng["start"], year)
    if rng.get("days"):
        return Window(start, start + timedelta(days=int(rng["days"]) - 1))
    end = resolve_rule(rng["end"], year)
    if end < start:
        end = resolve_rule(rng["end"], year + 1)
    return Window(start, end)


# ---------- записи региона ----------

def _to_entry(raw: dict) -> SeasonEntry:
    return SeasonEntry(
        id=raw["id"], category=raw["category"], name=raw["name"],
        ranges=tuple(raw.get("ranges", [])), confidence=raw.get("confidence", "federal"),
        source=raw.get("source", ""), note=raw.get("note"),
        closed=bool(raw.get("closed")), frame=bool(raw.get("frame")),
    )


def region_entries(code: str | None, data: dict | None = None) -> list[SeasonEntry]:
    """Федеральные записи, поверх которых лежат записи региона (по id)."""
    data = data or load_data()
    merged: dict[str, dict] = {e["id"]: e for e in data["federal"]}
    order = [e["id"] for e in data["federal"]]
    region = data["regions"].get(code or "")
    if region:
        for e in region["entries"]:
            if e["id"] not in merged:
                order.append(e["id"])
            merged[e["id"]] = e
    return [_to_entry(merged[i]) for i in order]


def is_verified(code: str | None, data: dict | None = None) -> bool:
    data = data or load_data()
    return bool(data["regions"].get(code or "", {}).get("verified"))


def entry_windows(entry: SeasonEntry, around: date) -> list[Window]:
    """Окна записи, которые могут быть актуальны вокруг даты (годы -1, 0, +1)."""
    windows: list[Window] = []
    for rng in entry.ranges:
        for y in (around.year - 1, around.year, around.year + 1):
            windows.append(resolve_range(rng, y))
    windows.sort(key=lambda w: w.start)
    return windows


@dataclass(frozen=True)
class Status:
    state: str            # open | upcoming | closed | banned
    window: Window | None  # текущее (open) или ближайшее (upcoming/closed) окно
    days: int | None = None  # дней до открытия (upcoming)


UPCOMING_DAYS = 30


def entry_status(entry: SeasonEntry, today: date) -> Status:
    if entry.closed or not entry.ranges:
        return Status("banned", None)
    windows = entry_windows(entry, today)
    for w in windows:
        if w.contains(today):
            return Status("open", w)
    future = [w for w in windows if w.start > today]
    nxt = future[0] if future else None
    if nxt is None:
        return Status("closed", None)
    delta = (nxt.start - today).days
    return Status("upcoming" if delta <= UPCOMING_DAYS else "closed", nxt, delta)


def open_entries(code: str | None, on: date, data: dict | None = None) -> list[SeasonEntry]:
    """Записи с реально открытым сезоном (рамки и запреты не считаются)."""
    result = []
    for e in region_entries(code, data):
        if e.frame or e.closed:
            continue
        if entry_status(e, on).state == "open":
            result.append(e)
    return result


def season_open(code: str | None, on: date, data: dict | None = None) -> bool:
    return bool(open_entries(code, on, data))


# ---------- текст ----------

def _fmt(d: date) -> str:
    return f"{d.day:02d}.{d.month:02d}"


def _fmt_full(d: date) -> str:
    return f"{d.day:02d}.{d.month:02d}.{d.year}"


def _ranges_text(entry: SeasonEntry, today: date) -> str:
    """Ближайшие окна записи для показа (в текущем или следующем сезоне)."""
    wins = entry_windows(entry, today)
    shown = []
    for w in wins:
        if w.end >= today and w.start <= today + timedelta(days=366):
            shown.append(w)
    shown = shown[: len(entry.ranges)] or wins[-1:]
    return "; ".join(f"{_fmt_full(w.start)} — {_fmt_full(w.end)}" for w in shown)


def format_entry(entry: SeasonEntry, today: date) -> str:
    st = entry_status(entry, today)
    name = entry.name
    if st.state == "banned":
        line = f"⛔ <b>{name}</b>: {entry.note or 'охота не открывается'}"
        return line
    if entry.frame:
        w = resolve_range(entry.ranges[0], today.year)
        return (f"🔸 <b>{name}</b>: рамки {_fmt(w.start)} — {_fmt(w.end)}"
                + (f"\n   <i>{entry.note}</i>" if entry.note else ""))
    if st.state == "open":
        icon, tail = "🟢", f"открыт, до {_fmt_full(st.window.end)}"
    elif st.state == "upcoming":
        icon, tail = "🟡", f"откроется {_fmt_full(st.window.start)} (через {st.days} дн.)"
    else:
        icon, tail = "⚪", "закрыт"
        if st.window:
            tail += f", следующий — с {_fmt_full(st.window.start)}"
    mark = " · <i>по сообщениям, проверьте</i>" if entry.confidence == "regional_reported" else ""
    line = f"{icon} <b>{name}</b>: {tail}{mark}\n   {_ranges_text(entry, today)}"
    if entry.note:
        line += f"\n   <i>{entry.note}</i>"
    return line


def format_seasons(code: str, today: date, data: dict | None = None) -> list[str]:
    """Сообщения для /seasons (несколько частей, чтобы влезть в лимит Telegram)."""
    data = data or load_data()
    region = get_region(code)
    title = region.name if region else code
    verified = is_verified(code, data)
    entries = region_entries(code, data)

    head = [f"📅 <b>Сроки охоты: {title}</b>", f"Сегодня {_fmt_full(today)}."]
    if verified:
        head.append(data["regions"][code]["summary"])
    else:
        head.append(
            "Для этого региона нет проверенных региональных дат — показаны <b>федеральные сроки</b> "
            "(приказ Минприроды № 477). " + DISCLAIMER
        )
    head.append("Легенда: 🟢 открыт · 🟡 скоро · ⚪ закрыт · ⛔ не открывается / запрещено · 🔸 рамки.")
    parts = ["\n".join(head)]

    for cat in CATEGORY_ORDER:
        items = [e for e in entries if e.category == cat]
        if not items:
            continue
        # в категории «весна» рамки показываем только если нет региональных периодов
        if cat == "spring" and any(not e.frame for e in items):
            items = [e for e in items if not e.frame]
        lines = [CATEGORY_TITLES[cat]] + [format_entry(e, today) for e in items]
        parts.append(lines[0] + "\n\n" + "\n\n".join(lines[1:]))

    tail = []
    if verified and data["regions"][code].get("notes"):
        tail.append("ℹ️ " + data["regions"][code]["notes"])
    if verified:
        tail.append("⚠️ " + DISCLAIMER)
    srcs = data["regions"][code]["sources"] if verified else []
    src_keys = list(dict.fromkeys(srcs + ["fed_birds", "fed_ungulates", "fed_fur"]))
    tail.append("Источники:\n" + "\n".join(
        f"• {data['sources'][k]['title']}\n  {data['sources'][k]['url']}" for k in src_keys))
    tail.append("Расшифровка пометок: «региональный акт» — текст акта региона прочитан; "
                "«по сообщениям» — из региональных СМИ/справочных сайтов, проверьте. "
                "Это справка, а не юридический документ.")
    parts.append("\n\n".join(tail))
    return parts
