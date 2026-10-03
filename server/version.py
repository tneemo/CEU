"""Application version read from the Tauri manifest.

The Tauri manifest is the single version source for the desktop application.  The
server reads it at runtime so integrations do not need a second hard-coded version.
"""
import json
from pathlib import Path


_MANIFEST = Path(__file__).resolve().parents[1] / "web-app" / "src-tauri" / "tauri.conf.json"


def current() -> str:
    try:
        with _MANIFEST.open(encoding="utf-8") as f:
            return str(json.load(f)["version"])
    except (OSError, KeyError, TypeError, ValueError):
        return "0.0.0"


VERSION = current()
