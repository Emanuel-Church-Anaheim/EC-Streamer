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


class VideoLibrary(Base):
    """An external folder whose contents are scanned into the video library."""
    __tablename__ = "video_libraries"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)        # friendly label
    folder_path = Column(String, nullable=False) # absolute path on disk
    auto_scan = Column(Boolean, default=True)    # re-scan on startup
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class VideoFile(Base):
    __tablename__ = "videos"
    id = Column(Integer, primary_key=True, autoincrement=True)
    filename = Column(String, nullable=False)
    filepath = Column(String, nullable=False, unique=True)
    title = Column(String)
    duration = Column(Float)          # seconds
    size = Column(Integer)            # bytes
    library_id = Column(Integer, nullable=True)  # VideoLibrary.id or None (= uploaded)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class ScheduledItem(Base):
    __tablename__ = "schedule"
    id = Column(Integer, primary_key=True, autoincrement=True)
    video_id = Column(Integer, nullable=True)      # None for bumper/auto_bumper slots
    title = Column(String)
    start_time = Column(String, nullable=False)   # HH:MM  24-hour
    recurrence = Column(String, default="once")   # once | daily | weekly
    date = Column(String)                          # YYYY-MM-DD  (for 'once')
    days_of_week = Column(String)                  # comma-sep 0-6  (for 'weekly')
    enabled = Column(Boolean, default=True)
    priority = Column(Integer, default=0)
    bumper_pre_id = Column(Integer, nullable=True)    # BumperFile.id or None
    bumper_post_id = Column(Integer, nullable=True)   # BumperFile.id or None
    slot_type = Column(String, default="video")        # video | bumper | auto_bumper
    bumper_id = Column(Integer, nullable=True)         # BumperFile.id when slot_type='bumper'
    slot_duration = Column(Float, nullable=True)       # seconds for auto_bumper slot
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
    label = Column(String)                              # internal name
    filename = Column(String, default="")               # PNG filename
    filepath = Column(String, default="")               # absolute path to PNG
    trigger_offset = Column(Integer, default=0)         # seconds from video start
    duration = Column(Integer, default=0)               # seconds to display; 0 = entire video
    schedule_item_id = Column(Integer, nullable=True)   # None = global (all videos)
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
    "auto_bumper_enabled": "false",   # generate HTML schedule bumper
    "auto_bumper_duration": "30",     # seconds per auto bumper video
    "server_port": "8087",            # must match run.py port (used by renderer)
}


def _migrate_db() -> None:
    """Add columns introduced after initial schema creation (SQLite-safe)."""
    import sqlalchemy as sa
    with engine.connect() as conn:
        for table, col, definition in [
            ("schedule",     "bumper_pre_id",  "INTEGER"),
            ("schedule",     "bumper_post_id", "INTEGER"),
            ("schedule",     "slot_type",      "TEXT DEFAULT 'video'"),
            ("schedule",     "bumper_id",      "INTEGER"),
            ("schedule",     "slot_duration",  "REAL"),
            ("lower_thirds", "filename",       "TEXT DEFAULT ''"),
            ("lower_thirds", "filepath",       "TEXT DEFAULT ''"),
            ("videos",       "library_id",     "INTEGER"),
        ]:
            rows = conn.execute(
                sa.text(f"PRAGMA table_info({table})")
            ).fetchall()
            existing = [r[1] for r in rows]
            if col not in existing:
                conn.execute(
                    sa.text(f"ALTER TABLE {table} ADD COLUMN {col} {definition}")
                )
        conn.commit()

        # Make schedule.video_id nullable (SQLite requires a full table rebuild)
        rows = conn.execute(sa.text("PRAGMA table_info(schedule)")).fetchall()
        # row format: (cid, name, type, notnull, dflt_value, pk)
        vid_col = next((r for r in rows if r[1] == "video_id"), None)
        if vid_col and vid_col[3] == 1:  # notnull == 1 means NOT NULL
            col_names = [r[1] for r in rows]
            cols_csv  = ", ".join(col_names)
            # Rebuild without NOT NULL on video_id
            col_defs = []
            for r in rows:
                cid, name, typ, notnull, dflt, pk = r
                defn = f"{name} {typ}"
                if pk:
                    defn += " PRIMARY KEY"
                if notnull and name != "video_id":
                    defn += " NOT NULL"
                if dflt is not None:
                    defn += f" DEFAULT {dflt}"
                col_defs.append(defn)
            conn.execute(sa.text("PRAGMA foreign_keys = OFF"))
            conn.execute(sa.text(
                f"CREATE TABLE schedule_new ({', '.join(col_defs)})"
            ))
            conn.execute(sa.text(
                f"INSERT INTO schedule_new ({cols_csv}) SELECT {cols_csv} FROM schedule"
            ))
            conn.execute(sa.text("DROP TABLE schedule"))
            conn.execute(sa.text("ALTER TABLE schedule_new RENAME TO schedule"))
            conn.execute(sa.text("PRAGMA foreign_keys = ON"))
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
