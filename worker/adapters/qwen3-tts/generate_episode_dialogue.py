"""Render the approved RABENBLUT Episode 01 dialogue as individually editable WAV files."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("voice_design", HERE / "generate_voice_design.py")
voice_design = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(voice_design)

ROLE_SETTINGS = {
    "erzaehler": {
        "seed": 41001,
        "description": "German-speaking male narrator, deep warm baritone, calm and intimate, gravelly but perfectly intelligible, restrained noir atmosphere, close microphone, no music, no dramatic exaggeration.",
    },
    "baron": {
        "seed": 42001,
        "description": "German-speaking male hero in his late thirties, deep controlled voice, calm resolve, slightly rough from rain and battle, cinematic noir delivery, perfectly intelligible, close microphone, no music, no shouting.",
    },
    "michel": {
        "seed": 43001,
        "description": "German-speaking male villain, low and precise voice, cold intelligent restraint, faint dry menace, slow measured diction, perfectly intelligible, intimate close microphone, no music, never shouting or cartoonish.",
    },
}

CUES = [
    ("01", "erzaehler", 6.0, 14.0, "In dieser Stadt stirbt nichts leise."),
    ("02", "erzaehler", 31.0, 39.0, "Der Regen trägt Namen. Heute trägt er seinen."),
    ("03", "baron", 49.0, 54.0, "Michel."),
    ("04", "michel", 88.0, 98.0, "Du kommst immer, wenn die Glocken schweigen."),
    ("05", "baron", 104.0, 111.0, "Dann lass sie wieder läuten."),
    ("06", "michel", 131.0, 138.0, "Du rettest keine Stadt. Du fütterst nur ihre nächste Nacht."),
    ("07", "erzaehler", 151.0, 158.0, "Ein Schlag. Ein Fehler. Und Eisen erinnerte sich an Blut."),
    ("08", "michel", 187.0, 194.0, "Sieh dich an, Baron. Selbst die Ketten kennen deinen Namen."),
    ("09", "baron", 210.0, 218.0, "Dann sollen sie ihn loslassen."),
    ("10", "erzaehler", 241.0, 247.0, "Das Herz war kein Schutz. Es war ein Takt."),
    ("11", "baron", 272.0, 278.0, "Jetzt."),
    ("12", "michel", 285.0, 292.0, "Nein."),
    ("13", "baron", 296.0, 303.0, "Für die, die noch nicht gefallen sind."),
    ("14", "erzaehler", 319.0, 327.0, "Als das Herz verstummte, hielt die Stadt den Atem an."),
    ("15", "michel", 338.0, 345.0, "Der letzte Puls gehört mir."),
    ("16", "erzaehler", 348.0, 357.0, "Und über den Dächern wartete der Regen auf die nächste Nacht."),
]


def generate(base_url: str, text: str, description: str, seed: int, output: Path) -> str:
    import requests

    endpoint = "generate_voice_design"
    request = requests.post(
        f"{base_url.rstrip('/')}/gradio_api/call/{endpoint}",
        json={"data": [text, "German", description, seed]}, timeout=30,
    )
    request.raise_for_status()
    data = voice_design.wait_for_result(base_url, endpoint, request.json()["event_id"])
    audio, status = data[0], data[1]
    if not isinstance(audio, dict) or not audio.get("url"):
        raise RuntimeError(f"No audio returned: {data}")
    output.parent.mkdir(parents=True, exist_ok=True)
    download = requests.get(str(audio["url"]), timeout=120)
    download.raise_for_status()
    output.write_bytes(download.content)
    return str(status)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    rendered = []
    for number, role, start, end, text in CUES:
        output = output_dir / f"{number}_{role}.wav"
        setting = ROLE_SETTINGS[role]
        print(f"[{number}/16] {role}: {text}", flush=True)
        status = generate(args.base_url, text, setting["description"], setting["seed"], output)
        rendered.append({"number": number, "role": role, "start": start, "end": end, "text": text, "file": output.name, "status": status})
    (output_dir / "dialogue-cues.json").write_text(json.dumps(rendered, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Rendered {len(rendered)} lines to {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
