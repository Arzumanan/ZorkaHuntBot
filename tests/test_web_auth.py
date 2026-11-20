import time

import pytest

from bot.web.auth import InitDataError, build_init_data, compute_hash, validate_init_data

TOKEN = "123456:TEST-TOKEN"
USER = {"id": 42, "first_name": "Жека", "username": "zhk"}


def test_valid_init_data():
    user = validate_init_data(build_init_data(TOKEN, USER), TOKEN)
    assert (user.id, user.first_name, user.username) == (42, "Жека", "zhk")


def test_valid_with_extra_fields_and_signature_field():
    data = build_init_data(TOKEN, USER, query_id="AAH123", chat_type="private", signature="abc_DEF-1")
    assert validate_init_data(data, TOKEN).id == 42


def test_known_vector_from_algorithm():
    """Независимая пересборка по алгоритму из документации Telegram."""
    import hashlib
    import hmac
    from urllib.parse import urlencode

    fields = {"auth_date": str(int(time.time())), "query_id": "Q1", "user": '{"id":7,"first_name":"A"}'}
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", TOKEN.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    assert validate_init_data(urlencode(fields), TOKEN).id == 7


def test_wrong_token_rejected():
    with pytest.raises(InitDataError, match="bad_hash"):
        validate_init_data(build_init_data(TOKEN, USER), "999:OTHER")


def test_tampered_user_rejected():
    from urllib.parse import parse_qsl, urlencode

    fields = dict(parse_qsl(build_init_data(TOKEN, USER)))
    fields["user"] = fields["user"].replace("42", "43")
    with pytest.raises(InitDataError, match="bad_hash"):
        validate_init_data(urlencode(fields), TOKEN)


def test_tampered_hash_rejected():
    data = build_init_data(TOKEN, USER)
    with pytest.raises(InitDataError):
        validate_init_data(data[:-1] + ("0" if data[-1] != "0" else "1"), TOKEN)


def test_missing_hash_rejected():
    with pytest.raises(InitDataError, match="no_hash"):
        validate_init_data("auth_date=1&user=%7B%22id%22%3A1%7D", TOKEN)


@pytest.mark.parametrize("bad", ["", "garbage", "a=b=c&&", "hash="])
def test_garbage_rejected(bad):
    with pytest.raises(InitDataError):
        validate_init_data(bad, TOKEN)


def test_empty_token_rejected():
    with pytest.raises(InitDataError):
        validate_init_data(build_init_data(TOKEN, USER), "")


def test_expired_rejected_and_fresh_accepted():
    old = build_init_data(TOKEN, USER, auth_date=int(time.time()) - 25 * 3600)
    with pytest.raises(InitDataError, match="expired"):
        validate_init_data(old, TOKEN)
    fresh = build_init_data(TOKEN, USER, auth_date=int(time.time()) - 23 * 3600)
    assert validate_init_data(fresh, TOKEN).id == 42


def test_custom_max_age_and_now():
    data = build_init_data(TOKEN, USER, auth_date=1_000_000)
    assert validate_init_data(data, TOKEN, max_age=100, now=1_000_050).id == 42
    with pytest.raises(InitDataError, match="expired"):
        validate_init_data(data, TOKEN, max_age=100, now=1_000_200)


def test_auth_date_from_future_rejected():
    data = build_init_data(TOKEN, USER, auth_date=int(time.time()) + 3600)
    with pytest.raises(InitDataError, match="expired"):
        validate_init_data(data, TOKEN)


def test_missing_user_rejected():
    from urllib.parse import urlencode

    fields = {"auth_date": str(int(time.time()))}
    fields["hash"] = compute_hash(fields, TOKEN)
    with pytest.raises(InitDataError, match="no_user"):
        validate_init_data(urlencode(fields), TOKEN)
