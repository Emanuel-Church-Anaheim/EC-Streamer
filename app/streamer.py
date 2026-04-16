"""
StreamManager — manages the FFmpeg child process for the 24/7 RTMP stream.

Design:
- A single background thread (_stream_loop) runs continuously while
  self.running is True.
- Every ~5 seconds (or when woken by _switch_event) it decides what should
  be playing via _determine_playback(), compares with self.current_item,
  and kills/restarts FFmpeg as needed.
- Supports an "override" mode where a specific video is force-played
  regardless of the schedule (cleared automatically when that video ends).
"""

import os
import subprocess
import threading
import logging
import platform
from collections import deque
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

_IS_WINDOWS = platform.system() == "Windows"

# CREATE_NO_WINDOW prevents a console flash; CREATE_NEW_PROCESS_GROUP ensures
# the child gets its own process group so we can kill the whole tree later.
_CREATION_FLAGS = 0
if _IS_WINDOWS:
    _CREATION_FLAGS = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP


class StreamManager:
    def __init__(self) -> None:
        self.process: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()

        # Every PID we have ever spawned — swept on stop to catch any leaked procs
        self._spawned_pids: set = set()

        self.running: bool = False
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._switch_event = threading.Event()

        self.current_item: Optional[dict] = None
        self.override_video_id: Optional[int] = None
        self.started_at: Optional[str] = None

        # Bumper state
        self._in_bumper: bool = False
        self._pending_target: Optional[dict] = None
        self._bumper_round: int = 0

        self.settings: dict = {}
        self.log_buffer: deque = deque(maxlen=300)

    # ── Public API ───────────────────────────────────────────────────────────

    def configure(self, settings: dict) -> None:
        self.settings = settings

    def start(self) -> dict:
        if self.running:
            return {"status": "already_running"}
        self.running = True
        self.started_at = datetime.now().isoformat()
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._stream_loop, daemon=True, name="StreamLoop"
        )
        self._thread.start()
        self._log("Stream manager started")
        return {"status": "started"}

    def stop(self) -> dict:
        if not self.running:
            return {"status": "not_running"}
        self.running = False
        self._stop_event.set()
        self._switch_event.set()   # wake the loop so it exits promptly
        self._kill_current("stop requested")
        if self._thread:
            self._thread.join(timeout=10)
            self._thread = None
        # Second pass: kill anything that slipped through during shutdown,
        # then sweep every PID we have ever spawned just in case.
        self._kill_current("post-join cleanup")
        self._kill_all_spawned()
        self.current_item = None
        self.started_at = None
        self._log("Stream stopped")
        return {"status": "stopped"}

    def restart(self) -> dict:
        self.stop()
        return self.start()

    def trigger_switch(self) -> None:
        """Wake the loop to re-evaluate the schedule immediately."""
        self._switch_event.set()

    def play_override(self, video_id: int) -> None:
        self.override_video_id = video_id
        self.trigger_switch()

    def clear_override(self) -> None:
        self.override_video_id = None
        self.trigger_switch()

    def get_status(self) -> dict:
        proc_alive = self.process is not None and self.process.poll() is None
        return {
            "running": self.running,
            "process_alive": proc_alive,
            "current_item": self.current_item,
            "started_at": self.started_at,
            "override_active": self.override_video_id is not None,
            "logs": list(self.log_buffer)[-50:],
        }

    # ── Internals — process management ───────────────────────────────────────

    def _log(self, msg: str) -> None:
        entry = {"time": datetime.now().strftime("%H:%M:%S"), "message": msg}
        self.log_buffer.append(entry)
        logger.info(msg)

    def _kill_all_spawned(self) -> None:
        """Last-resort sweep: kill every PID we have ever started that is still alive."""
        with self._lock:
            pids = set(self._spawned_pids)
            self._spawned_pids.clear()
        for pid in pids:
            _kill_pid(pid, self._log)

    def _kill_current(self, reason: str = "") -> None:
        # Grab the process reference and clear self.process atomically under
        # the lock, then do the actual kill OUTSIDE the lock so we never block
        # other threads from seeing self.process = None.
        with self._lock:
            proc = self.process
            self.process = None
        _kill_proc(proc, self._log, reason)

    def _start_process(self, cmd: list) -> Optional[subprocess.Popen]:
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                creationflags=_CREATION_FLAGS,
            )
            # Track every PID we spawn so stop() can do a final sweep
            with self._lock:
                self._spawned_pids.add(proc.pid)
            # Drain stderr in a daemon thread so the pipe never blocks
            threading.Thread(
                target=self._drain_stderr, args=(proc.stderr,), daemon=True
            ).start()
            return proc
        except FileNotFoundError:
            self._log("ERROR: FFmpeg executable not found. Check the FFmpeg path in Settings.")
            return None
        except Exception as exc:
            self._log(f"ERROR starting FFmpeg: {exc}")
            return None

    def _drain_stderr(self, pipe) -> None:
        try:
            for line in pipe:
                line = line.strip()
                if not line:
                    continue
                lower = line.lower()
                if any(k in lower for k in ("error", "warning", "frame=", "fps=", "bitrate=")):
                    self._log(f"ffmpeg: {line[:140]}")
        except Exception:
            pass

    # ── Internals — command builders ─────────────────────────────────────────

    def _rtmp_target(self) -> str:
        url = self.settings.get("rtmp_url", "").rstrip("/")
        key = self.settings.get("stream_key", "").strip()
        return f"{url}/{key}" if key else url

    def _common_encode_args(self) -> list:
        vbr    = self.settings.get("video_bitrate", "4500k")
        abr    = self.settings.get("audio_bitrate", "160k")
        fps    = self.settings.get("fps", "30")
        enc    = self.settings.get("encoder", "libx264")
        preset = self.settings.get("preset", "veryfast")
        buf    = f"{int(vbr.rstrip('k')) * 2}k"
        gop    = str(int(float(fps) * 2))
        return [
            "-c:v", enc, "-preset", preset, "-tune", "zerolatency",
            "-b:v", vbr, "-maxrate", vbr, "-bufsize", buf,
            "-g", gop,
            "-c:a", "aac", "-b:a", abr, "-ar", "44100", "-ac", "2",
            "-f", "flv",
        ]

    def _build_filler_cmd(self) -> list:
        ffmpeg = self.settings.get("ffmpeg_path", "ffmpeg")
        res    = self.settings.get("resolution", "1280x720")
        fps    = self.settings.get("fps", "30")
        ftype  = self.settings.get("filler_type", "black")
        fcolor = self.settings.get("filler_color", "000000")

        if ftype == "test":
            vsrc = f"testsrc=size={res}:rate={fps}"
        elif ftype == "color":
            vsrc = f"color=c=#{fcolor}:size={res}:rate={fps}"
        else:
            vsrc = f"color=c=black:size={res}:rate={fps}"

        return [
            ffmpeg, "-re",
            "-f", "lavfi", "-i", vsrc,
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
            "-map", "0:v", "-map", "1:a",
            *self._common_encode_args(),
            self._rtmp_target(),
        ]

    def _probe_has_audio(self, filepath: str) -> bool:
        ffprobe = self.settings.get("ffprobe_path", "ffprobe")
        try:
            r = subprocess.run(
                [ffprobe, "-v", "quiet", "-select_streams", "a:0",
                 "-show_entries", "stream=codec_type",
                 "-of", "compact=p=0:nk=1", filepath],
                capture_output=True, text=True, timeout=10,
                creationflags=_CREATION_FLAGS,
            )
            return "audio" in r.stdout
        except Exception:
            return True  # assume audio exists if probe fails

    def _build_video_cmd(self, filepath: str, schedule_item_id: Optional[int] = None, max_duration: Optional[float] = None) -> list:
        ffmpeg = self.settings.get("ffmpeg_path", "ffmpeg")
        res    = self.settings.get("resolution", "1280x720")
        fps    = self.settings.get("fps", "30")
        w, h   = res.split("x")

        # Optional duration limit (e.g. for scheduled auto_bumper slots)
        dur_args = ["-t", str(max_duration)] if max_duration else []

        # Letterbox / pillar-box scale — preserves aspect ratio
        scale_filter = (
            f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"setsar=1,fps=fps={fps}"
        )

        overlays = self._get_overlay_graphics(schedule_item_id)
        has_audio = self._probe_has_audio(filepath)

        base_cmd = [ffmpeg, "-re", *dur_args, "-i", filepath]

        if overlays:
            # Add each overlay PNG as an additional input
            for ov in overlays:
                base_cmd += ["-i", ov["filepath"]]
            if not has_audio:
                base_cmd += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]
                anull_idx = len(overlays) + 1

            # Build filter_complex:
            #   [0:v] -> scale/pad -> [base]
            #   [N:v] -> scale to output res -> [olN]
            #   [base][ol1]overlay...[v1]  ->  [v1][ol2]overlay...[v2]  etc.
            parts = [f"[0:v]{scale_filter}[base]"]
            prev = "base"
            for idx, ov in enumerate(overlays):
                in_idx = idx + 1
                t1 = ov["trigger_offset"]
                t2 = t1 + ov["duration"] if ov["duration"] > 0 else None
                out = f"v{idx + 1}"
                parts.append(
                    f"[{in_idx}:v]scale={w}:{h}:flags=lanczos,"
                    f"format=rgba[ol{in_idx}]"
                )
                if t2 is not None:
                    enable = f":enable='between(t,{t1},{t2})'"
                elif t1 > 0:
                    enable = f":enable='gte(t,{t1})'"
                else:
                    enable = ""
                parts.append(f"[{prev}][ol{in_idx}]overlay=0:0{enable}[{out}]")
                prev = out

            fc = ";".join(parts)
            audio_map = "0:a" if has_audio else f"{anull_idx}:a"
            return [
                *base_cmd,
                "-filter_complex", fc,
                "-map", f"[{prev}]", "-map", audio_map,
                *self._common_encode_args(),
                self._rtmp_target(),
            ]

        # No overlays — simple -vf path
        vf = scale_filter
        if has_audio:
            return [
                *base_cmd,
                "-vf", vf,
                "-map", "0:v", "-map", "0:a",
                *self._common_encode_args(),
                self._rtmp_target(),
            ]
        else:
            # No audio stream — supply silent audio from lavfi
            return [
                *base_cmd,
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                "-vf", vf,
                "-map", "0:v", "-map", "1:a",
                *self._common_encode_args(),
                self._rtmp_target(),
            ]

    def _get_overlay_graphics(self, schedule_item_id: Optional[int]) -> list:
        """Return enabled PNG overlay records applicable to this video."""
        from app.database import SessionLocal, LowerThird
        db = SessionLocal()
        try:
            result = []
            for lt in db.query(LowerThird).filter(LowerThird.enabled == True).all():  # noqa: E712
                if not lt.filepath or not os.path.exists(lt.filepath):
                    continue
                # Global (no schedule_item_id) always applies;
                # per-slot only applies to its matching slot.
                if lt.schedule_item_id is None or lt.schedule_item_id == schedule_item_id:
                    result.append({
                        "filepath": lt.filepath,
                        "trigger_offset": lt.trigger_offset or 0,
                        "duration": lt.duration or 0,
                    })
            return result
        except Exception as exc:
            self._log(f"Overlay fetch error: {exc}")
            return []
        finally:
            db.close()

    def _get_bumper_for_target(self, target: dict) -> Optional[dict]:
        """Return a bumper dict to play before target, or None."""
        if target.get("type") != "video":
            return None
        from app.database import SessionLocal, BumperFile, ScheduledItem
        from app import bumper_renderer

        # 1. Per-item pre-bumper (manual) — always checked first
        sid = target.get("schedule_item_id")
        if sid:
            db = SessionLocal()
            try:
                item = db.query(ScheduledItem).filter(ScheduledItem.id == sid).first()
                if item and item.bumper_pre_id:
                    b = db.query(BumperFile).filter(
                        BumperFile.id == item.bumper_pre_id,
                        BumperFile.enabled == True,  # noqa: E712
                    ).first()
                    if b and os.path.exists(b.filepath):
                        return {"type": "bumper", "title": b.title or b.filename,
                                "filepath": b.filepath}
            except Exception as exc:
                self._log(f"Per-item bumper fetch error: {exc}")
            finally:
                db.close()

        # 2. Auto schedule bumper
        if self.settings.get("auto_bumper_enabled", "false").lower() == "true":
            auto_path = bumper_renderer.AUTO_BUMPER_PATH
            if os.path.exists(auto_path):
                return {"type": "bumper", "title": "Coming Up", "filepath": auto_path}

        # 3. Global manual bumper (round-robin) — only if bumper_enabled=true
        if self.settings.get("bumper_enabled", "false").lower() != "true":
            return None
        if self.settings.get("bumper_between_items", "true").lower() != "true":
            return None
        db = SessionLocal()
        try:
            bumpers = (
                db.query(BumperFile)
                .filter(BumperFile.enabled == True)  # noqa: E712
                .order_by(BumperFile.id)
                .all()
            )
            # Skip the auto-generated file if it ends up in the DB somehow
            bumpers = [b for b in bumpers if not b.filename.startswith("_auto_")]
            if bumpers:
                b = bumpers[self._bumper_round % len(bumpers)]
                if os.path.exists(b.filepath):
                    self._bumper_round += 1
                    return {"type": "bumper", "title": b.title or b.filename,
                            "filepath": b.filepath}
        except Exception as exc:
            self._log(f"Global bumper fetch error: {exc}")
        finally:
            db.close()
        return None

    # ── Internals — schedule logic ────────────────────────────────────────────

    def _get_scheduled_item(self) -> Optional[dict]:
        """Return the highest-priority schedule entry that should be playing right now."""
        from app.database import SessionLocal, ScheduledItem, VideoFile, BumperFile  # local import avoids circular
        from app import bumper_renderer

        now         = datetime.now()
        now_time    = now.strftime("%H:%M")
        now_weekday = now.weekday()   # 0 = Monday
        now_date    = now.strftime("%Y-%m-%d")

        db = SessionLocal()
        try:
            items = (
                db.query(ScheduledItem)
                .filter(ScheduledItem.enabled == True)  # noqa: E712
                .order_by(ScheduledItem.priority.desc())
                .all()
            )
            for item in items:
                slot_type = getattr(item, "slot_type", None) or "video"

                if slot_type == "video":
                    video = db.query(VideoFile).filter(VideoFile.id == item.video_id).first() if item.video_id else None
                    if not video or not os.path.exists(video.filepath):
                        continue
                    duration = video.duration or 0
                    hit_extra = {"video": video}

                elif slot_type == "bumper":
                    bid = getattr(item, "bumper_id", None)
                    bumper = db.query(BumperFile).filter(BumperFile.id == bid).first() if bid else None
                    if not bumper or not os.path.exists(bumper.filepath):
                        continue
                    duration = bumper.duration or 0
                    hit_extra = {"bumper": bumper}

                elif slot_type == "auto_bumper":
                    if not os.path.exists(bumper_renderer.AUTO_BUMPER_PATH):
                        continue
                    duration = getattr(item, "slot_duration", None) or 30
                    hit_extra = {}

                else:
                    continue

                end_time = _add_minutes_to_hhmm(item.start_time, duration / 60)
                if not _time_in_window(now_time, item.start_time, end_time):
                    continue

                match = False
                if item.recurrence == "once" and item.date == now_date:
                    match = True
                elif item.recurrence == "daily":
                    match = True
                elif item.recurrence == "weekly":
                    days = [
                        int(d.strip())
                        for d in (item.days_of_week or "").split(",")
                        if d.strip().isdigit()
                    ]
                    if now_weekday in days:
                        match = True

                if match:
                    return {"item": item, "slot_type": slot_type, **hit_extra}

            return None
        except Exception as exc:
            self._log(f"Schedule check error: {exc}")
            return None
        finally:
            db.close()

    def _determine_playback(self) -> dict:
        """Return a dict describing what SHOULD be playing right now."""
        # 1. Manual override takes highest priority
        if self.override_video_id is not None:
            from app.database import SessionLocal, VideoFile
            db = SessionLocal()
            try:
                video = db.query(VideoFile).filter(VideoFile.id == self.override_video_id).first()
                if video and os.path.exists(video.filepath):
                    return {
                        "type": "video",
                        "video_id": video.id,
                        "title": video.title or video.filename,
                        "filename": video.filename,
                        "filepath": video.filepath,
                        "override": True,
                    }
            finally:
                db.close()
            self.override_video_id = None   # video gone — clear override

        # 2. Scheduled item
        hit = self._get_scheduled_item()
        if hit:
            item      = hit["item"]
            slot_type = hit.get("slot_type", "video")

            if slot_type == "video":
                video = hit["video"]
                return {
                    "type": "video",
                    "video_id": video.id,
                    "schedule_item_id": item.id,
                    "title": item.title or video.title or video.filename,
                    "filename": video.filename,
                    "filepath": video.filepath,
                    "override": False,
                }

            elif slot_type == "bumper":
                bumper = hit["bumper"]
                return {
                    "type": "bumper",
                    "video_id": None,
                    "schedule_item_id": item.id,
                    "title": item.title or bumper.title or bumper.filename,
                    "filepath": bumper.filepath,
                    "override": False,
                }

            elif slot_type == "auto_bumper":
                from app import bumper_renderer
                slot_dur = getattr(item, "slot_duration", None) or 30
                return {
                    "type": "bumper",
                    "video_id": None,
                    "schedule_item_id": item.id,
                    "title": item.title or "Auto Schedule Bumper",
                    "filepath": bumper_renderer.AUTO_BUMPER_PATH,
                    "slot_duration": slot_dur,
                    "override": False,
                }

        # 3. Filler
        return {"type": "filler", "title": "Standby / Filler"}

    def _needs_switch(self, target: dict) -> bool:
        if self.current_item is None:
            return True
        if target["type"] != self.current_item.get("type"):
            return True
        if target["type"] == "video":
            return target.get("video_id") != self.current_item.get("video_id")
        if target["type"] == "bumper":
            # Distinguish by schedule_item_id (scheduled bumper) or filepath (pre-roll bumper)
            return (target.get("schedule_item_id") != self.current_item.get("schedule_item_id")
                    or target.get("filepath") != self.current_item.get("filepath"))
        return False  # both filler

    def _apply_playback(self, target: dict) -> None:
        if target["type"] in ("video", "bumper"):
            sid = target.get("schedule_item_id") if target["type"] == "video" else None
            max_dur = target.get("slot_duration")  # only set on auto_bumper scheduled slots
            cmd = self._build_video_cmd(target["filepath"], sid, max_duration=max_dur)
            self._log(f"▶  Playing: {target['title']}")
        else:
            cmd = self._build_filler_cmd()
            self._log("⏸  Playing filler / standby")

        proc = self._start_process(cmd)

        # Check stop_event BEFORE storing the new process.  If stop() fired
        # while _start_process was running, kill the newly-spawned process
        # immediately instead of leaking it.
        if self._stop_event.is_set():
            _kill_proc(proc, self._log, "stop fired during startup")
            return

        with self._lock:
            self.process = proc
        self.current_item = {**target, "started_at": datetime.now().isoformat()}

    # ── Main loop ─────────────────────────────────────────────────────────────

    def _stream_loop(self) -> None:
        self._log("Stream loop started")
        while not self._stop_event.is_set():
            try:
                proc_dead = (
                    self.process is not None and self.process.poll() is not None
                )

                if proc_dead:
                    if self._in_bumper:
                        # Bumper finished naturally – now play the pending target
                        self._in_bumper = False
                        target = self._pending_target
                        self._pending_target = None
                        with self._lock:
                            self.process = None
                        if target and not self._stop_event.is_set():
                            self._apply_playback(target)
                        self._switch_event.wait(timeout=5)
                        self._switch_event.clear()
                        continue
                    else:
                        if self.current_item and self.current_item.get("override"):
                            self.override_video_id = None
                        with self._lock:
                            self.process = None

                # While a bumper is still playing, don't touch the schedule
                if self._in_bumper:
                    self._switch_event.wait(timeout=5)
                    self._switch_event.clear()
                    continue

                target = self._determine_playback()

                if self._needs_switch(target) or self.process is None:
                    self._kill_current("switch")
                    if self._stop_event.is_set():
                        break
                    # Check whether to insert a bumper before the new content
                    bumper = self._get_bumper_for_target(target)
                    if bumper:
                        self._pending_target = target
                        self._in_bumper = True
                        self._apply_playback(bumper)
                    else:
                        self._apply_playback(target)

            except Exception as exc:
                self._log(f"Stream loop error: {exc}")

            self._switch_event.wait(timeout=5)
            self._switch_event.clear()

        self._log("Stream loop ended")


# ── Module-level helpers ──────────────────────────────────────────────────────

def _kill_pid(pid: int, log_fn) -> None:
    """Kill a process by PID (tree kill on Windows)."""
    try:
        if _IS_WINDOWS:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True, timeout=8,
            )
        else:
            import signal as _signal, os as _os
            try:
                _os.killpg(_os.getpgid(pid), _signal.SIGKILL)
            except ProcessLookupError:
                pass
    except Exception as exc:
        log_fn(f"_kill_pid({pid}) error: {exc}")


def _kill_proc(proc, log_fn, reason: str = "") -> None:
    """Terminate a Popen instance; uses tree-kill so no orphaned children."""
    if proc is None or proc.poll() is not None:
        return
    tag = f" ({reason})" if reason else ""
    log_fn(f"Killing FFmpeg pid={proc.pid}{tag}")
    _kill_pid(proc.pid, log_fn)
    try:
        proc.wait(timeout=6)
    except subprocess.TimeoutExpired:
        log_fn(f"FFmpeg pid={proc.pid} still alive after tree-kill; forcing")
        try:
            proc.kill()
            proc.wait(timeout=3)
        except Exception:
            pass
    except Exception:
        pass

def _add_minutes_to_hhmm(hhmm: str, minutes: float) -> str:
    h, m = map(int, hhmm.split(":"))
    total = h * 60 + m + int(minutes)
    return f"{(total // 60) % 24:02d}:{total % 60:02d}"


def _time_in_window(current: str, start: str, end: str) -> bool:
    """True if current HH:MM falls in [start, end). Handles midnight crossing."""
    if end == start:
        return False
    if end < start:   # crosses midnight
        return current >= start or current < end
    return start <= current < end


# Singleton used across the app
stream_manager = StreamManager()
