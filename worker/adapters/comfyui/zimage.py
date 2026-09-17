"""Standbild mit Z-Image Turbo erzeugen (ComfyUI lokal).

Dient hier vor allem als Ankerbild fuer H3-Videos: ein Motiv erzeugen und
dann in jedem Clip als Startbild verwenden, damit das Objekt gleich bleibt.

  python zimage.py "Prompt" --breite 1024 --hoehe 576 --name hero/ninja
"""
import argparse, json, os, sys, time, urllib.error, urllib.request

BASE = os.environ.get('COMFY_URL', 'http://127.0.0.1:8188')


def api(pfad, daten=None, timeout=120):
    req = urllib.request.Request(
        BASE + pfad,
        data=json.dumps(daten).encode() if daten is not None else None,
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def main():
    p = argparse.ArgumentParser()
    p.add_argument('prompt')
    p.add_argument('--negativ', default='')
    p.add_argument('--breite', type=int, default=1024)
    p.add_argument('--hoehe', type=int, default=576)
    p.add_argument('--schritte', type=int, default=8)
    p.add_argument('--cfg', type=float, default=1.0)
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--name', default='zimage/bild')
    a = p.parse_args()
    if a.seed == 0:
        a.seed = int(time.time()) % 2**31

    g = {
        'clip': {'class_type': 'CLIPLoader', 'inputs': {
            'clip_name': 'qwen_3_4b.safetensors', 'type': 'lumina2', 'device': 'default'}},
        'vae': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'ae.safetensors'}},
        'unet': {'class_type': 'UNETLoader', 'inputs': {
            'unet_name': 'z_image_turbo_bf16.safetensors', 'weight_dtype': 'default'}},
        'shift': {'class_type': 'ModelSamplingAuraFlow', 'inputs': {
            'model': ['unet', 0], 'shift': 3.0}},
        'pos': {'class_type': 'CLIPTextEncode', 'inputs': {'text': a.prompt, 'clip': ['clip', 0]}},
        'neg': {'class_type': 'CLIPTextEncode', 'inputs': {'text': a.negativ, 'clip': ['clip', 0]}},
        'lat': {'class_type': 'EmptySD3LatentImage', 'inputs': {
            'width': a.breite, 'height': a.hoehe, 'batch_size': 1}},
        'k': {'class_type': 'KSampler', 'inputs': {
            'model': ['shift', 0], 'positive': ['pos', 0], 'negative': ['neg', 0],
            'latent_image': ['lat', 0], 'seed': a.seed, 'steps': a.schritte, 'cfg': a.cfg,
            'sampler_name': 'res_multistep', 'scheduler': 'simple', 'denoise': 1.0}},
        'dec': {'class_type': 'VAEDecode', 'inputs': {'samples': ['k', 0], 'vae': ['vae', 0]}},
        'save': {'class_type': 'SaveImage', 'inputs': {
            'images': ['dec', 0], 'filename_prefix': a.name}},
    }

    print('%dx%d, %d Schritte, cfg %.1f, seed %d' % (a.breite, a.hoehe, a.schritte, a.cfg, a.seed))
    try:
        pid = api('/prompt', {'prompt': g, 'client_id': 'zimage-tool'})['prompt_id']
    except urllib.error.HTTPError as e:
        print('abgelehnt:', e.read().decode()[:1500])
        return 1

    t0 = time.time()
    while time.time() - t0 < 1800:
        h = api('/history/' + pid)
        if pid in h:
            zustand = h[pid]['status']
            print('fertig nach %.0f s — %s' % (time.time() - t0, zustand.get('status_str')))
            for m in zustand.get('messages', []):
                if m[0] == 'execution_error':
                    d = m[1]
                    print('FEHLER in %s: %s' % (d.get('node_type'), d.get('exception_type')))
                    print(str(d.get('exception_message'))[:800])
                    return 1
            for ausgabe in h[pid].get('outputs', {}).values():
                for bild in ausgabe.get('images', []):
                    print('Datei:', os.path.join('output', bild.get('subfolder', ''), bild['filename']))
            return 0
        time.sleep(10)
    print('Zeitgrenze erreicht')
    return 1


if __name__ == '__main__':
    sys.exit(main())
