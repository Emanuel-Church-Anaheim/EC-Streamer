import json
import logging
import os
import platform
import re
import shutil
import subprocess
import unicodedata
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
    VideoLibrary,
    get_db,
    init_db,
)
from app.streamer import stream_manager
from app.restream import restream_manager
from app import bumper_renderer

logger = logging.getLogger(__name__)

_CREATION_FLAGS = subprocess.CREATE_NO_WINDOW if platform.system() == "Windows" else 0

app = FastAPI(title="EC-Streamer", version="1.0.0")
app.mount("/static", StaticFiles(directory="static"), name="static")


# ── Lifecycle ─────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def on_startup() -> None:
    os.makedirs("videos", exist_ok=True)
    os.makedirs("bumpers", exist_ok=True)
    os.makedirs("overlays", exist_ok=True)
    init_db()
    db = SessionLocal()
    try:
        settings = {s.key: s.value for s in db.query(Setting).all()}
    finally:
        db.close()
    stream_manager.configure(settings)
    # Auto-scan libraries flagged for it
    db_scan = SessionLocal()
    try:
        for lib in db_scan.query(VideoLibrary).filter(VideoLibrary.auto_scan == True).all():  # noqa: E712
            if os.path.isdir(lib.folder_path):
                added, _ = _scan_library(lib, db_scan)
                if added:
                    logger.info("Auto-scan: %d new video(s) from library '%s'", added, lib.name)
    except Exception as exc:
        logger.warning("Auto-scan error on startup: %s", exc)
    finally:
        db_scan.close()
    # Kick off auto bumper render in the background (no-op if disabled)
    bumper_renderer.trigger_regenerate(settings)


@app.on_event("shutdown")
async def on_shutdown() -> None:
    if stream_manager.running:
        stream_manager.stop()


# ── UI ────────────────────────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse("templates/index.html")


@app.get("/bumper-preview", include_in_schema=False)
async def bumper_preview():
    """Live preview of the auto schedule bumper (also used by the renderer)."""
    return FileResponse("templates/bumper.html")


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


# ── Auto bumper ──────────────────────────────────────────────────────────────

@app.get("/api/schedule-upcoming")
def schedule_upcoming(db: Session = Depends(get_db)):
    """Return the next 4 upcoming schedule items for the bumper preview page."""
    return bumper_renderer.get_upcoming_schedule(db, limit=4)


@app.post("/api/bumper/regenerate")
def regenerate_bumper(db: Session = Depends(get_db)):
    """Manually trigger a re-render of the auto schedule bumper."""
    if not bumper_renderer.is_playwright_available():
        raise HTTPException(
            503,
            "playwright is not installed. Run: pip install playwright && playwright install chromium",
        )
    settings = {s.key: s.value for s in db.query(Setting).all()}
    # Force-enable for this call even if setting is off
    settings["auto_bumper_enabled"] = "true"
    bumper_renderer.trigger_regenerate(settings)
    return {"status": "rendering"}


@app.get("/api/bumper/status")
def bumper_status():
    """Return last-modified time and existence of the auto bumper file."""
    path = bumper_renderer.AUTO_BUMPER_PATH
    exists = os.path.exists(path)
    mtime  = None
    if exists:
        try:
            mtime = datetime.fromtimestamp(os.path.getmtime(path)).isoformat()
        except OSError:
            pass
    return {
        "file_exists":        exists,
        "last_rendered":      mtime,
        "playwright_available": bumper_renderer.is_playwright_available(),
    }


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


# ── Re-stream control ─────────────────────────────────────────────────────────

@app.get("/api/restream/status")
def get_restream_status():
    return restream_manager.get_status()


@app.post("/api/restream/start")
async def start_restream(request: Request, db: Session = Depends(get_db)):
    data = await request.json()
    filepath = data.get("filepath", "")
    title    = data.get("title", os.path.basename(filepath))
    # Merge caller-supplied settings on top of stored settings so ffmpeg/ffprobe
    # paths are always available even if the user didn't send them.
    stored = {s.key: s.value for s in db.query(Setting).all()}
    settings = {
        "ffmpeg_path":   stored.get("ffmpeg_path", "ffmpeg"),
        "ffprobe_path":  stored.get("ffprobe_path", "ffprobe"),
        "rtmp_url":      data.get("rtmp_url",      stored.get("rtmp_url",      "")),
        "stream_key":    data.get("stream_key",    stored.get("stream_key",    "")),
        "resolution":    data.get("resolution",    stored.get("resolution",    "1280x720")),
        "fps":           data.get("fps",           stored.get("fps",           "30")),
        "video_bitrate": data.get("video_bitrate", stored.get("video_bitrate", "4500k")),
        "audio_bitrate": data.get("audio_bitrate", stored.get("audio_bitrate", "160k")),
        "encoder":       data.get("encoder",       stored.get("encoder",       "libx264")),
        "preset":        data.get("preset",        stored.get("preset",        "veryfast")),
    }
    if not filepath:
        raise HTTPException(400, "filepath is required")
    duration = data.get("duration")  # optional float — seconds
    try:
        duration = float(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration = None
    result = restream_manager.start(filepath, title, settings, duration=duration)
    if result.get("status") == "error":
        raise HTTPException(400, result.get("detail", "Cannot start re-stream"))
    return result


@app.post("/api/restream/stop")
def stop_restream():
    return restream_manager.stop()


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
        if ftype == "auto_bumper" and os.path.exists(bumper_renderer.AUTO_BUMPER_PATH):
            cmd = [
                ffmpeg, "-ss", "0", "-i", bumper_renderer.AUTO_BUMPER_PATH,
                "-vframes", "1", "-vf", "scale=640:-2",
                "-f", "image2", "-vcodec", "mjpeg", "-q:v", "3", "pipe:1",
            ]
        else:
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
    settings = {s.key: s.value for s in db.query(Setting).all()}
    bumper_renderer.trigger_regenerate(settings)
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
        "library_id": v.library_id,
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


# ── Video Libraries ────────────────────────────────────────────────────────────

_VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".webm",
               ".m4v", ".mpg", ".mpeg", ".ts", ".mts", ".m2ts"}


@app.get("/api/libraries")
def list_libraries(db: Session = Depends(get_db)):
    return [_lib_dict(lib) for lib in db.query(VideoLibrary).order_by(VideoLibrary.created_at).all()]


@app.post("/api/libraries")
async def add_library(request: Request, db: Session = Depends(get_db)):
    data = await request.json()
    folder = data.get("folder_path", "").strip()
    if not folder:
        raise HTTPException(400, "folder_path is required")
    # Normalise to absolute path
    folder = os.path.abspath(folder)
    if not os.path.isdir(folder):
        raise HTTPException(400, f"Directory not found: {folder}")
    if db.query(VideoLibrary).filter(VideoLibrary.folder_path == folder).first():
        raise HTTPException(409, "A library for that folder already exists")
    lib = VideoLibrary(
        name=data.get("name", "").strip() or os.path.basename(folder) or folder,
        folder_path=folder,
        auto_scan=data.get("auto_scan", True),
    )
    db.add(lib)
    db.commit()
    db.refresh(lib)
    added, skipped = _scan_library(lib, db)
    logger.info("Library %s added — %d new, %d skipped", folder, added, skipped)
    return {**_lib_dict(lib), "added": added, "skipped": skipped}


@app.put("/api/libraries/{lib_id}")
async def update_library(lib_id: int, request: Request, db: Session = Depends(get_db)):
    lib = db.query(VideoLibrary).filter(VideoLibrary.id == lib_id).first()
    if not lib:
        raise HTTPException(404, "Library not found")
    data = await request.json()
    if "name" in data:
        lib.name = data["name"]
    if "auto_scan" in data:
        lib.auto_scan = data["auto_scan"]
    db.commit()
    return _lib_dict(lib)


@app.delete("/api/libraries/{lib_id}")
def delete_library(
    lib_id: int,
    remove_videos: bool = False,
    db: Session = Depends(get_db),
):
    lib = db.query(VideoLibrary).filter(VideoLibrary.id == lib_id).first()
    if not lib:
        raise HTTPException(404, "Library not found")
    # Disassociate (or optionally delete) videos linked to this library
    videos = db.query(VideoFile).filter(VideoFile.library_id == lib_id).all()
    for v in videos:
        if remove_videos:
            db.query(ScheduledItem).filter(ScheduledItem.video_id == v.id).delete()
            db.delete(v)
        else:
            v.library_id = None   # keep the video, just detach it
    db.delete(lib)
    db.commit()
    return {"status": "deleted", "videos_removed": len(videos) if remove_videos else 0}


@app.post("/api/libraries/{lib_id}/scan")
def scan_library(lib_id: int, db: Session = Depends(get_db)):
    lib = db.query(VideoLibrary).filter(VideoLibrary.id == lib_id).first()
    if not lib:
        raise HTTPException(404, "Library not found")
    if not os.path.isdir(lib.folder_path):
        raise HTTPException(400, f"Folder no longer exists: {lib.folder_path}")
    added, skipped = _scan_library(lib, db)
    return {"status": "scanned", "added": added, "skipped": skipped}


def _lib_dict(lib: VideoLibrary) -> dict:
    return {
        "id": lib.id,
        "name": lib.name,
        "folder_path": lib.folder_path,
        "auto_scan": lib.auto_scan,
        "created_at": lib.created_at.isoformat() if lib.created_at else None,
    }


def _scan_library(lib: VideoLibrary, db: Session) -> tuple[int, int]:
    """Walk lib.folder_path, add any new video files to VideoFile table.
    Returns (added_count, skipped_count)."""
    settings_dict = {s.key: s.value for s in db.query(Setting).all()}
    added = skipped = 0
    try:
        for entry in os.scandir(lib.folder_path):
            if not entry.is_file():
                continue
            ext = os.path.splitext(entry.name)[1].lower()
            if ext not in _VIDEO_EXTS:
                continue
            abs_path = os.path.abspath(entry.path)
            # Skip if already known
            if db.query(VideoFile).filter(VideoFile.filepath == abs_path).first():
                skipped += 1
                continue
            duration = _probe_duration_direct(abs_path, settings_dict)
            try:
                size = entry.stat().st_size
            except OSError:
                size = None
            title = os.path.splitext(entry.name)[0]
            video = VideoFile(
                filename=entry.name,
                filepath=abs_path,
                title=title,
                duration=duration,
                size=size,
                library_id=lib.id,
            )
            db.add(video)
            added += 1
    except Exception as exc:
        logger.warning("Library scan error for %s: %s", lib.folder_path, exc)
    db.commit()
    return added, skipped


def _probe_duration_direct(filepath: str, settings: dict) -> Optional[float]:
    """ffprobe without a DB session (uses settings dict directly)."""
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


# ── Local sermon catalogue + title enrichment ────────────────────────────────

_SERMON_CATALOGUE: list = []   # loaded lazily from yt_video_sermons.json

def _load_sermon_catalogue() -> list:
    global _SERMON_CATALOGUE
    if _SERMON_CATALOGUE:
        return _SERMON_CATALOGUE
    catalogue_path = os.path.join(os.path.dirname(__file__), "..", "yt_video_sermons.json")
    try:
        with open(catalogue_path, encoding="utf-8") as f:
            _SERMON_CATALOGUE = json.load(f)
        logger.info("Loaded %d entries from yt_video_sermons.json", len(_SERMON_CATALOGUE))
    except FileNotFoundError:
        logger.warning("yt_video_sermons.json not found — enrich will return no matches")
    except Exception as exc:
        logger.warning("Failed to load sermon catalogue: %s", exc)
    return _SERMON_CATALOGUE


def _normalise(text: str) -> str:
    """Lowercase, strip accents, collapse whitespace/punctuation to spaces."""
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = re.sub(r"[^a-z0-9 ]+", " ", text.lower())
    return re.sub(r"\s+", " ", text).strip()


def _token_overlap(a: str, b: str) -> float:
    """Fraction of tokens in `a` that appear in `b`."""
    ta = set(_normalise(a).split())
    tb = set(_normalise(b).split())
    if not ta:
        return 0.0
    return len(ta & tb) / len(ta)


def _filename_to_query(filename: str) -> str:
    """Turn a cleaned filename stem into a human-readable query string.
    e.g. 'Lazar_Gog-Omul_de_tip_Isus' -> 'Lazar Gog Omul de tip Isus'
    """
    stem = os.path.splitext(filename)[0]
    return re.sub(r"[_\-]+", " ", stem).strip()


def _search_catalogue(query: str, max_results: int = 3) -> list:
    """Score every entry in the local catalogue against the query tokens.
    Returns up to max_results sorted by descending score."""
    catalogue = _load_sermon_catalogue()
    if not catalogue:
        return []
    scored = []
    for entry in catalogue:
        combined = f"{entry.get('title', '')} {entry.get('speaker', '')}"
        score = _token_overlap(query, combined)
        if score > 0:
            scored.append((score, entry))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [
        {
            "youtube_id": e["id"],
            "title": f"{e['title']} - {e['speaker']}",
            "channel": e.get("speaker", ""),
            "score": round(s, 3),
        }
        for s, e in scored[:max_results]
    ]


@app.post("/api/videos/enrich-preview")
async def enrich_preview(request: Request, db: Session = Depends(get_db)):
    """Match library videos against the local sermon catalogue.
    Body: { library_id?: int, video_ids?: [int] }
    Returns a list of { video_id, filename, current_title, query, candidates[] }.
    """
    body = await request.json()

    library_id = body.get("library_id")
    video_ids = body.get("video_ids")

    if library_id:
        videos = db.query(VideoFile).filter(VideoFile.library_id == int(library_id)).all()
    elif video_ids:
        videos = db.query(VideoFile).filter(VideoFile.id.in_(video_ids)).all()
    else:
        videos = db.query(VideoFile).all()

    results = []
    for v in videos:
        query = _filename_to_query(v.filename)
        candidates = _search_catalogue(query, max_results=3)
        results.append({
            "video_id": v.id,
            "filename": v.filename,
            "current_title": v.title or v.filename,
            "query": query,
            "candidates": candidates,
        })
    return results


@app.post("/api/videos/enrich-apply")
async def enrich_apply(request: Request, db: Session = Depends(get_db)):
    """Apply enriched titles.
    Body: [{ video_id: int, title: str }, ...]
    """
    items = await request.json()
    updated = 0
    for item in items:
        v = db.query(VideoFile).filter(VideoFile.id == int(item["video_id"])).first()
        if v and item.get("title"):
            v.title = item["title"].strip()
            updated += 1
    db.commit()
    return {"updated": updated}


# ── Schedule ──────────────────────────────────────────────────────────────────

@app.get("/api/schedule")
def list_schedule(db: Session = Depends(get_db)):
    items = db.query(ScheduledItem).order_by(ScheduledItem.start_time).all()
    result = []
    for item in items:
        slot_type = getattr(item, "slot_type", None) or "video"
        video  = db.query(VideoFile).filter(VideoFile.id == item.video_id).first() if item.video_id else None
        bumper = db.query(BumperFile).filter(BumperFile.id == item.bumper_id).first() if getattr(item, "bumper_id", None) else None
        result.append(_schedule_dict(item, video, bumper))
    return result


@app.post("/api/schedule")
async def add_schedule(request: Request, db: Session = Depends(get_db)):
    data = await request.json()
    slot_type = data.get("slot_type", "video") or "video"
    video_id  = data.get("video_id")
    bumper_id = data.get("bumper_id")

    if slot_type == "video":
        if not db.query(VideoFile).filter(VideoFile.id == video_id).first():
            raise HTTPException(404, "Video not found")
    elif slot_type == "bumper":
        if not bumper_id or not db.query(BumperFile).filter(BumperFile.id == bumper_id).first():
            raise HTTPException(404, "Bumper not found")
        video_id = None
    elif slot_type == "auto_bumper":
        video_id  = None
        bumper_id = None
    else:
        raise HTTPException(400, f"Unknown slot_type: {slot_type}")

    item = ScheduledItem(
        video_id=video_id,
        slot_type=slot_type,
        bumper_id=bumper_id,
        slot_duration=data.get("slot_duration"),
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
    _trigger_auto_bumper(db)
    video  = db.query(VideoFile).filter(VideoFile.id == item.video_id).first() if item.video_id else None
    bumper = db.query(BumperFile).filter(BumperFile.id == item.bumper_id).first() if item.bumper_id else None
    return _schedule_dict(item, video, bumper)


@app.put("/api/schedule/{item_id}")
async def update_schedule(item_id: int, request: Request, db: Session = Depends(get_db)):
    item = db.query(ScheduledItem).filter(ScheduledItem.id == item_id).first()
    if not item:
        raise HTTPException(404, "Schedule item not found")
    data = await request.json()
    for field in ["title", "start_time", "recurrence", "date", "days_of_week",
                  "enabled", "priority", "video_id", "slot_type", "bumper_id", "slot_duration"]:
        if field in data:
            setattr(item, field, data[field] if data[field] != '' else None)
    for field in ["bumper_pre_id", "bumper_post_id"]:
        if field in data:
            setattr(item, field, data[field] or None)
    db.commit()
    stream_manager.trigger_switch()
    _trigger_auto_bumper(db)
    video  = db.query(VideoFile).filter(VideoFile.id == item.video_id).first() if item.video_id else None
    bumper = db.query(BumperFile).filter(BumperFile.id == item.bumper_id).first() if item.bumper_id else None
    return _schedule_dict(item, video, bumper)


@app.delete("/api/schedule/{item_id}")
def delete_schedule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(ScheduledItem).filter(ScheduledItem.id == item_id).first()
    if not item:
        raise HTTPException(404, "Schedule item not found")
    db.delete(item)
    db.commit()
    stream_manager.trigger_switch()
    _trigger_auto_bumper(db)
    return {"status": "deleted"}


def _trigger_auto_bumper(db: Session) -> None:
    """Re-render auto bumper if enabled, pulling current settings."""
    settings = {s.key: s.value for s in db.query(Setting).all()}
    bumper_renderer.trigger_regenerate(settings)


def _schedule_dict(item: ScheduledItem, video: Optional[VideoFile] = None, bumper: Optional[BumperFile] = None) -> dict:
    slot_type = getattr(item, "slot_type", None) or "video"
    if slot_type == "video":
        display_title = (video.title or video.filename) if video else "Unknown"
        duration = video.duration if video else None
    elif slot_type == "bumper":
        display_title = (bumper.title or bumper.filename) if bumper else "Unknown Bumper"
        duration = bumper.duration if bumper else None
    else:  # auto_bumper
        display_title = "Auto Schedule Bumper"
        duration = getattr(item, "slot_duration", None)
    return {
        "id": item.id,
        "slot_type": slot_type,
        "video_id": item.video_id,
        "bumper_id": getattr(item, "bumper_id", None),
        "slot_duration": getattr(item, "slot_duration", None),
        "video_title": display_title,
        "video_duration": duration,
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


# ── Overlay graphics (PNG lower thirds) ──────────────────────────────────────

@app.get("/api/lower-thirds")
def list_lower_thirds(db: Session = Depends(get_db)):
    return [
        _lt_dict(lt)
        for lt in db.query(LowerThird).order_by(LowerThird.created_at.desc()).all()
    ]


@app.post("/api/lower-thirds")
async def upload_lower_third(
    file: UploadFile = File(...),
    label: str = Form(""),
    trigger_offset: int = Form(0),
    duration: int = Form(0),
    schedule_item_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
):
    if not file.filename:
        raise HTTPException(400, "No file provided")
    safe_name = os.path.basename(file.filename)
    if not safe_name or safe_name in (".", ".."):
        raise HTTPException(400, "Invalid filename")
    # Allow PNG, JPEG, GIF, WEBP overlays
    ext = os.path.splitext(safe_name)[1].lower()
    if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        raise HTTPException(400, "Only PNG/JPEG/GIF/WEBP files are accepted")
    dest = os.path.abspath(os.path.join("overlays", safe_name))
    overlays_root = os.path.abspath("overlays")
    if not dest.startswith(overlays_root + os.sep):
        raise HTTPException(400, "Invalid filename")
    base, fext = os.path.splitext(dest)
    counter = 1
    while os.path.exists(dest):
        dest = f"{base}_{counter}{fext}"
        counter += 1
    safe_name = os.path.basename(dest)
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    size = os.path.getsize(dest)
    lt = LowerThird(
        label=label or os.path.splitext(safe_name)[0],
        filename=safe_name,
        filepath=dest,
        trigger_offset=trigger_offset,
        duration=duration,
        schedule_item_id=schedule_item_id or None,
    )
    db.add(lt)
    db.commit()
    db.refresh(lt)
    return _lt_dict(lt)


@app.get("/api/lower-thirds/{lt_id}/image")
def get_overlay_image(lt_id: int, db: Session = Depends(get_db)):
    lt = db.query(LowerThird).filter(LowerThird.id == lt_id).first()
    if not lt or not lt.filepath or not os.path.exists(lt.filepath):
        raise HTTPException(404, "Image not found")
    return FileResponse(lt.filepath)


@app.put("/api/lower-thirds/{lt_id}")
async def update_lower_third(
    lt_id: int, request: Request, db: Session = Depends(get_db)
):
    lt = db.query(LowerThird).filter(LowerThird.id == lt_id).first()
    if not lt:
        raise HTTPException(404, "Overlay not found")
    data = await request.json()
    for field in ("label", "trigger_offset", "duration", "enabled"):
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
        raise HTTPException(404, "Overlay not found")
    try:
        if lt.filepath and os.path.exists(lt.filepath):
            os.remove(lt.filepath)
    except OSError as exc:
        logger.warning("Could not remove overlay %s: %s", lt.filepath, exc)
    db.delete(lt)
    db.commit()
    return {"status": "deleted"}


def _lt_dict(lt: LowerThird) -> dict:
    return {
        "id": lt.id,
        "label": lt.label,
        "filename": lt.filename,
        "trigger_offset": lt.trigger_offset,
        "duration": lt.duration,
        "schedule_item_id": lt.schedule_item_id,
        "enabled": lt.enabled,
        "created_at": lt.created_at.isoformat() if lt.created_at else None,
    }
