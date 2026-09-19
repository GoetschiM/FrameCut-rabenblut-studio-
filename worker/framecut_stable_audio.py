"""Request one music, ambience or SFX cue through Stable Audio's public Gradio API.

The Pinokio launcher owns Stable Audio's lifecycle. This small client deliberately talks
only to its documented ``/generate`` API; it does not import Stable Audio internals or
load model weights itself. The worker supplies an already-running local URL and a tiny
JSON spec, then normalizes the resulting file with ffmpeg before upload.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from gradio_client import Client, handle_file


def generated_file(value: object) -> Path:
    """Accommodate the FileData shapes returned by Gradio 4 and 5 clients."""
    if isinstance(value, str):
        return Path(value)
    if isinstance(value, dict):
        for key in ("path", "name"):
            if value.get(key):
                return Path(str(value[key]))
    raise RuntimeError(f"Stable Audio returned no downloadable file: {value!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--spec", required=True)
    args = parser.parse_args()

    # Windows PowerShell writes UTF-8 with a BOM by default.  Accept both that
    # form and plain UTF-8 so a perfectly valid cue never fails before Stable
    # Audio even receives the prompt.
    spec = json.loads(Path(args.spec).read_text(encoding="utf-8-sig"))
    prompt = str(spec.get("prompt") or "").strip()
    duration = max(1, min(120, int(spec.get("duration_seconds") or 1)))
    output = Path(str(spec.get("output") or "")).resolve()
    if not prompt:
        raise RuntimeError("Stable Audio needs a non-empty prompt.")

    client = Client(args.base_url)
    # Stable Audio 3's launcher exposes this documented /generate endpoint. Values map
    # to its public UI controls: RF-friendly defaults, WAV output and exact duration.
    result = client.predict(
        prompt, "", duration, 1.0, 8, 0, -1, "pingpong", 1.0,
        0.0, 1.0, 0.0, 0.0, 1.0, "wav", "output.wav", True,
        None, 1.0, "", "", None, "Init audio", 100, 0.3, False,
        0.0, 1, None,
        api_name="/generate",
    )
    source = generated_file(result[0] if isinstance(result, (list, tuple)) else result)
    if not source.is_file():
        # Some Gradio versions return a URL-shaped FileData instead of downloading it.
        source = Path(handle_file(str(source)))
    if not source.is_file():
        raise RuntimeError(f"Stable Audio output is unavailable: {source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, output)
    print(json.dumps({"ok": True, "output": str(output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
