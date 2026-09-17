# FrameCut: Proxmox-Betrieb

## Zielaufteilung

- **LXC auf Proxmox:** FrameCut-Webseite, Datenbank, Storys, Prompts, Referenzen, kleine Vorschauen, freigegebene Clips, finale Exporte und Backups.
- **Laptop:** Pinokio, ComfyUI, MiniMax H3, Qwen TTS, Stable Audio sowie alle temporären Render- und Schnittdaten.

Der LXC rendert niemals. Er bleibt erreichbar, wenn der Laptop aus ist. Der spätere Laptop-Worker fragt den LXC aktiv nach Jobs ab; der LXC öffnet keine Verbindung zum Laptop.

## Empfohlene erste LXC-Größe

Debian 12, 2 vCPU, 4 GB RAM, 50 GB Datenplatte als Start. Eine separate Datenplatte kann später ohne Neuinstallation auf 100 GB vergrößert werden.

## Speicherregeln

1. Auf den LXC gehören die Projektbeschreibung, Prompt-Historie, Seeds, Referenzen und freigegebenen Ergebnisse.
2. Rohclips und ComfyUI-Caches bleiben zunächst auf dem Laptop.
3. Der Laptop sendet für jede Prüfung nur eine kleine Vorschau an den LXC.
4. Erst freigegebene Shots und finale Master werden synchronisiert.
5. Jeder verwaltete Clip erhält einen Status: `Entwurf`, `freigegeben`, `Papierkorb`, `gelöscht`.
6. „Papierkorb“ bleibt 14 Tage wiederherstellbar; erst danach darf ein geplanter Bereinigungslauf die Datei löschen.
7. Ein Projekt kann jederzeit als ZIP exportiert werden: Story-Markdown, Shot-Manifeste, Prompts, Referenzen, Audio, Untertitel und gewählte Exporte.

## Cloudflare und Authentik

Cloudflare Tunnel zeigt ausschließlich auf den LXC-Port `4317`. Der Laptop bleibt unsichtbar im LAN.

Authentik wird später über OIDC eingebunden. Dafür braucht FrameCut erst beim Einrichten diese Werte:

- Issuer-URL von Authentik
- Client-ID
- Client-Secret, ausschließlich als LXC-Umgebungsvariable oder Secret-Datei
- erlaubte Callback-URL der FrameCut-Domain

Bis OIDC aktiv ist, bleibt die vorhandene lokale Anmeldung verfügbar. Der Cloudflare Tunnel sollte erst öffentlich freigegeben werden, wenn mindestens Cloudflare Access oder Authentik davor liegt.
