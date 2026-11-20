from datetime import date

import pytest

from bot.services import seasons as S

DATA = S.load_data()


# ---------- правила дат ----------

@pytest.mark.parametrize(
    "rule,year,expected",
    [
        ("sat2-08", 2026, date(2026, 8, 8)),    # вторая суббота августа
        ("sat3-08", 2026, date(2026, 8, 15)),   # третья суббота августа
        ("sat4-09", 2026, date(2026, 9, 26)),   # 4-я суббота сентября (открытие утки в Краснодарском крае)
        ("sat3-01", 2027, date(2027, 1, 16)),
        ("sat3-04", 2026, date(2026, 4, 18)),
        ("sat4-04", 2026, date(2026, 4, 25)),
        ("eom-02", 2027, date(2027, 2, 28)),
        ("eom-02", 2028, date(2028, 2, 29)),    # високосный год
        ("10-15", 2026, date(2026, 10, 15)),
    ],
)
def test_resolve_rule(rule, year, expected):
    assert S.resolve_rule(rule, year) == expected


def test_range_wraps_to_next_year():
    w = S.resolve_range({"start": "09-15", "end": "01-10"}, 2026)
    assert w.start == date(2026, 9, 15) and w.end == date(2027, 1, 10)


def test_range_with_days():
    w = S.resolve_range({"start": "sat2-04", "days": 10}, 2027)
    assert w.start == date(2027, 4, 10) and w.end == date(2027, 4, 19)


def test_range_dog_season_ends_third_saturday_of_january():
    w = S.resolve_range({"start": "sat3-08", "end": "sat3-01"}, 2026)
    assert w.start == date(2026, 8, 15) and w.end == date(2027, 1, 16)


# ---------- статусы ----------

def entry(ranges, **kw):
    return S.SeasonEntry(id="x", category="fur", name="Тест", ranges=tuple(ranges),
                         confidence="federal", source="", **kw)


def test_status_open_and_boundaries():
    e = entry([{"start": "10-01", "end": "01-10"}])
    assert S.entry_status(e, date(2026, 10, 1)).state == "open"
    assert S.entry_status(e, date(2027, 1, 10)).state == "open"   # после смены года
    assert S.entry_status(e, date(2027, 1, 11)).state != "open"


def test_status_upcoming_and_closed():
    e = entry([{"start": "10-01", "end": "01-10"}])
    up = S.entry_status(e, date(2026, 9, 20))
    assert up.state == "upcoming" and up.days == 11 and up.window.start == date(2026, 10, 1)
    far = S.entry_status(e, date(2026, 6, 1))
    assert far.state == "closed" and far.window.start == date(2026, 10, 1)


def test_status_banned_for_closed_entry():
    assert S.entry_status(entry([], closed=True), date(2026, 11, 1)).state == "banned"


def test_two_windows_picks_next():
    e = entry([{"start": "05-20", "end": "06-20"}, {"start": "07-15", "end": "08-15"}])
    assert S.entry_status(e, date(2026, 7, 20)).state == "open"
    st = S.entry_status(e, date(2026, 6, 25))
    assert st.window.start == date(2026, 7, 15)


# ---------- данные регионов ----------

def test_krasnodar_and_adygea_are_first_in_region_picker():
    codes = [r.code for r in S.load_regions()[:2]]
    assert codes == ["krasnodar", "adygea"]


def test_region_codes_unique_and_names_nonempty():
    regions = S.load_regions()
    assert len({r.code for r in regions}) == len(regions) >= 85
    assert all(r.name for r in regions)


def test_search_regions_case_insensitive_and_yo():
    assert [r.code for r in S.search_regions("краснодар")] == ["krasnodar"]
    assert any(r.code == "adygea" for r in S.search_regions("АДЫГЕЯ"))
    assert S.search_regions("") == []
    assert S.search_regions("несуществующий регион") == []


def test_data_integrity():
    sources = DATA["sources"]
    region_codes = {r.code for r in S.load_regions()}
    for e in DATA["federal"]:
        assert e["source"] in sources
    for code, region in DATA["regions"].items():
        assert code in region_codes
        assert region["sources"], f"{code}: нет источников"
        for key in region["sources"]:
            assert key in sources
        ids = [e["id"] for e in region["entries"]]
        assert len(ids) == len(set(ids)), f"{code}: дублируются id"
        for e in region["entries"]:
            assert e["category"] in S.CATEGORY_ORDER
            assert e["source"] in sources, (code, e["id"])
            assert e["confidence"] in S.CONFIDENCE_LABELS
            assert e["closed"] if "closed" in e else e["ranges"], (code, e["id"])
    for s in sources.values():
        assert s["url"].startswith("http")


def test_all_entries_resolve_for_several_years():
    for code in [None, *DATA["regions"]]:
        for e in S.region_entries(code):
            for year in (2026, 2027, 2028):
                for rng in e.ranges:
                    w = S.resolve_range(rng, year)
                    assert w.start <= w.end, (code, e.id, year)


def test_federal_fallback_for_unknown_region():
    entries = {e.id: e for e in S.region_entries("samarskaya_oblast")}
    assert entries["waterfowl"].confidence == "federal"
    assert not S.is_verified("samarskaya_oblast")
    assert entries["boar"].ranges[0] == {"start": "06-01", "end": "eom-02"}


def test_region_entry_overrides_federal():
    entries = {e.id: e for e in S.region_entries("krasnodar")}
    assert entries["waterfowl"].ranges[0]["start"] == "sat4-09"      # региональный срок
    assert entries["spring_frame"].closed                            # весенняя охота запрещена
    assert entries["roe"].ranges[0] == {"start": "10-01", "end": "01-10"}


def test_krasnodar_waterfowl_opens_26_sept_2026():
    e = {e.id: e for e in S.region_entries("krasnodar")}["waterfowl"]
    assert S.entry_status(e, date(2026, 9, 25)).state != "open"
    assert S.entry_status(e, date(2026, 9, 26)).state == "open"
    assert S.entry_status(e, date(2027, 1, 20)).state == "open"
    assert S.entry_status(e, date(2027, 1, 21)).state != "open"


def test_adygea_boar_regional_dates():
    e = {e.id: e for e in S.region_entries("adygea")}["boar"]
    assert S.entry_status(e, date(2026, 6, 19)).state != "open"
    assert S.entry_status(e, date(2026, 6, 20)).state == "open"
    assert S.entry_status(e, date(2027, 1, 21)).state != "open"


def test_moscow_oblast_spring_window_2027():
    e = {e.id: e for e in S.region_entries("moscow_oblast")}["spring_south"]
    assert S.entry_status(e, date(2027, 4, 10)).state == "open"
    assert S.entry_status(e, date(2027, 4, 19)).state == "open"
    assert S.entry_status(e, date(2027, 4, 20)).state != "open"


# ---------- «открыт ли какой-то сезон» ----------

def test_season_open_in_november_and_closed_in_april_for_federal_region():
    assert S.season_open("samarskaya_oblast", date(2026, 11, 21))
    assert not S.season_open("samarskaya_oblast", date(2027, 4, 4))   # рамки весенней охоты не считаются


def test_frame_and_closed_entries_do_not_count_as_open():
    names = {e.id for e in S.open_entries("krasnodar", date(2027, 4, 4))}
    assert "spring_frame" not in names


# ---------- текст ----------

def test_format_seasons_for_unverified_region_has_disclaimer_and_sources():
    text = "\n".join(S.format_seasons("samarskaya_oblast", date(2026, 11, 20)))
    assert "федеральные сроки" in text
    assert "региональном охотуправлении" in text
    assert "base.garant.ru" in text


def test_format_seasons_for_krasnodar_lists_sources_and_urls():
    text = "\n".join(S.format_seasons("krasnodar", date(2026, 11, 20)))
    assert "Краснодарский край" in text
    assert "krasnodar-gov.ru/doc/61309" in text
    assert "26.09.2026" in text
    assert "региональном охотуправлении" in text


def test_format_seasons_parts_fit_telegram_limit():
    for code in ["krasnodar", "adygea", "moscow_oblast", "tver", "moscow"]:
        for part in S.format_seasons(code, date(2026, 11, 20)):
            assert len(part) < 4096, code
