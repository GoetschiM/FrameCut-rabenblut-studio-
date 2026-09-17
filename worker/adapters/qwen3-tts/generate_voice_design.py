"""Generate one designed Qwen3-TTS voice line via its documented Gradio API."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.parse import urljoin

import requests


def wait_for_result(base_url: str, endpoint: str, event_id: str) -> list[object]:
    response = requests.get(
        f"{base_url.rstrip('/')}/gradio_api/call/{endpoint}/{event_id}",
        stream=True,
        timeout=600,
    )
    response.raise_for_status()
    event = None
    for raw_line in response.iter_lines(decode_unicode=True):
        if not raw_line:
            continue
        if raw_line.startswith("event:"):
            event = raw_line.split(":", 1)[1].strip()
            continue
        if raw_line.startswith("data:"):
            payload = json.loads(raw_line.split(":", 1)[1].strip())
            if event == "complete":
                return payload
            if event == "error":
                raise RuntimeError(str(payload))
    raise RuntimeError("Gradio returned no completed result")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--description", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--language", default="German")
    parser.add_argument("--seed", type=int, default=-1)
    args = parser.parse_args()

    endpoint = "generate_voice_design"
    base_url = args.base_url.rstrip("/")
    request = requests.post(
        f"{base_url}/gradio_api/call/{endpoint}",
        json={"data": [args.text, args.language, args.description, args.seed]},
        timeout=30,
    )
    request.raise_for_status()
    event_id = request.json()["event_id"]
    data = wait_for_result(base_url, endpoint, event_id)
    audio, status = data[0], data[1]
    if not isinstance(audio, dict) or not audio.get("url"):
        raise RuntimeError(f"No audio returned: {data}")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    download = requests.get(urljoin(base_url + "/", str(audio["url"])), timeout=120)
    download.raise_for_status()
    output.write_bytes(download.content)
    print(json.dumps({"output": str(output), "status": status, "server_audio": audio.get("url")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
