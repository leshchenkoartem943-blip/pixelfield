from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    LabeledPrice,
    MenuButtonWebApp,
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
from backend.game import add_donation, ensure_user, finish_pool  # noqa: E402
from backend.models import DonationRound, DonationRoundStatus, WithdrawalRequest  # noqa: E402
from sqlalchemy import select  # noqa: E402

DONATE_AMOUNTS = [1, 5, 10, 25, 50, 100]
API_BASE = settings.webapp_url.replace("/webapp/", "").rstrip("/")


def main_keyboard() -> ReplyKeyboardMarkup:
    """Reply keyboard — works on mobile. Desktop users should use the inline button."""
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="🎮 Играть", web_app=WebAppInfo(url=settings.webapp_url))],
            [KeyboardButton(text="👤 Профиль"), KeyboardButton(text="🏆 Топ")],
            [KeyboardButton(text="💎 Донат в пул"), KeyboardButton(text="ℹ️ Правила")],
        ],
        resize_keyboard=True,
        input_field_placeholder="Выберите действие",
    )


def play_inline_button() -> InlineKeyboardMarkup:
    """Inline button embedded in the message — passes initData on Telegram Desktop too."""
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🎮 Играть", web_app=WebAppInfo(url=settings.webapp_url))],
    ])


async def cmd_start(msg: Message) -> None:
    # Send inline button first — it works on Telegram Desktop (passes initData)
    # Reply keyboard is kept for mobile convenience
    await msg.answer(
        "🎮 <b>Pixel Field</b>\n\n"
        "Крась клетки, захватывай территорию, зарабатывай монеты!\n"
        "Защищай свои клетки — враги должны атаковать 3 раза чтобы захватить.\n\n"
        "💎 <b>Донат-пул:</b> вкладывай звёзды — победитель (топ-1) забирает всё!\n"
        "VIP донаторы получают постоянные бонусы в игре.\n\n"
        "👇 <b>Нажми кнопку ниже чтобы открыть игру:</b>",
        parse_mode="HTML",
        reply_markup=play_inline_button(),
    )
    # Also send reply keyboard so mobile users have quick access
    await msg.answer(
        "Или используй кнопку снизу 👇",
        reply_markup=main_keyboard(),
    )


async def profile(msg: Message) -> None:
    u = msg.from_user
    db = SessionLocal()
    try:
        user = ensure_user(db, tg_user_id=u.id, username=u.username, display_name=u.full_name or "Player")
        db.commit()
        vip_names = {0: "Обычный", 1: "🥉 Bronze VIP", 2: "🥈 Silver VIP", 3: "🥇 Gold VIP"}
        vip_str = vip_names.get(user.vip_level, "Обычный")
        await msg.answer(
            f"👤 <b>Профиль</b>\n"
            f"Имя: <b>{user.display_name}</b>\n"
            f"Уровень: <b>{user.level}</b> · XP: {user.xp}\n"
            f"Монеты: <b>{user.coins}</b> ⬡\n"
            f"Очки: <b>{user.score}</b> ★\n"
            f"Клеток: <b>{user.tiles_painted}</b> 🟩\n"
            f"Статус: <b>{vip_str}</b>\n"
            f"Всего вложено: <b>{user.total_donated_stars}</b> ⭐",
            parse_mode="HTML",
            reply_markup=main_keyboard(),
        )
    finally:
        db.close()


async def top(msg: Message) -> None:
    await msg.answer(
        "🏆 Топ игроков доступен прямо в игре!\n"
        "Нажми «Играть» → кнопка 🏆 в интерфейсе.",
        reply_markup=main_keyboard(),
    )


async def rules(msg: Message) -> None:
    await msg.answer(
        "ℹ️ <b>Правила игры</b>\n\n"
        "• Нажимай на соседние клетки — красишь и перемещаешься\n"
        "• <b>Захватные войны:</b> чтобы захватить чужую клетку, нужно атаковать её 3 раза\n"
        "  (или 1 раз, если она без защиты)\n"
        "• Укрепляй свои клетки — жми на свои тайлы чтобы добавить защиту\n"
        "• За каждую новую клетку: монеты + очки\n"
        "• В центре арены выше шанс лута и спавн мини-событий\n"
        "• Мини-события: раз в час в центре появляется клетка с x5-x10 бонусом!\n\n"
        "💎 <b>VIP привилегии:</b>\n"
        "• 5+ ⭐ donated → Bronze VIP: x1.5 монеты, дальность 2\n"
        "• 25+ ⭐ → Silver VIP: x2 монеты, дальность 2, эксклюзивные стили\n"
        "• 100+ ⭐ → Gold VIP: x3 монеты, дальность 3, VIP бейдж, спавн у центра\n\n"
        "💎 <b>Донат-пул:</b> победитель (топ-1 по очкам) забирает все звёзды!\n"
        "Для вывода напишите администратору.",
        parse_mode="HTML",
        reply_markup=main_keyboard(),
    )


async def donate_menu(msg: Message) -> None:
    lines = ["💎 <b>Донат в пул</b>\n"]
    lines.append("Выбери количество звёзд:\n")
    bonus = {1: 5, 5: 8, 10: 8, 25: 12, 50: 12, 100: 20}
    for amt in DONATE_AMOUNTS:
        b = bonus.get(amt, 5)
        lines.append(f"/donate_{amt} — {amt} ⭐ (+{amt*b} монет)")
    lines.append("\n<b>VIP уровни:</b>")
    lines.append("5 ⭐ total → 🥉 Bronze: x1.5 монеты, дальность 2")
    lines.append("25 ⭐ total → 🥈 Silver: x2 монеты + эксклюзивные стили")
    lines.append("100 ⭐ total → 🥇 Gold: x3 монеты, дальность 3, VIP бейдж")
    lines.append("\nПобедитель (топ-1 по очкам) забирает все ⭐!")
    await msg.answer("\n".join(lines), parse_mode="HTML", reply_markup=main_keyboard())


async def handle_donate_amount(msg: Message, stars: int) -> None:
    bonus_mult = 5 if stars < 25 else 12 if stars < 100 else 20
    await msg.answer_invoice(
        title=f"Донат {stars} ⭐ в пул",
        description=(
            f"Вложи {stars} звезду(-ы) в общий пул.\n"
            f"Победитель забирает всё!\n"
            f"Ты получаешь +{stars*bonus_mult} монет в игре."
        ),
        payload=f"pool_donate_{stars}",
        currency="XTR",
        prices=[LabeledPrice(label=f"{stars} Stars", amount=stars)],
    )


async def pre_checkout(query: PreCheckoutQuery) -> None:
    await query.answer(ok=True)


async def successful_payment(msg: Message) -> None:
    payment = msg.successful_payment
    if not payment or not msg.from_user:
        return

    payload = payment.invoice_payload
    charge_id = payment.telegram_payment_charge_id
    stars = 0
    if payload.startswith("pool_donate_"):
        try:
            stars = int(payload.split("_")[-1])
        except ValueError:
            stars = payment.total_amount

    if stars > 0:
        db = SessionLocal()
        try:
            u = msg.from_user
            user = ensure_user(db, tg_user_id=u.id, username=u.username,
                               display_name=u.full_name or "Player")
            db.commit(); db.refresh(user)
            result = add_donation(db, user, stars, tg_payment_charge_id=charge_id)
            db.commit()
            bonus = result.get("bonus_coins", stars * 5)
            pool_total = result.get("pool_total", "?")
            vip = result.get("vip_level", 0)
            vip_names = {1: "🥉 Bronze VIP", 2: "🥈 Silver VIP", 3: "🥇 Gold VIP"}
            vip_msg = f"\n\n✨ Ты получил статус <b>{vip_names[vip]}</b>!" if vip > 0 and vip_names.get(vip) else ""
            await msg.answer(
                f"✅ <b>Спасибо! {stars} ⭐ добавлено в пул!</b>\n"
                f"Общий пул: <b>{pool_total} ⭐</b>\n"
                f"Ты получил <b>+{bonus} монет</b> в игре!{vip_msg}\n\n"
                f"Победитель (топ-1 по очкам к концу раунда) получит все звёзды.\n"
                f"Для вывода свяжитесь с администратором.",
                parse_mode="HTML",
                reply_markup=main_keyboard(),
            )
        except Exception as e:
            await msg.answer(f"Ошибка записи доната: {e}")
        finally:
            db.close()


# ── Admin commands ────────────────────────────────────────────────────────────

async def admin_pay(msg: Message, bot: Bot) -> None:
    """Mark a withdrawal request as paid and notify the winner."""
    admin_ids = {settings.admin_tg_id} if settings.admin_tg_id else set()
    if msg.from_user.id not in admin_ids:
        await msg.answer("❌ Нет прав.")
        return

    parts = (msg.text or "").split()
    if len(parts) < 2 or not parts[1].isdigit():
        await msg.answer(
            "❌ Укажи номер раунда: <code>/admin_pay 3</code>",
            parse_mode="HTML",
        )
        return

    round_id = int(parts[1])
    db = SessionLocal()
    try:
        wr = db.execute(
            select(WithdrawalRequest).where(WithdrawalRequest.round_id == round_id)
        ).scalar_one_or_none()
        if not wr:
            await msg.answer(f"❌ Заявки на вывод для раунда #{round_id} нет.")
            return
        if wr.status == "paid":
            await msg.answer(f"ℹ️ Раунд #{round_id} уже помечен как выплаченный.")
            return

        from datetime import datetime
        wr.status = "paid"
        wr.paid_at = datetime.utcnow()
        db.commit()

        await msg.answer(
            f"✅ Раунд #{round_id} помечен как выплаченный.\n"
            f"Уведомляю победителя (TG ID: <code>{wr.winner_tg_id}</code>)...",
            parse_mode="HTML",
        )

        if wr.winner_tg_id:
            try:
                await bot.send_message(
                    chat_id=wr.winner_tg_id,
                    text=(
                        f"✅ <b>Выплата произведена!</b>\n\n"
                        f"Раунд <b>#{round_id}</b> · <b>{wr.total_stars} ⭐</b> отправлено.\n\n"
                        f"Проверь входящие переводы в Telegram (раздел «Stars»).\n"
                        f"Спасибо за игру — до встречи в новом сезоне! 🎮"
                    ),
                    parse_mode="HTML",
                    reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
                        InlineKeyboardButton(
                            text="🎮 Играть снова",
                            web_app=WebAppInfo(url=settings.webapp_url),
                        )
                    ]]),
                )
            except Exception:
                await msg.answer("⚠️ Не удалось уведомить победителя — возможно, не запускал бота.")
    finally:
        db.close()


async def admin_withdrawals(msg: Message) -> None:
    """Show pending withdrawal requests."""
    admin_ids = {settings.admin_tg_id} if settings.admin_tg_id else set()
    if msg.from_user.id not in admin_ids:
        await msg.answer("❌ Нет прав.")
        return

    db = SessionLocal()
    try:
        requests = db.execute(
            select(WithdrawalRequest)
            .where(WithdrawalRequest.status == "pending")
            .order_by(WithdrawalRequest.id.desc())
            .limit(10)
        ).scalars().all()

        if not requests:
            await msg.answer("✅ Нет ожидающих заявок на вывод.")
            return

        lines = ["📋 <b>Ожидающие заявки на вывод:</b>\n"]
        for wr in requests:
            lines.append(
                f"• Раунд <b>#{wr.round_id}</b> — <b>{wr.total_stars} ⭐</b>\n"
                f"  TG ID: <code>{wr.winner_tg_id}</code>\n"
                f"  Запрошено: {wr.requested_at.strftime('%d.%m.%Y %H:%M')}\n"
                f"  Подтвердить: <code>/admin_pay {wr.round_id}</code>\n"
            )
        await msg.answer("\n".join(lines), parse_mode="HTML")
    finally:
        db.close()


async def cmd_respawn(msg: Message) -> None:
    """Move the user to a new spawn position on the map."""
    if not msg.from_user:
        return
    db = SessionLocal()
    try:
        from backend.game import _occupied_positions, spawn_for_user
        u = msg.from_user
        user = ensure_user(db, tg_user_id=u.id, username=u.username, display_name=u.full_name or "Player")
        db.commit(); db.refresh(user)
        occupied = _occupied_positions(db, exclude_id=user.id)
        nx, ny = spawn_for_user(u.id, occupied=occupied)
        user.pos_x, user.pos_y = nx, ny
        db.commit()
        await msg.answer(
            f"🔄 <b>Перемещение выполнено!</b>\n"
            f"Твоя новая позиция: <b>({nx}, {ny})</b>\n\n"
            f"Открой игру — ты появишься в новой точке.",
            parse_mode="HTML",
            reply_markup=main_keyboard(),
        )
    finally:
        db.close()


async def admin_finish(msg: Message, bot: Bot) -> None:
    admin_ids = {settings.admin_tg_id} if settings.admin_tg_id else set()
    if msg.from_user.id not in admin_ids:
        await msg.answer("❌ Нет прав.")
        return

    db = SessionLocal()
    try:
        result = finish_pool(db)
        db.commit()
    except ValueError as e:
        await msg.answer(f"Ошибка: {e}")
        db.close()
        return
    finally:
        db.close()

    winner_tg_id = result.get("winner_tg_id")
    winner_name = result.get("winner_name", "Неизвестный")
    total_stars = result.get("total_stars", 0)

    await msg.answer(
        f"✅ <b>Раунд завершён!</b>\n\n"
        f"Общий пул: <b>{total_stars} ⭐</b>\n"
        f"Победитель: <b>{winner_name}</b> (TG ID: <code>{winner_tg_id}</code>)\n\n"
        f"Свяжитесь с победителем для выплаты через Fragment/TON.",
        parse_mode="HTML",
    )

    # Notify the winner
    if winner_tg_id:
        try:
            await bot.send_message(
                chat_id=winner_tg_id,
                text=(
                    f"🏆 <b>Поздравляем! Ты победил в донат-пуле!</b>\n\n"
                    f"Ты занял 1-е место по очкам и выиграл <b>{total_stars} ⭐</b>!\n\n"
                    f"Для получения приза напиши администратору.\n"
                    f"Выплата производится через Fragment (Stars) или TON кошелёк."
                ),
                parse_mode="HTML",
            )
        except Exception:
            await msg.answer("⚠️ Не удалось уведомить победителя (возможно, не запускал бота).")


async def run() -> None:
    bot = Bot(token=settings.bot_token)
    dp = Dispatcher()

    # Set the menu button (bottom-left in chat) — most reliable way to open Mini App
    # with proper initData on all platforms including Telegram Desktop.
    try:
        await bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(
                text="🎮 Играть",
                web_app=WebAppInfo(url=settings.webapp_url),
            )
        )
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("Could not set menu button: %s", exc)

    dp.message.register(cmd_start, Command("start"))
    dp.message.register(profile, F.text == "👤 Профиль")
    dp.message.register(top, F.text == "🏆 Топ")
    dp.message.register(rules, F.text == "ℹ️ Правила")
    dp.message.register(cmd_start, F.text == "🎮 Играть")
    dp.message.register(donate_menu, F.text == "💎 Донат в пул")
    dp.message.register(cmd_respawn, Command("respawn"))
    dp.message.register(admin_finish, Command("admin_finish"))
    dp.message.register(admin_pay, Command("admin_pay"))
    dp.message.register(admin_withdrawals, Command("admin_withdrawals"))

    for amt in DONATE_AMOUNTS:
        _amt = amt
        dp.message.register(
            lambda m, a=_amt: handle_donate_amount(m, a),
            Command(f"donate_{_amt}"),
        )

    dp.pre_checkout_query.register(pre_checkout)
    dp.message.register(successful_payment, F.successful_payment)

    # drop_pending_updates=True: ignore any updates queued while bot was offline
    # and immediately claim the polling slot — old instance loses it right away.
    await dp.start_polling(bot, drop_pending_updates=True)


if __name__ == "__main__":
    asyncio.run(run())
