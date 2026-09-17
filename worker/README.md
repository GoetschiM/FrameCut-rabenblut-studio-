# FrameCut Worker

Nach der Proxmox-Einrichtung genügt ein Doppelklick auf `FrameCut-Worker.bat` auf dem Laptop. Der Worker prüft Pinokio und wird später nur dann ComfyUI, MiniMax, Qwen TTS oder Audio starten, wenn ein passender Job aus der zentralen Warteschlange ansteht.

Der Worker rendert immer lokal und lädt nur Vorschauen sowie freigegebene Ergebnisse zum Server hoch.

## Worker auf einem anderen Rechner einrichten (Kollegen-Account)

`worker/data/worker.config.json` kann diese optionalen Felder enthalten, um von den
Standardpfaden (passend zu diesem Laptop) abzuweichen:

```json
{
  "WorkerId": "eindeutiger-name",
  "ServerUrl": "http://10.0.60.131:4317",
  "H3Ref": "pinokio://...",
  "ComfyRef": "pinokio://...",
  "H3Url": "http://127.0.0.1:8188",
  "ComfyUrl": "http://127.0.0.1:8190",
  "RenderClientPath": "C:\\Pfad\\zu\\render_shot.py",
  "ImageClientPath": "C:\\Pfad\\zu\\zimage.py",
  "CaptionClientPath": "C:\\Pfad\\zu\\caption.py",
  "ComfyAppPath": "C:\\Pfad\\zu\\Pinokio\\api\\comfy.git\\app",
  "FfmpegPath": "C:\\Pfad\\zu\\ffmpeg.exe",
  "StripAudio": true
}
```

`StripAudio` (Standard: `true`) entfernt die vom Videomodell erzeugte Tonspur, bevor der
Clip hochgeladen wird — Dialog, Soundeffekte und Musik sollen als eigene Ebenen entstehen,
nicht vom Bildmodell mitgeraten werden. Auf `false` setzen, um den Originalton zu behalten.
`FfmpegPath` ist optional; ohne Angabe wird `ffmpeg` im PATH gesucht.

Es kann immer nur **ein** Worker gleichzeitig laufen — ein zweiter Start beendet sich
selbst mit Hinweis, damit sich nicht zwei Instanzen um dieselben Aufträge und dieselbe
GPU streiten.

Fehlen `RenderClientPath`, `ImageClientPath`, `CaptionClientPath` oder `ComfyAppPath`, greifen
automatisch die bisherigen Standardpfade unter `%USERPROFILE%` — ein bestehendes Setup ändert
sich also nicht.

## Automatische Bildbeschreibung ("Beschreibung per KI erstellen")

`comfy-tools/caption.py` beschreibt ein hochgeladenes Referenzfoto automatisch in
englischer Sprache (Qwen2.5-VL-3B-Instruct, läuft in der bestehenden ComfyUI-Python-
Umgebung mit GPU). Voraussetzung ist einmalig `pip install timm` in dieser Umgebung —
`torch`, `transformers` und `einops` sind dort bereits vorhanden. Beim ersten Aufruf
lädt das Skript das Modell (~6-7 GB) von Hugging Face und cached es lokal.
