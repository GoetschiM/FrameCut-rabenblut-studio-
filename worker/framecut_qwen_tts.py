"""Small, local Qwen3-TTS adapter used by the FrameCut worker.

It deliberately calls the installed Pinokio application's own virtual environment and
model cache.  Nothing is sent to a cloud provider.  Input is JSON so PowerShell can
queue several lines while the model stays loaded once on the GPU.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--qwen-app", required=True)
    parser.add_argument("--jobs", required=True, help="JSON array: id, text, voice, language, output")
    parser.add_argument("--model-size", default="0.6B", choices=["0.6B", "1.7B"])
    parser.add_argument("--voice-mode", default="custom", choices=["custom", "design"])
    args = parser.parse_args()

    app_dir = Path(args.qwen_app).resolve()
    if not (app_dir / "qwen_tts").is_dir():
        raise RuntimeError(f"Qwen3-TTS application not found: {app_dir}")
    sys.path.insert(0, str(app_dir))

    import soundfile as sf
    import torch
    from huggingface_hub import snapshot_download
    from qwen_tts import Qwen3TTSModel

    # Windows PowerShell 5.1 writes UTF-8 text with a BOM.  Accept either
    # representation so worker job specs do not fail before Qwen is invoked.
    jobs = json.loads(Path(args.jobs).read_text(encoding="utf-8-sig"))
    if not isinstance(jobs, list) or not jobs:
        raise RuntimeError("No speech jobs were supplied.")

    # VoiceDesign (1.7B) makes arbitrary voices but can exceed a laptop GPU after
    # MiniMax has been used. CustomVoice 0.6B is the dependable production default:
    # it offers distinct, stable speaker identities with dramatically less VRAM.
    model_type = "VoiceDesign" if args.voice_mode == "design" else "CustomVoice"
    if model_type == "VoiceDesign" and args.model_size != "1.7B":
        raise RuntimeError("VoiceDesign is only available in 1.7B; use CustomVoice for 0.6B.")
    repo_id = f"Qwen/Qwen3-TTS-12Hz-{args.model_size}-{model_type}"
    # The normal Hugging Face cache uses symbolic links on Windows.  This worker
    # deliberately runs without admin privileges, so use an app-local snapshot
    # directory instead.  It contains ordinary files and is reusable afterwards.
    model_dir = app_dir / "framecut-models" / repo_id.replace("/", "--")
    model_path = snapshot_download(repo_id, local_dir=str(model_dir), local_dir_use_symlinks=False)
    model = Qwen3TTSModel.from_pretrained(model_path, device_map="cuda", dtype=torch.bfloat16)

    speakers = ("Aiden", "Dylan", "Eric", "Ono_anna", "Ryan", "Serena", "Sohee", "Uncle_fu", "Vivian")
    results = []
    for job in jobs:
        text = str(job.get("text") or "").strip()
        output = Path(str(job.get("output") or "")).resolve()
        if not text or not output:
            raise RuntimeError("Every speech job needs text and output.")
        output.parent.mkdir(parents=True, exist_ok=True)
        language = str(job.get("language") or "German").strip() or "German"
        voice = str(job.get("voice") or "A clear, natural German storyteller voice.").strip()
        if model_type == "VoiceDesign":
            wavs, sample_rate = model.generate_voice_design(text=text, language=language, instruct=voice)
        else:
            # Keying by the saved voice direction keeps every character on the same
            # voice across scenes while naturally assigning different casts another one.
            key = hashlib.sha256(voice.encode("utf-8")).digest()[0]
            speaker = speakers[key % len(speakers)]
            wavs, sample_rate = model.generate_custom_voice(
                text=text, language=language, speaker=speaker,
                instruct=voice if args.model_size == "1.7B" else None,
            )
        sf.write(str(output), wavs[0], sample_rate)
        results.append({"id": job.get("id"), "output": str(output), "speaker": speaker if model_type == "CustomVoice" else "voice-design", "sample_rate": int(sample_rate), "seconds": round(len(wavs[0]) / sample_rate, 3)})

    print(json.dumps({"ok": True, "results": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
