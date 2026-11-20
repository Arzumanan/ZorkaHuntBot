"""Статистика журнала охоты (чистая функция по списку записей)."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

MONTH_NAMES = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль",
               "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]


@dataclass(frozen=True)
class JournalStats:
    records: int = 0
    trips: int = 0  # уникальные даты
    by_species: list[tuple[str, int]] = field(default_factory=list)
    by_place: list[tuple[str, int]] = field(default_factory=list)
    by_month: list[tuple[str, int]] = field(default_factory=list)       # "2026-11" -> n (по хронологии)
    best_months: list[tuple[str, int]] = field(default_factory=list)    # название месяца года -> n


def _norm(s: str) -> str:
    return " ".join(s.strip().split()).lower()


def _top(counter: Counter, display: dict[str, str]) -> list[tuple[str, int]]:
    return [(display[k], n) for k, n in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))]


def compute_stats(trophies) -> JournalStats:
    """trophies — любые объекты с полями hunt_date (ISO), place, species."""
    items = list(trophies)
    if not items:
        return JournalStats()
    species, places = Counter(), Counter()
    sp_disp, pl_disp = {}, {}
    months, month_of_year = Counter(), Counter()
    for t in items:
        k = _norm(t.species)
        species[k] += 1
        sp_disp.setdefault(k, t.species.strip().capitalize())
        k = _norm(t.place)
        places[k] += 1
        pl_disp.setdefault(k, t.place.strip())
        months[t.hunt_date[:7]] += 1
        month_of_year[int(t.hunt_date[5:7])] += 1
    best = sorted(month_of_year.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    return JournalStats(
        records=len(items),
        trips=len({t.hunt_date for t in items}),
        by_species=_top(species, sp_disp),
        by_place=_top(places, pl_disp),
        by_month=sorted(months.items()),
        best_months=[(MONTH_NAMES[m - 1], n) for m, n in best],
    )


def format_stats(s: JournalStats) -> str:
    if s.records == 0:
        return ("📊 Статистика пока пуста. Журнал ведётся по желанию: добавь запись через /add_trophy — "
                "и здесь появятся итоги.")
    lines = ["📊 <b>Статистика журнала</b>", f"Записей (трофеев): <b>{s.records}</b>", f"Выездов (дней): <b>{s.trips}</b>", ""]

    def block(title: str, rows: list[tuple[str, int]], limit: int = 7) -> None:
        if rows:
            lines.append(f"<b>{title}</b>")
            lines.extend(f"• {name}: {n}" for name, n in rows[:limit])
            lines.append("")

    block("По дичи", s.by_species)
    block("По угодьям", s.by_place)
    block("По месяцам", [(m, n) for m, n in s.by_month][-12:], 12)
    if s.best_months:
        lines.append("<b>Лучшие месяцы</b>")
        lines.extend(f"• {name}: {n}" for name, n in s.best_months)
    return "\n".join(lines).rstrip()
