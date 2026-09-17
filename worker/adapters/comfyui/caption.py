"""Detaillierte Bildbeschreibung mit Qwen2.5-VL (lokal, GPU).

Nimmt ein Bild entgegen und gibt eine ausfuehrliche englische Beschreibung
auf stdout zurueck, die direkt als "Visuelle Leitplanken / Prompt" fuer ein
FrameCut-Material (Figur, Ort, Requisite) verwendet werden kann.

  python caption.py "C:\\pfad\\zum\\bild.png"

Das Modell wird beim ersten Aufruf einmalig von Hugging Face geladen
(Internetzugang noetig) und danach lokal zwischengespeichert.
"""
import argparse
import sys

import torch
from PIL import Image
from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

MODEL_ID = 'Qwen/Qwen2.5-VL-3B-Instruct'

DEFAULT_INSTRUCTION = (
    'Describe this image in vivid, concrete visual detail for use as an AI image-generation '
    'reference prompt. Cover: subject appearance (age range, build, hair, clothing, distinguishing '
    'features), pose and expression, setting and background, lighting and color palette, and overall '
    'mood. Write it as one dense paragraph in English, no bullet points, no preamble.'
)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('image')
    p.add_argument('--instruction', default=DEFAULT_INSTRUCTION)
    p.add_argument('--model', default=MODEL_ID)
    p.add_argument('--max-new-tokens', type=int, default=300)
    a = p.parse_args()

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    dtype = torch.float16 if device == 'cuda' else torch.float32

    try:
        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            a.model, torch_dtype=dtype
        ).to(device).eval()
        processor = AutoProcessor.from_pretrained(a.model)

        image = Image.open(a.image).convert('RGB')
        messages = [{
            'role': 'user',
            'content': [
                {'type': 'image', 'image': image},
                {'type': 'text', 'text': a.instruction},
            ],
        }]
        text_prompt = processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = processor(text=[text_prompt], images=[image], return_tensors='pt').to(device)

        with torch.no_grad():
            generated_ids = model.generate(**inputs, max_new_tokens=a.max_new_tokens, do_sample=False)
        trimmed_ids = [
            out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs['input_ids'], generated_ids)
        ]
        result = processor.batch_decode(
            trimmed_ids, skip_special_tokens=True, clean_up_tokenization_spaces=True
        )[0]
        print(result.strip())
    except Exception as exc:  # surfaced to the PowerShell worker's stderr capture
        print(f'CAPTION_ERROR: {exc}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
