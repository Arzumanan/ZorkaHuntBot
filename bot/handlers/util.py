"""Общие помощники для хендлеров."""
from __future__ import annotations

from aiogram.exceptions import TelegramBadRequest
from aiogram.types import Message

TG_LIMIT = 4000


def split_text(text: str, limit: int = TG_LIMIT) -> list[str]:
    """Делит длинный текст по пустым строкам, чтобы уложиться в лимит Telegram."""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    current = ""
    for block in text.split("\n\n"):
        candidate = f"{current}\n\n{block}" if current else block
        if len(candidate) <= limit:
            current = candidate
            continue
        if current:
            chunks.append(current)
        while len(block) > limit:  # блок сам длиннее лимита
            chunks.append(block[:limit])
            block = block[limit:]
        current = block
    if current:
        chunks.append(current)
    return chunks


async def answer_long(message: Message, text: str, **kwargs) -> None:
    chunks = split_text(text)
    for i, chunk in enumerate(chunks):
        # клавиатуру и прочие параметры прикрепляем к последнему сообщению
        await message.answer(chunk, **(kwargs if i == len(chunks) - 1 else {"disable_web_page_preview": True}))


async def safe_edit(message, text: str, reply_markup=None) -> None:
    """edit_text, который не падает на «message is not modified»."""
    try:
        await message.edit_text(text, reply_markup=reply_markup)
    except TelegramBadRequest as exc:
        if "not modified" not in str(exc):
            raise
