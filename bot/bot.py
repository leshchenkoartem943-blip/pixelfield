from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command
from aiogram.types import (
    KeyboardButton,
    LabeledPrice,
    Message,
    PreCheckoutQuery,
    ReplyKeyboardMarkup,
    WebAppInfo,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.settings import settings  # noqa: E402
from backend.db import SessionLocal  # noqa: E402
from backend.game import add_donation, ensure_user  # noqa: E402


DONATE_AMOUNTS = [1, 5, 10, 50, 100]  # Stars


def main_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="🎮 Играть", web_app=WebAppInfo(url=settings.webapp_url))],
            [KeyboardButton(text="👤 Профиль"), KeyboardButton(text="🏆 Топ")],
            [KeyboardButton(text="💎 Донат в пул"), KeyboardButton(text="ℹ️ Правила")],
        ],
        resize_keyboard=True,
        input_field_placeholder="Выберите действие",
    )


async def cmd_start(msg: Message) -> None:
    await msg.answer(
        "🎮 <b>Pixel Field</b>\n\n"
        "Крась клетки, захватывай территорию, зарабатывай монеты!\n"
        "Чем ближе к центру — тем ценнее лут.\n\n"
        "💎 <b>Система доната:</b> вкладывай звёзды в общий пул — победитель (топ-1 по очкам) забирает всё!",
        parse_mode="HTML",
        reply_markup=main_keyboard(),
    )


async def profile(msg: Message) -> None:
    u = msg.from_user
    await msg.answer(
        f"👤 <b>Профиль</b>\n"
        f"ID: <code>{u.id}</code>\n"
        f"Username: <code>{u.username or '-'}</code>\n"
        f"Имя: <b>{u.full_name}</b>\n\n"
        "Открой игру кнопкой «Играть» — там видны монеты, очки и позиция.",
        parse_mode="HTML",
        reply_markup=main_keyboard(),
    )


async def top(msg: Message) -> None:
    await msg.answer(
        "🏆 Топ игроков доступен прямо в игре!\n"
        "Нажми «Играть» → кнопка «Топ» в интерфейсе.",
        reply_markup=main_keyboard(),
    )


async def rules(msg: Message) -> None:
    await msg.answer(
        "ℹ️ <b>Правила</b>\n\n"
        "• Спавн на краю арены случайно\n"
        "• Кликай на соседние клетки — красишь и перемещаешься\n"
        "• За новую клетку: +монеты и +очки\n"
        "• В центре шанс лута выше\n"
        "• Покупай стили и бусты в магазине\n\n"
        "💎 <b>Донат-пул:</b>\n"
        "Вложи звёзды в общий пул. Каждые 24 ч победитель (игрок с наибольшим счётом) забирает весь пул звёздами!\n"
        "За каждую звезду ты получаешь +5 монет в игре.",
        parse_mode="HTML",
        reply_markup=main_keyboard(),
    )


async def donate_menu(msg: Message) -> None:
    lines = ["💎 <b>Донат в пул</b>\n", "Выбери количество звёзд:\n"]
    for amt in DONATE_AMOUNTS:
        lines.append(f"/donate_{amt} — {amt} ⭐ (+{amt * 5} монет)")
    lines.append("\nПобедитель (топ-1 по очкам раунда) получит все звёзды пула!")
    await msg.answer("\n".join(lines), parse_mode="HTML", reply_markup=main_keyboard())


async def handle_donate_amount(msg: Message, stars: int) -> None:
    await msg.answer_invoice(
        title=f"Донат {stars} ⭐ в пул",
        description=f"Вложи {stars} звезду(-ы) в общий пул. Победитель забирает всё! Ты получаешь +{stars * 5} монет.",
        payload=f"pool_donate_{stars}",
        currency="XTR",
        prices=[LabeledPrice(label=f"{stars} Stars", amount=stars)],
    )


async def pre_checkout(query: PreCheckoutQuery) -> None:
    await query.answer(ok=True)


async def successful_payment(msg: Message) -> None:
    payment = msg.successful_payment
    if not payment:
        return

    payload = payment.invoice_payload
    charge_id = payment.telegram_payment_charge_id

    stars = 0
    if payload.startswith("pool_donate_"):
        try:
            stars = int(payload.split("_")[-1])
        except ValueError:
            stars = payment.total_amount

    if stars > 0 and msg.from_user:
        db = SessionLocal()
        try:
            u = msg.from_user
            user = ensure_user(
                db,
                tg_user_id=u.id,
                username=u.username,
                display_name=u.full_name or "Player",
            )
            db.commit()
            db.refresh(user)
            result = add_donation(db, user, stars, tg_payment_charge_id=charge_id)
            db.commit()
            bonus = result.get("bonus_coins", stars * 5)
            pool_total = result.get("pool_total", "?")
            await msg.answer(
                f"✅ Спасибо! {stars} ⭐ добавлено в пул!\n"
                f"Общий пул: <b>{pool_total} ⭐</b>\n"
                f"Ты получил <b>+{bonus} монет</b> в игре!\n\n"
                "Побеждает игрок с наибольшим счётом в конце раунда.",
                parse_mode="HTML",
                reply_markup=main_keyboard(),
            )
        except Exception as e:
            await msg.answer(f"Ошибка записи доната: {e}")
        finally:
            db.close()


async def run() -> None:
    bot = Bot(token=settings.bot_token)
    dp = Dispatcher()

    dp.message.register(cmd_start, Command("start"))
    dp.message.register(profile, F.text == "👤 Профиль")
    dp.message.register(top, F.text == "🏆 Топ")
    dp.message.register(rules, F.text == "ℹ️ Правила")
    dp.message.register(cmd_start, F.text == "🎮 Играть")
    dp.message.register(donate_menu, F.text == "💎 Донат в пул")

    for amt in DONATE_AMOUNTS:
        _amt = amt
        dp.message.register(
            lambda m, a=_amt: handle_donate_amount(m, a),
            Command(f"donate_{_amt}"),
        )

    dp.pre_checkout_query.register(pre_checkout)
    dp.message.register(successful_payment, F.successful_payment)

    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(run())
