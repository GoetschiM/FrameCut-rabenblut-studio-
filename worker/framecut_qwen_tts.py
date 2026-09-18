"""Small, local Qwen3-TTS adapter used by the FrameCut worker.

It deliberately calls the installed Pinokio application's own virtual environment and
model cache.  Nothing is sent to a cloud provider.  Input is JSON so PowerShell can
queue several lines while the model stays loaded once on the GPU.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--qwen-app", required=True)
    parser.add_argument("--jobs", required=True, help="JSON array: id, text, voice, language, output")
    parser.add_argument("--model-size", default="1.7B", choices=["1.7B"])
    args = parser.parse_args()

    app_dir = Path(args.qwen_app).resolve()
    if not (app_dir / "qwen_tts").is_dir():
        raise RuntimeError(f"Qwen3-TTS application not found: {app_dir}")
    sys.path.insert(0, str(app_dir))

    import soundfile as sf
    import torch
    from huggingface_hub import snapshot_download
    from qwen_tts import Qwen3TTSModel

    jobs = json.loads(Path(args.jobs).read_text(encoding="utf-8"))
    if not isinstance(jobs, list) or not jobs:
        raise RuntimeError("No speech jobs were supplied.")

    # VoiceDesign accepts natural-language voice direction, which maps directly to the
    # character and narrator fields in FrameCut.  It is intentionally not a voice clone.
    repo_id = f"Qwen/Qwen3-TTS-12Hz-{args.model_size}-VoiceDesign"
    model_path = snapshot_download(repo_id)
    model = Qwen3TTSModel.from_pretrained(model_path, device_map="cuda", dtype=torch.bfloat16)

    results = []
    for job in jobs:
        text = str(job.get("text") or "").strip()
        output = Path(str(job.get("output") or "")).resolve()
        if not text or not output:
            raise RuntimeError("Every speech job needs text and output.")
        output.parent.mkdir(parents=True, exist_ok=True)
        language = str(job.get("language") or "German").strip() or "German"
        voice = str(job.get("voice") or "A clear, natural German storyteller voice.").strip()
        wavs, sample_rate = model.generate_voice_design(text=text, language=language, instruct=voice)
        sf.write(str(output), wavs[0], sample_rate)
        results.append({"id": job.get("id"), "output": str(output), "sample_rate": int(sample_rate), "seconds": round(len(wavs[0]) / sample_rate, 3)})

    print(json.dumps({"ok": True, "results": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
