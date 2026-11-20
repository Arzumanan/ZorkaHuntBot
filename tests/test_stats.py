from bot.db import Trophy
from bot.services.stats import compute_stats, format_stats


def t(i, d, place, species):
    return Trophy(i, 1, d, place, species, "")


RECORDS = [
    t(1, "2026-09-12", "Озеро", "Утка"),
    t(2, "2026-09-12", "Озеро", "утка "),      # регистр/пробелы не различаются
    t(3, "2026-10-03", "Лес", "Кабан"),
    t(4, "2026-11-14", "Озеро", "Гусь"),
    t(5, "2025-09-20", "Лес", "Утка"),
]


def test_empty():
    s = compute_stats([])
    assert s.records == 0 and s.trips == 0
    assert "пуста" in format_stats(s)


def test_counts():
    s = compute_stats(RECORDS)
    assert s.records == 5
    assert s.trips == 4   # 12.09.2026 — один выезд


def test_by_species_groups_case_insensitively():
    s = compute_stats(RECORDS)
    assert s.by_species[0] == ("Утка", 3)
    assert dict(s.by_species)["Кабан"] == 1


def test_by_place_and_months():
    s = compute_stats(RECORDS)
    assert s.by_place[0] == ("Озеро", 3)
    assert s.by_month[0] == ("2025-09", 1)
    assert dict(s.by_month)["2026-09"] == 2


def test_best_months_use_month_of_year():
    s = compute_stats(RECORDS)
    assert s.best_months[0] == ("сентябрь", 3)
    assert len(s.best_months) <= 3


def test_format_contains_sections():
    text = format_stats(compute_stats(RECORDS))
    for word in ("Записей", "Выездов", "По дичи", "По угодьям", "По месяцам", "Лучшие месяцы"):
        assert word in text
