import pytest

from bot.services.activity import GROUPS, Activity, ActivityInputs, estimate_activity


def best(**kw):
    return ActivityInputs(pressure_change=-3, wind_speed=3, precipitation=0, temp_change=-5,
                          moon_illumination=0.05, time_of_day="dawn", **kw)


@pytest.mark.parametrize("group", list(GROUPS))
def test_value_always_in_range(group):
    for tod in ("dawn", "dusk", "day"):
        for p in (-10, -3, 0, 3, 10):
            for w in (0, 5, 12):
                a = estimate_activity(group, ActivityInputs(p, w, 0, 0, 0.5, tod))
                assert isinstance(a, Activity) and 1 <= a.value <= 5


@pytest.mark.parametrize("group", list(GROUPS))
def test_ideal_conditions_give_high_activity(group):
    assert estimate_activity(group, best()).value >= 4


@pytest.mark.parametrize("group", list(GROUPS))
def test_midday_lower_than_dawn(group):
    dawn = estimate_activity(group, ActivityInputs(time_of_day="dawn"))
    day = estimate_activity(group, ActivityInputs(time_of_day="day"))
    assert day.value < dawn.value


@pytest.mark.parametrize("group", list(GROUPS))
def test_storm_lowers_activity(group):
    calm = estimate_activity(group, ActivityInputs(wind_speed=3, precipitation=0))
    storm = estimate_activity(group, ActivityInputs(wind_speed=14, precipitation=6))
    assert storm.value < calm.value


def test_slowly_falling_pressure_beats_rising():
    falling = estimate_activity("ungulates", ActivityInputs(pressure_change=-3))
    rising = estimate_activity("ungulates", ActivityInputs(pressure_change=+8))
    assert falling.value > rising.value


def test_waterfowl_likes_moderate_wind_upland_does_not():
    wf = estimate_activity("waterfowl", ActivityInputs(wind_speed=6))
    up = estimate_activity("upland", ActivityInputs(wind_speed=8))
    assert any("утка летает" in r for r in wf.reasons)
    assert any("птица сидит" in r for r in up.reasons)


def test_bright_moon_reduces_activity():
    dark = estimate_activity("ungulates", ActivityInputs(moon_illumination=0.05))
    full = estimate_activity("ungulates", ActivityInputs(moon_illumination=0.98))
    assert full.value < dark.value


def test_no_data_does_not_crash():
    a = estimate_activity("upland", ActivityInputs())
    assert 1 <= a.value <= 5 and a.reasons


def test_invalid_args():
    with pytest.raises(ValueError):
        estimate_activity("fish", ActivityInputs())
    with pytest.raises(ValueError):
        estimate_activity("upland", ActivityInputs(time_of_day="night"))


# ---------- фазан и заяц ----------

def calm(**kw):
    base = dict(pressure_change=0, wind_speed=2, precipitation=0, temp_change=0, moon_illumination=0.5,
                temperature=5, fresh_snow=0)
    base.update(kw)
    return base


def act(group, **kw):
    return estimate_activity(group, ActivityInputs(**kw))


def test_new_groups_registered_with_titles():
    assert GROUPS["pheasant"] == ("🐓", "Фазан") and GROUPS["hare"] == ("🐇", "Заяц")
    assert list(GROUPS)[-2:] == ["pheasant", "hare"]


def test_pheasant_dislikes_rain():
    dry = act("pheasant", **calm())
    rain = act("pheasant", **calm(precipitation=3, temperature=8))
    assert rain.value < dry.value
    assert any("дождь — фазан отсиживается" in r for r in rain.reasons)
    drizzle = act("pheasant", **calm(precipitation=0.8, temperature=8))
    assert rain.value <= drizzle.value < dry.value + 1


def test_pheasant_snow_is_worded_as_snow_not_rain():
    snow = act("pheasant", **calm(precipitation=1, temperature=-3))
    assert any("снег — фазан" in r for r in snow.reasons)


def test_pheasant_dislikes_strong_wind():
    still = act("pheasant", **calm(wind_speed=2))
    breeze = act("pheasant", **calm(wind_speed=7))
    gale = act("pheasant", **calm(wind_speed=11))
    assert still.value > breeze.value >= gale.value and still.value > gale.value
    assert any("густом укрытии" in r for r in gale.reasons)


def test_pheasant_active_morning_and_evening_not_midday():
    dawn = act("pheasant", **calm(time_of_day="dawn"))
    dusk = act("pheasant", **calm(time_of_day="dusk"))
    day = act("pheasant", **calm(time_of_day="day"))
    assert dawn.value == dusk.value > day.value
    assert any("кормится у кромок и укрытий" in r for r in dawn.reasons)


def test_pheasant_ignores_moon_and_suffers_in_hard_frost():
    assert act("pheasant", **calm(moon_illumination=0.98)).value == act("pheasant", **calm(moon_illumination=0.05)).value
    assert not any("луна" in r for r in act("pheasant", **calm(moon_illumination=0.98)).reasons)
    frost = act("pheasant", **calm(temperature=-20))
    assert any("сильный мороз" in r for r in frost.reasons)


def test_hare_more_active_at_dusk_than_dawn_and_both_beat_midday():
    dawn = act("hare", **calm(time_of_day="dawn"))
    dusk = act("hare", **calm(time_of_day="dusk"))
    day = act("hare", **calm(time_of_day="day"))
    assert dusk.value > dawn.value > day.value
    assert any("выходит на жировку" in r for r in dusk.reasons)
    assert any("лежит на лёжке" in r for r in day.reasons)


def test_hare_likes_calm_weather_and_dislikes_wind():
    still = act("hare", **calm(wind_speed=2, time_of_day="dusk"))
    windy = act("hare", **calm(wind_speed=8, time_of_day="dusk"))
    gale = act("hare", **calm(wind_speed=12, time_of_day="dusk"))
    assert still.value > windy.value > gale.value or (still.value > gale.value and windy.value >= gale.value)
    assert any("сильный ветер — заяц лежит" in r for r in gale.reasons)


def test_hare_fresh_snow_porosha_raises_activity():
    base = act("hare", **calm(temperature=-3, fresh_snow=0, time_of_day="dawn", moon_illumination=0.5))
    powder = act("hare", **calm(temperature=-3, fresh_snow=1.5, time_of_day="dawn", moon_illumination=0.5))
    assert powder.value > base.value
    assert any("пороша" in r for r in powder.reasons) and not any("пороша" in r for r in base.reasons)


def test_hare_powder_ignored_during_heavy_snowfall_and_for_other_groups():
    heavy = act("hare", **calm(temperature=-3, fresh_snow=3, precipitation=4))
    assert not any("пороша" in r for r in heavy.reasons)
    for group in ("waterfowl", "upland", "ungulates", "pheasant"):
        assert not any("пороша" in r for r in act(group, **calm(temperature=-3, fresh_snow=3)).reasons)


def test_hare_bright_moon_lowers_morning_activity():
    dark = act("hare", **calm(moon_illumination=0.05))
    full = act("hare", **calm(moon_illumination=0.98))
    assert full.value < dark.value
    assert any("заяц кормится всю ночь" in r for r in full.reasons)


@pytest.mark.parametrize("group", ["pheasant", "hare"])
def test_new_groups_never_crash_and_stay_in_range(group):
    for tod in ("dawn", "dusk", "day"):
        for w in (None, 0, 5, 8, 12):
            for p in (None, 0, 1, 5):
                for snow in (None, 0, 2):
                    for temp in (None, -25, 0, 20):
                        a = act(group, wind_speed=w, precipitation=p, time_of_day=tod, fresh_snow=snow, temperature=temp)
                        assert 1 <= a.value <= 5 and a.reasons
