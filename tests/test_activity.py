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
