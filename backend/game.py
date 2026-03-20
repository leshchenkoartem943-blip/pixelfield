from __future__ import annotations

import hashlib
import hmac
import math
import random
import time
import colorsys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qsl

from sqlalchemy import and_, select, func
from sqlalchemy.orm import Session

from backend.models import (
    Boost, BoostType, CosmeticKind, Donation, DonationRound, DonationRoundStatus,
    LootCrate, MiniEvent, Tile, TileAttackEvent, User, UserAchievement, UserCosmetic,
    DailyQuestProgress, WithdrawalRequest,
)
from backend.settings import settings


# ── Helpers ──────────────────────────────────────────────────────────────────

def now_utc() -> datetime:
    return datetime.now(tz=timezone.utc).replace(tzinfo=None)


def today_date() -> date:
    return datetime.now(tz=timezone.utc).date()


def clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def manhattan(ax: int, ay: int, bx: int, by: int) -> int:
    return abs(ax - bx) + abs(ay - by)


def map_center() -> tuple[int, int]:
    return settings.map_width // 2, settings.map_height // 2


# ── Arena shapes ─────────────────────────────────────────────────────────────

def _star_check(x: int, y: int) -> bool:
    """6-pointed star arena."""
    cx, cy = map_center()
    r = settings.arena_radius_tiles
    dx, dy = x - cx, y - cy
    dist = math.sqrt(dx * dx + dy * dy)
    if dist > r:
        return False
    if dist == 0:
        return True
    angle = math.atan2(dy, dx)
    # star has 6 arms; compute minimum scale needed to reach this point
    arm_angle = (angle % (math.tau / 6))
    arm_factor = math.cos(math.pi / 6) / max(1e-9, math.cos(arm_angle - math.pi / 6))
    return dist <= r * arm_factor


def in_arena(x: int, y: int) -> bool:
    shape = getattr(settings, "arena_shape", "circle")
    cx, cy = map_center()
    dx, dy = x - cx, y - cy
    r = settings.arena_radius_tiles
    if shape == "square":
        return abs(dx) <= r and abs(dy) <= r
    if shape == "star":
        return _star_check(x, y)
    # default: circle
    return dx * dx + dy * dy <= r * r


def distance_to_center(x: int, y: int) -> float:
    cx, cy = map_center()
    return math.sqrt((x - cx) ** 2 + (y - cy) ** 2)


def loot_chance_for_position(x: int, y: int) -> float:
    max_dist = float(settings.arena_radius_tiles)
    d = distance_to_center(x, y)
    t = 1.0 - min(1.0, d / max_dist)
    return 0.02 + 0.12 * (t ** 2)


def random_spawn_edge(vip: bool = False) -> tuple[int, int]:
    cx, cy = map_center()
    r = settings.arena_radius_tiles
    if vip:
        # VIP spawns near center (inner 25%)
        for _ in range(20):
            ang = random.random() * math.tau
            d = random.randint(0, r // 4)
            x = clamp(int(round(cx + d * math.cos(ang))), 0, settings.map_width - 1)
            y = clamp(int(round(cy + d * math.sin(ang))), 0, settings.map_height - 1)
            if in_arena(x, y):
                return x, y
    ang = random.random() * math.tau
    x = int(round(cx + r * math.cos(ang)))
    y = int(round(cy + r * math.sin(ang)))
    x = clamp(x, 0, settings.map_width - 1)
    y = clamp(y, 0, settings.map_height - 1)
    if in_arena(x, y):
        return x, y
    for _ in range(8):
        dx2 = x - cx
        dy2 = y - cy
        x = int(round(x - (1 if dx2 > 0 else -1 if dx2 < 0 else 0)))
        y = int(round(y - (1 if dy2 > 0 else -1 if dy2 < 0 else 0)))
        x = clamp(x, 0, settings.map_width - 1)
        y = clamp(y, 0, settings.map_height - 1)
        if in_arena(x, y):
            return x, y
    return cx, cy


# ── VIP ──────────────────────────────────────────────────────────────────────

def compute_vip_level(total_donated_stars: int) -> int:
    if total_donated_stars >= 100:
        return 3  # gold
    if total_donated_stars >= 25:
        return 2  # silver
    if total_donated_stars >= 5:
        return 1  # bronze
    return 0


VIP_NAMES = {0: "", 1: "Bronze VIP", 2: "Silver VIP", 3: "Gold VIP"}
VIP_COIN_MULT = {0: 1.0, 1: 1.5, 2: 2.0, 3: 3.0}
VIP_PAINT_RANGE = {0: 1, 1: 2, 2: 2, 3: 3}


# ── Effective stats ───────────────────────────────────────────────────────────

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
    vip = compute_vip_level(user.total_donated_stars)
    coin_mult = VIP_COIN_MULT[vip]
    paint_range = VIP_PAINT_RANGE[vip]
    speed_mult = 1.0
    t = now_utc()

    boosts = db.execute(
        select(Boost).where(and_(Boost.user_id == user.id, Boost.active == True, Boost.expires_at > t))  # noqa: E712
    ).scalars()
    for b in boosts:
        if b.boost_type == BoostType.coin_multiplier:
            coin_mult = max(coin_mult, coin_mult * max(1.0, b.value_float / 1000.0))
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


# ── User creation ─────────────────────────────────────────────────────────────

def ensure_user(db: Session, tg_user_id: int, username: str | None, display_name: str | None) -> User:
    user = db.execute(select(User).where(User.tg_user_id == tg_user_id)).scalar_one_or_none()
    if user:
        if username is not None:
            user.username = username
        if display_name:
            user.display_name = display_name[:64]
        return user

    hue = ((tg_user_id * 0.61803398875) % 1.0)
    r, g, b = colorsys.hsv_to_rgb(hue, 0.78, 0.78)
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
        total_donated_stars=0,
        vip_level=0,
    )
    db.add(user)
    db.flush()
    db.add(Tile(x=sx, y=sy, owner_user_id=user.id, color=current_tile_style(user), defense=0))
    db.flush()
    return user


# ── Color / style helpers ─────────────────────────────────────────────────────

def _hex_to_rgb01(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    if len(h) != 6:
        return 0.3, 0.8, 1.0
    return int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0


def _rgb01_to_hex(r: float, g: float, b: float) -> str:
    return f"#{clamp(int(r*255),0,255):02x}{clamp(int(g*255),0,255):02x}{clamp(int(b*255),0,255):02x}"


def brightened_color(base_hex: str, level: int) -> str:
    r, g, b = _hex_to_rgb01(base_hex)
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    boost = min(0.35, 0.02 * max(0, level - 1))
    r2, g2, b2 = colorsys.hsv_to_rgb(h, s, min(1.0, v + boost))
    return _rgb01_to_hex(r2, g2, b2)


def current_tile_style(user: User) -> str:
    col = brightened_color(user.base_color, user.level)
    return f"{user.paint_style}:{col}"


# ── Achievements ──────────────────────────────────────────────────────────────

ACHIEVEMENTS: dict[str, dict] = {
    "tiles_10":    {"title": "Первые шаги",  "desc": "Покрась 10 клеток",    "field": "tiles_painted", "threshold": 10,    "reward_coins": 20,   "icon": "🎨"},
    "tiles_100":   {"title": "Художник",      "desc": "Покрась 100 клеток",   "field": "tiles_painted", "threshold": 100,   "reward_coins": 100,  "icon": "🖌️"},
    "tiles_500":   {"title": "Маэстро",       "desc": "Покрась 500 клеток",   "field": "tiles_painted", "threshold": 500,   "reward_coins": 400,  "icon": "🏅"},
    "tiles_1000":  {"title": "Мастер",        "desc": "Покрась 1000 клеток",  "field": "tiles_painted", "threshold": 1000,  "reward_coins": 800,  "icon": "🥇"},
    "tiles_5000":  {"title": "Захватчик",     "desc": "Покрась 5000 клеток",  "field": "tiles_painted", "threshold": 5000,  "reward_coins": 3000, "icon": "⚔️"},
    "tiles_10000": {"title": "Легенда",       "desc": "Покрась 10000 клеток", "field": "tiles_painted", "threshold": 10000, "reward_coins": 8000, "icon": "👑"},
    "level_5":     {"title": "Прокачка",      "desc": "Достигни 5 уровня",    "field": "level",         "threshold": 5,     "reward_coins": 50,   "icon": "⚡"},
    "level_10":    {"title": "Ветеран",       "desc": "Достигни 10 уровня",   "field": "level",         "threshold": 10,    "reward_coins": 200,  "icon": "🔥"},
    "level_20":    {"title": "Элита",         "desc": "Достигни 20 уровня",   "field": "level",         "threshold": 20,    "reward_coins": 600,  "icon": "💫"},
    "score_1000":  {"title": "Тысячник",      "desc": "Набери 1000 очков",    "field": "score",         "threshold": 1000,  "reward_coins": 150,  "icon": "⭐"},
    "score_5000":  {"title": "Чемпион",       "desc": "Набери 5000 очков",    "field": "score",         "threshold": 5000,  "reward_coins": 500,  "icon": "🏆"},
}


def check_achievements(db: Session, user: User) -> list[dict]:
    """Check and grant newly unlocked achievements. Returns list of new ones."""
    unlocked_ids = {a.achievement_id for a in user.achievements}
    new_achievements = []
    for ach_id, ach in ACHIEVEMENTS.items():
        if ach_id in unlocked_ids:
            continue
        val = getattr(user, ach["field"], 0)
        if val >= ach["threshold"]:
            db.add(UserAchievement(user_id=user.id, achievement_id=ach_id))
            user.coins += ach["reward_coins"]
            new_achievements.append({
                "id": ach_id,
                "title": ach["title"],
                "desc": ach["desc"],
                "icon": ach["icon"],
                "reward_coins": ach["reward_coins"],
            })
    if new_achievements:
        db.flush()
    return new_achievements


def get_achievements(db: Session, user: User) -> list[dict]:
    unlocked = {a.achievement_id: a.unlocked_at for a in user.achievements}
    result = []
    for ach_id, ach in ACHIEVEMENTS.items():
        val = getattr(user, ach["field"], 0)
        is_done = ach_id in unlocked
        result.append({
            "id": ach_id,
            "title": ach["title"],
            "desc": ach["desc"],
            "icon": ach["icon"],
            "reward_coins": ach["reward_coins"],
            "threshold": ach["threshold"],
            "field": ach["field"],
            "current": val,
            "completed": is_done,
            "unlocked_at": unlocked[ach_id].isoformat() if is_done else None,
        })
    return result


# ── Daily quests ──────────────────────────────────────────────────────────────

QUEST_POOL: list[dict] = [
    {"id": "paint_30",   "desc": "Покрась 30 новых клеток",   "type": "paint",  "target": 30,  "reward_coins": 40,  "icon": "🎨"},
    {"id": "paint_75",   "desc": "Покрась 75 новых клеток",   "type": "paint",  "target": 75,  "reward_coins": 90,  "icon": "🖌️"},
    {"id": "paint_150",  "desc": "Покрась 150 новых клеток",  "type": "paint",  "target": 150, "reward_coins": 200, "icon": "🖼️"},
    {"id": "loot_2",     "desc": "Найди 2 лутбокса",          "type": "loot",   "target": 2,   "reward_coins": 50,  "icon": "📦"},
    {"id": "loot_5",     "desc": "Найди 5 лутбоксов",         "type": "loot",   "target": 5,   "reward_coins": 120, "icon": "🎁"},
    {"id": "score_50",   "desc": "Набери 50 очков за день",   "type": "score",  "target": 50,  "reward_coins": 60,  "icon": "⭐"},
    {"id": "score_200",  "desc": "Набери 200 очков за день",  "type": "score",  "target": 200, "reward_coins": 180, "icon": "🌟"},
]

# 3 quests active per day, chosen deterministically by date
def _daily_quest_ids() -> list[str]:
    d = today_date()
    seed = d.year * 10000 + d.month * 100 + d.day
    rng = random.Random(seed)
    chosen = rng.sample(range(len(QUEST_POOL)), min(3, len(QUEST_POOL)))
    return [QUEST_POOL[i]["id"] for i in chosen]


def get_daily_quests(db: Session, user: User) -> list[dict]:
    quest_ids = _daily_quest_ids()
    today = today_date()
    result = []
    for qid in quest_ids:
        q = next((x for x in QUEST_POOL if x["id"] == qid), None)
        if not q:
            continue
        prog = db.execute(
            select(DailyQuestProgress).where(
                and_(DailyQuestProgress.user_id == user.id,
                     DailyQuestProgress.quest_id == qid,
                     DailyQuestProgress.date == today)
            )
        ).scalar_one_or_none()
        result.append({
            "id": qid,
            "desc": q["desc"],
            "icon": q["icon"],
            "target": q["target"],
            "reward_coins": q["reward_coins"],
            "progress": prog.progress if prog else 0,
            "completed": prog.completed if prog else False,
            "reward_claimed": prog.reward_claimed if prog else False,
        })
    return result


def _update_daily_quest(db: Session, user: User, quest_type: str, amount: int = 1) -> list[dict]:
    """Update daily quest progress. Returns list of newly completed quests."""
    quest_ids = _daily_quest_ids()
    today = today_date()
    completed_now = []
    for qid in quest_ids:
        q = next((x for x in QUEST_POOL if x["id"] == qid), None)
        if not q or q["type"] != quest_type:
            continue
        prog = db.execute(
            select(DailyQuestProgress).where(
                and_(DailyQuestProgress.user_id == user.id,
                     DailyQuestProgress.quest_id == qid,
                     DailyQuestProgress.date == today)
            )
        ).scalar_one_or_none()
        if prog is None:
            prog = DailyQuestProgress(user_id=user.id, quest_id=qid, date=today, progress=0)
            db.add(prog)
        if prog.completed:
            continue
        prog.progress = min(q["target"], prog.progress + amount)
        if prog.progress >= q["target"] and not prog.completed:
            prog.completed = True
            completed_now.append({"id": qid, "desc": q["desc"], "icon": q["icon"], "reward_coins": q["reward_coins"]})
    db.flush()
    return completed_now


def claim_daily_quest(db: Session, user: User, quest_id: str) -> dict:
    today = today_date()
    prog = db.execute(
        select(DailyQuestProgress).where(
            and_(DailyQuestProgress.user_id == user.id,
                 DailyQuestProgress.quest_id == quest_id,
                 DailyQuestProgress.date == today)
        )
    ).scalar_one_or_none()
    if not prog or not prog.completed:
        raise ValueError("not_completed")
    if prog.reward_claimed:
        raise ValueError("already_claimed")
    q = next((x for x in QUEST_POOL if x["id"] == quest_id), None)
    if not q:
        raise ValueError("bad_quest")
    prog.reward_claimed = True
    user.coins += q["reward_coins"]
    db.flush()
    return {"ok": True, "coins": q["reward_coins"]}


# ── Mini-events ───────────────────────────────────────────────────────────────

def get_active_events(db: Session) -> list[dict]:
    now = now_utc()
    _expire_old_events(db, now)
    _maybe_spawn_event(db, now)
    events = db.execute(
        select(MiniEvent).where(and_(MiniEvent.active == True, MiniEvent.ends_at > now))  # noqa: E712
    ).scalars().all()
    return [
        {"id": e.id, "type": e.event_type, "x": e.x, "y": e.y,
         "multiplier": e.reward_multiplier,
         "ends_at": e.ends_at.isoformat()}
        for e in events
    ]


def _expire_old_events(db: Session, now: datetime) -> None:
    db.execute(
        MiniEvent.__table__.update()
        .where(and_(MiniEvent.active == True, MiniEvent.ends_at <= now))  # noqa: E712
        .values(active=False)
    )


def _maybe_spawn_event(db: Session, now: datetime) -> None:
    """Spawn a new event if none active or last one started > 1 hour ago."""
    last = db.execute(
        select(MiniEvent).order_by(MiniEvent.id.desc()).limit(1)
    ).scalar_one_or_none()
    if last and (now - last.started_at).total_seconds() < 3600:
        return
    cx, cy = map_center()
    r = settings.arena_radius_tiles
    for _ in range(20):
        ang = random.random() * math.tau
        d = random.randint(0, r // 3)
        x = clamp(int(round(cx + d * math.cos(ang))), 0, settings.map_width - 1)
        y = clamp(int(round(cy + d * math.sin(ang))), 0, settings.map_height - 1)
        if in_arena(x, y):
            db.add(MiniEvent(
                event_type="rare_loot",
                x=x, y=y,
                reward_multiplier=random.choice([5, 8, 10]),
                started_at=now,
                ends_at=now + timedelta(minutes=30),
                active=True,
            ))
            db.flush()
            return


def _check_event_tile(db: Session, user: User, x: int, y: int) -> int:
    """Returns event reward multiplier if tile is an active event tile, else 1."""
    now = now_utc()
    event = db.execute(
        select(MiniEvent).where(
            and_(MiniEvent.x == x, MiniEvent.y == y,
                 MiniEvent.active == True, MiniEvent.ends_at > now)  # noqa: E712
        )
    ).scalar_one_or_none()
    if event:
        event.active = False
        event.triggered_by_user_id = user.id
        db.flush()
        return event.reward_multiplier
    return 1


# ── Movement & painting ───────────────────────────────────────────────────────

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


def _streak_coin_bonus(user: User) -> float:
    """Returns extra coin multiplier from active capture streak."""
    if not user.streak_bonus_until:
        return 1.0
    if now_utc() > user.streak_bonus_until:
        return 1.0
    if user.capture_streak >= 5:
        return 2.0
    if user.capture_streak >= 3:
        return 1.5
    return 1.0


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
    user.pos_x = x
    user.pos_y = y
    user.last_paint_at = now_utc()

    # ── Capture war mechanic ──────────────────────────────────────────────────
    if existing is not None and existing.owner_user_id != user.id:
        old_owner_id = existing.owner_user_id
        defender = db.execute(select(User).where(User.id == old_owner_id)).scalar_one_or_none()

        if existing.defense > 0:
            existing.defense -= 1
            existing.attack_hits = (existing.attack_hits or 0) + 1
            db.add(TileAttackEvent(
                attacker_id=user.id, defender_id=old_owner_id,
                x=x, y=y, result="hit",
                attacker_name=user.display_name,
                defender_name=defender.display_name if defender else "",
            ))
            db.flush()
            return {
                "new": False, "defended": True,
                "defense_left": existing.defense,
                "attack_hits": existing.attack_hits,
                "max_defense": existing.defense + 1 + existing.attack_hits,
                "coins": 0, "score": 0, "loot": False,
                "level": user.level,
                "new_achievements": [], "completed_quests": [],
                "streak": user.capture_streak,
            }

        # defense == 0 → tile is captured
        existing.owner_user_id = user.id
        existing.color = style
        existing.defense = 0
        existing.attack_hits = 0
        existing.painted_at = now_utc()

        # Update owned_tiles counters
        user.owned_tiles = (user.owned_tiles or 0) + 1
        if defender:
            defender.owned_tiles = max(0, (defender.owned_tiles or 0) - 1)

        # Capture streak
        user.capture_streak = (user.capture_streak or 0) + 1
        streak = user.capture_streak
        streak_popup = None
        if streak == 5:
            user.streak_bonus_until = now_utc() + timedelta(minutes=5)
            streak_popup = f"⚔️ СЕРИЯ x{streak}! Бонус +100% монет!"
        elif streak == 3:
            user.streak_bonus_until = now_utc() + timedelta(minutes=3)
            streak_popup = f"⚔️ Серия x{streak}! Бонус +50% монет!"
        elif streak > 5 and streak % 5 == 0:
            user.streak_bonus_until = now_utc() + timedelta(minutes=5)
            streak_popup = f"⚔️ СЕРИЯ x{streak}! Продолжаешь громить!"

        db.add(TileAttackEvent(
            attacker_id=user.id, defender_id=old_owner_id,
            x=x, y=y, result="captured",
            attacker_name=user.display_name,
            defender_name=defender.display_name if defender else "",
        ))
        newly_claimed = True
        captured_from = defender.display_name if defender else None
    elif existing is None:
        db.add(Tile(x=x, y=y, owner_user_id=user.id, color=style, defense=0, attack_hits=0))
        user.owned_tiles = (user.owned_tiles or 0) + 1
        user.capture_streak = 0
        newly_claimed = True
        captured_from = None
        streak_popup = None
        streak = 0
    else:
        # own tile: reinforce (max 3)
        existing.color = style
        existing.attack_hits = 0
        existing.painted_at = now_utc()
        if existing.defense < 3:
            existing.defense += 1
        user.capture_streak = 0
        newly_claimed = False
        captured_from = None
        streak_popup = None
        streak = 0

    db.flush()

    if not newly_claimed:
        return {
            "new": False, "defended": False,
            "defense": existing.defense if existing else 0,
            "coins": 0, "score": 0, "loot": False,
            "level": user.level,
            "new_achievements": [], "completed_quests": [],
            "streak": 0,
        }

    # ── Event bonus ───────────────────────────────────────────────────────────
    event_mult = _check_event_tile(db, user, x, y)
    streak_mult = _streak_coin_bonus(user)

    reward_coins = max(1, int(settings.base_tile_reward_coins * stats.coin_multiplier * event_mult * streak_mult))
    reward_score = settings.base_tile_reward_score * event_mult
    user.coins += reward_coins
    user.score += reward_score
    user.tiles_painted += 1
    user.xp += 1
    new_level = 1 + (user.xp // 25)
    leveled = new_level != user.level
    user.level = new_level

    if leveled:
        new_style = current_tile_style(user)
        db.query(Tile).filter(Tile.owner_user_id == user.id).update({Tile.color: new_style})

    got_loot = random.random() < loot_chance_for_position(x, y)
    if got_loot:
        db.add(LootCrate(user_id=user.id))

    # ── Achievements & daily quests ───────────────────────────────────────────
    new_achievements = check_achievements(db, user)
    completed_quests = _update_daily_quest(db, user, "paint", 1)
    completed_quests += _update_daily_quest(db, user, "score", reward_score)
    if got_loot:
        completed_quests += _update_daily_quest(db, user, "loot", 1)

    db.flush()
    return {
        "new": True, "defended": False,
        "defense": 0,
        "coins": reward_coins,
        "score": reward_score,
        "loot": got_loot,
        "level": user.level,
        "leveled": leveled,
        "event_mult": event_mult,
        "streak_mult": round(streak_mult, 1),
        "streak": streak,
        "streak_popup": streak_popup,
        "captured_from": captured_from,
        "new_achievements": new_achievements,
        "completed_quests": completed_quests,
    }


# ── Loot ──────────────────────────────────────────────────────────────────────

def open_loot(db: Session, user: User, crate_id: int) -> dict:
    crate = db.execute(
        select(LootCrate).where(and_(LootCrate.id == crate_id, LootCrate.user_id == user.id))
    ).scalar_one_or_none()
    if crate is None:
        raise ValueError("not_found")
    if crate.opened:
        return {"already_opened": True, "reward_type": crate.reward_type, "reward_amount": crate.reward_amount}

    roll = random.random()
    if roll < 0.50:
        amt = random.randint(15, 80)
        crate.reward_type = "coins"
        crate.reward_amount = amt
        user.coins += amt
    elif roll < 0.72:
        crate.reward_type = "boost_coin_x2_10m"
        crate.reward_amount = 2
        db.add(Boost(user_id=user.id, boost_type=BoostType.coin_multiplier,
                     value_float=2000, value_int=0, expires_at=now_utc() + timedelta(minutes=10)))
    elif roll < 0.88:
        crate.reward_type = "boost_range_2_8m"
        crate.reward_amount = 2
        db.add(Boost(user_id=user.id, boost_type=BoostType.paint_range,
                     value_int=2, value_float=0, expires_at=now_utc() + timedelta(minutes=8)))
    elif roll < 0.97:
        crate.reward_type = "boost_speed_1_5x_6m"
        crate.reward_amount = 1500
        db.add(Boost(user_id=user.id, boost_type=BoostType.speed,
                     value_float=1500, value_int=0, expires_at=now_utc() + timedelta(minutes=6)))
    else:
        # rare: large coin bag
        amt = random.randint(200, 500)
        crate.reward_type = "coins_rare"
        crate.reward_amount = amt
        user.coins += amt

    crate.opened = True
    crate.opened_at = now_utc()
    db.flush()
    completed_quests = _update_daily_quest(db, user, "loot", 1)
    db.flush()
    return {"already_opened": False, "reward_type": crate.reward_type,
            "reward_amount": crate.reward_amount, "completed_quests": completed_quests}


# ── Shop ──────────────────────────────────────────────────────────────────────

def buy_shop_item(db: Session, user: User, item_id: str) -> dict:
    catalog = get_shop_catalog()
    if item_id not in catalog:
        raise ValueError("bad_item")
    it = catalog[item_id]

    # VIP-exclusive items check
    if it.get("vip_required", 0) > user.vip_level:
        raise ValueError("vip_required")

    if user.coins < it["price"]:
        raise ValueError("no_money")
    user.coins -= it["price"]

    if it["kind"] in ("style", "color", "border"):
        kind_map = {"style": CosmeticKind.style, "color": CosmeticKind.color, "border": CosmeticKind.border}
        kind = kind_map[it["kind"]]
        existing = db.execute(
            select(UserCosmetic).where(and_(UserCosmetic.user_id == user.id, UserCosmetic.cosmetic_id == item_id))
        ).scalar_one_or_none()
        if existing is None:
            db.add(UserCosmetic(user_id=user.id, cosmetic_id=item_id, kind=kind,
                                title=it["title"], payload=it["payload"]))
        db.flush()
        return {"ok": True, "item": item_id, "spent": it["price"], "kind": it["kind"]}

    db.add(Boost(user_id=user.id, boost_type=it["type"],
                 value_int=it["value_int"], value_float=it["value_float"],
                 expires_at=now_utc() + timedelta(minutes=it["min"])))
    db.flush()
    return {"ok": True, "item": item_id, "spent": it["price"]}


def get_shop_catalog() -> dict[str, dict]:
    catalog: dict[str, dict] = {
        "coin_x2_30m": {
            "kind": "boost", "title": "x2 монеты (30 мин)",
            "price": 50, "type": BoostType.coin_multiplier,
            "value_float": 2000, "value_int": 0, "min": 30,
        },
        "coin_x3_15m": {
            "kind": "boost", "title": "x3 монеты (15 мин)",
            "price": 100, "type": BoostType.coin_multiplier,
            "value_float": 3000, "value_int": 0, "min": 15,
        },
        "range_2_20m": {
            "kind": "boost", "title": "Дальность 2 (20 мин)",
            "price": 60, "type": BoostType.paint_range,
            "value_float": 0, "value_int": 2, "min": 20,
        },
        "range_3_10m": {
            "kind": "boost", "title": "Дальность 3 (10 мин)",
            "price": 150, "type": BoostType.paint_range,
            "value_float": 0, "value_int": 3, "min": 10,
        },
        "speed_1_5x_20m": {
            "kind": "boost", "title": "Скорость 1.5x (20 мин)",
            "price": 60, "type": BoostType.speed,
            "value_float": 1500, "value_int": 0, "min": 20,
        },
    }

    styles = [
        ("solid",         "Сплошной",         0,   0),
        ("gradient",      "Градиент",          80,  0),
        ("marble",        "Мрамор",            120, 0),
        ("ice",           "Лёд",               120, 0),
        ("carbon",        "Карбон",            150, 0),
        ("magma",         "Магма",             200, 0),
        ("magma_sparks",  "Магма (искры)",     250, 0),
        ("neon_pulse",    "Неон (пульс)",      300, 0),
        ("crystal",       "Кристалл",          300, 0),
        ("aurora",        "Аврора",            400, 0),
        ("rainbow_shift", "Радуга (перелив)",  500, 0),
        ("galaxy",        "Галактика",         600, 0),
        ("glitch",        "Глитч",             700, 0),
        # VIP-exclusive styles
        ("neon_pulse",    "Неон VIP (Bronze)", 0,   1),
        ("rainbow_shift", "Радуга VIP (Silver)", 0, 2),
        ("galaxy",        "Галактика VIP (Gold)", 0, 3),
    ]
    seen_style = set()
    for name, title, price, vip_req in styles:
        cid = f"style_{name}" if vip_req == 0 else f"style_{name}_vip{vip_req}"
        if cid in seen_style:
            continue
        seen_style.add(cid)
        item = {"kind": "style", "title": f"Стиль: {title}", "price": price, "payload": name}
        if vip_req:
            item["vip_required"] = vip_req
        catalog[cid] = item

    colors = [
        ("#ff3b30", "Красный",       80),
        ("#ff9500", "Янтарь",       80),
        ("#ffd60a", "Жёлтый",       80),
        ("#34c759", "Зелёный",      80),
        ("#00c7be", "Тиффани",      100),
        ("#0a84ff", "Синий",        80),
        ("#5e5ce6", "Индиго",       100),
        ("#bf5af2", "Фиолетовый",   100),
        ("#ff2d55", "Розовый неон", 120),
        ("#64d2ff", "Лёд-голубой",  120),
        ("#30d158", "Неон-лайм",    120),
        ("#ff9f0a", "Лава-оранжевый", 120),
        ("#f2f2f7", "Белый",        150),
        ("#1c1c1e", "Графит",       150),
    ]
    for i, (hx, title, price) in enumerate(colors, start=1):
        cid = f"color_{i:02d}"
        catalog[cid] = {"kind": "color", "title": f"Цвет: {title}", "price": price, "payload": hx}

    borders = [
        ("border_glow",     "✨ Свечение",        200,  0),
        ("border_fire",     "🔥 Огонь",           300,  0),
        ("border_ice",      "❄️ Лёд",             300,  0),
        ("border_neon",     "💡 Неон RGB",         400,  0),
        ("border_gold",     "🥇 Золото",           350,  0),
        ("border_plasma",   "⚡ Плазма",           450,  0),
        ("border_void",     "🌑 Пустота",          500,  0),
        ("border_rainbow",  "🌈 Радуга",           600,  0),
        ("border_circuit",  "🔌 Схема",            550,  0),
        ("border_diamond",  "💎 Бриллиант",        700,  0),
        ("border_glitch",   "📡 Глитч",            800,  0),
        ("border_aurora",   "🌌 Аврора VIP",       0,    1),
        ("border_cosmic",   "🚀 Космос VIP",       0,    2),
        ("border_inferno",  "👑 Инферно Gold",     0,    3),
    ]
    for name, title, price, vip_req in borders:
        item: dict = {"kind": "border", "title": f"Рамка: {title}", "price": price, "payload": name}
        if vip_req:
            item["vip_required"] = vip_req
        catalog[f"brd_{name}"] = item

    return catalog


def list_inventory(db: Session, user: User) -> list[dict]:
    items = (
        db.execute(select(UserCosmetic).where(UserCosmetic.user_id == user.id).order_by(UserCosmetic.id.desc()))
        .scalars().all()
    )
    return [{"id": it.cosmetic_id, "kind": it.kind.value, "title": it.title, "payload": it.payload}
            for it in items]


def equip_cosmetic(db: Session, user: User, cosmetic_id: str) -> dict:
    it = db.execute(
        select(UserCosmetic).where(and_(UserCosmetic.user_id == user.id, UserCosmetic.cosmetic_id == cosmetic_id))
    ).scalar_one_or_none()
    if it is None:
        return {"ok": False, "equipped": None, "reason": "not_owned"}
    if it.kind == CosmeticKind.style:
        user.paint_style = it.payload
    elif it.kind == CosmeticKind.color:
        user.base_color = it.payload
    elif it.kind == CosmeticKind.border:
        user.border_style = it.payload
        db.flush()
        return {"ok": True, "equipped": cosmetic_id, "border": user.border_style}
    new_style = current_tile_style(user)
    db.query(Tile).filter(Tile.owner_user_id == user.id).update({Tile.color: new_style})
    db.flush()
    return {"ok": True, "equipped": cosmetic_id, "style": user.paint_style, "color": user.base_color}


# ── Alerts & War Feed ─────────────────────────────────────────────────────────

def get_my_alerts(db: Session, user: User) -> list[dict]:
    events = db.execute(
        select(TileAttackEvent)
        .where(TileAttackEvent.defender_id == user.id)
        .order_by(TileAttackEvent.at.desc())
        .limit(5)
    ).scalars().all()
    now = now_utc()
    result = []
    for e in events:
        secs = max(0, (now - e.at).total_seconds())
        if secs < 60:
            ago = "только что"
        elif secs < 3600:
            ago = f"{int(secs // 60)} мин назад"
        else:
            ago = f"{int(secs // 3600)} ч назад"
        result.append({
            "id": e.id,
            "attacker": e.attacker_name,
            "x": e.x, "y": e.y,
            "result": e.result,
            "ago": ago,
        })
    return result


def get_war_feed(db: Session) -> list[dict]:
    events = db.execute(
        select(TileAttackEvent)
        .order_by(TileAttackEvent.at.desc())
        .limit(20)
    ).scalars().all()
    now = now_utc()
    result = []
    for e in events:
        secs = max(0, (now - e.at).total_seconds())
        if secs < 60:
            ago = "только что"
        elif secs < 3600:
            ago = f"{int(secs // 60)} мин назад"
        else:
            ago = f"{int(secs // 3600)} ч назад"
        if e.result == "captured":
            text = f"⚔️ {e.attacker_name} захватил клетку у {e.defender_name} ({e.x},{e.y})"
        else:
            text = f"🛡 {e.defender_name} отбил атаку от {e.attacker_name} ({e.x},{e.y})"
        result.append({"text": text, "ago": ago, "result": e.result, "x": e.x, "y": e.y})
    return result


def get_round_history(db: Session) -> list[dict]:
    rounds = db.execute(
        select(DonationRound)
        .where(DonationRound.status == DonationRoundStatus.finished)
        .order_by(DonationRound.id.desc())
        .limit(10)
    ).scalars().all()
    result = []
    for r in rounds:
        wr = r.withdrawal
        payout = wr.status if wr else "none"
        result.append({
            "round_id": r.id,
            "total_stars": r.total_stars,
            "winner_name": r.winner_name,
            "winner_tg_id": r.winner_tg_id,
            "ended_at": r.finished_at.isoformat() if r.finished_at else None,
            "payout_status": payout,
        })
    return result


# ── Donation Pool ─────────────────────────────────────────────────────────────

def _auto_finish_round(db: Session, round_: DonationRound) -> None:
    winner = db.execute(select(User).order_by(User.score.desc())).scalar_one_or_none()
    round_.status = DonationRoundStatus.finished
    round_.finished_at = now_utc()
    if winner and round_.total_stars > 0:
        round_.winner_user_id = winner.id
        round_.winner_tg_id = winner.tg_user_id
        round_.winner_name = winner.display_name
        winner.coins += round_.total_stars * 10
    # Season reset: wipe scores for new round
    db.execute(User.__table__.update().values(score=0))
    db.flush()


def get_or_create_active_round(db: Session) -> DonationRound:
    round_ = db.execute(
        select(DonationRound).where(DonationRound.status == DonationRoundStatus.active)
        .order_by(DonationRound.id.desc())
    ).scalar_one_or_none()
    if round_ is not None and round_.ends_at <= now_utc():
        _auto_finish_round(db, round_)
        round_ = None
    if round_ is None:
        round_ = DonationRound(ends_at=now_utc() + timedelta(days=7))
        db.add(round_)
        db.flush()
    return round_


def add_donation(db: Session, user: User, stars: int, tg_payment_charge_id: str | None = None) -> dict:
    if stars < 1:
        raise ValueError("min_1_star")
    round_ = get_or_create_active_round(db)
    if round_.status != DonationRoundStatus.active:
        raise ValueError("round_finished")

    db.add(Donation(round_id=round_.id, user_id=user.id, stars=stars,
                    tg_payment_charge_id=tg_payment_charge_id))
    round_.total_stars += stars

    # Track total donations for VIP level
    user.total_donated_stars += stars
    user.vip_level = compute_vip_level(user.total_donated_stars)

    # VIP bonus coins per star
    bonus_mult = {0: 5, 1: 8, 2: 12, 3: 20}
    bonus_coins = stars * bonus_mult.get(user.vip_level, 5)
    user.coins += bonus_coins
    db.flush()
    return {"ok": True, "stars": stars, "pool_total": round_.total_stars,
            "bonus_coins": bonus_coins, "vip_level": user.vip_level}


def get_pool_info(db: Session) -> dict:
    round_ = get_or_create_active_round(db)
    rows = db.execute(
        select(User.id, User.display_name, User.tg_user_id, func.sum(Donation.stars).label("total"))
        .join(Donation, Donation.user_id == User.id)
        .where(Donation.round_id == round_.id)
        .group_by(User.id)
        .order_by(func.sum(Donation.stars).desc())
        .limit(10)
    ).all()
    top_players = db.execute(
        select(User).order_by(User.score.desc()).limit(10)
    ).scalars().all()
    total_pool = round_.total_stars or 1
    return {
        "round_id": round_.id,
        "status": round_.status.value,
        "total_stars": round_.total_stars,
        "ends_at": round_.ends_at.isoformat(),
        "contributors": [
            {
                "user_id": r.id, "display_name": r.display_name,
                "stars": r.total,
                "pct": round(r.total / total_pool * 100, 1),
            }
            for r in rows
        ],
        "top_players": [
            {"user_id": p.id, "display_name": p.display_name, "score": p.score,
             "tiles_painted": p.tiles_painted, "level": p.level, "vip_level": p.vip_level}
            for p in top_players
        ],
    }


def finish_pool(db: Session) -> dict:
    round_ = db.execute(
        select(DonationRound).where(DonationRound.status == DonationRoundStatus.active)
        .order_by(DonationRound.id.desc())
    ).scalar_one_or_none()
    if round_ is None:
        raise ValueError("no_active_round")
    _auto_finish_round(db, round_)
    db.flush()
    return {
        "round_id": round_.id,
        "total_stars": round_.total_stars,
        "winner_user_id": round_.winner_user_id,
        "winner_tg_id": round_.winner_tg_id,
        "winner_name": round_.winner_name,
    }


# ── Leaderboard ───────────────────────────────────────────────────────────────

def get_leaderboard(db: Session) -> list[dict]:
    top = db.execute(select(User).order_by(User.score.desc()).limit(50)).scalars().all()
    return [
        {"rank": i + 1, "user_id": u.id, "display_name": u.display_name,
         "score": u.score, "tiles_painted": u.tiles_painted, "owned_tiles": u.owned_tiles or 0,
         "level": u.level, "base_color": u.base_color, "vip_level": u.vip_level}
        for i, u in enumerate(top)
    ]


# ── Telegram WebApp auth ──────────────────────────────────────────────────────

def _telegram_webapp_secret(bot_token: str) -> bytes:
    return hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()


def verify_telegram_init_data(init_data: str, bot_token: str) -> dict:
    parsed = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = parsed.pop("hash", None)
    if not received_hash:
        raise ValueError("no_hash")
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
    secrets = [
        _telegram_webapp_secret(bot_token),
        hashlib.sha256(bot_token.encode("utf-8")).digest(),
        hmac.new(bot_token.encode("utf-8"), b"WebAppData", hashlib.sha256).digest(),
    ]
    ok = any(
        hmac.compare_digest(
            hmac.new(sec, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest(),
            received_hash,
        )
        for sec in secrets
    )
    if not ok:
        raise ValueError("bad_hash")
    auth_date = parsed.get("auth_date")
    if auth_date and auth_date.isdigit():
        if time.time() - int(auth_date) > 24 * 3600:
            raise ValueError("too_old")
    return parsed
