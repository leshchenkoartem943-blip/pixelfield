from __future__ import annotations

import os

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    bot_token: str = "CHANGE_ME"
    # Default points to the Render deployment; override via WEBAPP_URL env var for local dev.
    webapp_url: str = "https://pixel-field-backend.onrender.com/webapp/"

    @model_validator(mode="after")
    def _auto_webapp_url(self) -> "Settings":
        """If WEBAPP_URL is the generic default, prefer RENDER_EXTERNAL_URL if available."""
        default = "https://pixel-field-backend.onrender.com/webapp/"
        if self.webapp_url == default:
            render_host = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
            if render_host:
                self.webapp_url = render_host + "/webapp/"
        return self
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

    # Arena shape: circle | square | star
    arena_shape: str = "circle"

    # Admin Telegram user ID for /admin_finish bot command
    admin_tg_id: int = 0


settings = Settings()

