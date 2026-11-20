import pytest


async def test_location_roundtrip_and_update(db):
    assert await db.get_location(1) is None
    await db.set_location(1, 56.86, 35.9, "Тверь")
    loc = await db.get_location(1)
    assert (loc.latitude, loc.longitude, loc.place) == (56.86, 35.9, "Тверь")
    await db.set_location(1, 55.0, 37.0, None)
    loc = await db.get_location(1)
    assert loc.latitude == 55.0 and loc.place is None


async def test_locations_are_per_user(db):
    await db.set_location(1, 1.0, 2.0, "A")
    await db.set_location(2, 3.0, 4.0, "B")
    assert (await db.get_location(1)).place == "A"
    assert (await db.get_location(2)).place == "B"


async def test_trophy_create_and_list(db):
    tid = await db.add_trophy(1, "2026-11-15", "Тверская обл.", "кабан", "хороший секач")
    assert tid > 0
    items = await db.list_trophies(1)
    assert len(items) == 1
    t = items[0]
    assert (t.hunt_date, t.place, t.species, t.note) == ("2026-11-15", "Тверская обл.", "кабан", "хороший секач")


async def test_journal_limit_and_order(db):
    for i in range(1, 13):
        await db.add_trophy(1, f"2026-11-{i:02d}", "место", f"вид{i}")
    items = await db.list_trophies(1, limit=10)
    assert len(items) == 10
    assert items[0].hunt_date == "2026-11-12"
    assert items[-1].hunt_date == "2026-11-03"


async def test_journal_isolated_per_user(db):
    await db.add_trophy(1, "2026-11-01", "p", "s")
    assert await db.list_trophies(2) == []


async def test_delete_trophy_only_own(db):
    tid = await db.add_trophy(1, "2026-11-01", "p", "s")
    assert await db.delete_trophy(2, tid) is False
    assert await db.delete_trophy(1, tid) is True
    assert await db.list_trophies(1) == []


async def test_closed_db_raises(tmp_path):
    from bot.db import Database

    with pytest.raises(RuntimeError):
        await Database(str(tmp_path / "x.db")).get_location(1)
