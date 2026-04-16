import json
import logging
import os
import platform
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from app.database import (
    BumperFile,
    DEFAULT_SETTINGS,
    LowerThird,
    ScheduledItem,
    SessionLocal,
    Setting,
    VideoFile,
    get_db,
    init_db,
)
from app.streamer import stream_manager

logger = logging.getLogger(__name__)

_CREATION_FLAGS = subprocess.CREATE_NO_WINDOW if platform.system() == "Windows" else 0

app = FastAPI(title="EC-Streamer", version="1.0.0")
app.mount("/static", StaticFiles(directory="static"), name="static")


# ── Lifecycle ─────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def on_startup() -> None:
    os.makedirs("videos", exist_ok=True)
    os.makedirs("bumpers", exist_ok=True)
    init_db()
    db = SessionLocal()
    try:
        settings = {s.key: s.value for s in db.query(Setting).all()}
    finally:
        db.close()
    stream_manager.configure(settings)


@app.on_event("shutdown")
async def on_shutdown() -> None:
    if stream_manager.running:
        stream_manager.stop()


# ── UI ────────────────────────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse("templates/index.html")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    # Prefer the SVG (served directly from /static/favicon.svg via the <link> tag);
    # this endpoint is the fallback for browsers that still request /favicon.ico.
    svg = "static/favicon.svg"
    if os.path.exists(svg):
        return FileResponse(svg, media_type="image/svg+xml",
                            headers={"Cache-Control": "max-age=86400"})
    ico = "static/favicon.ico"
    if os.path.exists(ico):
        return FileResponse(ico)
    # Last-resort: minimal transparent 1×1 ICO
    ICO_1PX = (
        b"\x00\x00\x01\x00\x01\x00\x01\x01\x00\x00\x01\x00\x18\x00"
        b"\x30\x00\x00\x00\x16\x00\x00\x00\x28\x00\x00\x00\x01\x00"
        b"\x00\x00\x02\x00\x00\x00\x01\x00\x18\x00\x00\x00\x00\x00"
        b"\x04\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
        b"\x00\x00\x00\x00\x00\x00\x1e\x1e\x1e\x00\x00\x00\x00\x00"
    )
    return Response(content=ICO_1PX, media_type="image/x-icon",
                    headers={"Cache-Control": "max-age=86400"})


# ── System check ──────────────────────────────────────────────────────────────

@app.get("/api/check")
def check_system(db: Session = Depends(get_db)):
    settings = {s.key: s.value for s in db.query(Setting).all()}
    results = {}
    for key, name in [("ffmpeg_path", "ffmpeg"), ("ffprobe_path", "ffprobe")]:
        path = settings.get(key, name)
        try:
            r = subprocess.run(
                [path, "-version"],
                capture_output=True, text=True, timeout=5,
                creationflags=_CREATION_FLAGS,
            )
            results[name] = {"available": r.returncode == 0, "path": path}
        except FileNotFoundError:
            results[name] = {"available": False, "path": path}
        except Exception as exc:
            results[name] = {"available": False, "path": path, "error": str(exc)}
    return results


# ── Stream control ────────────────────────────────────────────────────────────

@app.get("/api/status")
def get_status():
    return stream_manager.get_status()


@app.post("/api/stream/start")
def start_stream(db: Session = Depends(get_db)):
    _reload_settings(db)
    return stream_manager.start()


@app.post("/api/stream/stop")
def stop_stream():
    return stream_manager.stop()


@app.post("/api/stream/restart")
def restart_stream(db: Session = Depends(get_db)):
    _reload_settings(db)
    return stream_manager.restart()


@app.post("/api/stream/play-now/{video_id}")
def play_now(video_id: int, db: Session = Depends(get_db)):
    video = db.query(VideoFile).filter(VideoFile.id == video_id).first()
    if not video:
        raise HTTPException(404, "Video not found")
    if not stream_manager.running:
        raise HTTPException(400, "Stream is not running — start it first.")
    stream_manager.play_override(video_id)
    return {"status": "switching", "title": video.title or video.filename}


@app.post("/api/stream/clear-override")
def clear_override():
    stream_manager.clear_override()
    return {"status": "override_cleared"}


@app.get("/api/preview.jpg")
def get_preview(db: Session = Depends(get_db)):
    """Return a single JPEG frame from the current source for the dashboard preview."""
    settings = {s.key: s.value for s in db.query(Setting).all()}
    ffmpeg = settings.get("ffmpeg_path", "ffmpeg")
    status = stream_manager.get_status()
    item   = status.get("current_item")

    cmd: Optional[list] = None

    if item and item.get("type") == "video":
        filepath   = item.get("filepath", "")
        started_at = item.get("started_at")
        if filepath and os.path.exists(filepath):
            offset = 0
            if started_at:
                try:
                    elapsed = (
                        datetime.now(timezone.utc)
                        - datetime.fromisoformat(started_at).astimezone(timezone.utc)
                    ).total_seconds()
                    video_id = item.get("video_id")
                    if video_id:
                        video = db.query(VideoFile).filter(VideoFile.id == video_id).first()
                        if video and video.duration and video.duration > 0:
                            offset = elapsed % video.duration
                        else:
                            offset = max(0, elapsed)
                except Exception:
                    offset = 0
            cmd = [
                ffmpeg, "-ss", str(max(0, int(offset))), "-i", filepath,
                "-vframes", "1", "-vf", "scale=640:-2",
                "-f", "image2", "-vcodec", "mjpeg", "-q:v", "3", "pipe:1",
            ]

    if cmd is None:
        # Filler preview
        res    = settings.get("resolution", "1280x720")
        ftype  = settings.get("filler_type", "black")
        fcolor = settings.get("filler_color", "000000")
        if ftype == "test":
            vsrc = f"testsrc=size={res}:rate=1"
        elif ftype == "color":
            vsrc = f"color=c=#{fcolor}:size={res}:rate=1"
        else:
            vsrc = f"color=c=black:size={res}:rate=1"
        cmd = [
            ffmpeg, "-f", "lavfi", "-i", vsrc,
            "-vframes", "1", "-vf", "scale=640:-2",
            "-f", "image2", "-vcodec", "mjpeg", "-q:v", "3", "pipe:1",
        ]

    try:
        result = subprocess.run(
            cmd, capture_output=True, timeout=15,
            creationflags=_CREATION_FLAGS,
        )
        if result.returncode == 0 and result.stdout:
            return Response(
                content=result.stdout,
                media_type="image/jpeg",
                headers={"Cache-Control": "no-store, max-age=0"},
            )
    except Exception as exc:
        logger.warning("Preview generation failed: %s", exc)
    raise HTTPException(503, "Preview unavailable")


def _reload_settings(db: Session) -> None:
    settings = {s.key: s.value for s in db.query(Setting).all()}
    stream_manager.configure(settings)


# ── Settings ──────────────────────────────────────────────────────────────────

@app.get("/api/settings")
def get_settings(db: Session = Depends(get_db)):
    return {s.key: s.value for s in db.query(Setting).all()}


@app.post("/api/settings")
async def update_settings(request: Request, db: Session = Depends(get_db)):
    data = await request.json()
    for key, value in data.items():
        s = db.query(Setting).filter(Setting.key == key).first()
        if s:
            s.value = str(value)
        else:
            db.add(Setting(key=key, value=str(value)))
    db.commit()
    _reload_settings(db)
    return {"status": "saved"}


# ── Videos ────────────────────────────────────────────────────────────────────

@app.get("/api/videos")
def list_videos(db: Session = Depends(get_db)):
    return [
        _video_dict(v)
        for v in db.query(VideoFile).order_by(VideoFile.created_at.desc()).all()
    ]


@app.post("/api/videos/upload")
async def upload_video(
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    os.makedirs("videos", exist_ok=True)

    # Prevent path traversal
    safe_name = os.path.basename(file.filename or "upload")
    if not safe_name or safe_name in (".", ".."):
        raise HTTPException(400, "Invalid filename")

    dest = os.path.abspath(os.path.join("videos", safe_name))
    videos_root = os.path.abspath("videos")
    if not dest.startswith(videos_root + os.sep):
        raise HTTPException(400, "Invalid filename")

    # Avoid collisions
    base, ext = os.path.splitext(dest)
    counter = 1
    while os.path.exists(dest):
        dest = f"{base}_{counter}{ext}"
        counter += 1
    safe_name = os.path.basename(dest)

    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    duration = _probe_duration(dest, db)
    size = os.path.getsize(dest)

    video = VideoFile(
        filename=safe_name,
        filepath=dest,
        title=title or os.path.splitext(safe_name)[0],
        duration=duration,
        size=size,
    )
    db.add(video)
    db.commit()
    db.refresh(video)
    return _video_dict(video)


@app.delete("/api/videos/{video_id}")
def delete_video(video_id: int, db: Session = Depends(get_db)):
    video = db.query(VideoFile).filter(VideoFile.id == video_id).first()
    if not video:
        raise HTTPException(404, "Video not found")
    try:
        if os.path.exists(video.filepath):
            os.remove(video.filepath)
    except OSError as exc:
        logger.warning("Could not remove file %s: %s", video.filepath, exc)
    db.query(ScheduledItem).filter(ScheduledItem.video_id == video_id).delete()
    db.delete(video)
    db.commit()
    return {"status": "deleted"}


@app.put("/api/videos/{video_id}")
async def update_video(video_id: int, request: Request, db: Session = Depends(get_db)):
    video = db.query(VideoFile).filter(VideoFile.id == video_id).first()
    if not video:
        raise HTTPException(404, "Video not found")
    data = await request.json()
    if "title" in data:
        video.title = data["title"]
    db.commit()
    return _video_dict(video)


def _video_dict(v: VideoFile) -> dict:
    return {
        "id": v.id,
        "filename": v.filename,
        "filepath": v.filepath,
        "title": v.title or v.filename,
        "duration": v.duration,
        "size": v.size,
        "created_at": v.created_at.isoformat() if v.created_at else None,
    }


def _probe_duration(filepath: str, db: Session) -> Optional[float]:
    settings = {s.key: s.value for s in db.query(Setting).all()}
    ffprobe = settings.get("ffprobe_path", "ffprobe")
    try:
        r = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", filepath],
            capture_output=True, text=True, timeout=30,
            creationflags=_CREATION_FLAGS,
        )
        if r.returncode == 0:
            data = json.loads(r.stdout)
            return float(data.get("format", {}).get("duration", 0)) or None
    except Exception as exc:
        logger.warning("Could not probe duration for %s: %s", filepath, exc)
    return None


# ── Schedule ──────────────────────────────────────────────────────────────────

@app.get("/api/schedule")
def list_schedule(db: Session = Depends(get_db)):
    items = db.query(ScheduledItem).order_by(ScheduledItem.start_time).all()
    return [
        _schedule_dict(item, db.query(VideoFile).filter(VideoFile.id == item.video_id).first())
        for item in items
    ]


@app.post("/api/schedule")
async def add_schedule(request: Request, db: Session = Depends(get_db)):
    data = await request.json()
    video_id = data.get("video_id")
    if not db.query(VideoFile).filter(VideoFile.id == video_id).first():
        raise HTTPException(404, "Video not found")
    item = ScheduledItem(
        video_id=video_id,
        title=data.get("title"),
        start_time=data["start_time"],
        recurrence=data.get("recurrence", "once"),
        date=data.get("date"),
        days_of_week=data.get("days_of_week"),
        enabled=data.get("enabled", True),
        priority=int(data.get("priority", 0)),
        bumper_pre_id=data.get("bumper_pre_id") or None,
        bumper_post_id=data.get("bumper_post_id") or None,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    stream_manager.trigger_switch()
    video = db.query(VideoFile).filter(VideoFile.id == item.video_id).first()
    return _schedule_dict(item, video)


@app.put("/api/schedule/{item_id}")
async def update_schedule(item_id: int, request: Request, db: Session = Depends(get_db)):
    item = db.query(ScheduledItem).filter(ScheduledItem.id == item_id).first()
    if not item:
        raise HTTPException(404, "Schedule item not found")
    data = await request.json()
    for field in ["title", "start_time", "recurrence", "date", "days_of_week",
                  "enabled", "priority", "video_id"]:
        if field in data:
            setattr(item, field, data[field])
    for field in ["bumper_pre_id", "bumper_post_id"]:
        if field in data:
            setattr(item, field, data[field] or None)
    db.commit()
    stream_manager.trigger_switch()
    video = db.query(VideoFile).filter(VideoFile.id == item.video_id).first()
    return _schedule_dict(item, video)


@app.delete("/api/schedule/{item_id}")
def delete_schedule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(ScheduledItem).filter(ScheduledItem.id == item_id).first()
    if not item:
        raise HTTPException(404, "Schedule item not found")
    db.delete(item)
    db.commit()
    stream_manager.trigger_switch()
    return {"status": "deleted"}


def _schedule_dict(item: ScheduledItem, video: Optional[VideoFile]) -> dict:
    return {
        "id": item.id,
        "video_id": item.video_id,
        "video_title": (video.title or video.filename) if video else "Unknown",
        "video_duration": video.duration if video else None,
        "title": item.title,
        "start_time": item.start_time,
        "recurrence": item.recurrence,
        "date": item.date,
        "days_of_week": item.days_of_week,
        "enabled": item.enabled,
        "priority": item.priority,
        "bumper_pre_id": item.bumper_pre_id,
        "bumper_post_id": item.bumper_post_id,
    }


# ── Bumpers ──────────────────────────────────────────────────────────────────

@app.get("/api/bumpers")
def list_bumpers(db: Session = Depends(get_db)):
    return [
        _bumper_dict(b)
        for b in db.query(BumperFile).order_by(BumperFile.created_at.desc()).all()
    ]


@app.post("/api/bumpers/upload")
async def upload_bumper(
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    os.makedirs("bumpers", exist_ok=True)
    safe_name = os.path.basename(file.filename or "upload")
    if not safe_name or safe_name in (".", ".."):
        raise HTTPException(400, "Invalid filename")
    dest = os.path.abspath(os.path.join("bumpers", safe_name))
    bumpers_root = os.path.abspath("bumpers")
    if not dest.startswith(bumpers_root + os.sep):
        raise HTTPException(400, "Invalid filename")
    base, ext = os.path.splitext(dest)
    counter = 1
    while os.path.exists(dest):
        dest = f"{base}_{counter}{ext}"
        counter += 1
    safe_name = os.path.basename(dest)
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    duration = _probe_duration(dest, db)
    size = os.path.getsize(dest)
    bumper = BumperFile(
        filename=safe_name,
        filepath=dest,
        title=title or os.path.splitext(safe_name)[0],
        duration=duration,
        size=size,
    )
    db.add(bumper)
    db.commit()
    db.refresh(bumper)
    return _bumper_dict(bumper)


@app.put("/api/bumpers/{bumper_id}")
async def update_bumper(
    bumper_id: int, request: Request, db: Session = Depends(get_db)
):
    bumper = db.query(BumperFile).filter(BumperFile.id == bumper_id).first()
    if not bumper:
        raise HTTPException(404, "Bumper not found")
    data = await request.json()
    for field in ("title", "enabled"):
        if field in data:
            setattr(bumper, field, data[field])
    db.commit()
    return _bumper_dict(bumper)


@app.delete("/api/bumpers/{bumper_id}")
def delete_bumper(bumper_id: int, db: Session = Depends(get_db)):
    bumper = db.query(BumperFile).filter(BumperFile.id == bumper_id).first()
    if not bumper:
        raise HTTPException(404, "Bumper not found")
    try:
        if os.path.exists(bumper.filepath):
            os.remove(bumper.filepath)
    except OSError as exc:
        logger.warning("Could not remove bumper %s: %s", bumper.filepath, exc)
    db.delete(bumper)
    db.commit()
    return {"status": "deleted"}


def _bumper_dict(b: BumperFile) -> dict:
    return {
        "id": b.id,
        "filename": b.filename,
        "title": b.title or b.filename,
        "duration": b.duration,
        "size": b.size,
        "enabled": b.enabled,
        "created_at": b.created_at.isoformat() if b.created_at else None,
    }


# ── Lower thirds ─────────────────────────────────────────────────────────────

@app.get("/api/lower-thirds")
def list_lower_thirds(db: Session = Depends(get_db)):
    return [
        _lt_dict(lt)
        for lt in db.query(LowerThird).order_by(LowerThird.created_at.desc()).all()
    ]


@app.post("/api/lower-thirds")
async def create_lower_third(request: Request, db: Session = Depends(get_db)):
    data = await request.json()
    lt = LowerThird(
        label=data.get("label", ""),
        line1=data.get("line1", ""),
        line2=data.get("line2", ""),
        position=data.get("position", "bottom-left"),
        font_size=int(data.get("font_size", 32)),
        text_color=data.get("text_color", "ffffff"),
        bg_color=data.get("bg_color", "000000"),
        bg_opacity=float(data.get("bg_opacity", 0.6)),
        trigger_offset=int(data.get("trigger_offset", 5)),
        duration=int(data.get("duration", 10)),
        schedule_item_id=data.get("schedule_item_id") or None,
        enabled=data.get("enabled", True),
    )
    db.add(lt)
    db.commit()
    db.refresh(lt)
    return _lt_dict(lt)


@app.put("/api/lower-thirds/{lt_id}")
async def update_lower_third(
    lt_id: int, request: Request, db: Session = Depends(get_db)
):
    lt = db.query(LowerThird).filter(LowerThird.id == lt_id).first()
    if not lt:
        raise HTTPException(404, "Lower third not found")
    data = await request.json()
    for field in ("label", "line1", "line2", "position", "font_size",
                  "text_color", "bg_color", "bg_opacity",
                  "trigger_offset", "duration", "enabled"):
        if field in data:
            setattr(lt, field, data[field])
    if "schedule_item_id" in data:
        lt.schedule_item_id = data["schedule_item_id"] or None
    db.commit()
    return _lt_dict(lt)


@app.delete("/api/lower-thirds/{lt_id}")
def delete_lower_third(lt_id: int, db: Session = Depends(get_db)):
    lt = db.query(LowerThird).filter(LowerThird.id == lt_id).first()
    if not lt:
        raise HTTPException(404, "Lower third not found")
    db.delete(lt)
    db.commit()
    return {"status": "deleted"}


def _lt_dict(lt: LowerThird) -> dict:
    return {
        "id": lt.id,
        "label": lt.label,
        "line1": lt.line1,
        "line2": lt.line2,
        "position": lt.position,
        "font_size": lt.font_size,
        "text_color": lt.text_color,
        "bg_color": lt.bg_color,
        "bg_opacity": lt.bg_opacity,
        "trigger_offset": lt.trigger_offset,
        "duration": lt.duration,
        "schedule_item_id": lt.schedule_item_id,
        "enabled": lt.enabled,
        "created_at": lt.created_at.isoformat() if lt.created_at else None,
    }
