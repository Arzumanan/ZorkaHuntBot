"""Статика Mini App: одна страница, относительные адреса, без обращений к серверу за данными."""
import re
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from bot.config import Config
from bot.web.server import WEBAPP_DIR, create_app

URL_ATTR = re.compile(r'(?:src|href)="([^"]+)"')


@pytest.fixture
async def client(tmp_path):
    app = create_app(Config(bot_token="1:x", db_path=str(tmp_path / "none.db")))
    async with TestClient(TestServer(app)) as c:
        yield c


def local_assets(html: str) -> list[str]:
    return [u for u in URL_ATTR.findall(html) if not u.startswith(("http://", "https://", "#"))]


async def test_index_is_served_with_no_cache(client):
    resp = await client.get("/")
    assert resp.status == 200 and "Зорька" in await resp.text()
    assert resp.headers["Cache-Control"] == "no-cache"


async def test_healthz(client):
    assert await (await client.get("/healthz")).json() == {"ok": True}


async def test_every_asset_of_index_is_relative_versioned_and_served(client):
    html = (WEBAPP_DIR / "index.html").read_text(encoding="utf-8")
    assets = local_assets(html)
    assert len(assets) >= 15
    versions = set()
    for url in assets:
        assert not url.startswith("/"), f"абсолютный адрес ломает GitHub Pages: {url}"
        path, _, query = url.partition("?")
        assert query.startswith("v="), f"нет версии для сброса кэша: {url}"
        versions.add(query)
        resp = await client.get("/" + path)
        assert resp.status == 200, url
        assert resp.headers["Cache-Control"] == "no-cache"
    assert len(versions) == 1                         # у всех файлов одна версия


async def test_data_files_are_served_as_json(client):
    for name in ("seasons.json", "regions.json", "checklist.json"):
        resp = await client.get(f"/data/{name}")
        assert resp.status == 200
        assert await resp.json()


async def test_unknown_api_path_is_json_404(client):
    resp = await client.get("/api/me")
    assert resp.status == 404 and (await resp.json())["error"] == "not_found"


def test_no_server_routes_are_referenced_by_the_app():
    """Приложение не должно ходить за данными на свой сервер: единственное исключение — временный перенос."""
    offenders = []
    for path in list(WEBAPP_DIR.glob("*.js")) + list(WEBAPP_DIR.glob("lib/*.js")):
        for m in re.finditer(r'["\'`](/api/[^"\'`]*)', path.read_text(encoding="utf-8")):
            if not m.group(1).startswith("/api/legacy-export"):
                offenders.append((path.name, m.group(1)))
    assert offenders == []


def test_webapp_dir_has_no_server_code_or_secrets():
    names = {p.name for p in Path(WEBAPP_DIR).rglob("*") if p.is_file()}
    assert not any(n.endswith((".py", ".env", ".db")) for n in names)
