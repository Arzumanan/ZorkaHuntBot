"""ВРЕМЕННО: разовый перенос данных из старой серверной базы (zorka.db) в хранилище Telegram самого пользователя.

Приложение больше ничего не хранит на сервере. Но у автора (и, возможно, друга) в zorka.db остались данные прошлых версий.
Mini App при первом запуске с пустым CloudStorage один раз вызывает:
  GET  /api/legacy-export        — отдаёт данные ЭТОГО пользователя (по подписанной initData), если файл базы существует;
  POST /api/legacy-export/done   — после успешного импорта стирает строки этого пользователя из базы.
Нет файла базы или нет данных у пользователя: 404 и JSON {"error": "no_legacy_db" | "no_legacy_data"}.

Когда все перенесли: удалите этот файл, маршруты в bot/web/server.py, db_path в конфиге и сам zorka.db (см. README).
"""
from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
from contextlib import closing

log = logging.getLogger(__name__)

# Таблицы старой схемы, у которых есть user_id
TABLES = ("users", "user_settings", "places", "trophies", "checklist_items", "consents")


class LegacyMissing(Exception):
    """Нет базы или нет данных пользователя; code уходит клиенту как error."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _connect(path: str) -> sqlite3.Connection:
    if not os.path.isfile(path):
        raise LegacyMissing("no_legacy_db")
    con = sqlite3.connect(path, isolation_level=None)       # autocommit: так работает и VACUUM
    con.row_factory = sqlite3.Row
    return con


def _rows(con: sqlite3.Connection, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    try:
        return con.execute(sql, args).fetchall()
    except sqlite3.OperationalError:       # таблицы нет (база старой версии) — для нас это «пусто»
        return []


def _count(con: sqlite3.Connection, user_id: int) -> int:
    return sum(len(_rows(con, f"SELECT 1 FROM {t} WHERE user_id=?", (user_id,))) for t in TABLES)


def export_user(path: str, user_id: int) -> dict:
    with closing(_connect(path)) as con:
        if _count(con, user_id) == 0:
            raise LegacyMissing("no_legacy_data")
        settings = _rows(con, "SELECT region_code, timezone, hunt_type FROM user_settings WHERE user_id=?", (user_id,))
        location = _rows(con, "SELECT latitude, longitude, place FROM users WHERE user_id=?", (user_id,))
        return {
            "user_id": user_id,
            "settings": dict(settings[0]) if settings else None,
            "location": ({"lat": location[0]["latitude"], "lon": location[0]["longitude"], "place": location[0]["place"]}
                         if location else None),
            "places": [
                {"id": r["id"], "name": r["name"], "lat": r["latitude"], "lon": r["longitude"],
                 "is_default": bool(r["is_default"])}
                for r in _rows(con, "SELECT * FROM places WHERE user_id=? ORDER BY id", (user_id,))],
            "trophies": [
                {"id": r["id"], "date": r["hunt_date"], "place": r["place"], "species": r["species"], "note": r["note"] or ""}
                for r in _rows(con, "SELECT * FROM trophies WHERE user_id=? ORDER BY hunt_date, id", (user_id,))],
            "checklist": [
                {"hunt_type": r["hunt_type"], "category": r["category"], "key": r["key"], "text": r["text"],
                 "checked": bool(r["checked"]), "custom": bool(r["custom"])}
                for r in _rows(con, "SELECT * FROM checklist_items WHERE user_id=? ORDER BY id", (user_id,))],
        }


def delete_user(path: str, user_id: int) -> dict[str, int]:
    """Стирает все строки пользователя; VACUUM, чтобы удалённое не осталось в свободных страницах файла."""
    with closing(_connect(path)) as con:
        if _count(con, user_id) == 0:
            raise LegacyMissing("no_legacy_data")
        removed = {}
        for table in TABLES:
            try:
                removed[table] = con.execute(f"DELETE FROM {table} WHERE user_id=?", (user_id,)).rowcount
            except sqlite3.OperationalError:
                removed[table] = 0
        con.execute("VACUUM")
        return removed


async def export_user_async(path: str, user_id: int) -> dict:
    return await asyncio.to_thread(export_user, path, user_id)


async def delete_user_async(path: str, user_id: int) -> dict[str, int]:
    removed = await asyncio.to_thread(delete_user, path, user_id)
    log.info("Старые данные пользователя %s перенесены и удалены из базы", user_id)
    return removed
