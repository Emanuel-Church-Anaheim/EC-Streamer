# EC-Streamer

A 24/7 RTMP video streamer with a full Web UI. Stream constantly to any RTMP endpoint (YouTube Live, Twitch, custom server) with automatic scheduling, a video library, and real-time monitoring.

## Features

- **Constant RTMP stream** — never goes offline; falls back to a configurable filler screen (black, solid colour, or test pattern) when nothing is scheduled
- **Video library** — upload local video files (MP4, MKV, AVI, MOV, TS, …) via drag-and-drop
- **Scheduler** — schedule videos to play at specific times with one-time, daily, or weekly recurrence
- **Play Now override** — force any video to play immediately from the library
- **Web UI** — Dashboard, Library, Schedule, and Settings tabs; real-time status and log viewer
- **Configurable quality** — resolution, FPS, video/audio bitrate, encoder (CPU / NVENC / AMF / QSV), preset

## Requirements

- Python 3.10+
- [FFmpeg](https://ffmpeg.org/download.html) with `ffmpeg` and `ffprobe` accessible (add to PATH or set paths in Settings)

## Quick Start

```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Start the server
python run.py

# 3. Open the Web UI
#    http://localhost:8080
```

## Usage

1. **Settings** → enter your RTMP URL and stream key, adjust quality, save
2. **Library** → upload your video files
3. **Schedule** → add schedule items (time + recurrence + video)
4. **Dashboard** → click **Start Stream** — the stream begins broadcasting filler until a scheduled slot begins

### RTMP URL format

| Platform | RTMP URL | Stream Key field |
|---|---|---|
| Twitch | `rtmp://live.twitch.tv/live` | Your stream key |
| YouTube Live | `rtmp://a.rtmp.youtube.com/live2` | Your stream key |
| Custom nginx-rtmp | `rtmp://your-server/live` | Stream name |

## Project Structure

```
EC-Streamer/
├── app/
│   ├── main.py        # FastAPI routes
│   ├── streamer.py    # FFmpeg process manager
│   └── database.py    # SQLite models (SQLAlchemy)
├── templates/
│   └── index.html     # Single-page Web UI
├── static/
│   ├── js/app.js      # Frontend JavaScript
│   └── css/style.css  # Custom styles
├── videos/            # Uploaded video files (auto-created)
├── run.py             # Entry point
└── requirements.txt
```

## Notes

- The database (`ec_streamer.db`) is created automatically on first run
- When switching between videos there is a brief reconnect (~1 s); this is normal with direct RTMP output. For zero-gap switching, place an nginx-rtmp relay in front and stream to it
- GPU encoders (`h264_nvenc`, `h264_amf`, `h264_qsv`) require the appropriate FFmpeg build and driver