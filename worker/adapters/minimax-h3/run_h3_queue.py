"""Run a manifest of H3 shots serially, without duplicating existing ComfyUI jobs."""
import argparse
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(r"C:\Users\Miche\Documents\ChatGPT\Moto Poschung")
SHOT_CLIENT = ROOT / "pinokio_agent" / "skills" / "api" / "minimax-h3-pinokio.git" / "clients" / "render_shot.py"

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--base-url", default="http://localhost:8188")
    p.add_argument("--limit", type=int, default=0, help="Maximum newly submitted shots; 0 means all ready shots")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    manifest = json.loads(a.manifest.read_text(encoding="utf-8"))
    base = a.base_url.rstrip("/")
    output = ROOT / manifest.get("output_dir", "assets/ravenblood-comic/film-v2/shots")
    output.mkdir(parents=True, exist_ok=True)

    def api(route):
        with urllib.request.urlopen(base + route, timeout=30) as response:
            return json.load(response)

    try:
        api("/system_stats")
    except Exception as error:
        raise SystemExit("MiniMax H3 API nicht erreichbar: " + str(error))

    submitted = 0
    for shot in manifest["shots"]:
        if not shot.get("ready", False):
            print("SKIP (noch kein kontrolliertes Startbild): " + shot["name"], flush=True)
            continue
        name = shot["name"]
        mp4 = output / (name + ".mp4")
        state = output / (name + ".state.json")
        if mp4.exists():
            print("DONE: " + name, flush=True)
            continue
        if state.exists():
            saved = json.loads(state.read_text(encoding="utf-8"))
            print("STOP: Bestehender Zustand ohne MP4 bei " + name + " (Prompt " + str(saved.get("prompt_id")) + "). Nicht doppelt senden.", flush=True)
            return 2
        if a.limit and submitted >= a.limit:
            print("LIMIT erreicht", flush=True)
            return 0
        queue = api("/queue")
        if queue.get("queue_running") or queue.get("queue_pending"):
            print("STOP: ComfyUI-Queue ist nicht leer. Nicht eingreifen.", flush=True)
            return 3
        command = [sys.executable, str(SHOT_CLIENT), "--base-url", base,
                   "--image", str(ROOT / shot["image"]),
                   "--prompt-file", str(ROOT / shot["prompt_file"]),
                   "--output-dir", str(output), "--name", name,
                   "--frames", str(shot.get("frames", 124)), "--seed", str(shot["seed"])]
        for ref in shot.get("reference_images", []):
            command += ["--reference-image", str(ROOT / ref)]
        if shot.get("crop"):
            command += ["--crop"] + [str(n) for n in shot["crop"]]
        if shot.get("low_vram", False):
            command += ["--low-vram"]
        print(("PLAN: " if a.dry_run else "START: ") + name, flush=True)
        if not a.dry_run:
            result = subprocess.run(command, cwd=ROOT)
            if result.returncode:
                print("STOP: H3-Job fehlgeschlagen: " + name, flush=True)
                return result.returncode
        submitted += 1
    print("QUEUE-FERTIG", flush=True)

if __name__ == "__main__":
    main()
