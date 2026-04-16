"""
Auto schedule bumper renderer.

Renders the /bumper-preview HTML page with the next N scheduled items to a
video file using Playwright (headless Chromium), then converts to H.264 MP4
via FFmpeg.

Install once:
    pip install playwright
    playwright install chromium
"""

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
import threading
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

# The auto-generated bumper lives here (never surfaced in the BumperFile table;
# the streamer reads it directly via AUTO_BUMPER_PATH).
AUTO_BUMPER_PATH = os.path.abspath(os.path.join("bumpers", "_auto_schedule.mp4"))

_render_lock = threading.Lock()
_IS_WIN = os.name == "nt"
_FLAGS = subprocess.CREATE_NO_WINDOW if _IS_WIN else 0

# ── public helpers ────────────────────────────────────────────────────────────


def is_playwright_available() -> bool:
    try:
        import playwright  # noqa: F401
        return True
    except ImportError:
        return False


def trigger_regenerate(settings: dict) -> None:
    """Start a background render thread if auto_bumper_enabled=true."""
    if settings.get("auto_bumper_enabled", "false").lower() != "true":
        return
    t = threading.Thread(
        target=_regenerate_blocking,
        args=(settings,),
        daemon=True,
        name="AutoBumperRender",
    )
    t.start()


def get_upcoming_schedule(db, limit: int = 4) -> list:
    """Return the next *limit* upcoming scheduled items, sorted chronologically."""
    from app.database import ScheduledItem, VideoFile  # local import avoids circular

    now        = datetime.now()
    now_mins   = now.hour * 60 + now.minute
    today_wd   = now.weekday()          # 0 = Monday
    today_date = now.strftime("%Y-%m-%d")

    rows = db.query(ScheduledItem).filter(ScheduledItem.enabled == True).all()  # noqa: E712
    candidates = []

    for item in rows:
        video = db.query(VideoFile).filter(VideoFile.id == item.video_id).first()
        if not video:
            continue

        h, m       = map(int, item.start_time.split(":"))
        start_mins = h * 60 + m

        if item.recurrence == "once":
            if item.date < today_date:
                continue
            if item.date == today_date and start_mins <= now_mins:
                continue
            sort_key = (item.date, start_mins)

        elif item.recurrence == "daily":
            if start_mins > now_mins:
                sort_key = (today_date, start_mins)
            else:
                tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%d")
                sort_key  = (tomorrow, start_mins)

        elif item.recurrence == "weekly":
            days = [
                int(d.strip())
                for d in (item.days_of_week or "").split(",")
                if d.strip().isdigit()
            ]
            found = None
            # Check today first (if not yet passed), then next 7 days
            for offset in range(8):
                day = (today_wd + offset) % 7
                if day in days:
                    if offset == 0 and start_mins <= now_mins:
                        continue
                    found = offset
                    break
            if found is None:
                continue
            next_date = (now + timedelta(days=found)).strftime("%Y-%m-%d")
            sort_key  = (next_date, start_mins)

        else:
            continue

        raw = (item.title or video.title or video.filename or "").strip()
        if " - " in raw:
            idx     = raw.rfind(" - ")
            title   = raw[:idx].strip()
            speaker = raw[idx + 3:].strip()
        else:
            title   = raw
            speaker = ""

        candidates.append({
            "sort_key": sort_key,
            "time":     item.start_time,
            "title":    title,
            "speaker":  speaker,
        })

    candidates.sort(key=lambda x: x["sort_key"])
    return [
        {"time": c["time"], "title": c["title"], "speaker": c["speaker"]}
        for c in candidates[:limit]
    ]


# ── internal ──────────────────────────────────────────────────────────────────


def _regenerate_blocking(settings: dict) -> None:
    if not _render_lock.acquire(blocking=False):
        logger.info("Auto bumper render skipped — another render already running")
        return
    try:
        from app.database import SessionLocal
        db = SessionLocal()
        try:
            items = get_upcoming_schedule(db)
        finally:
            db.close()

        port     = int(settings.get("server_port", "8087"))
        url      = f"http://127.0.0.1:{port}/bumper-preview"
        duration = max(5, int(settings.get("auto_bumper_duration", "30")))
        ffmpeg   = settings.get("ffmpeg_path", "ffmpeg")

        asyncio.run(_render_via_playwright(url, AUTO_BUMPER_PATH, duration, ffmpeg))
        logger.info("Auto bumper saved → %s", AUTO_BUMPER_PATH)
    except Exception as exc:
        logger.error("Auto bumper render error: %s", exc, exc_info=True)
    finally:
        _render_lock.release()


async def _render_via_playwright(
    url: str, output_path: str, duration: int, ffmpeg_exe: str
) -> None:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise RuntimeError(
            "playwright is not installed.\n"
            "Run:  pip install playwright && playwright install chromium"
        )

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    tmp_mp4 = output_path + ".tmp.mp4"
    rec_dir = tempfile.mkdtemp(prefix="ec_bumper_")

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(args=[
                "--no-sandbox",
                "--disable-gpu",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows",
                "--force-device-scale-factor=1",
            ])
            context = await browser.new_context(
                viewport={"width": 1920, "height": 1080},
                device_scale_factor=1,
                record_video_dir=rec_dir,
                record_video_size={"width": 1920, "height": 1080},
            )
            page = await context.new_page()
            await page.goto(url, wait_until="networkidle")
            # Let CSS entry animations play for the full duration
            await asyncio.sleep(duration)
            await context.close()
            await browser.close()

        # Playwright names the file with a random UUID; grab it
        webm_files = [f for f in os.listdir(rec_dir) if f.endswith(".webm")]
        if not webm_files:
            raise RuntimeError("Playwright did not produce a .webm recording")
        webm_path = os.path.join(rec_dir, webm_files[0])

        # Convert webm → H.264 mp4 with a silent audio track
        cmd = [
            ffmpeg_exe, "-y",
            "-i", webm_path,
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-preset", "fast", "-crf", "18",
            "-c:a", "aac", "-b:a", "128k",
            "-map", "0:v:0", "-map", "1:a:0",
            "-shortest",
            tmp_mp4,
        ]
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=300,
            creationflags=_FLAGS,
        )
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg conversion failed:\n{result.stderr[-600:]}")

        os.replace(tmp_mp4, output_path)

    finally:
        shutil.rmtree(rec_dir, ignore_errors=True)
        try:
            os.remove(tmp_mp4)
        except OSError:
            pass
