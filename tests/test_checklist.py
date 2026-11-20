import pytest

from bot.services.checklist import CATEGORIES, HUNT_TYPES, template_for, weather_hints


@pytest.mark.parametrize("hunt_type", list(HUNT_TYPES))
def test_template_has_all_four_categories_and_unique_keys(hunt_type):
    items = template_for(hunt_type)
    assert {c for c, _, _ in items} == set(CATEGORIES)
    keys = [(c, k) for c, k, _ in items]
    assert len(keys) == len(set(keys))


def test_required_documents_present():
    texts = " ".join(t for c, _, t in template_for("general") if c == "docs").lower()
    for word in ("охотничий билет", "разрешение на хранение и ношение оружия", "путёвка", "разрешение на добычу", "паспорт"):
        assert word in texts


def test_type_specific_items():
    assert any("чучела" in t.lower() for _, _, t in template_for("waterfowl"))
    assert any("световозвращающая" in t.lower() for _, _, t in template_for("ungulates"))
    assert not any("чучела" in t.lower() for _, _, t in template_for("ungulates"))


def test_unknown_type_falls_back_to_general():
    assert template_for("???") == template_for("general")


def test_rain_hint():
    assert any("дождевик" in h for h in weather_hints(temperature=8, precipitation=3))


def test_snow_hint_when_freezing():
    h = weather_hints(temperature=-3, precipitation=2)
    assert any("снег" in x.lower() for x in h) and not any("дождевик" in x for x in h)


def test_cold_heat_and_wind_hints():
    assert any("мороз" in h for h in weather_hints(temperature=-15))
    assert any("комаров" in h for h in weather_hints(temperature=25))
    assert any("ветер" in h.lower() for h in weather_hints(wind_speed=10))
    assert any("ветер" in h.lower() for h in weather_hints(wind_gusts=14))


def test_no_hints_for_mild_weather_and_no_data():
    assert weather_hints(temperature=10, precipitation=0, wind_speed=2, wind_gusts=4) == []
    assert weather_hints() == []
