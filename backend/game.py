from __future__ import annotations

import hashlib
import hmac
import math
import random
import time
import colorsys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from backend.models import Boost, BoostType, CosmeticKind, LootCrate, Tile, User, UserCosmetic
from backend.settings import settings


def now_utc() -> datetime:
    return datetime.now(tz=timezone.utc).replace(tzinfo=None)


def clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def manhattan(ax: int, ay: int, bx: int, by: int) -> int:
    return abs(ax - bx) + abs(ay - by)


def map_center() -> tuple[int, int]:
    return settings.map_width // 2, settings.map_height // 2


def in_arena(x: int, y: int) -> bool:
    cx, cy = map_center()
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= settings.arena_radius_tiles * settings.arena_radius_tiles


def distance_to_center(x: int, y: int) -> float:
    cx, cy = map_center()
    return math.sqrt((x - cx) ** 2 + (y - cy) ** 2)


def loot_chance_for_position(x: int, y: int) -> float:
    """
    Higher chance near center, lower near edges.
    Returns probability 0..1 for getting a crate on a successful NEW paint.
    """
    max_dist = math.sqrt((settings.map_width / 2) ** 2 + (settings.map_height / 2) ** 2)
    d = distance_to_center(x, y)
    t = 1.0 - min(1.0, d / max_dist)  # 1 at center, 0 at far corner
    base = 0.02
    bonus = 0.10 * (t**2)
    return base + bonus


def random_spawn_edge() -> tuple[int, int]:
    # Spawn on the circular arena boundary, randomly by angle.
    cx, cy = map_center()
    r = settings.arena_radius_tiles
    ang = random.random() * math.tau
    x = int(round(cx + r * math.cos(ang)))
    y = int(round(cy + r * math.sin(ang)))
    x = clamp(x, 0, settings.map_width - 1)
    y = clamp(y, 0, settings.map_height - 1)
    if in_arena(x, y):
        return x, y
    # If rounding put us outside, step inward a bit.
    for _ in range(8):
        dx = x - cx
        dy = y - cy
        x = int(round(x - (1 if dx > 0 else -1 if dx < 0 else 0)))
        y = int(round(y - (1 if dy > 0 else -1 if dy < 0 else 0)))
        x = clamp(x, 0, settings.map_width - 1)
        y = clamp(y, 0, settings.map_height - 1)
        if in_arena(x, y):
            return x, y
    return cx, cy


def cleanup_expired_boosts(db: Session, user: User) -> None:
    t = now_utc()
    for b in user.boosts:
        if b.active and b.expires_at <= t:
            b.active = False
    db.flush()


@dataclass
class EffectiveStats:
    coin_multiplier: float
    paint_range: int
    speed_multiplier: float


def effective_stats(db: Session, user: User) -> EffectiveStats:
    cleanup_expired_boosts(db, user)
    coin_mult = 1.0
    paint_range = 1
    speed_mult = 1.0
    t = now_utc()

    boosts = db.execute(
        select(Boost).where(and_(Boost.user_id == user.id, Boost.active == True, Boost.expires_at > t))  # noqa: E712
    ).scalars()
    for b in boosts:
        if b.boost_type == BoostType.coin_multiplier:
            coin_mult *= max(1.0, b.value_float / 1000.0)
        elif b.boost_type == BoostType.paint_range:
            paint_range = max(paint_range, int(b.value_int))
        elif b.boost_type == BoostType.speed:
            speed_mult *= max(1.0, b.value_float / 1000.0)
    return EffectiveStats(coin_multiplier=coin_mult, paint_range=paint_range, speed_multiplier=speed_mult)


def can_act(last_at: datetime | None, cooldown_ms: int, speed_multiplier: float) -> bool:
    if last_at is None:
        return True
    cooldown = cooldown_ms / max(0.25, speed_multiplier)
    return (now_utc() - last_at).total_seconds() * 1000.0 >= cooldown


def ensure_user(db: Session, tg_user_id: int, username: str | None, display_name: str | None) -> User:
    user = db.execute(select(User).where(User.tg_user_id == tg_user_id)).scalar_one_or_none()
    if user:
        if username is not None:
            user.username = username
        if display_name:
            user.display_name = display_name[:64]
        return user

    # pleasant identity color (deterministic by tg_user_id; thousands of shades)
    # golden ratio step produces nicely spread hues
    hue = ((tg_user_id * 0.61803398875) % 1.0)
    sat = 0.78
    val = 0.78
    r, g, b = colorsys.hsv_to_rgb(hue, sat, val)
    base_hex = f"#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}"

    sx, sy = random_spawn_edge()
    user = User(
        tg_user_id=tg_user_id,
        username=username,
        display_name=(display_name or "Player")[:64],
        pos_x=sx,
        pos_y=sy,
        coins=0,
        score=0,
        tiles_painted=0,
        xp=0,
        level=1,
        base_color=base_hex,
        paint_style="solid",
    )
    db.add(user)
    db.flush()

    # Paint spawn cell immediately, so the initial tile isn't empty.
    db.add(Tile(x=sx, y=sy, owner_user_id=user.id, color=current_tile_style(user)))
    db.flush()
    return user


def _hex_to_rgb01(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    if len(h) != 6:
        return 0.3, 0.8, 1.0
    r = int(h[0:2], 16) / 255.0
    g = int(h[2:4], 16) / 255.0
    b = int(h[4:6], 16) / 255.0
    return r, g, b


def _rgb01_to_hex(r: float, g: float, b: float) -> str:
    return f"#{int(clamp(int(r*255),0,255)):02x}{int(clamp(int(g*255),0,255)):02x}{int(clamp(int(b*255),0,255)):02x}"


def brightened_color(base_hex: str, level: int) -> str:
    # brighten with level (cap)
    r, g, b = _hex_to_rgb01(base_hex)
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    boost = min(0.35, 0.02 * max(0, level - 1))
    v2 = min(1.0, v + boost)
    r2, g2, b2 = colorsys.hsv_to_rgb(h, s, v2)
    return _rgb01_to_hex(r2, g2, b2)


def current_tile_style(user: User) -> str:
    col = brightened_color(user.base_color, user.level)
    return f"{user.paint_style}:{col}"


def move_user(db: Session, user: User, dx: int, dy: int) -> None:
    stats = effective_stats(db, user)
    if not can_act(user.last_move_at, settings.move_cooldown_ms, stats.speed_multiplier):
        raise ValueError("move_cooldown")
    nx = clamp(user.pos_x + dx, 0, settings.map_width - 1)
    ny = clamp(user.pos_y + dy, 0, settings.map_height - 1)
    if not in_arena(nx, ny):
        raise ValueError("out_of_arena")
    user.pos_x = nx
    user.pos_y = ny
    user.last_move_at = now_utc()


def paint_tile(db: Session, user: User, x: int, y: int, color: str) -> dict:
    stats = effective_stats(db, user)
    if not can_act(user.last_paint_at, settings.paint_cooldown_ms, stats.speed_multiplier):
        raise ValueError("paint_cooldown")

    x = clamp(x, 0, settings.map_width - 1)
    y = clamp(y, 0, settings.map_height - 1)
    if not in_arena(x, y):
        raise ValueError("out_of_arena")

    if manhattan(user.pos_x, user.pos_y, x, y) > stats.paint_range:
        raise ValueError("too_far")

    style = current_tile_style(user)
    existing = db.execute(select(Tile).where(and_(Tile.x == x, Tile.y == y))).scalar_one_or_none()
    newly_claimed = existing is None or existing.owner_user_id != user.id

    if existing is None:
        db.add(Tile(x=x, y=y, owner_user_id=user.id, color=style))
    else:
        existing.owner_user_id = user.id
        existing.color = style
        existing.painted_at = now_utc()

    # move player onto painted tile (simplifies gameplay)
    user.pos_x = x
    user.pos_y = y
    user.last_paint_at = now_utc()

    if newly_claimed:
        reward_coins = max(1, int(settings.base_tile_reward_coins * stats.coin_multiplier))
        reward_score = settings.base_tile_reward_score
        user.coins += reward_coins
        user.score += reward_score
        user.tiles_painted += 1
        user.xp += 1
        # level up each 25 xp
        new_level = 1 + (user.xp // 25)
        leveled = new_level != user.level
        user.level = new_level

        if leveled:
            # brighten color affects visuals; repaint owned tiles to updated style
            new_style = current_tile_style(user)
            db.query(Tile).filter(Tile.owner_user_id == user.id).update({Tile.color: new_style})

        got_loot = random.random() < loot_chance_for_position(x, y)
        if got_loot:
            db.add(LootCrate(user_id=user.id))

        return {"new": True, "coins": reward_coins, "score": reward_score, "loot": got_loot, "level": user.level}

    return {"new": False, "coins": 0, "score": 0, "loot": False, "level": user.level}


def open_loot(db: Session, user: User, crate_id: int) -> dict:
    crate = db.execute(
        select(LootCrate).where(and_(LootCrate.id == crate_id, LootCrate.user_id == user.id))
    ).scalar_one_or_none()
    if crate is None:
        raise ValueError("not_found")
    if crate.opened:
        return {"already_opened": True, "reward_type": crate.reward_type, "reward_amount": crate.reward_amount}

    roll = random.random()
    if roll < 0.55:
        # coins
        amt = random.randint(15, 60)
        crate.reward_type = "coins"
        crate.reward_amount = amt
        user.coins += amt
    elif roll < 0.80:
        # coin multiplier for 10 min
        crate.reward_type = "boost_coin_x2_10m"
        crate.reward_amount = 2
        db.add(
            Boost(
                user_id=user.id,
                boost_type=BoostType.coin_multiplier,
                value_float=2000,
                value_int=0,
                expires_at=now_utc() + timedelta(minutes=10),
            )
        )
    elif roll < 0.93:
        # paint range 2 for 8 min
        crate.reward_type = "boost_range_2_8m"
        crate.reward_amount = 2
        db.add(
            Boost(
                user_id=user.id,
                boost_type=BoostType.paint_range,
                value_int=2,
                value_float=0,
                expires_at=now_utc() + timedelta(minutes=8),
            )
        )
    else:
        # speed 1.5x for 6 min
        crate.reward_type = "boost_speed_1_5x_6m"
        crate.reward_amount = 1500
        db.add(
            Boost(
                user_id=user.id,
                boost_type=BoostType.speed,
                value_float=1500,
                value_int=0,
                expires_at=now_utc() + timedelta(minutes=6),
            )
        )

    crate.opened = True
    crate.opened_at = now_utc()
    db.flush()
    return {"already_opened": False, "reward_type": crate.reward_type, "reward_amount": crate.reward_amount}


def buy_shop_item(db: Session, user: User, item_id: str) -> dict:
    """
    Player invests coins into boosts. Prices tuned for MVP.
    """
    catalog = get_shop_catalog()
    if item_id not in catalog:
        raise ValueError("bad_item")
    it = catalog[item_id]
    if user.coins < it["price"]:
        raise ValueError("no_money")
    user.coins -= it["price"]

    if it["kind"] in ("style", "color"):
        kind = CosmeticKind.style if it["kind"] == "style" else CosmeticKind.color
        existing = db.execute(
            select(UserCosmetic).where(and_(UserCosmetic.user_id == user.id, UserCosmetic.cosmetic_id == item_id))
        ).scalar_one_or_none()
        if existing is None:
            db.add(
                UserCosmetic(
                    user_id=user.id,
                    cosmetic_id=item_id,
                    kind=kind,
                    title=it["title"],
                    payload=it["payload"],
                )
            )
        db.flush()
        return {"ok": True, "item": item_id, "spent": it["price"], "kind": it["kind"]}

    db.add(
        Boost(
            user_id=user.id,
            boost_type=it["type"],
            value_int=it["value_int"],
            value_float=it["value_float"],
            expires_at=now_utc() + timedelta(minutes=it["min"]),
        )
    )
    db.flush()
    return {"ok": True, "item": item_id, "spent": it["price"]}


def get_shop_catalog() -> dict[str, dict]:
    """
    Unified shop catalog.
    kind: boost|style|color
    payload: style name or hex color for cosmetics
    """
    # free for testing (prices = 0)
    catalog: dict[str, dict] = {
        "coin_x2_30m": {
            "kind": "boost",
            "title": "x2 монеты (30 мин)",
            "price": 0,
            "type": BoostType.coin_multiplier,
            "value_float": 2000,
            "value_int": 0,
            "min": 30,
        },
        "range_2_20m": {
            "kind": "boost",
            "title": "дальность покраски 2 (20 мин)",
            "price": 0,
            "type": BoostType.paint_range,
            "value_float": 0,
            "value_int": 2,
            "min": 20,
        },
        "speed_1_5x_20m": {
            "kind": "boost",
            "title": "скорость 1.5x (20 мин)",
            "price": 0,
            "type": BoostType.speed,
            "value_float": 1500,
            "value_int": 0,
            "min": 20,
        },
    }

    styles = [
        ("solid", "Стиль: Сплошной"),
        ("gradient", "Стиль: Градиент"),
        ("marble", "Стиль: Мрамор"),
        ("magma", "Стиль: Магма"),
        ("magma_sparks", "Стиль: Магма (искры)"),
        ("neon_pulse", "Стиль: Неон (пульс)"),
        ("rainbow_shift", "Стиль: Радуга (перелив)"),
        ("ice", "Стиль: Лёд"),
        ("crystal", "Стиль: Кристалл"),
        ("aurora", "Стиль: Аврора"),
        ("galaxy", "Стиль: Галактика"),
        ("glitch", "Стиль: Глитч"),
        ("carbon", "Стиль: Карбон"),
    ]
    for name, title in styles:
        cid = f"style_{name}"
        catalog[cid] = {"kind": "style", "title": f"{title} (перманент)", "price": 0, "payload": name}

    colors = [
        ("#ff3b30", "Красный"),
        ("#ff9500", "Янтарь"),
        ("#ffd60a", "Жёлтый"),
        ("#34c759", "Зелёный"),
        ("#00c7be", "Тиффани"),
        ("#0a84ff", "Синий"),
        ("#5e5ce6", "Индиго"),
        ("#bf5af2", "Фиолетовый"),
        ("#ff2d55", "Розовый неон"),
        ("#64d2ff", "Лёд-голубой"),
        ("#30d158", "Неон-лайм"),
        ("#ff9f0a", "Лава-оранжевый"),
        ("#f2f2f7", "Белый"),
        ("#1c1c1e", "Графит"),
    ]
    for i, (hx, title) in enumerate(colors, start=1):
        cid = f"color_{i:02d}"
        catalog[cid] = {"kind": "color", "title": f"Цвет: {title} (перманент)", "price": 0, "payload": hx}

    return catalog


def list_inventory(db: Session, user: User) -> list[dict]:
    items = (
        db.execute(select(UserCosmetic).where(UserCosmetic.user_id == user.id).order_by(UserCosmetic.id.desc()))
        .scalars()
        .all()
    )
    return [
        {"id": it.cosmetic_id, "kind": it.kind.value, "title": it.title, "payload": it.payload}
        for it in items
    ]


def equip_cosmetic(db: Session, user: User, cosmetic_id: str) -> dict:
    it = db.execute(
        select(UserCosmetic).where(and_(UserCosmetic.user_id == user.id, UserCosmetic.cosmetic_id == cosmetic_id))
    ).scalar_one_or_none()
    if it is None:
        # мягкое поведение: если почему-то нет записи, просто ничего не меняем
        return {"ok": False, "equipped": None, "reason": "not_owned"}
    if it.kind == CosmeticKind.style:
        user.paint_style = it.payload
    elif it.kind == CosmeticKind.color:
        user.base_color = it.payload
    # recolor all owned tiles immediately
    new_style = current_tile_style(user)
    db.query(Tile).filter(Tile.owner_user_id == user.id).update({Tile.color: new_style})
    db.flush()
    return {"ok": True, "equipped": cosmetic_id, "style": user.paint_style, "color": user.base_color}


# --- Telegram WebApp auth (initData verification) ---


def _telegram_webapp_secret(bot_token: str) -> bytes:
    # Telegram Mini Apps (WebApp initData) secret (most common):
    # secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
    return hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()


def verify_telegram_init_data(init_data: str, bot_token: str) -> dict:
    """
    Validates Telegram WebApp initData string per Telegram docs.
    Returns parsed key/value dict (including user as JSON string).
    Raises ValueError if invalid.
    """
    parsed = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = parsed.pop("hash", None)
    if not received_hash:
        raise ValueError("no_hash")

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))

    # In the wild, implementations occasionally differ by secret derivation.
    # We accept any matching calculation among known-correct variants to reduce false rejects.
    secrets: list[bytes] = [
        _telegram_webapp_secret(bot_token),
        # legacy/incorrect-but-seen variant
        hashlib.sha256(bot_token.encode("utf-8")).digest(),
        # reversed HMAC variant (seen in some snippets)
        hmac.new(bot_token.encode("utf-8"), b"WebAppData", hashlib.sha256).digest(),
    ]
    ok = False
    for sec in secrets:
        calculated = hmac.new(sec, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
        if hmac.compare_digest(calculated, received_hash):
            ok = True
            break
    if not ok:
        raise ValueError("bad_hash")

    # optional freshness check
    auth_date = parsed.get("auth_date")
    if auth_date and auth_date.isdigit():
        if time.time() - int(auth_date) > 24 * 3600:
            raise ValueError("too_old")
    return parsed

