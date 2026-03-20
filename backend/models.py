from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint, Date
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.db import Base


class BoostType(str, enum.Enum):
    coin_multiplier = "coin_multiplier"
    paint_range = "paint_range"
    speed = "speed"


class CosmeticKind(str, enum.Enum):
    style = "style"
    color = "color"
    border = "border"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tg_user_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    display_name: Mapped[str] = mapped_column(String(64), default="Player")

    coins: Mapped[int] = mapped_column(Integer, default=0)
    score: Mapped[int] = mapped_column(Integer, default=0)
    tiles_painted: Mapped[int] = mapped_column(Integer, default=0)
    owned_tiles: Mapped[int] = mapped_column(Integer, default=0)
    xp: Mapped[int] = mapped_column(Integer, default=0)
    level: Mapped[int] = mapped_column(Integer, default=1)

    base_color: Mapped[str] = mapped_column(String(16), default="#44ccff")
    paint_style: Mapped[str] = mapped_column(String(32), default="solid")
    border_style: Mapped[str] = mapped_column(String(32), default="none")

    # VIP / donation status
    total_donated_stars: Mapped[int] = mapped_column(Integer, default=0)
    vip_level: Mapped[int] = mapped_column(Integer, default=0)  # 0=none 1=bronze 2=silver 3=gold

    # Capture streak
    capture_streak: Mapped[int] = mapped_column(Integer, default=0)
    streak_bonus_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    pos_x: Mapped[int] = mapped_column(Integer, default=0)
    pos_y: Mapped[int] = mapped_column(Integer, default=0)

    last_move_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_paint_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    boosts: Mapped[list["Boost"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    loot: Mapped[list["LootCrate"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    cosmetics: Mapped[list["UserCosmetic"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    donations: Mapped[list["Donation"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    achievements: Mapped[list["UserAchievement"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    daily_quests: Mapped[list["DailyQuestProgress"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Tile(Base):
    __tablename__ = "tiles"
    __table_args__ = (UniqueConstraint("x", "y", name="uq_tile_xy"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    x: Mapped[int] = mapped_column(Integer, index=True)
    y: Mapped[int] = mapped_column(Integer, index=True)

    owner_user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    color: Mapped[str] = mapped_column(String(16), default="#44ccff")
    defense: Mapped[int] = mapped_column(Integer, default=0)  # 0-3
    attack_hits: Mapped[int] = mapped_column(Integer, default=0)  # hits taken since last reinforce
    painted_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class TileAttackEvent(Base):
    __tablename__ = "tile_attack_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    attacker_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    defender_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    x: Mapped[int] = mapped_column(Integer)
    y: Mapped[int] = mapped_column(Integer)
    result: Mapped[str] = mapped_column(String(16))  # "hit" | "captured"
    attacker_name: Mapped[str] = mapped_column(String(64), default="")
    defender_name: Mapped[str] = mapped_column(String(64), default="")
    at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class Boost(Base):
    __tablename__ = "boosts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    boost_type: Mapped[BoostType] = mapped_column(Enum(BoostType))
    value_int: Mapped[int] = mapped_column(Integer, default=0)
    value_float: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped["User"] = relationship(back_populates="boosts")


class LootCrate(Base):
    __tablename__ = "loot_crates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    opened: Mapped[bool] = mapped_column(Boolean, default=False)

    reward_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    reward_amount: Mapped[int | None] = mapped_column(Integer, nullable=True)

    user: Mapped["User"] = relationship(back_populates="loot")


class UserCosmetic(Base):
    __tablename__ = "user_cosmetics"
    __table_args__ = (UniqueConstraint("user_id", "cosmetic_id", name="uq_user_cosmetic"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    cosmetic_id: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[CosmeticKind] = mapped_column(Enum(CosmeticKind))
    title: Mapped[str] = mapped_column(String(64))
    payload: Mapped[str] = mapped_column(String(128), default="")
    acquired_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped["User"] = relationship(back_populates="cosmetics")


# ── Achievements ────────────────────────────────────────────────────────────────

class UserAchievement(Base):
    __tablename__ = "user_achievements"
    __table_args__ = (UniqueConstraint("user_id", "achievement_id", name="uq_user_ach"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    achievement_id: Mapped[str] = mapped_column(String(64))
    unlocked_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped["User"] = relationship(back_populates="achievements")


# ── Daily quests ─────────────────────────────────────────────────────────────

class DailyQuestProgress(Base):
    __tablename__ = "daily_quest_progress"
    __table_args__ = (UniqueConstraint("user_id", "quest_id", "date", name="uq_daily_quest"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    quest_id: Mapped[str] = mapped_column(String(64))
    date: Mapped[datetime] = mapped_column(Date, index=True)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    completed: Mapped[bool] = mapped_column(Boolean, default=False)
    reward_claimed: Mapped[bool] = mapped_column(Boolean, default=False)

    user: Mapped["User"] = relationship(back_populates="daily_quests")


# ── Mini-events ──────────────────────────────────────────────────────────────

class MiniEvent(Base):
    __tablename__ = "mini_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_type: Mapped[str] = mapped_column(String(32), default="rare_loot")
    x: Mapped[int] = mapped_column(Integer, default=0)
    y: Mapped[int] = mapped_column(Integer, default=0)
    reward_multiplier: Mapped[int] = mapped_column(Integer, default=5)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    ends_at: Mapped[datetime] = mapped_column(DateTime)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    triggered_by_user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


# ── Donation Pool ────────────────────────────────────────────────────────────

class DonationRoundStatus(str, enum.Enum):
    active = "active"
    finished = "finished"


class DonationRound(Base):
    __tablename__ = "donation_rounds"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    status: Mapped[DonationRoundStatus] = mapped_column(
        Enum(DonationRoundStatus), default=DonationRoundStatus.active
    )
    total_stars: Mapped[int] = mapped_column(Integer, default=0)
    winner_user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.id"), nullable=True)
    winner_tg_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    winner_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    ends_at: Mapped[datetime] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    donations: Mapped[list["Donation"]] = relationship(back_populates="round", cascade="all, delete-orphan")
    withdrawal: Mapped["WithdrawalRequest | None"] = relationship(back_populates="round", uselist=False)


class Donation(Base):
    __tablename__ = "donations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    round_id: Mapped[int] = mapped_column(Integer, ForeignKey("donation_rounds.id"), index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    stars: Mapped[int] = mapped_column(Integer, default=1)
    tg_payment_charge_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    round: Mapped["DonationRound"] = relationship(back_populates="donations")
    user: Mapped["User"] = relationship(back_populates="donations")


class WithdrawalRequest(Base):
    __tablename__ = "withdrawal_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    round_id: Mapped[int] = mapped_column(Integer, ForeignKey("donation_rounds.id"), unique=True, index=True)
    winner_user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    winner_tg_id: Mapped[int] = mapped_column(Integer)
    total_stars: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | paid
    requested_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    round: Mapped["DonationRound"] = relationship(back_populates="withdrawal")
