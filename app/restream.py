"""RestreamManager — one-shot FFmpeg re-stream.

Plays a single video file to an RTMP target exactly once.
No bumpers, no overlays, no looping — the process exits naturally when the
video finishes (or the user stops it early).
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
_CREATION_FLAGS = 0
if _IS_WINDOWS:
    _CREATION_FLAGS = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP


def _kill_pid(pid: int) -> None:
    """Force-kill a process (tree) by PID."""
    try:
        if _IS_WINDOWS:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True, timeout=8,
            )
        else:
            import signal as _signal
            import os as _os
            try:
                _os.killpg(_os.getpgid(pid), _signal.SIGKILL)
            except ProcessLookupError:
                pass
    except Exception:
        pass


class RestreamManager:
    def __init__(self) -> None:
        self.process: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self.running: bool = False
        self._thread: Optional[threading.Thread] = None
        self.started_at: Optional[str] = None
        self.filepath: Optional[str] = None
        self.video_title: Optional[str] = None
        self.log_buffer: deque = deque(maxlen=300)

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self, filepath: str, title: str, settings: dict) -> dict:
        with self._lock:
            if self.running:
                return {"status": "already_running"}
            if not os.path.exists(filepath):
                return {"status": "error", "detail": "File not found"}
            self.running = True
            self.filepath = filepath
            self.video_title = title
            self.started_at = datetime.now().isoformat()
            self.log_buffer.clear()
        self._log(f"Re-stream starting: {title}")
        t = threading.Thread(
            target=self._run, args=(filepath, settings),
            daemon=True, name="RestreamThread",
        )
        self._thread = t
        t.start()
        return {"status": "started"}

    def stop(self) -> dict:
        proc = None
        was_running = False
        with self._lock:
            was_running = self.running
            if self.running:
                proc = self.process
                self.running = False
                self.started_at = None
        if was_running:
            if proc and proc.poll() is None:
                _kill_pid(proc.pid)
            self._log("Re-stream stopped by user")
            return {"status": "stopped"}
        return {"status": "not_running"}

    def get_status(self) -> dict:
        with self._lock:
            proc_alive = self.process is not None and self.process.poll() is None
            return {
                "running": self.running,
                "process_alive": proc_alive,
                "started_at": self.started_at,
                "filepath": self.filepath,
                "video_title": self.video_title,
                "logs": list(self.log_buffer),
            }

    # ── Private ───────────────────────────────────────────────────────────────

    def _run(self, filepath: str, settings: dict) -> None:
        cmd = self._build_cmd(filepath, settings)
        self._log("FFmpeg: " + " ".join(str(c) for c in cmd))
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                creationflags=_CREATION_FLAGS,
            )
            with self._lock:
                self.process = proc
            for line in proc.stderr:
                line = line.strip()
                if not line:
                    continue
                lower = line.lower()
                if any(k in lower for k in ("error", "warning", "frame=", "fps=", "bitrate=")):
                    self._log(line[:160])
            proc.wait()
            self._log(f"FFmpeg exited (code {proc.returncode})")
        except FileNotFoundError:
            self._log("ERROR: FFmpeg executable not found — check the FFmpeg path in Settings.")
        except Exception as exc:
            self._log(f"Re-stream error: {exc}")
        finally:
            with self._lock:
                self.running = False
                self.process = None
                self.started_at = None
            self._log("Re-stream finished")

    def _build_cmd(self, filepath: str, s: dict) -> list:
        ffmpeg   = s.get("ffmpeg_path", "ffmpeg")
        ffprobe  = s.get("ffprobe_path", "ffprobe")
        res      = s.get("resolution", "1280x720")
        fps      = s.get("fps", "30")
        vbr      = s.get("video_bitrate", "4500k")
        abr      = s.get("audio_bitrate", "160k")
        enc      = s.get("encoder", "libx264")
        preset   = s.get("preset", "veryfast")
        rtmp_url = s.get("rtmp_url", "").rstrip("/")
        key      = s.get("stream_key", "").strip()
        target   = f"{rtmp_url}/{key}" if key else rtmp_url

        w, h = res.split("x")
        buf  = f"{int(vbr.rstrip('k')) * 2}k"
        try:
            gop = str(int(float(fps) * 2))
        except ValueError:
            gop = "60"

        scale_filter = (
            f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"setsar=1,fps=fps={fps}"
        )

        has_audio = self._probe_has_audio(ffprobe, filepath)

        encode_args = [
            "-c:v", enc, "-preset", preset, "-tune", "zerolatency",
            "-b:v", vbr, "-maxrate", vbr, "-bufsize", buf,
            "-g", gop,
            "-c:a", "aac", "-b:a", abr, "-ar", "44100", "-ac", "2",
            "-f", "flv", target,
        ]

        if has_audio:
            return [
                ffmpeg, "-re", "-i", filepath,
                "-vf", scale_filter,
                "-map", "0:v", "-map", "0:a",
                *encode_args,
            ]
        else:
            return [
                ffmpeg, "-re", "-i", filepath,
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                "-vf", scale_filter,
                "-map", "0:v", "-map", "1:a",
                *encode_args,
            ]

    def _probe_has_audio(self, ffprobe: str, filepath: str) -> bool:
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
            return True  # assume audio present if probe fails

    def _log(self, msg: str) -> None:
        self.log_buffer.append(msg)
        logger.info("[Restream] %s", msg)


# Singleton
restream_manager = RestreamManager()
