"""Выбор точки для прогноза: сохранённые угодья или текущее место."""
from __future__ import annotations

from dataclasses import dataclass

from ..db import Database


@dataclass(frozen=True)
class Spot:
    key: str          # "p<id>" или "cur"
    title: str
    latitude: float
    longitude: float


async def list_spots(db: Database, user_id: int) -> list[Spot]:
    """Все доступные точки: угодья (по умолчанию первым), затем текущее место."""
    spots = [Spot(f"p{p.id}", f"{'⭐ ' if p.is_default else ''}{p.name}", p.latitude, p.longitude)
             for p in await db.list_places(user_id)]
    loc = await db.get_location(user_id)
    if loc is not None:
        spots.append(Spot("cur", f"📍 {loc.place or 'Моё место'}", loc.latitude, loc.longitude))
    return spots


def pick_spot(spots: list[Spot], key: str | None = None) -> Spot | None:
    """Выбранная точка по ключу; без ключа — угодье по умолчанию, иначе текущее место."""
    if not spots:
        return None
    if key:
        return next((s for s in spots if s.key == key), None)
    return spots[0]
