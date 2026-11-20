"""Веб-сервер: раздаёт статику Mini App (webapp/) и временные маршруты переноса старых данных.

Приложение полностью клиентское (данные в CloudStorage Telegram, погода напрямую из Open-Meteo), поэтому сервер нужен только
если вы хостите webapp/ у себя (например, через туннель cloudflared). С GitHub Pages он не обязателен.
"""
from __future__ import annotations

import logging

from aiohttp import web

from .. import legacy
from ..config import BASE_DIR, Config
from .auth import InitDataError, validate_init_data

log = logging.getLogger(__name__)

WEBAPP_DIR = BASE_DIR / "webapp"
INIT_HEADER = "X-Telegram-Init-Data"


def json_error(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": code, "message": message}, status=status)


# ---------- middleware ----------

@web.middleware
async def cors_middleware(request: web.Request, handler):
    origin = request.app["config"].webapp_cors_origin
    if not origin or not request.path.startswith("/api/"):
        return await handler(request)
    resp = web.Response(status=204) if request.method == "OPTIONS" else await handler(request)
    resp.headers["Access-Control-Allow-Origin"] = origin
    resp.headers["Access-Control-Allow-Headers"] = f"Content-Type, {INIT_HEADER}"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Vary"] = "Origin"
    return resp


@web.middleware
async def error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except Exception:
        log.exception("Ошибка веб-сервера")
        return json_error(500, "internal", "Внутренняя ошибка.")


@web.middleware
async def no_cache(request: web.Request, handler):
    resp = await handler(request)
    if not request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache"     # Telegram не должен показывать устаревшие файлы приложения
    return resp


# ---------- ВРЕМЕННО: перенос старых данных ----------

def _user_id(request: web.Request) -> int:
    """Пользователь из подписанной initData; без неё или с чужой подписью — 401."""
    try:
        return validate_init_data(request.headers.get(INIT_HEADER, ""), request.app["config"].bot_token).id
    except InitDataError as exc:
        log.info("initData отклонена: %s", exc)
        raise web.HTTPUnauthorized(
            text=json_error(401, "unauthorized", "Откройте Mini App из Telegram.").text, content_type="application/json")


async def legacy_export(request: web.Request) -> web.Response:
    uid = _user_id(request)
    try:
        data = await legacy.export_user_async(request.app["config"].db_path, uid)
    except legacy.LegacyMissing as exc:
        return json_error(404, exc.code, "Старых данных нет.")
    return web.json_response(data, headers={"Cache-Control": "no-store"})


async def legacy_done(request: web.Request) -> web.Response:
    uid = _user_id(request)
    try:
        removed = await legacy.delete_user_async(request.app["config"].db_path, uid)
    except legacy.LegacyMissing as exc:
        return json_error(404, exc.code, "Старых данных нет.")
    return web.json_response({"ok": True, "removed": removed}, headers={"Cache-Control": "no-store"})


# ---------- статика ----------

async def index(request: web.Request) -> web.StreamResponse:
    return web.FileResponse(WEBAPP_DIR / "index.html")


async def health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def api_fallback(request: web.Request) -> web.Response:
    return json_error(404, "not_found", "Такого запроса нет: приложение хранит данные в Telegram, а не на сервере.")


def create_app(config: Config) -> web.Application:
    app = web.Application(middlewares=[cors_middleware, error_middleware, no_cache])
    app["config"] = config
    app.router.add_get("/", index)
    app.router.add_get("/healthz", health)
    app.router.add_get("/api/legacy-export", legacy_export)
    app.router.add_post("/api/legacy-export/done", legacy_done)
    app.router.add_route("OPTIONS", "/api/{tail:.*}", health)     # preflight: заголовки добавит cors_middleware
    app.router.add_route("*", "/api/{tail:.*}", api_fallback)
    app.router.add_static("/", WEBAPP_DIR, show_index=False)
    return app


async def start_web_server(config: Config) -> web.AppRunner:
    runner = web.AppRunner(create_app(config))
    await runner.setup()
    await web.TCPSite(runner, config.webapp_host, config.webapp_port).start()
    log.info("Mini App: http://%s:%s/", config.webapp_host, config.webapp_port)
    return runner
