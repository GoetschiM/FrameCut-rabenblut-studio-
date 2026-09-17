"""Render the German narration and subtitle manifest for Michel Tagebuch Episode 01."""

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

VOICE = (
    "German-speaking male narrator in his forties, warm calm baritone with a subtle Swiss warmth, "
    "natural documentary storytelling, intimate close microphone, perfectly intelligible standard German, "
    "measured pace, emotionally genuine but understated, no music, no sound effects, no shouting."
)

# Timings include the six-second opening title.
CUES = [
    ("01", 7.0, 18.0, "Es war der Sonntag vor den Ferien. Über Biberist lag eine klare Nacht, und der Vollmond begleitete mich nach Hause."),
    ("02", 22.0, 34.0, "Ich parkierte den Tesla in der Garage, sah noch kurz fern und fiel wenig später müde ins Bett."),
    ("03", 39.0, 52.0, "Am nächsten Morgen weckte mich die Sonne. Noch ein wenig Arbeit am Computer, dann begann der eigentliche Sonntag."),
    ("04", 57.0, 71.0, "Gegen elf fuhr ich von Biberist nach Solothurn, um meine Mutter Manuela abzuholen."),
    ("05", 76.0, 91.0, "Wir begrüssten uns, stiegen ein und machten uns gemeinsam auf den Weg zum Restaurant Florida in Studen."),
    ("06", 97.0, 112.0, "Dort wartete die Familie bereits. Ein warmer Empfang, viele bekannte Gesichter und sofort dieses Gefühl von Zuhause."),
    ("07", 116.0, 133.0, "Rolf und Doris waren da, Tricks mit Mike und Florian, Karin, Conny, meine Mutter – und natürlich Leo."),
    ("08", 137.0, 153.0, "Vor uns lag der See. Flamingos standen im Wasser, Fische zogen darunter vorbei, und die Sonne spiegelte sich auf den Wellen."),
    ("09", 157.0, 176.0, "Wir assen, redeten und lachten. Danach ging ich mit Leo auf den Spielplatz. Ich bin sein Götti – und darauf bin ich stolz."),
    ("10", 181.0, 198.0, "Leo tobte über Rutsche und Schaukel, während wir Erwachsenen zusahen. Für einen Moment war die Zeit ganz einfach still."),
    ("11", 202.0, 216.0, "Als der Abend kam, verabschiedeten wir uns. Der Tesla brachte meine Mutter und mich wieder zurück nach Solothurn."),
    ("12", 220.0, 234.0, "Ich setzte Manuela zu Hause ab und fuhr weiter nach Biberist. Ein schöner Tag lag hinter uns."),
    ("13", 238.0, 249.0, "Später machte ich noch eine kleine Runde und holte an der Tankstelle ein paar Energy Drinks."),
    ("14", 252.0, 269.0, "Zu Hause arbeitete ich auf dem Sofa weiter an FrameCut, während nebenbei Netflix lief. Gegen elf war endgültig Feierabend."),
    ("15", 271.0, 278.0, "Ein Sonntag vor den Ferien. Familie, Fahrtwind und eine Idee, die langsam zum Film wurde."),
]


def generate(base_url: str, text: str, seed: int, output: Path) -> str:
    import requests

    endpoint = "generate_voice_design"
    request = requests.post(
        f"{base_url.rstrip('/')}/gradio_api/call/{endpoint}",
        json={"data": [text, "German", VOICE, seed]}, timeout=30,
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


def stamp(seconds: float) -> str:
    millis = round(seconds * 1000)
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    rendered = []
    for number, start, end, text in CUES:
        output = output_dir / f"{number}_narrator.wav"
        print(f"[{number}/{len(CUES):02}] {text}", flush=True)
        status = generate(args.base_url, text, 51001, output)
        rendered.append({"number": number, "start": start, "end": end, "text": text, "file": output.name, "status": status})
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "narration-cues.json").write_text(json.dumps(rendered, ensure_ascii=False, indent=2), encoding="utf-8")
    srt=[]
    for index, cue in enumerate(rendered, 1):
        srt.extend([str(index), f"{stamp(cue['start'])} --> {stamp(cue['end'])}", cue["text"], ""])
    (output_dir / "Michel-Tagebuch-Deutsch.srt").write_text("\n".join(srt), encoding="utf-8-sig")
    print(f"Rendered {len(rendered)} narration lines to {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
