# EC-Streamer

A 24/7 RTMP video streamer with a full Web UI. Stream constantly to any RTMP endpoint (YouTube Live, Twitch, custom server) with automatic scheduling, a video library, and real-time monitoring.

## Features

- **Constant RTMP stream** — never goes offline; falls back to a configurable filler screen (black, solid colour, test pattern, or looped auto-bumper) when nothing is scheduled
- **Video library** — upload local video files (MP4, MKV, AVI, MOV, TS, …) or add external folder libraries with auto-scan
- **Scheduler** — schedule videos to play at specific times with one-time, daily, or weekly recurrence; drag-and-drop timeline view with zoom (1×/2×/4×/8×), element snapping, and configurable time-snap increment
- **Bumpers** — insert short bumper clips before videos (per-slot, round-robin, or auto-generated animated schedule bumper)
- **Overlays / Lower Thirds** — composite PNG graphics on top of the stream with per-item timing
- **Re-Stream** — one-shot stream of a single video to any RTMP target; streams end automatically when the video finishes; includes progress bar and per-session RTMP settings
- **Play Now override** — force any video to play immediately from the library
- **Web UI** — Dashboard, Library, Schedule, Bumpers, Overlays, Re-Stream, and Settings tabs; real-time status, log viewer, and stream preview thumbnail
- **Configurable quality** — resolution, FPS, video/audio bitrate, encoder (CPU / NVENC / AMF / QSV), preset
- **Title enrichment** — match uploaded videos against a local sermon catalogue (`yt_video_sermons.json`) to auto-fill descriptive titles

## Requirements

- Python 3.10+
- [FFmpeg](https://ffmpeg.org/download.html) with `ffmpeg` and `ffprobe` accessible (add to PATH or set paths in Settings)
- *(Optional)* [Playwright](https://playwright.dev/python/) + Chromium for the animated auto-schedule bumper renderer

## Quick Start

```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. (Optional) Install Playwright for auto-bumper rendering
pip install playwright && playwright install chromium

# 3. Start the server
python run.py

# 4. Open the Web UI
#    http://localhost:8087
```

## Docker / Portainer Deployment

EC-Streamer can run as a self-contained Docker service with FFmpeg, Playwright, and Chromium included, plus persistent volumes for the SQLite database and uploaded media. The default Compose file pulls the prebuilt private image from GitHub Container Registry instead of building on the Portainer host.

```bash
docker compose up -d
```

The container listens on port **8087**:

```text
http://SERVER_IP:8087
```

The included `docker-compose.yml` stores runtime data in Docker volumes:

| Volume | Container path | Purpose |
|---|---|---|
| `ec_streamer_data` | `/data` | SQLite database |
| `ec_streamer_videos` | `/app/videos` | Uploaded videos |
| `ec_streamer_bumpers` | `/app/bumpers` | Uploaded bumper clips |
| `ec_streamer_overlays` | `/app/overlays` | Uploaded overlay PNGs |

### Portainer

For a private GitHub repo and private GHCR image, deploy as a Git-backed Portainer stack:

1. In Portainer, add a registry for `ghcr.io` using a GitHub token with `read:packages` access.
2. Go to **Stacks** -> **Add stack**.
3. Choose **Repository**.
4. Use this repo URL and branch `main`.
5. Set the compose path to `docker-compose.yml`.
6. Add GitHub credentials or a fine-scoped token that can read this private repo.
7. Deploy the stack.

This avoids building the image inside Portainer. GitHub Actions builds and publishes the image after changes are merged to `main`, and Portainer only pulls the finished image.

The app also works behind Nginx Proxy Manager when proxied to `http://ec-streamer:8087` or `http://SERVER_IP:8087`. It remains fully functional when accessed directly by IP on the internal network.

Do not expose this app directly to the public internet without adding authentication or placing it behind a secured VPN/proxy, because it controls RTMP streaming settings.

## Usage

1. **Settings** → enter your RTMP URL and stream key, adjust quality, save
2. **Library** → upload your video files or add a folder library
3. **Schedule** → add schedule items (time + recurrence + video); use the timeline view to visualise and drag items
4. **Dashboard** → click **Start Stream** — the stream begins broadcasting filler until a scheduled slot begins
5. **Re-Stream** → for one-off streams (e.g. re-broadcasting a failed livestream): pick a video from the library or upload one, configure RTMP settings, and click **Start Re-Stream**; the stream stops automatically when the video ends

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
│   ├── main.py            # FastAPI routes
│   ├── streamer.py        # 24/7 FFmpeg process manager
│   ├── restream.py        # One-shot re-stream manager
│   ├── bumper_renderer.py # Playwright-based auto-bumper renderer
│   └── database.py        # SQLite models (SQLAlchemy)
├── templates/
│   ├── index.html         # Single-page Web UI
│   └── bumper.html        # Auto-schedule bumper preview page
├── static/
│   ├── js/app.js          # Frontend JavaScript (vanilla IIFE)
│   ├── css/style.css      # Custom styles
│   └── favicon.svg
├── videos/                # Uploaded video files (auto-created)
├── bumpers/               # Uploaded bumper clips (auto-created)
├── overlays/              # Uploaded overlay PNGs (auto-created)
├── yt_video_sermons.json  # Local sermon catalogue for title enrichment
├── run.py                 # Entry point (uvicorn, port 8087)
└── requirements.txt
```

## Notes

- The database (`ec_streamer.db`) is created automatically on first run
- The server runs on port **8087** by default (set in `run.py`)
- When switching between videos there is a brief reconnect (~1 s); this is normal with direct RTMP output. For zero-gap switching, place an nginx-rtmp relay in front and stream to it
- GPU encoders (`h264_nvenc`, `h264_amf`, `h264_qsv`) require the appropriate FFmpeg build and driver
- The auto-schedule bumper (`bumpers/auto_bumper.mp4`) is generated by Playwright rendering `bumper.html`; if Playwright is not installed the bumper feature is disabled but everything else works normally
