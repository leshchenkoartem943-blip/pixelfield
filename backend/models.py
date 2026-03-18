from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.db import Base


class BoostType(str, enum.Enum):
    coin_multiplier = "coin_multiplier"
    paint_range = "paint_range"
    speed = "speed"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tg_user_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    display_name: Mapped[str] = mapped_column(String(64), default="Player")

    coins: Mapped[int] = mapped_column(Integer, default=0)
    score: Mapped[int] = mapped_column(Integer, default=0)
    tiles_painted: Mapped[int] = mapped_column(Integer, default=0)
    xp: Mapped[int] = mapped_column(Integer, default=0)
    level: Mapped[int] = mapped_column(Integer, default=1)

    # Visual identity
    base_color: Mapped[str] = mapped_column(String(16), default="#44ccff")  # hex
    paint_style: Mapped[str] = mapped_column(String(32), default="solid")  # solid|magma|marble|gradient

    pos_x: Mapped[int] = mapped_column(Integer, default=0)
    pos_y: Mapped[int] = mapped_column(Integer, default=0)

    last_move_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_paint_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    boosts: Mapped[list["Boost"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    loot: Mapped[list["LootCrate"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    cosmetics: Mapped[list["UserCosmetic"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Tile(Base):
    __tablename__ = "tiles"
    __table_args__ = (UniqueConstraint("x", "y", name="uq_tile_xy"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    x: Mapped[int] = mapped_column(Integer, index=True)
    y: Mapped[int] = mapped_column(Integer, index=True)

    owner_user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    color: Mapped[str] = mapped_column(String(16), default="#44ccff")
    painted_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Boost(Base):
    __tablename__ = "boosts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    boost_type: Mapped[BoostType] = mapped_column(Enum(BoostType))
    value_int: Mapped[int] = mapped_column(Integer, default=0)
    value_float: Mapped[int] = mapped_column(Integer, default=0)  # store *1000 to avoid float issues
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

    # determined on open (so we can tweak balance without migrating existing crates)
    reward_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    reward_amount: Mapped[int | None] = mapped_column(Integer, nullable=True)

    user: Mapped["User"] = relationship(back_populates="loot")


class CosmeticKind(str, enum.Enum):
    style = "style"
    color = "color"


class UserCosmetic(Base):
    __tablename__ = "user_cosmetics"
    __table_args__ = (UniqueConstraint("user_id", "cosmetic_id", name="uq_user_cosmetic"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    cosmetic_id: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[CosmeticKind] = mapped_column(Enum(CosmeticKind))
    title: Mapped[str] = mapped_column(String(64))
    payload: Mapped[str] = mapped_column(String(128), default="")  # e.g. style name or hex color
    acquired_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped["User"] = relationship(back_populates="cosmetics")

