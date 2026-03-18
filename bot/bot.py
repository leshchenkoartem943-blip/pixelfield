from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command
from aiogram.types import KeyboardButton, Message, ReplyKeyboardMarkup, WebAppInfo

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.settings import settings  # noqa: E402


def main_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="🎮 Играть", web_app=WebAppInfo(url=settings.webapp_url))],
            [KeyboardButton(text="👤 Профиль"), KeyboardButton(text="ℹ️ Правила")],
        ],
        resize_keyboard=True,
        input_field_placeholder="Выберите действие",
    )


async def cmd_start(msg: Message) -> None:
    await msg.answer(
        "Добро пожаловать в Pixel Field!\n\n"
        "Нажми «Играть», чтобы открыть поле. Крась клетки рядом с собой — за новые клетки дают монеты и очки.\n"
        "Чем ближе к центру, тем чаще выпадает лут.",
        reply_markup=main_keyboard(),
    )


async def profile(msg: Message) -> None:
    # В MVP профиль показываем текстом. Вся “регистрация/авторизация” происходит автоматически через Telegram.
    u = msg.from_user
    await msg.answer(
        "👤 Профиль\n"
        f"- ID: `{u.id}`\n"
        f"- Username: `{u.username or '-'}`\n"
        f"- Имя: `{u.full_name}`\n\n"
        "Открой игру кнопкой «Играть» — там видны монеты/очки и позиция.",
        parse_mode="Markdown",
        reply_markup=main_keyboard(),
    )


async def rules(msg: Message) -> None:
    await msg.answer(
        "ℹ️ Правила (MVP)\n"
        "- Спавн на краю карты случайно.\n"
        "- Можно красить только рядом (на 1 клетку).\n"
        "- За новую клетку: +монеты и +очки.\n"
        "- В центре шанс лута выше.\n"
        "- Монеты можно вложить в бусты (магазин в игре).",
        reply_markup=main_keyboard(),
    )


async def run() -> None:
    bot = Bot(token=settings.bot_token)
    dp = Dispatcher()

    dp.message.register(cmd_start, Command("start"))
    dp.message.register(profile, F.text == "👤 Профиль")
    dp.message.register(rules, F.text == "ℹ️ Правила")
    dp.message.register(cmd_start, F.text == "🎮 Играть")

    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(run())

