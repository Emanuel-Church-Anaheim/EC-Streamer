from sqlalchemy import create_engine, Column, Integer, String, Float, Boolean, DateTime, Text
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from datetime import datetime, timezone
from typing import Optional

DATABASE_URL = "sqlite:///./ec_streamer.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


class Setting(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True, index=True)
    value = Column(Text, default="")


class VideoFile(Base):
    __tablename__ = "videos"
    id = Column(Integer, primary_key=True, autoincrement=True)
    filename = Column(String, nullable=False)
    filepath = Column(String, nullable=False, unique=True)
    title = Column(String)
    duration = Column(Float)          # seconds
    size = Column(Integer)            # bytes
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class ScheduledItem(Base):
    __tablename__ = "schedule"
    id = Column(Integer, primary_key=True, autoincrement=True)
    video_id = Column(Integer, nullable=False)
    title = Column(String)
    start_time = Column(String, nullable=False)   # HH:MM  24-hour
    recurrence = Column(String, default="once")   # once | daily | weekly
    date = Column(String)                          # YYYY-MM-DD  (for 'once')
    days_of_week = Column(String)                  # comma-sep 0-6  (for 'weekly')
    enabled = Column(Boolean, default=True)
    priority = Column(Integer, default=0)
    bumper_pre_id = Column(Integer, nullable=True)    # BumperFile.id or None
    bumper_post_id = Column(Integer, nullable=True)   # BumperFile.id or None
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class BumperFile(Base):
    __tablename__ = "bumpers"
    id = Column(Integer, primary_key=True, autoincrement=True)
    filename = Column(String, nullable=False)
    filepath = Column(String, nullable=False, unique=True)
    title = Column(String)
    duration = Column(Float)
    size = Column(Integer)
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class LowerThird(Base):
    __tablename__ = "lower_thirds"
    id = Column(Integer, primary_key=True, autoincrement=True)
    label = Column(String)                         # internal name
    line1 = Column(String, default="")             # main text
    line2 = Column(String, default="")             # subtitle (optional)
    position = Column(String, default="bottom-left")
    font_size = Column(Integer, default=32)
    text_color = Column(String, default="ffffff")
    bg_color = Column(String, default="000000")
    bg_opacity = Column(Float, default=0.6)
    trigger_offset = Column(Integer, default=5)    # seconds from video start
    duration = Column(Integer, default=10)         # seconds to display
    schedule_item_id = Column(Integer, nullable=True)  # None = global (all videos)
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


DEFAULT_SETTINGS: dict = {
    "rtmp_url": "rtmp://live.twitch.tv/live",
    "stream_key": "",
    "resolution": "1280x720",
    "fps": "30",
    "video_bitrate": "4500k",
    "audio_bitrate": "160k",
    "encoder": "libx264",
    "preset": "veryfast",
    "ffmpeg_path": "ffmpeg",
    "ffprobe_path": "ffprobe",
    "filler_type": "black",
    "filler_color": "000000",
    "bumper_enabled": "false",
    "bumper_between_items": "true",   # play bumper between scheduled videos
    "font_path": "",                   # path to .ttf for lower thirds (blank = FFmpeg default)
}


def _migrate_db() -> None:
    """Add columns introduced after initial schema creation (SQLite-safe)."""
    with engine.connect() as conn:
        for table, col, definition in [
            ("schedule", "bumper_pre_id",  "INTEGER"),
            ("schedule", "bumper_post_id", "INTEGER"),
        ]:
            rows = conn.execute(
                __import__("sqlalchemy").text(f"PRAGMA table_info({table})")
            ).fetchall()
            existing = [r[1] for r in rows]
            if col not in existing:
                conn.execute(
                    __import__("sqlalchemy").text(
                        f"ALTER TABLE {table} ADD COLUMN {col} {definition}"
                    )
                )
        conn.commit()


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _migrate_db()
    db = SessionLocal()
    try:
        for key, value in DEFAULT_SETTINGS.items():
            if not db.query(Setting).filter(Setting.key == key).first():
                db.add(Setting(key=key, value=value))
        db.commit()
    finally:
        db.close()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
