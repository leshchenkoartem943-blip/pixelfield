from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy import text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from backend.settings import settings


def _connect_args(url: str) -> dict:
    if url.startswith("sqlite"):
        return {"check_same_thread": False}
    return {}


engine = create_engine(settings.database_url, connect_args=_connect_args(settings.database_url))
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def init_db() -> None:
    from backend import models  # noqa: F401

    Base.metadata.create_all(bind=engine)

    is_pg = not settings.database_url.startswith("sqlite")

    # PostgreSQL migrations: fix column types and add missing columns
    if is_pg:
        with engine.begin() as conn:
            # Fix tg_user_id: INTEGER → BIGINT (Telegram IDs can exceed 2^31)
            conn.execute(text(
                "ALTER TABLE users ALTER COLUMN tg_user_id TYPE BIGINT"
            ))
    # SQLite migrations for local dev
    elif settings.database_url.startswith("sqlite"):
        with engine.begin() as conn:
            cols = conn.execute(text("PRAGMA table_info(users)")).fetchall()
            existing = {c[1] for c in cols}
            if "xp" not in existing:
                conn.execute(text("ALTER TABLE users ADD COLUMN xp INTEGER DEFAULT 0"))
            if "level" not in existing:
                conn.execute(text("ALTER TABLE users ADD COLUMN level INTEGER DEFAULT 1"))
            if "base_color" not in existing:
                conn.execute(text("ALTER TABLE users ADD COLUMN base_color VARCHAR(16) DEFAULT '#44ccff'"))
            if "paint_style" not in existing:
                conn.execute(text("ALTER TABLE users ADD COLUMN paint_style VARCHAR(32) DEFAULT 'solid'"))

