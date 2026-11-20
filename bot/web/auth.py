"""Проверка Telegram Mini App initData (чистая функция, без сети).

Алгоритм из документации Telegram:
  secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
  data_check_string = все пары key=value (кроме hash), отсортированные по ключу, через \\n
  hash == hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl

MAX_AGE_SECONDS = 24 * 3600


class InitDataError(Exception):
    """initData не прошла проверку."""


@dataclass(frozen=True)
class WebAppUser:
    id: int
    first_name: str = ""
    username: str | None = None


def _secret_key(bot_token: str) -> bytes:
    return hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()


def compute_hash(fields: dict[str, str], bot_token: str) -> str:
    check = "\n".join(f"{k}={fields[k]}" for k in sorted(fields) if k != "hash")
    return hmac.new(_secret_key(bot_token), check.encode(), hashlib.sha256).hexdigest()


def validate_init_data(init_data: str, bot_token: str, max_age: int = MAX_AGE_SECONDS,
                       now: float | None = None) -> WebAppUser:
    """Возвращает пользователя или бросает InitDataError."""
    if not init_data or not bot_token:
        raise InitDataError("empty")
    try:
        fields = dict(parse_qsl(init_data, keep_blank_values=True, strict_parsing=True))
    except ValueError as exc:
        raise InitDataError("malformed") from exc
    received = fields.get("hash")
    if not received:
        raise InitDataError("no_hash")
    if not hmac.compare_digest(compute_hash(fields, bot_token), received):
        raise InitDataError("bad_hash")
    try:
        auth_date = int(fields["auth_date"])
    except (KeyError, ValueError) as exc:
        raise InitDataError("no_auth_date") from exc
    now = time.time() if now is None else now
    if auth_date > now + 300 or now - auth_date > max_age:
        raise InitDataError("expired")
    try:
        user = json.loads(fields["user"])
        return WebAppUser(id=int(user["id"]), first_name=str(user.get("first_name", "")),
                          username=user.get("username"))
    except (KeyError, ValueError, TypeError) as exc:
        raise InitDataError("no_user") from exc


def build_init_data(bot_token: str, user: dict, auth_date: int | None = None, **extra: str) -> str:
    """Собирает корректную initData (для тестов и локальной отладки)."""
    from urllib.parse import urlencode

    fields = {"auth_date": str(auth_date if auth_date is not None else int(time.time())),
              "user": json.dumps(user, ensure_ascii=False, separators=(",", ":")), **extra}
    fields["hash"] = compute_hash(fields, bot_token)
    return urlencode(fields)
