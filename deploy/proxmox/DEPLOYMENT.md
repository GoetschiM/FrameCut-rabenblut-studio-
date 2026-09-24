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

## Automatisches Deployment bei Push

`.github/workflows/deploy.yml` löst bei jedem Push auf `main` per SSH
`deploy/proxmox/remote-deploy.sh` auf dem LXC aus. Das Skript macht
`git fetch` + `git reset --hard origin/main` in `/opt/framecut` und startet
`framecut.service` neu.

Damit das läuft, einmalig einrichten:

1. **GitHub-Secrets** im Repo (Settings → Secrets and variables → Actions):
   - `DEPLOY_HOST` — IP/Hostname des LXC
   - `DEPLOY_USER` — SSH-Deploy-User (z. B. `framecut`, nicht `root`)
   - `DEPLOY_SSH_KEY` — privater SSH-Key für diesen User (Pubkey vorher in
     `~/.ssh/authorized_keys` des Deploy-Users auf dem LXC eintragen)
   - `DEPLOY_PORT` — optional, falls SSH nicht auf Port 22 läuft
2. **Sudoers-Eintrag** auf dem LXC, damit der Deploy-User `framecut.service`
   ohne Passwort neu starten darf, z. B. in `/etc/sudoers.d/framecut-deploy`:
   ```
   framecut ALL=(root) NOPASSWD: /usr/bin/systemctl restart framecut, /usr/bin/systemctl status framecut
   ```
3. **Git-Remote auf dem LXC**: `/opt/framecut` muss ein Checkout dieses Repos
   mit `origin` = `https://github.com/GoetschiM/rabenblut-studio.git` sein
   (oder per Deploy-Key, falls das Repo privat bleiben soll und kein PAT auf
   dem LXC liegen soll).

Ohne diese drei Schritte bleibt der Workflow rot (SSH schlägt fehl), ändert
aber nichts am laufenden Dienst — sicher zum Mergen, bevor die Secrets
gesetzt sind.
