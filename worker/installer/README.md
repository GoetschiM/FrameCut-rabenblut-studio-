# FrameCut Worker Installer

Windows-Bootstrap für zusätzliche GPU-Worker. Der Installer wird auf dem Render-PC gestartet und verbindet sich ausgehend mit FrameCut; am Render-PC muss kein Port geöffnet werden.

```text
Install-FrameCutWorker.bat
```

Der Installer schlägt im lokalen Netz bereits `http://10.0.60.131:4317` und den Rechnernamen vor; ein leeres Enter übernimmt diese Defaults. Tailscale ist nur ein optionaler Fallback und wird im gleichen LAN nicht benötigt.

Der Registrierungscode ist keine frei erfundene PIN. Er wird in FrameCut unter **Worker -> Neuen Join-Code erzeugen** erstellt, beginnt mit `FC-` und ist einmalig. Eingaben wie `1234` werden verständlich abgewiesen. Danach lädt der Installer das versionierte Worker-Archiv vom Server, prüft die SHA-256-Prüfsumme, verschlüsselt das Worker-Token mit Windows DPAPI und richtet den Autostart ein.

Der veröffentlichte Paketstand `bootstrap-2` registriert und überwacht den Rechner bereits, beansprucht aber bewusst noch keine Renderaufträge. Das mitgelieferte Runtime-Setup prüft Pinokio und richtet die MiniMax-H3-Pinokio-App über `pterm` ein. Der erste Modelldownload ist groß und kann längere Zeit dauern. So kann ein frisch installierter PC keine Aufträge ohne lokale Modelle übernehmen.

Der Server muss dafür liefern:

- `GET /api/worker/installer/manifest` → `version`, `downloadUrl`, `sha256`, `entrypoint`
- `POST /api/worker/register` → `workerId`, `workerToken`

Zusätzlich stellt FrameCut bereit:

- `POST /api/workers/join-codes` (angemeldet) → einmaligen Join-Code erzeugen
- `POST /api/worker/heartbeat` → Bootstrap-/Runtime-Status
- `GET /api/workers` (angemeldet) → registrierte Worker anzeigen

MiniMax-/ComfyUI-Modelle gehören nicht in das Worker-Archiv. Sie werden lokal über Pinokio installiert bzw. heruntergeladen.
