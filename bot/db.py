"""SQLite: локации пользователей и журнал охоты."""
from __future__ import annotations

from dataclasses import dataclass

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    user_id   INTEGER PRIMARY KEY,
    latitude  REAL NOT NULL,
    longitude REAL NOT NULL,
    place     TEXT
);
CREATE TABLE IF NOT EXISTS trophies (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL,
    hunt_date TEXT NOT NULL,
    place    TEXT NOT NULL,
    species  TEXT NOT NULL,
    note     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS user_settings (
    user_id     INTEGER PRIMARY KEY,
    region_code TEXT,
    timezone    TEXT NOT NULL DEFAULT 'Europe/Moscow',
    subscribed  INTEGER NOT NULL DEFAULT 0,
    send_time   TEXT NOT NULL DEFAULT '05:00',
    last_sent   TEXT,
    hunt_type   TEXT NOT NULL DEFAULT 'general'
);
CREATE TABLE IF NOT EXISTS places (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    latitude   REAL NOT NULL,
    longitude  REAL NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_places_user ON places(user_id);
CREATE TABLE IF NOT EXISTS checklist_items (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL,
    hunt_type TEXT NOT NULL,
    category  TEXT NOT NULL,
    key       TEXT,
    text      TEXT NOT NULL,
    checked   INTEGER NOT NULL DEFAULT 0,
    custom    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checklist_user ON checklist_items(user_id, hunt_type);
CREATE INDEX IF NOT EXISTS idx_trophies_user ON trophies(user_id, hunt_date DESC, id DESC);
"""


@dataclass(frozen=True)
class UserLocation:
    latitude: float
    longitude: float
    place: str | None


@dataclass(frozen=True)
class Trophy:
    id: int
    user_id: int
    hunt_date: str  # ISO ГГГГ-ММ-ДД
    place: str
    species: str
    note: str


@dataclass(frozen=True)
class Settings:
    user_id: int
    region_code: str | None = None
    timezone: str = "Europe/Moscow"
    subscribed: bool = False
    send_time: str = "05:00"
    last_sent: str | None = None
    hunt_type: str = "general"


@dataclass(frozen=True)
class Place:
    id: int
    user_id: int
    name: str
    latitude: float
    longitude: float
    is_default: bool


@dataclass(frozen=True)
class ChecklistItem:
    id: int
    category: str
    key: str | None
    text: str
    checked: bool
    custom: bool


class Database:
    def __init__(self, path: str) -> None:
        self.path = path
        self._conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("База данных не подключена: вызовите connect()")
        return self._conn

    # --- локация ---
    async def set_location(self, user_id: int, latitude: float, longitude: float, place: str | None = None) -> None:
        await self.conn.execute(
            "INSERT INTO users(user_id, latitude, longitude, place) VALUES(?,?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET latitude=excluded.latitude, "
            "longitude=excluded.longitude, place=excluded.place",
            (user_id, latitude, longitude, place),
        )
        await self.conn.commit()

    async def get_location(self, user_id: int) -> UserLocation | None:
        async with self.conn.execute(
            "SELECT latitude, longitude, place FROM users WHERE user_id=?", (user_id,)
        ) as cur:
            row = await cur.fetchone()
        return UserLocation(row["latitude"], row["longitude"], row["place"]) if row else None

    # --- журнал ---
    async def add_trophy(self, user_id: int, hunt_date: str, place: str, species: str, note: str = "") -> int:
        cur = await self.conn.execute(
            "INSERT INTO trophies(user_id, hunt_date, place, species, note) VALUES(?,?,?,?,?)",
            (user_id, hunt_date, place, species, note),
        )
        await self.conn.commit()
        return cur.lastrowid

    async def list_trophies(self, user_id: int, limit: int = 10) -> list[Trophy]:
        async with self.conn.execute(
            "SELECT * FROM trophies WHERE user_id=? ORDER BY hunt_date DESC, id DESC LIMIT ?",
            (user_id, limit),
        ) as cur:
            rows = await cur.fetchall()
        return [Trophy(r["id"], r["user_id"], r["hunt_date"], r["place"], r["species"], r["note"]) for r in rows]

    async def delete_trophy(self, user_id: int, trophy_id: int) -> bool:
        cur = await self.conn.execute(
            "DELETE FROM trophies WHERE id=? AND user_id=?", (trophy_id, user_id)
        )
        await self.conn.commit()
        return cur.rowcount > 0

    # --- all trophies (для статистики) ---
    async def all_trophies(self, user_id: int) -> list[Trophy]:
        async with self.conn.execute(
            "SELECT * FROM trophies WHERE user_id=? ORDER BY hunt_date, id", (user_id,)
        ) as cur:
            rows = await cur.fetchall()
        return [Trophy(r["id"], r["user_id"], r["hunt_date"], r["place"], r["species"], r["note"]) for r in rows]

    # --- настройки (регион, рассылка) ---
    async def _ensure_settings(self, user_id: int) -> None:
        await self.conn.execute("INSERT OR IGNORE INTO user_settings(user_id) VALUES(?)", (user_id,))

    async def get_settings(self, user_id: int) -> Settings:
        async with self.conn.execute("SELECT * FROM user_settings WHERE user_id=?", (user_id,)) as cur:
            r = await cur.fetchone()
        if r is None:
            return Settings(user_id=user_id)
        return Settings(r["user_id"], r["region_code"], r["timezone"], bool(r["subscribed"]),
                        r["send_time"], r["last_sent"], r["hunt_type"])

    async def _set_setting(self, user_id: int, column: str, value) -> None:
        assert column in {"region_code", "timezone", "subscribed", "send_time", "last_sent", "hunt_type"}
        await self._ensure_settings(user_id)
        await self.conn.execute(f"UPDATE user_settings SET {column}=? WHERE user_id=?", (value, user_id))
        await self.conn.commit()

    async def set_region(self, user_id: int, code: str) -> None:
        await self._set_setting(user_id, "region_code", code)

    async def set_subscribed(self, user_id: int, value: bool) -> None:
        await self._set_setting(user_id, "subscribed", 1 if value else 0)

    async def set_send_time(self, user_id: int, value: str) -> None:
        await self._set_setting(user_id, "send_time", value)

    async def set_timezone(self, user_id: int, value: str) -> None:
        await self._set_setting(user_id, "timezone", value)

    async def set_last_sent(self, user_id: int, iso_date: str) -> None:
        await self._set_setting(user_id, "last_sent", iso_date)

    async def set_hunt_type(self, user_id: int, value: str) -> None:
        await self._set_setting(user_id, "hunt_type", value)

    async def list_subscribers(self) -> list[Settings]:
        async with self.conn.execute("SELECT * FROM user_settings WHERE subscribed=1") as cur:
            rows = await cur.fetchall()
        return [Settings(r["user_id"], r["region_code"], r["timezone"], True,
                         r["send_time"], r["last_sent"], r["hunt_type"]) for r in rows]

    # --- сохранённые угодья ---
    async def add_place(self, user_id: int, name: str, latitude: float, longitude: float) -> int:
        async with self.conn.execute("SELECT COUNT(*) AS n FROM places WHERE user_id=?", (user_id,)) as cur:
            first = (await cur.fetchone())["n"] == 0
        cur = await self.conn.execute(
            "INSERT INTO places(user_id, name, latitude, longitude, is_default) VALUES(?,?,?,?,?)",
            (user_id, name, latitude, longitude, 1 if first else 0),
        )
        await self.conn.commit()
        return cur.lastrowid

    async def list_places(self, user_id: int) -> list[Place]:
        async with self.conn.execute(
            "SELECT * FROM places WHERE user_id=? ORDER BY is_default DESC, id", (user_id,)
        ) as cur:
            rows = await cur.fetchall()
        return [Place(r["id"], r["user_id"], r["name"], r["latitude"], r["longitude"], bool(r["is_default"])) for r in rows]

    async def get_place(self, user_id: int, place_id: int) -> Place | None:
        async with self.conn.execute("SELECT * FROM places WHERE id=? AND user_id=?", (place_id, user_id)) as cur:
            r = await cur.fetchone()
        return Place(r["id"], r["user_id"], r["name"], r["latitude"], r["longitude"], bool(r["is_default"])) if r else None

    async def get_default_place(self, user_id: int) -> Place | None:
        places = await self.list_places(user_id)
        return places[0] if places and places[0].is_default else (places[0] if places else None)

    async def set_default_place(self, user_id: int, place_id: int) -> bool:
        if await self.get_place(user_id, place_id) is None:
            return False
        await self.conn.execute("UPDATE places SET is_default=0 WHERE user_id=?", (user_id,))
        await self.conn.execute("UPDATE places SET is_default=1 WHERE id=? AND user_id=?", (place_id, user_id))
        await self.conn.commit()
        return True

    async def rename_place(self, user_id: int, place_id: int, name: str) -> bool:
        cur = await self.conn.execute("UPDATE places SET name=? WHERE id=? AND user_id=?", (name, place_id, user_id))
        await self.conn.commit()
        return cur.rowcount > 0

    async def delete_place(self, user_id: int, place_id: int) -> bool:
        place = await self.get_place(user_id, place_id)
        if place is None:
            return False
        await self.conn.execute("DELETE FROM places WHERE id=? AND user_id=?", (place_id, user_id))
        if place.is_default:  # назначаем новое «по умолчанию»
            await self.conn.execute(
                "UPDATE places SET is_default=1 WHERE id=(SELECT id FROM places WHERE user_id=? ORDER BY id LIMIT 1)",
                (user_id,),
            )
        await self.conn.commit()
        return True

    # --- чек-лист ---
    async def seed_checklist(self, user_id: int, hunt_type: str, template: list[tuple[str, str, str]]) -> None:
        """Создаёт пункты шаблона, если для вида охоты ещё нет ни одного (свои пункты сохраняются)."""
        async with self.conn.execute(
            "SELECT COUNT(*) AS n FROM checklist_items WHERE user_id=? AND hunt_type=? AND custom=0",
            (user_id, hunt_type),
        ) as cur:
            if (await cur.fetchone())["n"] > 0:
                return
        await self.conn.executemany(
            "INSERT INTO checklist_items(user_id, hunt_type, category, key, text) VALUES(?,?,?,?,?)",
            [(user_id, hunt_type, c, k, t) for c, k, t in template],
        )
        await self.conn.commit()

    async def list_checklist(self, user_id: int, hunt_type: str, category: str | None = None) -> list[ChecklistItem]:
        sql = "SELECT * FROM checklist_items WHERE user_id=? AND hunt_type=?"
        args: list = [user_id, hunt_type]
        if category:
            sql += " AND category=?"
            args.append(category)
        async with self.conn.execute(sql + " ORDER BY id", args) as cur:
            rows = await cur.fetchall()
        return [ChecklistItem(r["id"], r["category"], r["key"], r["text"], bool(r["checked"]), bool(r["custom"])) for r in rows]

    async def toggle_item(self, user_id: int, item_id: int) -> bool | None:
        async with self.conn.execute(
            "SELECT checked FROM checklist_items WHERE id=? AND user_id=?", (item_id, user_id)
        ) as cur:
            r = await cur.fetchone()
        if r is None:
            return None
        new = 0 if r["checked"] else 1
        await self.conn.execute("UPDATE checklist_items SET checked=? WHERE id=?", (new, item_id))
        await self.conn.commit()
        return bool(new)

    async def add_custom_item(self, user_id: int, hunt_type: str, category: str, text: str) -> int:
        cur = await self.conn.execute(
            "INSERT INTO checklist_items(user_id, hunt_type, category, key, text, custom) VALUES(?,?,?,?,?,1)",
            (user_id, hunt_type, category, None, text),
        )
        await self.conn.commit()
        return cur.lastrowid

    async def delete_custom_item(self, user_id: int, item_id: int) -> bool:
        cur = await self.conn.execute(
            "DELETE FROM checklist_items WHERE id=? AND user_id=? AND custom=1", (item_id, user_id)
        )
        await self.conn.commit()
        return cur.rowcount > 0

    async def reset_checks(self, user_id: int, hunt_type: str) -> None:
        await self.conn.execute(
            "UPDATE checklist_items SET checked=0 WHERE user_id=? AND hunt_type=?", (user_id, hunt_type)
        )
        await self.conn.commit()
