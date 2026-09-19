# FrameCut Worker Installer

Windows-Bootstrap für zusätzliche GPU-Worker. Der Installer wird auf dem Render-PC gestartet und verbindet sich ausgehend mit FrameCut; am Render-PC muss kein Port geöffnet werden.

```text
Install-FrameCutWorker.bat
```

Der Benutzer gibt einen einmaligen, kurzlebigen Registrierungscode ein. Danach lädt der Installer das versionierte Worker-Archiv vom Server, prüft die SHA-256-Prüfsumme, verschlüsselt das Worker-Token mit Windows DPAPI und richtet den Autostart ein.

Der veröffentlichte Paketstand `bootstrap-1` registriert und überwacht den Rechner bereits, beansprucht aber bewusst noch keine Renderaufträge. Erst ein nachfolgendes Runtime-Setup prüft Pinokio, ComfyUI und MiniMax H3 und schaltet den Worker auf `ready`. So kann ein frisch installierter PC keine Aufträge ohne lokale Modelle übernehmen.

Der Server muss dafür liefern:

- `GET /api/worker/installer/manifest` → `version`, `downloadUrl`, `sha256`, `entrypoint`
- `POST /api/worker/register` → `workerId`, `workerToken`

Zusätzlich stellt FrameCut bereit:

- `POST /api/workers/join-codes` (angemeldet) → einmaligen Join-Code erzeugen
- `POST /api/worker/heartbeat` → Bootstrap-/Runtime-Status
- `GET /api/workers` (angemeldet) → registrierte Worker anzeigen

MiniMax-/ComfyUI-Modelle gehören nicht in das Worker-Archiv. Sie werden lokal über Pinokio installiert bzw. heruntergeladen.
