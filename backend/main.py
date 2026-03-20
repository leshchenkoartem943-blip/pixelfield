from __future__ import annotations

import json
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from sqlalchemy import select
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.db import SessionLocal, init_db
import httpx

from backend.game import (
    add_donation, buy_shop_item, claim_daily_quest, ensure_user, equip_cosmetic,
    finish_pool, get_achievements, get_active_events, get_daily_quests, get_leaderboard,
    get_my_alerts, get_pool_info, get_round_history, get_shop_catalog, get_war_feed,
    in_arena, list_inventory, move_user, open_loot, paint_tile, verify_telegram_init_data,
)
from backend.models import (
    DonationRound, DonationRoundStatus, LootCrate, Tile, User, WithdrawalRequest,
)
from backend.settings import settings


BASE_DIR = Path(__file__).resolve().parent.parent
WEBAPP_DIR = BASE_DIR / "webapp"

app = FastAPI(title="Telegram Pixel Field")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(
    db: Session = Depends(get_db),
    x_tg_initdata: str | None = Header(default=None, alias="X-TG-INITDATA"),
    x_admin_secret: str | None = Header(default=None, alias="X-ADMIN-SECRET"),
) -> User:
    if x_admin_secret and x_admin_secret == settings.admin_secret:
        user = ensure_user(db, tg_user_id=999000, username="admin", display_name="Admin")
        db.commit(); db.refresh(user)
        return user

    if not x_tg_initdata:
        raise HTTPException(status_code=401, detail="missing_initdata")
    try:
        parsed = verify_telegram_init_data(
            x_tg_initdata, settings.telegram_bot_token_for_webapp_hash or settings.bot_token
        )
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e)) from e

    user_json = parsed.get("user")
    if not user_json:
        raise HTTPException(status_code=401, detail="missing_user")
    u = json.loads(user_json)
    tg_user_id = int(u["id"])
    username = u.get("username")
    display_name = ((u.get("first_name") or "") + " " + (u.get("last_name") or "")).strip() or "Player"
    user = ensure_user(db, tg_user_id=tg_user_id, username=username, display_name=display_name)
    db.commit(); db.refresh(user)
    return user


@app.on_event("startup")
def _startup():
    init_db()


app.mount("/webapp/static", StaticFiles(directory=str(WEBAPP_DIR / "static")), name="webapp_static")


@app.get("/webapp/", response_class=HTMLResponse)
def webapp_index():
    return HTMLResponse((WEBAPP_DIR / "index.html").read_text(encoding="utf-8"))


# ── Pydantic models ───────────────────────────────────────────────────────────

class MoveIn(BaseModel):
    dx: int
    dy: int

class PaintIn(BaseModel):
    x: int
    y: int
    color: str = "#44ccff"

class ShopBuyIn(BaseModel):
    item_id: str

class EquipIn(BaseModel):
    cosmetic_id: str

class DonateIn(BaseModel):
    stars: int
    tg_payment_charge_id: str | None = None

class ClaimQuestIn(BaseModel):
    quest_id: str


# ── User ──────────────────────────────────────────────────────────────────────

@app.get("/api/me")
def api_me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # Check if user won any finished round (jackpot notification)
    won_round = db.execute(
        select(DonationRound)
        .where(
            DonationRound.status == DonationRoundStatus.finished,
            DonationRound.winner_user_id == user.id,
            DonationRound.total_stars > 0,
        )
        .order_by(DonationRound.id.desc())
    ).scalar_one_or_none()
    jackpot = None
    if won_round:
        wr = won_round.withdrawal
        if not wr:
            jackpot = {"round_id": won_round.id, "total_stars": won_round.total_stars}

    return {
        "id": user.id, "tg_user_id": user.tg_user_id,
        "username": user.username, "display_name": user.display_name,
        "coins": user.coins, "score": user.score,
        "tiles_painted": user.tiles_painted,
        "owned_tiles": user.owned_tiles or 0,
        "xp": user.xp, "level": user.level,
        "base_color": user.base_color, "paint_style": user.paint_style,
        "border_style": user.border_style or "none",
        "pos": {"x": user.pos_x, "y": user.pos_y},
        "vip_level": user.vip_level,
        "total_donated_stars": user.total_donated_stars,
        "capture_streak": user.capture_streak or 0,
        "jackpot": jackpot,
    }


# ── Game state ────────────────────────────────────────────────────────────────

@app.get("/api/game/state")
def api_state(x0: int, y0: int, x1: int, y1: int,
              user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    x0 = max(0, min(settings.map_width-1, x0)); y0 = max(0, min(settings.map_height-1, y0))
    x1 = max(0, min(settings.map_width-1, x1)); y1 = max(0, min(settings.map_height-1, y1))
    if x1 < x0: x0, x1 = x1, x0
    if y1 < y0: y0, y1 = y1, y0

    tiles = (db.query(Tile).filter(Tile.x>=x0, Tile.x<=x1, Tile.y>=y0, Tile.y<=y1).limit(50000).all())
    tiles = [t for t in tiles if in_arena(t.x, t.y)]
    players = (db.query(User).filter(User.pos_x>=x0, User.pos_x<=x1, User.pos_y>=y0, User.pos_y<=y1).limit(200).all())
    players = [p for p in players if in_arena(p.pos_x, p.pos_y)]
    events = get_active_events(db)

    # Borders map: owner_id → border_style for all tiles in viewport
    owner_ids = list({t.owner_user_id for t in tiles})
    borders: dict[int, str] = {}
    if owner_ids:
        border_rows = db.execute(
            select(User.id, User.border_style).where(User.id.in_(owner_ids))
        ).all()
        borders = {r.id: (r.border_style or "none") for r in border_rows}

    db.commit()
    return {
        "map": {"w": settings.map_width, "h": settings.map_height,
                "shape": getattr(settings, "arena_shape", "circle"),
                "r": settings.arena_radius_tiles},
        "me": {"x": user.pos_x, "y": user.pos_y, "id": user.id},
        "tiles": [
            {"x": t.x, "y": t.y, "c": t.color, "o": t.owner_user_id,
             "d": t.defense, "h": t.attack_hits or 0}
            for t in tiles
        ],
        "players": [
            {"id": p.id, "x": p.pos_x, "y": p.pos_y, "name": p.display_name,
             "style": f"{p.paint_style}:{p.base_color}", "level": p.level, "vip": p.vip_level}
            for p in players
        ],
        "events": events,
        "borders": {str(k): v for k, v in borders.items()},
    }


@app.get("/api/game/minimap")
def api_minimap(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    tiles = db.query(Tile).filter(Tile.x>=0, Tile.x<settings.map_width, Tile.y>=0, Tile.y<settings.map_height).all()
    tiles = [t for t in tiles if in_arena(t.x, t.y)]
    players = db.query(User).filter(User.pos_x>=0, User.pos_x<settings.map_width,
                                    User.pos_y>=0, User.pos_y<settings.map_height).limit(500).all()
    players = [p for p in players if in_arena(p.pos_x, p.pos_y)]
    return {
        "map": {"w": settings.map_width, "h": settings.map_height},
        "tiles": [{"x": t.x, "y": t.y, "c": t.color, "o": t.owner_user_id} for t in tiles],
        "players": [{"id": p.id, "x": p.pos_x, "y": p.pos_y,
                     "style": f"{p.paint_style}:{p.base_color}", "level": p.level} for p in players],
        "me": {"id": user.id, "x": user.pos_x, "y": user.pos_y},
    }


@app.post("/api/game/move")
def api_move(body: MoveIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        move_user(db, user, body.dx, body.dy)
        db.commit()
    except ValueError as e:
        db.rollback(); raise HTTPException(400, str(e))
    return {"ok": True, "pos": {"x": user.pos_x, "y": user.pos_y}}


@app.post("/api/game/paint")
def api_paint(body: PaintIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        res = paint_tile(db, user, body.x, body.y, body.color)
        db.commit()
    except ValueError as e:
        db.rollback(); raise HTTPException(400, str(e))
    return {"ok": True, "result": res, "pos": {"x": user.pos_x, "y": user.pos_y},
            "coins": user.coins, "score": user.score, "vip_level": user.vip_level}


# ── Loot ──────────────────────────────────────────────────────────────────────

@app.get("/api/loot/list")
def api_loot_list(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    crates = db.query(LootCrate).filter(LootCrate.user_id==user.id).order_by(LootCrate.id.desc()).limit(50).all()
    return {"crates": [{"id": c.id, "opened": c.opened, "reward_type": c.reward_type,
                        "reward_amount": c.reward_amount} for c in crates]}


@app.post("/api/loot/open/{crate_id}")
def api_loot_open(crate_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        res = open_loot(db, user, crate_id); db.commit()
    except ValueError as e:
        db.rollback(); raise HTTPException(400, str(e))
    return {"ok": True, "result": res, "coins": user.coins}


# ── Shop ──────────────────────────────────────────────────────────────────────

@app.get("/api/shop/catalog")
def api_shop_catalog(user: User = Depends(get_current_user)):
    cat = get_shop_catalog()
    return {"items": [
        {"id": cid, "title": it["title"], "price": it["price"], "kind": it["kind"],
         "payload": it.get("payload", ""), "vip_required": it.get("vip_required", 0)}
        for cid, it in cat.items()
    ]}


@app.post("/api/shop/buy")
def api_shop_buy(body: ShopBuyIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        res = buy_shop_item(db, user, body.item_id); db.commit()
    except ValueError as e:
        db.rollback(); raise HTTPException(400, str(e))
    return {"ok": True, "result": res, "coins": user.coins}


# ── Profile & cosmetics ───────────────────────────────────────────────────────

@app.get("/api/profile")
def api_profile(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    inv = list_inventory(db, user)
    return {
        "me": {"id": user.id, "display_name": user.display_name, "coins": user.coins,
               "score": user.score, "tiles_painted": user.tiles_painted,
               "owned_tiles": user.owned_tiles or 0,
               "xp": user.xp, "level": user.level, "base_color": user.base_color,
               "paint_style": user.paint_style, "border_style": user.border_style or "none",
               "vip_level": user.vip_level, "total_donated_stars": user.total_donated_stars,
               "capture_streak": user.capture_streak or 0},
        "inventory": inv,
    }


@app.post("/api/cosmetics/equip")
def api_equip(body: EquipIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        res = equip_cosmetic(db, user, body.cosmetic_id); db.commit()
    except ValueError as e:
        db.rollback(); raise HTTPException(400, str(e))
    return {"ok": True, "result": res}


# ── Achievements ──────────────────────────────────────────────────────────────

@app.get("/api/achievements")
def api_achievements(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"achievements": get_achievements(db, user)}


# ── Daily quests ──────────────────────────────────────────────────────────────

@app.get("/api/daily")
def api_daily(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"quests": get_daily_quests(db, user)}


@app.post("/api/daily/claim")
def api_daily_claim(body: ClaimQuestIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        res = claim_daily_quest(db, user, body.quest_id); db.commit()
    except ValueError as e:
        db.rollback(); raise HTTPException(400, str(e))
    return {"ok": True, "result": res, "coins": user.coins}


# ── Mini-events ───────────────────────────────────────────────────────────────

@app.get("/api/events")
def api_events(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    events = get_active_events(db)
    db.commit()
    return {"events": events}


# ── Donation Pool ─────────────────────────────────────────────────────────────

@app.get("/api/pool")
def api_pool(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    info = get_pool_info(db); db.commit()
    return info


@app.post("/api/pool/donate")
def api_pool_donate(body: DonateIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        res = add_donation(db, user, body.stars, body.tg_payment_charge_id); db.commit()
    except ValueError as e:
        db.rollback(); raise HTTPException(400, str(e))
    return {"ok": True, "result": res, "coins": user.coins, "vip_level": user.vip_level}


@app.post("/api/pool/finish")
def api_pool_finish(x_admin_secret: str | None = Header(default=None, alias="X-ADMIN-SECRET"),
                    db: Session = Depends(get_db)):
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(403, "forbidden")
    try:
        res = finish_pool(db); db.commit()
    except ValueError as e:
        db.rollback(); raise HTTPException(400, str(e))
    return {"ok": True, "result": res}


# ── Leaderboard ───────────────────────────────────────────────────────────────

@app.get("/api/leaderboard")
def api_leaderboard(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"leaderboard": get_leaderboard(db)}


# ── Misc ──────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"ok": True}


# ── Alerts & War Feed ─────────────────────────────────────────────────────────

@app.get("/api/game/my_alerts")
def api_my_alerts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"alerts": get_my_alerts(db, user)}


@app.get("/api/warfeed")
def api_warfeed(db: Session = Depends(get_db)):
    return {"feed": get_war_feed(db)}


# ── Pool: history, invoice, withdrawal ───────────────────────────────────────

@app.get("/api/pool/history")
def api_pool_history(db: Session = Depends(get_db)):
    return {"history": get_round_history(db)}


@app.post("/api/pool/create_invoice")
async def api_create_invoice(
    stars: int = Query(ge=1, le=2500),
    user: User = Depends(get_current_user),
):
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"https://api.telegram.org/bot{settings.bot_token}/createInvoiceLink",
            json={
                "title": f"Донат {stars} ⭐ в пул",
                "description": f"Вложи {stars} звёзд в общий пул. Победитель забирает всё!",
                "payload": f"pool_donate_{stars}",
                "currency": "XTR",
                "prices": [{"label": f"{stars} Stars", "amount": stars}],
            },
        )
    data = resp.json()
    if not data.get("ok"):
        raise HTTPException(500, f"invoice_failed: {data.get('description','')}")
    return {"invoice_link": data["result"]}


@app.post("/api/pool/withdrawal")
async def api_withdrawal(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    won_round = db.execute(
        select(DonationRound)
        .where(
            DonationRound.status == DonationRoundStatus.finished,
            DonationRound.winner_user_id == user.id,
            DonationRound.total_stars > 0,
        )
        .order_by(DonationRound.id.desc())
    ).scalar_one_or_none()
    if not won_round:
        raise HTTPException(400, "not_winner")
    if won_round.withdrawal:
        return {"ok": True, "status": won_round.withdrawal.status, "already_requested": True}
    wr = WithdrawalRequest(
        round_id=won_round.id,
        winner_user_id=user.id,
        winner_tg_id=user.tg_user_id,
        total_stars=won_round.total_stars,
    )
    db.add(wr)
    db.commit()

    # Notify admin via Bot API
    if settings.admin_tg_id:
        tg_username = f"@{user.username}" if user.username else f"TG ID: {user.tg_user_id}"
        text = (
            f"🏆 <b>Запрос на вывод приза!</b>\n\n"
            f"Раунд: <b>#{won_round.id}</b>\n"
            f"Победитель: <b>{user.display_name}</b> ({tg_username})\n"
            f"TG ID: <code>{user.tg_user_id}</code>\n"
            f"Сумма: <b>{won_round.total_stars} ⭐</b>\n\n"
            f"Выплати через Fragment и подтверди командой:\n"
            f"<code>/admin_pay {won_round.id}</code>"
        )
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                await client.post(
                    f"https://api.telegram.org/bot{settings.bot_token}/sendMessage",
                    json={"chat_id": settings.admin_tg_id, "text": text, "parse_mode": "HTML"},
                )
        except Exception:
            pass

    return {"ok": True, "status": "pending", "already_requested": False}


@app.post("/api/pool/admin_pay/{round_id}")
async def api_admin_pay(
    round_id: int,
    x_admin_secret: str | None = Header(default=None, alias="X-ADMIN-SECRET"),
    db: Session = Depends(get_db),
):
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(403, "forbidden")
    wr = db.execute(
        select(WithdrawalRequest).where(WithdrawalRequest.round_id == round_id)
    ).scalar_one_or_none()
    if not wr:
        raise HTTPException(404, "no_withdrawal_request")
    from datetime import datetime
    wr.status = "paid"
    wr.paid_at = datetime.utcnow()
    db.commit()

    # Notify winner
    if wr.winner_tg_id:
        text = (
            f"✅ <b>Выплата произведена!</b>\n\n"
            f"Раунд #{round_id} · <b>{wr.total_stars} ⭐</b> отправлено.\n\n"
            f"Проверь входящие переводы в Telegram.\n"
            f"Спасибо за игру — до встречи в новом сезоне! 🎮"
        )
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                await client.post(
                    f"https://api.telegram.org/bot{settings.bot_token}/sendMessage",
                    json={"chat_id": wr.winner_tg_id, "text": text, "parse_mode": "HTML"},
                )
        except Exception:
            pass

    return {"ok": True, "round_id": round_id, "total_stars": wr.total_stars}


@app.get("/api/debug/settings")
def debug_settings(x_admin_secret: str | None = Header(default=None, alias="X-ADMIN-SECRET")):
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(403, "forbidden")
    tok = settings.telegram_bot_token_for_webapp_hash or settings.bot_token
    return {"bot_token_prefix": tok[:10]+"..." if tok else None,
            "env_webapp_url": settings.webapp_url,
            "env_database_url": settings.database_url,
            "arena_shape": getattr(settings, "arena_shape", "circle")}
