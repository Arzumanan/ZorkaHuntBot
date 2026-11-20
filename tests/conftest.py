
import pytest



def build_forecast_json() -> dict:
    """Минимальный ответ Open-Meteo на 2 суток (2026-11-20 и 2026-11-21), без сети."""
    times = []
    for day in ("2026-11-20", "2026-11-21"):
        for h in range(24):
            times.append(f"{day}T{h:02d}:00")
    n = len(times)
    return {
        "utc_offset_seconds": 10800,
        "hourly": {
            "time": times,
            "temperature_2m": [-2.0 + (i % 24) * 0.1 for i in range(n)],
            "precipitation": [0.0] * n,
            "pressure_msl": [1015.0] * n,
            "cloud_cover": [40.0] * n,
            "wind_speed_10m": [2.0] * n,
            "wind_direction_10m": [270.0] * n,
            "wind_gusts_10m": [4.0] * n,
        },
        "daily": {
            "time": ["2026-11-20", "2026-11-21"],
            "sunrise": ["2026-11-20T08:05", "2026-11-21T08:07"],
            "sunset": ["2026-11-20T16:10", "2026-11-21T16:08"],
        },
    }


@pytest.fixture
def forecast_json() -> dict:
    return build_forecast_json()


@pytest.fixture
async def db(tmp_path):
    from bot.db import Database

    database = Database(str(tmp_path / "test.db"))
    await database.connect()
    yield database
    await database.close()
