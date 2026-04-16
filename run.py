"""
EC-Streamer — entry point.
Run with:  python run.py
"""
import os
import sys

# Ensure required directories exist before FastAPI tries to mount them
for _d in ["videos", "static/js", "static/css", "templates", "app"]:
    os.makedirs(_d, exist_ok=True)

try:
    import uvicorn
except ImportError:
    print("ERROR: uvicorn not found.\nInstall dependencies first:\n  pip install -r requirements.txt")
    sys.exit(1)

if __name__ == "__main__":
    print("=" * 50)
    print("  EC-Streamer")
    print("  Web UI → http://localhost:8087")
    print("=" * 50)
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8087,
        reload=False,
        log_level="info",
    )
