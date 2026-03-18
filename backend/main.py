from __future__ import annotations

import json
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.db import SessionLocal, init_db
from backend.game import (
    buy_shop_item,
    ensure_user,
    equip_cosmetic,
    get_shop_catalog,
    list_inventory,
    in_arena,
    move_user,
    open_loot,
    paint_tile,
    verify_telegram_init_data,
)
from backend.models import LootCrate, Tile, User
from backend.settings import settings


BASE_DIR = Path(__file__).resolve().parent.parent
WEBAPP_DIR = BASE_DIR / "webapp"

app = FastAPI(title="Telegram Pixel Field")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
        # dev/admin bypass: use a fixed tg id
        user = ensure_user(db, tg_user_id=999000, username="admin", display_name="Admin")
        # Persist auto-created user across requests (each request has its own DB session).
        db.commit()
        db.refresh(user)
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
    display_name = ((u.get("first_name") or "") + " " + (u.get("last_name") or "")).strip() or u.get("first_name") or "Player"
    user = ensure_user(db, tg_user_id=tg_user_id, username=username, display_name=display_name)
    db.commit()
    db.refresh(user)
    return user


@app.on_event("startup")
def _startup():
    init_db()


app.mount("/webapp/static", StaticFiles(directory=str(WEBAPP_DIR / "static")), name="webapp_static")


@app.get("/webapp/", response_class=HTMLResponse)
def webapp_index():
    index_path = WEBAPP_DIR / "index.html"
    return HTMLResponse(index_path.read_text(encoding="utf-8"))


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


@app.get("/api/me")
def api_me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.flush()
    return {
        "id": user.id,
        "tg_user_id": user.tg_user_id,
        "username": user.username,
        "display_name": user.display_name,
        "coins": user.coins,
        "score": user.score,
        "tiles_painted": user.tiles_painted,
        "xp": user.xp,
        "level": user.level,
        "base_color": user.base_color,
        "paint_style": user.paint_style,
        "pos": {"x": user.pos_x, "y": user.pos_y},
    }


@app.get("/api/game/state")
def api_state(
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # clamp viewport
    x0 = max(0, min(settings.map_width - 1, x0))
    y0 = max(0, min(settings.map_height - 1, y0))
    x1 = max(0, min(settings.map_width - 1, x1))
    y1 = max(0, min(settings.map_height - 1, y1))
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0

    tiles = (
        db.query(Tile)
        .filter(Tile.x >= x0, Tile.x <= x1, Tile.y >= y0, Tile.y <= y1)
        .limit(50000)
        .all()
    )
    tiles = [t for t in tiles if in_arena(t.x, t.y)]
    players = (
        db.query(User)
        .filter(User.pos_x >= x0, User.pos_x <= x1, User.pos_y >= y0, User.pos_y <= y1)
        .limit(200)
        .all()
    )
    players = [p for p in players if in_arena(p.pos_x, p.pos_y)]
    return {
        "map": {"w": settings.map_width, "h": settings.map_height},
        "me": {"x": user.pos_x, "y": user.pos_y, "id": user.id},
        "tiles": [{"x": t.x, "y": t.y, "c": t.color, "o": t.owner_user_id} for t in tiles],
        "players": [
            {
                "id": p.id,
                "x": p.pos_x,
                "y": p.pos_y,
                "name": p.display_name,
                "style": f"{p.paint_style}:{p.base_color}",
                "level": p.level,
            }
            for p in players
        ],
    }


@app.get("/api/game/minimap")
def api_minimap(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    tiles = (
        db.query(Tile)
        .filter(Tile.x >= 0, Tile.x < settings.map_width, Tile.y >= 0, Tile.y < settings.map_height)
        .all()
    )
    tiles = [t for t in tiles if in_arena(t.x, t.y)]

    players = (
        db.query(User)
        .filter(User.pos_x >= 0, User.pos_x < settings.map_width, User.pos_y >= 0, User.pos_y < settings.map_height)
        .limit(500)
        .all()
    )
    players = [p for p in players if in_arena(p.pos_x, p.pos_y)]
    return {
        "map": {"w": settings.map_width, "h": settings.map_height},
        "tiles": [{"x": t.x, "y": t.y, "c": t.color, "o": t.owner_user_id} for t in tiles],
        "players": [
            {
                "id": p.id,
                "x": p.pos_x,
                "y": p.pos_y,
                "style": f"{p.paint_style}:{p.base_color}",
                "level": p.level,
            }
            for p in players
        ],
        "me": {"id": user.id, "x": user.pos_x, "y": user.pos_y},
    }


@app.post("/api/game/move")
def api_move(body: MoveIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        move_user(db, user, body.dx, body.dy)
        db.commit()
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "pos": {"x": user.pos_x, "y": user.pos_y}}


@app.post("/api/game/paint")
def api_paint(body: PaintIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        res = paint_tile(db, user, body.x, body.y, body.color)
        db.commit()
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "result": res, "pos": {"x": user.pos_x, "y": user.pos_y}, "coins": user.coins, "score": user.score}


@app.get("/api/loot/list")
def api_loot_list(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    crates = (
        db.query(LootCrate)
        .filter(LootCrate.user_id == user.id)
        .order_by(LootCrate.id.desc())
        .limit(50)
        .all()
    )
    return {
        "crates": [
            {"id": c.id, "opened": c.opened, "reward_type": c.reward_type, "reward_amount": c.reward_amount}
            for c in crates
        ]
    }


@app.post("/api/loot/open/{crate_id}")
def api_loot_open(crate_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        res = open_loot(db, user, crate_id)
        db.commit()
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "result": res, "coins": user.coins}


@app.get("/api/shop/catalog")
def api_shop_catalog():
    cat = get_shop_catalog()
    return {
        "items": [
            {"id": cid, "title": it["title"], "price": it["price"], "kind": it["kind"]}
            for cid, it in cat.items()
        ]
    }


@app.post("/api/shop/buy")
def api_shop_buy(body: ShopBuyIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        res = buy_shop_item(db, user, body.item_id)
        db.commit()
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "result": res, "coins": user.coins}


@app.get("/api/profile")
def api_profile(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    inv = list_inventory(db, user)
    return {
        "me": {
            "id": user.id,
            "display_name": user.display_name,
            "coins": user.coins,
            "score": user.score,
            "tiles_painted": user.tiles_painted,
            "xp": user.xp,
            "level": user.level,
            "base_color": user.base_color,
            "paint_style": user.paint_style,
        },
        "inventory": inv,
    }


@app.post("/api/cosmetics/equip")
def api_cosmetics_equip(body: EquipIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        res = equip_cosmetic(db, user, body.cosmetic_id)
        db.commit()
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "result": res}


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/debug/settings")
def debug_settings(x_admin_secret: str | None = Header(default=None, alias="X-ADMIN-SECRET")):
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=403, detail="forbidden")
    tok = settings.telegram_bot_token_for_webapp_hash or settings.bot_token
    return {
        "bot_token_prefix": tok[:10] + "..." if tok else None,
        "bot_token_len": len(tok) if tok else 0,
        "env_webapp_url": settings.webapp_url,
        "env_database_url": settings.database_url,
        "admin_secret_set": bool(settings.admin_secret),
    }

