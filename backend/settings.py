from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    bot_token: str = "CHANGE_ME"
    webapp_url: str = "http://localhost:8000/webapp/"
    database_url: str = "sqlite:///./data.db"
    telegram_bot_token_for_webapp_hash: str | None = None
    admin_secret: str = "change_me"

    # Game config
    map_width: int = 150
    map_height: int = 150
    center_loot_radius: int = 27
    # Playable world is a circle inscribed into the square map.
    arena_radius_tiles: int = 74

    base_tile_reward_coins: int = 1
    base_tile_reward_score: int = 1
    move_cooldown_ms: int = 250
    paint_cooldown_ms: int = 350


settings = Settings()

