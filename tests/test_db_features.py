from bot.services.checklist import template_for


async def test_settings_defaults_and_updates(db):
    s = await db.get_settings(7)
    assert (s.region_code, s.timezone, s.subscribed, s.send_time, s.hunt_type) == (None, "Europe/Moscow", False, "05:00", "general")
    await db.set_region(7, "krasnodar")
    await db.set_send_time(7, "04:30")
    await db.set_timezone(7, "Asia/Omsk")
    await db.set_subscribed(7, True)
    s = await db.get_settings(7)
    assert (s.region_code, s.send_time, s.timezone, s.subscribed) == ("krasnodar", "04:30", "Asia/Omsk", True)


async def test_region_persists_across_reconnect(tmp_path):
    from bot.db import Database

    path = str(tmp_path / "persist.db")
    d1 = Database(path)
    await d1.connect()
    await d1.set_region(1, "adygea")
    await d1.close()
    d2 = Database(path)
    await d2.connect()
    assert (await d2.get_settings(1)).region_code == "adygea"
    await d2.close()


async def test_subscribers_listing(db):
    await db.set_subscribed(1, True)
    await db.set_subscribed(2, False)
    await db.set_subscribed(3, True)
    assert {s.user_id for s in await db.list_subscribers()} == {1, 3}


async def test_last_sent(db):
    await db.set_last_sent(1, "2026-11-21")
    assert (await db.get_settings(1)).last_sent == "2026-11-21"


async def test_places_crud_and_default(db):
    a = await db.add_place(1, "Озеро", 45.0, 38.9)
    b = await db.add_place(1, "Лес", 44.6, 40.1)
    places = await db.list_places(1)
    assert [p.name for p in places] == ["Озеро", "Лес"]
    assert places[0].is_default and not places[1].is_default     # первое угодье — по умолчанию
    assert await db.set_default_place(1, b)
    assert (await db.get_default_place(1)).name == "Лес"
    assert [p.name for p in await db.list_places(1)] == ["Лес", "Озеро"]
    assert await db.delete_place(1, b)                            # удалили default -> назначается другое
    assert (await db.get_default_place(1)).id == a
    assert await db.delete_place(1, 9999) is False


async def test_places_isolated_per_user(db):
    p = await db.add_place(1, "Моё", 1.0, 2.0)
    assert await db.list_places(2) == []
    assert await db.delete_place(2, p) is False
    assert await db.set_default_place(2, p) is False
    assert await db.get_place(2, p) is None


async def test_checklist_seed_toggle_reset(db):
    tpl = template_for("waterfowl")
    await db.seed_checklist(1, "waterfowl", tpl)
    await db.seed_checklist(1, "waterfowl", tpl)                  # повторный seed не дублирует
    items = await db.list_checklist(1, "waterfowl")
    assert len(items) == len(tpl)
    assert await db.toggle_item(1, items[0].id) is True
    assert await db.toggle_item(1, items[0].id) is False
    await db.toggle_item(1, items[1].id)
    await db.reset_checks(1, "waterfowl")
    assert not any(i.checked for i in await db.list_checklist(1, "waterfowl"))
    assert await db.toggle_item(2, items[0].id) is None           # чужой пункт


async def test_checklist_custom_items(db):
    await db.seed_checklist(1, "general", template_for("general"))
    cid = await db.add_custom_item(1, "general", "gear", "Термос на 2 л")
    mine = [i for i in await db.list_checklist(1, "general", "gear") if i.custom]
    assert [i.text for i in mine] == ["Термос на 2 л"]
    default_id = (await db.list_checklist(1, "general", "gun"))[0].id
    assert await db.delete_custom_item(1, default_id) is False    # стандартные пункты не удаляются
    assert await db.delete_custom_item(2, cid) is False
    assert await db.delete_custom_item(1, cid) is True


async def test_checklist_separate_per_hunt_type(db):
    await db.seed_checklist(1, "waterfowl", template_for("waterfowl"))
    await db.seed_checklist(1, "ungulates", template_for("ungulates"))
    w = {i.text for i in await db.list_checklist(1, "waterfowl")}
    u = {i.text for i in await db.list_checklist(1, "ungulates")}
    assert w != u


async def test_all_trophies_returns_everything_chronologically(db):
    for i in range(1, 15):
        await db.add_trophy(1, f"2026-10-{i:02d}", "место", "утка")
    items = await db.all_trophies(1)
    assert len(items) == 14 and items[0].hunt_date == "2026-10-01"
