"""Чек-лист снаряжения: шаблоны по виду охоты и подсказки по погоде (чистые функции)."""
from __future__ import annotations

CATEGORIES = {
    "gun": "🔫 Оружие",
    "docs": "📄 Документы",
    "gear": "🎒 Снаряжение",
    "food": "🥪 Еда и питьё",
}
CATEGORY_ORDER = ["gun", "docs", "gear", "food"]

HUNT_TYPES = {
    "waterfowl": "🦆 Водоплавающая (утка, гусь)",
    "upland": "🐦 Боровая / полевая дичь",
    "ungulates": "🐗 Копытные (кабан, лось, косуля)",
    "general": "🧭 Общий",
}

# (категория, ключ, текст)
COMMON: list[tuple[str, str, str]] = [
    ("gun", "gun", "Ружьё (проверить, что исправно и разряжено при перевозке)"),
    ("gun", "case", "Чехол / кейс для оружия"),
    ("gun", "belt", "Ремень, патронташ / подсумок"),
    ("gun", "clean", "Принадлежности для чистки"),
    ("docs", "ticket", "Охотничий билет"),
    ("docs", "weapon_permit", "Разрешение на хранение и ношение оружия (РОХа)"),
    ("docs", "voucher", "Путёвка / договор с охотпользователем (закреплённые угодья)"),
    ("docs", "harvest_permit", "Разрешение на добычу охотничьих ресурсов"),
    ("docs", "passport", "Паспорт"),
    ("gear", "knife", "Нож"),
    ("gear", "light", "Фонарь / налобник + запасные батарейки"),
    ("gear", "firstaid", "Аптечка"),
    ("gear", "phone", "Телефон, пауэрбанк, навигатор / карта"),
    ("gear", "clothes", "Одежда и обувь по сезону и погоде"),
    ("gear", "lighter", "Спички / зажигалка"),
    ("food", "water", "Вода / термос с чаем"),
    ("food", "snack", "Перекус (бутерброды, орехи, шоколад)"),
]

BY_TYPE: dict[str, list[tuple[str, str, str]]] = {
    "waterfowl": [
        ("gun", "shells", "Патроны на утку / гуся (дробь по виду дичи и нормам)"),
        ("gear", "decoys", "Чучела (профили), шнур, грузы"),
        ("gear", "calls", "Манки (утка, гусь)"),
        ("gear", "waders", "Забродные / болотные сапоги или вейдерсы"),
        ("gear", "camo", "Маскировка: камуфляж, маскировочная сеть"),
        ("gear", "dog", "Собака: поводок, подстилка, вода (если охота с собакой)"),
    ],
    "upland": [
        ("gun", "shells", "Патроны на боровую / полевую дичь (мелкая и средняя дробь)"),
        ("gear", "calls", "Манки (рябчик, глухарь, вальдшнеп)"),
        ("gear", "bag", "Ягдташ / сумка для добычи"),
        ("gear", "dog", "Собака: ошейник, поводок, вода (если охота с собакой)"),
        ("gear", "compass", "Компас / навигатор (лес)"),
    ],
    "ungulates": [
        ("gun", "shells", "Патроны на копытных: пули / картечь / нарезной калибр"),
        ("gun", "optics", "Оптика, бинокль"),
        ("gear", "reflect", "Световозвращающая одежда / яркий жилет (при коллективной охоте и в темноте)"),
        ("gear", "carve", "Нож для разделки, мешки, верёвка"),
        ("gear", "stand", "Сидушка / подвесное место, шумоподавляющие наушники"),
    ],
    "general": [
        ("gun", "shells", "Патроны по виду дичи (калибр, дробь / пуля)"),
        ("gear", "binoculars", "Бинокль"),
    ],
}


def template_for(hunt_type: str) -> list[tuple[str, str, str]]:
    """Список (категория, ключ, текст) для вида охоты."""
    extra = BY_TYPE.get(hunt_type, BY_TYPE["general"])
    return COMMON + extra


def weather_hints(
    temperature: float | None = None,
    precipitation: float | None = None,
    wind_speed: float | None = None,
    wind_gusts: float | None = None,
) -> list[str]:
    """Подсказки к чек-листу по прогнозу (всё необязательно)."""
    hints: list[str] = []
    if precipitation is not None and precipitation >= 0.5:
        if temperature is not None and temperature <= 0:
            hints.append("❄️ Ожидается снег: маскхалат / белая маскировка, водоотталкивающая одежда.")
        else:
            hints.append("🌧 Ожидается дождь: дождевик, сменные носки, влагозащита для оружия и оптики.")
    if temperature is not None:
        if temperature <= -10:
            hints.append("🥶 Сильный мороз: термобельё, тёплые перчатки и обувь, грелки, термос с горячим.")
        elif temperature <= 3:
            hints.append("🧥 Холодно: тёплый слой, шапка, перчатки, горячий чай.")
        elif temperature >= 20:
            hints.append("☀️ Тепло: больше воды, головной убор, средство от комаров и клещей.")
    if (wind_speed is not None and wind_speed >= 8) or (wind_gusts is not None and wind_gusts >= 12):
        hints.append("💨 Сильный ветер: ветрозащитная куртка, закрепите чучела и маскировку.")
    return hints
